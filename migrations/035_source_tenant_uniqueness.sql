-- Migration 035: tenant-aware source uniqueness (Founder remediation
-- order 2026-11-01 §6; design: ASTRA review package §3)
-- System: OCG OS / PIPELINE
-- Purpose: seller_opportunity_sources carried a GLOBAL
-- UNIQUE(source_type, source_record_id) (migration 003, retained by the
-- 024 rebuild). After the certified U1 fix tenant-scoped both convert
-- idempotency lookups, a cross-tenant re-presentation of the same source
-- pair fell through the scoped legs and aborted on that global
-- constraint (500 conversion_transaction_failed — fail-closed, no
-- disclosure, but a legitimate second-tenant record of the same source
-- lead was impossible).
--
-- This migration makes the uniqueness tenant-aware:
--   * seller_opportunity_sources gains tenant_id, backfilled from the
--     parent opportunity (tenant truth comes from the parent row, never
--     from caller input — every runtime insert site stamps it from the
--     parent opportunity it creates/loads in the same transaction);
--   * the constraint becomes UNIQUE(tenant_id, source_type,
--     source_record_id): same-tenant dedupe behavior is unchanged (the
--     old global constraint was strictly stronger, so every existing row
--     set satisfies the new one), while a different tenant presenting
--     the same source pair now creates its OWN record.
--
-- Second layer of the same residual, found by reproduction during this
-- remediation: the convert transaction inserts the opportunity BEFORE
-- the source row, and migration 003's partial index
-- idx_unq_active_property_opp enforces one ACTIVE opportunity per
-- ocg_one_property_id GLOBALLY — so a cross-tenant conversion actually
-- aborted on the property index first and never reached the source
-- constraint (the U1-era 500 had two layers; only the second was
-- documented). The index's business invariant — one active opportunity
-- per property — is preserved, scoped per tenant: the replacement
-- index below is UNIQUE(tenant_id, ocg_one_property_id) under the
-- identical partial predicate. Same-tenant behavior is unchanged;
-- no code reads by property id expecting a global singleton.
--
-- SQLite cannot ALTER a UNIQUE constraint; the standard table-rebuild
-- pattern from migration 024 is used. The append-only triggers (004,
-- re-created by 024) block UPDATE/DELETE only, so the INSERT..SELECT
-- copy is unaffected; they are re-created by name after the rename.
-- The copy resolves tenant_id through a LEFT JOIN so a hypothetically
-- dangling row would survive with a NULL tenant instead of aborting the
-- migration (the FK makes dangling rows impossible in an enforced DB).

PRAGMA foreign_keys=OFF;

CREATE TABLE seller_opportunity_sources_new (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    tenant_id TEXT,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'property_lead_inbox', 'gmail_digest', 'website_form', 'manual_entry',
        'referral', 'deal_scout_handoff', 'deal_finder_intake', 'ocg_one_lead',
        'legacy_seller_record'
    )),
    source_record_id TEXT,
    source_message_id TEXT,
    original_address TEXT NOT NULL,
    source_timestamp TEXT NOT NULL,
    conversion_actor TEXT NOT NULL,
    conversion_timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    provenance_metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CONSTRAINT unq_source_record UNIQUE (tenant_id, source_type, source_record_id)
);

INSERT INTO seller_opportunity_sources_new
    (id, opportunity_id, tenant_id, source_type, source_record_id, source_message_id,
     original_address, source_timestamp, conversion_actor, conversion_timestamp,
     provenance_metadata_json, created_at)
SELECT
    s.id, s.opportunity_id, o.tenant_id, s.source_type, s.source_record_id, s.source_message_id,
    s.original_address, s.source_timestamp, s.conversion_actor, s.conversion_timestamp,
    s.provenance_metadata_json, s.created_at
FROM seller_opportunity_sources s
LEFT JOIN seller_opportunities o ON o.id = s.opportunity_id;

DROP TABLE seller_opportunity_sources;

ALTER TABLE seller_opportunity_sources_new RENAME TO seller_opportunity_sources;

-- Re-create the append-only triggers dropped with the old table (names and
-- behavior identical to 004/024).
CREATE TRIGGER trg_prevent_seller_sources_update
BEFORE UPDATE ON seller_opportunity_sources
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_opportunity_sources is prohibited.');
END;

CREATE TRIGGER trg_prevent_seller_sources_delete
BEFORE DELETE ON seller_opportunity_sources
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_opportunity_sources is prohibited.');
END;

CREATE INDEX IF NOT EXISTS idx_sources_opportunity ON seller_opportunity_sources(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_sources_record ON seller_opportunity_sources(tenant_id, source_type, source_record_id);

-- One ACTIVE opportunity per property, per tenant (was: globally).
-- Same name, same partial predicate, tenant-leading key.
DROP INDEX IF EXISTS idx_unq_active_property_opp;
CREATE UNIQUE INDEX idx_unq_active_property_opp
ON seller_opportunities(tenant_id, ocg_one_property_id)
WHERE opportunity_status NOT IN ('closed_purchased', 'closed_disqualified', 'closed_lost', 'archived');

PRAGMA foreign_keys=ON;
