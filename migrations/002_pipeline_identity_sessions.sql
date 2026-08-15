-- Migration 002: PIPELINE identity and session storage
-- Phase 3E authenticated integration contracts schema.
-- Creates tables for nonce replay protection, session state, and audit logs.
-- This migration is idempotent, transactional, and rollback-safe.

CREATE TABLE IF NOT EXISTS pipeline_handoff_nonces (
  jti TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, jti)
);

CREATE TABLE IF NOT EXISTS pipeline_sessions (
  id TEXT PRIMARY KEY,
  external_user_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  csrf_token_hash TEXT,
  csrf_issued_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_auth_audit (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  session_id TEXT,
  jti_hash TEXT,
  issuer TEXT NOT NULL,
  correlation_id TEXT,
  result TEXT NOT NULL,
  reason_code TEXT,
  created_at TEXT NOT NULL
);
