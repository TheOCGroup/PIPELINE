-- pipeline:migration-no-transaction
-- Migration 025: Offer underwriting source honesty — operator assumptions.
--
-- Offers prepared from founder-recorded operator assumptions (not Victor/Deal
-- Scout analysis) must be able to name their true underwriting source. The
-- original seller_offer_versions CHECK only allowed Victor vocabularies
-- ('victor_analysis', 'deal_scout_project'), which made honest operator-source
-- offers impossible and would have forced a false Victor label.
--
-- This migration widens the CHECK to include 'operator_assumption'.
--
-- Strategy: the new table is built under a TEMPORARY name, then swapped into
-- place (DROP original, RENAME temp to the live name). The live table name is
-- never renamed to something else, because SQLite rewrites foreign-key clauses
-- and trigger bodies that mention a renamed table — renaming seller_offer_versions
-- would silently repoint five child tables' FKs and five triggers at the stale
-- name. The swap avoids that entire hazard: child FK text keeps saying
-- REFERENCES seller_offer_versions(id) and resolves to the rebuilt table.
--
-- This migration manages its own transaction because the swap requires
-- PRAGMA foreign_keys=OFF outside any transaction (the pragma is a no-op
-- inside one; dropping a referenced parent is blocked with FKs on).
--
-- Safety: the CHECK change is a strict widening (every existing row satisfies
-- it), column order/names are unchanged, child FKs and all 59 triggers are
-- verified identical before/after (see migration verification notes).

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

-- 0. Temporarily drop the triggers on OTHER tables whose bodies reference
--    seller_offer_versions. SQLite blocks DROP TABLE while such triggers exist
--    ("error in trigger ... no such table"). They are rebuilt verbatim in step 6.
DROP TRIGGER IF EXISTS trg_verify_active_version_fkey;
DROP TRIGGER IF EXISTS trg_verify_active_version_ownership_insert;
DROP TRIGGER IF EXISTS trg_verify_active_version_ownership_update;
DROP TRIGGER IF EXISTS trg_verify_outcome_offer_version_ownership_insert;
DROP TRIGGER IF EXISTS trg_verify_outcome_offer_version_ownership_update;

-- 1. Build the replacement under a temporary name. Definition is byte-identical
--    to migration 005 except the widened underwriting_source_type CHECK.
CREATE TABLE seller_offer_versions_new (
    id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL REFERENCES seller_offers(id) ON DELETE RESTRICT,
    version_number INTEGER NOT NULL,
    version_status TEXT NOT NULL DEFAULT 'draft' CHECK (version_status IN ('draft', 'pending_approval', 'approved', 'rejected', 'superseded')),
    strategy_type TEXT NOT NULL CHECK (strategy_type IN ('cash_purchase', 'assignment', 'novation', 'seller_finance', 'subject_to', 'lease_option', 'listing_referral', 'no_offer')),
    purchase_price REAL NOT NULL,
    earnest_money REAL NOT NULL,
    inspection_days INTEGER NOT NULL,
    closing_days INTEGER NOT NULL,
    expiration_at TEXT,
    contingencies_json TEXT NOT NULL,
    seller_facing_terms TEXT,
    internal_notes TEXT,
    underwriting_source_type TEXT NOT NULL CHECK (underwriting_source_type IN ('victor_analysis', 'deal_scout_project', 'operator_assumption')),
    underwriting_source_id TEXT NOT NULL,
    underwriting_version_id TEXT NOT NULL,
    underwriting_arv_snapshot REAL NOT NULL,
    underwriting_rehab_snapshot REAL NOT NULL,
    underwriting_mao_snapshot REAL NOT NULL,
    underwriting_confidence REAL,
    underwriting_limitations TEXT,
    underwriting_timestamp TEXT,
    ocg_one_approval_id TEXT, -- External approval reference without FK
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    superseded_by TEXT REFERENCES seller_offer_versions_new(id),
    CONSTRAINT unq_offer_version UNIQUE (offer_id, version_number)
);

