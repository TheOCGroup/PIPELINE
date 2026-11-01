-- Migration 033: Piper persisted guided workflows (Issue #1, item 5)
-- System: OCG OS / PIPELINE
-- Purpose: persist guided-workflow instances and their step outcomes.
-- Definitions live in code (src/domain/piper/guidedWorkflows.js, versioned
-- templates); the database stores only instances + step outcomes, so a
-- template edit never rewrites history. Steps never execute side effects:
-- an instance is bookkeeping — advancing a step only records that the
-- operator worked it (a step may suggest an existing tool, which still
-- parks for its own approval through the normal Piper proposal path).

CREATE TABLE IF NOT EXISTS piper_guided_workflows (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    opportunity_id TEXT REFERENCES seller_opportunities(id),
    workflow_key TEXT NOT NULL,
    template_version INTEGER NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','completed','abandoned')),
    current_step INTEGER,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_piper_guided_workflows_tenant_opp
    ON piper_guided_workflows(tenant_id, opportunity_id, state);
CREATE INDEX IF NOT EXISTS idx_piper_guided_workflows_tenant_state
    ON piper_guided_workflows(tenant_id, state, updated_at);

CREATE TABLE IF NOT EXISTS piper_guided_workflow_steps (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES piper_guided_workflows(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    step_key TEXT NOT NULL,
    label TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','current','done','skipped')),
    note TEXT,
    decided_by TEXT,
    decided_at TEXT,
    UNIQUE (workflow_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_piper_guided_workflow_steps_workflow
    ON piper_guided_workflow_steps(workflow_id, step_index);
