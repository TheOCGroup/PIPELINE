/** Read-only data-quality service. Deterministic given a clock. */

import { summarizeDataQuality } from "../domain/dataQuality/dataQualityModel.js";

export class DataQualityReadService {
  constructor(opportunityRepository) { this.repository = opportunityRepository; }

  async summarize({ now } = {}) {
    const opportunities = await this.repository.listAll();
    return summarizeDataQuality(opportunities, { now });
  }
}