-- 2. Copy rows. Self-referencing superseded_by links are restored in a second
--    pass so no ordering hazard exists.
INSERT INTO seller_offer_versions_new (
    id, offer_id, version_number, version_status, strategy_type,
    purchase_price, earnest_money, inspection_days, closing_days,
    expiration_at, contingencies_json, seller_facing_terms, internal_notes,
    underwriting_source_type, underwriting_source_id, underwriting_version_id,
    underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
    underwriting_confidence, underwriting_limitations, underwriting_timestamp,
    ocg_one_approval_id, created_by, created_at, superseded_by
)
SELECT
    id, offer_id, version_number, version_status, strategy_type,
    purchase_price, earnest_money, inspection_days, closing_days,
    expiration_at, contingencies_json, seller_facing_terms, internal_notes,
    underwriting_source_type, underwriting_source_id, underwriting_version_id,
    underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
    underwriting_confidence, underwriting_limitations, underwriting_timestamp,
    ocg_one_approval_id, created_by, created_at, NULL
FROM seller_offer_versions;

UPDATE seller_offer_versions_new
SET superseded_by = (
  SELECT legacy.superseded_by
  FROM seller_offer_versions AS legacy
  WHERE legacy.id = seller_offer_versions_new.id
)
WHERE EXISTS (
  SELECT 1 FROM seller_offer_versions AS legacy
  WHERE legacy.id = seller_offer_versions_new.id AND legacy.superseded_by IS NOT NULL
);

-- 3. Swap into place. The live name is never renamed away, so child FK clauses
--    and trigger bodies that mention it are untouched.
DROP TABLE seller_offer_versions;

ALTER TABLE seller_offer_versions_new RENAME TO seller_offer_versions;

-- 4. Restore the index.
CREATE INDEX IF NOT EXISTS idx_seller_ver_off ON seller_offer_versions(offer_id, version_number);

-- 5. Recreate the two triggers that lived ON seller_offer_versions (dropping the
--    original table dropped them). Rebuilt verbatim from migration 005.
CREATE TRIGGER trg_prevent_pending_or_approved_offer_version_terms_update
BEFORE UPDATE ON seller_offer_versions
FOR EACH ROW
WHEN (OLD.version_status = 'pending_approval' OR OLD.version_status = 'approved')
  AND (NEW.strategy_type != OLD.strategy_type
    OR NEW.purchase_price != OLD.purchase_price
    OR NEW.earnest_money != OLD.earnest_money
    OR NEW.inspection_days != OLD.inspection_days
    OR NEW.closing_days != OLD.closing_days
    OR COALESCE(NEW.expiration_at, '') != COALESCE(OLD.expiration_at, '')
    OR NEW.contingencies_json != OLD.contingencies_json
    OR COALESCE(NEW.seller_facing_terms, '') != COALESCE(OLD.seller_facing_terms, '')
    OR COALESCE(NEW.internal_notes, '') != COALESCE(OLD.internal_notes, '')
    OR NEW.underwriting_source_type != OLD.underwriting_source_type
    OR NEW.underwriting_source_id != OLD.underwriting_source_id
    OR NEW.underwriting_version_id != OLD.underwriting_version_id
    OR NEW.underwriting_arv_snapshot != OLD.underwriting_arv_snapshot
    OR NEW.underwriting_rehab_snapshot != OLD.underwriting_rehab_snapshot
    OR NEW.underwriting_mao_snapshot != OLD.underwriting_mao_snapshot
    OR COALESCE(NEW.underwriting_confidence, 0) != COALESCE(OLD.underwriting_confidence, 0)
    OR COALESCE(NEW.underwriting_limitations, '') != COALESCE(OLD.underwriting_limitations, '')
    OR COALESCE(NEW.underwriting_timestamp, '') != COALESCE(OLD.underwriting_timestamp, ''))
BEGIN
    SELECT RAISE(FAIL, 'Modifying terms of a pending_approval or approved seller_offer_version is prohibited. Revisions must create a new version.');
END;

CREATE TRIGGER trg_prevent_pending_or_approved_offer_version_delete
BEFORE DELETE ON seller_offer_versions
FOR EACH ROW
WHEN OLD.version_status = 'pending_approval' OR OLD.version_status = 'approved'
BEGIN
    SELECT RAISE(FAIL, 'Deleting a pending_approval or approved seller_offer_version is prohibited.');
