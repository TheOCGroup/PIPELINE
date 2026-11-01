/**
 * Piper's retrieval layer.
 *
 * Builds a bounded snapshot of real PIPELINE state for Piper to reason over.
 * Deliberately NOT a database dump: one summary row per opportunity plus a
 * capped tail of recent events. Every field traces to a stored column, and a
 * field the database does not hold is reported as null — never inferred.
 *
 * Exactly one summary row per opportunity (F2 correction): the underwriting
 * ref joined into a row is the opportunity's GOVERNING ref — the newest by
 * the Delta B ordering (analyzed_at DESC, created_at DESC, rowid DESC), the
 * same deterministic selection the investment committee and offer
 * preparation use — so every aggregate derived from this snapshot counts
 * each opportunity once, citing the governing ref's figures. No stored ref
 * is hidden: all of an opportunity's refs ride along in `underwritingRefs`
 * (newest first, governing flagged) with their own basis-labeled figures,
 * preserving per-reference provenance.
 *
 * Agent boundary: Piper reads what Hunter (Deal Finder) delivered and what
 * Victor (Deal Scout) computed. She does not recompute either. Underwriting
 * figures are snapshots taken from Victor; PIPELINE never derives them.
 */

import { STAGES, isClosedStage } from "../domain/stages/stageModel.js";
import { normalizeTenantId } from "../repositories/sqlite/tenantScope.js";

const MAX_OPPORTUNITIES = 250;
const MAX_RECENT = 25;
const STALE_DAYS = 7;

/**
 * Figure-basis taxonomy (OCG System Owner Agent Standard): every money figure
 * Piper presents carries a basis — "recorded" (a stored value with named
 * provenance), "estimated" (a stored value the SOURCE system itself labeled
 * an estimate), or "unknown" (not recorded). The basis is derived only from
 * stored data: a value is "estimated" solely when the source's own stored
 * evidence labels it so (`figureBasis` in the underwriting evidence summary).
 * Nothing is ever relabeled silently — an unlabeled stored figure is
 * "recorded", an absent figure is "unknown", never the reverse.
 */
export const FIGURE_BASES = Object.freeze(["recorded", "estimated", "unknown"]);

export function labeledFigure(value, { basis = null, source = null } = {}) {
  if (value === null || value === undefined) return { value: null, basis: "unknown", source: null };
  return { value, basis: FIGURE_BASES.includes(basis) ? basis : "recorded", source: source || null };
}

/**
 * The Delta B deterministic ref ordering, shared with the investment
 * committee (`investmentCommitteeService.js`) and offer preparation
 * (`sqliteOperatorRepository.js`): newest analysis first; ties broken by
 * creation time, then by physical row order. SQL fragment — keep the three
 * copies textually identical.
 */
export const NEWEST_REF_ORDER = "analyzed_at DESC, created_at DESC, rowid DESC";

/**
 * Parse one ref's stored evidence summary into a basis lookup. Unparseable
 * evidence labels nothing (every stored figure stays "recorded"); a stored
 * label is honored only when it is one of the taxonomy's bases.
 */
function storedBasisLookup(evidenceSummaryJson) {
  let evidence = null;
  try { evidence = evidenceSummaryJson ? JSON.parse(evidenceSummaryJson) : null; } catch { /* unparseable evidence labels nothing */ }
  return (field) => {
    const b = evidence?.figureBasis?.[field];
    return FIGURE_BASES.includes(b) ? b : null;
  };
}

/** Basis-labeled ARV/rehab/MAO for one stored ref row. */
function refFigures(refRow, storedBasis) {
  const refSource = `${refRow.source_system || "deal-scout"} underwriting snapshot (Victor)`;
  return {
    arv: labeledFigure(refRow.arv, { basis: storedBasis("arv"), source: refSource }),
    rehab: labeledFigure(refRow.rehab, { basis: storedBasis("rehab"), source: refSource }),
    mao: labeledFigure(refRow.mao, { basis: storedBasis("mao"), source: refSource }),
  };
}

const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label || id;
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const daysBetween = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

