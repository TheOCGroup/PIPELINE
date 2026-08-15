/**
 * Read-only opportunity repository interface.
 *
 * A boundary the UI never crosses directly. Fixture-backed today; replaceable by
 * an API- or database-backed implementation in later phases. Read-only by
 * contract: there are no mutation methods, here or in any implementation.
 */
export class OpportunityReadRepository {
  /** @returns {Promise<Array<object>>} all opportunity records (unprojected) */
  async listAll() {
    throw new Error("OpportunityReadRepository.listAll is not implemented");
  }

  /** @param {string} id @returns {Promise<object|null>} */
  async getById(_id) {
    throw new Error("OpportunityReadRepository.getById is not implemented");
  }
}
