import { randomUUID } from "node:crypto";

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export class InvestmentCommitteeService {
  constructor(db) {
    this.db = db;
  }

  listReviews(opportunityId) {
    return this.db.prepare(`
      SELECT * FROM investment_committee_reviews
      WHERE opportunity_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(opportunityId).map(toReview);
  }

  reviewActiveOffer({ opportunityId, actor = "investment-committee" }) {
    const offer = this.db.prepare(`
      SELECT * FROM seller_offers WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(opportunityId);
    if (!offer || !offer.active_version_id) throw new Error("active_offer_required");

    const version = this.db.prepare("SELECT * FROM seller_offer_versions WHERE id = ?").get(offer.active_version_id);
    if (!version) throw new Error("active_offer_version_required");

    const underwriting = this.db.prepare(`
      SELECT * FROM opportunity_underwriting_refs
      WHERE opportunity_id = ?
      ORDER BY analyzed_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(opportunityId);
    if (!underwriting) throw new Error("underwriting_required");

    const evidence = parseJson(underwriting.evidence_summary_json, {});
    const hold = evidence && typeof evidence.hold === "object" && evidence.hold ? evidence.hold : {};

    const purchasePrice = finite(version.purchase_price);
    const arv = finite(underwriting.arv ?? version.underwriting_arv_snapshot);
    const rehab = finite(underwriting.rehab ?? version.underwriting_rehab_snapshot);
    const mao = finite(underwriting.mao ?? version.underwriting_mao_snapshot);
    const confidence = finite(underwriting.confidence ?? version.underwriting_confidence);
    const dscr = finite(hold.dscr);
    const monthlyDebtService = finite(hold.monthlyDebtService);
    const noi = finite(hold.noi);
    const holdStrategy = hold.strategy || null;

    const risks = [];
    let decision = "approve";

    if (mao === null || mao <= 0) {
      risks.push("No defensible MAO is available.");
      decision = "hold";
    }

    if (purchasePrice === null || purchasePrice <= 0) {
      risks.push("Offer price is missing or invalid.");
      decision = "hold";
    } else if (mao !== null && mao > 0 && purchasePrice > mao) {
      risks.push(`Offer price exceeds Victor MAO by ${Math.round(purchasePrice - mao)}.`);
      decision = "kill";
    }

    if (confidence === null || confidence < 0.55) {
      risks.push("Underwriting confidence is below the committee minimum.");
      if (decision !== "kill") decision = "hold";
    } else if (confidence < 0.7) {
      risks.push("Underwriting confidence is moderate; material assumptions need verification.");
      if (decision === "approve") decision = "revise";
    }

    if (arv !== null && arv > 0 && rehab !== null && rehab / arv > 0.45) {
      risks.push("Rehab exceeds 45% of ARV, creating elevated execution risk.");
      if (decision === "approve") decision = "revise";
    }

    if (dscr !== null) {
      if (dscr < 1.0) {
        risks.push(`DSCR ${dscr.toFixed(2)} is below 1.00 and does not cover debt service.`);
        decision = "kill";
      } else if (dscr < 1.2) {
        risks.push(`DSCR ${dscr.toFixed(2)} is below the committee's 1.20 hold threshold.`);
        if (decision !== "kill") decision = "hold";
      }
    }

    const rationale = buildRationale(decision, risks);
    const id = randomUUID();
    const metrics = {
      purchasePrice,
      arv,
      rehab,
      mao,
      confidence,
      holdStrategy,
      dscr,
      noi,
      monthlyDebtService,
    };

    this.db.prepare("BEGIN TRANSACTION").run();
    try {
      this.db.prepare(`
        INSERT INTO investment_committee_reviews (
          id, opportunity_id, offer_id, offer_version_id, underwriting_ref_id,
          decision, rationale, risks_json, metrics_json, reviewed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        opportunityId,
        offer.id,
        version.id,
        underwriting.id,
        decision,
        rationale,
        JSON.stringify(risks),
        JSON.stringify(metrics),
        actor
      );

      if (decision === "approve") {
        this.db.prepare("UPDATE seller_offer_versions SET version_status = 'pending_approval' WHERE id = ?").run(version.id);
        this.db.prepare("UPDATE seller_offers SET status = 'pending_approval', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(offer.id);
      } else if (decision === "kill") {
        this.db.prepare("UPDATE seller_offer_versions SET version_status = 'rejected' WHERE id = ?").run(version.id);
        this.db.prepare("UPDATE seller_offers SET status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(offer.id);
        this.db.prepare(`
          UPDATE seller_opportunities
          SET opportunity_status = 'on_hold', pipeline_stage = 'offer_approval_required', updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?
        `).run(actor, opportunityId);
      } else if (decision === "hold") {
        this.db.prepare("UPDATE seller_offers SET status = 'draft', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(offer.id);
        this.db.prepare(`
          UPDATE seller_opportunities
          SET opportunity_status = 'on_hold', pipeline_stage = 'strategy_development', updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?
        `).run(actor, opportunityId);
      } else {
        this.db.prepare("UPDATE seller_offers SET status = 'draft', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(offer.id);
        this.db.prepare(`
          UPDATE seller_opportunities
          SET opportunity_status = 'active', pipeline_stage = 'offer_preparation', updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?
        `).run(actor, opportunityId);
      }

      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }

    const row = this.db.prepare("SELECT * FROM investment_committee_reviews WHERE id = ?").get(id);
    return toReview(row);
  }
}

function buildRationale(decision, risks) {
  if (decision === "approve") return "Committee challenge found no blocking risk in the current underwriting and offer version.";
  if (decision === "kill") return `Kill the deal in its current form. ${risks.join(" ")}`;
  if (decision === "hold") return `Do not approve yet. ${risks.join(" ")}`;
  return `Revise the terms or verify assumptions before approval. ${risks.join(" ")}`;
}

function toReview(row) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    offerId: row.offer_id,
    offerVersionId: row.offer_version_id,
    underwritingRefId: row.underwriting_ref_id,
    decision: row.decision,
    rationale: row.rationale,
    risks: parseJson(row.risks_json, []),
    metrics: parseJson(row.metrics_json, {}),
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
  };
}
