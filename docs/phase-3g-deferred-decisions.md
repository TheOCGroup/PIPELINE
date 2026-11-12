# Phase 3G — deferred decisions

Known, accepted debt carried into production by the
`recovery/pipeline-source-2026-08-15` release. None of these block deployment.
Each needs a product decision before Phase 3G work starts.

---

## 0. Classification display — fabricated lineage verdict removed; authoritative lineage still not recorded

**Current main status (2026-11-12):** The prior fixture-id hardcoding and synthetic history described in the August finding are no longer present.

`SqliteClassificationRepository.listAll()` now returns `NOT_RECORDED` for lineage classification, reports the separate `record_classifications.classification_value` as `recordClassification`, and exposes the stored provenance resolution state separately. `listHistory()` reads the append-only `classification_history` table directly.

This is intentionally conservative. `record_classifications.classification_value` is a deal-type value (for example `investment_rehab`), while `source_provenance.resolution_status` describes whether provenance was resolved. Neither field, by itself, proves that the source lead is REAL or SYNTHETIC. An unresolved source must never be silently promoted to REAL or classified SYNTHETIC merely because evidence is absent.

**Remaining product/schema decision:** define the authoritative evidence and write path for a REAL / SYNTHETIC / AMBIGUOUS lineage determination. Until that is approved and implemented, the correct current value is `NOT_RECORDED`; do not derive a lineage verdict from provenance resolution status alone.

## 1. Operator workflow persistence — server-side routes now exist

**Current main status (2026-11-12):** The old browser-only scratchpad finding is stale for the current code.

The current UI persists workflow records through authenticated `/api/v1/operator/*` routes. The server-side repository stores notes, checklist items, seller interactions, underwriting assumptions, and related operator records. Transaction stage transitions, transaction tasks, milestones, and acquisition handoff events are persisted through `TransactionWorkflowService` and its event tables. These are not `localStorage` overrides.

`localStorage` remains in use for non-authoritative interface preferences such as fixture visibility, view mode, Piper panel state, and voice-output preference. Those preferences do not replace the server's opportunity stage or alter server-side funnel counts.

**Remaining acceptance:** exercise each persistence workflow against a populated, isolated test database and verify read-after-write, audit history, tenant scoping, and restart persistence before production cutover. The live IAP-only deployment currently has an empty database by design.

---

## 2. Intake path naming diverges from `feature/pipeline-phase-4-compat`

This release gates the existing route, `/api/integrations/deal-findr/intake`,
using the same authorization contract Phase 4 introduced —
`PIPELINE_ENABLE_PIPER_INTAKE`, `PIPELINE_PIPER_INTAKE_SECRET`, and
`authorizePiperIntake()` — so the two branches share one mechanism and one set of
environment variable names.

Phase 4 additionally serves the alias `/api/integrations/piper/intake` and
refactors the handler into `src/services/piperIntakeService.js` with listing
scores. Neither is carried here: the alias is unnecessary while Deal Findr is the
only caller, and the service refactor belongs with the rest of the Phase 4
discovery feature set.

**On merge**, Phase 4 supplies the alias and the refactor. The one genuine
conflict to resolve deliberately is the read-only gate described below — Phase 4
does not have it, and it must not be lost in a merge.

---

## 3. Read-only blocking of intake is stricter here than in Phase 4

`authorizePiperIntake()` in this branch refuses an authorized intake with
`503 read_only` when `PIPELINE_READ_ONLY=true`, mirroring the refusal
`src/http/routes/opportunitiesConvert.js` already returns. Phase 4's version does
not include this check.

This was an explicit product instruction: read-only mode blocks **all** mutations,
including intake. Because production defaults to `readOnly = true`
(`src/config/environment.js`), a production deployment accepts no intake writes
until an operator sets `PIPELINE_READ_ONLY=false` at cutover. That is intended —
it means a fresh production boot cannot be written to by accident.

Keep this check when merging Phase 4.

---

## 4. Lead intake ownership — current implementation contract

**Current main implementation:** Deal Scout submits seller-opportunity intake directly to PIPELINE through the authenticated `/api/integrations/deal-findr/intake` contract. PIPELINE owns the resulting seller-opportunity, source, provenance, and audit records. This matches `docs/governed-integration-apis.md` and the implemented intake route.

OCG ONE remains authoritative for properties, people/contacts, users/authentication identities, documents, canonical tasks/approvals, and transitional legacy `property_leads` records. PIPELINE stores OCG ONE identifiers and resolves OCG ONE-owned details through authenticated APIs; it must not open or duplicate OCG ONE's database.

The earlier statement that OCG ONE is the canonical lead-intake intermediary is superseded by the implemented Deal Scout-to-PIPELINE intake contract. Keep the ownership boundary above explicit in future integration work.
