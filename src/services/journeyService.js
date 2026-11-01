/**
 * Journey surfaces (Issue #8 seller-to-deal journey — durable artifacts).
 *
 * Three of the journey's legs previously existed only as ephemeral
 * derivations or chat-only tools. This service gives them durable,
 * operator-REST surfaces without inventing new logic:
 *
 *   - Seller briefs (A2): a per-seller brief ARTIFACT, generated from the
 *     same stored data the Piper seller-summary tools read (resolveSeller /
 *     sellerOpportunities / lastContact in piperSellerData, the operator
 *     repository's offers/tasks/interactions/communications, the newest
 *     underwriting reference with the Piper figure-basis taxonomy), then
 *     PERSISTED verbatim (migration 036). A brief is a stored document:
 *     reads return the generation-time document byte-identically, never a
 *     recomputation against later state. No figure is ever invented — an
 *     absent figure is null with basis "unknown".
 *
 *   - Call preparation (A3): the operator REST surface runs the SAME
 *     executor the Piper `prepare_call` tool runs (prepareCallPlan in
 *     piperSellerData) — one implementation, two surfaces. Preparation is
 *     a pure read over recorded state and stays read-only: the plan is
 *     assembled from persisted records at read time, so there is no stale
 *     copy to record and nothing is written.
 *
 *   - Journey recommendations (A10): a recommendation RECORD (migration
 *     036) transcribing real decision state — the investment committee's
 *     latest persisted decision when one exists, otherwise the operating
 *     brief's NEXT derivation (briefModel.recommendActions over the
 *     context snapshot, the identical derivation the portfolio brief
 *     serves). Recording never creates decision logic and never upgrades
 *     an outcome: a committee hold is recorded as a hold, a kill as a
 *     kill. When neither basis exists the record is refused
 *     (recommendation_basis_unavailable) rather than fabricated.
 *
 *   - Follow-up history: the complete recorded follow-up trail for an
 *     opportunity — interactions, next-actions, stage events — read from
 *     the existing stores (no duplicate store), each list and one merged
 *     stream in chronological order.
 *
 * Tenant scope: every method resolves the opportunity through the
 * configured tenant first; a foreign opportunity or artifact id behaves
 * exactly like a nonexistent one (null from reads, null from writes).
 */

import { randomUUID } from "node:crypto";
import { normalizeTenantId } from "../repositories/sqlite/tenantScope.js";
import {
  resolveSeller,
  sellerOpportunities,
  lastContact,
  prepareCallPlan,
} from "./piper/piperSellerData.js";
import { labeledFigure, FIGURE_BASES } from "./piperContextService.js";
import { buildBrief } from "../domain/piper/briefModel.js";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const COMMITTEE_ACTIONS = {
  hold: { label: "Hold — do not approve yet", kind: "committee_hold" },
  kill: { label: "Kill the deal in its current form", kind: "committee_kill" },
  approve: { label: "Proceed — committee approved the active offer", kind: "committee_approve" },
  revise: { label: "Revise the terms or verify assumptions before approval", kind: "committee_revise" },
};

export class JourneyService {
  constructor(db, { tenantId, operator, committee = null, contextService = null } = {}) {
    this.db = db;
    this.tenantId = normalizeTenantId(tenantId);
    this.operator = operator;
    this.committee = committee;
    this.contextService = contextService;
  }

  /** The tenant's opportunity row, or null (foreign === nonexistent). */
  _opportunity(opportunityId) {
    if (!opportunityId) return null;
    return this.db
      .prepare("SELECT * FROM seller_opportunities WHERE id = ? AND tenant_id = ?")
      .get(opportunityId, this.tenantId) || null;
  }

  // --- seller briefs (A2) ---------------------------------------------------

