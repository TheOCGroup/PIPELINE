import { OpportunityReadRepository } from "../opportunityReadRepository.js";

export class EmptyOpportunityRepository extends OpportunityReadRepository {
  async listAll() {
    return [];
  }

  async getById(_id) {
    return null;
  }
}
