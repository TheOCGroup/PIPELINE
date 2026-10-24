# HUNTER → VICTOR → PIPER — Workflow and Data Contracts

Companion to `docs/ocg-os-architecture.md`. Every claim below maps to code or a
migration in this repository as of main `8ff2bb5` (verified 2026-10-24,
217/217 tests passing). Anything not implemented is labelled NOT IMPLEMENTED.

## 1. HUNTER — discovery and intake

**Input record (property lead):** address (required), APN, asking price,
seller name / phone / email, `sourceRecordId`, source message id, source
timestamp, classification + reason.
Route: `POST /api/integrations/deal-findr/intake`
(`src/http/routes/dealFindrIntake.js`), Bearer-secret authenticated, fail-closed
when unconfigured, 512 KB body limit.

Historical naming note: the intake actor string in code is `deal-findr` and the
source type is `deal_finder_intake`. Under the 2026-10-24 correction that actor
IS HUNTER. Renaming the wire strings is a separate, QUINCEY-reviewed change —
existing records and dedupe keys depend on the current values, so they are
**not** renamed here.

**Deduplication (IMPLEMENTED), in order:** `sourceRecordId` → APN → normalised
address. A duplicate never creates a second opportunity; it reconciles onto the
existing record and writes a `DEAL_FINDR_DUPLICATE_RECONCILED` audit event.

**Output:** one `seller_opportunities` row (stage `new_lead`), one
`seller_opportunity_sources` row with source type `deal_finder_intake` (or
`manual_entry` for founder-entered records), provenance + classification rows,
and an operational audit event. Seller contact details are persisted only via
`sellerContactService` and linked as participants.

## 2. VICTOR — underwriting handoff

**Input package:** `packageId`, timestamp, property (id, address, asking
price, exit strategy), underwriting (purchase price, ARV, renovation budget,
MAO, confidence, limitations, scenarios, hold/DSCR evidence), market evidence
(comps).

**Storage contract (IMPLEMENTED):** PIPELINE stores a snapshot in
`opportunity_underwriting_refs` (migration 012): `source_system`,
`source_agent = 'Victor'`, source project / underwriting / version ids,
`analysis_status`, `arv`, `rehab`, `mao`, `confidence`, `limitations`,
`evidence_summary_json` (comps, recommendation, scenarios, hold/DSCR),
`analyzed_at`. A VICTOR package arriving for an existing HUNTER lead attaches
to that lead — verified by `tests/victor-underwriting-intake.test.mjs`
(Hunter lead + Victor package → one opportunity, no duplicate).

**Rules:**
- PIPELINE **snapshots, never computes** ARV / rehab / MAO / DSCR.
- Offer versions must cite their underwriting source:
  `victor_analysis` | `deal_scout_project` | `operator_assumption`
  (migration 025). An operator's working estimate is labelled
  `operator_assumption`, never VICTOR.
- Missing evidence ⇒ `analysis_status = 'insufficient_evidence'`, not a
  fabricated figure.
- Unverified property information and founder-supplied figures stay labelled
  with their source and confidence at every surface.

## 3. PIPER — CRM operation

PIPER operates the opportunity inside PIPELINE only. Canonical stages (20,
`src/domain/stages/stageModel.js`):

`new_lead, needs_review, attempting_contact, contacted, qualified,
appointment_scheduled, property_review, strategy_development,
offer_preparation, offer_approval_required, offer_presented, negotiating,
under_contract, due_diligence, closing_scheduled, closed, nurture,
disqualified, lost, archived`

(The founder-facing shell presents a simplified 8-stage strip; the canonical
20-stage model underneath is unchanged.)

**Records PIPER owns:**
- Seller record: participants / contacts linked to the opportunity.
- Communication history: `seller_communications` + lifecycle events —
  immutable, trigger-enforced (migration 013).
- Offer history: `seller_offer_versions` — immutable versions, each citing its
  underwriting source; approval passes the server-side Investment Committee
  gate (migration 014) — an offer cannot be approved without committee
  clearance.
- Tasks and follow-ups: next actions (operator state), transaction tasks with
  phase governance (017/020), Work Room tasks (023). PIPER's
  `create_next_action` tool proposes; the operator approves.
- Follow-up history: communication events + stage events + audit events,
  aggregated by the seller timeline.

**PIPER tool governance (IMPLEMENTED, `src/services/piper/toolRegistry.js`):**
read tools (`get_operating_brief`, `find_opportunities`, `get_opportunity`,
`get_outreach_state`) execute immediately; write tools (`create_next_action`,
`add_note`, `log_interaction`, `prepare_offer`, `modify_offer`,
`prepare_outreach_draft`) are recorded as proposals and execute **only after
operator approval**, through the same repository path the UI uses.
Production currently reports `piperProvider: "none"` — PIPER is LIMITED and
must be described that way until a provider is connected and verified.

## 4. Provenance, audit, isolation invariants

1. Every record carries its source type and source record id; provenance
   state (`original` / `recovered` / `unresolved`) is never silently upgraded —
   unresolved is not a synthetic determination.
2. Every mutation writes an operational audit event with actor and
   correlation id.
3. Communications, offer versions, classification history, and task events
   are append-only / immutable.
4. `tenant_id` is stored on every opportunity (default `ocg-one`); tenant
   **filtering** on reads is NOT IMPLEMENTED (see architecture doc) and must
   land, with isolation tests, before any second tenant is onboarded.
