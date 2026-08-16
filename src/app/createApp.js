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

export function createApp(config) {
  const migrationsDir = config.migrationsDir || join(APP_ROOT, "migrations");
  const publicDir = config.publicDir || join(APP_ROOT, "public");

  const db = openPipelineDatabase(config.dbPath);
  const migrations = runMigrations(db, migrationsDir);
  if (!config.isTest) seedDatabaseIfEmpty(db);
  const services = buildServices(config, db);
  const server = createServer({ config, db, publicDir, services, info: applicationInfo });

  return {
    server,
    db,
    config,
    services,
    migrations,
    close() {
      try { server.close(); } catch { /* not listening */ }
      try { db.close(); } catch { /* already closed */ }
    },
  };
}
