import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import {
  handleAidenCallIntegration,
  handleAidenInboxState,
  handleAidenRecordingPlayback,
} from "../src/http/routes/aidenCallIntegration.js";

const TOKEN = "test-inbox-state-intake-token-123456";
const INBOX_TOKEN = "test-inbox-state-read-token-123456789";
const ENV_KEYS = ["AIDEN_CALL_INTAKE_TOKEN", "AIDEN_CALL_RECORD_FILE", "AIDEN_INBOX_ACCESS_TOKEN", "VAPI_PRIVATE_API_KEY"];

function snapshotEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function startRig(folder) {
  process.env.AIDEN_CALL_INTAKE_TOKEN = TOKEN;
  process.env.AIDEN_CALL_RECORD_FILE = join(folder, "records.jsonl");
  const ctx = { config: { dbPath: join(folder, "pipeline.db") } };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.headers.authorization === "Bearer TEST_OP") req.operatorAuth = { actor: "test" };
    if (url.pathname === "/inbox-state") return handleAidenInboxState(req, res, ctx);
    if (url.pathname === "/recording") return handleAidenRecordingPlayback(req, res, ctx, url);
    return handleAidenCallIntegration(req, res, ctx);
  });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  const base = "http://127.0.0.1:" + server.address().port;
  const jsonHeaders = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
  const opHeaders = { authorization: "Bearer TEST_OP", "content-type": "application/json" };
  return {
    server,
    base,
    async seed(id, extra = {}) {
      const r = await fetch(base + "/records", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ id, message: "msg " + id, ...extra }) });
      assert.equal(r.status, 200);
    },
    async statePost(body, headers = jsonHeaders) {
      const r = await fetch(base + "/inbox-state", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
    async stateGet(headers = { authorization: "Bearer " + TOKEN }) {
      const r = await fetch(base + "/inbox-state", { headers });
      return { status: r.status, body: await r.json() };
    },
    async recordsGet(qs = "", headers = { authorization: "Bearer " + TOKEN }) {
      const r = await fetch(base + "/records" + qs, { headers });
      return { status: r.status, body: await r.json() };
    },
    async patch(id, action) {
      const r = await fetch(base + "/records", { method: "PATCH", headers: opHeaders, body: JSON.stringify({ id, action }) });
      return { status: r.status, body: await r.json() };
    },
    async close() { await new Promise(ok => server.close(ok)); },
  };
}

