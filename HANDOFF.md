# PIPELINE — UI merge handoff

Prepared in a **design environment**: no shell, no Node runtime, no test runner,
no deploy pipeline, and read-only GitHub access. Everything below was authored by
editing the recovered source directly. Nothing here has been executed, tested, or
deployed. Those steps are yours.

Recovered from `PIPELINE_FOR_CLAUDE.txt` (base64 → `.tar.xz`, 112 files, 471 KB
unpacked). The archive contained no `.env` and no `.git`, so there were no
secrets to strip; `.env.example` already holds placeholders only and is
unmodified. **Step 8 needed no action** — do not report it as work performed.

---

## What the recovered application actually is

Read this before acting on the original brief, because the two disagree.

- **Phase 3D/3E standalone shell.** Node ≥ 22.5, `node:sqlite`, one dependency
  (`jose`). No React, no Vite, no bundler. Front end is a vanilla SPA:
  `public/index.html` + `public/app.js` + `public/styles.css`.
- **The API is read-only by design.** `src/http/apiRouter.js` answers GET/HEAD
  only and returns 405 for anything else. There are no mutation endpoints. This
  is deliberate and load-bearing, not an omission.
- **The product's subject is data integrity, not deal flow.** Its core views are
  provenance lineage (`original` / `recovered` / `unresolved`) and classification
  (`REAL` / `SYNTHETIC` / `AMBIGUOUS`), with the invariant, stated in the docs
  and enforced in tests, that **unresolved provenance is not a synthetic
  determination**.
- **20 canonical stages**, mirrored from OCG ONE database constraints
  (`src/domain/stages/stageModel.js`).
- **The boundary in code is PIPELINE ↔ OCG ONE**, via signed handoff token →
  PIPELINE-owned session. Deal Scout appears as a lead originator;
  `src/http/routes/dealFindrIntake.js` is the intake route.

## Conflicts between the brief and the code — decide these

1. **The seven concept screens describe a different product.** They were designed
   from the brief before the source was recovered, and their *values* were
   invented — specific ARV/repair/MAO figures, deal scores, comparables, a 70%
   rule that appears nowhere in this repository. Those inventions are gone.
   But underwriting itself is **not** an invention: `seller_opportunities` carries
   `target_purchase_price`, `max_authorized_offer`, `underwriting_arv_snapshot`,
   `underwriting_rehab_snapshot`, `underwriting_mao_snapshot`,
   `underwriting_confidence`, `underwriting_limitations`,
   `underwriting_timestamp`; `seller_offer_versions` repeats the three snapshots
   as NOT NULL and adds `purchase_price`, `earnest_money`, `inspection_days`,
   `closing_days`, `strategy_type`; and intake accepts `arv`, `rehab`,
   `askingPrice`. The read API projects none of them and the fixtures carry no
   values, so the design now surfaces the columns in an explicit empty state with
   their Victor/Deal Scout attribution. **PIPELINE snapshots underwriting; it
   never computes it.** Any future underwriting UI must preserve that.
2. **Agent names partly match.** The brief's map is PIPELINE → Piper, Deal Finder
   → Hunter, Deal Scout → Victor, NOVA → Orion. Two of the four are real in this
   codebase:
   - **Piper** — present in the front end. Canonical assignment preserved.
   - **Victor** — present and *schema-enforced*. `migrations/005` declares
     `seller_offer_versions.underwriting_source_type TEXT NOT NULL CHECK (… IN
     ('victor_analysis','deal_scout_project'))`, so every offer version must cite
     a Victor analysis or a Deal Scout project as its underwriting source.
     `migrations/003` heads nine `underwriting_*` columns with the comment
     "Victor / Deal Scout refs", and `tests/database-schema-3f.test.mjs`
     exercises `'victor_analysis'` directly. This is the most strongly enforced
     inter-system contract in the repository.
   - **Hunter** and **Orion/NOVA** — zero occurrences anywhere in the tree. The
     intake route's actor is the literal string `deal-findr`, not Hunter.
   Note also that `docs/architecture-boundary.md` routes intake through OCG ONE
   as the canonical lead layer, while `dealFindrIntake.js` writes directly. Those
   two statements need reconciling by someone with the product context.
3. **An operator layer was bolted onto a read-only API.** The underwriting
   analyzer, acquisitions checklist, seller call log, and stage selector on the
   detail view write to `localStorage` via `getOverrides`/`setOverride`. Operator
   input therefore exists only in one browser, never reaches the server, is
   invisible to teammates, and is destroyed when site data is cleared. It also
   silently overrides the server's stage in list and overview counts. **This is
   the most serious functional issue in the recovered code.** It needs either a
   real persistence path (which means mutation endpoints, migrations, and
   authorization — a Phase 3G decision) or removal. Interim disclosures were
   added so nobody mistakes it for saved data; disclosure is not a fix.

## Changes made

### `src/http/routes/dealFindrIntake.js` — three defects repaired

This route contradicts the "read-only API" description: it is a **write path**,
inserting across `seller_opportunities`, `seller_opportunity_sources`,
`source_provenance`, `record_classifications` and `operational_audit_events` in
one transaction. Its values do check out against the schema —
`investment_rehab`, `original_resolved` and `original_address` are all valid per
migrations 003 and 007. Three real defects:

