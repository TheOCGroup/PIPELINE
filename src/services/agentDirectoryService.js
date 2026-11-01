/**
 * Agent Directory — persistent agent identities for OCG OS governance
 * (Issue #7, migration 030).
 *
 * Replaces the work room's free-text agent names with tenant-scoped
 * identities carrying a kind, a role, and a manager relationship:
 *
 *   Founder (human) -> Aiden (orchestrator) -> OCG OS Director (director)
 *     -> HUNTER / VICTOR / PIPER (lead) -> approved specialists (specialist)
 *
 * Hierarchy rules enforced here:
 *   - a manager must exist, be active, and belong to the same tenant;
 *   - the manager chain must stay acyclic (walked on every write);
 *   - a 'director' identity's manager must be an 'orchestrator' identity
 *     (the Director reports to Aiden; Aiden is not the department head);
 *   - a 'human' identity has no manager (top of the chain);
 *   - retirement is refused while the identity has active direct reports
 *     or owns non-settled work tasks.
 *
 * Lifecycle mutations require the actor to hold 'identity.manage'
 * (founder-only by role default — ASSUMPTION: identity lifecycle is a
 * permission change, and permission changes are founder-gated per
 * Issue #7). The capability check is injected by buildServices to keep
 * this module free of a capability-service import cycle; when no checker
 * is injected the service fails closed for mutations.
 *
 * Tenant discipline follows PR #36: the tenant comes only from service
 * construction (deployment configuration) — never from caller input — and
 * a foreign identity id resolves exactly like a nonexistent one.
 */
import { randomUUID } from "node:crypto";
import { normalizeTenantId } from "../repositories/sqlite/tenantScope.js";
import { recordGovernanceAudit } from "./governanceAudit.js";

export const AGENT_KINDS = new Set(["human", "orchestrator", "director", "lead", "specialist", "system"]);

/** The canonical seeded hierarchy. Names are the work room's existing
 *  vocabulary, so historical free-text rows resolve to these identities. */
