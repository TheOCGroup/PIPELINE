import { ClassificationReadRepository } from "../classificationReadRepository.js";
import { classificationReason } from "../../domain/classifications/classificationModel.js";
import { opportunityProvenanceState } from "../../domain/opportunities/opportunityModel.js";
import { NOT_RECORDED } from "../sqlite/sqliteRepositories.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Fixture-backed classification reads.
 *
 * The projection deliberately matches SqliteClassificationRepository field for
 * field, so the Classifications screen means the same thing in either data
 * source. Two distinct questions are kept apart:
 *
 *   recordClassification — the deal classification the database stores, drawn
 *                          from the CHECK-constrained vocabulary.
 *   classification       — the REAL/SYNTHETIC/AMBIGUOUS lineage determination.
 *
 * Fixtures carry a lineage determination because they are demonstration data
 * that includes one. The SQLite schema has no column for it and therefore
 * reports NOT_RECORDED. Both are reporting what is actually held, which is the
 * consistency that matters; neither infers the other.
 */
export class FixtureClassificationRepository extends ClassificationReadRepository {
  constructor(dataset, history) {
    super();
    this.dataset = dataset;
    this.history = history;
  }

  async listAll() {
    return this.dataset.map((o) => ({
      opportunityId: o.id,
      classification: o.classification ?? NOT_RECORDED,
      leadClassification: o.leadClassification ?? null,
      recordClassification: o.recordClassification ?? NOT_RECORDED,
      provenanceState: opportunityProvenanceState(o),
      determinedBy: "classifier.demo",
      determinedAt: null,
      reason: classificationReason({
        classification: o.classification,
        leadClassification: o.leadClassification ?? null,
        provenanceState: opportunityProvenanceState(o),
      }),
    }));
  }

  async listHistory() {
    // Normalised to the same field names the SQLite repository returns.
    return clone(this.history).map((h) => ({
      opportunityId: h.opportunityId,
      priorClassification: h.priorClassification ?? "NONE",
      newClassification: h.newClassification,
      reason: h.reason,
      changedAt: h.changedAt,
      determinedBy: h.changedBy ?? h.determinedBy ?? null,
      rulesVersion: h.rulesVersion ?? null,
    }));
  }
}
