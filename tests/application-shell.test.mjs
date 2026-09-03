/** Application shell: starts on a temp DB, serves health/version/page, identifies as pipeline. */

import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

test("shell starts on a temporary database and /health is 200", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "pipeline");
  assert.equal(body.database, "available");
  assert.equal(body.integration, "disabled");
});

test("/version returns 0.1.0 and identifies as OCG PIPELINE, not OCG ONE", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const body = await (await fetch(`${baseUrl}/version`)).json();
  assert.equal(body.version, "0.1.0");
  assert.equal(body.name, "OCG PIPELINE");
  assert.equal(body.service, "pipeline");
  assert.notEqual(body.service, "ocg-one");
  assert.equal(body.schemaVersion, "1"); // set by migration 001
});

test("static PIPELINE page loads inside the OCG OS shell without losing subsystem identity", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /OCG OS/);
  assert.match(html, /OCG PIPELINE/);
  assert.match(html, /PIPELINE \/ Seller Operations/);
  assert.match(html, /OCG OS Director/);
  assert.match(html, /Piper/);
  assert.match(html, /ocg-os-command\.js/);
  assert.match(html, /Overview/);
});

test("unknown API routes return a deterministic 404 with no internals", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/api/v1/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "not_found");
});
