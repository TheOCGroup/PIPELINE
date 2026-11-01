-- Migration 030: persistent agent identities (Issue #7 — OCG OS Director governance)
-- System: OCG OS / PIPELINE
-- Purpose: replace free-text agent names in the work room with a persistent,
-- tenant-scoped identity registry carrying role definitions and manager
-- relationships, so governance (capabilities, delegation, approvals) has a
-- real subject to bind to.
--
-- Canonical hierarchy (seeded per-tenant by agentDirectoryService, because
-- tenant_id is deployment configuration, not schema):
--   Founder (human) -> Aiden (orchestrator) -> OCG OS Director (director)
--     -> HUNTER / VICTOR / PIPER (leads) -> approved specialists.
--
-- Aiden is the company-wide orchestrator, NOT the department head; the
-- Director coordinates the OCG OS department under Aiden.

CREATE TABLE IF NOT EXISTS agent_identities (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','orchestrator','director','lead','specialist','system')),
    role TEXT NOT NULL,
    manager_agent_id TEXT REFERENCES agent_identities(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    retired_at TEXT
);

-- One identity per name per tenant: "VICTOR" in tenant A and tenant B are
-- different agents and must never resolve across the boundary.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_identities_tenant_name
    ON agent_identities(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_agent_identities_tenant
    ON agent_identities(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_identities_manager
    ON agent_identities(manager_agent_id);
