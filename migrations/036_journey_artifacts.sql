-- Migration 036: Durable journey artifacts (Issue #8 seller-to-deal journey)
-- System: PIPELINE
-- Status: EXECUTABLE MIGRATION
--
-- The journey's brief and recommendation legs existed only as ephemeral
-- derivations: the per-seller brief was a Piper chat tool result (gone when
-- the conversation ended) and the "recommended action" was either the
-- committee's decision record or a section of the portfolio brief — neither
-- was a stored, citable, per-opportunity artifact. This migration gives
-- both a durable store:
--
--   seller_briefs            One row per GENERATED per-seller brief. The
--                            brief document is stored verbatim (brief_json)
--                            at generation time, so a brief an operator or
--                            the committee cites reads back byte-identically
--                            forever — it is a stored artifact, never a
--                            recomputation against later state.
--                            provenance_json records what the brief was
--                            generated FROM (seller contact id, source row
--                            ids, the underwriting reference id, the
--                            committee review id, and record counts) so
--                            every figure in the document can be traced to
--                            the stored rows that produced it.
--
--   journey_recommendations  One row per RECORDED journey-level
--                            recommendation for an opportunity. A record is
--                            a transcription of real decision state, never
--                            new decision logic: basis_type names where the
--                            recommendation came from —
--                              'committee_review'      the investment
--                                committee's persisted decision (the
--                                recommendation restates that decision; a
--                                hold stays a hold, a kill stays a kill —
--                                recording can never upgrade it), or
--                              'brief_next_derivation' the operating
--                                brief's NEXT derivation (briefModel
--                                recommendActions over the context
--                                snapshot), with the derived item stored in
--                                basis_json.
--                            basis_ref_id names the committee review row
--                            when basis_type is 'committee_review'.
--
-- Both tables are tenant-owned: tenant_id is stamped from deployment
-- configuration at write time, never taken from a request, and every read
-- filters on it — a foreign artifact id behaves exactly like a
-- nonexistent one. Nothing here is an estimate: figures inside brief_json
-- trace to stored columns/snapshots and carry the recorded / estimated /
-- unknown basis labels of the Piper figure taxonomy; absent figures are
-- stored as null with basis 'unknown'.

CREATE TABLE IF NOT EXISTS seller_briefs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    brief_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    generated_by TEXT,
    generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_seller_briefs_tenant_opp
    ON seller_briefs(tenant_id, opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS journey_recommendations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    opportunity_id TEXT NOT NULL REFERENCES seller_opportunities(id) ON DELETE RESTRICT,
    action_label TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    rationale TEXT,
    basis_type TEXT NOT NULL CHECK (basis_type IN ('committee_review', 'brief_next_derivation')),
    basis_ref_id TEXT,
    basis_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_journey_recommendations_tenant_opp
    ON journey_recommendations(tenant_id, opportunity_id, created_at);
