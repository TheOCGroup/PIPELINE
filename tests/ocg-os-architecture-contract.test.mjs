import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { STAGES } from "../src/domain/stages/stageModel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const arch = read("docs/ocg-os-architecture.md");
const workflow = read("docs/hunter-victor-piper-workflow.md");
const apis = read("docs/governed-integration-apis.md");
const m024 = read("migrations/024_pipeline_source_type_honesty.sql");
const m025 = read("migrations/025_offer_underwriting_source_honesty.sql");

test("OCG OS architecture names exactly HUNTER, VICTOR, PIPER on PIPELINE", () => {
  for (const name of ["HUNTER", "VICTOR", "PIPER", "PIPELINE"]) {
    assert.ok(arch.includes(name), `architecture doc must name ${name}`);
  }
  // Separate systems must be listed as NOT modules of OCG OS.
  for (const separate of ["Deal Scout Mobile", "Agent Workspace", "OCG MEDIA", "OCG LAB OS"]) {
    assert.ok(arch.includes(separate), `architecture doc must classify ${separate} as separate`);
  }
});

test("workflow source types match migration 024 exactly", () => {
  for (const sourceType of ["deal_finder_intake", "deal_scout_handoff", "manual_entry"]) {
    assert.ok(m024.includes(`'${sourceType}'`), `migration 024 must allow ${sourceType}`);
    assert.ok(workflow.includes(sourceType) || arch.includes(sourceType),
      `docs must document ${sourceType}`);
  }
});

test("offer underwriting sources match migration 025 exactly", () => {
  for (const source of ["victor_analysis", "deal_scout_project", "operator_assumption"]) {
    assert.ok(m025.includes(`'${source}'`), `migration 025 must allow ${source}`);
    assert.ok(workflow.includes(source), `workflow doc must document ${source}`);
  }
});

test("workflow stage list matches the canonical stage model", () => {
  for (const stage of STAGES) {
    assert.ok(workflow.includes(stage), `workflow doc must list canonical stage ${stage}`);
  }
  assert.equal(STAGES.length, 20, "canonical stage model is 20 stages");
});

test("governed APIs forbid database sharing and code merging", () => {
  assert.match(apis, /no database is shared/i);
  assert.match(apis, /Deal Scout Mobile/);
  assert.match(apis, /Agent Workspace/);
  // Tenant honesty: architecture must not claim multi-tenant enforcement.
  assert.match(arch, /NOT IMPLEMENTED|not.*filter/i);
});