export class PiperContextService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.tenantId = normalizeTenantId(config && config.tenantId);
  }

  /** Timestamp of the last brief Piper delivered, or null on first run. */
  lastBriefAt() {
    const row = this.db
      .prepare("SELECT value FROM pipeline_application_metadata WHERE key = ?")
      .get("piper.last_brief_at");
    return row ? row.value : null;
  }

  markBriefDelivered(at = iso(Date.now())) {
    this.db.prepare(`
      INSERT INTO pipeline_application_metadata (key, value) VALUES ('piper.last_brief_at', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(at);
    return at;
  }

  /**
   * @param {{since?: string|null}} options
   * @returns {object} snapshot consumed by the brief and the question router
   */
  snapshot({ since = null } = {}) {
    const now = iso(Date.now());
    const cutoff = since || this.lastBriefAt();

    const rows = this.db.prepare(`
      SELECT
        o.id, o.opportunity_code, o.pipeline_stage, o.opportunity_status,
        o.assigned_acquisition_manager_id, o.asking_price, o.seller_expected_price,
        o.target_purchase_price, o.max_authorized_offer,
        ref.id AS ref_id,
        ref.source_system AS ref_source_system, ref.source_underwriting_id AS ref_underwriting_id,
        ref.arv AS ref_arv, ref.rehab AS ref_rehab,
        ref.mao AS ref_mao, ref.confidence AS ref_confidence,
        ref.limitations AS ref_limitations, ref.created_at AS ref_timestamp,
        ref.analyzed_at AS ref_analyzed_at,
        ref.analysis_status AS ref_status, ref.evidence_summary_json AS ref_evidence_summary_json,
        o.last_contacted_at, o.next_scheduled_contact_at,
        o.created_by, o.created_at, o.updated_at,
        src.original_address, src.source_type, src.source_message_id, src.conversion_actor,
        prov.resolution_status, prov.original_source_json, prov.recovered_source_json,
        cls.classification_value, cls.reason AS classification_reason, cls.determined_by AS classified_by
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN source_provenance prov        ON prov.opportunity_id = o.id
      LEFT JOIN record_classifications cls    ON cls.opportunity_id = o.id
      LEFT JOIN opportunity_underwriting_refs ref ON ref.id = (
        SELECT newest.id
        FROM opportunity_underwriting_refs newest
        WHERE newest.opportunity_id = o.id
        ORDER BY ${NEWEST_REF_ORDER}
        LIMIT 1
      )
      WHERE o.tenant_id = ?
      ORDER BY o.updated_at DESC, o.created_at DESC
      LIMIT ${MAX_OPPORTUNITIES}
    `).all(this.tenantId);

    // Every stored ref for this tenant's opportunities, newest first per
    // opportunity (same Delta B ordering). The main query above joins only
    // the governing ref so each opportunity yields exactly one row; this
    // full list rides along per entry as `underwritingRefs` so no
    // per-reference provenance is lost to the dedupe.
    const refsByOpp = groupBy(
      this.db.prepare(`
        SELECT id, opportunity_id, source_system, source_underwriting_id, analysis_status,
               arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at, created_at
        FROM opportunity_underwriting_refs
        WHERE opportunity_id IN (SELECT id FROM seller_opportunities WHERE tenant_id = ?)
        ORDER BY opportunity_id ASC, ${NEWEST_REF_ORDER}
      `).all(this.tenantId),
      (r) => r.opportunity_id
    );

    const actionsByOpp = groupBy(
      this.db.prepare(`
        SELECT id, opportunity_id, title, due_date, status, created_at, created_by
        FROM operator_next_actions
      `).all(),
      (r) => r.opportunity_id
    );

    const lastStageEvent = mapBy(
      this.db.prepare(`
        SELECT opportunity_id, MAX(created_at) AS at FROM seller_stage_events GROUP BY opportunity_id
      `).all(),
      (r) => r.opportunity_id
    );

    const lastInteraction = mapBy(
      this.db.prepare(`
        SELECT opportunity_id, MAX(occurred_at) AS at, COUNT(*) AS n
        FROM seller_interactions GROUP BY opportunity_id
      `).all(),
      (r) => r.opportunity_id
    );

    const noteCounts = mapBy(
      this.db.prepare("SELECT opportunity_id, COUNT(*) AS n FROM operator_notes GROUP BY opportunity_id").all(),
      (r) => r.opportunity_id
    );

    // Guided workflows (Issue #1 item 5, migration 033): the in-flight
    // workflow per opportunity, so "where am I in the sequence?" answers
    // from stored state, never from memory of the conversation. Guarded:
    // a database that predates migration 033 simply surfaces none.
    let guidedByOpp = new Map();
    try {
      const wfRows = this.db.prepare(`
        SELECT w.id, w.opportunity_id, w.workflow_key, w.title, w.state, w.template_version,
               s.step_index AS current_index, s.step_key AS current_key, s.label AS current_label
        FROM piper_guided_workflows w
        LEFT JOIN piper_guided_workflow_steps s ON s.workflow_id = w.id AND s.state = 'current'
        WHERE w.tenant_id = ? AND w.opportunity_id IS NOT NULL AND w.state IN ('active','paused')
        ORDER BY w.created_at DESC, w.rowid DESC
      `).all(this.tenantId);
      for (const w of wfRows) {
        if (guidedByOpp.has(w.opportunity_id)) continue; // newest in-flight wins
        guidedByOpp.set(w.opportunity_id, {
          id: w.id,
          workflowKey: w.workflow_key,
          title: w.title,
          state: w.state,
          templateVersion: w.template_version,
          currentStep: w.current_key
            ? { index: w.current_index, key: w.current_key, label: w.current_label }
            : null,
        });
      }
    } catch { /* pre-033 database: no workflows exist to surface */ }

    let communicationsByOpp = new Map();
    let commEventsByComm = new Map();
    let primaryContactByOpp = new Map();

    try {
      communicationsByOpp = groupBy(
        this.db.prepare(`
          SELECT id, opportunity_id, offer_version_id, recipient_person_id, recipient_value_snapshot,
                 recipient_channel, recipient_verification_status, direction, subject, content_text,
                 in_reply_to_communication_id, created_by, created_at
          FROM seller_communications
          ORDER BY created_at DESC
        `).all(),
        (r) => r.opportunity_id
      );

      commEventsByComm = groupBy(
        this.db.prepare(`
          SELECT id, communication_id, event_type, actor_id, provider_ref, outcome, occurred_at
          FROM seller_communication_events
          ORDER BY rowid ASC
        `).all(),
        (r) => r.communication_id
      );
    } catch {}

    try {
      const participants = this.db.prepare(`
        SELECT p.opportunity_id, p.verification_status, p.source_id, c.id AS person_id, c.first_name, c.last_name, c.email, c.phone
        FROM seller_opportunity_participants p
        LEFT JOIN pipeline_contacts c ON c.id = p.ocg_one_person_id
        WHERE p.is_primary = 1
      `).all();

      primaryContactByOpp = mapBy(participants.map(p => {
        const val = p.email || p.phone || null;
        const chan = p.email ? "email" : (p.phone ? "sms" : null);
        return {
          opportunity_id: p.opportunity_id,
          personId: p.person_id,
          displayName: p.first_name ? `${p.first_name} ${p.last_name}` : null,
          value: val,
          channel: chan,
          status: val ? (p.verification_status || "SOURCE_SUPPLIED") : "MISSING",
          sourceType: p.source_id ? "deal_scout_handoff" : "manual_entry",
          sourceId: p.source_id || null
        };
      }), (r) => r.opportunity_id);
    } catch {}

    const opportunities = rows.map((r) => {
      const closed = isClosedStage(r.pipeline_stage);
      const actions = actionsByOpp.get(r.id) || [];
      const openActions = actions.filter((a) => a.status === "open");

      const lastActivityAt = latest([
        r.updated_at,
        r.created_at,
        r.last_contacted_at,
        lastStageEvent.get(r.id)?.at,
        lastInteraction.get(r.id)?.at,
      ]);

      const missing = [];
      if (!r.original_address) missing.push("property address");
      if (r.asking_price === null || r.asking_price === undefined) missing.push("asking price");
      if (!r.ref_id) missing.push("underwriting source (Victor / Deal Scout)");
      if (r.ref_id && r.ref_status !== "insufficient_evidence") {
        if (r.ref_arv === null) missing.push("ARV snapshot");
        if (r.ref_rehab === null) missing.push("rehab snapshot");
        if (r.ref_mao === null) missing.push("MAO snapshot");
      }
      if (!r.resolution_status) missing.push("provenance record");
      if (!r.classification_value) missing.push("record classification");

      const risks = [];
      if (r.resolution_status === "unresolved") {
        risks.push({
          kind: "provenance_unresolved",
          detail: "Source provenance is unresolved. That is not a synthetic determination — it means the original source has not been established.",
        });
      }
      if (!r.resolution_status) {
        risks.push({ kind: "provenance_missing", detail: "No provenance row exists for this opportunity." });
      }
      if (!r.ref_id && !closed) {
        risks.push({ kind: "underwriting_absent", detail: "No Victor or Deal Scout underwriting has been recorded, so there is no authorized ceiling." });
      }
      if (r.ref_id && r.ref_status === "insufficient_evidence") {
        risks.push({ kind: "insufficient_evidence", detail: `Victor analyzed this opportunity but found insufficient evidence: ${r.ref_limitations || "No comps found."}` });
      }
      const activeMao = r.ref_mao !== null ? r.ref_mao : null;
      if (activeMao !== null && r.asking_price !== null && activeMao < r.asking_price) {
        risks.push({
          kind: "ceiling_below_ask",
          detail: `Authorized ceiling ${money(activeMao)} is below the asking price ${money(r.asking_price)}.`,
        });
      }
      if (r.ref_confidence !== null && (r.ref_confidence < 0.3 || String(r.ref_confidence).toLowerCase() === "low")) {
        risks.push({ kind: "low_confidence", detail: "Victor recorded low confidence in this underwriting." });
      }

      const daysSinceActivity = lastActivityAt ? daysBetween(now, lastActivityAt) : null;
      const stalled = !closed && daysSinceActivity !== null && daysSinceActivity >= STALE_DAYS && openActions.length === 0;

      // Basis-labeled figures (see labeledFigure). The underwriting evidence
      // summary is the only place a source-labeled basis can live; anything it
      // does not label stays "recorded" (stored) or "unknown" (absent).
      const storedBasis = storedBasisLookup(r.ref_evidence_summary_json);
      const refSource = r.ref_id ? `${r.ref_source_system || "deal-scout"} underwriting snapshot (Victor)` : null;
      const figures = {
        askingPrice: labeledFigure(r.asking_price, { source: r.source_type || "pipeline record" }),
        arv: labeledFigure(r.ref_arv, { basis: storedBasis("arv"), source: refSource }),
        rehab: labeledFigure(r.ref_rehab, { basis: storedBasis("rehab"), source: refSource }),
        mao: labeledFigure(r.ref_mao, { basis: storedBasis("mao"), source: refSource }),
        targetPurchasePrice: labeledFigure(activeMao, { basis: storedBasis("mao"), source: activeMao === null ? null : "authorized ceiling (recorded MAO snapshot)" }),
        maxAuthorizedOffer: labeledFigure(activeMao, { basis: storedBasis("mao"), source: activeMao === null ? null : "authorized ceiling (recorded MAO snapshot)" }),
      };

      // Per-reference provenance: every stored ref, newest first. The first
      // entry is the governing ref (identical selection to the JOIN above);
      // `governing` is marked by identity with the joined ref so the two
      // selections can never silently disagree.
      const underwritingRefs = (refsByOpp.get(r.id) || []).map((refRow) => ({
        id: refRow.id,
        sourceId: refRow.source_underwriting_id || refRow.id,
        sourceSystem: refRow.source_system || "deal-scout",
        status: refRow.analysis_status || null,
        arv: refRow.arv,
        rehab: refRow.rehab,
        mao: refRow.mao,
        confidence: refRow.confidence,
        limitations: refRow.limitations,
        analyzedAt: refRow.analyzed_at || null,
        recordedAt: refRow.created_at,
        governing: refRow.id === r.ref_id,
        figures: refFigures(refRow, storedBasisLookup(refRow.evidence_summary_json)),
      }));

      return {
        id: r.id,
        code: r.opportunity_code,
        address: r.original_address || null,
        stage: r.pipeline_stage,
        stageLabel: stageLabel(r.pipeline_stage),
        status: r.opportunity_status,
        closed,
        assignedOperator: r.assigned_acquisition_manager_id || r.created_by || null,
        originatedBy: r.conversion_actor || r.created_by || null,
        askingPrice: r.asking_price,
        targetPurchasePrice: activeMao,
        maxAuthorizedOffer: activeMao,
        figures,
        underwriting: {
          refId: r.ref_id || null,
          sourceType: r.ref_id ? (r.ref_source_system || "deal-scout") : null,
          sourceId: r.ref_id ? (r.ref_underwriting_id || r.ref_id) : null,
          arv: r.ref_arv,
          rehab: r.ref_rehab,
          mao: r.ref_mao,
          confidence: r.ref_confidence,
          limitations: r.ref_limitations,
          recordedAt: r.ref_timestamp,
          analyzedAt: r.ref_id ? (r.ref_analyzed_at || null) : null,
          attributedTo: r.ref_id ? "Victor" : null,
          status: r.ref_status || null,
          evidence: r.ref_evidence_summary_json ? JSON.parse(r.ref_evidence_summary_json) : null,
        },
        underwritingRefs,
        source: {
          sourceType: r.source_type || null,
          originalSourceMessageId: r.source_message_id || null,
          apn: (() => {
            try {
              return r.original_source_json ? (JSON.parse(r.original_source_json).apn || null) : null;
            } catch {
              return null;
            }
          })()
        },
        provenanceState: r.resolution_status || null,
        recordClassification: r.classification_value || null,
        classificationReason: r.classification_reason || null,
        classifiedBy: r.classified_by || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastActivityAt,
        daysSinceActivity,
        lastContactedAt: r.last_contacted_at,
        nextScheduledContactAt: r.next_scheduled_contact_at,
        openNextActionCount: openActions.length,
        nextActions: actions.map((a) => ({ id: a.id, title: a.title, dueDate: a.due_date, status: a.status })),
        guidedWorkflow: guidedByOpp.get(r.id) || null,
        interactionCount: lastInteraction.get(r.id)?.n || 0,
        lastInteractionAt: lastInteraction.get(r.id)?.at || null,
        noteCount: noteCounts.get(r.id)?.n || 0,
        stalled,
        missing,
        risks,
        isFixture: r.created_by === 'system-seed',
        contact: primaryContactByOpp.get(r.id) || { status: "MISSING", value: null, channel: null },
        communications: (communicationsByOpp.get(r.id) || []).map(c => {
          const events = commEventsByComm.get(c.id) || [];
          const latestEvent = events[events.length - 1];
          return {
            id: c.id,
            opportunityId: c.opportunity_id,
            offerVersionId: c.offer_version_id,
            recipientPersonId: c.recipient_person_id,
            recipientValueSnapshot: c.recipient_value_snapshot,
            recipientChannel: c.recipient_channel,
            direction: c.direction,
            subject: c.subject,
            contentText: c.content_text,
            status: latestEvent ? (latestEvent.event_type || latestEvent.eventType) : "drafted",
            events: events.map(e => ({ id: e.id, eventType: e.event_type, actorId: e.actor_id, outcome: e.outcome, occurredAt: e.occurred_at }))
          };
        }),
      };
    });

    return {
      generatedAt: now,
      since: cutoff,
      staleThresholdDays: STALE_DAYS,
      system: {
        dataSource: this.config.dataSource,
        demo: this.config.dataSource === "fixtures",
        integration: this.config.integrationEnabled ? "enabled" : "disabled",
        readOnly: this.config.readOnly === true,
        intakeEnabled: this.config.piperIntakeEnabled === true,
      },
      totals: {
        opportunities: opportunities.length,
        active: opportunities.filter((o) => !o.closed).length,
        stalled: opportunities.filter((o) => o.stalled).length,
        unresolvedProvenance: opportunities.filter((o) => o.provenanceState === "unresolved").length,
        missingProvenance: opportunities.filter((o) => !o.provenanceState).length,
        withoutUnderwriting: opportunities.filter((o) => !o.underwriting.sourceType && !o.closed).length,
        openNextActions: opportunities.reduce((n, o) => n + o.openNextActionCount, 0),
      },
      opportunities,
      recent: this.#recent(cutoff),
    };
  }

  #recent(cutoff) {
    const bound = (sql, ...params) => this.db.prepare(sql).all(...params).slice(0, MAX_RECENT);
    const where = cutoff ? "WHERE event_timestamp > ?" : "";
    const args = cutoff ? [cutoff] : [];
    // Tenant scope for the recent-events tail: only events belonging to the
    // configured tenant's opportunities may enter the snapshot.
    const tenantOppIds = new Set(
      this.db.prepare("SELECT id FROM seller_opportunities WHERE tenant_id = ?").all(this.tenantId).map((r) => r.id)
    );
    const inScope = (opportunityId) => tenantOppIds.has(opportunityId);

    const intakes = bound(`
      SELECT event_timestamp AS at, actor_id, payload_json
      FROM operational_audit_events
      WHERE event_type = 'DEAL_FINDR_INTAKE' ${cutoff ? "AND event_timestamp > ?" : ""}
      ORDER BY event_timestamp DESC
    `, ...args).map((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload_json); } catch { /* opaque payload stays empty */ }
      return {
        at: r.at,
        actor: r.actor_id,
        attributedTo: hunterAttribution(r.actor_id),
        opportunityId: payload.opportunityId || null,
        address: payload.address || null,
      };
    }).filter((e) => inScope(e.opportunityId));

    const stageEvents = bound(`
      SELECT opportunity_id, prior_stage, new_stage, changed_by, reason, created_at AS at
      FROM seller_stage_events ${cutoff ? "WHERE created_at > ?" : ""}
      ORDER BY created_at DESC
    `, ...args).filter((e) => inScope(e.opportunity_id));

    const classificationChanges = bound(`
      SELECT opportunity_id, prior_classification, new_classification, determined_by, reason, determined_at AS at
      FROM classification_history ${cutoff ? "WHERE determined_at > ?" : ""}
      ORDER BY determined_at DESC
    `, ...args).filter((e) => inScope(e.opportunity_id));

    const victorUpdates = bound(`
      SELECT opportunity_id, source_system AS underwriting_source_type, mao AS underwriting_mao_snapshot,
             arv AS underwriting_arv_snapshot, confidence AS underwriting_confidence, created_at AS at
      FROM opportunity_underwriting_refs
      WHERE created_at IS NOT NULL ${cutoff ? "AND created_at > ?" : ""}
      ORDER BY created_at DESC
    `, ...args).filter((e) => inScope(e.opportunity_id)).map((r) => ({ ...r, attributedTo: "Victor" }));

    void where;
    return { intakes, stageEvents, classificationChanges, victorUpdates };
  }
}

/** Deal Finder's canonical agent name. The stored actor string is `deal-findr`. */
function hunterAttribution(actorId) {
  if (actorId === "deal-findr") return { agent: "Hunter", system: "Deal Finder", storedActor: actorId };
  return { agent: null, system: null, storedActor: actorId };
}

/** Deal Scout's canonical agent name, from the schema-enforced source type. */
function victorAttribution(sourceType) {
  if (sourceType === "victor_analysis") return { agent: "Victor", system: "Deal Scout", storedSourceType: sourceType };
  if (sourceType === "deal_scout_project") return { agent: "Victor", system: "Deal Scout", storedSourceType: sourceType };
  return { agent: null, system: null, storedSourceType: sourceType || null };
}

const money = (n) => (n === null || n === undefined ? "not recorded" : `$${Number(n).toLocaleString("en-US")}`);

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function mapBy(rows, key) {
  const m = new Map();
  for (const r of rows) m.set(key(r), r);
  return m;
}

function latest(values) {
  const valid = values.filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1] : null;
}

export { money, STALE_DAYS };
