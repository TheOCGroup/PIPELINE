-- Migration 004: Pipeline Immutability and History Schema
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Stage Events Audit Log (Append-Only)
CREATE TABLE IF NOT EXISTS seller_stage_events (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    prior_stage TEXT,
    new_stage TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    reason TEXT,
    transition_metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. Seller Appointments Table (UTC Timestamps)
CREATE TABLE IF NOT EXISTS seller_appointments (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    ocg_one_property_id TEXT NOT NULL, -- External property reference without FK
    starts_at_utc TEXT NOT NULL,
    ends_at_utc TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Chicago',
    local_display_start TEXT,
    appointment_type TEXT NOT NULL CHECK (appointment_type IN (
        'initial_call', 'consultation', 'property_walkthrough', 'inspection',
        'offer_presentation', 'negotiation_meeting', 'closing_prep'
    )),
    location TEXT,
    meeting_method TEXT NOT NULL CHECK (meeting_method IN ('in_person', 'phone', 'video_call')),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'rescheduled')),
    confirmation_status TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending', 'confirmed', 'declined')),
    outcome TEXT,
    linked_task_id TEXT, -- External task reference without FK
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 3. Seller Interactions Table (Privacy-Controlled Projections)
CREATE TABLE IF NOT EXISTS seller_interactions (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    participant_id TEXT REFERENCES seller_opportunity_participants(id),
    channel TEXT NOT NULL CHECK (channel IN ('email', 'phone', 'sms', 'in_person', 'mail')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    occurred_at TEXT NOT NULL,
    outcome TEXT,
    summary TEXT NOT NULL,
    private_note TEXT,
    source_type TEXT,
    source_record_id TEXT,
    external_message_id TEXT,
    visibility_classification TEXT NOT NULL DEFAULT 'internal' CHECK (visibility_classification IN ('internal', 'executive_only', 'public_summary')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 4. Append-Only Triggers for Auditable Lists
-- A. seller_stage_events (Prevent UPDATE and DELETE)
DROP TRIGGER IF EXISTS trg_prevent_seller_stage_events_update;
CREATE TRIGGER trg_prevent_seller_stage_events_update
BEFORE UPDATE ON seller_stage_events
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_stage_events is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_seller_stage_events_delete;
CREATE TRIGGER trg_prevent_seller_stage_events_delete
BEFORE DELETE ON seller_stage_events
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_stage_events is prohibited.');
END;

-- B. seller_opportunity_sources (Prevent UPDATE and DELETE)
DROP TRIGGER IF EXISTS trg_prevent_seller_sources_update;
CREATE TRIGGER trg_prevent_seller_sources_update
BEFORE UPDATE ON seller_opportunity_sources
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_opportunity_sources is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_seller_sources_delete;
CREATE TRIGGER trg_prevent_seller_sources_delete
BEFORE DELETE ON seller_opportunity_sources
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_opportunity_sources is prohibited.');
END;

-- C. seller_interactions (Prevent UPDATE and DELETE)
DROP TRIGGER IF EXISTS trg_prevent_seller_interactions_update;
CREATE TRIGGER trg_prevent_seller_interactions_update
BEFORE UPDATE ON seller_interactions
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_interactions is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_seller_interactions_delete;
CREATE TRIGGER trg_prevent_seller_interactions_delete
BEFORE DELETE ON seller_interactions
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_interactions is prohibited.');
END;
