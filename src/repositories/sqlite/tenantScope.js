/**
 * Tenant scope — the single implementation of opportunity ownership.
 *
 * `tenant_id` exists only on `seller_opportunities` (migration 003); every
 * other table hangs off `opportunity_id`. Isolation therefore needs exactly
 * two mechanisms, both built on this module:
 *
 *   1. Root scoping — queries that touch `seller_opportunities` or list
 *      across opportunities filter on the root row's `tenant_id`.
 *   2. Ownership assertion — by-id / by-`opportunity_id` paths resolve the
 *      parent opportunity's tenant with one indexed lookup and treat a
 *      foreign id exactly like a nonexistent id (no existence leak).
 *
 * The tenant value itself comes only from deployment configuration
 * (`PIPELINE_TENANT_ID`, see src/config/environment.js) — never from a
 * request header, query parameter, token claim, or body field.
 */

export const DEFAULT_TENANT_ID = "ocg-one";

/**
 * Resolve the effective tenant for a config value that may be absent
 * (directly-constructed test configs bypass loadConfig). Falls back to the
 * canonical tenant, matching the non-production config default.
 */
export function normalizeTenantId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_TENANT_ID;
}

/** The stored tenant of one opportunity, or null when it does not exist. */
export function opportunityTenant(db, id) {
  if (!db || !id) return null;
  const row = db
    .prepare("SELECT tenant_id FROM seller_opportunities WHERE id = ?")
    .get(id);
  return row ? row.tenant_id : null;
}

/** True only when the opportunity exists AND belongs to the given tenant. */
export function isOpportunityInTenant(db, tenantId, id) {
  if (!db || !tenantId || !id) return false;
  const tenant = opportunityTenant(db, id);
  return tenant !== null && tenant === tenantId;
}
