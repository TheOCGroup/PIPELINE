-- Migration 006: Pipeline Invariant Hardening and Triggers
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Deprecation Triggers for Underwriting Ownership on seller_opportunities
DROP TRIGGER IF EXISTS trg_prevent_seller_opp_underwriting_insert;
CREATE TRIGGER trg_prevent_seller_opp_underwriting_insert
BEFORE INSERT ON seller_opportunities
FOR EACH ROW
WHEN NEW.target_purchase_price IS NOT NULL
  OR NEW.max_authorized_offer IS NOT NULL
  OR NEW.underwriting_arv_snapshot IS NOT NULL
  OR NEW.underwriting_rehab_snapshot IS NOT NULL
  OR NEW.underwriting_mao_snapshot IS NOT NULL
  OR NEW.underwriting_confidence IS NOT NULL
  OR NEW.underwriting_limitations IS NOT NULL
  OR NEW.underwriting_timestamp IS NOT NULL
BEGIN
    SELECT RAISE(FAIL, 'Direct writes to seller_opportunities underwriting fields are deprecated. Authoritative underwriting snapshots belong on seller_offer_versions.');
END;

DROP TRIGGER IF EXISTS trg_prevent_seller_opp_underwriting_update;
CREATE TRIGGER trg_prevent_seller_opp_underwriting_update
BEFORE UPDATE ON seller_opportunities
FOR EACH ROW
WHEN NEW.target_purchase_price IS NOT NULL
  OR NEW.max_authorized_offer IS NOT NULL
  OR NEW.underwriting_arv_snapshot IS NOT NULL
  OR NEW.underwriting_rehab_snapshot IS NOT NULL
  OR NEW.underwriting_mao_snapshot IS NOT NULL
  OR NEW.underwriting_confidence IS NOT NULL
  OR NEW.underwriting_limitations IS NOT NULL
  OR NEW.underwriting_timestamp IS NOT NULL
BEGIN
    SELECT RAISE(FAIL, 'Direct updates to seller_opportunities underwriting fields are deprecated. Authoritative underwriting snapshots belong on seller_offer_versions.');
END;

-- 2. Active Offer-Version Ownership Invariant Triggers on seller_offers
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

-- 3. Outcome Offer-Version Ownership Invariant Triggers on seller_opportunity_outcomes
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

-- 4. Auto-Refresh updated_at Triggers
DROP TRIGGER IF EXISTS trg_seller_opportunities_updated_at;
CREATE TRIGGER trg_seller_opportunities_updated_at
AFTER UPDATE ON seller_opportunities
FOR EACH ROW
BEGIN
    UPDATE seller_opportunities SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_seller_appointments_updated_at;
CREATE TRIGGER trg_seller_appointments_updated_at
AFTER UPDATE ON seller_appointments
FOR EACH ROW
BEGIN
    UPDATE seller_appointments SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_seller_offers_updated_at;
CREATE TRIGGER trg_seller_offers_updated_at
AFTER UPDATE ON seller_offers
FOR EACH ROW
BEGIN
    UPDATE seller_offers SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = NEW.id;
END;
