import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";

const SECRET = "test-piper-intake-secret-0001";
const INTAKE = "/api/integrations/deal-findr/intake";

function post(baseUrl, body) {
  return fetch(`${baseUrl}${INTAKE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
}

test("Victor package reconciles the Hunter lead and persists hold/DSCR evidence", async (t) => {
  const tempDb = makeTempDb();
  t.after(() => tempDb.cleanup());
  const { app, baseUrl } = await startApp(createApp, testConfig(tempDb.dbPath, {
    piperIntakeEnabled: true,
    piperIntakeSecret: SECRET,
    readOnly: false,
  }));
  t.after(() => app.server.close());

  const first = await post(baseUrl, {
    address: "241 Fairview Ave, Wichita KS",
    askingPrice: 95000,
    sourceRecordId: "hunter-241"
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const second = await post(baseUrl, {
    packageId: "handoff-prop-241-1",
    timestamp: "2026-09-02T17:00:00.000Z",
    property: {
      id: "prop-241",
      address: "241 Fairview Ave, Wichita KS",
      askingPrice: 95000,
      exitStrategy: "Rental"
    },
    underwriting: {
      purchasePrice: 90000,
      arv: 180000,
      renovationBudget: 35000,
      mao: 91000,
      confidenceScore: 0.88,
      holdStrategy: "Buy-and-Hold",
      monthlyRent: 2200,
      monthlyEffectiveGrossIncome: 2090,
      monthlyOperatingExpenses: 540,
      noi: 18600,
      monthlyDebtService: 1200,
      annualDebtService: 14400,
      dscr: 1.29,
      recommendation: "Hold scenario clears current assumptions"
    },
    marketEvidence: {
      compsCount: 1,
      comps: [{ address: "245 Fairview Ave", salePrice: 185000 }]
    }
  });

  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.opportunityId, firstBody.opportunityId);
  assert.equal(secondBody.dealId, firstBody.opportunityId);

  const db = openPipelineDatabase(tempDb.dbPath);
  const ref = db.prepare("SELECT * FROM opportunity_underwriting_refs WHERE opportunity_id = ?").get(firstBody.opportunityId);
  const evidence = JSON.parse(ref.evidence_summary_json);
  const { n } = db.prepare("SELECT COUNT(*) n FROM seller_opportunities WHERE id = ?").get(firstBody.opportunityId);
  db.close();

  assert.equal(n, 1, "Victor reconciliation must not duplicate the opportunity");
  assert.equal(ref.source_agent, "Victor");
  assert.equal(ref.arv, 180000);
  assert.equal(ref.rehab, 35000);
  assert.equal(ref.mao, 91000);
  assert.equal(ref.confidence, 0.88);
  assert.equal(evidence.hold.strategy, "Buy-and-Hold");
  assert.equal(evidence.hold.monthlyRent, 2200);
  assert.equal(evidence.hold.noi, 18600);
  assert.equal(evidence.hold.monthlyDebtService, 1200);
  assert.equal(evidence.hold.annualDebtService, 14400);
  assert.equal(evidence.hold.dscr, 1.29);
  assert.equal(evidence.comps.length, 1);
});
