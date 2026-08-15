/** Read-only provenance repository interface. No mutation methods, ever. */
export class ProvenanceReadRepository {
  /** @returns {Promise<Array<object>>} provenance rows */
  async listAll() {
    throw new Error("ProvenanceReadRepository.listAll is not implemented");
  }
}
