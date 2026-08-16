import { ClassificationReadRepository } from "../classificationReadRepository.js";
import { classificationReason } from "../../domain/classifications/classificationModel.js";
import { opportunityProvenanceState } from "../../domain/opportunities/opportunityModel.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

export class FixtureClassificationRepository extends ClassificationReadRepository {
  constructor(dataset, history) {
    super();
    this.dataset = dataset;
    this.history = history;
  }

  async listAll() {
    return this.dataset.map((o) => ({
      opportunityId: o.id,
      classification: o.classification,
      leadClassification: o.leadClassification ?? null,
      provenanceState: opportunityProvenanceState(o),
      reason: classificationReason({
        classification: o.classification,
        leadClassification: o.leadClassification ?? null,
        provenanceState: opportunityProvenanceState(o),
      }),
    }));
  }

  async listHistory() {
    return clone(this.history);
  }
}
