/** Disposable temp database paths + a base test config builder. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-shell-test-"));
  const dbPath = join(dir, "pipeline_test.db");
  return {
    dir,
    dbPath,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** A minimal, isolated config for createApp — integration off unless overridden. */
export function testConfig(dbPath, overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0, // ephemeral
    dbPath,
    env: "development",
    integrationEnabled: false,
    sessionSecret: "",
    handoffSecret: "",
    piperIntakeEnabled: false,
    piperIntakeSecret: "",
    piperDiscoveryEnabled: false,
    piperDiscoverySources: [],
    piperDiscoveryIntervalMinutes: 60,
    piperDiscoveryUserAgent: "OCG-PIPER-TEST/1.0",
    ocgOneBaseUrl: "http://127.0.0.1:8080",
    isTest: true,
    ...overrides,
  };
}

/** Start an app listening on an ephemeral port; returns { app, baseUrl }. */
export async function startApp(createApp, config) {
  const app = createApp(config);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}
