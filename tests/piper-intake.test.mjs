import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { runMigrations } from "../src/database/migrationRunner.js";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { APP_ROOT } from "../src/config/environment.js";
import { handleDealFindrIntake, normalizePropertyAddress } from "../src/http/routes/dealFindrIntake.js";
import { authorizePiperIntake } from "../src/http/routes/piperIntakeAuthorization.js";
import { makeTempDb } from "./helpers/temporaryDatabase.mjs";
import { join } from "node:path";

function request(payload, authorization = "") {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]);
  req.headers = { authorization };
  return req;
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

test("PIPER address normalization reconciles common street variants", () => {
  assert.equal(
    normalizePropertyAddress(" 419 N. Main Street, Wichita, KS "),
    "419 n main st wichita ks"
  );
});

test("PIPER intake authorization is disabled by default and constant-time protected when enabled", () => {
  assert.deepEqual(
    authorizePiperIntake({ headers: {} }, { piperIntakeEnabled: false, piperIntakeSecret: "" }),
    { ok: false, status: 503, error: "piper_intake_disabled" }
  );
  assert.equal(
    authorizePiperIntake(
      { headers: { authorization: "Bearer wrong" } },
      { piperIntakeEnabled: true, piperIntakeSecret: "correct-secret-value" }
    ).status,
    401
  );
  assert.deepEqual(
    authorizePiperIntake(
      { headers: { authorization: "Bearer correct-secret-value" } },
      { piperIntakeEnabled: true, piperIntakeSecret: "correct-secret-value" }
    ),
    { ok: true }
  );
});

test("PIPER intake persists one opportunity and deduplicates address variants", async (t) => {
  const tmp = makeTempDb();
  t.after(() => tmp.cleanup());
  const db = openPipelineDatabase(tmp.dbPath);
  t.after(() => db.close());
  runMigrations(db, join(APP_ROOT, "migrations"));

  const ctx = { db };
  const first = response();
  await handleDealFindrIntake(request({
    address: "419 N Main Street, Wichita, KS",
    externalId: "county-419-main",
    sourceName: "Sedgwick Public Feed",
    sourceType: "property_lead_inbox",
    sourceUrl: "https://example.test/property/419",
    askingPrice: 99000,
    arv: 180000,
    rehab: 32000,
    sellerName: "Test Seller",
  }), first, ctx);

  assert.equal(first.status, 201, first.body);
  const created = JSON.parse(first.body);
  assert.equal(created.ok, true);
  assert.equal(created.duplicate, false);

  const second = response();
  await handleDealFindrIntake(request({
    address: "419 N. Main St., Wichita KS",
    externalId: "another-source-id",
    sourceName: "Second Approved Feed",
  }), second, ctx);
  assert.equal(second.status, 200);
  assert.equal(JSON.parse(second.body).duplicate, true);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM seller_opportunities").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operational_audit_events WHERE event_type = 'PIPER_INTAKE'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operational_audit_events WHERE event_type = 'PIPER_DUPLICATE_RECONCILED'").get().count, 1);
});
