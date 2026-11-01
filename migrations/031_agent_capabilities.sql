-- Migration 031: capability registry + grants (Issue #7 — least-privilege RBAC)
-- System: OCG OS / PIPELINE
-- Purpose: one registry governs what an agent identity may do, across the
-- work room and the PIPER tool surface. Resolution is default-deny:
--   role defaults (agent_role_permissions) INTERSECT explicit grants
--   MINUS revocations; anything unlisted is denied.
--
-- VICTOR underwriting authority is a HARD constraint, encoded three ways:
--   1. agent_capabilities.reserved_role = 'victor' for 'underwriting.write';
--   2. the triggers below RAISE(FAIL) on any grant or role default that would
--      give 'underwriting.write' to a non-VICTOR role/identity — including
--      direct SQL writes that bypass the service layer;
--   3. agentCapabilityService refuses the grant with
--      'capability_reserved_for_victor' before touching the database.
-- The Director coordinates underwriting by delegating a task to VICTOR; the
-- Director never holds the pen.
--
-- High-risk capabilities carry risk_tier='high_risk' (Issue #7 approval
-- classes: capital commitments, destructive operations, permission changes,
-- sensitive-data release). Work exercising them runs under a founder
-- approval envelope (migration 032).

CREATE TABLE IF NOT EXISTS agent_capabilities (
    capability TEXT PRIMARY KEY,
    effect TEXT NOT NULL CHECK (effect IN ('read','write')),
    risk_tier TEXT NOT NULL DEFAULT 'standard' CHECK (risk_tier IN ('standard','high_risk')),
    reserved_role TEXT,
    description TEXT
);

CREATE TABLE IF NOT EXISTS agent_role_permissions (
    role TEXT NOT NULL,
    capability TEXT NOT NULL REFERENCES agent_capabilities(capability),
    effect TEXT NOT NULL CHECK (effect IN ('read','write')),
    PRIMARY KEY (role, capability)
);

CREATE TABLE IF NOT EXISTS agent_capability_grants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agent_identities(id),
    capability TEXT NOT NULL REFERENCES agent_capabilities(capability),
    effect TEXT NOT NULL CHECK (effect IN ('read','write')),
    granted_by TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    revoked_at TEXT,
    revoked_by TEXT
);

-- At most one ACTIVE grant per (tenant, agent, capability).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_capability_grants_active
    ON agent_capability_grants(tenant_id, agent_id, capability)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_capability_grants_agent
    ON agent_capability_grants(tenant_id, agent_id);

-- HARD CONSTRAINT: 'underwriting.write' may exist as a role default ONLY for
-- the reserved role, and may be granted ONLY to an identity whose role is the
-- reserved role. RAISE(FAIL) fires regardless of which code path (or ad-hoc
-- SQL) attempts the write.
DROP TRIGGER IF EXISTS trg_underwriting_write_role_default_reserved;
CREATE TRIGGER trg_underwriting_write_role_default_reserved
BEFORE INSERT ON agent_role_permissions
WHEN NEW.capability = 'underwriting.write'
     AND NEW.role <> (SELECT reserved_role FROM agent_capabilities WHERE capability = 'underwriting.write')
BEGIN
    SELECT RAISE(FAIL, 'underwriting.write is reserved to the VICTOR role');
END;

DROP TRIGGER IF EXISTS trg_underwriting_write_grant_reserved;
CREATE TRIGGER trg_underwriting_write_grant_reserved
BEFORE INSERT ON agent_capability_grants
WHEN NEW.capability = 'underwriting.write'
     AND NOT EXISTS (
        SELECT 1 FROM agent_identities
        WHERE id = NEW.agent_id
          AND role = (SELECT reserved_role FROM agent_capabilities WHERE capability = 'underwriting.write')
     )
BEGIN
    SELECT RAISE(FAIL, 'underwriting.write is reserved to the VICTOR identity');
END;

