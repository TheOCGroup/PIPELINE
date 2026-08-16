/**
 * Classification read model (PIPELINE-native).
 *
 * Two invariants extracted from the OCG ONE classification engine:
 *   1. Lineage beats naming: the REAL/SYNTHETIC decision follows the source
 *      lead's lineage, never a "real-looking" opportunity code.
 *   2. Absence of provenance is NOT synthetic: an unresolved source is
 *      AMBIGUOUS at most, never SYNTHETIC on that basis alone.
 * Pure — no I/O, no database, no side effects.
 */

export const CLASSIFICATIONS = Object.freeze({
  REAL: "REAL",
  SYNTHETIC: "SYNTHETIC",
  AMBIGUOUS: "AMBIGUOUS",
});

export const REAL = CLASSIFICATIONS.REAL;
export const SYNTHETIC = CLASSIFICATIONS.SYNTHETIC;
export const AMBIGUOUS = CLASSIFICATIONS.AMBIGUOUS;

/**
 * Lineage over naming. `code` is intentionally ignored for the decision.
 * @param {{leadClassification?:string|null, code?:string}} input
 */
export function classifyByLineage(input = {}) {
  const lineage = input.leadClassification;
  if (lineage === SYNTHETIC) return SYNTHETIC;
  if (lineage === REAL) return REAL;
  return AMBIGUOUS; // unknown / absent lineage is never silently promoted
}

/** An unresolved/absent provenance never implies SYNTHETIC. */
export function isSyntheticFromProvenance() {
  return false;
}

export function classificationReason({ classification, leadClassification, provenanceState } = {}) {
  if (classification === SYNTHETIC) return "Source lineage is synthetic (naming ignored).";
  if (classification === REAL) return "Source lineage is real.";
  // AMBIGUOUS
  if (provenanceState === "unresolved") {
    return "Provenance is unresolved; not synthetic — awaiting deterministic evidence.";
  }
  return leadClassification ? "Lineage inconclusive." : "No lineage evidence; classification withheld.";
}
