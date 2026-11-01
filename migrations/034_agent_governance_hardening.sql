-- Migration 034: governance hardening (Founder remediation order 2026-11-01)
-- System: OCG OS / PIPELINE
-- Purpose: close the three QUINCEY defense-in-depth findings on the
-- certified Phase 5/6 candidate at the database layer:
--
--   F1 (MODERATE) — approval-envelope start-of-work gating. The service
--   layer refuses to move an unapproved high-risk task into any
--   executable/working state; these triggers make the same rule hold for
--   direct SQL: an agent_work_tasks row whose envelope_class is
--   'high_risk' and whose approval_state is not 'granted' may not be
--   INSERTed into, or UPDATEd into, a working state (researching,
--   building, editing, testing, qa, waiting, retrying) or the settle
--   state 'complete'. Holding states (queued, awaiting_approval) and
--   no-execution exits (blocked, canceled, failed) are NOT gated — the
--   trigger is exactly as strict as the service rule, no stricter, so
--   the approval flow (queued -> awaiting_approval -> granted -> work),
--   founder denial (settles blocked), retry-bound settlement (failed),
--   and every standard-envelope flow pass untouched.
--
--   F4 (LOW) — the migration-031 VICTOR reservation triggers were
--   INSERT-only; raw UPDATEs of capability/role (role defaults) or
--   capability/agent_id (grants) could smuggle 'underwriting.write' at
--   the schema layer (the service layer already denied it in can()).
--   The UPDATE triggers below mirror the INSERT triggers exactly.
--   Revocation (UPDATE of revoked_at/revoked_by only) does not fire
--   them — the UPDATE OF column lists are deliberate.
--
--   F5 (LOW) — backfill the only determinable class of NULL-tenant work
--   tasks: rows linked to an opportunity take that opportunity's tenant
--   (the same rule migration 032 used). Rows with no linked opportunity
--   stay NULL: their tenant is NOT determinable, inventing one would
--   fabricate ownership, and the service layer now treats NULL exactly
--   like foreign (invisible to every tenant-scoped reader), so the
--   branch is closed either way.

-- F5: determinable NULL-tenant backfill (linked opportunity decides).
UPDATE agent_work_tasks
SET tenant_id = (
    SELECT tenant_id FROM seller_opportunities
    WHERE seller_opportunities.id = agent_work_tasks.opportunity_id
)
WHERE tenant_id IS NULL
  AND opportunity_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM seller_opportunities
    WHERE seller_opportunities.id = agent_work_tasks.opportunity_id
  );

-- F1: no unapproved high-risk task may be created in a working state.
DROP TRIGGER IF EXISTS trg_high_risk_task_insert_gate;
CREATE TRIGGER trg_high_risk_task_insert_gate
BEFORE INSERT ON agent_work_tasks
WHEN NEW.envelope_class = 'high_risk'
     AND NEW.approval_state <> 'granted'
     AND NEW.state IN ('researching','building','editing','testing','qa','waiting','retrying','complete')
BEGIN
    SELECT RAISE(FAIL, 'high-risk task may not enter a working state before founder approval');
END;

-- F1: no unapproved high-risk task may be moved into a working state.
DROP TRIGGER IF EXISTS trg_high_risk_task_start_gate;
CREATE TRIGGER trg_high_risk_task_start_gate
BEFORE UPDATE OF state ON agent_work_tasks
WHEN NEW.envelope_class = 'high_risk'
     AND NEW.approval_state <> 'granted'
     AND NEW.state IN ('researching','building','editing','testing','qa','waiting','retrying','complete')
BEGIN
    SELECT RAISE(FAIL, 'high-risk task may not enter a working state before founder approval');
END;

-- F4: the VICTOR reservation also binds UPDATEs of the deciding columns.
DROP TRIGGER IF EXISTS trg_underwriting_write_role_default_reserved_update;
CREATE TRIGGER trg_underwriting_write_role_default_reserved_update
BEFORE UPDATE OF capability, role ON agent_role_permissions
WHEN NEW.capability = 'underwriting.write'
     AND NEW.role <> (SELECT reserved_role FROM agent_capabilities WHERE capability = 'underwriting.write')
BEGIN
    SELECT RAISE(FAIL, 'underwriting.write is reserved to the VICTOR role');
END;

DROP TRIGGER IF EXISTS trg_underwriting_write_grant_reserved_update;
CREATE TRIGGER trg_underwriting_write_grant_reserved_update
BEFORE UPDATE OF capability, agent_id ON agent_capability_grants
WHEN NEW.capability = 'underwriting.write'
     AND NOT EXISTS (
        SELECT 1 FROM agent_identities
        WHERE id = NEW.agent_id
          AND role = (SELECT reserved_role FROM agent_capabilities WHERE capability = 'underwriting.write')
     )
BEGIN
    SELECT RAISE(FAIL, 'underwriting.write is reserved to the VICTOR identity');
END;
