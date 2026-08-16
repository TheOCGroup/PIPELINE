# PIPELINE ↔ OCG ONE — Architecture Boundary

**Status:** Phase 3C (application shell). Architectural statement of record.

## Principles
- **PIPELINE is an independent application.** It has its own runtime, database,
  migrations, authentication, tests, versioning, and deployment lifecycle. It is
  part of the OCG ecosystem but is **not** OCG ONE and must never present itself
  as OCG ONE.
- **OCG ONE is not the PIPELINE database owner after migration.** Once extraction
  completes (Phase 3F–3J), PIPELINE owns its data in its own database.
- **Properties and people remain OCG ONE-owned.** So do users, authentication
  identities, documents, canonical tasks, canonical approvals, and (during the
  transition) existing `property_leads` records.
- **PIPELINE stores external OCG ONE identifiers, not authoritative copies.**
  PIPELINE references OCG ONE records by id and resolves details through
  authenticated OCG ONE APIs. It must not create a second authoritative copy of
  an OCG ONE-owned record.
- **PIPELINE owns the seller-opportunity lifecycle:** seller opportunities,
  participants, sources, stage events, outcomes, offers and offer versions,
  provenance recovery records, classifications and classification history,
  PIPELINE-specific audit records, permissions, runtime config, and migrations.
- **Direct cross-database access is prohibited after extraction.** Neither system
  opens the other's database; all cross-system access is via versioned,
  authenticated APIs.
- **Deal Scout → PIPELINE intake uses a controlled integration contract.** Deal
  Scout may originate/discover a lead; OCG ONE remains the canonical lead
  integration layer during the transition; PIPELINE takes ownership when a lead
  is formally converted into a seller opportunity.
- **Production migration will not occur before Phase 3G.**
- **The embedded OCG ONE PIPELINE implementation remains authoritative during
  the transition.** Phase 3C is not a production cutover.

## Ownership summary
| Domain | Owner (target) | Access by the other system |
|---|---|---|
| Properties, People/Contacts, Users, Auth identities, Documents, Canonical tasks/approvals, transitional `property_leads` | **OCG ONE** | PIPELINE reads via authenticated OCG ONE API |
| Seller opportunities / participants / sources / stage events / outcomes / offers / offer versions | **PIPELINE** | OCG ONE reads via authenticated PIPELINE API |
| Source provenance, resolved provenance, classifications + history | **PIPELINE** | OCG ONE reads via authenticated PIPELINE API |
| PIPELINE audit, permissions, runtime config, migrations | **PIPELINE** | not exposed |

## Identity model (target)
```
OCG ONE authenticated user
    → short-lived signed handoff token
    → PIPELINE token verification (src/auth/handoffTokenVerifier.js)
    → PIPELINE-owned session and authorization (src/auth/sessionService.js, authorization.js)
```
Phase 3C implements only the interfaces and fail-closed stub behavior — no live
secrets, no production token trust.

## Authorization model (target)
Roles: `viewer`, `operator`, `manager`, `administrator`.
Permissions: `pipeline.read`, `pipeline.manage`, `pipeline.operator.preview`,
`pipeline.operator.apply`, `pipeline.admin` (see `src/auth/authorization.js`).
No Phase 3C route performs a production operator action.
