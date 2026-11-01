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
const toolRegistry = read("src/services/piper/toolRegistry.js");

/** Extract the quoted values of the first `CHECK (<col> IN (...))` list for a column. */
function checkValues(sql, column) {
  const m = sql.match(new RegExp(`CHECK \\(${column} IN \\(([\\s\\S]*?)\\)\\)`));
  assert.ok(m, `migration must contain a CHECK (${column} IN (...)) list`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
}

test("OCG OS architecture names exactly HUNTER, VICTOR, PIPER on PIPELINE", () => {
  for (const name of ["HUNTER", "VICTOR", "PIPER", "PIPELINE"]) {
    assert.ok(arch.includes(name), `architecture doc must name ${name}`);
  }
  // Membership guard (scoped to the membership sections, before "What OCG OS
  // is not" — separate systems and governance roles are legitimately named
  // later).
  const membership = arch.split("## What OCG OS is not")[0];
  // Allowlist guard (CA-D1, Issue #29): the membership section presents the
  // components as a table whose first column is the component name in bold.
  // The presented set must equal the canonical roster EXACTLY — the earlier
  // denylist alone could not catch an unlisted rogue member (QUINCEY probe:
  // an inserted TED row passed). Any addition to or removal from the table
  // fails this assertion.
  const presented = [...membership.matchAll(/^\|\s*\*\*([A-Z][A-Z ]*)\*\*\s*\|/gm)]
    .map((x) => x[1].trim());
  assert.deepEqual([...presented].sort(), ["HUNTER", "PIPELINE", "PIPER", "VICTOR"],
    "membership table must present exactly HUNTER, VICTOR, PIPER, PIPELINE");
  // Supplementary prose guard: known outsiders must not be named anywhere in
  // the membership sections either.
  for (const outsider of ["KING", "MARK", "NOVA", "ORION", "ARCHER", "MAESTRO",
    "ASTRA", "DEVIN", "CHARLIE", "WALLIE", "MIRA", "SYNDEE"]) {
    assert.ok(!new RegExp(`\\b${outsider}\\b`).test(membership),
      `${outsider} must not appear as an OCG OS member`);
  }
  // Separate systems must be listed as NOT modules of OCG OS.
  for (const separate of ["Deal Scout Mobile", "Agent Workspace", "OCG MEDIA", "OCG LAB OS"]) {
    assert.ok(arch.includes(separate), `architecture doc must classify ${separate} as separate`);
  }
});

test("workflow source types match migration 024 exactly", () => {
  // Exact-set guard (CA2): additions to or removals from the migration CHECK
  // list fail this test — the allowed set is pinned, not just sampled.
  assert.deepEqual(checkValues(m024, "source_type"), [
    "deal_finder_intake", "deal_scout_handoff", "gmail_digest",
    "legacy_seller_record", "manual_entry", "ocg_one_lead",
    "property_lead_inbox", "referral", "website_form",
  ]);
  // Each workflow-relevant type must be documented in BOTH docs (CA2: the
  // earlier `workflow || arch` assertion let a type vanish from one doc).
  for (const sourceType of ["deal_finder_intake", "deal_scout_handoff", "manual_entry"]) {
    assert.ok(workflow.includes(sourceType), `workflow doc must document ${sourceType}`);
    assert.ok(arch.includes(sourceType), `architecture doc must document ${sourceType}`);
  }
});

test("offer underwriting sources match migration 025 exactly", () => {
  assert.deepEqual(checkValues(m025, "underwriting_source_type"), [
    "deal_scout_project", "operator_assumption", "victor_analysis",
  ]);
  for (const source of ["victor_analysis", "deal_scout_project", "operator_assumption"]) {
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
  // Tenant honesty: architecture must describe the enforced state — one
  // configured tenant (PIPELINE_TENANT_ID) with scoped reads/writes — and
  // must not claim filtering is unimplemented or that one process serves
  // multiple tenants.
  assert.match(arch, /PIPELINE_TENANT_ID/);
  assert.doesNotMatch(arch, /NOT IMPLEMENTED|not.*filter|do \*\*not\*\* filter/i);
  assert.match(arch, /single-tenant/i);
});

test("workflow PIPER tool inventory matches the tool registry exactly", () => {
  const schemaNames = [...toolRegistry.matchAll(/name: "([a-z_]+)"/g)].map((x) => x[1]);
  const writeBlock = toolRegistry.match(/const WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(writeBlock, "toolRegistry must define WRITE_TOOLS");
  const writeNames = [...writeBlock[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  const readNames = schemaNames.filter((n) => !writeNames.includes(n));
  assert.equal(schemaNames.length, 26, "registry baseline is 26 tools");
  // The doc must name every tool and state counts that match the registry,
  // so adding/removing a tool — or a stale inventory (QUINCEY U1) — fails.
  for (const name of schemaNames) {
    assert.ok(workflow.includes(name), `workflow doc must name PIPER tool ${name}`);
  }
  assert.ok(workflow.includes(`${readNames.length} read`),
    `workflow doc must state ${readNames.length} read tools`);
  assert.ok(workflow.includes(`${writeNames.length} write`),
    `workflow doc must state ${writeNames.length} write tools`);
  // Two-directional inventory guard (CA-D2, Issue #29): parse the doc's own
  // read/write tool lists out of the governance block and require partitioned
  // set equality with the registry — a tool added to the doc only (QUINCEY
  // probe: `teleport_deal`), dropped from the doc, or moved between the
  // read/write partitions fails, in either direction.
  const govStart = workflow.indexOf("PIPER tool governance");
  assert.ok(govStart >= 0, "workflow doc must contain the PIPER tool governance block");
  const govEnd = workflow.indexOf("\n\n", govStart);
  const governance = workflow.slice(govStart, govEnd < 0 ? undefined : govEnd);
  const docList = (label) => {
    const m = governance.match(new RegExp(`${label} tools\\s*\\(([^)]*)\\)`));
    assert.ok(m, `workflow governance must present a ${label} tools list`);
    return [...m[1].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]);
  };
  assert.deepEqual([...docList("Read")].sort(), [...readNames].sort(),
    "doc read-tool list must equal the registry read set exactly");
  assert.deepEqual([...docList("Write")].sort(), [...writeNames].sort(),
    "doc write-tool list must equal the registry write set exactly");
  // No orphan tool-shaped names anywhere else in the governance block: every
  // backticked snake_case token there must be a registry tool.
  const mentioned = [...governance.matchAll(/`([a-z][a-z_]*)`/g)].map((x) => x[1])
    .filter((n) => n.includes("_"));
  assert.deepEqual([...new Set(mentioned)].sort(), [...schemaNames].sort(),
    "every tool-shaped name in the governance block must be a registry tool");
  // The approval-gate claim must cover the write set, draft tools included.
  for (const name of ["draft_sms", "draft_email"]) {
    assert.ok(writeNames.includes(name), `${name} must be a governed write tool`);
  }
});