-- Capability registry seed. Capability names reuse the PIPER tool names and
-- work-room verbs so one registry governs both surfaces.
INSERT OR IGNORE INTO agent_capabilities (capability, effect, risk_tier, reserved_role, description) VALUES
    ('work_task.read',          'read',  'standard',  NULL,     'Read work-room tasks and their event history'),
    ('work_task.create',        'write', 'standard',  NULL,     'Create work-room tasks'),
    ('work_task.transition',    'write', 'standard',  NULL,     'Transition work-room task state'),
    ('work_task.delegate',      'write', 'standard',  NULL,     'Delegate a child task to another agent identity'),
    ('work_task.retry',         'write', 'standard',  NULL,     'Retry a failed or blocked work-room task'),
    ('report.read',             'read',  'standard',  NULL,     'Read the Director status report (Aiden handoff contract)'),
    ('underwriting.write',      'write', 'standard',  'victor', 'Author or modify underwriting snapshots — VICTOR only'),
    ('offer.prepare',           'write', 'standard',  NULL,     'Prepare draft offers (approval gates still apply downstream)'),
    ('capital.commit',          'write', 'high_risk', NULL,     'Commit capital / approve a binding offer — founder approval envelope'),
    ('data.destructive',        'write', 'high_risk', NULL,     'Destructive data operations — founder approval envelope'),
    ('data.release_sensitive',  'write', 'high_risk', NULL,     'Release sensitive data outside the system — founder approval envelope'),
    ('capability.grant',        'write', 'high_risk', NULL,     'Grant or revoke agent capabilities (permission change) — founder approval envelope'),
    ('identity.manage',         'write', 'high_risk', NULL,     'Create or retire agent identities — founder approval envelope');

-- Least-privilege role defaults. Anything not listed here is denied unless
-- explicitly granted; explicit grants never override a reservation.
INSERT OR IGNORE INTO agent_role_permissions (role, capability, effect) VALUES
    -- Founder (human authority): full governance, including the pen reservations
    -- do NOT extend to the founder — 'underwriting.write' is deliberately absent
    -- here too; the founder directs VICTOR, the founder is not VICTOR.
    ('founder',     'work_task.read',       'read'),
    ('founder',     'work_task.create',     'write'),
    ('founder',     'work_task.transition', 'write'),
    ('founder',     'work_task.delegate',   'write'),
    ('founder',     'work_task.retry',      'write'),
    ('founder',     'report.read',          'read'),
    ('founder',     'offer.prepare',        'write'),
    ('founder',     'capital.commit',       'write'),
    ('founder',     'data.destructive',     'write'),
    ('founder',     'data.release_sensitive','write'),
    ('founder',     'capability.grant',     'write'),
    ('founder',     'identity.manage',      'write'),
    -- Aiden (orchestrator): routes work to the Director and reads reports.
    -- Aiden is NOT the department head and holds no execution capabilities.
    ('orchestrator','work_task.read',       'read'),
    ('orchestrator','work_task.create',     'write'),
    ('orchestrator','work_task.delegate',   'write'),
    ('orchestrator','report.read',          'read'),
    -- OCG OS Director: coordinates the department's work room end to end.
    -- NO underwriting.write (reserved), NO capability.grant, NO capital.commit.
    ('director',    'work_task.read',       'read'),
    ('director',    'work_task.create',     'write'),
    ('director',    'work_task.transition', 'write'),
    ('director',    'work_task.delegate',   'write'),
    ('director',    'work_task.retry',      'write'),
    ('director',    'report.read',          'read'),
    ('director',    'offer.prepare',        'write'),
    -- HUNTER (sourcing lead): works tasks; no offer or underwriting pen.
    ('hunter',      'work_task.read',       'read'),
    ('hunter',      'work_task.transition', 'write'),
    -- VICTOR (underwriting lead): the ONLY role holding underwriting.write.
    ('victor',      'work_task.read',       'read'),
    ('victor',      'work_task.transition', 'write'),
    ('victor',      'underwriting.write',   'write'),
    ('victor',      'offer.prepare',        'write'),
    -- PIPER (seller-ops lead): works tasks only.
    ('piper',       'work_task.read',       'read'),
    ('piper',       'work_task.transition', 'write'),
    -- Specialist: read-only until explicitly granted (default-deny showcase).
    ('specialist',  'work_task.read',       'read');
