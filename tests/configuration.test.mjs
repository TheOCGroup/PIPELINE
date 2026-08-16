/** Configuration contract: validation, safe defaults, fail-closed secrets, no secret leakage. */

import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { loadConfig } from "../src/config/environment.js";

test("an invalid port is rejected", () => {
  assert.throws(() => loadConfig({ PIPELINE_PORT: "70000" }), /PIPELINE_PORT/);
  assert.throws(() => loadConfig({ PIPELINE_PORT: "abc" }), /PIPELINE_PORT/);
  assert.throws(() => loadConfig({ PIPELINE_PORT: "0" }), /PIPELINE_PORT/);
});

test("a missing database path is handled safely with an absolute default", () => {
  const cfg = loadConfig({}); // nothing set
  assert.ok(isAbsolute(cfg.dbPath), "dbPath resolves to an absolute path");
  assert.match(cfg.dbPath.replace(/\\/g, "/"), /\/runtime\/pipeline\.db$/);
  assert.equal(cfg.port, 8090);
  assert.equal(cfg.integrationEnabled, false);
});

test("production + integration enabled rejects weak or missing secrets", () => {
  // missing
  assert.throws(
    () => loadConfig({ PIPELINE_ENV: "production", PIPELINE_ALLOW_OCG_ONE_INTEGRATION: "true" }),
    /SESSION_SECRET|HANDOFF_SECRET/
  );
  // weak
  assert.throws(
    () => loadConfig({
      PIPELINE_ENV: "production", PIPELINE_ALLOW_OCG_ONE_INTEGRATION: "true",
      PIPELINE_SESSION_SECRET: "short", PIPELINE_HANDOFF_SECRET: "short",
    }),
    /too weak/
  );
});

test("secret values never appear in configuration errors", () => {
  const weakSecret = "weakvalue12345";
  try {
    loadConfig({
      PIPELINE_ENV: "production", PIPELINE_ALLOW_OCG_ONE_INTEGRATION: "true",
      PIPELINE_SESSION_SECRET: weakSecret,
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!err.message.includes(weakSecret), "the secret value must not be echoed in the error");
  }
});

test("development mode does not require secrets", () => {
  const cfg = loadConfig({ PIPELINE_ENV: "development" });
  assert.equal(cfg.env, "development");
  // No throw; health/version never need secrets.
  assert.equal(cfg.sessionSecret, "");
});

test("PIPER intake is disabled by default and fails closed with a weak production secret", () => {
  const disabled = loadConfig({ PIPELINE_ENV: "production" });
  assert.equal(disabled.piperIntakeEnabled, false);

  assert.throws(
    () => loadConfig({
      PIPELINE_ENV: "production",
      PIPELINE_ENABLE_PIPER_INTAKE: "true",
      PIPELINE_PIPER_INTAKE_SECRET: "too-short",
    }),
    /PIPELINE_PIPER_INTAKE_SECRET.*too weak/
  );

  const enabled = loadConfig({
    PIPELINE_ENV: "production",
    PIPELINE_ENABLE_PIPER_INTAKE: "true",
    PIPELINE_PIPER_INTAKE_SECRET: "a-secure-piper-intake-secret",
  });
  assert.equal(enabled.piperIntakeEnabled, true);
});

test("an enabled production intake never echoes the secret in its failure", () => {
  const weakSecret = "short-intake-key";
  try {
    loadConfig({
      PIPELINE_ENV: "production",
      PIPELINE_ENABLE_PIPER_INTAKE: "true",
      PIPELINE_PIPER_INTAKE_SECRET: weakSecret.slice(0, 8),
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!err.message.includes(weakSecret.slice(0, 8)), "the secret value must not be echoed in the error");
  }
});

test("production defaults to read-only, which blocks intake writes", () => {
  const cfg = loadConfig({ PIPELINE_ENV: "production" });
  assert.equal(cfg.readOnly, true, "production must default to refusing mutations");
});
