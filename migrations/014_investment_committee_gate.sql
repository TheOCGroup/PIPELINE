-- Migration 014: Investment Committee approval gate
-- System: PIPELINE
-- Purpose: independently challenge underwriting before an offer can be approved.

CREATE TABLE investment_committee_reviews (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    offer_id TEXT NOT NULL REFERENCES seller_offers(id) ON DELETE RESTRICT,
    offer_version_id TEXT NOT NULL REFERENCES seller_offer_versions(id) ON DELETE RESTRICT,
    underwriting_ref_id TEXT REFERENCES opportunity_underwriting_refs(id) ON DELETE SET NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'hold', 'revise', 'kill')),
    rationale TEXT NOT NULL,
    risks_json TEXT NOT NULL DEFAULT '[]',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    reviewed_by TEXT NOT NULL DEFAULT 'investment-committee',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_investment_committee_reviews_opportunity
ON investment_committee_reviews(opportunity_id, created_at DESC);

CREATE INDEX idx_investment_committee_reviews_offer_version
ON investment_committee_reviews(offer_version_id, created_at DESC);

-- Committee reviews are historical evidence. They are append-only.
CREATE TRIGGER trg_prevent_investment_committee_review_update
BEFORE UPDATE ON investment_committee_reviews
BEGIN
    SELECT RAISE(FAIL, 'Investment committee reviews are append-only.');
END;

CREATE TRIGGER trg_prevent_investment_committee_review_delete
BEFORE DELETE ON investment_committee_reviews
BEGIN
    SELECT RAISE(FAIL, 'Investment committee reviews are append-only.');
END;

-- Fail closed once an opportunity has entered the offer approval workflow: an
-- offer cannot move to approved unless the latest committee review for the
-- active version is an approval. A revised version must be reviewed again.
CREATE TRIGGER trg_require_investment_committee_before_offer_approval
BEFORE UPDATE OF status ON seller_offers
FOR EACH ROW
WHEN NEW.status = 'approved'
  AND OLD.status <> 'approved'
  AND EXISTS (
    SELECT 1 FROM seller_opportunities
    WHERE id = NEW.opportunity_id
      AND pipeline_stage IN ('offer_preparation', 'offer_approval_required')
  )
BEGIN
    SELECT CASE
      WHEN NEW.active_version_id IS NULL
        THEN RAISE(FAIL, 'investment_committee_approval_required')
      WHEN COALESCE((
        SELECT decision
        FROM investment_committee_reviews
        WHERE offer_version_id = NEW.active_version_id
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      ), '') <> 'approve'
        THEN RAISE(FAIL, 'investment_committee_approval_required')
    END;
END;
