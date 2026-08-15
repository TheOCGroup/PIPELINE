-- Migration 003: Standalone Seller Opportunities Schema
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Standalone Seller Opportunities Table
CREATE TABLE IF NOT EXISTS seller_opportunities (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'ocg-one',
    opportunity_code TEXT NOT NULL UNIQUE,
    ocg_one_property_id TEXT NOT NULL, -- External property reference without FK
    
    -- Status Dimensions
    pipeline_stage TEXT NOT NULL DEFAULT 'new_lead' CHECK (pipeline_stage IN (
        'new_lead', 'needs_review', 'attempting_contact', 'contacted', 'qualified',
        'appointment_scheduled', 'property_review', 'strategy_development', 'offer_preparation',
        'offer_approval_required', 'offer_presented', 'negotiating', 'under_contract',
        'due_diligence', 'closing_scheduled', 'closed', 'nurture', 'disqualified', 'lost', 'archived'
    )),
    qualification_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (qualification_status IN (
        'unqualified_lead', 'needs_review', 'prospect', 'qualified', 'high_equity_target', 'disqualified'
    )),
    contact_status TEXT NOT NULL DEFAULT 'uncontacted' CHECK (contact_status IN (
        'uncontacted', 'contact_attempted', 'in_contact', 'consultation_completed', 'nurture_periodic', 'unresponsive'
    )),
    opportunity_status TEXT NOT NULL DEFAULT 'active' CHECK (opportunity_status IN (
        'active', 'on_hold', 'pending_approval', 'under_contract', 'closed_purchased', 'closed_disqualified', 'closed_lost', 'archived'
    )),
    data_quality_status TEXT NOT NULL DEFAULT 'raw_ingestion' CHECK (data_quality_status IN (
        'raw_ingestion', 'partial_ingestion', 'verified_address', 'enriched_property', 'verified_owner', 'full_audit'
    )),
    
    -- Seller Motivation & Target Terms
    seller_motivation_type TEXT,
    seller_motivation_score INTEGER CHECK (seller_motivation_score BETWEEN 1 AND 10),
    timeline_urgency TEXT,
    asking_price REAL,
    seller_expected_price REAL,
    desired_closing_date TEXT,
    occupancy_status TEXT,
    property_condition_summary TEXT,
    target_purchase_price REAL,
    max_authorized_offer REAL,
    
    -- Underwriting Snapshots (Victor / Deal Scout refs)
    underwriting_source_type TEXT,
    underwriting_source_id TEXT,
    underwriting_version_id TEXT,
    underwriting_arv_snapshot REAL,
    underwriting_rehab_snapshot REAL,
    underwriting_mao_snapshot REAL,
    underwriting_confidence REAL,
    underwriting_limitations TEXT,
    underwriting_timestamp TEXT,
    
    -- Assignment (External OCG ONE person IDs, no FK constraints)
    assigned_acquisition_manager_id TEXT,
    assigned_underwriter_id TEXT,
    
    -- Stage Timestamps
    first_contacted_at TEXT,
    last_contacted_at TEXT,
    next_scheduled_contact_at TEXT,
    underwriting_completed_at TEXT,
    offer_approved_at TEXT,
    offer_presented_at TEXT,
    contract_executed_at TEXT,
    scheduled_closing_at TEXT,
    closed_at TEXT,
    archived_at TEXT,
    created_by TEXT NOT NULL,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Partial Unique Index: 1 Active Opportunity per Property
CREATE UNIQUE INDEX IF NOT EXISTS idx_unq_active_property_opp 
ON seller_opportunities(ocg_one_property_id) 
WHERE opportunity_status NOT IN ('closed_purchased', 'closed_disqualified', 'closed_lost', 'archived');

-- 2. Standalone Seller Opportunity Participants Table
CREATE TABLE IF NOT EXISTS seller_opportunity_participants (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    ocg_one_person_id TEXT NOT NULL, -- External person reference without FK
    participant_role TEXT NOT NULL CHECK (participant_role IN (
        'primary_owner', 'co_owner', 'spouse', 'trustee', 'heir', 'power_of_attorney',
        'wholesaler_agent', 'attorney_advisor', 'decision_maker', 'other'
    )),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    decision_authority_status TEXT NOT NULL DEFAULT 'full_authority' CHECK (decision_authority_status IN (
        'full_authority', 'shared_authority', 'consultative_only', 'unverified'
    )),
    ownership_percentage REAL,
    source_id TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Partial Unique Index: 1 Primary Owner per Opportunity
CREATE UNIQUE INDEX IF NOT EXISTS idx_unq_primary_participant 
ON seller_opportunity_participants(opportunity_id) 
WHERE is_primary = 1;

-- 3. Standalone Source Attribution Model
CREATE TABLE IF NOT EXISTS seller_opportunity_sources (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'property_lead_inbox', 'gmail_digest', 'website_form', 'manual_entry',
        'referral', 'deal_scout_handoff', 'legacy_seller_record'
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
