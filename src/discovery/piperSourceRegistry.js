import { createHash } from "node:crypto";

const sourceId = (url) => `src_${createHash("sha256").update(url).digest("hex").slice(0, 14)}`;

export function syncPiperDiscoverySources(db, configuredSources = []) {
  const upsert = db.prepare(`
    INSERT INTO piper_discovery_sources (
      id, name, base_url, source_format, enabled, respect_robots, configuration_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(base_url) DO UPDATE SET
      name = excluded.name,
      source_format = excluded.source_format,
      enabled = excluded.enabled,
      respect_robots = excluded.respect_robots,
      configuration_json = excluded.configuration_json,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);
  for (const source of configuredSources) {
    upsert.run(source.id || sourceId(source.url), source.name, source.url, source.format,
      source.enabled === false ? 0 : 1, source.respectRobots === false ? 0 : 1,
      JSON.stringify(source.configuration || {}));
  }
}

export function listEnabledPiperSources(db) {
  return db.prepare(`
    SELECT id, name, base_url, source_format, respect_robots, configuration_json
    FROM piper_discovery_sources WHERE enabled = 1 ORDER BY name
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    url: row.base_url,
    sourceFormat: row.source_format,
    respectRobots: row.respect_robots === 1,
    configuration: JSON.parse(row.configuration_json || "{}"),
  }));
}
