-- Migration 011: Piper runtime — threads, messages, runs, tool calls
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION
--
-- Gives Piper conversational memory that survives a restart, and makes every
-- run and every proposed action an auditable row rather than transient state.
--
-- The design point: a tool call is recorded when it is PROPOSED, not when it is
-- executed. That way an action Piper suggested and the operator declined leaves
-- a trace, and "nothing was written" is a verifiable claim rather than an
-- assurance.

-- 1. Threads ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS piper_threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    opportunity_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. Messages ---------------------------------------------------------------
-- Append-only: a transcript that can be edited is not a transcript.
CREATE TABLE IF NOT EXISTS piper_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES piper_threads(id) ON DELETE CASCADE,
    run_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_piper_messages_thread ON piper_messages(thread_id, created_at);

DROP TRIGGER IF EXISTS trg_prevent_piper_message_update;
CREATE TRIGGER trg_prevent_piper_message_update
BEFORE UPDATE ON piper_messages
BEGIN
    SELECT RAISE(FAIL, 'Updating piper_messages is prohibited; the transcript is append-only.');
END;

-- 3. Runs -------------------------------------------------------------------
-- One row per invocation. `state` is the operator-visible lifecycle; every
-- value corresponds to work actually happening, so nothing simulates activity.
--
--   not_connected     no provider is configured; no model was called
--   retrieving        building the context snapshot from SQLite
--   generating        a request is in flight to the provider
--   awaiting_approval a tool call needs the operator's decision
--   running_tool      an approved tool is executing
--   complete          settled, succeeded
--   failed            settled, errored
--   canceled          settled, operator aborted
CREATE TABLE IF NOT EXISTS piper_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES piper_threads(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN (
        'not_connected', 'retrieving', 'generating', 'awaiting_approval',
        'running_tool', 'complete', 'failed', 'canceled'
    )),
    provider TEXT,
    model TEXT,
    question TEXT,
    active_opportunity_id TEXT,
    error_code TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_piper_runs_thread ON piper_runs(thread_id, started_at);

-- 4. Tool calls -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS piper_tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES piper_runs(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES piper_threads(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
        'proposed', 'approved', 'rejected', 'executed', 'failed'
    )),
    result_json TEXT,
    error_code TEXT,
    decided_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_piper_tool_calls_run ON piper_tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_piper_tool_calls_status ON piper_tool_calls(status);
