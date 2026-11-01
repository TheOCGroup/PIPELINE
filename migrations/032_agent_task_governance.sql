-- Migration 032: work-task governance (Issue #7 — delegation trees,
-- idempotency, retry accounting, tenant scope, approval envelopes)
-- System: OCG OS / PIPELINE
-- Purpose: close the substrate gaps in agent_work_tasks (migration 023):
-- tasks gain a tenant, a parent (delegation becomes a tree, not just an
-- event), an idempotency key (a retried delegation cannot duplicate), an
-- attempt counter with a bound, and an approval envelope that is enforced
-- by the service layer instead of merely asserted by the caller.

ALTER TABLE agent_work_tasks ADD COLUMN parent_task_id TEXT REFERENCES agent_work_tasks(id);
ALTER TABLE agent_work_tasks ADD COLUMN tenant_id TEXT;
ALTER TABLE agent_work_tasks ADD COLUMN idempotency_key TEXT;
ALTER TABLE agent_work_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_work_tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE agent_work_tasks ADD COLUMN capability TEXT;
ALTER TABLE agent_work_tasks ADD COLUMN envelope_class TEXT NOT NULL DEFAULT 'standard'
    CHECK (envelope_class IN ('standard','high_risk'));
ALTER TABLE agent_work_tasks ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'none'
    CHECK (approval_state IN ('none','requested','granted','denied'));
ALTER TABLE agent_work_tasks ADD COLUMN approved_by TEXT;
ALTER TABLE agent_work_tasks ADD COLUMN approved_at TEXT;

-- Backfill tenant scope for pre-032 rows: the linked opportunity's tenant
-- where one exists, otherwise the canonical default tenant (the same
-- DEFAULT_TENANT_ID the PR #36 tenant discipline falls back to — tenant
-- truth for NEW rows always comes from deployment configuration via the
-- service layer, never from this migration).
UPDATE agent_work_tasks
SET tenant_id = COALESCE(
    (SELECT tenant_id FROM seller_opportunities WHERE seller_opportunities.id = agent_work_tasks.opportunity_id),
    'ocg-one'
)
WHERE tenant_id IS NULL;

-- A retried delegation replays the same (tenant, idempotency_key) and must
-- resolve to the original task: at most one task per key per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_tasks_idempotency
    ON agent_work_tasks(tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_work_tasks_tenant
    ON agent_work_tasks(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_work_tasks_parent
    ON agent_work_tasks(parent_task_id);
