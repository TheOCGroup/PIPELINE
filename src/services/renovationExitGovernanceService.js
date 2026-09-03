import { randomUUID } from "node:crypto";

const EXIT_DECISIONS = new Set(["sell","hold","refinance","rent_ready"]);
const REVIEW_DECISIONS = new Set(["approve_sell","approve_hold","approve_refinance","revise","hold"]);

export class RenovationExitGovernanceService {
  constructor(db) { this.db = db; }

  receive({ payload, actor = "local-operator" }) {
    validate(payload);
    const opportunityId = payload.sourceOpportunityId;
    const projectId = payload.renovation?.projectId;
    const opportunity = this.db.prepare("SELECT id, pipeline_stage, opportunity_status FROM seller_opportunities WHERE id=?").get(opportunityId);
    if (!opportunity) throw new Error("opportunity_not_found");
    if (opportunity.opportunity_status !== "closed_purchased") throw new Error("closed_purchase_required");

    const existing = this.db.prepare("SELECT * FROM renovation_exit_handoffs WHERE opportunity_id=? AND source_project_id=?").get(opportunityId, projectId);
    if (existing) return { handoff: toHandoff(existing), duplicate: true };

    const id = randomUUID();
    this.db.prepare(`INSERT INTO renovation_exit_handoffs
      (id, opportunity_id, source_project_id, payload_json, original_decision, recommended_decision, confidence, received_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, opportunityId, projectId, JSON.stringify(payload), payload.exitEvaluation.originalDecision, payload.exitEvaluation.recommendedDecision || null, payload.exitEvaluation.confidence, actor);
    return { handoff: this.get(id), duplicate: false };
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM renovation_exit_handoffs WHERE id=?").get(id);
    return row ? toHandoff(row) : null;
  }

  list(opportunityId) {
    return this.db.prepare("SELECT * FROM renovation_exit_handoffs WHERE opportunity_id=? ORDER BY received_at DESC, rowid DESC").all(opportunityId).map(toHandoff);
  }

  review({ handoffId, decision, rationale, actor = "investment-committee" }) {
    if (!REVIEW_DECISIONS.has(decision)) throw new Error("invalid_exit_review_decision");
    if (!String(rationale || "").trim()) throw new Error("exit_review_rationale_required");
    const handoff = this.db.prepare("SELECT * FROM renovation_exit_handoffs WHERE id=?").get(handoffId);
    if (!handoff) throw new Error("renovation_exit_handoff_not_found");
    const payload = JSON.parse(handoff.payload_json);
    if (decision === "approve_sell" && payload.exitEvaluation?.recommendedDecision && payload.exitEvaluation.recommendedDecision !== "sell" && payload.exitEvaluation.confidence !== "insufficient_data") throw new Error("exit_review_conflicts_with_evidence");
    if (decision === "approve_hold" && payload.exitEvaluation?.recommendedDecision && !["hold","rent_ready"].includes(payload.exitEvaluation.recommendedDecision) && payload.exitEvaluation.confidence !== "insufficient_data") throw new Error("exit_review_conflicts_with_evidence");
    if (decision === "approve_refinance" && payload.exitEvaluation?.recommendedDecision && payload.exitEvaluation.recommendedDecision !== "refinance" && payload.exitEvaluation.confidence !== "insufficient_data") throw new Error("exit_review_conflicts_with_evidence");
    const id = randomUUID();
    this.db.prepare(`INSERT INTO renovation_exit_reviews (id, handoff_id, decision, rationale, metrics_json, reviewed_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, handoffId, decision, rationale.trim(), JSON.stringify(payload.exitEvaluation?.metrics || {}), actor);
    return this.db.prepare("SELECT * FROM renovation_exit_reviews WHERE id=?").get(id);
  }

  reviews(handoffId) {
    return this.db.prepare("SELECT * FROM renovation_exit_reviews WHERE handoff_id=? ORDER BY created_at DESC, rowid DESC").all(handoffId).map(r=>({
      id:r.id,handoffId:r.handoff_id,decision:r.decision,rationale:r.rationale,metrics:JSON.parse(r.metrics_json||"{}"),reviewedBy:r.reviewed_by,createdAt:r.created_at
    }));
  }
}

function validate(payload) {
  if (!payload || payload.contractVersion !== "1.0") throw new Error("unsupported_exit_handoff_contract");
  if (payload.sourceSystem !== "mission-control" || payload.targetSystem !== "ocg-os" || payload.handoffType !== "renovation_exit_ready") throw new Error("invalid_exit_handoff_route");
  if (payload.decisionStatus !== "investment_committee_required" || payload.exitEvaluation?.requiresInvestmentCommittee !== true) throw new Error("investment_committee_required");
  if (!payload.sourceOpportunityId || !payload.renovation?.projectId) throw new Error("exit_handoff_identity_required");
  if (!EXIT_DECISIONS.has(payload.exitEvaluation?.originalDecision)) throw new Error("invalid_exit_decision");
  if (payload.exitEvaluation?.recommendedDecision && !EXIT_DECISIONS.has(payload.exitEvaluation.recommendedDecision)) throw new Error("invalid_exit_decision");
  if (!["medium","low","insufficient_data"].includes(payload.exitEvaluation?.confidence)) throw new Error("invalid_exit_confidence");
  if (!payload.renovation?.completionEvidenceRef) throw new Error("renovation_completion_evidence_required");
}

function toHandoff(row){return {id:row.id,opportunityId:row.opportunity_id,sourceProjectId:row.source_project_id,payload:JSON.parse(row.payload_json),originalDecision:row.original_decision,recommendedDecision:row.recommended_decision,confidence:row.confidence,receivedBy:row.received_by,receivedAt:row.received_at};}
