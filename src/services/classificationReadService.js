/** Read-only classification service. Presents current + append-only history. */

export class ClassificationReadService {
  constructor(repository) { this.repository = repository; }

  async list() {
    return this.repository.listAll();
  }

  async history() {
    // Sorted oldest-first; history is append-only and never overwritten.
    const rows = await this.repository.listHistory();
    return rows.slice().sort((a, b) => String(a.changedAt).localeCompare(String(b.changedAt)));
  }
}
