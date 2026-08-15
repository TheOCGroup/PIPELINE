/** Fixture manifest: what each demo case validates. DEMO DATA ONLY. */

import { RECOVERY_METHODS } from "../domain/provenance/provenanceModel.js";

export const FIXTURE_MANIFEST = Object.freeze([
  { id: "FX-OPP-0001", validates: "Original provenance; REAL; active (negotiating); 2 participants; 3 stage events; has offer; fresh activity." },
  { id: "FX-OPP-0002", validates: "Recovered provenance via lead-claims path; REAL; active; single participant; no offer." },
  { id: "FX-OPP-0003", validates: "Unresolved provenance that is AMBIGUOUS, NOT synthetic; stale activity." },
  { id: "FX-OPP-0004", validates: "Synthetic lineage with a real-looking code (lineage wins); closed (lost); missing external property reference; has offer + outcome." },
  { id: "FX-OPP-0005", validates: "Recovered provenance via direct source-message path; REAL; closed (won); offer + outcome." },
  { id: "FX-OPP-0006", validates: "Original provenance; REAL; active; missing external property reference; participant with missing external person reference." },
]);

export const FIXTURE_EXPECTATIONS = Object.freeze({
  // Deterministic given src/fixtures/opportunities.js and clock 2026-08-01.
  totalOpportunities: 6,
  originalProvenance: 3,
  recoveredProvenance: 2,
  unresolvedProvenance: 1,
  missingPropertyReferences: 2,
  missingParticipantReferences: 1,
  staleOpportunities: 1,
  classifications: { REAL: 4, SYNTHETIC: 1, AMBIGUOUS: 1 },
});
