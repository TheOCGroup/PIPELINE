-- Migration 010: Operator state (next actions, notes, checklists)
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION
--
-- Moves operationally important operator input off browser localStorage and
-- into the database, so it survives a cleared cache, is visible to every
-- operator, and appears in Piper's reasoning.
--
-- Numbered 010 rather than 009 so it sorts after 009_piper_discovery.sql on
-- feature/pipeline-phase-4-compat and the two can merge without renumbering.
--
-- Call and activity logging is deliberately NOT duplicated here: it already has
-- a home in seller_interactions (migration 003).

-- 1. Next actions -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS operator_next_actions (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    completed_at TEXT,
    completed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_next_actions_opp ON operator_next_actions(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_next_actions_status ON operator_next_actions(status);

-- 2. Operator notes ---------------------------------------------------------
-- Append-only by policy: notes are a record of what an operator observed at a
-- point in time, so they are never edited in place.
CREATE TABLE IF NOT EXISTS operator_notes (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_operator_notes_opp ON operator_notes(opportunity_id);

DROP TRIGGER IF EXISTS trg_prevent_operator_note_update;
CREATE TRIGGER trg_prevent_operator_note_update
BEFORE UPDATE ON operator_notes
BEGIN
    SELECT RAISE(FAIL, 'Updating operator_notes is prohibited; notes are append-only.');
END;

-- 3. Acquisitions checklist -------------------------------------------------
-- One row per (opportunity, item). Checked state is current-value, not history,
-- so this table is updated in place.
CREATE TABLE IF NOT EXISTS operator_checklist_items (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    label TEXT NOT NULL,
    is_checked INTEGER NOT NULL DEFAULT 0 CHECK (is_checked IN (0, 1)),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (opportunity_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_checklist_opp ON operator_checklist_items(opportunity_id);
