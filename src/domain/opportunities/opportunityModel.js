/** Opportunity read model + list projection (PIPELINE-native, pure). */

import { resolveProvenance } from "../provenance/provenanceModel.js";
import { isClosedStage } from "../stages/stageModel.js";

export const OPPORTUNITY_STATUS = Object.freeze({ ACTIVE: "active", CLOSED: "closed" });

export function statusForStage(stage) {
  return isClosedStage(stage) ? OPPORTUNITY_STATUS.CLOSED : OPPORTUNITY_STATUS.ACTIVE;
}

/** Derives the resolved provenance state for an opportunity's primary source. */
export function opportunityProvenanceState(opp) {
  const src = opp.source || {};
  return resolveProvenance(src).provenanceState;
}

/** Compact projection for list views and the list API. */
export function toListItem(opp) {
  return {
    id: opp.id,
    sellerDisplayName: opp.sellerDisplayName,
    propertyRef: opp.property?.externalPropertyId ?? null,
    stage: opp.stage,
    source: opp.source?.sourceType ?? null,
    provenanceState: opportunityProvenanceState(opp),
    classification: opp.classification,
    lastActivity: opp.lastActivity,
    assignedOperator: opp.assignedOperator ?? null,
    status: statusForStage(opp.stage),
  };
}
