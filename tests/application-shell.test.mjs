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

test("static PIPELINE page loads as the Piper-first founder shell", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /OCG PIPELINE/);
  assert.match(html, /Acquisitions powered by Piper/);
  assert.match(html, /Piper/);
  assert.match(html, /Piper limited/);
  // Founder nav is Home / Pipeline / People / Tasks — nothing else.
  assert.match(html, /data-fpnav="home"/);
  assert.match(html, /data-fpnav="pipeline"/);
  assert.match(html, /data-fpnav="people"/);
  assert.match(html, /data-fpnav="tasks"/);
  assert.doesNotMatch(html, /Work Room/);
  // No console chrome in the founder shell.
  assert.doesNotMatch(html, /PIPELINE \/ Seller Operations/);
  assert.doesNotMatch(html, /OCG OS Director/);
  assert.doesNotMatch(html, /id="operator-access-btn"/);
  assert.doesNotMatch(html, /Operator: locked/);
  assert.doesNotMatch(html, /class="admin-link"/);
  assert.doesNotMatch(html, /ocg-os-work-room\.js/);
  assert.doesNotMatch(html, /ocg-os-command\.js/);
  assert.doesNotMatch(html, /ocg-os-deal-story\.js/);
  assert.doesNotMatch(html, /ocg-os-hierarchy-lock\.js/);
  // Clean unlock gate before the experience loads.
  assert.match(html, /id="fp-unlock"/);
  assert.match(html, /id="fp-unlock-form"/);
  // Piper conversation is an overlay, hidden by default — never a rail.
  assert.match(html, /id="piper-drawer" class="piper-drawer" hidden/);
  assert.match(html, /id="piper-close-btn"/);
  // No technical provider/model language on the founder screen.
  assert.doesNotMatch(html, /No language model is connected/);
  assert.doesNotMatch(html, /deterministic/i);
  assert.match(html, /piper-simple\.css/);
});

test("OCG OS command-center assets are served with real content and governed data sources", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const command = await fetch(`${baseUrl}/ocg-os-command.js`);
  assert.equal(command.status, 200);
  assert.match(command.headers.get("content-type") || "", /application\/javascript/);
  const commandText = await command.text();
  assert.match(commandText, /What matters now/);
  assert.match(commandText, /NEEDS GENARO/);
  assert.match(commandText, /CAPITAL DECISIONS/);
  assert.match(commandText, /TRANSACTION RISK/);
  assert.match(commandText, /\/api\/v1\/investment-committee/);
  assert.match(commandText, /\/api\/v1\/operator\/transactions/);
  assert.match(commandText, /\/api\/v1\/operator\/acquisition-handoffs/);
  assert.match(commandText, /\/api\/v1\/operator\/dispositions/);
  assert.match(commandText, /No simulated completion percentage is shown/);
  assert.doesNotMatch(commandText, /<!doctype html>/i);

  const story = await fetch(`${baseUrl}/ocg-os-deal-story.js`);
  assert.equal(story.status, 200);
  assert.match(story.headers.get("content-type") || "", /application\/javascript/);
  const storyText = await story.text();
  assert.match(storyText, /Hunter/);
  assert.match(storyText, /Victor/);
  assert.match(storyText, /Investment Committee/);
  assert.match(storyText, /Mission Control/);
  assert.match(storyText, /Sell \/ Hold \/ Refinance/);
  assert.match(storyText, /\/api\/v1\/operator\/acquisition-handoffs/);
  assert.match(storyText, /\/api\/v1\/operator\/dispositions/);
  assert.doesNotMatch(storyText, /<!doctype html>/i);

  const css = await fetch(`${baseUrl}/ocg-os-command.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") || "", /text\/css/);
  const cssText = await css.text();
  assert.match(cssText, /\.ocg-command-center/);
  assert.match(cssText, /\.ocg-executive-grid/);
  assert.match(cssText, /\.ocg-deal-story/);
  assert.match(cssText, /\.ocg-story-stage/);
  assert.doesNotMatch(cssText, /<!doctype html>/i);
});

test("Piper-first stylesheet is served as CSS, not the SPA fallback", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const css = await fetch(`${baseUrl}/piper-simple.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") || "", /text\/css/);
  const cssText = await css.text();
  assert.doesNotMatch(cssText, /<!doctype html>/i);
  assert.match(cssText, /\.ph-/);
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