export const CANONICAL_IDENTITIES = [
  { name: "Genaro", kind: "human", role: "founder", managerName: null },
  { name: "Aiden", kind: "orchestrator", role: "orchestrator", managerName: "Genaro" },
  { name: "OCG OS Director", kind: "director", role: "director", managerName: "Aiden" },
  { name: "HUNTER", kind: "lead", role: "hunter", managerName: "OCG OS Director" },
  { name: "VICTOR", kind: "lead", role: "victor", managerName: "OCG OS Director" },
  { name: "PIPER", kind: "lead", role: "piper", managerName: "OCG OS Director" },
];

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function createAgentDirectoryService(db, tenantId, { can = null } = {}) {
  const scopeTenantId = normalizeTenantId(tenantId);
  const failClosedCan = () => false;
  const canDo = typeof can === "function" ? can : failClosedCan;

  function byId(id) {
    if (!id) return null;
    const row = db.prepare("SELECT * FROM agent_identities WHERE id = ? AND tenant_id = ?").get(id, scopeTenantId);
    return row || null;
  }
  function byName(name) {
    if (!name) return null;
    const row = db.prepare("SELECT * FROM agent_identities WHERE tenant_id = ? AND name = ?").get(scopeTenantId, String(name).trim());
    return row || null;
  }
  /** Resolve an actor reference (identity id or canonical name) inside the
   *  tenant. Foreign or unknown references resolve to null — never across
   *  the tenant boundary. */
  function resolve(ref) {
    if (!ref) return null;
    return byId(ref) || byName(ref);
  }
  function list({ status = null } = {}) {
    let sql = "SELECT * FROM agent_identities WHERE tenant_id = ?";
    const args = [scopeTenantId];
    if (status) { sql += " AND status = ?"; args.push(status); }
    sql += " ORDER BY created_at ASC, rowid ASC";
    return db.prepare(sql).all(...args);
  }

  /** Idempotently seed the canonical hierarchy for this tenant. Existing
   *  identities (matched by the (tenant_id, name) unique index) are left
   *  untouched — seeding never resurrects a retired identity or rewrites a
   *  manager relationship an operator changed deliberately. */
  function ensureSeeded() {
    const created = [];
    for (const spec of CANONICAL_IDENTITIES) {
      if (byName(spec.name)) continue;
      const manager = spec.managerName ? byName(spec.managerName) : null;
      if (spec.managerName && !manager) throw new Error("agent_seed_manager_missing");
      const id = randomUUID();
      db.prepare(`INSERT INTO agent_identities (id, tenant_id, name, kind, role, manager_agent_id, status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
        .run(id, scopeTenantId, spec.name, spec.kind, spec.role, manager ? manager.id : null, now());
      created.push(byId(id));
    }
    return created;
  }

  function requireManager(actorRef, capability) {
    const actor = resolve(actorRef);
    if (!actor || actor.status !== "active" || !canDo(actor.id, capability)) {
      throw new Error("identity_manage_not_authorized");
    }
    return actor;
  }

  /** Walk the manager chain from `startId`; returns the chain (excluding the
   *  start) or throws if a cycle or a dangling/foreign link appears. */
  function managerChain(startId) {
    const chain = [];
    const seen = new Set([startId]);
    let cursor = byId(startId);
    while (cursor && cursor.manager_agent_id) {
      const mgr = byId(cursor.manager_agent_id);
      if (!mgr) throw new Error("agent_manager_not_found");
      if (seen.has(mgr.id)) throw new Error("agent_hierarchy_cycle");
      seen.add(mgr.id);
      chain.push(mgr);
      cursor = mgr;
    }
    return chain;
  }
  /** True when `ancestorId` is `agentId` itself or appears in its chain. */
  function isSelfOrAncestor(agentId, ancestorId) {
    if (!agentId || !ancestorId) return false;
    if (agentId === ancestorId) return true;
    return managerChain(agentId).some((m) => m.id === ancestorId);
  }

  function assertHierarchy(kind, manager) {
    if (kind === "human") {
      if (manager) throw new Error("agent_human_has_no_manager");
      return;
    }
    if (!manager) throw new Error("agent_manager_required");
    if (manager.status !== "active") throw new Error("agent_manager_not_active");
    if (kind === "director" && manager.kind !== "orchestrator") {
      throw new Error("agent_director_must_report_to_orchestrator");
    }
  }

  function createIdentity({ name, kind, role, managerAgentId = null, managerName = null, actorAgentId }) {
    const actor = requireManager(actorAgentId, "identity.manage");
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("missing_agent_name");
    if (!AGENT_KINDS.has(kind)) throw new Error("invalid_agent_kind");
    const cleanRole = String(role || "").trim();
    if (!cleanRole) throw new Error("missing_agent_role");
    if (byName(cleanName)) throw new Error("agent_name_taken");
    const manager = managerAgentId || managerName ? resolve(managerAgentId || managerName) : null;
    if ((managerAgentId || managerName) && !manager) throw new Error("agent_manager_not_found");
    assertHierarchy(kind, manager);
    const id = randomUUID();
    db.prepare(`INSERT INTO agent_identities (id, tenant_id, name, kind, role, manager_agent_id, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, scopeTenantId, cleanName, kind, cleanRole, manager ? manager.id : null, now());
    const row = byId(id);
    recordGovernanceAudit(db, {
      eventType: "AGENT_IDENTITY_CREATED",
      actorId: actor.name,
      payload: { tenantId: scopeTenantId, agentId: id, name: cleanName, kind, role: cleanRole, managerAgentId: manager ? manager.id : null },
    });
    return row;
  }

  function retireIdentity({ agentId, actorAgentId }) {
    const actor = requireManager(actorAgentId, "identity.manage");
    const target = byId(agentId);
    if (!target) throw new Error("agent_not_found");
    if (target.status === "retired") return target;
    const reports = db.prepare("SELECT COUNT(*) AS c FROM agent_identities WHERE tenant_id = ? AND manager_agent_id = ? AND status = 'active'")
      .get(scopeTenantId, target.id).c;
    if (reports > 0) throw new Error("agent_has_active_reports");
    const openTasks = db.prepare(`SELECT COUNT(*) AS c FROM agent_work_tasks
      WHERE tenant_id = ? AND state NOT IN ('complete','failed','canceled')
        AND (director = ? OR lead_agent = ? OR specialist_agent = ? OR orchestrator = ?)`)
      .get(scopeTenantId, target.name, target.name, target.name, target.name).c;
    if (openTasks > 0) throw new Error("agent_has_open_tasks");
    db.prepare("UPDATE agent_identities SET status = 'retired', retired_at = ? WHERE id = ? AND tenant_id = ?")
      .run(now(), target.id, scopeTenantId);
    recordGovernanceAudit(db, {
      eventType: "AGENT_IDENTITY_RETIRED",
      actorId: actor.name,
      payload: { tenantId: scopeTenantId, agentId: target.id, name: target.name },
    });
    return byId(target.id);
  }

  return {
    tenantId: scopeTenantId,
    ensureSeeded,
    list,
    get: byId,
    byName,
    resolve,
    managerChain,
    isSelfOrAncestor,
    createIdentity,
    retireIdentity,
  };
}
