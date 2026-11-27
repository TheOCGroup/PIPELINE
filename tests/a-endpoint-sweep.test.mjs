/**
 * Lane A — endpoint verification sweep: executable foreign==ghost proofs
 * for the S2 census surfaces the R1 batteries did NOT already cover:
 *  A-S1 operator checklist/interactions/underwriting/transaction-tasks/
 *       acquisition-handoffs (full-body equivalence, correlationId stripped)
 *  A-S2 Piper seller-data tools under a tenant (resolve/search/candidates)
 *  A-S3 pipeline-export CLI behavior against a two-tenant DB — originally
 *       executable evidence for the census's N/A-TENANT disposition (the
 *       CLI exported the whole deployment DB). Directive 004 §9 RESOLVED
 *       the hazard: unscoped export against a multi-tenant DB is now
 *       REFUSED, and a PIPELINE_TENANT_ID-scoped export contains only that
 *       tenant's records. This test now pins the resolved behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { createApp } from "../src/app/createApp.js";
import * as sellerData from "../src/services/piper/piperSellerData.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "x".repeat(40);
const INTAKE_SECRET = "y".repeat(40);
const AUTH = { Authorization: `Bearer ${SECRET}` };
const A_ID = "opp-a-0001";
const B_ID = "opp-b-0001";
const GHOST_ID = "opp-ghost-0000";
const TS = "2026-10-31T00:00:00.000Z";

function tenantConfig(dbPath, tenantId) {
  return testConfig(dbPath, {
    env: "production", operatorSecret: SECRET, operatorAuthEnabled: true,
    dataSource: "empty", tenantId, piperIntakeEnabled: true,
    piperIntakeSecret: INTAKE_SECRET, readOnly: false,
  });
}
async function api(baseUrl, method, path, headers = AUTH) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}
function seedFull(db, { id, tenantId, code, address, email }) {
  db.prepare(`INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
      pipeline_stage, asking_price, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'new_lead', 250000, 'seed', 'seed', ?, ?)`).run(id, tenantId, code, `prop-${id}`, TS, TS);
  db.prepare(`INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
      original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
    VALUES (?, ?, 'deal_finder_intake', ?, ?, ?, 'deal-findr', ?, '{}')`).run(`${id}-src`, id, `${id}-REC`, address, TS, TS);
  db.prepare(`INSERT INTO operator_checklist_items (id, opportunity_id, item_key, label, is_checked, updated_by)
    VALUES (?, ?, 'title_search', 'Title search', 0, 'seed')`).run(`${id}-chk`, id);
  db.prepare(`INSERT INTO seller_interactions (id, opportunity_id, channel, direction, occurred_at, summary, created_by)
    VALUES (?, ?, 'phone', 'outbound', ?, 'seed call', 'seed')`).run(`${id}-int`, id, TS);
  db.prepare(`INSERT INTO pipeline_contacts (id, first_name, last_name, email, phone, primary_role, notes_summary, created_at, updated_at)
    VALUES (?, 'Seed', 'Seller', ?, '3165550100', 'seller', 'seed', ?, ?)`).run(`${id}-contact`, email, TS, TS);
  db.prepare(`INSERT INTO seller_opportunity_participants (id, opportunity_id, ocg_one_person_id, participant_role,
      is_primary, decision_authority_status, verification_status, created_by, created_at)
    VALUES (?, ?, ?, 'primary_owner', 1, 'full_authority', 'source_supplied', 'seed', ?)`).run(`${id}-part`, id, `${id}-contact`, TS);
  // Offer chain (offer -> version -> approval link) so the scoped-export
  // test proves tenant filtering follows the FK chain, not just direct
  // opportunity children.
  db.prepare(`INSERT INTO seller_offers (id, opportunity_id, current_version, status, created_by)
    VALUES (?, ?, 1, 'draft', 'seed')`).run(`${id}-offer`, id);
  db.prepare(`INSERT INTO seller_offer_versions (id, offer_id, version_number, version_status, strategy_type,
      purchase_price, earnest_money, inspection_days, closing_days, contingencies_json, underwriting_source_type,
      underwriting_source_id, underwriting_version_id, underwriting_arv_snapshot, underwriting_rehab_snapshot,
      underwriting_mao_snapshot, underwriting_timestamp, created_by)
    VALUES (?, ?, 1, 'draft', 'cash_purchase', 100000, 1000, 7, 30, '[]', 'victor_analysis', 'unknown', '2.0', 0, 0, 0, ?, 'seed')`)
    .run(`${id}-ver`, `${id}-offer`, TS);
  db.prepare(`INSERT INTO seller_offer_approval_links (id, offer_version_id, ocg_one_approval_id, link_status, created_by)
    VALUES (?, ?, ?, 'linked', 'seed')`).run(`${id}-link`, `${id}-ver`, `${id}-APPR`);
}
async function bootPair(t) {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const started = await startApp(createApp, tenantConfig(tempDb.dbPath, "tenant-a"));
  t.after(() => started.app.close());
  seedFull(started.app.db, { id: A_ID, tenantId: "tenant-a", code: "OPP-A001", address: "200 tenant a way, wichita, ks 67217", email: "a@example.com" });
  seedFull(started.app.db, { id: B_ID, tenantId: "tenant-b", code: "OPP-B001", address: "100 tenant b way, wichita, ks 67217", email: "b@example.com" });
  return { ...started, tempDb };
}
const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); if (c.meta) delete c.meta.correlationId; return c; };

test("A-S1 operator surfaces: foreign id is indistinguishable from nonexistent id", async (t) => {
  const { baseUrl } = await bootPair(t);
  const surfaces = ["checklist", "interactions", "underwriting", "transaction-tasks", "acquisition-handoffs"];
  for (const s of surfaces) {
    const foreign = await api(baseUrl, "GET", `/api/v1/operator/${s}?opportunityId=${B_ID}`);
    const ghost = await api(baseUrl, "GET", `/api/v1/operator/${s}?opportunityId=${GHOST_ID}`);
    assert.equal(foreign.status, ghost.status, `${s}: status differs foreign vs ghost`);
    assert.deepEqual(strip(foreign.body), strip(ghost.body), `${s}: body differs foreign vs ghost`);
    // Control: tenant-a's own id returns its seeded data on the data-bearing surfaces.
    if (["checklist", "interactions"].includes(s)) {
      const own = await api(baseUrl, "GET", `/api/v1/operator/${s}?opportunityId=${A_ID}`);
      const key = s === "checklist" ? "checklist" : "interactions";
      assert.ok(own.body.data[key].length >= 1, `${s}: control — own data present`);
    }
  }
});

test("A-S2 Piper seller-data tools: foreign opportunity resolves exactly like a nonexistent one", async (t) => {
  const { app } = await bootPair(t);
  const db = app.db;
  const foreign = sellerData.resolveSeller(db, { opportunityId: B_ID, tenantId: "tenant-a" });
  const ghost = sellerData.resolveSeller(db, { opportunityId: GHOST_ID, tenantId: "tenant-a" });
  assert.deepEqual(foreign, ghost, "resolveSeller foreign != ghost");
  const own = sellerData.resolveSeller(db, { opportunityId: A_ID, tenantId: "tenant-a" });
  assert.ok(own !== null && JSON.stringify(own).includes(A_ID), "control: own opportunity resolves");

  const search = sellerData.searchPipeline(db, { street: "tenant b way", tenantId: "tenant-a" });
  assert.ok(!JSON.stringify(search).includes(B_ID), "searchPipeline leaked tenant-b via street search");
  const control = sellerData.searchPipeline(db, { street: "tenant a way", tenantId: "tenant-a" });
  assert.ok(JSON.stringify(control).includes(A_ID), "control: own street search finds tenant-a");

  const candidates = sellerData.findSellerCandidates(db, { phone: "3165550100", tenantId: "tenant-b" });
  assert.ok(JSON.stringify(candidates).includes(B_ID), "control: tenant-b finds its own candidate by shared phone");
  const lastF = sellerData.lastContact(db, B_ID, "tenant-a");
  const lastG = sellerData.lastContact(db, GHOST_ID, "tenant-a");
  assert.deepEqual(lastF, lastG, "lastContact foreign != ghost");
});

test("A-S3 pipeline-export CLI: unscoped export REFUSED on a multi-tenant DB; PIPELINE_TENANT_ID-scoped export contains only that tenant (Directive 004 §9)", async (t) => {
  const { app, tempDb } = await bootPair(t);
  await app.close();
  const dir = tempDb.dir || dirname(tempDb.dbPath);
  const cli = join(REPO, "src/bin/pipeline-export.js");
  const hashBefore = createHash("sha256").update(readFileSync(tempDb.dbPath)).digest("hex");

  // 1. Unscoped (no PIPELINE_TENANT_ID) against a two-tenant DB: refused,
  //    no payload written, no full-DB snapshot left behind.
  const snap1 = join(dir, "export-snapshot-unscoped.db");
  const json1 = join(dir, "export-unscoped.json");
  const refused = spawnSync("node", [cli, tempDb.dbPath, snap1, json1],
    { encoding: "utf8", env: { ...process.env, PIPELINE_TENANT_ID: "" } });
  assert.equal(refused.status, 1, `unscoped export must refuse.\nstdout: ${refused.stdout}\nstderr: ${refused.stderr}`);
  assert.match(refused.stderr + refused.stdout, /EXPORT REFUSED/);
  assert.ok(!existsSync(json1), "refused export must not write a payload");
  assert.ok(!existsSync(snap1), "refused export must not leave a full-DB snapshot behind");

  // 2. Scoped to tenant-a: ONLY tenant-a's records — root table, direct
  //    opportunity children, and the offer -> version -> approval-link chain.
  const snap2 = join(dir, "export-snapshot-scoped.db");
  const json2 = join(dir, "export-scoped.json");
  const out = execFileSync("node", [cli, tempDb.dbPath, snap2, json2],
    { encoding: "utf8", env: { ...process.env, PIPELINE_TENANT_ID: "tenant-a" } });
  assert.match(out, /EXPORT COMPLETE|Export payload written/);
  const payload = JSON.parse(readFileSync(json2, "utf8"));
  assert.equal(payload.tenantScoped, true);
  assert.equal(payload.tenantScope, "tenant-a");
  assert.deepEqual((payload.data.seller_opportunities || []).map((r) => r.id), [A_ID]);
  for (const table of ["seller_opportunity_sources", "seller_opportunity_participants", "seller_interactions"]) {
    const rows = payload.data[table] || [];
    assert.ok(rows.length >= 1 && rows.every((r) => r.opportunity_id === A_ID),
      `${table}: scoped export leaked or lost rows: ${JSON.stringify(rows.map((r) => r.id))}`);
  }
  assert.deepEqual((payload.data.seller_offers || []).map((r) => r.id), [`${A_ID}-offer`]);
  assert.deepEqual((payload.data.seller_offer_versions || []).map((r) => r.id), [`${A_ID}-ver`]);
  assert.deepEqual((payload.data.seller_offer_approval_links || []).map((r) => r.id), [`${A_ID}-link`]);

  // 3. Scoped to tenant-b symmetrically: only B.
  const json3 = join(dir, "export-scoped-b.json");
  execFileSync("node", [cli, tempDb.dbPath, join(dir, "export-snapshot-scoped-b.db"), json3],
    { encoding: "utf8", env: { ...process.env, PIPELINE_TENANT_ID: "tenant-b" } });
  const payloadB = JSON.parse(readFileSync(json3, "utf8"));
  assert.deepEqual((payloadB.data.seller_opportunities || []).map((r) => r.id), [B_ID]);

  // 4. Neither run mutated the source DB.
  const hashAfter = createHash("sha256").update(readFileSync(tempDb.dbPath)).digest("hex");
  assert.equal(hashAfter, hashBefore, "export must not mutate the source DB");
});
