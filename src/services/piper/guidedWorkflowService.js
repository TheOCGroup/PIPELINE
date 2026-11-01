/**
 * Piper guided workflows — the tenant-scoped instance store (Issue #1,
 * item 5; migration 033).
 *
 * Templates live in code (src/domain/piper/guidedWorkflows.js); this service
 * persists only instances + step outcomes. It is a state machine over two
 * tables and nothing else:
 *
 *   workflow: active -> paused -> active -> completed | abandoned
 *   step:     pending -> current -> done | skipped   (exactly one current
 *             step exists while the workflow is active or paused)
 *
 * SAFETY RULE (binding): steps never execute side effects here. A step may
 * suggest an existing Piper tool (surfaced on the DTO from the template);
 * running it is a separate, approval-gated proposal. advance/skip/pause/
 * resume/abandon are bookkeeping only.
 *
 * Tenant discipline follows the Issue #1 / PR #36 pattern: the tenant comes
 * only from service construction (deployment configuration) — never from
 * caller input — and a foreign workflow id resolves exactly like a
 * nonexistent one (ghost equality). Abandon keeps the record; nothing in
 * this service deletes.
 */
import { randomUUID } from "node:crypto";
import { normalizeTenantId, isOpportunityInTenant } from "../../repositories/sqlite/tenantScope.js";
import { getGuidedWorkflowTemplate, suggestedToolFor } from "../../domain/piper/guidedWorkflows.js";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const SETTLED = new Set(["completed", "abandoned"]);

export function createGuidedWorkflowService(db, tenantId) {
  const scopeTenantId = normalizeTenantId(tenantId);

  function rowToStep(row) {
    return {
      id: row.id,
      index: row.step_index,
      key: row.step_key,
      label: row.label,
      state: row.state,
      note: row.note || null,
      decidedBy: row.decided_by || null,
      decidedAt: row.decided_at || null,
    };
  }

  function present(row) {
    if (!row) return null;
    const steps = db
      .prepare("SELECT * FROM piper_guided_workflow_steps WHERE workflow_id = ? ORDER BY step_index ASC")
      .all(row.id)
      .map((s) => ({ ...rowToStep(s), suggestedTool: suggestedToolFor(row.workflow_key, s.step_key) }));
    const current = steps.find((s) => s.state === "current") || null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      opportunityId: row.opportunity_id || null,
      workflowKey: row.workflow_key,
      templateVersion: row.template_version,
      title: row.title,
      state: row.state,
      currentStepIndex: row.current_step,
      currentStep: current
        ? { index: current.index, key: current.key, label: current.label, suggestedTool: current.suggestedTool }
        : null,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || null,
      steps,
    };
  }

  function get(id) {
    if (!id) return null;
    const row = db
      .prepare("SELECT * FROM piper_guided_workflows WHERE id = ? AND tenant_id = ?")
      .get(id, scopeTenantId);
    return present(row || null);
  }

  function mustGet(id) {
    const wf = get(id);
    if (!wf) throw new Error("guided_workflow_not_found");
    return wf;
  }

  function start({ workflowKey, opportunityId = null, title = null, actor = "piper" } = {}) {
    const tpl = getGuidedWorkflowTemplate(workflowKey);
    if (!tpl) throw new Error("unknown_workflow");
    if (opportunityId && !isOpportunityInTenant(db, scopeTenantId, opportunityId)) {
      throw new Error("opportunity_not_found");
    }
    const id = randomUUID();
    const ts = now();
    db.prepare(`
      INSERT INTO piper_guided_workflows
        (id, tenant_id, opportunity_id, workflow_key, template_version, title, state, current_step, created_by, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, NULL)
    `).run(id, scopeTenantId, opportunityId || null, tpl.key, tpl.templateVersion, title || tpl.title, actor, ts, ts);
    const insertStep = db.prepare(`
      INSERT INTO piper_guided_workflow_steps (id, workflow_id, step_index, step_key, label, state)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    tpl.steps.forEach((step, i) => {
      insertStep.run(randomUUID(), id, i, step.key, step.label, i === 0 ? "current" : "pending");
    });
    return get(id);
  }

  /** Shared advance/skip mechanics: decide the current step, move on or settle. */
  function decideCurrent(id, { actor = "piper", note = null } = {}, outcome) {
    const wf = mustGet(id);
    if (SETTLED.has(wf.state)) throw new Error("guided_workflow_settled");
    if (wf.state !== "active") throw new Error("guided_workflow_not_active");
    const current = wf.steps.find((s) => s.state === "current");
    if (!current) throw new Error("guided_workflow_not_active");
    const ts = now();
    db.prepare(`
      UPDATE piper_guided_workflow_steps SET state = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?
    `).run(outcome, note || null, actor, ts, current.id);
    const next = wf.steps.find((s) => s.index === current.index + 1);
    if (next) {
      db.prepare("UPDATE piper_guided_workflow_steps SET state = 'current' WHERE id = ?").run(next.id);
      db.prepare("UPDATE piper_guided_workflows SET current_step = ?, updated_at = ? WHERE id = ?")
        .run(next.index, ts, id);
    } else {
      db.prepare("UPDATE piper_guided_workflows SET state = 'completed', current_step = NULL, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(ts, ts, id);
    }
    return get(id);
  }

  function advance(id, options = {}) {
    return decideCurrent(id, options, "done");
  }

  function skip(id, options = {}) {
    return decideCurrent(id, options, "skipped");
  }

  function pause(id) {
    const wf = mustGet(id);
    if (SETTLED.has(wf.state)) throw new Error("guided_workflow_settled");
    if (wf.state !== "active") throw new Error("guided_workflow_invalid_transition");
    db.prepare("UPDATE piper_guided_workflows SET state = 'paused', updated_at = ? WHERE id = ?").run(now(), id);
    return get(id);
  }

  function resume(id) {
    const wf = mustGet(id);
    if (SETTLED.has(wf.state)) throw new Error("guided_workflow_settled");
    if (wf.state !== "paused") throw new Error("guided_workflow_invalid_transition");
    db.prepare("UPDATE piper_guided_workflows SET state = 'active', updated_at = ? WHERE id = ?").run(now(), id);
    return get(id);
  }

  function abandon(id) {
    const wf = mustGet(id);
    if (SETTLED.has(wf.state)) throw new Error("guided_workflow_settled");
    // The record is kept — abandonment is a state, never a delete. The step
    // that was current stays marked current: it is where the work stopped.
    db.prepare("UPDATE piper_guided_workflows SET state = 'abandoned', updated_at = ? WHERE id = ?").run(now(), id);
    return get(id);
  }

  function list({ opportunityId = null, state = null, limit = 50 } = {}) {
    let sql = "SELECT * FROM piper_guided_workflows WHERE tenant_id = ?";
    const args = [scopeTenantId];
    if (opportunityId) { sql += " AND opportunity_id = ?"; args.push(opportunityId); }
    if (state) { sql += " AND state = ?"; args.push(state); }
    sql += " ORDER BY updated_at DESC, rowid DESC LIMIT ?";
    args.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
    return db.prepare(sql).all(...args).map((row) => present(row));
  }

  /** The in-flight (active or paused) workflow for one opportunity, if any. */
  function activeForOpportunity(opportunityId) {
    if (!opportunityId) return null;
    const row = db.prepare(`
      SELECT * FROM piper_guided_workflows
      WHERE tenant_id = ? AND opportunity_id = ? AND state IN ('active','paused')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(scopeTenantId, opportunityId);
    return present(row || null);
  }

  return { tenantId: scopeTenantId, start, get, list, advance, skip, pause, resume, abandon, activeForOpportunity };
}
