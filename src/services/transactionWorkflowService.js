import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export class TransactionWorkflowService {
  constructor(db) {
    this.db = db;
  }

  listMilestones(opportunityId) {
    return this.db.prepare(`
      SELECT * FROM transaction_milestones
      WHERE opportunity_id = ?
      ORDER BY effective_at DESC, rowid DESC
    `).all(opportunityId).map(toMilestone);
  }

  transition({ opportunityId, action, actor = "local-operator", effectiveAt = null, scheduledClosingAt = null, reason = null, details = {} }) {
    const opp = this.db.prepare("SELECT * FROM seller_opportunities WHERE id = ?").get(opportunityId);
    if (!opp) throw new Error("opportunity_not_found");

    const offer = this.db.prepare("SELECT * FROM seller_offers WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 1").get(opportunityId);
    const version = offer?.active_version_id
      ? this.db.prepare("SELECT * FROM seller_offer_versions WHERE id = ?").get(offer.active_version_id)
      : null;

    const at = effectiveAt || now();
    const ctx = { opp, offer, version, actor, at, scheduledClosingAt, reason, details };

    this.db.prepare("BEGIN TRANSACTION").run();
    try {
      let milestone;
      if (action === "start_negotiation") milestone = this._startNegotiation(ctx);
      else if (action === "accept") milestone = this._accept(ctx);
      else if (action === "begin_due_diligence") milestone = this._beginDueDiligence(ctx);
      else if (action === "schedule_closing") milestone = this._scheduleClosing(ctx);
      else if (action === "close") milestone = this._close(ctx);
      else if (action === "lose") milestone = this._lose(ctx);
      else throw new Error("invalid_transaction_action");
      this.db.prepare("COMMIT").run();
      return milestone;
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  _requirePresentedOffer({ offer, version }) {
    if (!offer || !version) throw new Error("active_offer_required");
    if (!["presented", "countered", "accepted"].includes(offer.status)) throw new Error("presented_offer_required");
  }

  _stage(ctx, nextStage, opportunityStatus, reason) {
    const { opp, actor, at } = ctx;
    if (opp.pipeline_stage !== nextStage) {
      this.db.prepare(`
        INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), opp.id, opp.pipeline_stage, nextStage, actor, reason, at);
    }
    this.db.prepare(`
      UPDATE seller_opportunities
      SET pipeline_stage = ?, opportunity_status = ?, updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStage, opportunityStatus, actor, at, opp.id);
  }

  _milestone(ctx, type, extra = {}) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO transaction_milestones
        (id, opportunity_id, offer_id, offer_version_id, milestone_type, effective_at, details_json, actor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ctx.opp.id,
      ctx.offer?.id || null,
      ctx.version?.id || null,
      type,
      ctx.at,
      JSON.stringify({ ...ctx.details, ...extra }),
      ctx.actor
    );
    return toMilestone(this.db.prepare("SELECT * FROM transaction_milestones WHERE id = ?").get(id));
  }

  _startNegotiation(ctx) {
    this._requirePresentedOffer(ctx);
    if (!['offer_presented', 'negotiating'].includes(ctx.opp.pipeline_stage)) throw new Error("negotiation_not_allowed_from_current_stage");
    this.db.prepare("UPDATE seller_offers SET status = 'countered', updated_at = ? WHERE id = ?").run(ctx.at, ctx.offer.id);
    this._stage(ctx, "negotiating", "active", ctx.reason || "Seller negotiation started");
    return this._milestone(ctx, "negotiation_started", { reason: ctx.reason || null });
  }

  _accept(ctx) {
    this._requirePresentedOffer(ctx);
    if (!['offer_presented', 'negotiating'].includes(ctx.opp.pipeline_stage)) throw new Error("acceptance_not_allowed_from_current_stage");
    this.db.prepare("UPDATE seller_offers SET status = 'accepted', updated_at = ? WHERE id = ?").run(ctx.at, ctx.offer.id);
    this.db.prepare(`
      UPDATE seller_opportunities
      SET contract_executed_at = ?
      WHERE id = ?
    `).run(ctx.at, ctx.opp.id);
    this._stage(ctx, "under_contract", "under_contract", ctx.reason || "Seller accepted active offer version");
    return this._milestone(ctx, "seller_accepted", { reason: ctx.reason || null });
  }

  _beginDueDiligence(ctx) {
    if (ctx.opp.pipeline_stage !== "under_contract" || ctx.opp.opportunity_status !== "under_contract") {
      throw new Error("executed_contract_required");
    }
    this._stage(ctx, "due_diligence", "under_contract", ctx.reason || "Due diligence opened");
    return this._milestone(ctx, "due_diligence_started", { reason: ctx.reason || null });
  }

  _scheduleClosing(ctx) {
    if (ctx.opp.pipeline_stage !== "due_diligence") throw new Error("due_diligence_required");
    if (!ctx.scheduledClosingAt) throw new Error("scheduled_closing_at_required");
    this.db.prepare("UPDATE seller_opportunities SET scheduled_closing_at = ? WHERE id = ?").run(ctx.scheduledClosingAt, ctx.opp.id);
    this._stage(ctx, "closing_scheduled", "under_contract", ctx.reason || "Closing scheduled");
    return this._milestone(ctx, "closing_scheduled", { scheduledClosingAt: ctx.scheduledClosingAt, reason: ctx.reason || null });
  }

  _close(ctx) {
    if (ctx.opp.pipeline_stage !== "closing_scheduled") throw new Error("closing_schedule_required");
    if (!ctx.opp.contract_executed_at) throw new Error("executed_contract_required");
    this.db.prepare(`
      UPDATE seller_opportunities
      SET closed_at = ?
      WHERE id = ?
    `).run(ctx.at, ctx.opp.id);
    this._stage(ctx, "closed", "closed_purchased", ctx.reason || "Purchase closed");
    this.db.prepare(`
      INSERT INTO seller_opportunity_outcomes
        (id, opportunity_id, outcome_type, reason, effective_at, actor_id, related_offer_version_id, reopen_eligibility)
      VALUES (?, ?, 'purchased', ?, ?, ?, ?, 'permanently_closed')
    `).run(randomUUID(), ctx.opp.id, ctx.reason || "Purchase closed", ctx.at, ctx.actor, ctx.version?.id || null);
    return this._milestone(ctx, "closed_purchased", { reason: ctx.reason || null });
  }

  _lose(ctx) {
    if (["closed", "archived"].includes(ctx.opp.pipeline_stage)) throw new Error("closed_opportunity_cannot_be_lost");
    const reason = ctx.reason || "Transaction did not proceed";
    this._stage(ctx, "lost", "closed_lost", reason);
    this.db.prepare(`
      INSERT INTO seller_opportunity_outcomes
        (id, opportunity_id, outcome_type, reason, effective_at, actor_id, related_offer_version_id, reopen_eligibility)
      VALUES (?, ?, 'other', ?, ?, ?, ?, 'eligible_with_approval')
    `).run(randomUUID(), ctx.opp.id, reason, ctx.at, ctx.actor, ctx.version?.id || null);
    return this._milestone(ctx, "transaction_lost", { reason });
  }
}

function toMilestone(row) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    offerId: row.offer_id,
    offerVersionId: row.offer_version_id,
    type: row.milestone_type,
    effectiveAt: row.effective_at,
    details: parseJson(row.details_json),
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}
