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
  assert.equal(body.schemaVersion, "1");
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

test("OCG OS command-center assets are served with their real content types and governed data sources", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const js = await fetch(`${baseUrl}/ocg-os-command.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") || "", /application\/javascript/);
  const jsText = await js.text();
  assert.match(jsText, /What matters now/);
  assert.match(jsText, /NEEDS GENARO/);
  assert.match(jsText, /CAPITAL DECISIONS/);
  assert.match(jsText, /TRANSACTION RISK/);
  assert.match(jsText, /\/api\/v1\/investment-committee/);
  assert.match(jsText, /\/api\/v1\/operator\/transactions/);
  assert.match(jsText, /\/api\/v1\/operator\/acquisition-handoffs/);
  assert.match(jsText, /\/api\/v1\/operator\/dispositions/);
  assert.match(jsText, /No simulated completion percentage is shown/);
  assert.doesNotMatch(jsText, /<!doctype html>/i);

  const css = await fetch(`${baseUrl}/ocg-os-command.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") || "", /text\/css/);
  const cssText = await css.text();
  assert.match(cssText, /\.ocg-command-center/);
  assert.match(cssText, /\.ocg-executive-grid/);
  assert.match(cssText, /\.ocg-priority-row/);
  assert.doesNotMatch(cssText, /<!doctype html>/i);
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
