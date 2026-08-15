/**
 * Composition root for the PIPELINE shell.
 *
 * createApp(config) opens the guarded database, applies migrations, and builds
 * the HTTP server WITHOUT listening. The caller (server.js or a test) decides
 * when and where to listen. close() tears everything down.
 */

import { join } from "node:path";
import { openPipelineDatabase } from "../database/openDatabase.js";
import { runMigrations } from "../database/migrationRunner.js";
import { createServer } from "../http/createServer.js";
import { APP_ROOT } from "../config/environment.js";
import { applicationInfo } from "./applicationInfo.js";
import { buildServices } from "./buildServices.js";
import { seedDatabaseIfEmpty } from "../database/seedDatabase.js";
import { syncPiperDiscoverySources } from "../discovery/piperSourceRegistry.js";
import { PiperDiscoveryRunner } from "../discovery/piperDiscoveryRunner.js";
import { PiperDiscoveryScheduler } from "../discovery/piperDiscoveryScheduler.js";

export function createApp(config) {
  const migrationsDir = config.migrationsDir || join(APP_ROOT, "migrations");
  const publicDir = config.publicDir || join(APP_ROOT, "public");

  const db = openPipelineDatabase(config.dbPath);
  const migrations = runMigrations(db, migrationsDir);
  if (!config.isTest) seedDatabaseIfEmpty(db);
  syncPiperDiscoverySources(db, config.piperDiscoverySources || []);
  const piperDiscoveryRunner = new PiperDiscoveryRunner({ db, userAgent: config.piperDiscoveryUserAgent });
  const services = buildServices(config, db);
  const server = createServer({ config, db, publicDir, services, info: applicationInfo, piperDiscoveryRunner });
  const piperDiscoveryScheduler = new PiperDiscoveryScheduler(piperDiscoveryRunner, config.piperDiscoveryIntervalMinutes || 60);
  if (config.piperDiscoveryEnabled && !config.isTest) piperDiscoveryScheduler.start();

  return {
    server,
    db,
    config,
    services,
    migrations,
    piperDiscoveryRunner,
    close() {
      piperDiscoveryScheduler.stop();
      try { server.close(); } catch { /* not listening */ }
      try { db.close(); } catch { /* already closed */ }
    },
  };
}
