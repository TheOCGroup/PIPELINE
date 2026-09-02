-- Migration 015: Governed offer workflow state
-- System: PIPELINE
-- Purpose: keep Offer Preparation -> Committee Review -> Approval -> Presentation
-- synchronized even when callers use existing offer endpoints.

-- Any new active offer version enters offer preparation and clears stale approval state.
CREATE TRIGGER trg_offer_version_enters_preparation
AFTER UPDATE OF active_version_id ON seller_offers
FOR EACH ROW
WHEN NEW.active_version_id IS NOT NULL
  AND COALESCE(NEW.active_version_id, '') <> COALESCE(OLD.active_version_id, '')
BEGIN
    INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
    SELECT lower(hex(randomblob(16))), NEW.opportunity_id, pipeline_stage, 'offer_preparation',
           'offer-workflow', 'Active offer version prepared or revised'
    FROM seller_opportunities
    WHERE id = NEW.opportunity_id AND pipeline_stage <> 'offer_preparation';

    UPDATE seller_opportunities
    SET pipeline_stage = 'offer_preparation',
        opportunity_status = 'active',
        updated_by = 'offer-workflow',
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.opportunity_id;
END;

-- Committee-approved candidates are explicitly waiting for operator approval.
CREATE TRIGGER trg_offer_pending_approval_updates_opportunity
AFTER UPDATE OF status ON seller_offers
FOR EACH ROW
WHEN NEW.status = 'pending_approval' AND OLD.status <> 'pending_approval'
BEGIN
    INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
    SELECT lower(hex(randomblob(16))), NEW.opportunity_id, pipeline_stage, 'offer_approval_required',
           'investment-committee', 'Investment Committee cleared active offer version for approval'
    FROM seller_opportunities
    WHERE id = NEW.opportunity_id AND pipeline_stage <> 'offer_approval_required';

    UPDATE seller_opportunities
    SET pipeline_stage = 'offer_approval_required',
        opportunity_status = 'pending_approval',
        updated_by = 'investment-committee',
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.opportunity_id;
END;

-- Final operator approval records the approval timestamp. Presentation remains a
-- separate seller-communication action and is already responsible for moving the
-- opportunity to offer_presented only after a successful send.
CREATE TRIGGER trg_offer_approved_updates_opportunity
AFTER UPDATE OF status ON seller_offers
FOR EACH ROW
WHEN NEW.status = 'approved' AND OLD.status <> 'approved'
BEGIN
    UPDATE seller_opportunities
    SET opportunity_status = 'active',
        offer_approved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        updated_by = 'offer-approval',
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.opportunity_id;
END;
