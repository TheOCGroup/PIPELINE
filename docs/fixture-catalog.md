# Fixture Catalog — Phase 3D

This catalog details the deterministic, fictional dataset used to simulate the read-only OCG PIPELINE experience. All records are fabricated and carry prefix markers (`FX-`, `DEMO-`) to ensure complete separation from production scopes.

## Clock Initialization
- **Deterministic Test Clock**: `2026-08-01T00:00:00Z`
- **Stale Cutoff (60 days)**: `2026-06-02T00:00:00Z`

---

## Fixture Manifest and Validation Scenarios

### 1. FX-OPP-0001 (Ada Fixtureton)
- **Code**: `DEMO-OPP-0001`
- **Address**: `100 Placeholder Lane, Sampleton`
- **Stage**: `negotiating` (Active)
- **Classification**: `REAL` (derived from REAL lead classification)
- **Provenance**: `original` (`DEMO-MSG-0001` message ID already present)
- **Validates**:
  - Precedence of original message when present.
  - Basic listing fields mapping.
  - Multi-participant rendering.
  - Multi-stage event rendering.
  - Active offers handling.

### 2. FX-OPP-0002 (Ben Sampleman)
- **Code**: `DEMO-OPP-0002`
- **Address**: `200 Example Court, Sampleton`
- **Stage**: `contacted` (Active)
- **Classification**: `REAL`
- **Provenance**: `recovered` via `lead_claims_source_message` (`DEMO-MSG-0002` recovered)
- **Validates**:
  - Fallback to recovered provenance when original is absent.
  - Display of recovery method labels.
  - Single-participant layout.
  - Opportunity with no offers.

### 3. FX-OPP-0003 (Cora Demarco)
- **Code**: `DEMO-OPP-0003`
- **Address**: `300 Demo Ridge, Sampleton`
- **Stage**: `qualified` (Active)
- **Classification**: `AMBIGUOUS` (withheld classification)
- **Provenance**: `unresolved` (no original or recovered message)
- **Validates**:
  - Unresolved provenance does NOT imply synthetic (falls back to ambiguous).
  - Identification of stale opportunities (last activity `2026-05-01` is prior to cutoff `2026-06-02`).

### 4. FX-OPP-0004 (Test Synthetic Dolan)
- **Code**: `DEMO-OPP-0004` (Naming is real-looking)
- **Address**: `400 Synthetic Way, Sampleton`
- **Stage**: `lost` (Closed)
- **Classification**: `SYNTHETIC` (lead classification is synthetic)
- **Provenance**: `original` (`DEMO-MSG-0004`)
- **Validates**:
  - Lineage beats naming constraint (lead classification synthetic overrides the real-looking code).
  - Stage mapping translates to closed status.
  - Display of outcome detail reasons (`lost` and `demo outcome`).
  - Missing external property reference check.

### 5. FX-OPP-0005 (Ella Prototype)
- **Code**: `DEMO-OPP-0005`
- **Address**: `500 Prototype Blvd, Sampleton`
- **Stage**: `closed` (Closed)
- **Classification**: `REAL`
- **Provenance**: `recovered` via `lead_source_messages_direct` (`DEMO-MSG-0005`)
- **Validates**:
  - Recovery via direct lead mapping.
  - Multiple participants representation.
  - Display of accepted offers.
  - Representation of closed won outcome results.

### 6. FX-OPP-0006 (Finn Placeholder)
- **Code**: `DEMO-OPP-0006`
- **Address**: `600 Sample Street, Sampleton`
- **Stage**: `new_lead` (Active)
- **Classification**: `REAL`
- **Provenance**: `original` (`DEMO-MSG-0006`)
- **Validates**:
  - Missing external property reference detection.
  - Missing external person reference (participant contains no external ID).
