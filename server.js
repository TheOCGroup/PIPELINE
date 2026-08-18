/**
 * OCG PIPELINE - standalone application entry point.
 *
 * Loads config from the environment, builds the app (guarded DB + migrations +
 * HTTP server), and listens. It never opens the OCG ONE canonical database and
 * never contacts OCG ONE unless integration is explicitly enabled.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __serverDir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__serverDir, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch (_) {}
}

import { assertNodeVersion } from "./src/runtime/checkNodeVersion.js";
import { loadConfig } from "./src/config/environment.js";
import { createApp } from "./src/app/createApp.js";
import { applicationInfo } from "./src/app/applicationInfo.js";

// Validate runtime requirements before boot
assertNodeVersion();

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  const piperDesc = app.services.piper ? app.services.piper.describeProvider() : null;
  const providerStr = piperDesc && piperDesc.connected
    ? `model=${piperDesc.provider} (${piperDesc.model})`
    : "model=none (deterministic)";
  console.log(
    `${applicationInfo.name} v${applicationInfo.version} listening on http://${config.host}:${config.port} ` +
      `(env=${config.env}, integration=${config.integrationEnabled ? "enabled" : "disabled"}, ${providerStr})`
  );
});

function shutdown() {
  app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