1. **The intake transaction could never commit.** The `record_classifications`
   INSERT carries one `?` placeholder but was called with two arguments
   (`opportunityId` and a timestamp). `node:sqlite` rejects surplus parameters,
   so every non-duplicate intake threw, rolled back, and returned 500. Only the
   duplicate path — which returns before the transaction — worked. Fixed to pass
   `opportunityId` alone. **Treat this as P0: it is the only write path in the
   application, and it was broken for every new record.**
2. **`classification_history` was never written.** The route set a current
   classification without recording the event, so the append-only history that
   migration 007 protects with triggers had no initial row. Added the insert
   inside the same transaction, `prior_classification NULL`.
3. **The 500 response leaked internals** via `details: err.message`, against the
   contract `apiRouter.js` holds itself to and brief §14. Removed, and the two
   `console.error` calls no longer print the raw error.

Not changed, and correct as-is: intake destructures `phone` and `email` and
persists neither. PIPELINE holds no contact details by design.

### `public/styles.css` — rewritten
The OCG visual system (inherited from `deal-finder`: Inter, slate/indigo, 28px
lattice, 900-weight tracked eyebrows, `--mono` figures) applied over the existing
markup. **Every class name in the old file is preserved** — `app.js` renders
against them and tests select them. Nav becomes a dark sidebar via CSS grid on
`body`, so no markup or router change was needed. Light-mode only: the old file
declared a dark palette plus a light `prefers-color-scheme` override, which is
two half-finished designs. Also added `.scratchpad-note` and `.timeline`.

### `public/index.html` — targeted edits
Inter/JetBrains Mono links. Piper's 🤖 emoji toggle replaced with the gradient
orb. Header/badge/placeholder copy. Quick actions changed from
Analyze / Check Provenance / **Objection Script** to Provenance state /
Unresolved records / Underwriting panel. Added a standing capability disclosure.
The hidden `PIPELINE Overview standalone` div that
`tests/application-shell.test.mjs` selects is **untouched**; all element IDs are
unchanged.

### `public/app.js` — Piper rebuilt to be honest
The recovered Piper was `setTimeout(800)` plus keyword matching over hardcoded
strings. Its provenance reply was:

> "Source verified, lineage is clean and skiptrace contact matches tax rolls."

It returned that for **any** opportunity, including `FX-OPP-0003`, whose
provenance is `unresolved` and classification `AMBIGUOUS` — asserting a
verification the system explicitly cannot make, against the one invariant the
app is built to protect. It also claimed to check contact data against tax rolls;
PIPELINE stores no contact details at all.

Replaced with deterministic reads of real state:
- provenance answers report the record's actual `provenanceState` and
  `classification`, and explain what that state means — including that
  unresolved is not synthetic;
- an "unresolved records" answer enumerates real matches from loaded data and
  scopes itself to the loaded page;
- the MAO answer states the figures are browser-only;
- **the script request is declined** — no model is connected, so generating
  negotiation copy would be fabrication.

Also: `<h2> funnel stage breakdown</h2>` → `<h2>Funnel stage breakdown</h2>`
(leading space, lowercase); localStorage save/stage alerts now say what actually
happened; scratchpad disclosures added to the three operator panels.

**Not touched:** every file under `src/`, `tests/`, `migrations/`, `deploy/`,
`docs/`, plus `server.js` and `scripts/`. No architecture, model, repository,
auth, or route change.

## Verification actually performed

Only what a design environment allows: `PIPELINE-preview.html` (in the parent
project, **not** part of this tree — never ship it) serves the real fixture set
to the real `app.js` over a stubbed `fetch`. Confirmed rendering of Overview,
Opportunities with filters, Provenance, opportunity detail, and the Piper panel,
with fixture-derived counts correct (5 total / 2 original / 2 recovered /
1 unresolved / 5-of-5 classified / 1 stale) and badge states correct on
`FX-OPP-0003` (AMBIGUOUS · UNRESOLVED · ACTIVE).

**Not verified:** the Node server, the SQLite path, migrations, auth, the handoff
route, `node --test tests/`, the production build, and deployment. No claim is
made about any of them.

## What you need to do

**Steps 3 onward cannot be done in the environment this was authored in.** No
shell, no Node runtime, no package manager, no test runner, and read-only GitHub
access. The following is therefore untested and unshipped:

1. `node --test tests/` — the 18 suites. The intake repair changes behaviour that
   `tests/opportunities-conversion.test.mjs` and `tests/mutation-safeguards.test.mjs`
   may assert against; if a test encoded the broken two-argument call or the
   absent history row, update the test to the corrected behaviour rather than
   reverting the fix.
2. `node server.js`, then walk all routes plus a detail page and a deep-link
   refresh.
3. Exercise intake with a new address and a duplicate address, and confirm a
   `classification_history` row now exists for the new one.
4. Decide the localStorage scratchpad question (conflict 3). It is the difference
   between a demo and a product.
5. Commit and push to `TheOCGroup/PIPELINE` (branch
   `recovery/pipeline-source-2026-08-15`, then promote to `main`). The repo holds
   only `.pipeline-release-seed`, so this is effectively the initial import.
   There is no `.env` in this tree, `.gitignore` already covers it, and
   `.env.example` is placeholders only — verified, nothing to strip.
6. Deploy via `deploy/production/` (Docker + Caddy). The brief's Vercel
   assumption does not fit: this is a long-running Node process with a SQLite
   volume, not a serverless target.
