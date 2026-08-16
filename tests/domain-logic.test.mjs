import test from "node:test";
import assert from "node:assert/strict";

import { classifyByLineage, classificationReason, REAL, SYNTHETIC, AMBIGUOUS } from "../src/domain/classifications/classificationModel.js";
import { resolveProvenance, PROVENANCE_STATES } from "../src/domain/provenance/provenanceModel.js";
import { statusForStage, opportunityProvenanceState } from "../src/domain/opportunities/opportunityModel.js";
import { summarizeDataQuality } from "../src/domain/dataQuality/dataQualityModel.js";

test("Domain: Provenance Resolution priority", () => {
  // 1. Original source message wins when present
  const res1 = resolveProvenance({ originalSourceMessageId: "MSG-ORIGINAL", recoveredSourceMessageId: "MSG-RECOVERED" });
  assert.equal(res1.resolvedSourceMessageId, "MSG-ORIGINAL");
  assert.equal(res1.provenanceState, PROVENANCE_STATES.ORIGINAL);

  // 2. Recovered source message falls back when original is missing
  const res2 = resolveProvenance({ originalSourceMessageId: null, recoveredSourceMessageId: "MSG-RECOVERED" });
  assert.equal(res2.resolvedSourceMessageId, "MSG-RECOVERED");
  assert.equal(res2.provenanceState, PROVENANCE_STATES.RECOVERED);

  // 3. Unresolved if both are absent
  const res3 = resolveProvenance({ originalSourceMessageId: null, recoveredSourceMessageId: null });
  assert.equal(res3.resolvedSourceMessageId, null);
  assert.equal(res3.provenanceState, PROVENANCE_STATES.UNRESOLVED);
});

test("Domain: Lineage Beats Naming (Classification Rules)", () => {
  // Lineage overrides record naming (code is ignored)
  assert.equal(classifyByLineage({ leadClassification: SYNTHETIC, code: "OPP-REAL-LOOKING" }), SYNTHETIC);
  assert.equal(classifyByLineage({ leadClassification: REAL, code: "OPP-TESTSTAG-LOOKING" }), REAL);

  // Unresolved/absent lineage is ambiguous, never silently promoted to synthetic
  assert.equal(classifyByLineage({ leadClassification: null, code: "OPP-REAL" }), AMBIGUOUS);
});

test("Domain: Classification Reason formatting", () => {
  assert.match(classificationReason({ classification: SYNTHETIC }), /synthetic/i);
  assert.match(classificationReason({ classification: REAL }), /real/i);
  assert.match(classificationReason({ classification: AMBIGUOUS, provenanceState: "unresolved" }), /unresolved/i);
});

test("Domain: Stale activity data-quality calculation", () => {
  const clock = "2026-08-01T00:00:00Z"; // stale limit is 60 days (cutoff 2026-06-02)
  const opps = [
    {
      id: "OPP-1",
      stage: "negotiating",
      lastActivity: "2026-07-20T00:00:00Z", // Fresh
      source: { originalSourceMessageId: "MSG-1" },
    },
    {
      id: "OPP-2",
      stage: "qualified",
      lastActivity: "2026-05-01T00:00:00Z", // Stale (< June 2)
      source: { originalSourceMessageId: null, recoveredSourceMessageId: null },
    }
  ];

  const summary = summarizeDataQuality(opps, { now: clock });
  assert.equal(summary.staleOpportunities, 1);
  assert.equal(summary.totalOpportunities, 2);
  assert.equal(summary.originalProvenance, 1);
  assert.equal(summary.unresolvedProvenance, 1);
});
