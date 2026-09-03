-- Migration 023: shared Agent Operations / Work Room event model
-- System: OCG OS / PIPELINE
-- Purpose: persist truthful workforce execution state without simulated progress.

CREATE TABLE IF NOT EXISTS agent_work_tasks (
    id TEXT PRIMARY KEY,
    department TEXT NOT NULL,
    title TEXT NOT NULL,
    requested_by TEXT NOT NULL DEFAULT 'Genaro',
    orchestrator TEXT NOT NULL DEFAULT 'Aiden',
    director TEXT NOT NULL,
    lead_agent TEXT,
    specialist_agent TEXT,
    opportunity_id TEXT,
    state TEXT NOT NULL CHECK (state IN (
        'queued','researching','building','editing','testing','qa','waiting','blocked',
        'retrying','awaiting_approval','complete','failed','canceled'
    )),
    current_action TEXT,
    blocker TEXT,
    approval_required INTEGER NOT NULL DEFAULT 0 CHECK (approval_required IN (0,1)),
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_work_tasks_state ON agent_work_tasks(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_work_tasks_opportunity ON agent_work_tasks(opportunity_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_work_tasks_department ON agent_work_tasks(department, updated_at);

-- Append-only evidence stream. Work Room UI must derive visible activity from
-- these persisted events (or an owning subsystem's equivalent runtime events),
-- never decorative timers, dots, percentages, or invented milestones.
CREATE TABLE IF NOT EXISTS agent_work_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_work_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'delegated','state_changed','tool_started','tool_completed','handoff','artifact',
        'qa_started','qa_passed','qa_failed','blocked','retry','approval_requested',
        'approval_granted','approval_denied','completed','failed','canceled'
    )),
    actor TEXT NOT NULL,
    from_actor TEXT,
    to_actor TEXT,
    tool_name TEXT,
    summary TEXT NOT NULL,
    artifact_ref TEXT,
    evidence_ref TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_work_events_task ON agent_work_events(task_id, created_at);

DROP TRIGGER IF EXISTS trg_prevent_agent_work_event_update;
CREATE TRIGGER trg_prevent_agent_work_event_update
BEFORE UPDATE ON agent_work_events
BEGIN
    SELECT RAISE(FAIL, 'Updating agent_work_events is prohibited; Work Room history is append-only.');
END;

DROP TRIGGER IF EXISTS trg_prevent_agent_work_event_delete;
CREATE TRIGGER trg_prevent_agent_work_event_delete
BEFORE DELETE ON agent_work_events
BEGIN
    SELECT RAISE(FAIL, 'Deleting agent_work_events is prohibited; Work Room history is append-only.');
END;
