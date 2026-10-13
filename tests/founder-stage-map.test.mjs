/** Founder-stage mapping: canonical module + browser-copy sync guard. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FOUNDER_STAGES,
  STAGE_TO_FOUNDER,
  FOUNDER_STAGE_DEFAULTS,
  toFounderStage,
  founderStageLabel,
  isFounderStageKey,
} from "../src/founderStages.mjs";

const BACKEND_STAGES = [
  "new_lead", "needs_review",
  "attempting_contact", "contacted", "qualified",
  "appointment_scheduled", "property_review",
  "strategy_development", "offer_preparation", "offer_approval_required", "offer_presented",
  "negotiating",
  "under_contract", "due_diligence", "closing_scheduled",
  "closed",
  "nurture", "disqualified", "lost", "archived",
];

test("exactly 8 founder stages, in founder order", () => {
  assert.deepEqual(FOUNDER_STAGES.map((s) => s.key), [
    "new", "contacted", "appointment", "offer",
    "negotiating", "under_contract", "closed", "dead",
  ]);
});

test("every backend stage maps to a valid founder stage", () => {
  for (const stage of BACKEND_STAGES) {
    const mapped = toFounderStage(stage);
    assert.ok(isFounderStageKey(mapped), `${stage} -> ${mapped} is not a founder stage`);
  }
});

test("unknown stages fall back to new (never crash the UI)", () => {
  assert.equal(toFounderStage(undefined), "new");
  assert.equal(toFounderStage("bogus_stage"), "new");
});

test("founder-stage write defaults are real backend stages", () => {
  for (const key of FOUNDER_STAGES.map((s) => s.key)) {
    const def = FOUNDER_STAGE_DEFAULTS[key];
    assert.ok(BACKEND_STAGES.includes(def), `${key} default ${def} is not a backend stage`);
  }
});

test("labels resolve for every founder stage", () => {
  for (const { key, label } of FOUNDER_STAGES) {
    assert.equal(founderStageLabel(key), label);
  }
});

test("browser copy in public/app.js matches the canonical mapping", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const appJs = readFileSync(path.join(root, "public/app.js"), "utf8");
  const block = appJs.match(/const STAGE_TO_FOUNDER = \{([\s\S]*?)\};/);
  assert.ok(block, "STAGE_TO_FOUNDER block not found in public/app.js");
  const pairs = {};
  for (const m of block[1].matchAll(/(\w+):\s*"(\w+)"/g)) pairs[m[1]] = m[2];
  assert.deepEqual(pairs, { ...STAGE_TO_FOUNDER });

  const defBlock = appJs.match(/const FOUNDER_STAGE_DEFAULTS = \{([\s\S]*?)\};/);
  assert.ok(defBlock, "FOUNDER_STAGE_DEFAULTS block not found in public/app.js");
  const defPairs = {};
  for (const m of defBlock[1].matchAll(/(\w+):\s*"(\w+)"/g)) defPairs[m[1]] = m[2];
  assert.deepEqual(defPairs, { ...FOUNDER_STAGE_DEFAULTS });
});
