import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/createApp.js';
import { makeTempDb, testConfig, startApp } from './helpers/temporaryDatabase.mjs';

/**
 * Issue #7 — OCG OS Director governance battery.
 *
 * Covers: persistent identity + hierarchy enforcement; least-privilege
 * capability registry with the VICTOR underwriting reservation as a hard
 * constraint (service layer AND schema triggers); governed delegation
 * (parent/child, hierarchy-only, idempotent); bounded retries with
 * founder escalation; founder approval envelopes for high-risk work;
 * tenant isolation of identities/tasks/report (foreign == nonexistent);
 * and the Aiden handoff report derived from real rows only.
 */

function boot(dbPath, overrides = {}) {
  return createApp(testConfig(dbPath, { readOnly: false, ...overrides }));
}
const names = (rows) => rows.map((r) => r.name);
function auditCount(db, eventType) {
  return db.prepare('SELECT COUNT(*) AS c FROM operational_audit_events WHERE event_type = ?').get(eventType).c;
}

test('canonical identities are seeded once, persist across restarts, and form the exact hierarchy', () => {
  const db = makeTempDb();
  let app = boot(db.dbPath);
  try {
    const dir = app.services.agents;
    const agents = dir.list();
    assert.deepEqual(names(agents), ['Genaro', 'Aiden', 'OCG OS Director', 'HUNTER', 'VICTOR', 'PIPER']);
    const victor = dir.byName('VICTOR');
    assert.equal(victor.kind, 'lead');
    assert.equal(victor.role, 'victor');
    // VICTOR's chain: Director -> Aiden -> Genaro, in that order.
    assert.deepEqual(names(dir.managerChain(victor.id)), ['OCG OS Director', 'Aiden', 'Genaro']);
    const aiden = dir.byName('Aiden');
    assert.equal(aiden.kind, 'orchestrator');
    assert.equal(dir.byName('OCG OS Director').manager_agent_id, aiden.id);
    assert.equal(dir.byName('Genaro').manager_agent_id, null);
    // Seeding is idempotent: a second ensure + a full restart change nothing.
    dir.ensureSeeded();
    assert.equal(dir.list().length, 6);
  } finally { app.close(); }
  app = boot(db.dbPath);
  try {
    assert.equal(app.services.agents.list().length, 6);
    assert.equal(app.services.agents.byName('VICTOR').role, 'victor');
  } finally { app.close(); db.cleanup(); }
});

test('hierarchy rules are enforced on identity creation and retirement', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const dir = app.services.agents;
    const founder = dir.byName('Genaro');
    // Non-founder actors cannot manage identities (least privilege).
    assert.throws(
      () => dir.createIdentity({ name: 'Rogue', kind: 'specialist', role: 'specialist', managerName: 'OCG OS Director', actorAgentId: 'OCG OS Director' }),
      /identity_manage_not_authorized/);
    // Manager must exist; an identity cannot be its own manager (acyclic by construction).
    assert.throws(
      () => dir.createIdentity({ name: 'Loop', kind: 'specialist', role: 'specialist', managerName: 'Loop', actorAgentId: founder.id }),
      /agent_manager_not_found/);
    // A director must report to the orchestrator, never to a lead.
    assert.throws(
      () => dir.createIdentity({ name: 'Second Director', kind: 'director', role: 'director', managerName: 'VICTOR', actorAgentId: founder.id }),
      /agent_director_must_report_to_orchestrator/);
    // Duplicate names are refused per tenant.
    assert.throws(
      () => dir.createIdentity({ name: 'VICTOR', kind: 'lead', role: 'victor', managerName: 'OCG OS Director', actorAgentId: founder.id }),
      /agent_name_taken/);
    // A valid specialist, then retirement rules bite in order.
    const spec = dir.createIdentity({ name: 'Research Specialist', kind: 'specialist', role: 'specialist', managerName: 'OCG OS Director', actorAgentId: founder.id });
    assert.equal(spec.status, 'active');
    // The Director cannot be retired while leads report to it.
    assert.throws(() => dir.retireIdentity({ agentId: dir.byName('OCG OS Director').id, actorAgentId: founder.id }), /agent_has_active_reports/);
    const retired = dir.retireIdentity({ agentId: spec.id, actorAgentId: founder.id });
    assert.equal(retired.status, 'retired');
    assert.ok(retired.retired_at);
    assert.ok(auditCount(app.db, 'AGENT_IDENTITY_CREATED') >= 1);
    assert.ok(auditCount(app.db, 'AGENT_IDENTITY_RETIRED') >= 1);
    // A retired identity cannot be a manager for new identities.
    assert.throws(
      () => dir.createIdentity({ name: 'Orphan', kind: 'specialist', role: 'specialist', managerName: 'Research Specialist', actorAgentId: founder.id }),
      /agent_manager_not_active/);
  } finally { app.close(); db.cleanup(); }
});

