-- Migration 005: Pipeline Offers and Outcomes Schema
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Standalone Seller Offers Table
CREATE TABLE IF NOT EXISTS seller_offers (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    current_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending_approval', 'approved', 'presented', 'rejected', 'countered', 'accepted', 'superseded', 'archived'
    )),
    active_version_id TEXT, -- Foreign key resolved below
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_seller_off_opp ON seller_offers(opportunity_id);

-- 2. Standalone Seller Offer Versions Table
CREATE TABLE IF NOT EXISTS seller_offer_versions (
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
    underwriting_source_type TEXT NOT NULL CHECK (underwriting_source_type IN ('victor_analysis', 'deal_scout_project')),
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
    superseded_by TEXT REFERENCES seller_offer_versions(id),
    CONSTRAINT unq_offer_version UNIQUE (offer_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_seller_ver_off ON seller_offer_versions(offer_id, version_number);

-- Add Foreign Key constraint (using a trigger since SQLite doesn't support adding FK dynamically via ALTER)
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

-- 3. Standalone Offer Approval Links Table
CREATE TABLE IF NOT EXISTS seller_offer_approval_links (
    id TEXT PRIMARY KEY,
    offer_version_id TEXT NOT NULL REFERENCES seller_offer_versions(id) ON DELETE RESTRICT,
    ocg_one_approval_id TEXT NOT NULL, -- External approval reference without FK
    link_status TEXT NOT NULL DEFAULT 'linked' CHECK (link_status IN ('linked', 'approved', 'rejected', 'by-passed')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unq_approval_link_version 
ON seller_offer_approval_links(offer_version_id);

-- 4. Standalone Seller Opportunity Outcomes Table (Append-Only)
CREATE TABLE IF NOT EXISTS seller_opportunity_outcomes (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    outcome_type TEXT NOT NULL CHECK (outcome_type IN (
        'purchased', 'seller_declined', 'price_misalignment', 'property_condition',
        'title_problem', 'unable_to_contact', 'competitor_purchased', 'listed_retail',
        'referred', 'nurture', 'duplicate', 'invalid_lead', 'other'
    )),
    reason TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    related_offer_version_id TEXT REFERENCES seller_offer_versions(id) ON DELETE SET NULL,
    reopen_eligibility TEXT NOT NULL DEFAULT 'eligible_with_approval' CHECK (reopen_eligibility IN ('eligible_with_approval', 'permanently_closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_seller_out_opp ON seller_opportunity_outcomes(opportunity_id);

-- 5. Immutability Protections for Offer Versions and Approval Links
-- A. Prevent modification of approved or pending versions
DROP TRIGGER IF EXISTS trg_prevent_pending_or_approved_offer_version_terms_update;
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

-- B. Prevent deletion of pending or approved offer versions
DROP TRIGGER IF EXISTS trg_prevent_pending_or_approved_offer_version_delete;
CREATE TRIGGER trg_prevent_pending_or_approved_offer_version_delete
BEFORE DELETE ON seller_offer_versions
FOR EACH ROW
WHEN OLD.version_status = 'pending_approval' OR OLD.version_status = 'approved'
BEGIN
    SELECT RAISE(FAIL, 'Deleting a pending_approval or approved seller_offer_version is prohibited.');
END;

-- C. Prevent update/delete on approval links
DROP TRIGGER IF EXISTS trg_prevent_seller_approval_links_update;
CREATE TRIGGER trg_prevent_seller_approval_links_update
BEFORE UPDATE ON seller_offer_approval_links
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_offer_approval_links is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_seller_approval_links_delete;
CREATE TRIGGER trg_prevent_seller_approval_links_delete
BEFORE DELETE ON seller_offer_approval_links
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_offer_approval_links is prohibited.');
END;

-- D. Prevent update/delete on outcomes
DROP TRIGGER IF EXISTS trg_prevent_seller_outcomes_update;
CREATE TRIGGER trg_prevent_seller_outcomes_update
BEFORE UPDATE ON seller_opportunity_outcomes
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_opportunity_outcomes is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_seller_outcomes_delete;
CREATE TRIGGER trg_prevent_seller_outcomes_delete
BEFORE DELETE ON seller_opportunity_outcomes
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_opportunity_outcomes is prohibited.');
END;
