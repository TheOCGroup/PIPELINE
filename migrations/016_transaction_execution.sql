-- Migration 016: Governed transaction execution
-- System: PIPELINE
-- Purpose: persist the post-offer chain from negotiation through closing.

CREATE TABLE transaction_milestones (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    offer_id TEXT REFERENCES seller_offers(id) ON DELETE SET NULL,
    offer_version_id TEXT REFERENCES seller_offer_versions(id) ON DELETE SET NULL,
    milestone_type TEXT NOT NULL CHECK (milestone_type IN (
        'negotiation_started', 'seller_accepted', 'due_diligence_started',
        'closing_scheduled', 'closed_purchased', 'transaction_lost'
    )),
    effective_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_transaction_milestones_opportunity
ON transaction_milestones(opportunity_id, effective_at DESC);

CREATE TRIGGER trg_prevent_transaction_milestone_update
BEFORE UPDATE ON transaction_milestones
BEGIN
    SELECT RAISE(FAIL, 'Transaction milestones are append-only.');
END;

CREATE TRIGGER trg_prevent_transaction_milestone_delete
BEFORE DELETE ON transaction_milestones
BEGIN
    SELECT RAISE(FAIL, 'Transaction milestones are append-only.');
END;
