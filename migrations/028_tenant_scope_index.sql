-- Tenant scoping support (Audit A §5): tenant_id already exists on
-- seller_opportunities (migration 003). This migration adds only the index
-- that makes tenant-scoped root reads and ownership assertions cheap.
-- No column changes, no backfill, no data rewrite: production rows carrying
-- legacy labels are normalized by a separate, founder-authorized data step,
-- never by this migration.
CREATE INDEX IF NOT EXISTS idx_seller_opportunities_tenant ON seller_opportunities(tenant_id);
