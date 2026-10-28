-- pipeline:migration-no-transaction
-- Migration 027: Nullable underwriting snapshots + explicit reference linkage.
--
-- Two storage-honesty closures left over from the PR #31 hardening
-- (Issue #30; QUINCEY findings U1/UA1):
--
-- 1. seller_offer_versions.underwriting_arv_snapshot / _rehab_snapshot /
--    _mao_snapshot are REAL NOT NULL (migration 005), so a version created
--    from an underwriting reference whose figures are unknown stores a 0
--    sentinel. Read models resolve figures through the reference, so the
--    sentinel is never presented as a figure — but unknown should STORE
--    as unknown. This migration makes the three columns nullable.
--
-- 2. A version's link to its underwriting reference is currently implicit
--    (source-id string + analyzed_at timestamp match), which is ambiguous
--    when a corrected package is re-sent with its original timestamp
--    (UA1). This migration adds underwriting_ref_id, an explicit foreign
--    key to opportunity_underwriting_refs(id), written at offer-prepare /
--    modify time from the actual reference row. ON DELETE SET NULL: the
--    Deal Scout dedupe flow legitimately replaces reference rows, and a
--    replaced reference must dissolve the link (read models then fall
--    back to the timestamp match) rather than block the replacement.
--
-- Strategy: identical to the proven migration 025 rebuild — the new
-- table is built under a TEMPORARY name, then swapped into place (DROP
-- original, RENAME temp to the live name). The live table name is never
-- renamed to something else, because SQLite rewrites foreign-key clauses
-- and trigger bodies that mention a renamed table. This migration
-- manages its own transaction because the swap requires
-- PRAGMA foreign_keys=OFF outside any transaction.
--
-- Safety: the change is purely structural. Every existing row is copied
-- verbatim (underwriting_ref_id starts NULL for historical rows;
-- backfilling linkage and nulling stored sentinels is the separately
-- governed remediation step, NOT part of this migration). One deliberate
-- deviation from "recreate triggers verbatim": the terms-protection
-- trigger recreated in step 5 compares the newly nullable snapshot
-- columns (and the new ref linkage) with IS NOT instead of !=, because
-- != evaluates to NULL — silently NOT firing — when either side is
-- NULL; without this, nullability would weaken the immutability guard.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

-- 0. Temporarily drop the triggers on OTHER tables whose bodies reference
--    seller_offer_versions (verbatim set from migration 025 step 0).
DROP TRIGGER IF EXISTS trg_verify_active_version_fkey;
DROP TRIGGER IF EXISTS trg_verify_active_version_ownership_insert;
DROP TRIGGER IF EXISTS trg_verify_active_version_ownership_update;
DROP TRIGGER IF EXISTS trg_verify_outcome_offer_version_ownership_insert;
DROP TRIGGER IF EXISTS trg_verify_outcome_offer_version_ownership_update;

-- 1. Build the replacement under a temporary name. Definition is identical
--    to migration 025's table except: the three snapshot columns are
--    nullable, and underwriting_ref_id is added after underwriting_version_id.
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
    underwriting_ref_id TEXT REFERENCES opportunity_underwriting_refs(id) ON DELETE SET NULL,
    underwriting_arv_snapshot REAL,
    underwriting_rehab_snapshot REAL,
    underwriting_mao_snapshot REAL,
    underwriting_confidence REAL,
    underwriting_limitations TEXT,
    underwriting_timestamp TEXT,
    ocg_one_approval_id TEXT, -- External approval reference without FK
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    superseded_by TEXT REFERENCES seller_offer_versions_new(id),
    CONSTRAINT unq_offer_version UNIQUE (offer_id, version_number)
);

-- 2. Copy rows verbatim. underwriting_ref_id is NULL for every historical
--    row. Self-referencing superseded_by links restored in a second pass.
INSERT INTO seller_offer_versions_new (
    id, offer_id, version_number, version_status, strategy_type,
    purchase_price, earnest_money, inspection_days, closing_days,
    expiration_at, contingencies_json, seller_facing_terms, internal_notes,
    underwriting_source_type, underwriting_source_id, underwriting_version_id,
    underwriting_ref_id,
    underwriting_arv_snapshot, underwriting_rehab_snapshot, underwriting_mao_snapshot,
    underwriting_confidence, underwriting_limitations, underwriting_timestamp,
    ocg_one_approval_id, created_by, created_at, superseded_by
)
SELECT
    id, offer_id, version_number, version_status, strategy_type,
    purchase_price, earnest_money, inspection_days, closing_days,
    expiration_at, contingencies_json, seller_facing_terms, internal_notes,
    underwriting_source_type, underwriting_source_id, underwriting_version_id,
    NULL,
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

-- 3. Swap into place. The live name is never renamed away, so child FK
--    clauses and trigger bodies that mention it are untouched.
DROP TABLE seller_offer_versions;

ALTER TABLE seller_offer_versions_new RENAME TO seller_offer_versions;

-- 4. Restore the index.
CREATE INDEX IF NOT EXISTS idx_seller_ver_off ON seller_offer_versions(offer_id, version_number);

-- 5. Recreate the two triggers that lived ON seller_offer_versions.
--    The delete trigger is verbatim from migration 005. The terms-update
--    trigger is verbatim EXCEPT the comparisons for the newly nullable
--    snapshot columns and the new underwriting_ref_id use IS NOT
--    (null-safe), for the reason stated in the header.
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
    OR NEW.underwriting_ref_id IS NOT OLD.underwriting_ref_id
    OR NEW.underwriting_arv_snapshot IS NOT OLD.underwriting_arv_snapshot
    OR NEW.underwriting_rehab_snapshot IS NOT OLD.underwriting_rehab_snapshot
    OR NEW.underwriting_mao_snapshot IS NOT OLD.underwriting_mao_snapshot
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
