import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { handleAidenCallIntegration } from "../src/http/routes/aidenCallIntegration.js";

test("durable Aiden reports: auth, idempotency, retrieval", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aiden-intake-"));
  const file = join(folder, "reports.jsonl");
  const priorKey = process.env.AIDEN_CALL_INTAKE_TOKEN;
  const priorFile = process.env.AIDEN_CALL_RECORD_FILE;
  const token = "qa-aiden-reports-durable-secret-12345";
  process.env.AIDEN_CALL_INTAKE_TOKEN = token;
  process.env.AIDEN_CALL_RECORD_FILE = file;
  const ctx = { config: { dbPath: join(folder, "pipeline.db") } };
  const server = createServer((req, res) => handleAidenCallIntegration(req, res, ctx));
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + server.address().port;
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const payload = { id: "call-test-001", message: "Interested in OCG LAB", from: "+13165550199" };
    for (let n = 0; n < 2; n++) {
      const sent = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) });
      assert.equal(sent.status, 200);
    }
    const retrieved = await fetch(url, { headers: { authorization: "Bearer " + token } });
    assert.equal(retrieved.status, 200);
    const rows = (await retrieved.json()).messages;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message, payload.message);
    const disk = await readFile(file, "utf8");
    assert.equal(disk.trim().split("\n").length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (priorKey === undefined) delete process.env.AIDEN_CALL_INTAKE_TOKEN; else process.env.AIDEN_CALL_INTAKE_TOKEN = priorKey;
    if (priorFile === undefined) delete process.env.AIDEN_CALL_RECORD_FILE; else process.env.AIDEN_CALL_RECORD_FILE = priorFile;
    await rm(folder, { recursive: true, force: true });
  }
});

test("operator inbox: authorized GET, unauthenticated GET rejected, webhook POST remains restricted", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-auth-"));
  const file = join(folder, "records.jsonl");
  const previousToken = process.env.AIDEN_CALL_INTAKE_TOKEN;
  const previousFile = process.env.AIDEN_CALL_RECORD_FILE;
  process.env.AIDEN_CALL_INTAKE_TOKEN = "test-aiden-private-intake-token-123456";
  process.env.AIDEN_CALL_RECORD_FILE = file;
  const ctx = { config: { dbPath: join(folder, "pipeline.db") } };
  const server = createServer((req, res) => {
    if (req.headers.authorization === "Bearer TEST_OPERATOR") req.operatorAuth = { actor: "test" };
    return handleAidenCallIntegration(req, res, ctx);
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const record = { id: "inbox-001", message: "Please call back", callerName: "Caller", from: "+13165550000" };
    const posted = await fetch(base, { method: "POST", headers: { authorization: "Bearer test-aiden-private-intake-token-123456", "content-type": "application/json" }, body: JSON.stringify(record) });
    assert.equal(posted.status, 200);
    const anonymous = await fetch(base);
    assert.equal(anonymous.status, 401);
    const operator = await fetch(base, { headers: { authorization: "Bearer TEST_OPERATOR" } });
    assert.equal(operator.status, 200);
    const result = await operator.json();
    assert.equal(result.messages[0].callerName, "Caller");
    const forbiddenWrite = await fetch(base, { method: "POST", headers: { authorization: "Bearer TEST_OPERATOR", "content-type": "application/json" }, body: JSON.stringify({ id: "unexpected", message: "bad" }) });
    assert.equal(forbiddenWrite.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.AIDEN_CALL_INTAKE_TOKEN; else process.env.AIDEN_CALL_INTAKE_TOKEN = previousToken;
    if (previousFile === undefined) delete process.env.AIDEN_CALL_RECORD_FILE; else process.env.AIDEN_CALL_RECORD_FILE = previousFile;
    await rm(folder, { recursive: true, force: true });
  }
});
