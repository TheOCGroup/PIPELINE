import { ProvenanceReadRepository } from "../provenanceReadRepository.js";

export class EmptyProvenanceRepository extends ProvenanceReadRepository {
  async listAll() {
    return [];
  }
}
