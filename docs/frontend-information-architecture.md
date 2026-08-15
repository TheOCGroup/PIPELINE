# Frontend Information Architecture — Phase 3D

This document specifies the routing structure and client-side view states of the standalone PIPELINE SPA frontend.

## Navigation Layout

The application navigation bar contains links corresponding to the following views:
- **Overview** (`/`)
- **Opportunities** (`/opportunities`)
- **Provenance** (`/provenance`)
- **Classifications** (`/classifications`)
- **Data Quality** (`/data-quality`)
- **System** (`/system`)

---

## Route Mappings

### 1. Overview (`/` or `/index.html`)
- Displays:
  - Identity headers, standalone mode, and version status.
  - Core data quality metrics cards (Total Opportunities, Original Provenance, Recovered Provenance, Unresolved Provenance, Classification Coverage, Stale).
  - Clear **DEMO DATA** disclosure box if the environment confirms fixture loading is active.

### 2. Opportunities (`/opportunities`)
- Displays:
  - Searchable and filterable table of opportunities.
  - Interactive filter dropdowns:
    - **Stage**: Supports the 20 canonical stages.
    - **Provenance State**: `original`, `recovered`, `unresolved`.
    - **Classification**: `REAL`, `SYNTHETIC`, `AMBIGUOUS`.
    - **Status**: `active`, `closed`.
  - Paged items list (25 per page by default) with `Prev` and `Next` buttons.

### 3. Opportunity Detail (`/opportunities/:id`)
- Displays:
  - Header with seller name, classification badge, provenance state, and status.
  - Key-value detail panel containing property address, external refs, and last activity.
  - Provenance resolution panel detailing message IDs, recovery methods, and confidence levels.
  - List of participants, stage timeline, offer versions, and outcome summary.
  - Placeholder markers for OCG ONE integration links.

### 4. Provenance (`/provenance`)
- Displays:
  - Summary count.
  - Table mapping each opportunity ID to its original/recovered message IDs, recovery methods, and confidence states.

### 5. Classifications (`/classifications`)
- Displays:
  - Current classifications table.
  - Deterministic reason descriptions (lineage verification vs unresolved states).
  - History log listing prior and new classifications, reason context, and change timestamp.

### 6. Data Quality (`/data-quality`)
- Displays:
  - Privacy warning (confirming no contact details are exposed).
  - Aggregated cards of data violations (missing references, unreachable leads, stale records).

### 7. System (`/system`)
- Displays:
  - App metadata (name, version, schema version, runtime mode, data source, database, integration, and API contract version).
  - Strictly conceals secrets, token values, or system filesystem paths.
