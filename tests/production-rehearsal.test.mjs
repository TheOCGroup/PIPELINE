import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config/environment.js";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, startApp } from "./helpers/temporaryDatabase.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const production = (...parts) => readFileSync(join(root, "deploy", "production", ...parts), "utf8");

test("production integration defaults to read-only and requires an explicit cutover", () => {
  const env = {
    PIPELINE_ENV: "production",
    PIPELINE_ALLOW_OCG_ONE_INTEGRATION: "true",
    PIPELINE_SESSION_SECRET: "a-secure-session-secret-value",
    OCG_ONE_HANDOFF_PUBLIC_KEYS_JSON: '{"handoff-key-1":"pem"}',
    OCG_ONE_SERVICE_PUBLIC_KEYS_JSON: '{"service-key-1":"pem"}',
    OCG_ONE_SERVICE_PRIVATE_KEY_B64: Buffer.from("private key").toString("base64"),
    OCG_ONE_SERVICE_KEY_ID: "service-key-1",
  };
  assert.equal(loadConfig(env).readOnly, true);
  assert.equal(loadConfig({ ...env, PIPELINE_READ_ONLY: "false" }).readOnly, false);
});

test("conversion endpoint honors the production read-only safety gate", async (t) => {
  const temp = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, {
    host: "127.0.0.1", port: 0, dbPath: temp.dbPath, env: "production",
    integrationEnabled: true, readOnly: true, dataSource: "empty",
    handoffPublicKeys: {}, servicePublicKeys: {},
  });

  t.after(() => { app.close(); temp.cleanup(); });

  const response = await fetch(`${baseUrl}/api/v1/opportunities/convert`, { method: "POST" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "read_only");
});

test("system status reports configured handoff from the active verification keys", async (t) => {
  const temp = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, {
    host: "127.0.0.1", port: 0, dbPath: temp.dbPath, env: "production",
    integrationEnabled: true, readOnly: true, dataSource: "empty",
    handoffPublicKeys: { "handoff-key-1": "pem" }, servicePublicKeys: { "service-key-1": "pem" },
  });
  t.after(() => { app.close(); temp.cleanup(); });

  const response = await fetch(`${baseUrl}/api/v1/system/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.integration, "enabled");
  assert.equal(body.data.handoff, "configured");
});

test("production package uses the staged source layout and live config names", () => {
  const compose = production("docker-compose.yml");
  const generator = production("generate-secrets.sh");
  const envExample = production("pipeline.env.example");
  const migrationScript = production("migrate-pipeline.sh");
  const deploy = production("deploy.ps1");

  assert.match(compose, /context: \.\.\/apps\/pipeline/);
  assert.match(compose, /context: \.\.\/apps\/ocg-one/);
  assert.doesNotMatch(compose, /\.\.\/\.\.\/apps\//);
  assert.match(generator, /^PIPELINE_ALLOW_OCG_ONE_INTEGRATION=true$/m);
  assert.match(generator, /^OCG_ONE_SERVICE_PUBLIC_KEYS_JSON=\$\{HANDOFF_PUBLIC_JSON\}$/m);
  const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^node_modules\/$/m);
  assert.match(dockerignore, /^runtime\/$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);

  assert.match(envExample, /^PIPELINE_ALLOW_OCG_ONE_INTEGRATION=true$/m);
  assert.doesNotMatch(envExample, /PIPELINE_INTEGRATION_ENABLED/);
  assert.match(migrationScript, /FROM pipeline_migrations/);
  assert.doesNotMatch(migrationScript, /migrations_applied/);
  assert.match(deploy, /\$workspaceRoot = Resolve-Path/);
  assert.match(deploy, /tar -czf \$tarPath -C \$workspaceRoot apps\/ocg-one apps\/pipeline/);
});
