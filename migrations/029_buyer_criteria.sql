-- Migration 029: Buyer criteria registry (Issue #8 seller-to-deal journey)
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION
--
-- The journey's "client criteria intake" leg had no store: PIPELINE held
-- seller opportunities but nothing describing what a buyer is looking for,
-- so candidates could not be ranked against criteria. This table is that
-- registry. One row is one buyer's stated criteria, owned by exactly one
-- tenant (tenant_id is stamped from deployment configuration at write time,
-- never taken from a request).
--
-- Criteria semantics — recorded values only, NULL means "no bound stated":
--   markets_json          JSON array of market strings (matched case-
--                         insensitively against the recorded property
--                         address). Empty array = any market.
--   property_types_json   JSON array of property-type strings. Empty array
--                         = any type. Candidates carry no recorded property
--                         type in this system, so a non-empty value makes
--                         every candidate unrankable on that criterion
--                         ("property type not recorded") rather than guessed.
--   min_price / max_price Price band applied to the recorded asking price.
--   min_mao_headroom      Minimum recorded headroom (VICTOR mao minus
--                         asking price) a candidate must show.
--   criteria_json         Extension object for additional minimums. The
--                         ranking service currently honours
--                         { "minConfidence": <number> } against the newest
--                         underwriting reference's recorded confidence.
--
-- Nothing in this table is an estimate: every bound is a value the buyer
-- (via the operator) actually stated, and ranking never invents the
-- candidate-side figures these bounds are compared against.

CREATE TABLE IF NOT EXISTS buyer_criteria (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    label TEXT NOT NULL,
    markets_json TEXT NOT NULL DEFAULT '[]',
    property_types_json TEXT NOT NULL DEFAULT '[]',
    min_price REAL,
    max_price REAL,
    min_mao_headroom REAL,
    criteria_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_buyer_criteria_tenant ON buyer_criteria(tenant_id, status);
