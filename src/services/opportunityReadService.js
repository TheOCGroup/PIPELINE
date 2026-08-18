/**
 * Read-only opportunity service. Projects domain read models, validates filters,
 * and paginates. Exposes NO mutation methods.
 */

import { toListItem, statusForStage, opportunityProvenanceState, OPPORTUNITY_STATUS } from "../domain/opportunities/opportunityModel.js";
import { STAGES } from "../domain/stages/stageModel.js";
import { PROVENANCE_STATES, resolveProvenance } from "../domain/provenance/provenanceModel.js";
import { CLASSIFICATIONS } from "../domain/classifications/classificationModel.js";
import { ValidationError, NotFoundError } from "./serviceErrors.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const ALLOWED = {
  stage: new Set(STAGES),
  provenanceState: new Set(Object.values(PROVENANCE_STATES)),
  classification: new Set(Object.values(CLASSIFICATIONS)),
  status: new Set(Object.values(OPPORTUNITY_STATUS)),
};

function validateFilters(filters = {}) {
  const clean = {};
  for (const key of ["stage", "provenanceState", "classification", "status"]) {
    const v = filters[key];
    if (v == null || v === "") continue;
    if (!ALLOWED[key].has(v)) throw new ValidationError(`invalid filter value for '${key}'`, { field: key });
    clean[key] = v;
  }
  if (filters.assignedOperator) clean.assignedOperator = String(filters.assignedOperator);
  return clean;
}

function validatePagination({ page, pageSize } = {}) {
  const p = page == null || page === "" ? 1 : Number(page);
  const ps = pageSize == null || pageSize === "" ? DEFAULT_PAGE_SIZE : Number(pageSize);
  if (!Number.isInteger(p) || p < 1) throw new ValidationError("invalid 'page'", { field: "page" });
  if (!Number.isInteger(ps) || ps < 1 || ps > MAX_PAGE_SIZE) throw new ValidationError("invalid 'pageSize'", { field: "pageSize" });
  return { page: p, pageSize: ps };
}

export class OpportunityReadService {
  constructor(repository) { this.repository = repository; }

  async list({ filters = {}, page, pageSize } = {}) {
    const clean = validateFilters(filters);
    const { page: p, pageSize: ps } = validatePagination({ page, pageSize });

    const all = (await this.repository.listAll()).map(toListItem);
    const filtered = all.filter((o) =>
      (clean.stage == null || o.stage === clean.stage) &&
      (clean.provenanceState == null || o.provenanceState === clean.provenanceState) &&
      (clean.classification == null || o.classification === clean.classification) &&
      (clean.status == null || o.status === clean.status) &&
      (clean.assignedOperator == null || o.assignedOperator === clean.assignedOperator)
    );
    // Deterministic order by id.
    filtered.sort((a, b) => a.id.localeCompare(b.id));

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / ps));
    const start = (p - 1) * ps;
    const items = filtered.slice(start, start + ps);

    return { items, pagination: { page: p, pageSize: ps, total, totalPages }, appliedFilters: clean };
  }

  async getById(id) {
    const opp = await this.repository.getById(id);
    if (!opp) throw new NotFoundError("opportunity_not_found");
    const resolved = resolveProvenance(opp.source || {});
    return {
      id: opp.id,
      code: opp.code,
      sellerDisplayName: opp.sellerDisplayName,
      property: { externalPropertyId: opp.property?.externalPropertyId ?? null, address: opp.property?.address ?? null },
      assignedOperator: opp.assignedOperator ?? null,
      stage: opp.stage,
      status: statusForStage(opp.stage),
      classification: opp.classification,
      isFixture: opp.isFixture ?? false,
      provenance: {
        state: opportunityProvenanceState(opp),
        resolvedSourceMessageId: resolved.resolvedSourceMessageId,
        originalSourceMessageId: opp.source?.originalSourceMessageId ?? null,
        recoveredSourceMessageId: opp.source?.recoveredSourceMessageId ?? null,
        recoveryMethod: opp.source?.recoveryMethod ?? null,
        recoveryConfidence: opp.source?.recoveryConfidence ?? null,
        metadata: opp.source?.provenanceMetadata ?? null
      },
      underwriting: opp.underwriting ?? null,
      participants: opp.participants ?? [],
      sources: opp.sources ?? [],
      stageTimeline: opp.stageTimeline ?? [],
      offers: opp.offers ?? [],
      contact: opp.contact ?? null,
      communications: opp.communications ?? [],
      outcome: opp.outcome ?? null,
      lastActivity: opp.lastActivity ?? null,
    };
  }
}
