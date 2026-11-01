import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app/createApp.js';
import { makeTempDb, testConfig } from './helpers/temporaryDatabase.mjs';
import { openPipelineDatabase } from '../src/database/openDatabase.js';
import { runMigrations } from '../src/database/migrationRunner.js';

/**
 * Security & schema remediation battery (founder remediation order
 * 2026-11-01; QUINCEY findings F1 / F4 / F5 + migration 035).
 *
 *   F1 (MODERATE) — an unapproved high-risk task must not enter ANY
 *   executable/working state before the founder grant: not via
 *   transition(), not via retry(), not by being created in one, not via
 *   a delegated child, and not via raw SQL (migration 034 triggers).
 *   Approval replays must not reset the grant.
 *   F4 (LOW) — the VICTOR reservation binds UPDATEs of the deciding
 *   columns, not just INSERTs (migration 034), while revocation keeps
 *   working.
 *   F5 (LOW) — NULL-tenant work tasks are invisible to tenant-scoped
 *   get/list/report; migration 034 backfills only the rows whose tenant
 *   is determinable from a linked opportunity.
 *   Migration 035 — a pre-035 database upgrades cleanly: source rows are
 *   backfilled from their parent opportunities and the uniqueness
 *   becomes tenant-aware without breaking same-tenant dedupe.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const WORKING = ['researching', 'building', 'editing', 'testing', 'qa', 'waiting', 'retrying'];

function boot(dbPath, overrides = {}) {
  return createApp(testConfig(dbPath, { readOnly: false, ...overrides }));
}
function auditCount(db, eventType) {
  return db.prepare('SELECT COUNT(*) AS c FROM operational_audit_events WHERE event_type = ?').get(eventType).c;
}
/** A migrations dir containing only the .sql files numbered <= `through`. */
function stagedMigrationsDir(through) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-migrations-stage-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (Number(f.slice(0, 3)) <= through) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
}
function insertOpportunity(db, { id, tenantId }) {
  db.prepare(`
    INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
      pipeline_stage, asking_price, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'new_lead', 100000, 'seed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
  `).run(id, tenantId, `OPP-${id}`, `prop-${id}`);
}

// ---------------------------------------------------------------- F1 ----

test('F1: an unapproved high-risk task cannot enter any working state via transition (from queued)', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    const task = room.create({ department: 'OCG OS', title: 'Commit capital', director: 'OCG OS Director', capability: 'capital.commit' });
    assert.equal(task.state, 'queued');
    assert.equal(task.approval_state, 'requested');
    for (const state of [...WORKING, 'complete']) {
      assert.throws(
        () => room.transition({ taskId: task.id, state, actor: 'OCG OS Director' }),
        /approval_envelope_violation/, `queued -> ${state} must be refused before approval`);
      assert.equal(room.get(task.id).state, 'queued', 'a refused transition changes nothing');
    }
    assert.equal(auditCount(app.db, 'AGENT_APPROVAL_ENVELOPE_VIOLATION'), WORKING.length + 1);
  } finally { app.close(); db.cleanup(); }
});

