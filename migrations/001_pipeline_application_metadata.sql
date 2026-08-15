-- Migration 001: PIPELINE application metadata (shell only)
-- Phase 3C establishes the migration framework, NOT the production schema.
-- This migration creates only shell-level metadata. It intentionally creates NO
-- seller, provenance, classification, offer, property, people, or lead tables.
-- The runner wraps this file in a transaction and rolls back on failure.

CREATE TABLE IF NOT EXISTS pipeline_application_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO pipeline_application_metadata (key, value) VALUES ('application', 'pipeline');
INSERT OR IGNORE INTO pipeline_application_metadata (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO pipeline_application_metadata (key, value) VALUES ('shell_phase', '3C');
