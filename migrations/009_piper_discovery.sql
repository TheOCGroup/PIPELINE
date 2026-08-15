-- Migration 009: PIPER proactive discovery registry, runs, findings, and recommendations.

CREATE TABLE IF NOT EXISTS piper_discovery_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    source_format TEXT NOT NULL CHECK (source_format IN ('json', 'jsonld', 'rss')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    respect_robots INTEGER NOT NULL DEFAULT 1 CHECK (respect_robots IN (0, 1)),
    configuration_json TEXT NOT NULL DEFAULT '{}',
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_piper_source_url ON piper_discovery_sources(base_url);

CREATE TABLE IF NOT EXISTS piper_discovery_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES piper_discovery_sources(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'blocked_by_robots')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    records_found INTEGER NOT NULL DEFAULT 0,
    records_created INTEGER NOT NULL DEFAULT 0,
    records_reconciled INTEGER NOT NULL DEFAULT 0,
    records_failed INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_piper_runs_source_started ON piper_discovery_runs(source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS piper_discovery_items (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES piper_discovery_sources(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES piper_discovery_runs(id) ON DELETE RESTRICT,
    external_id TEXT NOT NULL,
    source_url TEXT,
    normalized_address TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    raw_payload_json TEXT NOT NULL,
    piper_score INTEGER NOT NULL CHECK (piper_score BETWEEN 0 AND 100),
    score_reasons_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('new', 'reconciled', 'rejected', 'failed')),
    opportunity_id TEXT REFERENCES seller_opportunities(id) ON DELETE SET NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CONSTRAINT unq_piper_source_external UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_piper_items_score ON piper_discovery_items(piper_score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_piper_items_opportunity ON piper_discovery_items(opportunity_id);

CREATE TABLE IF NOT EXISTS piper_recommendations (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('review_now', 'verify_owner', 'request_underwriting', 'contact_seller', 'monitor', 'reject')),
    priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    summary TEXT NOT NULL,
    rationale_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'completed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_piper_recommendations_open ON piper_recommendations(status, priority, created_at DESC);

DROP TRIGGER IF EXISTS trg_prevent_piper_runs_delete;
CREATE TRIGGER trg_prevent_piper_runs_delete
BEFORE DELETE ON piper_discovery_runs
BEGIN
    SELECT RAISE(FAIL, 'Deleting piper_discovery_runs is prohibited.');
END;

DROP TRIGGER IF EXISTS trg_prevent_piper_items_delete;
CREATE TRIGGER trg_prevent_piper_items_delete
BEFORE DELETE ON piper_discovery_items
BEGIN
    SELECT RAISE(FAIL, 'Deleting piper_discovery_items is prohibited.');
END;
