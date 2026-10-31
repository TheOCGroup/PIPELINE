# OCG OS — Canonical Architecture (Correction, 2026-10-24)

**Authority:** Founder directive "OCG OS — Architecture Correction and Continued
Execution", 2026-10-24. This document supersedes any earlier description that
classified PIPELINE as outside OCG OS, or Deal Scout Mobile, Agent Workspace,
OCG MEDIA, or OCG LAB OS as modules of OCG OS. All verified prior work,
repositories, and certified functionality are preserved.

## What OCG OS is

OCG OS is the real-estate business operating system for Ocasio Collective /
The OC Group. It contains exactly three operational agents and one platform:

| Component | Role | Canonical implementation |
|---|---|---|
| **HUNTER** | Property discovery, sourcing, acquisition opportunities, lead qualification | Sourcing feeds + the Deal Finder intake contract into PIPELINE (`deal_finder_intake`). HUNTER is an agent role, not a separate codebase inside PIPELINE. |
| **VICTOR** | Underwriting, comparable sales, ARV, rehabilitation estimates, offer calculations, investment scenarios, risk evaluation | Underwriting originates in Deal Scout / VICTOR and is **snapshotted** into PIPELINE (`opportunity_underwriting_refs`, `source_agent = 'Victor'`). PIPELINE never computes underwriting. |
| **PIPER** | CRM, seller relationships, communication history, offer history, follow-ups, tasks, pipeline workflows | PIPER is the operator interface of PIPELINE (`src/services/piper/`, `src/domain/piper/`). Writes are proposals executed only after operator approval. |
| **PIPELINE** | The CRM / workflow platform operated through PIPER; belongs within OCG OS | This repository (`TheOCGroup/PIPELINE`). Own database, migrations, auth, audit trail. |

## What OCG OS is not

Separate systems — integrated only through the governed APIs in
`docs/governed-integration-apis.md`, never by merging codebases:

- Deal Scout Mobile (incl. the Hunter Drive mobile slice in Aiden Mobile)
- Agent Workspace (TheOCGroup/chatbot)
- OCG MEDIA (TheOCGroup/nova)
- OCG LAB OS
- ONCALL OS
- Aiden / My COO — belongs to **Agent Workspace** (the founder-facing Aiden
  Experience), not inside OCG OS, and is separate from PIPER

## Workflow

HUNTER → VICTOR → PIPER, defined in `docs/hunter-victor-piper-workflow.md`.
Short form:

1. HUNTER discovers and qualifies a property lead and submits it through the
   authenticated intake. PIPELINE deduplicates and creates one seller
   opportunity with honest provenance.
2. VICTOR underwrites externally; PIPELINE stores an immutable-attributed
   snapshot (ARV, rehab, MAO, confidence, limitations, evidence). It never
   recomputes those figures.
3. PIPER operates the opportunity through the 20 canonical stages: seller
   contact, communications, offers (immutable versions, committee-gated),
   tasks / next actions, follow-ups, and outcomes — every step audit-logged.

## Ownership, provenance, isolation — verified state (2026-10-24)

- **Provenance (IMPLEMENTED):** source types `deal_finder_intake`,
  `deal_scout_handoff`, `manual_entry` (migration 024); offer underwriting
  sources `victor_analysis`, `deal_scout_project`, `operator_assumption`
  (migration 025). Operator estimates are never labelled as VICTOR output.
- **Audit trail (IMPLEMENTED):** `operational_audit_events` (008),
  append-only classification history, immutable seller communications and
  communication events (013, trigger-enforced), and offer versions whose
  terms/deletion are trigger-protected once pending or approved (005 —
  state-scoped immutability, not blanket immutability).
- **Ownership controls (IMPLEMENTED):** founder-operator Bearer auth
  (fail-closed), session + CSRF on cookie writes, roles
  viewer / operator / manager / administrator (`src/auth/authorization.js`),
  PIPER write tools require operator approval before execution.
- **Tenant isolation (IMPLEMENTED — single-tenant deployment model):**
  `seller_opportunities` carries `tenant_id` (default `'ocg-one'`, migration
  003; index `idx_seller_opportunities_tenant`, migration 028). Each
  deployment serves exactly ONE tenant, configured by `PIPELINE_TENANT_ID`
  (production boot fails closed when it is unset; non-production default
  `'ocg-one'`). Opportunity, provenance, and classification root reads are
  filtered by the configured tenant; operator, investment-committee,
  transaction-workflow, seller-timeline, agent-work-room, and PIPER read
  paths assert parent-opportunity ownership before reading or mutating by
  `opportunity_id`, so an opportunity owned by another tenant behaves exactly
  like a nonexistent one on every such surface. Intake dedupe (source record,
  APN, address) matches only within the configured tenant, manual create and
  S2S conversion stamp the configured tenant, and conversion never accepts a
  tenant from the request body. This is enforcement for a single-tenant
  deployment, NOT a multi-tenant platform claim: one process serves one
  tenant, and isolation is covered by `tests/tenant-isolation.test.mjs`.
  Data note: production historically carried mixed labels (`'ocg-one'` and
  `'pipeline'`); normalizing stored rows to the canonical `'ocg-one'` is a
  separate founder-authorized data step — the code never rewrites stored
  tenant labels on its own.
- **Financial labelling (RULE):** every ARV / rehab / MAO / rent / DSCR figure
  stored in PIPELINE is a snapshot attributed to its source
  (`victor_analysis`, `deal_scout_project`, or `operator_assumption`) with its
  confidence and limitations. Unverified property information stays labelled
  as such; no figure is presented as verified fact on PIPELINE's own authority.

## Deployment and governance

- GCP is the preferred hosting platform for new deployments. Existing working
  deployments are preserved until replacements are tested and approved —
  PIPELINE production currently runs on Render (verified live 2026-10-24,
  `/health` 200, main `8ff2bb5`) and Deal Scout on Cloud Run (GCP, `/health`
  200, v2.0.0). No migration is authorised by this document.
- No Vercel. No purchased services or paid infrastructure without founder
  authorisation. No production deployment without approval and release gates,
  including independent QUINCEY certification — the builder does not
  self-certify.
- Grant-ready records: changes, tests, R&D classification, costs, failures,
  and corrective actions are recorded with each increment.
