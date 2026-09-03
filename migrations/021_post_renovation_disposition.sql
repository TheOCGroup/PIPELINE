-- Migration 021: Post-renovation disposition execution
-- System: PIPELINE / OCG OS
-- Purpose: turn an approved second Investment Committee decision into an auditable
-- sell, hold, or refinance execution plan without allowing the agent to self-approve.

CREATE TABLE disposition_plans (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    renovation_exit_handoff_id TEXT NOT NULL REFERENCES renovation_exit_handoffs(id) ON DELETE RESTRICT,
    renovation_exit_review_id TEXT NOT NULL REFERENCES renovation_exit_reviews(id) ON DELETE RESTRICT,
    disposition_type TEXT NOT NULL CHECK (disposition_type IN ('sell','hold','refinance')),
    requirements_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(renovation_exit_handoff_id, renovation_exit_review_id)
);

CREATE TABLE disposition_plan_events (
    id TEXT PRIMARY KEY,
    disposition_plan_id TEXT NOT NULL REFERENCES disposition_plans(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('ready','started','blocked','unblocked','completed','failed')),
    detail TEXT,
    evidence_ref TEXT,
    external_ref TEXT,
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_disposition_plans_opportunity ON disposition_plans(opportunity_id, created_at);
CREATE INDEX idx_disposition_events_plan ON disposition_plan_events(disposition_plan_id, occurred_at);

CREATE TRIGGER disposition_plans_immutable_update
BEFORE UPDATE ON disposition_plans BEGIN
    SELECT RAISE(ABORT, 'disposition_plan_immutable');
END;
CREATE TRIGGER disposition_plans_immutable_delete
BEFORE DELETE ON disposition_plans BEGIN
    SELECT RAISE(ABORT, 'disposition_plan_immutable');
END;
CREATE TRIGGER disposition_events_append_only_update
BEFORE UPDATE ON disposition_plan_events BEGIN
    SELECT RAISE(ABORT, 'disposition_event_append_only');
END;
CREATE TRIGGER disposition_events_append_only_delete
BEFORE DELETE ON disposition_plan_events BEGIN
    SELECT RAISE(ABORT, 'disposition_event_append_only');
END;
