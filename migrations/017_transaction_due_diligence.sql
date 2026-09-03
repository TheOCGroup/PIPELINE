-- Migration 017: Governed due-diligence and closing work
-- System: PIPELINE
-- Purpose: persist transaction-critical inspection, title, financing, insurance,
-- utility, walkthrough and closing tasks with explicit deadlines and evidence.

CREATE TABLE transaction_tasks (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    category TEXT NOT NULL CHECK (category IN (
        'inspection', 'title', 'financing', 'insurance', 'appraisal',
        'utilities', 'walkthrough', 'closing', 'other'
    )),
    task_key TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'blocked', 'complete', 'waived')),
    required_for_closing INTEGER NOT NULL DEFAULT 1 CHECK (required_for_closing IN (0, 1)),
    due_at TEXT,
    completed_at TEXT,
    evidence_ref TEXT,
    notes TEXT,
    blocker_reason TEXT,
    created_by TEXT NOT NULL,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CONSTRAINT unq_transaction_task UNIQUE (opportunity_id, task_key)
);

CREATE INDEX idx_transaction_tasks_opportunity_status
ON transaction_tasks(opportunity_id, status, due_at);

CREATE TABLE transaction_task_events (
    id TEXT PRIMARY KEY,
    transaction_task_id TEXT NOT NULL REFERENCES transaction_tasks(id) ON DELETE RESTRICT,
    prior_status TEXT,
    new_status TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT,
    evidence_ref TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_transaction_task_events_task
ON transaction_task_events(transaction_task_id, occurred_at);

CREATE TRIGGER trg_prevent_transaction_task_event_update
BEFORE UPDATE ON transaction_task_events
BEGIN
    SELECT RAISE(FAIL, 'Transaction task events are append-only.');
END;

CREATE TRIGGER trg_prevent_transaction_task_event_delete
BEFORE DELETE ON transaction_task_events
BEGIN
    SELECT RAISE(FAIL, 'Transaction task events are append-only.');
END;
