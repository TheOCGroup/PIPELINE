-- Migration 007: Provenance and Classification Tables
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

-- 1. Source Provenance Table
CREATE TABLE IF NOT EXISTS source_provenance (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    original_source_json TEXT NOT NULL,
    recovered_source_json TEXT,
    resolution_status TEXT NOT NULL DEFAULT 'unresolved' CHECK (resolution_status IN ('unresolved', 'original_resolved', 'recovered_resolved', 'manually_resolved')),
    recovery_attempts INTEGER NOT NULL DEFAULT 0,
    last_recovery_error TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unq_opp_provenance ON source_provenance(opportunity_id);

-- 2. Recovery Metadata Table
CREATE TABLE IF NOT EXISTS recovery_metadata (
    id TEXT PRIMARY KEY,
    run_timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    records_scanned INTEGER NOT NULL,
    records_recovered INTEGER NOT NULL,
    records_failed INTEGER NOT NULL,
    error_summary TEXT,
    run_by_actor TEXT NOT NULL
);

-- 3. Record Classifications Table
CREATE TABLE IF NOT EXISTS record_classifications (
    opportunity_id TEXT PRIMARY KEY REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    classification_value TEXT NOT NULL CHECK (classification_value IN ('retail_listing', 'wholesale_target', 'investment_rehab', 'land_hold', 'disqualified', 'unknown')),
    classification_rules_version TEXT NOT NULL,
    determined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    determined_by TEXT NOT NULL,
    reason TEXT NOT NULL
);

-- 4. Classification History Table (Append-Only)
CREATE TABLE IF NOT EXISTS classification_history (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    prior_classification TEXT,
    new_classification TEXT NOT NULL CHECK (new_classification IN ('retail_listing', 'wholesale_target', 'investment_rehab', 'land_hold', 'disqualified', 'unknown')),
    classification_rules_version TEXT NOT NULL,
    determined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    determined_by TEXT NOT NULL,
    reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_class_hist_opp ON classification_history(opportunity_id);

-- 5. Immutability Protections for Provenance & Classification History
DROP TRIGGER IF EXISTS trg_prevent_provenance_delete;
CREATE TRIGGER trg_prevent_provenance_delete
BEFORE DELETE ON source_provenance
BEGIN
    SELECT RAISE(FAIL, 'Deleting source_provenance is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_classification_history_update;
CREATE TRIGGER trg_prevent_classification_history_update
BEFORE UPDATE ON classification_history
BEGIN
    SELECT RAISE(FAIL, 'Updating classification_history is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_classification_history_delete;
CREATE TRIGGER trg_prevent_classification_history_delete
BEFORE DELETE ON classification_history
BEGIN
    SELECT RAISE(FAIL, 'Deleting classification_history is prohibited.');
END;
