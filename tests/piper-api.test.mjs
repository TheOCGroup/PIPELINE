import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("PIPER API exposes grounded status and conversational answers", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, { dataSource: "fixtures" }));
  t.after(() => { app.close(); db.cleanup(); });

  const statusResponse = await fetch(`${baseUrl}/api/v1/piper/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.data.mode, "grounded");

  const chatResponse = await fetch(`${baseUrl}/api/v1/piper/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What is my highest-priority next action?" }),
  });
  assert.equal(chatResponse.status, 200);
  const chat = await chatResponse.json();
  assert.equal(chat.data.grounded, true);
  assert.match(chat.data.answer, /recommendations|priority|discovery/i);
});

test("PIPER API constrains methods, discovery state, and chat payload size", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const wrongMethod = await fetch(`${baseUrl}/api/v1/piper/chat`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const disabledRun = await fetch(`${baseUrl}/api/v1/piper/run`, { method: "POST" });
  assert.equal(disabledRun.status, 409);

  const oversized = await fetch(`${baseUrl}/api/v1/piper/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(33 * 1024) }),
  });
  assert.equal(oversized.status, 413);
});
