# Phase 3G — deferred decisions

Known, accepted debt carried into production by the
`recovery/pipeline-source-2026-08-15` release. None of these block deployment.
Each needs a product decision before Phase 3G work starts.

---

## 0. P1 — the Classifications screen shows fabricated data

**Found during release verification on 2026-08-15. Pre-existing; not introduced
by the intake security patch. Not fixed here, because the correct fix needs a
schema decision.** Do not present the Classifications screen as authoritative
until this is resolved.

`SqliteClassificationRepository` in `src/repositories/sqlite/sqliteRepositories.js`
does not read the tables it appears to.

**`listAll()`** hardcodes lineage classification by fixture id:

```js
let classification = "REAL";
if (r.opportunityId === "FX-OPP-0004") classification = "SYNTHETIC";
else if (r.opportunityId === "FX-OPP-0003") classification = "AMBIGUOUS";
```

Every record that is not one of those two demo fixtures is therefore reported
**REAL** — including records whose provenance is `unresolved`. Verified live: an
intake record with UNRESOLVED provenance displays as REAL.

That is the inverse of the invariant this product exists to enforce. The domain
model is explicit — `classifyByLineage()` in
`src/domain/classifications/classificationModel.js` returns AMBIGUOUS for
unknown or absent lineage, commented "unknown / absent lineage is never silently
promoted" — and the repository silently promotes.

**`listHistory()`** does not read `classification_history` at all. It selects
`DEAL_FINDR_INTAKE` and `DEAL_FINDR_DUPLICATE_RECONCILED` rows out of
`operational_audit_events` and synthesizes each entry with a constant
`priorClassification: "NONE"`, `newClassification: "REAL"`, and
`reason: "Ingested via Deal Findr Webhook"`. Consequences, all verified against a
live database:

- the append-only history that migration 007 protects with triggers is never
  displayed, while the screen claims to be showing it;
- a duplicate address that was *reconciled* — explicitly not a classification
  event — appears as a classification event. One opportunity with a single real
  history row rendered as three;
- with 2 rows in `classification_history`, `/api/v1/classifications` returned 8;
- SYNTHETIC and AMBIGUOUS records both display a REAL history entry.

**Why it is not fixed in this release.** There is no lineage column to read.
`record_classifications.classification_value` holds a deal-type value
(`investment_rehab`), not a REAL/SYNTHETIC/AMBIGUOUS lineage determination, which
is why someone hardcoded the mapping in the first place. Fixing it properly means
deciding where lineage classification is stored — a new column and migration, or
a documented derivation from `source_provenance.resolution_status` — and then
routing both methods through the existing, already-tested domain functions the
way `src/repositories/fixture/fixtureClassificationReadRepository.js` does.

That is a schema and product decision, not a repair. Guessing the mapping in a
release commit would ship a different wrong answer with more confidence.

**Scope of impact.** Read-only display defect. It does not affect intake writes,
authorization, provenance, data quality, or the opportunity views, all of which
read their real tables. Production ships `readOnly = true` and no intake by
default, so a fresh deployment shows only seeded fixtures until cutover.

---

## 1. Operator input is browser-local and invisible to the server

**Status:** accepted for this release. Do not treat operator input as saved data.

The underwriting analyzer, acquisitions checklist, seller call log, and the stage
selector on the opportunity detail view all write to `localStorage` through
`getOverrides` / `setOverride` in `public/app.js`. Consequences today:

- input exists in exactly one browser profile and never reaches the server;
- teammates cannot see it, and it is absent from every API response;
- clearing site data destroys it with no recovery path and no audit trail;
- a locally overridden stage silently outranks the server's stage in the
  opportunities list and in the Overview funnel counts, so two operators can see
  different pipeline totals for the same database.

That last point is the sharp edge: the counts on Overview are not purely a
function of server state.

Interim disclosures are rendered in the three operator panels so the behaviour is
visible to whoever is using it. **Disclosure is not a fix.**

**The decision to make.** Either give operator input a real persistence path or
remove it. Persistence is not a small change — it means mutation endpoints on an
API that is deliberately GET/HEAD-only, new migrations, an authorization model
for who may move a stage, and an audit trail consistent with the append-only
guarantees migration 007 already enforces for classification history. Choosing
persistence effectively ends "PIPELINE is a read-only projection", which is a
product decision, not a refactor.

Until then the honest framing is: PIPELINE reads authoritative state, and the
scratchpad is a private notepad drawn on top of it.

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

## 4. Two documents disagree about who owns lead intake

`docs/architecture-boundary.md` routes intake through OCG ONE as the canonical
lead layer. `src/http/routes/dealFindrIntake.js` writes directly into PIPELINE's
own tables. Both statements are currently true in the repository and they cannot
both be the contract.

Someone with the product context needs to pick one and correct the other. This
has no runtime effect today; it is a correctness problem in the documentation
that will mislead the next integrator.
