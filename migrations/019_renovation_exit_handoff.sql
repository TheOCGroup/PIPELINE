-- Mission Control -> OCG OS renovation exit governance
-- Persists immutable exit-ready packages and append-only committee decisions.

CREATE TABLE renovation_exit_handoffs (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    source_project_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    original_decision TEXT NOT NULL CHECK (original_decision IN ('sell','hold','refinance','rent_ready')),
    recommended_decision TEXT CHECK (recommended_decision IS NULL OR recommended_decision IN ('sell','hold','refinance','rent_ready')),
    confidence TEXT NOT NULL CHECK (confidence IN ('medium','low','insufficient_data')),
    received_by TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(opportunity_id, source_project_id)
);

CREATE TABLE renovation_exit_reviews (
    id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES renovation_exit_handoffs(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('approve_sell','approve_hold','approve_refinance','revise','hold')),
    rationale TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    reviewed_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER renovation_exit_handoffs_immutable_update
BEFORE UPDATE ON renovation_exit_handoffs
BEGIN
    SELECT RAISE(ABORT, 'renovation_exit_handoff_immutable');
END;

CREATE TRIGGER renovation_exit_handoffs_immutable_delete
BEFORE DELETE ON renovation_exit_handoffs
BEGIN
    SELECT RAISE(ABORT, 'renovation_exit_handoff_immutable');
END;

CREATE TRIGGER renovation_exit_reviews_append_only_update
BEFORE UPDATE ON renovation_exit_reviews
BEGIN
    SELECT RAISE(ABORT, 'renovation_exit_review_append_only');
END;

CREATE TRIGGER renovation_exit_reviews_append_only_delete
BEFORE DELETE ON renovation_exit_reviews
BEGIN
    SELECT RAISE(ABORT, 'renovation_exit_review_append_only');
END;

CREATE INDEX idx_renovation_exit_handoffs_opportunity ON renovation_exit_handoffs(opportunity_id, received_at);
CREATE INDEX idx_renovation_exit_reviews_handoff ON renovation_exit_reviews(handoff_id, created_at);