test('capability registry is default-deny; grants and revocations are founder-gated and audited', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const dir = app.services.agents, caps = app.services.capabilities;
    const founder = dir.byName('Genaro'), director = dir.byName('OCG OS Director');
    const spec = dir.createIdentity({ name: 'Analyst', kind: 'specialist', role: 'specialist', managerName: 'OCG OS Director', actorAgentId: founder.id });
    // Default-deny: a fresh specialist can read the work room and nothing else.
    assert.equal(caps.can(spec.id, 'work_task.read'), true);
    assert.equal(caps.can(spec.id, 'work_task.create'), false);
    assert.equal(caps.can(spec.id, 'offer.prepare'), false);
    assert.equal(caps.can(spec.id, 'nonexistent.capability'), false);
    assert.equal(caps.can('no-such-agent', 'work_task.read'), false);
    // Only a capability.grant holder (founder by default) may grant.
    assert.throws(() => caps.grant({ agentId: spec.id, capability: 'offer.prepare', actorAgentId: director.id }), /capability_grant_not_authorized/);
    const grant = caps.grant({ agentId: spec.id, capability: 'offer.prepare', actorAgentId: founder.id });
    assert.equal(grant.capability, 'offer.prepare');
    assert.equal(caps.can(spec.id, 'offer.prepare'), true);
    caps.revoke({ agentId: spec.id, capability: 'offer.prepare', actorAgentId: founder.id });
    assert.equal(caps.can(spec.id, 'offer.prepare'), false);
    // An explicit revocation beats even a role default (grant -> revoke -> cannot).
    const piper = dir.byName('PIPER');
    assert.equal(caps.can(piper.id, 'work_task.transition'), true);
    caps.grant({ agentId: piper.id, capability: 'work_task.transition', actorAgentId: founder.id });
    caps.revoke({ agentId: piper.id, capability: 'work_task.transition', actorAgentId: founder.id });
    assert.equal(caps.can(piper.id, 'work_task.transition'), false);
    assert.ok(auditCount(app.db, 'AGENT_CAPABILITY_GRANTED') >= 2);
    assert.ok(auditCount(app.db, 'AGENT_CAPABILITY_REVOKED') >= 2);
  } finally { app.close(); db.cleanup(); }
});

