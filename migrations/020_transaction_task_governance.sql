-- Migration 020: Transaction task phase governance
-- System: PIPELINE
-- Purpose: distinguish tasks required before scheduling from tasks required to actually close.

ALTER TABLE transaction_tasks
ADD COLUMN required_for_scheduling INTEGER NOT NULL DEFAULT 0 CHECK (required_for_scheduling IN (0, 1));

CREATE INDEX idx_transaction_tasks_scheduling_readiness
ON transaction_tasks(opportunity_id, required_for_scheduling, status, due_at);
