# Governed Integration APIs — Separate Products ↔ OCG OS

Companion to `docs/ocg-os-architecture.md`. OCG OS (HUNTER / VICTOR / PIPER on
PIPELINE) integrates with separate products **only** through the contracts
below. No codebase is merged, no database is shared, and no system opens
another system's database. Status labels are exact: IMPLEMENTED / PARTIAL /
DEFINED, NOT IMPLEMENTED.

## Rules that apply to every integration

1. Versioned routes (`/api/v1/…` or `/api/integrations/<system>/…`).
2. Authenticated on every non-public route; secrets ≥ 32 chars, compared in
   constant time, fail-closed when unconfigured.
3. Idempotency / dedupe keys on every mutation (source record id, package id,
   or explicit idempotency key).
4. Correlation id on every request; the owning system keeps its own audit
   trail.
5. Foreign records are referenced by id with a system qualifier — never copied
   as a second authoritative record.
6. Payload limits, explicit schemas, bounded retries; a failed integration
   degrades honestly (status shown, last verified state preserved) and never
   fabricates the other system's state.
7. Financial / property payloads carry source, confidence, and limitations;
   unverified values stay labelled end-to-end.

## 1. Deal Scout (server) → PIPELINE — IMPLEMENTED

- `POST /api/integrations/deal-findr/intake` — HUNTER lead intake and VICTOR
  underwriting package handoff (`deal_scout_handoff` provenance), dedupe by
  sourceRecordId → APN → normalised address. This is the live contract the
  HUNTER → VICTOR → PIPER workflow runs on.
- Deal Scout remains a separate system (Cloud Run, GCP). PIPELINE snapshots
  its underwriting; it does not embed Deal Scout code.

## 2. Deal Scout Mobile / Hunter Drive (Aiden Mobile) → OCG OS — DEFINED, NOT IMPLEMENTED

The mobile slice is a separate system (Aiden Mobile, local-only Hunter Drive
work at time of writing). It must integrate as a **client of the HUNTER
intake**, not as a PIPELINE module:

- Submit discovered properties to the same intake contract (§1), with a
  stable per-device `sourceRecordId` and provenance metadata (APN, capture
  method, GPS-vs-typed-address flag). The intake assigns the source type
  (`deal_finder_intake`) **server-side**; clients do not set it — this item
  describes the record the server will create, not a payload field.
- Mobile never writes to the PIPELINE database, never receives the operator
  secret, and uses a dedicated, revocable intake credential scoped to intake
  only.
- Address-resolution failures must surface as UNRESOLVED on the device —
  never a silent substitution of a different property.
- No mobile code is added to this repository, and no PIPELINE code is added
  to the mobile repository, under this contract.

Implementation gate: founder approval of the mobile credential model +
QUINCEY review of the intake change, then an end-to-end device → intake →
PIPER test.

## 3. Agent Workspace (TheOCGroup/chatbot) → OCG OS — PARTIAL

- Work Room contract (IMPLEMENTED): OCG OS / Agent Workspace jobs are visible
  through the governed Work Room lifecycle (`agent_work_tasks` /
  `agent_work_events`, migration 023) with persistent history — verified by
  `tests/work-room-http-acceptance.test.mjs` ("real OCG OS job is visible
  through governed Work Room lifecycle").
- Identity handoff (PARTIAL): signed handoff token → PIPELINE-owned session
  (`src/auth/handoffTokenVerifier.js`) exists as interface + fail-closed
  behaviour; a live Agent Workspace → PIPELINE SSO trust is **not** claimed
  until it is configured and verified end-to-end.
- Agent Workspace stays a separate system: it may read PIPELINE status
  through authenticated PIPELINE APIs and submit Work Room jobs; it does not
  receive PIPELINE's database, operator secret, or CRM logic, and PIPELINE
  does not absorb Agent Workspace / CHIEF code.

## 4. ONCALL / Aiden call intake → PIPELINE — IMPLEMENTED (separate product)

- Aiden call records arrive through the token-authenticated call-integration
  route (`src/http/routes/aidenCallIntegration.js`, constant-time Bearer,
  fail-closed). ONCALL OS and the OCG Receptionist remain separate products;
  this is a data intake contract only, not a module merge.

## Change control

Any new integration, credential, or route under this document requires:
tests in this repository, an audit-trail entry design, and independent
QUINCEY certification before production use. No production deployment without
founder approval and release gates.
