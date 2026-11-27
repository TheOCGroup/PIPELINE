-- pipeline:migration-no-transaction
-- Migration 030: Tenant-scoped source-record uniqueness (R1 finding GAP-1b).
--
-- seller_opportunity_sources carries CONSTRAINT unq_source_record
-- UNIQUE (source_type, source_record_id) — a GLOBAL uniqueness rule from the
-- single-tenant era (migration 003, retained by the 024 rebuild). With the
-- tenant-scope layer in place (028) and the convert dedupe lookups
-- tenant-scoped (R1 Patch A), this constraint is itself a cross-tenant
-- defect: when tenant B has converted a source lead, tenant A's legitimate
-- conversion of the same lead dies on the constraint
-- (500 conversion_transaction_failed), even though no data would leak.
-- Proven by tests/r1-s2-battery.test.mjs case S2-T5 against the pre-030
-- schema.
--
-- Fix: stamp each source row with its parent opportunity's tenant
-- (backfilled here by JOIN; writers stamp it at insert from this migration
-- on) and move uniqueness to (source_type, source_record_id, tenant_id) —
-- the same dedupe scope the application layer already enforces. The
-- per-tenant race protection the global constraint provided is preserved
-- within each tenant. Rows whose tenant cannot be resolved keep NULL
-- (SQLite treats NULLs as distinct in UNIQUE indexes, so legacy rows can
-- never collide).
--
-- Strategy follows 024/025: build under a temporary name, swap into place
-- (DROP original, RENAME temp), re-create the append-only triggers that
-- were defined on the table (004, re-created by 024). This migration
-- manages its own transaction because the swap requires
-- PRAGMA foreign_keys=OFF outside any transaction.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE seller_opportunity_sources_new (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
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
    tenant_id TEXT
);

INSERT INTO seller_opportunity_sources_new
    (id, opportunity_id, source_type, source_record_id, source_message_id,
     original_address, source_timestamp, conversion_actor, conversion_timestamp,
     provenance_metadata_json, created_at, tenant_id)
SELECT
    s.id, s.opportunity_id, s.source_type, s.source_record_id, s.source_message_id,
    s.original_address, s.source_timestamp, s.conversion_actor, s.conversion_timestamp,
    s.provenance_metadata_json, s.created_at, o.tenant_id
FROM seller_opportunity_sources s
JOIN seller_opportunities o ON o.id = s.opportunity_id;

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
CREATE INDEX IF NOT EXISTS idx_sources_record ON seller_opportunity_sources(source_type, source_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unq_source_record_tenant
    ON seller_opportunity_sources(source_type, source_record_id, tenant_id);

COMMIT;

PRAGMA foreign_keys=ON;
