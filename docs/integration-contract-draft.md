# OCG ONE ⇄ PIPELINE — Integration Contract (DRAFT)

**Status:** Phase 3C draft. Architectural only — no production APIs are
implemented in this phase. Contract version placeholder: `0.0.0-draft`.

## OCG ONE-owned APIs (planned; OCG ONE serves, PIPELINE consumes)
| Capability | Purpose |
|---|---|
| Property lookup | Resolve property details by OCG ONE property id |
| Person / contact lookup | Resolve seller/contact details by id |
| Transitional lead lookup | Read `property_leads` during the transition |
| User identity handoff | Issue short-lived signed handoff tokens |
| Document reference lookup | Resolve document metadata / access |
| Canonical task reference lookup | Resolve linked canonical tasks |

## PIPELINE-owned APIs (planned; PIPELINE serves, OCG ONE consumes)
| Capability | Purpose |
|---|---|
| Seller opportunities | CRUD + stage lifecycle |
| Seller opportunity participants | Participant management |
| Sources | Opportunity source records |
| Provenance resolution | Resolved/unresolved source provenance |
| Classifications | REAL / SYNTHETIC / AMBIGUOUS status |
| Stage history | Append-only stage events |
| Offers | Offers and offer versions |
| Outcomes | Opportunity outcomes |
| Pipeline audit history | PIPELINE-owned audit trail |

## Contract requirements
- **Versioned routes** (e.g. `/api/v1/...`); backward-compatible evolution.
- **Authenticated requests** on every non-public route.
- **Short-lived tokens** for identity handoff; PIPELINE mints its own session.
- **Role mapping** between OCG ONE roles and PIPELINE roles.
- **Correlation IDs** on every request for cross-system tracing.
- **Cross-system record IDs**: store foreign ids with a `system` qualifier;
  never copy authoritative records.
- **Idempotency keys** required on all mutations.
- **Request/response validation** with explicit schemas.
- **Failure & retry**: bounded retries with backoff; safe on repeat (idempotent).
- **Timeouts**: every cross-system call has a timeout and a defined fallback.
- **Audit ownership**: the system that owns the data owns its audit trail.
- **Graceful degradation** when either system is offline (already precedented:
  the embedded implementation guards on the resolved view's existence).
- **Compatibility testing**: contract tests gate every release.

## Non-goals for Phase 3C
No production API implementation, no live SSO, no Deal Scout integration, no
seller-opportunity CRUD. These belong to Phase 3E and later.