test("underwriting.write is hard-reserved to VICTOR — service, role defaults, and schema triggers", () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const dir = app.services.agents, caps = app.services.capabilities;
    const founder = dir.byName('Genaro'), director = dir.byName('OCG OS Director'), victor = dir.byName('VICTOR');
    assert.equal(caps.can(victor.id, 'underwriting.write'), true);
    assert.equal(caps.can(director.id, 'underwriting.write'), false);
    // Strict reservation: even the founder qua operator does not hold the pen.
    assert.equal(caps.can(founder.id, 'underwriting.write'), false);
    assert.equal(caps.capabilityDef('underwriting.write').reserved_role, 'victor');
    // Service layer refuses the grant with the named error.
    assert.throws(() => caps.grant({ agentId: director.id, capability: 'underwriting.write', actorAgentId: founder.id }), /capability_reserved_for_victor/);
    // Granting it to VICTOR is a harmless no-op success (role default already covers it).
    const g = caps.grant({ agentId: victor.id, capability: 'underwriting.write', actorAgentId: founder.id });
    assert.equal(g.agent_id, victor.id);
    // Schema layer: direct SQL cannot smuggle the capability to the Director.
    assert.throws(
      () => app.db.prepare(`INSERT INTO agent_capability_grants (id, tenant_id, agent_id, capability, effect, granted_by) VALUES ('x1','ocg-one',?,'underwriting.write','write','Genaro')`).run(director.id),
      /reserved/);
    assert.throws(
      () => app.db.prepare(`INSERT INTO agent_role_permissions (role, capability, effect) VALUES ('director','underwriting.write','write')`).run(),
      /reserved/);
    // High-risk tiers are registered for the Issue #7 approval classes.
    for (const cap of ['capital.commit', 'data.destructive', 'data.release_sensitive', 'capability.grant', 'identity.manage']) {
      assert.equal(caps.capabilityDef(cap).risk_tier, 'high_risk', `${cap} must be high-risk`);
    }
  } finally { app.close(); db.cleanup(); }
});

test('delegation builds a hierarchy-bound, idempotent parent/child tree', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom, dir = app.services.agents;
    const root = room.create({ department: 'OCG OS', title: 'Acquire 500 Pine St', director: 'OCG OS Director', leadAgent: 'HUNTER' });
    const { task: child, deduplicated } = room.delegate({
      parentTaskId: root.id, delegatorAgentId: 'OCG OS Director', delegateeName: 'VICTOR',
      title: 'Underwrite 500 Pine St', capability: 'underwriting.write', idempotencyKey: 'del-500-pine-uw',
    });
    assert.equal(deduplicated, false);
    assert.equal(child.parent_task_id, root.id);
    assert.equal(child.tenant_id, 'ocg-one');
    assert.equal(child.lead_agent, 'VICTOR');
    assert.equal(child.capability, 'underwriting.write');
    assert.equal(child.envelope_class, 'standard');
    const delegationEvents = child.events.filter((e) => e.event_type === 'delegated' && e.to_actor === 'VICTOR');
    assert.ok(delegationEvents.length >= 1);
    const eventCount = child.events.length;
    // Replay with the same idempotency key: same task, no new rows or events.
    const replay = room.delegate({
      parentTaskId: root.id, delegatorAgentId: 'OCG OS Director', delegateeName: 'VICTOR',
      title: 'Underwrite 500 Pine St', capability: 'underwriting.write', idempotencyKey: 'del-500-pine-uw',
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.task.id, child.id);
    assert.equal(room.get(child.id).events.length, eventCount);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM agent_work_tasks').get().c, 2);
    // Delegation flows down the manager chain only: VICTOR cannot delegate to PIPER.
    assert.throws(() => room.delegate({ parentTaskId: root.id, delegatorAgentId: 'VICTOR', delegateeName: 'PIPER', title: 'x' }), /delegation_outside_hierarchy/);
    // Inside the chain but without the capability: VICTOR is the manager of
    // its own specialist yet holds no work_task.delegate default.
    const founder = dir.byName('Genaro');
    dir.createIdentity({ name: 'Victor Analyst', kind: 'specialist', role: 'specialist', managerName: 'VICTOR', actorAgentId: founder.id });
    assert.throws(() => room.delegate({ parentTaskId: root.id, delegatorAgentId: 'VICTOR', delegateeName: 'Victor Analyst', title: 'x' }), /agent_capability_denied/);
    // A delegatee must actually hold the delegated capability.
    assert.throws(() => room.delegate({ parentTaskId: root.id, delegatorAgentId: 'OCG OS Director', delegateeName: 'HUNTER', title: 'x', capability: 'underwriting.write' }), /delegatee_capability_denied/);
    // Retired agents cannot receive work.
    const temp = dir.createIdentity({ name: 'Temp Scout', kind: 'specialist', role: 'specialist', managerName: 'OCG OS Director', actorAgentId: founder.id });
    dir.retireIdentity({ agentId: temp.id, actorAgentId: founder.id });
    assert.throws(() => room.delegate({ parentTaskId: root.id, delegatorAgentId: 'OCG OS Director', delegateeName: 'Temp Scout', title: 'x' }), /agent_not_active/);
    assert.ok(auditCount(app.db, 'AGENT_TASK_DELEGATED') >= 1);
  } finally { app.close(); db.cleanup(); }
});

