/**
 * Provenance read model (PIPELINE-native).
 *
 * Mirrors the resolution semantics of the OCG ONE 053 view
 * `v_seller_opportunity_source_resolved`: the original source message wins when
 * present; otherwise the recovered one is used; otherwise the source is
 * unresolved. Pure — no I/O, no database, no side effects.
 */

export const PROVENANCE_STATES = Object.freeze({
  ORIGINAL: "original",
  RECOVERED: "recovered",
  UNRESOLVED: "unresolved",
});

export const RECOVERY_METHODS = Object.freeze({
  CLAIMS: "lead_claims_source_message",
  DIRECT: "lead_source_messages_direct",
});

/**
 * @param {{originalSourceMessageId?:string|null, recoveredSourceMessageId?:string|null}} src
 * @returns {{resolvedSourceMessageId:string|null, provenanceState:string}}
 */
export function resolveProvenance(src = {}) {
  const original = src.originalSourceMessageId ?? null;
  const recovered = src.recoveredSourceMessageId ?? null;
  const resolvedSourceMessageId = original ?? recovered ?? null;
  const provenanceState = original
    ? PROVENANCE_STATES.ORIGINAL
    : recovered
      ? PROVENANCE_STATES.RECOVERED
      : PROVENANCE_STATES.UNRESOLVED;
  return { resolvedSourceMessageId, provenanceState };
}

export function formatProvenanceState(state) {
  switch (state) {
    case PROVENANCE_STATES.ORIGINAL: return "Original";
    case PROVENANCE_STATES.RECOVERED: return "Recovered";
    case PROVENANCE_STATES.UNRESOLVED: return "Unresolved";
    default: return "Unknown";
  }
}

export function formatRecoveryMethod(method) {
  if (method === RECOVERY_METHODS.CLAIMS) return "Lead claims (single message)";
  if (method === RECOVERY_METHODS.DIRECT) return "Direct source message";
  return method ? String(method) : "—";
}
