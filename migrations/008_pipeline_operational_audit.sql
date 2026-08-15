-- Migration 008: Pipeline Operational Audit Log Schema
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Operational Audit Events Table
CREATE TABLE IF NOT EXISTS operational_audit_events (
    id TEXT PRIMARY KEY,
    event_timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    event_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    opportunity_id TEXT,
    correlation_id TEXT,
    payload_json TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_opp ON operational_audit_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_audit_corr ON operational_audit_events(correlation_id);

-- 2. Immutability Protections for Audit Events
DROP TRIGGER IF EXISTS trg_prevent_audit_update;
CREATE TRIGGER trg_prevent_audit_update
BEFORE UPDATE ON operational_audit_events
BEGIN
    SELECT RAISE(FAIL, 'Updating operational_audit_events is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_audit_delete;
CREATE TRIGGER trg_prevent_audit_delete
BEFORE DELETE ON operational_audit_events
BEGIN
    SELECT RAISE(FAIL, 'Deleting operational_audit_events is prohibited.');
END;
