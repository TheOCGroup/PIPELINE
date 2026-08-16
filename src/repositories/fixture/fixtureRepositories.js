/**
 * Fixture-backed and empty read repositories resolver.
 * Selects the appropriate implementation based on data-source mode.
 */

import { FixtureOpportunityRepository } from "./fixtureOpportunityReadRepository.js";
import { FixtureProvenanceRepository } from "./fixtureProvenanceReadRepository.js";
import { FixtureClassificationRepository } from "./fixtureClassificationReadRepository.js";

import { EmptyOpportunityRepository } from "../empty/emptyOpportunityReadRepository.js";
import { EmptyProvenanceRepository } from "../empty/emptyProvenanceReadRepository.js";
import { EmptyClassificationRepository } from "../empty/emptyClassificationReadRepository.js";

import { OPPORTUNITY_FIXTURES, CLASSIFICATION_HISTORY_FIXTURES } from "../../fixtures/opportunities.js";

/**
 * @param {"empty"|"fixtures"} mode
 * @returns {{opportunity: any, provenance: any, classification: any}}
 */
export function buildFixtureRepositories(mode) {
  if (mode === "fixtures") {
    return {
      opportunity: new FixtureOpportunityRepository(OPPORTUNITY_FIXTURES),
      provenance: new FixtureProvenanceRepository(OPPORTUNITY_FIXTURES),
      classification: new FixtureClassificationRepository(OPPORTUNITY_FIXTURES, CLASSIFICATION_HISTORY_FIXTURES),
    };
  }

  return {
    opportunity: new EmptyOpportunityRepository(),
    provenance: new EmptyProvenanceRepository(),
    classification: new EmptyClassificationRepository(),
  };
}
