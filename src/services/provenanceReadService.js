/** Read-only provenance service. */

import { formatProvenanceState, formatRecoveryMethod } from "../domain/provenance/provenanceModel.js";

export class ProvenanceReadService {
  constructor(repository) { this.repository = repository; }

  async list() {
    const rows = await this.repository.listAll();
    return rows.map((r) => ({
      ...r,
      provenanceLabel: formatProvenanceState(r.provenanceState),
      recoveryMethodLabel: formatRecoveryMethod(r.recoveryMethod),
    }));
  }
}