test('F1: the gate holds from awaiting_approval; holding moves and no-execution exits stay open', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    const task = room.create({ department: 'OCG OS', title: 'Destroy staging data', director: 'OCG OS Director', capability: 'data.destructive' });
    room.transition({ taskId: task.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    for (const state of [...WORKING, 'complete']) {
      assert.throws(() => room.transition({ taskId: task.id, state, actor: 'OCG OS Director' }), /approval_envelope_violation/);
    }
    // Retreat to the holding queue executes nothing and stays open.
    assert.equal(room.transition({ taskId: task.id, state: 'queued', actor: 'OCG OS Director' }).state, 'queued');
    room.transition({ taskId: task.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    // No-execution exits stay open without a grant.
    assert.equal(room.transition({ taskId: task.id, state: 'blocked', actor: 'OCG OS Director', blocker: 'Waiting on founder' }).state, 'blocked');
    assert.equal(room.transition({ taskId: task.id, state: 'failed', actor: 'OCG OS Director', summary: 'Abandoned' }).state, 'failed');
  } finally { app.close(); db.cleanup(); }
});

test('F1: create() refuses to birth a high-risk task into a working state; standard tasks are unaffected', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    for (const state of ['building', 'researching', 'complete']) {
      assert.throws(
        () => room.create({ department: 'OCG OS', title: `Born ${state}`, director: 'OCG OS Director', capability: 'data.destructive', state }),
        /approval_envelope_violation/, `create in ${state} must be refused`);
    }
    assert.equal(app.db.prepare("SELECT COUNT(*) AS c FROM agent_work_tasks WHERE title LIKE 'Born %'").get().c, 0, 'refused creations write no task row');
    assert.ok(auditCount(app.db, 'AGENT_APPROVAL_ENVELOPE_VIOLATION') >= 3, 'refused creations are attested');
    // Holding births are fine, and a standard task may still be born working.
    assert.equal(room.create({ department: 'OCG OS', title: 'Born waiting', director: 'OCG OS Director', capability: 'capital.commit', state: 'awaiting_approval' }).state, 'awaiting_approval');
    assert.equal(room.create({ department: 'OCG OS', title: 'Routine build', director: 'OCG OS Director', state: 'building' }).state, 'building');
  } finally { app.close(); db.cleanup(); }
});

test('F1: retry() of an unapproved high-risk task is refused; a granted task retries normally', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    const task = room.create({ department: 'OCG OS', title: 'Wire earnest money', director: 'OCG OS Director', capability: 'capital.commit', maxAttempts: 3 });
    room.transition({ taskId: task.id, state: 'failed', actor: 'OCG OS Director', summary: 'Bank portal down' });
    assert.throws(() => room.retry({ taskId: task.id, actorAgentId: 'OCG OS Director' }), /approval_envelope_violation/);
    const after = room.get(task.id);
    assert.equal(after.state, 'failed');
    assert.equal(after.attempt, 1, 'a refused retry consumes no attempt');

    const granted = room.create({ department: 'OCG OS', title: 'Wire deposit (approved)', director: 'OCG OS Director', capability: 'capital.commit', maxAttempts: 3 });
    room.transition({ taskId: granted.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    room.approve({ taskId: granted.id, actorAgentId: 'Genaro', decision: 'granted' });
    room.transition({ taskId: granted.id, state: 'building', actor: 'OCG OS Director' });
    room.transition({ taskId: granted.id, state: 'failed', actor: 'OCG OS Director', summary: 'Bank portal down' });
    const retried = room.retry({ taskId: granted.id, actorAgentId: 'OCG OS Director' });
    assert.equal(retried.state, 'retrying');
    assert.equal(retried.attempt, 2);
  } finally { app.close(); db.cleanup(); }
});

test('F1: a delegated high-risk child starts governed, and a delegation replay never resets its approval', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom, dir = app.services.agents, caps = app.services.capabilities;
    const founder = dir.byName('Genaro'), hunter = dir.byName('HUNTER');
    caps.grant({ agentId: hunter.id, capability: 'capital.commit', actorAgentId: founder.id });
    const root = room.create({ department: 'OCG OS', title: 'Acquire 500 Pine St', director: 'OCG OS Director', leadAgent: 'HUNTER' });
    const { task: child, deduplicated } = room.delegate({
      parentTaskId: root.id, delegatorAgentId: 'OCG OS Director', delegateeName: 'HUNTER',
      title: 'Commit earnest money', capability: 'capital.commit', idempotencyKey: 'f1-del-1',
    });
    assert.equal(deduplicated, false);
    assert.equal(child.envelope_class, 'high_risk');
    assert.equal(child.state, 'queued');
    assert.equal(child.approval_state, 'requested');
    // Neither the service nor raw SQL can start the child before approval.
    assert.throws(() => room.transition({ taskId: child.id, state: 'building', actor: 'HUNTER' }), /approval_envelope_violation/);
    assert.throws(() => app.db.prepare("UPDATE agent_work_tasks SET state = 'building' WHERE id = ?").run(child.id), /founder approval/);
    assert.equal(room.get(child.id).state, 'queued');
    // Approve, start work, then replay the delegation: the same child comes
    // back with its grant and its progress untouched.
    room.transition({ taskId: child.id, state: 'awaiting_approval', actor: 'OCG OS Director', approvalRequired: true });
    room.approve({ taskId: child.id, actorAgentId: 'Genaro', decision: 'granted' });
    room.transition({ taskId: child.id, state: 'building', actor: 'HUNTER' });
    const replay = room.delegate({
      parentTaskId: root.id, delegatorAgentId: 'OCG OS Director', delegateeName: 'HUNTER',
      title: 'Commit earnest money', capability: 'capital.commit', idempotencyKey: 'f1-del-1',
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.task.id, child.id);
    assert.equal(replay.task.approval_state, 'granted', 'replay must not reset the founder grant');
    assert.equal(replay.task.state, 'building');
  } finally { app.close(); db.cleanup(); }
});

