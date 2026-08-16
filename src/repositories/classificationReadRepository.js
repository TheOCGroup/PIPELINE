/** Read-only classification repository interface. No mutation methods, ever. */
export class ClassificationReadRepository {
  /** @returns {Promise<Array<object>>} current classifications */
  async listAll() {
    throw new Error("ClassificationReadRepository.listAll is not implemented");
  }

  /** @returns {Promise<Array<object>>} append-only classification history */
  async listHistory() {
    throw new Error("ClassificationReadRepository.listHistory is not implemented");
  }
}
