/**
 * Agent Capability Service — least-privilege RBAC for OCG OS agents
 * (Issue #7, migration 031).
 *
 * can(agent, capability) resolution, in order:
 *   1. unknown / retired / foreign agent            -> deny
 *   2. unknown capability                           -> deny
 *   3. reserved capability, agent role != reserved  -> deny (hard rule;
 *      no grant can override it — enforced again by DB triggers)
 *   4. latest grant record for the pair             -> active allows,
 *      revoked denies (an explicit deny beats a role default)
 *   5. role default (agent_role_permissions)        -> allow
 *   6. otherwise                                    -> deny (default-deny)
 *
 * Grant and revoke are permission changes — high-risk per Issue #7 — and
 * require the actor to hold 'capability.grant' (founder-only by role
 * default; ASSUMPTION: the Director may NOT grant within an envelope,
 * because Issue #7 classifies permission changes as approval-gated and
 * no envelope-grant authority has been authorized).
 *
 * 'underwriting.write' is reserved to the VICTOR role: the Director (and
 * every other identity, including the founder qua operator) can never
 * hold it. The Director coordinates underwriting by delegating a task to
 * VICTOR, never by holding the pen. Attempts are refused here with
 * 'capability_reserved_for_victor' and would RAISE(FAIL) at the schema
 * layer even if this service were bypassed.
 */
import { randomUUID } from "node:crypto";
import { normalizeTenantId } from "../repositories/sqlite/tenantScope.js";
import { recordGovernanceAudit } from "./governanceAudit.js";

export function createAgentCapabilityService(db, tenantId, { directory } = {}) {
  const scopeTenantId = normalizeTenantId(tenantId);
  if (!directory) throw new Error("capability_service_requires_directory");

  function capabilityDef(capability) {
    if (!capability) return null;
    return db.prepare("SELECT * FROM agent_capabilities WHERE capability = ?").get(capability) || null;
  }
  function listCapabilities() {
    return db.prepare("SELECT * FROM agent_capabilities ORDER BY capability ASC").all();
  }
  function roleDefault(role, capability) {
    if (!role || !capability) return null;
    return db.prepare("SELECT * FROM agent_role_permissions WHERE role = ? AND capability = ?").get(role, capability) || null;
  }
  function activeGrant(agentId, capability) {
    return db.prepare(`SELECT * FROM agent_capability_grants
      WHERE tenant_id = ? AND agent_id = ? AND capability = ? AND revoked_at IS NULL`)
      .get(scopeTenantId, agentId, capability) || null;
  }
  /** The most recent grant row for the pair, active or revoked. A revoked
   *  grant is an explicit deny record: it overrides a role default until a
   *  fresh grant supersedes it (grant -> revoke -> cannot, even where a
   *  role default would otherwise allow). */
  function latestGrant(agentId, capability) {
    return db.prepare(`SELECT * FROM agent_capability_grants
      WHERE tenant_id = ? AND agent_id = ? AND capability = ?
      ORDER BY granted_at DESC, rowid DESC LIMIT 1`)
      .get(scopeTenantId, agentId, capability) || null;
  }
  function listGrants(agentId) {
    return db.prepare(`SELECT * FROM agent_capability_grants
      WHERE tenant_id = ? AND agent_id = ? ORDER BY granted_at ASC, rowid ASC`).all(scopeTenantId, agentId);
  }

  function can(agentRef, capability, effect = null) {
    const agent = directory.resolve(agentRef);
    if (!agent || agent.status !== "active") return false;
    const def = capabilityDef(capability);
    if (!def) return false;
    if (effect && def.effect !== effect) return false;
    // Hard reservation: not grantable, not defaultable, not overridable.
    if (def.reserved_role && agent.role !== def.reserved_role) return false;
    const latest = latestGrant(agent.id, capability);
    if (latest) return latest.revoked_at === null; // explicit grant/deny record wins
    if (roleDefault(agent.role, capability)) return true;
    return false;
  }

  function requireGrantAuthority(actorRef) {
    const actor = directory.resolve(actorRef);
    if (!actor || actor.status !== "active" || !can(actor.id, "capability.grant")) {
      throw new Error("capability_grant_not_authorized");
    }
    return actor;
  }

  function grant({ agentId, capability, actorAgentId }) {
    const actor = requireGrantAuthority(actorAgentId);
    const target = directory.get(agentId) || directory.byName(agentId);
    if (!target) throw new Error("agent_not_found");
    const def = capabilityDef(capability);
    if (!def) throw new Error("unknown_capability");
    if (def.reserved_role && target.role !== def.reserved_role) {
      // The named refusal for the VICTOR reservation; generic for any
      // future reserved capability.
      throw new Error(def.capability === "underwriting.write" ? "capability_reserved_for_victor" : "capability_reserved");
    }
    if (target.status !== "active") throw new Error("agent_not_active");
    const existing = activeGrant(target.id, capability);
    if (existing) return existing; // idempotent: re-grant is a no-op
    const id = randomUUID();
    db.prepare(`INSERT INTO agent_capability_grants (id, tenant_id, agent_id, capability, effect, granted_by)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, scopeTenantId, target.id, capability, def.effect, actor.name);
    const row = db.prepare("SELECT * FROM agent_capability_grants WHERE id = ?").get(id);
    recordGovernanceAudit(db, {
      eventType: "AGENT_CAPABILITY_GRANTED",
      actorId: actor.name,
      payload: { tenantId: scopeTenantId, agentId: target.id, agentName: target.name, capability, effect: def.effect, grantId: id },
    });
    return row;
  }

  function revoke({ agentId, capability, actorAgentId }) {
    const actor = requireGrantAuthority(actorAgentId);
    const target = directory.get(agentId) || directory.byName(agentId);
    if (!target) throw new Error("agent_not_found");
    const existing = activeGrant(target.id, capability);
    if (!existing) throw new Error("capability_grant_not_found");
    db.prepare("UPDATE agent_capability_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ? WHERE id = ?")
      .run(actor.name, existing.id);
    recordGovernanceAudit(db, {
      eventType: "AGENT_CAPABILITY_REVOKED",
      actorId: actor.name,
      payload: { tenantId: scopeTenantId, agentId: target.id, agentName: target.name, capability, grantId: existing.id },
    });
    return db.prepare("SELECT * FROM agent_capability_grants WHERE id = ?").get(existing.id);
  }

  return { tenantId: scopeTenantId, listCapabilities, capabilityDef, listGrants, can, grant, revoke };
}
