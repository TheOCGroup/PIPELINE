/**
 * Director Report — the standardized handoff contract back to Aiden
 * (Issue #7): { status, evidence, blockers, risks, decisionsRequired,
 * nextActions }, derived ONLY from persisted work-room rows for the
 * configured tenant. Nothing here is estimated, simulated, or invented:
 * every entry traces to a task or an event row that exists in the DB.
 *
 *   status            task counts by lifecycle state + envelope posture
 *   evidence          recent events carrying an evidence/artifact ref
 *   blockers          blocked and failed tasks with their recorded blocker
 *   risks             high-risk-envelope tasks not yet founder-approved,
 *                     tasks that exhausted their retry bound, failed tasks
 *   decisionsRequired high-risk tasks waiting in awaiting_approval without
 *                     a founder grant — the founder/Aiden decision queue
 *   nextActions       open tasks' recorded current_action (queued first)
 */
import { normalizeTenantId } from "../repositories/sqlite/tenantScope.js";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const SETTLED = ["complete", "failed", "canceled"];

export function createDirectorReportService(db, tenantId) {
  const scopeTenantId = normalizeTenantId(tenantId);

  function build({ department = null, limit = 50 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 250);
    let taskSql = "SELECT * FROM agent_work_tasks WHERE tenant_id = ?";
    const args = [scopeTenantId];
    if (department) { taskSql += " AND department = ?"; args.push(department); }
    taskSql += " ORDER BY updated_at DESC, rowid DESC";
    const tasks = db.prepare(taskSql).all(...args);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const byState = {};
    for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1;
    const open = tasks.filter((t) => !SETTLED.includes(t.state));

    const status = {
      tenantId: scopeTenantId,
      department: department || null,
      generatedAt: now(),
      totalTasks: tasks.length,
      openTasks: open.length,
      settledTasks: tasks.length - open.length,
      byState,
      highRiskOpen: open.filter((t) => t.envelope_class === "high_risk").length,
      awaitingApproval: tasks.filter((t) => t.state === "awaiting_approval").length,
    };

    // Evidence: persisted events (of this tenant's tasks) that carry an
    // evidence or artifact reference, most recent first.
    let evSql = `SELECT e.* FROM agent_work_events e
      JOIN agent_work_tasks t ON t.id = e.task_id
      WHERE t.tenant_id = ? AND (e.evidence_ref IS NOT NULL OR e.artifact_ref IS NOT NULL)`;
    const evArgs = [scopeTenantId];
    if (department) { evSql += " AND t.department = ?"; evArgs.push(department); }
    evSql += " ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?";
    evArgs.push(lim);
    const evidence = db.prepare(evSql).all(...evArgs).map((e) => ({
      taskId: e.task_id,
      taskTitle: byId.get(e.task_id)?.title || null,
      eventType: e.event_type,
      actor: e.actor,
      summary: e.summary,
      evidenceRef: e.evidence_ref,
      artifactRef: e.artifact_ref,
      createdAt: e.created_at,
    }));

    const blockers = tasks
      .filter((t) => t.state === "blocked" || t.state === "failed")
      .slice(0, lim)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        state: t.state,
        blocker: t.blocker || t.current_action || null,
        attempt: t.attempt,
        maxAttempts: t.max_attempts,
        updatedAt: t.updated_at,
      }));

    const risks = [];
    for (const t of tasks) {
      if (t.envelope_class === "high_risk" && !SETTLED.includes(t.state) && t.approval_state !== "granted") {
        risks.push({ taskId: t.id, title: t.title, kind: "high_risk_unapproved", capability: t.capability, state: t.state, approvalState: t.approval_state });
      }
      if (t.state === "failed" && t.attempt >= t.max_attempts) {
        risks.push({ taskId: t.id, title: t.title, kind: "retry_exhausted", capability: t.capability, state: t.state, approvalState: t.approval_state });
      } else if (t.state === "failed") {
        risks.push({ taskId: t.id, title: t.title, kind: "task_failed", capability: t.capability, state: t.state, approvalState: t.approval_state });
      }
    }

    const decisionsRequired = tasks
      .filter((t) => t.state === "awaiting_approval" && t.approval_state !== "granted")
      .slice(0, lim)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        capability: t.capability,
        envelopeClass: t.envelope_class,
        approvalState: t.approval_state,
        requestedBy: t.requested_by,
        director: t.director,
        currentAction: t.current_action,
        updatedAt: t.updated_at,
      }));

    const nextActions = open
      .slice(0, lim)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        state: t.state,
        currentAction: t.current_action || null,
        leadAgent: t.lead_agent || t.specialist_agent || null,
        updatedAt: t.updated_at,
      }));

    return { status, evidence, blockers: blockers.slice(0, lim), risks: risks.slice(0, lim), decisionsRequired, nextActions };
  }

  return { tenantId: scopeTenantId, build };
}