test("inbox-state transition matrix: trash, restore, purge with per-id truth", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-state-"));
  const rig = await startRig(folder);
  try {
    for (const id of ["r1", "r2", "r3", "r4"]) await rig.seed(id);
    // trash single via id
    let out = await rig.statePost({ action: "trash", id: "r1" });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.results, [{ id: "r1", ok: true, status: "trashed" }]);
    // trash again -> already_trashed
    out = await rig.statePost({ action: "trash", id: "r1" });
    assert.deepEqual(out.body.results, [{ id: "r1", ok: false, error: "already_trashed" }]);
    // unknown id -> not_found
    out = await rig.statePost({ action: "trash", id: "nope" });
    assert.deepEqual(out.body.results, [{ id: "nope", ok: false, error: "not_found" }]);
    // restore / purge from inbox -> not_trashed
    out = await rig.statePost({ action: "restore", id: "r2" });
    assert.deepEqual(out.body.results, [{ id: "r2", ok: false, error: "not_trashed" }]);
    out = await rig.statePost({ action: "purge", id: "r2" });
    assert.deepEqual(out.body.results, [{ id: "r2", ok: false, error: "not_trashed" }]);
    // bulk trash with mixed outcomes
    out = await rig.statePost({ action: "trash", ids: ["r2", "r3", "nope"] });
    assert.deepEqual(out.body.results, [
      { id: "r2", ok: true, status: "trashed" },
      { id: "r3", ok: true, status: "trashed" },
      { id: "nope", ok: false, error: "not_found" },
    ]);
    // restore from trash
    out = await rig.statePost({ action: "restore", ids: ["r2"] });
    assert.deepEqual(out.body.results, [{ id: "r2", ok: true, status: "inbox" }]);
    // purge from trash, then every action on purged -> "purged"
    out = await rig.statePost({ action: "purge", id: "r3" });
    assert.deepEqual(out.body.results, [{ id: "r3", ok: true, status: "purged" }]);
    for (const action of ["trash", "restore", "purge"]) {
      out = await rig.statePost({ action, id: "r3" });
      assert.deepEqual(out.body.results, [{ id: "r3", ok: false, error: "purged" }], action);
    }
    // operator-deleted record -> "deleted" for gateway actions
    assert.equal((await rig.patch("r4", "delete")).status, 200);
    out = await rig.statePost({ action: "trash", id: "r4" });
    assert.deepEqual(out.body.results, [{ id: "r4", ok: false, error: "deleted" }]);
    out = await rig.statePost({ action: "restore", id: "r4" });
    assert.deepEqual(out.body.results, [{ id: "r4", ok: false, error: "deleted" }]);
    // summary endpoint shape
    const summary = await rig.stateGet();
    assert.equal(summary.status, 200);
    assert.equal(summary.body.ok, true);
    assert.equal(typeof summary.body.trashed.r1.deletedAt, "string");
    assert.deepEqual(summary.body.purged, ["r3"]);
    // disk truth: trashed carries deletedAt, purged does not
    const disk = JSON.parse(await readFile(join(folder, "aiden-message-state.json"), "utf8"));
    assert.equal(disk.r1.status, "trashed");
    assert.equal(typeof disk.r1.deletedAt, "string");
    assert.equal(disk.r3.status, "purged");
    assert.equal("deletedAt" in disk.r3, false);
    assert.equal(disk.r2.status, "inbox");
    assert.equal("deletedAt" in disk.r2, false);
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});

test("empty-trash requires confirm:true and purges every trashed record", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-empty-"));
  const rig = await startRig(folder);
  try {
    for (const id of ["e1", "e2", "e3"]) await rig.seed(id);
    await rig.statePost({ action: "trash", ids: ["e1", "e2"] });
    let out = await rig.statePost({ action: "empty-trash" });
    assert.equal(out.status, 400);
    out = await rig.statePost({ action: "empty-trash", confirm: false });
    assert.equal(out.status, 400);
    out = await rig.statePost({ action: "empty-trash", confirm: "true" });
    assert.equal(out.status, 400);
    out = await rig.statePost({ action: "empty-trash", confirm: true });
    assert.equal(out.status, 200);
    assert.deepEqual([...out.body.purged].sort(), ["e1", "e2"]);
    const summary = await rig.stateGet();
    assert.deepEqual(summary.body.trashed, {});
    assert.deepEqual([...summary.body.purged].sort(), ["e1", "e2"]);
    // second run is a well-formed no-op
    out = await rig.statePost({ action: "empty-trash", confirm: true });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.purged, []);
    // e3 was never trashed and stays actionable
    out = await rig.statePost({ action: "trash", id: "e3" });
    assert.deepEqual(out.body.results, [{ id: "e3", ok: true, status: "trashed" }]);
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});

