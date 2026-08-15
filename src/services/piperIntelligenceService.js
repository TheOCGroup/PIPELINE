function parse(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

export class PiperIntelligenceService {
  constructor(db) { this.db = db; }

  status() {
    const sourceCounts = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
      FROM piper_discovery_sources
    `).get();
    const latestRun = this.db.prepare(`
      SELECT r.status, r.started_at AS startedAt, r.finished_at AS finishedAt,
        r.records_found AS recordsFound, r.records_created AS recordsCreated,
        r.records_reconciled AS recordsReconciled, r.records_failed AS recordsFailed,
        s.name AS sourceName
      FROM piper_discovery_runs r JOIN piper_discovery_sources s ON s.id = r.source_id
      ORDER BY r.started_at DESC LIMIT 1
    `).get() || null;
    const recommendations = this.db.prepare(`
      SELECT priority, COUNT(*) AS count FROM piper_recommendations
      WHERE status = 'open' GROUP BY priority
    `).all();
    const opportunityCount = this.db.prepare("SELECT COUNT(*) AS count FROM seller_opportunities WHERE opportunity_status = 'active'").get().count;
    const topFinding = this.db.prepare(`
      SELECT i.piper_score AS score, i.normalized_address AS address, i.opportunity_id AS opportunityId,
        s.name AS sourceName
      FROM piper_discovery_items i JOIN piper_discovery_sources s ON s.id = i.source_id
      ORDER BY i.piper_score DESC, i.last_seen_at DESC LIMIT 1
    `).get() || null;
    return {
      mode: "grounded",
      sources: { total: Number(sourceCounts.total || 0), enabled: Number(sourceCounts.enabled || 0) },
      activeOpportunities: Number(opportunityCount || 0),
      latestRun,
      recommendations: Object.fromEntries(recommendations.map((row) => [row.priority, Number(row.count)])),
      topFinding,
    };
  }

  recommendations(limit = 20) {
    return this.db.prepare(`
      SELECT r.id, r.opportunity_id AS opportunityId, r.recommendation_type AS type,
        r.priority, r.summary, r.rationale_json AS rationaleJson, r.status, r.created_at AS createdAt,
        src.original_address AS address
      FROM piper_recommendations r
      JOIN seller_opportunities o ON o.id = r.opportunity_id
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      WHERE r.status = 'open'
      ORDER BY CASE r.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        r.created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, Number(limit) || 20))).map((row) => ({
      ...row,
      rationale: parse(row.rationaleJson, []),
      rationaleJson: undefined,
    }));
  }

  opportunityContext(opportunityId) {
    if (!opportunityId) return null;
    const row = this.db.prepare(`
      SELECT o.id, o.opportunity_code AS code, o.pipeline_stage AS stage, o.asking_price AS askingPrice,
        o.property_condition_summary AS condition, src.original_address AS address, src.source_type AS sourceType,
        src.source_record_id AS sourceRecordId, src.source_timestamp AS sourceTimestamp,
        prov.resolution_status AS provenanceStatus, audit.payload_json AS intakeJson,
        item.piper_score AS piperScore, item.score_reasons_json AS scoreReasonsJson
      FROM seller_opportunities o
      LEFT JOIN seller_opportunity_sources src ON src.opportunity_id = o.id
      LEFT JOIN source_provenance prov ON prov.opportunity_id = o.id
      LEFT JOIN operational_audit_events audit ON audit.opportunity_id = o.id AND audit.event_type = 'PIPER_INTAKE'
      LEFT JOIN piper_discovery_items item ON item.opportunity_id = o.id
      WHERE o.id = ? LIMIT 1
    `).get(opportunityId);
    if (!row) return null;
    const intake = parse(row.intakeJson, {});
    return { ...row, intake, scoreReasons: parse(row.scoreReasonsJson, []) };
  }

  chat({ message, opportunityId }) {
    const query = String(message || "").trim();
    if (!query) throw Object.assign(new Error("missing_message"), { status: 400, code: "missing_message" });
    const normalized = query.toLowerCase();
    const context = this.opportunityContext(opportunityId);
    const actions = [];
    let answer;

    if (/scan|scrap|source|website|discover/.test(normalized) && !/provenance|verify/.test(normalized)) {
      const status = this.status();
      if (!status.sources.enabled) {
        answer = "No approved discovery sources are enabled yet. I will not scrape unapproved sites. Add approved JSON, JSON-LD, or RSS sources, then I can scan them automatically.";
        actions.push({ type: "configure_sources", label: "Configure approved sources" });
      } else if (!status.latestRun) {
        answer = `${status.sources.enabled} approved source${status.sources.enabled === 1 ? " is" : "s are"} ready, but no scan has completed yet. I recommend running discovery now.`;
        actions.push({ type: "run_discovery", label: "Run discovery now" });
      } else {
        answer = `My latest scan of ${status.latestRun.sourceName} found ${status.latestRun.recordsFound} properties, created ${status.latestRun.recordsCreated} opportunities, reconciled ${status.latestRun.recordsReconciled} duplicates, and recorded ${status.latestRun.recordsFailed} failures.`;
        actions.push({ type: "view_recommendations", label: "Review my priorities" });
      }
    } else if (/mao|analy|underwrit|deal|numbers/.test(normalized) && context) {
      const arv = Number(context.intake.arv || 0);
      const rehab = Number(context.intake.rehab || 0);
      const asking = Number(context.askingPrice || context.intake.askingPrice || 0);
      if (!arv || !rehab) {
        answer = `${context.address} is missing ${!arv && !rehab ? "ARV and rehab" : !arv ? "ARV" : "rehab"} data, so I cannot responsibly recommend an offer yet. Send this to Victor for underwriting before advancing it.`;
        actions.push({ type: "request_underwriting", opportunityId: context.id, label: "Send to Victor" });
      } else {
        const mao = Math.max(0, arv * 0.7 - rehab);
        const spread = mao - asking;
        answer = `For ${context.address}, the 70% rule produces an MAO of ${money(mao)} before holding and closing adjustments. The asking price is ${money(asking)}, leaving ${money(spread)} of preliminary room. ${spread >= 0 ? "It deserves review, but the offer still needs verified comps and a repair scope." : "The asking price exceeds the preliminary MAO; negotiate down or reject it."}`;
        actions.push({ type: spread >= 0 ? "review_now" : "reject", opportunityId: context.id, label: spread >= 0 ? "Review opportunity" : "Mark price misalignment" });
      }
    } else if (/script|seller|conversation|objection|negotiat/.test(normalized) && context) {
      const address = context.address || "this property";
      answer = `Grounded opener for ${address}: “Hi, I’m calling about the property at ${address}. I’d like to understand your goals and timing before discussing any numbers. Is now a good time?” I have not assumed motivation, condition, or a closing date—confirm those directly with the seller.`;
      actions.push({ type: "open_opportunity", opportunityId: context.id, label: "Open seller workspace" });
    } else if (/provenance|verify|source/.test(normalized) && context) {
      answer = `${context.address} came through ${context.sourceType || "an unresolved source"}. Provenance is ${context.provenanceStatus || "unresolved"}${context.sourceRecordId ? ` with source record ${context.sourceRecordId}` : ""}. ${context.provenanceStatus === "original_resolved" ? "The original lineage is recorded." : "I recommend verification before outreach or underwriting."}`;
      if (context.provenanceStatus !== "original_resolved") actions.push({ type: "verify_source", opportunityId: context.id, label: "Verify source" });
    } else if (/next|priority|recommend|what should/.test(normalized)) {
      const top = this.recommendations(1)[0];
      answer = top
        ? `My highest-priority open action is ${top.type.replace(/_/g, " ")} for ${top.address}: ${top.summary}`
        : "There are no open PIPER recommendations yet. Run discovery or add an opportunity so I can prioritize the next action.";
      if (top) actions.push({ type: "open_opportunity", opportunityId: top.opportunityId, label: "Open priority" });
    } else if (context) {
      answer = `${context.address} is in ${String(context.stage || "new_lead").replace(/_/g, " ")}. Its PIPER score is ${context.piperScore ?? "not yet scored"}. Ask me to analyze the deal, verify its source, or recommend the next action.`;
    } else {
      const status = this.status();
      answer = `I am monitoring ${status.activeOpportunities} active opportunities across ${status.sources.enabled} approved discovery sources. Ask for my top priority, discovery status, or open a property and ask me to analyze it.`;
    }

    return { answer, actions, grounded: true, opportunityId: context?.id || null };
  }
}