test('F1 at the database boundary: raw SQL cannot birth or move an unapproved high-risk task into work', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const room = app.services.workRoom;
    const insertRaw = (id, state, envelopeClass, approvalState) => app.db.prepare(
      `INSERT INTO agent_work_tasks (id, department, title, director, state, tenant_id, envelope_class, approval_state)
       VALUES (?, 'OCG OS', 'Raw task', 'OCG OS Director', ?, 'ocg-one', ?, ?)`).run(id, state, envelopeClass, approvalState);
    // Births: queued is fine, working is not — for high-risk rows only.
    insertRaw('raw-hr-queued', 'queued', 'high_risk', 'requested');
    assert.throws(() => insertRaw('raw-hr-building', 'building', 'high_risk', 'requested'), /founder approval/);
    insertRaw('raw-std-building', 'building', 'standard', 'none');
    // Moves: working targets raise; holding and exit targets pass.
    const setState = (id, state) => app.db.prepare('UPDATE agent_work_tasks SET state = ? WHERE id = ?').run(state, id);
    assert.throws(() => setState('raw-hr-queued', 'researching'), /founder approval/);
    assert.throws(() => setState('raw-hr-queued', 'complete'), /founder approval/);
    setState('raw-hr-queued', 'awaiting_approval');
    setState('raw-hr-queued', 'canceled');
    // The full legitimate arc at the SQL layer: hold, grant via the
    // service, then work.
    const task = room.create({ department: 'OCG OS', title: 'SQL arc', director: 'OCG OS Director', capability: 'capital.commit' });
    setState(task.id, 'awaiting_approval');
    room.approve({ taskId: task.id, actorAgentId: 'Genaro', decision: 'granted' });
    setState(task.id, 'building');
    assert.equal(app.db.prepare('SELECT state FROM agent_work_tasks WHERE id = ?').get(task.id).state, 'building');
  } finally { app.close(); db.cleanup(); }
});

// ---------------------------------------------------------------- F4 ----

