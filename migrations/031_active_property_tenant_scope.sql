-- Migration 031: Tenant-scoped active-property uniqueness (R1 finding GAP-1c).
--
-- Migration 003 created idx_unq_active_property_opp: one ACTIVE opportunity
-- per ocg_one_property_id — globally. In a shared database that makes two
-- tenants' legitimate conversions of leads for the same property collide
-- (500 conversion_transaction_failed on the second tenant's insert), the
-- same single-tenant-era defect class as GAP-1b (migration 030). The rule
-- itself is sound per tenant; its scope was wrong.
--
-- Fix: same partial unique index, keyed by (tenant_id, ocg_one_property_id).
-- Index-only change; no table rebuild, no data movement. NULL property ids
-- remain distinct under SQLite UNIQUE semantics, exactly as before.
DROP INDEX IF EXISTS idx_unq_active_property_opp;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unq_active_property_opp
ON seller_opportunities(tenant_id, ocg_one_property_id)
WHERE opportunity_status NOT IN ('closed_purchased', 'closed_disqualified', 'closed_lost', 'archived');
