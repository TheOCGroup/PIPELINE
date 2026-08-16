# Phase 3D Extraction Manifest

This manifest documents the extraction and adapter actions taken on committed OCG ONE logic to produce the pure, standalone, read-only PIPELINE presentation layer.

## Extracted and Reimplemented Logic

---

### 1. Classification Constants and Reason Generation
- **New PIPELINE File**: [classificationModel.js](file:///C:/Users/Genaro/Documents/OCG%20OS/apps/pipeline/src/domain/classifications/classificationModel.js)
- **Source OCG ONE File**: `src/pipeline-foundation/classificationRules.js`
- **Source Commit**: `9c59ad88445cc2ac1167624539c991f76f21156f`
- **Source Responsibility**: Define REAL, SYNTHETIC, AMBIGUOUS classification values, scoring, and rule-based explanations.
- **Action**: **Adapted / Reimplemented**. Extracted the pure ruleset behavior and translated it into a database-free logic layer.
- **Side Effects Removed**: None (source was already pure).
- **Database Dependency Removed**: None.
- **Tests Covering Behavior**: `tests/domain-logic.test.mjs` ("Domain: Lineage Beats Naming" and "Domain: Classification Reason formatting").

---

### 2. Provenance Resolution Rules
- **New PIPELINE File**: [provenanceModel.js](file:///C:/Users/Genaro/Documents/OCG%20OS/apps/pipeline/src/domain/provenance/provenanceModel.js)
- **Source OCG ONE File**: `src/pipeline-foundation/provenanceRecoveryService.js`
- **Source Commit**: `9c59ad88445cc2ac1167624539c991f76f21156f`
- **Source Responsibility**: Resolve message IDs using CLAIMS (`lead_claims_source_message`) and DIRECT (`lead_source_messages_direct`) patterns.
- **Action**: **Adapted / Reimplemented**. The pure selection logic from the OCG ONE SQL view `v_seller_opportunity_source_resolved` was mapped to a synchronous JS function.
- **Side Effects Removed**: Database queries and transactional inserts.
- **Database Dependency Removed**: SQLite lookup and transaction bounds.
- **Tests Covering Behavior**: `tests/domain-logic.test.mjs` ("Domain: Provenance Resolution priority").

---

### 3. Data Quality Calculations
- **New PIPELINE File**: [dataQualityModel.js](file:///C:/Users/Genaro/Documents/OCG%20OS/apps/pipeline/src/domain/dataQuality/dataQualityModel.js)
- **Source OCG ONE File**: `src/pipeline-foundation/dataQualityReporter.js`
- **Source Commit**: `9c59ad88445cc2ac1167624539c991f76f21156f`
- **Source Responsibility**: Check duplicates, stale records, broken provenance, and missing references.
- **Action**: **Reimplemented**. Modeled the mathematical calculations of orphans, stale items (60-day threshold), and reference coverage as pure calculations over the array of opportunities.
- **Side Effects Removed**: File system checks (attachment folder listings), direct SQLite queries.
- **Database Dependency Removed**: Replaced all `db.prepare(...).all()` lookups with JS array filters.
- **Tests Covering Behavior**: `tests/domain-logic.test.mjs` ("Domain: Stale activity data-quality calculation").

---

### 4. Stage Formatting and Ordering
- **New PIPELINE File**: [stageModel.js](file:///C:/Users/Genaro/Documents/OCG%20OS/apps/pipeline/src/domain/stages/stageModel.js)
- **Source OCG ONE File**: `src/views/seller-pipeline-view.js` and `database/migrations/044_seller_acquisition_pipeline.sql`
- **Source Commit**: `0b5606adfe29c4940b186f172b0f485fad5406c2`
- **Source Responsibility**: Constraint check lists and UI display labels for the 20 stages.
- **Action**: **Copied and Adapted**. Preserved the exact 20 canonical stages and mapped them to the presentation labels verified in OCG ONE views.
- **Side Effects Removed**: UI rendering dependencies.
- **Database Dependency Removed**: Replaced SQL CHECK constraints with array locks.
- **Tests Covering Behavior**: `tests/application-shell.test.mjs` ("static PIPELINE page loads and shows the shell identity" verifies filter elements containing these names).

---

### 5. Repository Resolution
- **New PIPELINE File**: [fixtureRepositories.js](file:///C:/Users/Genaro/Documents/OCG%20OS/apps/pipeline/src/repositories/fixture/fixtureRepositories.js)
- **Source OCG ONE File**: `src/seller-acquisition/sellerSourceService.js`
- **Source Commit**: `1ae79db7edfb8ae3282c116cc80c929dc2f66c6b`
- **Source Responsibility**: Expose additive opportunity sources via `getOpportunitySourcesResolved()`.
- **Action**: **Reimplemented**. Extracted the read models and isolated them behind clean, replaceable repositories.
- **Side Effects Removed**: Database reads, transaction control, database opens.
- **Database Dependency Removed**: Banned access to `ocg_one.db` or local SQL tables.
- **Tests Covering Behavior**: `tests/read-api.test.mjs` ("API: GET /api/v1/opportunities listing, filters, and pagination").
