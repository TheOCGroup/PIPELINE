-- Migration 012: Opportunity Underwriting References
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION

CREATE TABLE opportunity_underwriting_refs (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE CASCADE,
    source_system TEXT NOT NULL DEFAULT 'deal-scout',
    source_agent TEXT NOT NULL DEFAULT 'Victor',
    source_project_id TEXT,
    source_underwriting_id TEXT,
    source_version_id TEXT,
    analysis_status TEXT NOT NULL DEFAULT 'completed',
    arv REAL,
    rehab REAL,
    mao REAL,
    confidence REAL,
    limitations TEXT,
    evidence_summary_json TEXT,
    analyzed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_underwriting_refs_opportunity_id ON opportunity_underwriting_refs(opportunity_id);