test("records GET views: default unchanged, inbox excludes trash states, trash shows deletedAt", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-views-"));
  const rig = await startRig(folder);
  try {
    for (const id of ["va", "vb", "vc", "vd", "ve"]) await rig.seed(id);
    assert.equal((await rig.patch("vb", "archive")).status, 200);
    await rig.statePost({ action: "trash", id: "vc" });
    await rig.statePost({ action: "trash", id: "vd" });
    await rig.statePost({ action: "purge", id: "vd" });
    assert.equal((await rig.patch("ve", "delete")).status, 200);
    const byId = rows => Object.fromEntries(rows.map(r => [r.id, r]));
    // default: exactly the legacy rule (exclude deleted only, annotate inboxStatus)
    let out = await rig.recordsGet();
    assert.equal(out.status, 200);
    let rows = byId(out.body.messages);
    assert.deepEqual(Object.keys(rows).sort(), ["va", "vb", "vc", "vd"]);
    assert.equal(rows.va.inboxStatus, "inbox");
    assert.equal(rows.vb.inboxStatus, "archived");
    assert.equal(rows.vc.inboxStatus, "trashed");
    assert.equal(rows.vd.inboxStatus, "purged");
    assert.equal("deletedAt" in rows.vc, false);
    // inbox view: also excludes trashed + purged
    out = await rig.recordsGet("?view=inbox");
    assert.deepEqual(out.body.messages.map(r => r.id).sort(), ["va", "vb"]);
    // trash view: only trashed, annotated with deletedAt
    out = await rig.recordsGet("?view=trash");
    assert.equal(out.body.messages.length, 1);
    assert.equal(out.body.messages[0].id, "vc");
    assert.equal(out.body.messages[0].inboxStatus, "trashed");
    assert.equal(typeof out.body.messages[0].deletedAt, "string");
    // unknown views are rejected
    assert.equal((await rig.recordsGet("?view=archived")).status, 400);
    assert.equal((await rig.recordsGet("?view=")).status, 400);
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});

test("recording playback is blocked for trashed, purged and deleted records", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-playback-"));
  process.env.VAPI_PRIVATE_API_KEY = "test-vapi-key-not-real";
  const rig = await startRig(folder);
  try {
    for (const id of ["p1", "p2", "p3"]) await rig.seed(id, { recordingUrl: "https://example.invalid/rec.mp3" });
    await rig.statePost({ action: "trash", id: "p1" });
    await rig.statePost({ action: "trash", id: "p2" });
    await rig.statePost({ action: "purge", id: "p2" });
    assert.equal((await rig.patch("p3", "delete")).status, 200);
    const op = { authorization: "Bearer TEST_OP" };
    for (const id of ["p1", "p2", "p3"]) {
      const r = await fetch(rig.base + "/recording?id=" + id, { headers: op });
      assert.equal(r.status, 404, id);
      assert.equal((await r.json()).error, "not_found");
    }
    // unauthenticated playback is still rejected first
    assert.equal((await fetch(rig.base + "/recording?id=p1")).status, 401);
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});

test("operator PATCH cross-actions against trash states", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-patch-"));
  const rig = await startRig(folder);
  try {
    for (const id of ["x1", "x2", "x3"]) await rig.seed(id);
    // archive on trashed -> 409 already_trashed (restore first)
    await rig.statePost({ action: "trash", id: "x1" });
    let out = await rig.patch("x1", "archive");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "already_trashed");
    // restore on trashed -> inbox, deletedAt dropped
    out = await rig.patch("x1", "restore");
    assert.equal(out.status, 200);
    assert.equal(out.body.status, "inbox");
    let disk = JSON.parse(await readFile(join(folder, "aiden-message-state.json"), "utf8"));
    assert.equal("deletedAt" in disk.x1, false);
    // delete on trashed -> deleted
    await rig.statePost({ action: "trash", id: "x1" });
    out = await rig.patch("x1", "delete");
    assert.equal(out.status, 200);
    assert.equal(out.body.status, "deleted");
    // purged is terminal for every PATCH action
    await rig.statePost({ action: "trash", id: "x2" });
    await rig.statePost({ action: "purge", id: "x2" });
    for (const action of ["archive", "restore", "delete"]) {
      out = await rig.patch("x2", action);
      assert.equal(out.status, 409, action);
      assert.equal(out.body.error, "already_purged");
    }
    // legacy PATCH semantics on untouched records are unchanged
    out = await rig.patch("x3", "archive");
    assert.equal(out.status, 200);
    assert.equal(out.body.status, "archived");
    out = await rig.patch("x3", "restore");
    assert.equal(out.status, 200);
    assert.equal(out.body.status, "inbox");
    out = await rig.patch("x3", "delete");
    assert.equal(out.status, 200);
    out = await rig.patch("x3", "restore");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "already_deleted");
    disk = JSON.parse(await readFile(join(folder, "aiden-message-state.json"), "utf8"));
    assert.equal(disk.x2.status, "purged");
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});