END;

-- 6. Rebuild the triggers dropped in step 0, verbatim from migrations 005/006.
DROP TRIGGER IF EXISTS trg_verify_active_version_fkey;
CREATE TRIGGER trg_verify_active_version_fkey
BEFORE UPDATE OF active_version_id ON seller_offers
FOR EACH ROW
WHEN NEW.active_version_id IS NOT NULL
BEGIN
    SELECT CASE
        WHEN (SELECT id FROM seller_offer_versions WHERE id = NEW.active_version_id) IS NULL
        THEN RAISE(FAIL, 'active_version_id must reference a valid seller_offer_versions record.')
    END;
END;

DROP TRIGGER IF EXISTS trg_verify_active_version_ownership_insert;
CREATE TRIGGER trg_verify_active_version_ownership_insert
BEFORE INSERT ON seller_offers
FOR EACH ROW
WHEN NEW.active_version_id IS NOT NULL
BEGIN
    SELECT CASE 
        WHEN (SELECT offer_id FROM seller_offer_versions WHERE id = NEW.active_version_id) IS NULL
          OR (SELECT offer_id FROM seller_offer_versions WHERE id = NEW.active_version_id) != NEW.id
        THEN RAISE(FAIL, 'Active offer version must belong to the exact seller offer.')
    END;
END;

DROP TRIGGER IF EXISTS trg_verify_active_version_ownership_update;
CREATE TRIGGER trg_verify_active_version_ownership_update
BEFORE UPDATE OF active_version_id ON seller_offers
FOR EACH ROW
WHEN NEW.active_version_id IS NOT NULL
BEGIN
    SELECT CASE 
        WHEN (SELECT offer_id FROM seller_offer_versions WHERE id = NEW.active_version_id) IS NULL
          OR (SELECT offer_id FROM seller_offer_versions WHERE id = NEW.active_version_id) != NEW.id
        THEN RAISE(FAIL, 'Active offer version must belong to the exact seller offer.')
    END;
END;

DROP TRIGGER IF EXISTS trg_verify_outcome_offer_version_ownership_insert;
CREATE TRIGGER trg_verify_outcome_offer_version_ownership_insert
BEFORE INSERT ON seller_opportunity_outcomes
FOR EACH ROW
WHEN NEW.related_offer_version_id IS NOT NULL
BEGIN
    SELECT CASE 
        WHEN (
            SELECT so.opportunity_id 
            FROM seller_offer_versions sov 
            JOIN seller_offers so ON sov.offer_id = so.id 
            WHERE sov.id = NEW.related_offer_version_id
        ) IS NULL OR (
            SELECT so.opportunity_id 
            FROM seller_offer_versions sov 
            JOIN seller_offers so ON sov.offer_id = so.id 
            WHERE sov.id = NEW.related_offer_version_id
        ) != NEW.opportunity_id
        THEN RAISE(FAIL, 'Related offer version must belong to an offer under the same opportunity.')
    END;
END;

DROP TRIGGER IF EXISTS trg_verify_outcome_offer_version_ownership_update;
CREATE TRIGGER trg_verify_outcome_offer_version_ownership_update
BEFORE UPDATE OF related_offer_version_id ON seller_opportunity_outcomes
FOR EACH ROW
WHEN NEW.related_offer_version_id IS NOT NULL
BEGIN
    SELECT CASE 
        WHEN (
            SELECT so.opportunity_id 
            FROM seller_offer_versions sov 
            JOIN seller_offers so ON sov.offer_id = so.id 
            WHERE sov.id = NEW.related_offer_version_id
        ) IS NULL OR (
            SELECT so.opportunity_id 
            FROM seller_offer_versions sov 
            JOIN seller_offers so ON sov.offer_id = so.id 
            WHERE sov.id = NEW.related_offer_version_id
        ) != NEW.opportunity_id
        THEN RAISE(FAIL, 'Related offer version must belong to an offer under the same opportunity.')
    END;
END;

COMMIT;

PRAGMA foreign_keys=ON;
