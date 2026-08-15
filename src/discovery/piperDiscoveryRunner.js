import { randomUUID } from "node:crypto";
import { ingestPiperListing } from "../services/piperIntakeService.js";
import { parsePiperSource } from "./piperSourceParsers.js";
import { listEnabledPiperSources } from "./piperSourceRegistry.js";
import { robotsAllows } from "./robotsPolicy.js";

function startRun(db, source) {
  const id = randomUUID();
  db.prepare(`INSERT INTO piper_discovery_runs (id, source_id, status, started_at) VALUES (?, ?, 'running', ?)`)
    .run(id, source.id, new Date().toISOString());
  return id;
}

function finishRun(db, id, status, counts, error = null) {
  db.prepare(`
    UPDATE piper_discovery_runs SET status = ?, finished_at = ?, records_found = ?, records_created = ?,
      records_reconciled = ?, records_failed = ?, error_summary = ? WHERE id = ?
  `).run(status, new Date().toISOString(), counts.found, counts.created, counts.reconciled, counts.failed, error, id);
}

function saveFinding(db, source, runId, result) {
  const listing = result.listing;
  const status = result.duplicate ? "reconciled" : "new";
  db.prepare(`
    INSERT INTO piper_discovery_items (
      id, source_id, run_id, external_id, source_url, normalized_address, fingerprint,
      raw_payload_json, piper_score, score_reasons_json, status, opportunity_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      run_id = excluded.run_id,
      source_url = excluded.source_url,
      normalized_address = excluded.normalized_address,
      fingerprint = excluded.fingerprint,
      raw_payload_json = excluded.raw_payload_json,
      piper_score = excluded.piper_score,
      score_reasons_json = excluded.score_reasons_json,
      status = excluded.status,
      opportunity_id = excluded.opportunity_id,
      last_seen_at = excluded.last_seen_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(randomUUID(), source.id, runId, listing.externalId, listing.sourceUrl, listing.normalizedAddress,
    listing.fingerprint, JSON.stringify(listing.raw || listing), result.score, JSON.stringify(result.reasons),
    status, result.opportunityId, listing.discoveredAt, new Date().toISOString());
}

export class PiperDiscoveryRunner {
  constructor({ db, fetchImpl = globalThis.fetch, userAgent = "OCG-PIPER/1.0 (+https://ocgict.com)" }) {
    this.db = db;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.running = false;
  }

  async runAll() {
    if (this.running) return { skipped: true, reason: "already_running" };
    this.running = true;
    try {
      const results = [];
      for (const source of listEnabledPiperSources(this.db)) results.push(await this.runSource(source));
      return { skipped: false, results };
    } finally {
      this.running = false;
    }
  }

  async runSource(source) {
    const runId = startRun(this.db, source);
    const counts = { found: 0, created: 0, reconciled: 0, failed: 0 };
    try {
      if (source.respectRobots && !(await robotsAllows(this.fetchImpl, source.url, this.userAgent))) {
        finishRun(this.db, runId, "blocked_by_robots", counts, "robots_policy_disallowed");
        return { sourceId: source.id, runId, status: "blocked_by_robots", counts };
      }

      const response = await this.fetchImpl(source.url, {
        headers: { accept: "application/json, application/ld+json, application/rss+xml, text/html;q=0.9", "user-agent": this.userAgent },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`source_http_${response.status}`);
      const listings = parsePiperSource(await response.text(), source);
      counts.found = listings.length;

      for (const listing of listings) {
        try {
          const result = ingestPiperListing(this.db, {
            ...listing,
            sourceName: source.name,
            sourceType: "property_lead_inbox",
            sourceUrl: listing.sourceUrl || source.url,
          });
          saveFinding(this.db, source, runId, { ...result, listing: { ...result.listing, raw: listing.raw } });
          if (result.duplicate) counts.reconciled += 1;
          else counts.created += 1;
        } catch {
          counts.failed += 1;
        }
      }

      const status = counts.failed > 0 ? "partial" : "completed";
      finishRun(this.db, runId, status, counts);
      this.db.prepare("UPDATE piper_discovery_sources SET last_run_at = ?, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), source.id);
      return { sourceId: source.id, runId, status, counts };
    } catch (error) {
      finishRun(this.db, runId, "failed", counts, String(error.message || "discovery_failed").slice(0, 300));
      return { sourceId: source.id, runId, status: "failed", counts, error: String(error.message || "discovery_failed") };
    }
  }
}