test('F4: the VICTOR reservation binds UPDATEs of role defaults and grants; revocation still works', () => {
  const db = makeTempDb(); const app = boot(db.dbPath);
  try {
    const dir = app.services.agents, caps = app.services.capabilities;
    const founder = dir.byName('Genaro'), director = dir.byName('OCG OS Director'), victor = dir.byName('VICTOR');
    const directorGrant = caps.grant({ agentId: director.id, capability: 'offer.prepare', actorAgentId: founder.id });
    const victorGrant = caps.grant({ agentId: victor.id, capability: 'underwriting.write', actorAgentId: founder.id });
    // Smuggle by rewriting the capability on an existing role default.
    assert.throws(
      () => app.db.prepare("UPDATE agent_role_permissions SET capability = 'underwriting.write' WHERE role = 'director' AND capability = 'work_task.read'").run(),
      /reserved/);
    // Smuggle by renaming VICTOR's role on its own default row.
    assert.throws(
      () => app.db.prepare("UPDATE agent_role_permissions SET role = 'chief' WHERE role = 'victor' AND capability = 'underwriting.write'").run(),
      /reserved/);
    // Smuggle by rewriting the capability on the Director's live grant.
    assert.throws(
      () => app.db.prepare("UPDATE agent_capability_grants SET capability = 'underwriting.write' WHERE id = ?").run(directorGrant.id),
      /reserved/);
    // Smuggle by re-pointing VICTOR's grant at the Director.
    assert.throws(
      () => app.db.prepare("UPDATE agent_capability_grants SET agent_id = ? WHERE id = ?").run(director.id, victorGrant.id),
      /reserved/);
    // Nothing moved: the reservation still resolves exactly as before.
    assert.equal(caps.can(director.id, 'underwriting.write'), false);
    assert.equal(caps.can(victor.id, 'underwriting.write'), true);
    // Revocation — an UPDATE of revoked_at/revoked_by only — does not fire
    // the new triggers, and the explicit deny still beats the role default.
    caps.revoke({ agentId: director.id, capability: 'offer.prepare', actorAgentId: founder.id });
    assert.equal(caps.can(director.id, 'offer.prepare'), false);
  } finally { app.close(); db.cleanup(); }
});

// ---------------------------------------------------------------- F5 ----

test('F5: NULL-tenant tasks are invisible to tenant-scoped get, list, and the Director report', () => {
  const db = makeTempDb(); const app = boot(db.dbPath, { tenantId: 'tenant-a', env: 'production' });
  try {
    const room = app.services.workRoom;
    const mine = room.create({ department: 'OCG OS', title: 'Tenant A work', director: 'OCG OS Director' });
    app.db.prepare(`INSERT INTO agent_work_tasks (id, department, title, director, state, tenant_id) VALUES ('task-null','OCG OS','Unscoped legacy row','OCG OS Director','queued',NULL)`).run();
    app.db.prepare(`INSERT INTO agent_work_tasks (id, department, title, director, state, tenant_id) VALUES ('task-b','OCG OS','Tenant B work','OCG OS Director','queued','tenant-b')`).run();
    assert.equal(room.get('task-null'), null, 'a NULL-tenant task resolves exactly like a foreign one');
    assert.equal(room.get('task-b'), null);
    assert.deepEqual(room.list().map((t) => t.id), [mine.id]);
    assert.equal(app.services.directorReport.build().status.totalTasks, 1);
    // Invisibility, not deletion: the raw rows are untouched.
    assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM agent_work_tasks WHERE tenant_id IS NULL').get().c, 1);
  } finally { app.close(); db.cleanup(); }
});

test('migration 034 backfills a NULL tenant only where a linked opportunity determines it', () => {
  const staged = stagedMigrationsDir(32);
  const tempDb = makeTempDb();
  const db = openPipelineDatabase(tempDb.dbPath);
  try {
    runMigrations(db, staged);
    insertOpportunity(db, { id: 'opp-x', tenantId: 'tenant-x' });
    const insertTask = (id, opportunityId) => db.prepare(
      `INSERT INTO agent_work_tasks (id, department, title, director, state, opportunity_id, tenant_id)
       VALUES (?, 'OCG OS', 'Legacy', 'OCG OS Director', 'queued', ?, NULL)`).run(id, opportunityId);
    insertTask('task-linked', 'opp-x');
    insertTask('task-unlinked', null);
    const applied = runMigrations(db, MIGRATIONS_DIR);
    assert.ok(applied.some((r) => r.file === '034_agent_governance_hardening.sql' && r.status === 'applied'));
    assert.equal(db.prepare('SELECT tenant_id FROM agent_work_tasks WHERE id = ?').get('task-linked').tenant_id, 'tenant-x',
      'a linked row takes its opportunity\u2019s tenant');
    assert.equal(db.prepare('SELECT tenant_id FROM agent_work_tasks WHERE id = ?').get('task-unlinked').tenant_id, null,
      'an unlinked row keeps NULL — its tenant is not determinable and is never invented');
  } finally { db.close(); tempDb.cleanup(); rmSync(staged, { recursive: true, force: true }); }
});

