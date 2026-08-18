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
  const lastActivity = opp.lastActivity ?? null;
  return {
    id: opp.id,
    code: opp.code,
    sellerDisplayName: opp.sellerDisplayName,
    propertyRef: opp.property?.externalPropertyId ?? null,
    property: opp.property ? { address: opp.property.address } : null,
    stage: opp.stage,
    source: opp.source?.sourceType ?? null,
    provenanceState: opportunityProvenanceState(opp),
    classification: opp.classification,
    lastActivity,
    // The Reactor overview sorts on updatedAt. Preserve the existing
    // lastActivity contract while also providing the explicit timestamp alias
    // expected by the client so older/real records cannot crash rendering.
    updatedAt: opp.updatedAt ?? lastActivity,
    assignedOperator: opp.assignedOperator ?? null,
    status: statusForStage(opp.stage),
    isFixture: opp.isFixture ?? false,
    provenanceMetadata: opp.source?.provenanceMetadata ?? null,
    underwriting: opp.underwriting ?? null
  };
}
