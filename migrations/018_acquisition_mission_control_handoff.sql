-- Migration 018: Closed acquisition -> Mission Control handoff outbox
-- System: PIPELINE
-- Purpose: persist a single auditable post-close package for renovation operations
-- without coupling PIPELINE to a particular Mission Control transport.

CREATE TABLE acquisition_handoffs (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    target_system TEXT NOT NULL DEFAULT 'mission-control' CHECK (target_system = 'mission-control'),
    handoff_type TEXT NOT NULL DEFAULT 'closed_acquisition' CHECK (handoff_type = 'closed_acquisition'),
    payload_json TEXT NOT NULL,
    source_closed_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CONSTRAINT unq_acquisition_handoff UNIQUE (opportunity_id, target_system, handoff_type)
);

CREATE INDEX idx_acquisition_handoffs_target_created
ON acquisition_handoffs(target_system, created_at);

CREATE TABLE acquisition_handoff_events (
    id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES acquisition_handoffs(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('ready', 'dispatch_attempted', 'dispatched', 'acknowledged', 'failed')),
    actor_id TEXT NOT NULL,
    detail TEXT,
    external_ref TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_acquisition_handoff_events_handoff
ON acquisition_handoff_events(handoff_id, occurred_at, rowid);

CREATE TRIGGER trg_prevent_acquisition_handoff_update
BEFORE UPDATE ON acquisition_handoffs
BEGIN
    SELECT RAISE(FAIL, 'Acquisition handoffs are immutable.');
END;

CREATE TRIGGER trg_prevent_acquisition_handoff_delete
BEFORE DELETE ON acquisition_handoffs
BEGIN
    SELECT RAISE(FAIL, 'Acquisition handoffs are immutable.');
END;

CREATE TRIGGER trg_prevent_acquisition_handoff_event_update
BEFORE UPDATE ON acquisition_handoff_events
BEGIN
    SELECT RAISE(FAIL, 'Acquisition handoff events are append-only.');
END;

CREATE TRIGGER trg_prevent_acquisition_handoff_event_delete
BEFORE DELETE ON acquisition_handoff_events
BEGIN
    SELECT RAISE(FAIL, 'Acquisition handoff events are append-only.');
END;