test("inbox-state auth and malformed requests", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-auth-"));
  process.env.AIDEN_INBOX_ACCESS_TOKEN = INBOX_TOKEN;
  const rig = await startRig(folder);
  try {
    await rig.seed("a1");
    // no token / wrong token / inbox read token: all rejected (integration bearer only)
    assert.equal((await rig.stateGet({})).status, 401);
    assert.equal((await rig.stateGet({ authorization: "Bearer wrong-token-that-is-long-enough-x" })).status, 401);
    assert.equal((await rig.stateGet({ authorization: "Bearer " + INBOX_TOKEN })).status, 401);
    const noAuthPost = await fetch(rig.base + "/inbox-state", { method: "POST", body: "{}" });
    assert.equal(noAuthPost.status, 401);
    const inboxTokenPost = await rig.statePost({ action: "trash", id: "a1" }, { authorization: "Bearer " + INBOX_TOKEN, "content-type": "application/json" });
    assert.equal(inboxTokenPost.status, 401);
    // malformed bodies and actions -> 400
    assert.equal((await rig.statePost("not json")).status, 400);
    assert.equal((await rig.statePost({})).status, 400);
    assert.equal((await rig.statePost({ action: "bogus", id: "a1" })).status, 400);
    assert.equal((await rig.statePost({ action: "trash" })).status, 400);
    assert.equal((await rig.statePost({ action: "trash", ids: "a1" })).status, 400);
    assert.equal((await rig.statePost({ action: "trash", ids: [42] })).status, 400);
    assert.equal((await rig.statePost({ action: "trash", id: 42 })).status, 400);
    // an empty id list is a well-formed no-op
    const empty = await rig.statePost({ action: "trash", ids: [] });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.results, []);
    // unsupported method with valid auth -> 405
    const del = await fetch(rig.base + "/inbox-state", { method: "DELETE", headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(del.status, 405);
    // none of the rejected calls changed state
    const summary = await rig.stateGet();
    assert.deepEqual(summary.body.trashed, {});
    assert.deepEqual(summary.body.purged, []);
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});

test("state persists across a restart and the writer fsyncs", async () => {
  const saved = snapshotEnv();
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-restart-"));
  let rig = await startRig(folder);
  try {
    await rig.seed("s1");
    await rig.seed("s2");
    await rig.statePost({ action: "trash", id: "s1" });
    await rig.statePost({ action: "trash", id: "s2" });
    await rig.statePost({ action: "purge", id: "s2" });
    await rig.close();
    // the state file itself carries the truth on disk
    const disk = JSON.parse(await readFile(join(folder, "aiden-message-state.json"), "utf8"));
    assert.equal(disk.s1.status, "trashed");
    assert.equal(disk.s2.status, "purged");
    // a fresh server instance over the same files sees the same state
    rig = await startRig(folder);
    const summary = await rig.stateGet();
    assert.equal(typeof summary.body.trashed.s1.deletedAt, "string");
    assert.deepEqual(summary.body.purged, ["s2"]);
    const trashView = await rig.recordsGet("?view=trash");
    assert.deepEqual(trashView.body.messages.map(r => r.id), ["s1"]);
    const inboxView = await rig.recordsGet("?view=inbox");
    assert.deepEqual(inboxView.body.messages, []);
    // the state writer fsyncs the temp file and the directory
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "http", "routes", "aidenCallIntegration.js"), "utf8");
    assert.ok((source.match(/\.sync\(\)/g) || []).length >= 2, "expected temp-file and directory fsync calls");
  } finally {
    await rig.close();
    restoreEnv(saved);
    await rm(folder, { recursive: true, force: true });
  }
});
