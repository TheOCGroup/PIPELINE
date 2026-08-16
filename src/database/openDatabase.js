/**
 * Opens the PIPELINE database — and only a PIPELINE database.
 * The canonical guard runs first and throws before any file is opened.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertNotCanonical } from "./canonicalDatabaseGuard.js";

export function openPipelineDatabase(dbPath) {
  const safePath = assertNotCanonical(dbPath); // fails closed before opening
  mkdirSync(dirname(safePath), { recursive: true });

  const db = new DatabaseSync(safePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
