/**
 * F2 remediation battery — report-total reconciliation (QUINCEY F2, MODERATE).
 *
 * Defect under test: the Piper snapshot's underwriting-ref JOIN yielded one
 * snapshot row per (opportunity × ref), so a multi-ref opportunity was
 * counted once per ref in every aggregate derived from the snapshot —
 * snapshot totals, the operating brief's evidence counts, and the
 * intelligence report's portfolio totals (opportunitiesConsidered, byStage).
 *
 * The correction: one snapshot entry per opportunity, citing the governing
 * ref — the newest by the Delta B ordering (analyzed_at DESC, created_at
 * DESC, rowid DESC), the same selection the investment committee and offer
 * preparation use — with every stored ref preserved per opportunity in
 * `underwritingRefs` (newest first) and disclosed in the report as
 * `underwriting.references`, each ref carrying its own basis-labeled figures.
 *
 * Fixtures (all hand-computed expectations asserted exactly):
 *   multi  — 2 refs; totals must cite the NEWEST ref only; the older ref's
 *            figures survive only as per-reference detail.
 *   noref  — 0 refs; counted once, figures unknown, never dropped.
 *   hist   — 2 refs inserted newest-first; selection follows analyzed_at,
 *            never insertion/rowid order.
 *   tie    — 3 refs sharing analyzed_at; created_at DESC then rowid DESC
 *            break the tie deterministically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDb, testConfig } from "./helpers/temporaryDatabase.mjs";
import { openPipelineDatabase } from "../src/database/openDatabase.js";
import { createApp } from "../src/app/createApp.js";
import { PiperContextService } from "../src/services/piperContextService.js";
import { buildIntelligenceReport } from "../src/services/piper/intelligenceReportService.js";
import { buildBrief } from "../src/domain/piper/briefModel.js";

function seed(conn) {
  const opp = (id, code, stage, price) => conn.prepare(`
    INSERT INTO seller_opportunities (id, opportunity_code, pipeline_stage, opportunity_status, created_by, ocg_one_property_id, asking_price)
    VALUES (?, ?, ?, 'active', 'f2-test', ?, ?)
  `).run(id, code, stage, `prop-${id}`, price);
  const src = (id, oppId, addr) => conn.prepare(`
    INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, original_address, conversion_actor, source_timestamp, conversion_timestamp)
    VALUES (?, ?, 'manual_entry', ?, 'f2-test', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')
  `).run(id, oppId, addr);
  const ref = (id, oppId, { arv, rehab, mao, confidence = null, evidence = null, analyzedAt, createdAt }) => conn.prepare(`
    INSERT INTO opportunity_underwriting_refs
      (id, opportunity_id, source_system, source_underwriting_id, analysis_status, arv, rehab, mao, confidence, limitations, evidence_summary_json, analyzed_at, created_at)
    VALUES (?, ?, 'deal-scout', ?, 'completed', ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(id, oppId, `uw-${id}`, arv, rehab, mao, confidence, evidence ? JSON.stringify(evidence) : null, analyzedAt, createdAt);

  // multi — older ref inserted first, newer ref second.
  opp("opp_multi", "OPP-RPT-001", "contacted", 180000);
  src("src_multi", "opp_multi", "12 Pine St, Wichita, KS");
  ref("ref_multi_old", "opp_multi", {
    arv: 200000, rehab: 25000, mao: 120000, confidence: 0.5,
    evidence: { figureBasis: { arv: "estimated" } },
    analyzedAt: "2026-08-01T10:00:00Z", createdAt: "2026-08-01T10:00:00Z",
  });
  ref("ref_multi_new", "opp_multi", {
    arv: 230000, rehab: 28000, mao: 155000, confidence: 0.85,
    evidence: { figureBasis: { mao: "estimated" } },
    analyzedAt: "2026-09-15T10:00:00Z", createdAt: "2026-09-15T10:00:00Z",
  });

  // noref — no underwriting at all.
  opp("opp_noref", "OPP-RPT-002", "new_lead", null);
  src("src_noref", "opp_noref", "3 Birch Ln, Wichita, KS");

  // hist — newest ref inserted FIRST (lowest rowid), older ref second.
  opp("opp_hist", "OPP-RPT-003", "contacted", 90000);
  src("src_hist", "opp_hist", "71 Cedar Ave, Wichita, KS");
  ref("ref_hist_new", "opp_hist", {
    arv: 150000, rehab: 10000, mao: 95000, confidence: 0.7,
    analyzedAt: "2026-09-01T09:00:00Z", createdAt: "2026-09-01T09:00:00Z",
  });
  ref("ref_hist_old", "opp_hist", {
    arv: 140000, rehab: 12000, mao: 88000, confidence: 0.6,
    analyzedAt: "2026-07-01T09:00:00Z", createdAt: "2026-07-01T09:00:00Z",
  });

  // tie — identical analyzed_at; created_at DESC, then rowid DESC decide.
  opp("opp_tie", "OPP-RPT-004", "property_review", 120000);
  src("src_tie", "opp_tie", "8 Walnut Dr, Wichita, KS");
  ref("ref_tie_a", "opp_tie", {
    arv: 160000, rehab: 20000, mao: 80000, confidence: 0.4,
    analyzedAt: "2026-09-10T00:00:00Z", createdAt: "2026-09-10T01:00:00Z",
  });
  ref("ref_tie_b", "opp_tie", {
    arv: 165000, rehab: 20000, mao: 88000, confidence: 0.45,
    analyzedAt: "2026-09-10T00:00:00Z", createdAt: "2026-09-10T02:00:00Z",
  });
  ref("ref_tie_c", "opp_tie", {
    arv: 170000, rehab: 20000, mao: 91000, confidence: 0.5,
    analyzedAt: "2026-09-10T00:00:00Z", createdAt: "2026-09-10T02:00:00Z",
  });
}

async function fresh(t) {
  const tmp = makeTempDb();
  const app = createApp(testConfig(tmp.dbPath, { dataSource: "empty" }));
  app.close();
  const config = testConfig(tmp.dbPath, { readOnly: false, isTest: false, dataSource: "empty" });
  const db = openPipelineDatabase(tmp.dbPath);
  seed(db);
  const contextService = new PiperContextService(db, config);
  t.after(() => { db.close(); tmp.cleanup(); });
  return { db, contextService };
}

// --- Snapshot cardinality -------------------------------------------------------

test("snapshot: exactly one entry per opportunity regardless of ref count", async (t) => {
  const { contextService } = await fresh(t);
  const snapshot = contextService.snapshot();
  assert.equal(snapshot.opportunities.length, 4);
  assert.equal(new Set(snapshot.opportunities.map((o) => o.id)).size, 4);
  assert.equal(snapshot.totals.opportunities, 4);
  // Only the ref-less lead lacks underwriting — counted once, not per ref.
  assert.equal(snapshot.totals.withoutUnderwriting, 1);
});

// --- Governing-ref selection ----------------------------------------------------

test("snapshot: figures cite the newest ref (Delta B ordering), never an older one", async (t) => {
  const { contextService } = await fresh(t);
  const snapshot = contextService.snapshot();

  const multi = snapshot.opportunities.find((o) => o.id === "opp_multi");
  assert.equal(multi.underwriting.refId, "ref_multi_new");
  assert.equal(multi.figures.arv.value, 230000);
  assert.equal(multi.figures.mao.value, 155000);
  assert.equal(multi.targetPurchasePrice, 155000);
  assert.equal(multi.underwriting.confidence, 0.85);

  // Insertion order must not rescue the older ref: hist's newest was inserted first.
  const hist = snapshot.opportunities.find((o) => o.id === "opp_hist");
  assert.equal(hist.underwriting.refId, "ref_hist_new");
  assert.equal(hist.figures.mao.value, 95000);

  // Full tie-break chain: analyzed_at tie -> created_at DESC -> rowid DESC.
  const tie = snapshot.opportunities.find((o) => o.id === "opp_tie");
  assert.equal(tie.underwriting.refId, "ref_tie_c");
  assert.equal(tie.figures.mao.value, 91000);
});

test("snapshot: a ref-less opportunity is present once with unknown figures", async (t) => {
  const { contextService } = await fresh(t);
  const snapshot = contextService.snapshot();
  const noref = snapshot.opportunities.find((o) => o.id === "opp_noref");
  assert.ok(noref, "ref-less opportunity must not be dropped");
  assert.equal(noref.underwriting.refId, null);
  assert.equal(noref.underwriting.status, null);
  assert.deepEqual(noref.underwritingRefs, []);
  assert.equal(noref.figures.arv.value, null);
  assert.equal(noref.figures.arv.basis, "unknown");
  assert.equal(noref.figures.mao.basis, "unknown");
});

// --- Per-reference provenance ---------------------------------------------------

test("snapshot: every ref survives as per-reference detail, newest first, bases intact", async (t) => {
  const { contextService } = await fresh(t);
  const snapshot = contextService.snapshot();

  const multi = snapshot.opportunities.find((o) => o.id === "opp_multi");
  assert.deepEqual(multi.underwritingRefs.map((r) => r.id), ["ref_multi_new", "ref_multi_old"]);
  assert.equal(multi.underwritingRefs[0].governing, true);
  assert.equal(multi.underwritingRefs[1].governing, false);
  // Per-ref basis labeling: the NEW ref's stored label marks its MAO estimated…
  assert.equal(multi.underwritingRefs[0].figures.mao.basis, "estimated");
  assert.equal(multi.underwritingRefs[0].figures.arv.basis, "recorded");
  // …and the OLD ref keeps its own label (its ARV was the estimated one).
  assert.equal(multi.underwritingRefs[1].figures.arv.value, 200000);
  assert.equal(multi.underwritingRefs[1].figures.arv.basis, "estimated");
  assert.equal(multi.underwritingRefs[1].figures.mao.value, 120000);
  assert.equal(multi.underwritingRefs[1].figures.mao.basis, "recorded");
  // The entry-level figures follow the governing ref, labels included.
  assert.equal(multi.figures.mao.basis, "estimated");
  assert.equal(multi.figures.arv.basis, "recorded");

  const tie = snapshot.opportunities.find((o) => o.id === "opp_tie");
  assert.deepEqual(tie.underwritingRefs.map((r) => r.id), ["ref_tie_c", "ref_tie_b", "ref_tie_a"]);
});

// --- Report reconciliation --------------------------------------------------------

test("report: portfolio totals count each opportunity once (hand-computed)", async (t) => {
  const { contextService } = await fresh(t);
  const report = buildIntelligenceReport(contextService.snapshot());

  assert.equal(report.evidence.opportunitiesConsidered, 4);
  assert.equal(report.portfolio.totals.opportunities, 4);
  assert.deepEqual(report.portfolio.byStage, { contacted: 2, new_lead: 1, property_review: 1 });
  assert.equal(
    Object.values(report.portfolio.byStage).reduce((n, c) => n + c, 0),
    report.evidence.opportunitiesConsidered,
    "byStage buckets must sum to the opportunity count"
  );
  assert.equal(report.opportunities.length, 4);

  // Hand-computed governing-MAO sum across the portfolio: 155000 + 95000 + 91000.
  // The ref-less lead contributes no figure (unknown), and no older ref leaks in.
  const maoSum = report.opportunities.reduce((n, o) => n + (o.figures.mao.value ?? 0), 0);
  assert.equal(maoSum, 341000);

  // Risks are per opportunity, not per ref: multi's ceiling-below-ask appears once.
  const multiRisks = report.risks.filter((r) => r.opportunityId === "opp_multi" && r.kind === "ceiling_below_ask");
  assert.equal(multiRisks.length, 1);
});

test("report: governing ref is disclosed and per-reference detail is preserved", async (t) => {
  const { contextService } = await fresh(t);
  const report = buildIntelligenceReport(contextService.snapshot());

  const multi = report.opportunities.find((o) => o.id === "opp_multi");
  assert.equal(multi.underwriting.governingRefId, "ref_multi_new");
  assert.equal(multi.underwriting.references.length, 2);
  assert.deepEqual(multi.underwriting.references.map((r) => r.refId), ["ref_multi_new", "ref_multi_old"]);
  assert.equal(multi.underwriting.references[0].governing, true);
  assert.equal(multi.underwriting.references[1].governing, false);
  assert.equal(multi.underwriting.references[1].figures.arv.basis, "estimated");
  assert.equal(multi.underwriting.references[1].figures.mao.value, 120000);
  // The older ref's MAO exists ONLY as reference detail — never as the row figure.
  assert.equal(multi.figures.mao.value, 155000);

  const noref = report.opportunities.find((o) => o.id === "opp_noref");
  assert.equal(noref.underwriting.governingRefId, null);
  assert.deepEqual(noref.underwriting.references, []);

  assert.match(report.evidence.governingRefSelection, /analyzed_at DESC/);
});

// --- Operating brief consistency --------------------------------------------------

test("brief: the pre-existing operating brief counts distinct opportunities too", async (t) => {
  const { contextService } = await fresh(t);
  const brief = buildBrief(contextService.snapshot());
  assert.equal(brief.evidence.opportunitiesConsidered, 4);
});