test('retry is bounded, state-gated, and escalates to the founder at the bound', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    const task = room.create({ department: 'OCG OS', title: 'Flaky evidence pull', director: 'OCG OS Director', leadAgent: 'HUNTER', maxAttempts: 2 });
    // Cannot retry work that has not failed or blocked.
    assert.throws(() => room.retry({ taskId: task.id, actorAgentId: 'OCG OS Director' }), /work_task_not_retryable/);
    room.transition({ taskId: task.id, state: 'failed', actor: 'HUNTER', summary: 'Source timed out' });
    const retried = room.retry({ taskId: task.id, actorAgentId: 'OCG OS Director' });
    assert.equal(retried.state, 'retrying');
    assert.equal(retried.attempt, 2);
    assert.ok(retried.events.some((e) => e.event_type === 'retry'));
    room.transition({ taskId: task.id, state: 'failed', actor: 'HUNTER', summary: 'Source timed out again' });
    const escalationsBefore = auditCount(app.db, 'AGENT_TASK_ESCALATED');
    assert.throws(() => room.retry({ taskId: task.id, actorAgentId: 'OCG OS Director' }), /max_attempts_exceeded/);
    const settledTask = room.get(task.id);
    assert.equal(settledTask.state, 'failed');
    assert.ok(settledTask.settled_at);
    assert.equal(auditCount(app.db, 'AGENT_TASK_ESCALATED'), escalationsBefore + 1);
  } finally { app.close(); db.cleanup(); }
});

