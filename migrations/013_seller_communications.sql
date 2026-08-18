-- Migration 013: Event-Driven Seller Communications Schema
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Contacts Table (if not exists to align test and production databases)
CREATE TABLE IF NOT EXISTS pipeline_contacts (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    primary_role TEXT NOT NULL DEFAULT 'contact',
    roles_list TEXT,
    trust_score REAL DEFAULT 80.0,
    relationship_score REAL DEFAULT 75.0,
    last_contact TEXT,
    next_follow_up TEXT,
    notes_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. Immutable Communication Artifacts Table
CREATE TABLE IF NOT EXISTS seller_communications (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    offer_version_id TEXT REFERENCES seller_offer_versions(id) ON DELETE RESTRICT,
    recipient_person_id TEXT,
    recipient_value_snapshot TEXT NOT NULL,
    recipient_channel TEXT NOT NULL CHECK (recipient_channel IN ('email', 'sms', 'phone', 'mail')),
    recipient_verification_status TEXT NOT NULL CHECK (recipient_verification_status IN ('VERIFIED', 'SOURCE_SUPPLIED', 'UNVERIFIED', 'MISSING')),
    recipient_source_type TEXT,
    recipient_source_id TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    subject TEXT,
    content_text TEXT NOT NULL,
    template_version TEXT,
    in_reply_to_communication_id TEXT REFERENCES seller_communications(id) ON DELETE RESTRICT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 3. Append-Only Lifecycle Events Table
CREATE TABLE IF NOT EXISTS seller_communication_events (
    id TEXT PRIMARY KEY,
    communication_id TEXT NOT NULL REFERENCES seller_communications(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('drafted', 'authorized', 'send_attempted', 'sent', 'delivered', 'failed', 'canceled', 'received')),
    actor_id TEXT NOT NULL,
    provider_ref TEXT,
    outcome TEXT,
    metadata_json TEXT,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Indices for fast querying
CREATE INDEX IF NOT EXISTS idx_seller_comm_opp ON seller_communications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_seller_comm_events_comm ON seller_communication_events(communication_id);

-- Immutability validation triggers
DROP TRIGGER IF EXISTS trg_prevent_comm_update;
CREATE TRIGGER trg_prevent_comm_update
BEFORE UPDATE ON seller_communications
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_communications is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_comm_delete;
CREATE TRIGGER trg_prevent_comm_delete
BEFORE DELETE ON seller_communications
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_communications is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_comm_event_update;
CREATE TRIGGER trg_prevent_comm_event_update
BEFORE UPDATE ON seller_communication_events
BEGIN
    SELECT RAISE(FAIL, 'Updating seller_communication_events is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_comm_event_delete;
CREATE TRIGGER trg_prevent_comm_event_delete
BEFORE DELETE ON seller_communication_events
BEGIN
    SELECT RAISE(FAIL, 'Deleting seller_communication_events is prohibited.');
END;