  /**
   * Generate a per-seller brief from current stored state and persist it
   * verbatim. Returns the stored brief document, or null when the
   * opportunity is not the tenant's.
   */
  generateBrief(opportunityId, actor) {
    const opp = this._opportunity(opportunityId);
    if (!opp) return null;

    const sources = this.db.prepare(`
      SELECT * FROM seller_opportunity_sources
      WHERE opportunity_id = ?
      ORDER BY conversion_timestamp ASC, rowid ASC
    `).all(opportunityId);
    const provenanceRow = this.db
      .prepare("SELECT * FROM source_provenance WHERE opportunity_id = ?")
      .get(opportunityId);

    const seller = resolveSeller(this.db, { opportunityId, tenantId: this.tenantId });
    const sellerOpps = seller
      ? sellerOpportunities(this.db, seller.contactId, this.tenantId)
      : [];

    // Newest underwriting reference — the certified Delta B ordering, the
    // same selection the committee and the context snapshot rely on.
    const ref = this.db.prepare(`
      SELECT * FROM opportunity_underwriting_refs
      WHERE opportunity_id = ?
      ORDER BY analyzed_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(opportunityId) || null;
    let refEvidence = null;
    try { refEvidence = ref?.evidence_summary_json ? JSON.parse(ref.evidence_summary_json) : null; } catch { refEvidence = null; }
    const storedBasis = (field) => {
      const b = refEvidence?.figureBasis?.[field];
      return FIGURE_BASES.includes(b) ? b : null;
    };
    const refSource = ref ? `${ref.source_system || "deal-scout"} underwriting snapshot (Victor)` : null;

    const offers = (this.operator ? this.operator.listOffers(opportunityId) : []).map((o) => ({
      id: o.id,
      status: o.status,
      versions: (o.versions || []).map((v) => ({
        versionNumber: v.versionNumber,
        purchasePrice: v.purchasePrice ?? null,
        versionStatus: v.versionStatus,
        underwritingRefId: v.underwritingRefId ?? null,
        createdAt: v.createdAt,
      })),
    }));
    const nextActions = this.operator ? this.operator.listNextActions(opportunityId) : [];
    const interactions = this.operator ? this.operator.listInteractions(opportunityId) : [];
    const communications = (this.operator ? this.operator.listCommunications(opportunityId) : []).map((c) => ({
      id: c.id,
      channel: c.recipientChannel || null,
      direction: c.direction || null,
      status: c.status || null,
      createdAt: c.createdAt,
    }));
    const noteCount = this.operator ? this.operator.listNotes(opportunityId).length : 0;
    const lc = lastContact(this.db, opportunityId, this.tenantId);
    const reviews = this.committee ? this.committee.listReviews(opportunityId) : [];
    const latestReview = reviews[0] || null;

    const id = randomUUID();
    const generatedAt = now();
    const brief = {
      id,
      opportunityId,
      generatedAt,
      generatedBy: actor || null,
      seller: seller
        ? { contactId: seller.contactId, displayName: seller.displayName, phone: seller.phone, email: seller.email }
        : null,
      sellerOpportunities: sellerOpps,
      opportunity: {
        id: opp.id,
        code: opp.opportunity_code,
        address: sources[0]?.original_address ?? null,
        stage: opp.pipeline_stage,
        status: opp.opportunity_status,
        askingPrice: labeledFigure(opp.asking_price ?? null, { source: sources[0]?.source_type || "pipeline record" }),
        createdAt: opp.created_at,
        updatedAt: opp.updated_at,
      },
      sources: sources.map((s) => {
        let apn = null;
        try { apn = s.provenance_metadata_json ? (JSON.parse(s.provenance_metadata_json).apn || null) : null; } catch { apn = null; }
        return {
          sourceType: s.source_type,
          sourceRecordId: s.source_record_id,
          sourceMessageId: s.source_message_id,
          address: s.original_address,
          apn,
          conversionActor: s.conversion_actor,
          sourceTimestamp: s.source_timestamp,
          conversionTimestamp: s.conversion_timestamp,
        };
      }),
      provenance: provenanceRow
        ? { resolutionStatus: provenanceRow.resolution_status, resolvedAt: provenanceRow.resolved_at }
        : null,
      underwriting: ref
        ? {
            refId: ref.id,
            sourceSystem: ref.source_system || null,
            sourceAgent: ref.source_agent || null,
            analysisStatus: ref.analysis_status || null,
            analyzedAt: ref.analyzed_at || null,
            figures: {
              arv: labeledFigure(ref.arv ?? null, { basis: storedBasis("arv"), source: refSource }),
              rehab: labeledFigure(ref.rehab ?? null, { basis: storedBasis("rehab"), source: refSource }),
              mao: labeledFigure(ref.mao ?? null, { basis: storedBasis("mao"), source: refSource }),
            },
            confidence: ref.confidence ?? null,
            limitations: ref.limitations || null,
          }
        : null,
      offers,
      committee: latestReview
        ? {
            reviewId: latestReview.id,
            decision: latestReview.decision,
            rationale: latestReview.rationale,
            reviewedBy: latestReview.reviewedBy,
            createdAt: latestReview.createdAt,
          }
        : null,
      activity: {
        interactionCount: interactions.length,
        lastContact: lc.found
          ? { at: lc.at, channel: lc.channel, direction: lc.direction, summary: lc.summary, outcome: lc.outcome }
          : null,
        communications,
        openNextActions: nextActions
          .filter((a) => a.status === "open")
          .map((a) => ({ id: a.id, title: a.title, dueDate: a.dueDate, createdAt: a.createdAt })),
        openNextActionCount: nextActions.filter((a) => a.status === "open").length,
        noteCount,
      },
      basis: "stored records only — every figure traces to a recorded column or underwriting snapshot and carries its recorded/estimated/unknown basis; absent figures are null, never invented",
    };

    const provenance = {
      sellerContactId: seller?.contactId || null,
      sourceRowIds: sources.map((s) => s.id),
      underwritingRefId: ref?.id || null,
      committeeReviewId: latestReview?.id || null,
      counts: {
        sources: sources.length,
        offers: offers.length,
        interactions: interactions.length,
        communications: communications.length,
        openNextActions: brief.activity.openNextActionCount,
        notes: noteCount,
      },
      generatedFrom: [
        "seller_opportunities", "seller_opportunity_sources", "source_provenance",
        "pipeline_contacts", "opportunity_underwriting_refs", "seller_offers",
        "seller_interactions", "seller_communications", "operator_next_actions",
        "operator_notes", "investment_committee_reviews",
      ],
    };

    this.db.prepare(`
      INSERT INTO seller_briefs (id, tenant_id, opportunity_id, brief_json, provenance_json, generated_by, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.tenantId, opportunityId, JSON.stringify(brief), JSON.stringify(provenance), actor || null, generatedAt);
    return this.getBrief(id);
  }

  /** One stored brief by id; foreign === nonexistent (null). */
  getBrief(id) {
    if (!id) return null;
    const row = this.db
      .prepare("SELECT * FROM seller_briefs WHERE id = ? AND tenant_id = ?")
      .get(id, this.tenantId);
    if (!row) return null;
    return {
      ...JSON.parse(row.brief_json),
      artifactProvenance: JSON.parse(row.provenance_json || "{}"),
    };
  }

  /** Stored briefs for an opportunity, newest first; null when foreign/missing. */
  listBriefs(opportunityId) {
    if (!this._opportunity(opportunityId)) return null;
    const rows = this.db.prepare(`
      SELECT id FROM seller_briefs
      WHERE opportunity_id = ? AND tenant_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(opportunityId, this.tenantId);
    return rows.map((r) => this.getBrief(r.id));
  }

  latestBrief(opportunityId) {
    const list = this.listBriefs(opportunityId);
    return list && list.length ? list[0] : null;
  }

  // --- call preparation (A3) --------------------------------------------------

  /**
   * The operator REST surface for call preparation: the identical executor
   * the Piper prepare_call tool dispatches to. Returns the plan, or null
   * when the opportunity is not the tenant's. Read-only by construction.
   */
  callPreparation(opportunityId) {
    if (!this._opportunity(opportunityId)) return null;
    return prepareCallPlan(this.db, this.operator, { opportunityId, tenantId: this.tenantId });
  }

  // --- journey recommendations (A10) ------------------------------------------

  /**
   * Record the journey's recommended action for an opportunity, derived
   * from real decision state only. Throws
   * Error("recommendation_basis_unavailable") when neither a committee
   * decision nor a brief NEXT derivation exists — nothing is fabricated.
   * Returns null when the opportunity is not the tenant's.
   */
  recordRecommendation(opportunityId, actor) {
    if (!this._opportunity(opportunityId)) return null;

    const reviews = this.committee ? this.committee.listReviews(opportunityId) : [];
    const latest = reviews[0] || null;
    let draft = null;
    if (latest) {
      const action = COMMITTEE_ACTIONS[latest.decision] || {
        label: `Committee decision of record: ${latest.decision}`,
        kind: "committee_decision",
      };
      draft = {
        actionLabel: action.label,
        actionKind: action.kind,
        rationale: latest.rationale || null,
        basisType: "committee_review",
        basisRefId: latest.id,
        basis: {
          reviewId: latest.id,
          decision: latest.decision,
          rationale: latest.rationale,
          risks: latest.risks,
          metrics: latest.metrics,
          reviewedBy: latest.reviewedBy,
          reviewCreatedAt: latest.createdAt,
        },
      };
    } else if (this.contextService) {
      const snapshot = this.contextService.snapshot();
      const brief = buildBrief(snapshot);
      const nextSection = (brief.sections || []).find((s) => s.title === "NEXT");
      const item = (nextSection?.items || []).find((i) => i.opportunityId === opportunityId);
      if (item) {
        draft = {
          actionLabel: item.label,
          actionKind: item.action?.kind || "brief_next",
          rationale: (item.reasons || []).join(" ") || null,
          basisType: "brief_next_derivation",
          basisRefId: null,
          basis: {
            derivation: "briefModel.recommendActions over the Piper context snapshot — the identical derivation the operating brief's NEXT section serves",
            snapshotGeneratedAt: snapshot.generatedAt,
            label: item.label,
            reasons: item.reasons || [],
            action: item.action || null,
          },
        };
      }
    }
    if (!draft) throw new Error("recommendation_basis_unavailable");

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO journey_recommendations
        (id, tenant_id, opportunity_id, action_label, action_kind, rationale, basis_type, basis_ref_id, basis_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.tenantId, opportunityId, draft.actionLabel, draft.actionKind, draft.rationale,
      draft.basisType, draft.basisRefId, JSON.stringify(draft.basis), actor || null);
    return this.getRecommendation(id);
  }

  getRecommendation(id) {
    if (!id) return null;
    const row = this.db
      .prepare("SELECT * FROM journey_recommendations WHERE id = ? AND tenant_id = ?")
      .get(id, this.tenantId);
    return row ? toRecommendation(row) : null;
  }

  /** Recorded recommendations for an opportunity, newest first; null when foreign/missing. */
  listRecommendations(opportunityId) {
    if (!this._opportunity(opportunityId)) return null;
    return this.db.prepare(`
      SELECT * FROM journey_recommendations
      WHERE opportunity_id = ? AND tenant_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(opportunityId, this.tenantId).map(toRecommendation);
  }

  latestRecommendation(opportunityId) {
    const list = this.listRecommendations(opportunityId);
    return list && list.length ? list[0] : null;
  }

  // --- follow-up history --------------------------------------------------------

  /**
   * The complete recorded follow-up history for an opportunity:
   * interactions, next-actions, and stage events from their existing
   * stores, each in chronological order, plus one merged chronological
   * stream. Null when the opportunity is not the tenant's.
   */
  followUpHistory(opportunityId) {
    if (!this._opportunity(opportunityId)) return null;
    const interactions = (this.operator ? this.operator.listInteractions(opportunityId) : [])
      .slice()
      .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
    const nextActions = (this.operator ? this.operator.listNextActions(opportunityId) : [])
      .slice()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const stageEvents = this.db.prepare(`
      SELECT prior_stage, new_stage, changed_by, reason, created_at
      FROM seller_stage_events WHERE opportunity_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(opportunityId).map((r) => ({
      priorStage: r.prior_stage,
      newStage: r.new_stage,
      changedBy: r.changed_by,
      reason: r.reason,
      at: r.created_at,
    }));

    const events = [];
    for (const i of interactions) {
      events.push({
        at: i.occurredAt, kind: "interaction",
        summary: `${i.direction || ""} ${i.channel || ""}${i.summary ? ` — ${i.summary}` : ""}`.trim(),
        outcome: i.outcome || null,
      });
    }
    for (const a of nextActions) {
      events.push({
        at: a.createdAt, kind: "next_action",
        summary: `Follow-up: ${a.title} [${a.status}]`,
        status: a.status, dueDate: a.dueDate || null,
      });
      if (a.completedAt) {
        events.push({
          at: a.completedAt, kind: "next_action_completed",
          summary: `Completed: ${a.title}`,
          status: a.status,
        });
      }
    }
    for (const s of stageEvents) {
      events.push({
        at: s.at, kind: "stage_change",
        summary: `Stage: ${s.priorStage || "—"} → ${s.newStage}`,
        reason: s.reason || null,
      });
    }
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

    return {
      opportunityId,
      interactions,
      nextActions,
      stageEvents,
      events,
      counts: {
        interactions: interactions.length,
        nextActions: nextActions.length,
        stageEvents: stageEvents.length,
        events: events.length,
      },
    };
  }
}

function toRecommendation(r) {
  let basis = {};
  try { basis = r.basis_json ? JSON.parse(r.basis_json) : {}; } catch { basis = {}; }
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    actionLabel: r.action_label,
    actionKind: r.action_kind,
    rationale: r.rationale,
    basisType: r.basis_type,
    basisRefId: r.basis_ref_id,
    basis,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}
