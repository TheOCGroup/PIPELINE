import { buildFixtureRepositories } from "../repositories/fixture/fixtureRepositories.js";
import {
  SqliteOpportunityRepository,
  SqliteProvenanceRepository,
  SqliteClassificationRepository
} from "../repositories/sqlite/sqliteRepositories.js";
import { OpportunityReadService } from "../services/opportunityReadService.js";
import { ProvenanceReadService } from "../services/provenanceReadService.js";
import { ClassificationReadService } from "../services/classificationReadService.js";
import { DataQualityReadService } from "../services/dataQualityReadService.js";
import { SqliteOperatorRepository } from "../repositories/sqlite/sqliteOperatorRepository.js";
import { PiperContextService } from "../services/piperContextService.js";
import { PiperRuntime } from "../services/piper/piperRuntime.js";
import { createPiperProvider } from "../services/piper/providers/index.js";
import { InvestmentCommitteeService } from "../services/investmentCommitteeService.js";

export function buildServices(config, db) {
  let repos;
  if (config.dataSource === "empty") {
    repos = {
      opportunity: new SqliteOpportunityRepository(db),
      provenance: new SqliteProvenanceRepository(db),
      classification: new SqliteClassificationRepository(db),
    };
  } else {
    repos = buildFixtureRepositories(config.dataSource);
  }

  return {
    opportunities: new OpportunityReadService(repos.opportunity),
    provenance: new ProvenanceReadService(repos.provenance),
    classifications: new ClassificationReadService(repos.classification),
    dataQuality: new DataQualityReadService(repos.opportunity),
    // Operator state and Piper always read the database directly, even when the
    // read API is serving fixtures: operator input and the brief must reflect
    // what is actually stored, never a demonstration set.
    operator: db ? new SqliteOperatorRepository(db, config) : null,
    investmentCommittee: db ? new InvestmentCommitteeService(db) : null,
    piperContext: db ? new PiperContextService(db, config) : null,
    piper: db ? buildPiperRuntime(config, db) : null,
  };
}

function buildPiperRuntime(config, db) {
  const contextService = new PiperContextService(db, config);
  const operator = new SqliteOperatorRepository(db, config);
  // A misconfigured provider must not take the whole application down; Piper
  // degrades to deterministic answers and the System view reports why.
  let provider;
  try {
    provider = createPiperProvider(config);
  } catch (err) {
    console.error(`[piper] provider disabled: ${err.message}`);
    provider = createPiperProvider({ piperProvider: "none" });
  }
  return new PiperRuntime({ db, config, contextService, operator, provider });
}
