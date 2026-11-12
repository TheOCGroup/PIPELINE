# OCG PIPELINE — Verified Deployment Status

**Verification date:** 2026-11-12  
**Canonical repository:** `TheOCGroup/PIPELINE`  
**Canonical main commit:** `a0ac433232e5d1c53a1227969ca85ba7d3660ad5`

## Source and test gates

- PR #40 (migration portability and governance corrections): merged.
- PR #39 (authenticated Mission Control handoff dispatcher): merged.
- PR #41 (real HTTP loopback acceptance tests): merged.
- GitHub Production Gate for main: PASS.
- Full local test suite on canonical main: **298 passed, 0 failed**.
- Combined Mission Control delivery branch was also tested before merge: 296/296 passed.

## Current Google Cloud test deployment

PIPELINE is installed on the **existing** `ocg-os-prod` Compute Engine VM. No new VM, Cloud Run service, Render service, or paid hosting plan was created.

- systemd service: `ocg-pipeline.service` (enabled and active)
- source release: `/opt/ocg-pipeline/releases/a0ac433`
- active symlink: `/opt/ocg-pipeline/current`
- runtime: Node.js 24, PIPELINE v0.1.0
- bind: `10.128.0.2:8090`
- database: `/var/lib/ocg-pipeline/pipeline.db`
- backup: `/var/lib/ocg-pipeline/backups/pipeline-initial-a0ac433.db`
- database integrity: `ok`; 45 tables; initial opportunity/provenance/classification/handoff counts are zero.

### Access boundary

This is an **internal, IAP-only test deployment**, not a public production release.

- Firewall rule `allow-iap-ocg-pipeline-8090` permits TCP 8090 only from Google IAP's `35.235.240.0/20` range and only to the `ocg-pipeline-iap` VM tag.
- Direct public access to port 8090 was tested and timed out.
- A desktop launcher is installed: `Open-OCG-PIPELINE.bat` (with companion `.ps1`) on the founder desktop.
- The launcher opens an IAP tunnel at `127.0.0.1:18090`; browser URL: `http://127.0.0.1:18090/`.
- PIPELINE does not have a public DNS route in this deployment. Do not publish the localhost URL as a public link.

The service runs in `development` runtime mode solely behind the authenticated IAP tunnel. It is not exposed to the public internet. Do not change this to public development mode.

## Acceptance performed

- Health, version, system status, opportunities, provenance, classifications, and data-quality endpoints: HTTP 200.
- Desktop and mobile browser checks: HTTP 200, no JavaScript errors, no horizontal overflow at 1440px and 390px.
- Navigation checks across Home, Opportunities, People, Tasks, Provenance, Classifications, Data Quality, System, and Admin: HTTP 200.
- SQLite integrity check: `ok`; initial backup integrity check: `ok`.
- Actual RENO `missionControlHttpReceiver` and `missionControlIntake` modules were exercised against PIPELINE's delivery service using an isolated in-memory repository. Verified bearer auth (401 when absent), schema rejection (400), successful creation, lost-ack retry, duplicate acknowledgment, and exactly one project persisted.

The cross-service test was isolated QA. It did **not** write to the production Mission Control database or prove a live production handoff.

## Explicitly not complete

- PIPELINE database is empty. No production opportunity data was migrated.
- OCG ONE SSO/public-key integration remains disabled and unconfigured.
- Mission Control production handoff credentials are not configured in PIPELINE's environment; dispatch correctly fails closed until configured.
- Piper is deterministic-only (`piperProvider=none`); voice is unavailable.
- Outreach providers are not implemented.
- Production migration is governed by the existing Phase 3G architecture gate. The architecture document says production migration must not occur before Phase 3G.
- Public DNS, public HTTPS, production operator credential provisioning, production browser acceptance, and live production handoff remain release gates.

## Next controlled steps

1. Complete Phase 3G product decisions and reconcile the architecture/ownership documents before data cutover.
2. Configure production authentication and the Mission Control handoff secret through an approved secret-handling path; do not place credentials in Git or chat.
3. Complete source-data migration and reconciliation from the existing authoritative system without creating duplicate records.
4. Run production acceptance with a genuine authorized acquisition, then promote through the approved release process.

**Release verdict:** Canonical source merged and CI-verified; local-only Google Cloud deployment is running and browser-tested. **Not production-complete or publicly launched.**
