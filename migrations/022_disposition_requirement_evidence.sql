-- Migration 022: Evidence-backed disposition requirements
-- Each approved sell/hold/refinance requirement must be verified before completion.

CREATE TABLE disposition_requirement_evidence (
    id TEXT PRIMARY KEY,
    disposition_plan_id TEXT NOT NULL REFERENCES disposition_plans(id) ON DELETE RESTRICT,
    requirement_key TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    note TEXT,
    verified_by TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(disposition_plan_id, requirement_key)
);

CREATE TRIGGER disposition_requirement_evidence_immutable_update
BEFORE UPDATE ON disposition_requirement_evidence
BEGIN
    SELECT RAISE(ABORT, 'disposition_requirement_evidence_immutable');
END;

CREATE TRIGGER disposition_requirement_evidence_immutable_delete
BEFORE DELETE ON disposition_requirement_evidence
BEGIN
    SELECT RAISE(ABORT, 'disposition_requirement_evidence_immutable');
END;

CREATE INDEX idx_disposition_requirement_evidence_plan
ON disposition_requirement_evidence(disposition_plan_id, requirement_key);