// ------------------------------------------------------- migration 035 ----

test('migration 035: a pre-035 database upgrades cleanly and source uniqueness becomes tenant-aware', () => {
  const staged = stagedMigrationsDir(34);
  const tempDb = makeTempDb();
  const db = openPipelineDatabase(tempDb.dbPath);
  try {
    runMigrations(db, staged);
    insertOpportunity(db, { id: 'opp-a', tenantId: 'tenant-a' });
    insertOpportunity(db, { id: 'opp-b', tenantId: 'tenant-b' });
    // A pre-035 source row: the old column set, no tenant_id anywhere.
    db.prepare(`
      INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
        original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
      VALUES ('src-a', 'opp-a', 'deal_scout_handoff', 'lead-shared', '1 Main St', '2026-10-01T00:00:00Z', 'victor', '2026-10-01T00:00:00Z', '{}')
    `).run();

    const applied = runMigrations(db, MIGRATIONS_DIR);
    assert.ok(applied.some((r) => r.file === '035_source_tenant_uniqueness.sql' && r.status === 'applied'));
    // Backfill: the row took its parent opportunity's tenant.
    assert.equal(db.prepare('SELECT tenant_id FROM seller_opportunity_sources WHERE id = ?').get('src-a').tenant_id, 'tenant-a');
    // The same pair under a DIFFERENT tenant is now a legitimate record.
    db.prepare(`
      INSERT INTO seller_opportunity_sources (id, opportunity_id, tenant_id, source_type, source_record_id,
        original_address, source_timestamp, conversion_actor)
      VALUES ('src-b', 'opp-b', 'tenant-b', 'deal_scout_handoff', 'lead-shared', '1 Main St', '2026-10-01T00:00:00Z', 'victor')
    `).run();
    // The same pair under the SAME tenant still collides — dedupe intact.
    assert.throws(() => db.prepare(`
      INSERT INTO seller_opportunity_sources (id, opportunity_id, tenant_id, source_type, source_record_id,
        original_address, source_timestamp, conversion_actor)
      VALUES ('src-a2', 'opp-a', 'tenant-a', 'deal_scout_handoff', 'lead-shared', '1 Main St', '2026-10-01T00:00:00Z', 'victor')
    `).run(), /UNIQUE/);
    // The certified convert lookup (source leg, parent-tenant scoped)
    // resolves each tenant to its OWN record.
    const lookup = (tenantId) => db.prepare(`
      SELECT sos.opportunity_id FROM seller_opportunity_sources sos
      JOIN seller_opportunities so ON so.id = sos.opportunity_id
      WHERE sos.source_record_id = ? AND sos.source_type = ? AND so.tenant_id = ?
    `).get('lead-shared', 'deal_scout_handoff', tenantId)?.opportunity_id;
    assert.equal(lookup('tenant-a'), 'opp-a');
    assert.equal(lookup('tenant-b'), 'opp-b');
    // The property invariant became tenant-aware in the same migration:
    // a second ACTIVE opportunity for A's property under tenant-b is a
    // legitimate record, while tenant-a still cannot hold two.
    db.prepare(`
      INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
        pipeline_stage, asking_price, created_by, created_at, updated_at)
      VALUES ('opp-b-prop', 'tenant-b', 'OPP-opp-b-prop', 'prop-opp-a', 'new_lead', 100000, 'seed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
    `).run();
    assert.throws(() => db.prepare(`
      INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
        pipeline_stage, asking_price, created_by, created_at, updated_at)
      VALUES ('opp-a-prop2', 'tenant-a', 'OPP-opp-a-prop2', 'prop-opp-a', 'new_lead', 100000, 'seed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
    `).run(), /UNIQUE/);
    // The append-only protection survived the rebuild, and the upgraded
    // database is structurally sound.
    assert.throws(() => db.prepare("UPDATE seller_opportunity_sources SET original_address = 'x' WHERE id = 'src-a'").run(), /prohibited/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); tempDb.cleanup(); rmSync(staged, { recursive: true, force: true }); }
});
