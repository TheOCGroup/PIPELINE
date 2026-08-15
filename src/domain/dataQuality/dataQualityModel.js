/** Read-only data-quality calculations (PIPELINE-native, pure and deterministic). */

import { PROVENANCE_STATES } from "../provenance/provenanceModel.js";
import { opportunityProvenanceState } from "../opportunities/opportunityModel.js";

export const STALE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Array<object>} opportunities
 * @param {{now?:number|string}} [opts] deterministic clock for stale calc
 */
export function summarizeDataQuality(opportunities = [], opts = {}) {
  const nowMs = opts.now != null ? new Date(opts.now).getTime() : Date.now();
  const staleCutoff = nowMs - STALE_DAYS * DAY_MS;

  let original = 0, recovered = 0, unresolved = 0;
  let classified = 0;
  let missingPropertyReferences = 0;
  let missingParticipantReferences = 0;
  let stale = 0;

  for (const opp of opportunities) {
    const state = opportunityProvenanceState(opp);
    if (state === PROVENANCE_STATES.ORIGINAL) original++;
    else if (state === PROVENANCE_STATES.RECOVERED) recovered++;
    else unresolved++;

    if (opp.classification) classified++;
    if (!opp.property || opp.property.externalPropertyId == null) missingPropertyReferences++;

    const participants = opp.participants || [];
    if (participants.length === 0 || participants.some((p) => p.externalPersonId == null)) {
      missingParticipantReferences++;
    }

    const last = opp.lastActivity ? new Date(opp.lastActivity).getTime() : null;
    if (last != null && last < staleCutoff) stale++;
  }

  const total = opportunities.length;
  return {
    totalOpportunities: total,
    originalProvenance: original,
    recoveredProvenance: recovered,
    unresolvedProvenance: unresolved,
    missingProvenance: unresolved,
    classificationCoverage: { classified, total },
    missingPropertyReferences,
    missingParticipantReferences,
    staleOpportunities: stale,
  };
}
