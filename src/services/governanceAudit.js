/**
 * Governance audit — writes to the existing operational audit machinery
 * (operational_audit_events, the same table Investment Committee uses).
 * Governance actions (identity lifecycle, capability grants/revocations,
 * delegations, retries, approvals, escalations) are attested here in
 * addition to any task-bound work-room event, so a governance decision is
 * auditable even when no work task exists yet.
 */
import { randomUUID } from "node:crypto";

export function recordGovernanceAudit(db, { eventType, actorId, payload = {}, correlationId = null }) {
  db.prepare(`
    INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?, ?, ?)
  `).run(randomUUID(), eventType, actorId || "unknown", JSON.stringify(payload), correlationId || randomUUID());
}
