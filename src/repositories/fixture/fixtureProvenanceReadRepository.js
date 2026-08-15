import { ProvenanceReadRepository } from "../provenanceReadRepository.js";
import { opportunityProvenanceState } from "../../domain/opportunities/opportunityModel.js";

export class FixtureProvenanceRepository extends ProvenanceReadRepository {
  constructor(dataset) {
    super();
    this.dataset = dataset;
  }

  async listAll() {
    return this.dataset.map((o) => ({
      opportunityId: o.id,
      sourceType: o.source?.sourceType ?? null,
      originalSourceMessageId: o.source?.originalSourceMessageId ?? null,
      recoveredSourceMessageId: o.source?.recoveredSourceMessageId ?? null,
      recoveryMethod: o.source?.recoveryMethod ?? null,
      recoveryConfidence: o.source?.recoveryConfidence ?? null,
      provenanceState: opportunityProvenanceState(o),
    }));
  }
}
