import { OpportunityReadRepository } from "../opportunityReadRepository.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

export class FixtureOpportunityRepository extends OpportunityReadRepository {
  constructor(dataset) {
    super();
    this.dataset = dataset;
  }

  async listAll() {
    return clone(this.dataset);
  }

  async getById(id) {
    return clone(this.dataset.find((o) => o.id === id) ?? null);
  }
}
