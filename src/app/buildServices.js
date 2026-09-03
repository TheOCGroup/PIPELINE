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
import { TransactionWorkflowService } from "../services/transactionWorkflowService.js";
import { RenovationExitGovernanceService } from "../services/renovationExitGovernanceService.js";
import { PostRenovationDispositionService } from "../services/postRenovationDispositionService.js";
import { createAgentWorkRoomService } from "../services/agentWorkRoomService.js";

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

  const transactionService = db ? new TransactionWorkflowService(db) : null;
  const dispositionService = db ? new PostRenovationDispositionService(db) : null;
  const piperContext = db ? buildRiskAwarePiperContext(db, config, transactionService, dispositionService) : null;

  return {
    opportunities: new OpportunityReadService(repos.opportunity),
    provenance: new ProvenanceReadService(repos.provenance),
    classifications: new ClassificationReadService(repos.classification),
    dataQuality: new DataQualityReadService(repos.opportunity),
    operator: db ? new SqliteOperatorRepository(db, config) : null,
    investmentCommittee: db ? new InvestmentCommitteeService(db) : null,
    transactions: transactionService,
    renovationExits: db ? new RenovationExitGovernanceService(db) : null,
    dispositions: dispositionService,
    workRoom: db ? createAgentWorkRoomService(db) : null,
    piperContext,
    piper: db ? buildPiperRuntime(config, db, piperContext) : null,
  };
}

function buildRiskAwarePiperContext(db, config, transactions, dispositions = null) {
  const context = new PiperContextService(db, config);
  const baseSnapshot = context.snapshot.bind(context);
  context.snapshot = (options = {}) => {
    const snapshot = baseSnapshot(options);
    let criticalTransactionRisks = 0;
    let highTransactionRisks = 0;
    let blockedDispositions = 0;
    let activeDispositions = 0;

    snapshot.opportunities = snapshot.opportunities.map((opportunity) => {
      let transactionRisk = null;
      try { transactionRisk = transactions.riskReport(opportunity.id, snapshot.generatedAt); } catch {}

      let disposition = null;
      try { disposition = dispositions?.list(opportunity.id)?.[0] || null; } catch {}

      const transactionRisks = transactionRisk ? transactionRisk.risks.map((risk) => ({
        kind: risk.kind,
        severity: risk.severity,
        detail: risk.detail,
        dueAt: risk.dueAt || null,
        taskKey: risk.taskKey || null,
        category: risk.category || null,
        source: "transaction-workflow",
      })) : [];
      if (transactionRisk) {
        criticalTransactionRisks += transactionRisk.criticalCount;
        highTransactionRisks += transactionRisk.highCount;
      }

      const dispositionRisks = [];
      let dispositionNextAction = null;
      if (disposition) {
        if (disposition.status !== "completed") activeDispositions += 1;
        if (disposition.status === "blocked") {
          blockedDispositions += 1;
          dispositionRisks.push({kind:"disposition_blocked",severity:"high",detail:disposition.statusDetail || `${disposition.dispositionType} disposition is blocked.`,source:"post-renovation-disposition"});
          dispositionNextAction = `Resolve ${disposition.dispositionType} disposition blocker: ${disposition.statusDetail || "review blocking item"}`;
        } else if (disposition.status === "failed") {
          dispositionRisks.push({kind:"disposition_failed",severity:"critical",detail:disposition.statusDetail || `${disposition.dispositionType} disposition failed.`,source:"post-renovation-disposition"});
          dispositionNextAction = `Review failed ${disposition.dispositionType} disposition and determine recovery path`;
        } else if (disposition.status === "ready") dispositionNextAction = `Start approved ${disposition.dispositionType} disposition execution`;
        else if (["started","unblocked"].includes(disposition.status)) dispositionNextAction = `Continue approved ${disposition.dispositionType} disposition and satisfy remaining evidence requirements`;
      }

      return {
        ...opportunity,
        transactionRisk,
        disposition,
        dispositionNextAction,
        risks: [...(opportunity.risks || []), ...transactionRisks, ...dispositionRisks],
      };
    });

    snapshot.totals = {
      ...snapshot.totals,
      criticalTransactionRisks,
      highTransactionRisks,
      transactionsAtRisk: snapshot.opportunities.filter(o => ["critical", "high"].includes(o.transactionRisk?.riskLevel)).length,
      activeDispositions,
      blockedDispositions,
    };
    return snapshot;
  };
  return context;
}

function buildPiperRuntime(config, db, contextService = null) {
  const context = contextService || buildRiskAwarePiperContext(db, config, new TransactionWorkflowService(db), new PostRenovationDispositionService(db));
  const operator = new SqliteOperatorRepository(db, config);
  let provider;
  try {
    provider = createPiperProvider(config);
  } catch (err) {
    console.error(`[piper] provider disabled: ${err.message}`);
    provider = createPiperProvider({ piperProvider: "none" });
  }
  return new PiperRuntime({ db, config, contextService: context, operator, provider });
}
