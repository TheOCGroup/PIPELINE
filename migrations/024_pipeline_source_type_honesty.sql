-- 024: Honest source attribution for intake origins.
--
-- The seller_opportunity_sources.source_type CHECK predates the protected
-- Deal Finder intake cutover and only knows 'deal_scout_handoff', so plain
-- Deal Finder (Hunter) payloads were recorded under the wrong typed origin.
-- The true origin was only recoverable from provenance_metadata_json.
--
-- This rebuilds the table with an expanded CHECK that distinguishes:
--   deal_finder_intake  - Deal Finder / Hunter discovery intake
--   deal_scout_handoff  - Victor / Deal Scout underwriting handoff
--   manual_entry        - founder-entered via the PIPELINE operator UI
--   ocg_one_lead        - converted OCG ONE lead via /opportunities/convert
-- plus the pre-existing legacy values.
--
-- SQLite cannot ALTER a CHECK constraint; the standard table-rebuild pattern
-- is used. The append-only triggers (004) block UPDATE/DELETE only, so the
-- INSERT..SELECT copy is unaffected. Triggers are re-created by name after
-- the rename (they were defined on the table name, so they must be dropped
-- with the old table and re-created).

PRAGMA foreign_keys=OFF;

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
    CONSTRAINT unq_source_record UNIQUE (source_type, source_record_id)
);

INSERT INTO seller_opportunity_sources_new
    (id, opportunity_id, source_type, source_record_id, source_message_id,
     original_address, source_timestamp, conversion_actor, conversion_timestamp,
     provenance_metadata_json, created_at)
SELECT
    id, opportunity_id,
    -- Reclassify plain Deal Finder intake rows that were recorded under the
    -- conflated 'deal_scout_handoff' type, using the origin metadata the
    -- intake has always written.
    CASE
        WHEN source_type = 'deal_scout_handoff'
             AND json_extract(provenance_metadata_json, '$.originSystem') = 'deal-finder'
             AND json_extract(provenance_metadata_json, '$.victorPackage') IS NULL
        THEN 'deal_finder_intake'
        ELSE source_type
    END,
    source_record_id, source_message_id,
    original_address, source_timestamp, conversion_actor, conversion_timestamp,
    provenance_metadata_json, created_at
FROM seller_opportunity_sources;

DROP TABLE seller_opportunity_sources;

ALTER TABLE seller_opportunity_sources_new RENAME TO seller_opportunity_sources;

-- Re-create the append-only triggers dropped with the old table (names and
-- behavior identical to 004).
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

PRAGMA foreign_keys=ON;