test('high-risk approval envelope: system-enforced, founder-only, denial settles to blocked', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    // Envelope class is DERIVED from the capability registry — the caller
    // cannot talk a capital commitment down to 'standard'.
    const task = room.create({ department: 'OCG OS', title: 'Commit capital for 500 Pine St', director: 'OCG OS Director', capability: 'capital.commit' });
    assert.equal(task.envelope_class, 'high_risk');
    assert.equal(task.approval_required, 1);
    assert.equal(task.approval_state, 'requested');
    assert.ok(task.events.some((e) => e.event_type === 'approval_requested'));
    assert.ok(auditCount(app.db, 'AGENT_TASK_ESCALATED') >= 1);
    // F1 remediation (2026-11-01): the pre-fix battery moved the task
    // queued -> researching here, before approval — that step exercised
    // exactly the start-of-work hole QUINCEY F1 documents, so it is
    // removed; the envelope flow is queued -> awaiting_approval ->
    // founder grant -> work. Every assertion in this test is unchanged.
    room.transition({ taskId: task.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    // Bare transitions out of the envelope are refused and audited.
    assert.throws(() => room.transition({ taskId: task.id, state: 'building', actor: 'OCG OS Director' }), /approval_envelope_violation/);
    assert.throws(() => room.transition({ taskId: task.id, state: 'complete', actor: 'OCG OS Director' }), /approval_envelope_violation/);
    assert.ok(auditCount(app.db, 'AGENT_APPROVAL_ENVELOPE_VIOLATION') >= 2);
    // Neither the Director nor Aiden can approve — founder only.
    assert.throws(() => room.approve({ taskId: task.id, actorAgentId: 'OCG OS Director', decision: 'granted' }), /approval_not_authorized/);
    assert.throws(() => room.approve({ taskId: task.id, actorAgentId: 'Aiden', decision: 'granted' }), /approval_not_authorized/);
    const granted = room.approve({ taskId: task.id, actorAgentId: 'Genaro', decision: 'granted', summary: 'Founder approved the capital envelope' });
    assert.equal(granted.approval_state, 'granted');
    assert.equal(granted.approved_by, 'Genaro');
    assert.ok(granted.events.some((e) => e.event_type === 'approval_granted'));
    const done = room.transition({ taskId: task.id, state: 'complete', actor: 'OCG OS Director', summary: 'Capital committed under envelope' });
    assert.equal(done.state, 'complete');
    // Denial path: a second high-risk task denied by the founder blocks.
    const task2 = room.create({ department: 'OCG OS', title: 'Release seller PII extract', director: 'OCG OS Director', capability: 'data.release_sensitive' });
    assert.equal(task2.envelope_class, 'high_risk');
    room.transition({ taskId: task2.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    const denied = room.approve({ taskId: task2.id, actorAgentId: 'Genaro', decision: 'denied', summary: 'Not authorized' });
    assert.equal(denied.approval_state, 'denied');
    assert.equal(denied.state, 'blocked');
    assert.ok(denied.events.some((e) => e.event_type === 'approval_denied'));
    // Legacy standard tasks keep caller-asserted approval semantics:
    // approval_required alone never triggers envelope enforcement.
    const legacy = room.create({ department: 'OCG OS', title: 'Routine review', director: 'OCG OS Director', approvalRequired: true });
    assert.equal(legacy.envelope_class, 'standard');
    room.transition({ taskId: legacy.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    const legacyDone = room.transition({ taskId: legacy.id, state: 'complete', actor: 'OCG OS Director' });
    assert.equal(legacyDone.state, 'complete');
  } finally { app.close(); db.cleanup(); }
});

test('tenant isolation: foreign identities, tasks, and reports are indistinguishable from nonexistent', () => {
  const db = makeTempDb();
  const app = boot(db.dbPath, { tenantId: 'tenant-a', env: 'production' });
  try {
    const room = app.services.workRoom, dir = app.services.agents;
    const mine = room.create({ department: 'OCG OS', title: 'Tenant A work', director: 'OCG OS Director' });
    assert.equal(mine.tenant_id, 'tenant-a');
    // Seed a foreign tenant's rows directly (another deployment's data in the same file).
    app.db.prepare(`INSERT INTO agent_work_tasks (id, department, title, director, state, tenant_id) VALUES ('task-b','OCG OS','Tenant B work','OCG OS Director','queued','tenant-b')`).run();
    app.db.prepare(`INSERT INTO agent_identities (id, tenant_id, name, kind, role, status) VALUES ('agent-b','tenant-b','VICTOR','lead','victor','active')`).run();
    assert.equal(room.get('task-b'), null);
    assert.equal(dir.get('agent-b'), null);
    assert.ok(room.list().every((t) => t.id !== 'task-b'));
    assert.throws(() => room.delegate({ parentTaskId: 'task-b', delegatorAgentId: 'OCG OS Director', delegateeName: 'VICTOR', title: 'x' }), /work_task_not_found/);
    // Name resolution never crosses the boundary: tenant-a's VICTOR is a different row.
    assert.equal(dir.byName('VICTOR').tenant_id, 'tenant-a');
    const report = app.services.directorReport.build();
    assert.equal(report.status.tenantId, 'tenant-a');
    assert.equal(report.status.totalTasks, 1);
    // Foreign rows are untouched by everything above.
    const foreign = app.db.prepare('SELECT title FROM agent_work_tasks WHERE id = ?').get('task-b');
    assert.equal(foreign.title, 'Tenant B work');
  } finally { app.close(); db.cleanup(); }
});

test('director report is the six-field Aiden contract, traced to real rows only', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    const done = room.create({ department: 'OCG OS', title: 'Evidence pull', director: 'OCG OS Director', leadAgent: 'HUNTER' });
    room.event({ taskId: done.id, eventType: 'tool_completed', actor: 'HUNTER', toolName: 'property-records', summary: 'Records recovered', evidenceRef: 'evidence://property/500-pine' });
    room.transition({ taskId: done.id, state: 'complete', actor: 'OCG OS Director' });
    const blocked = room.create({ department: 'OCG OS', title: 'Seller outreach', director: 'OCG OS Director', leadAgent: 'PIPER' });
    room.transition({ taskId: blocked.id, state: 'blocked', actor: 'PIPER', blocker: 'Seller phone unreachable' });
    const risky = room.create({ department: 'OCG OS', title: 'Wire earnest money', director: 'OCG OS Director', capability: 'capital.commit' });
    room.transition({ taskId: risky.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    const queued = room.create({ department: 'OCG OS', title: 'Queue comps pull', director: 'OCG OS Director', currentAction: 'Waiting for assignment' });

    const report = app.services.directorReport.build();
    assert.deepEqual(Object.keys(report).sort(), ['blockers', 'decisionsRequired', 'evidence', 'nextActions', 'risks', 'status']);
    assert.equal(report.status.totalTasks, 4);
    assert.equal(report.status.byState.complete, 1);
    assert.equal(report.status.byState.blocked, 1);
    assert.equal(report.status.byState.awaiting_approval, 1);
    assert.ok(report.evidence.some((e) => e.taskId === done.id && e.evidenceRef === 'evidence://property/500-pine'));
    assert.ok(report.blockers.some((b) => b.taskId === blocked.id && b.blocker === 'Seller phone unreachable'));
    assert.ok(report.decisionsRequired.some((d) => d.taskId === risky.id && d.capability === 'capital.commit'));
    assert.ok(report.risks.some((r) => r.taskId === risky.id && r.kind === 'high_risk_unapproved'));
    assert.ok(report.nextActions.some((n) => n.taskId === queued.id && n.currentAction === 'Waiting for assignment'));
    // Honesty: nothing derived carries invented progress metrics.
    assert.doesNotMatch(JSON.stringify(report), /percent|progress_\d|estimated/i);
  } finally { app.close(); db.cleanup(); }
});

test('governance HTTP surface: agents, grants, delegation, approval, and the report', async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { readOnly: false }));
  t.after(() => { app.close(); db.cleanup(); });
  const post = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  // Identities are listed for the tenant.
  let res = await fetch(`${baseUrl}/api/v1/agents`);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.data.agents.length, 6);
  const director = body.data.agents.find((a) => a.name === 'OCG OS Director');
  // The VICTOR reservation holds over HTTP too.
  let out = await post(`/api/v1/agents/${director.id}/capabilities`, { capability: 'underwriting.write', actorAgent: 'Genaro' });
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'capability_reserved_for_victor');
  // Create a root task, delegate, and read the report back.
  out = await post('/api/v1/work-room', { department: 'OCG OS', title: 'HTTP governance flow', director: 'OCG OS Director' });
  assert.equal(out.status, 201);
  const rootId = out.body.data.task.id;
  out = await post(`/api/v1/work-room/${rootId}/delegate`, { delegatorAgentId: 'OCG OS Director', delegateeName: 'VICTOR', title: 'Underwrite it', capability: 'underwriting.write', idempotencyKey: 'http-del-1' });
  assert.equal(out.status, 201);
  assert.equal(out.body.data.deduplicated, false);
  out = await post(`/api/v1/work-room/${rootId}/delegate`, { delegatorAgentId: 'OCG OS Director', delegateeName: 'VICTOR', title: 'Underwrite it', capability: 'underwriting.write', idempotencyKey: 'http-del-1' });
  assert.equal(out.status, 201);
  assert.equal(out.body.data.deduplicated, true);
  res = await fetch(`${baseUrl}/api/v1/work-room/director-report`);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.data.report.status.totalTasks, 2);
  // Foreign/unknown agent id is a 404, never a leak.
  res = await fetch(`${baseUrl}/api/v1/agents/does-not-exist`);
  assert.equal(res.status, 404);
});
