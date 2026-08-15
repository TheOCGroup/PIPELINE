/** Handoff verification testing for Phase 3E (RS256 with jose). */

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";

async function post(baseUrl, body = {}) {
  return fetch(`${baseUrl}/auth/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function signTestToken(privateKeyPem, {
  keyId = "key-1",
  issuer = "ocg-one",
  audience = "pipeline",
  subject = "user-genaro",
  roles = ["administrator"],
  permissions = ["pipeline.read", "pipeline.manage", "pipeline.operator.preview", "pipeline.operator.apply", "pipeline.admin"],
  jti = "nonce-12345",
  exp
} = {}) {
  const { importPKCS8 } = await import("jose");
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    name: "Genaro Ocasio",
    email: "genaro@example.com",
    roles,
    permissions,
    destination: "/opportunities",
    contract_version: "1.0.0"
  };

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp || (now + 60));

  return await jwt.sign(privateKey);
}

test("handoff is disabled by default (integration off) -> 403", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await post(baseUrl, { token: "some-token" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "integration_disabled");
});

test("integration on but no handoff public keys configured -> 401/503 fail closed", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp,
    testConfig(db.dbPath, { integrationEnabled: true, handoffPublicKeys: {} }));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await post(baseUrl, { token: "some-token" });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "unsigned_or_malformed_token");
});

test("missing token, bad signature, unsigned, and expired tokens all fail", async (t) => {
  const db = makeTempDb();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, {
    integrationEnabled: true,
    handoffPublicKeys: { "key-1": publicKeyPem },
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline"
  }));
  t.after(() => { app.close(); db.cleanup(); });

  // 1. missing token
  const res1 = await post(baseUrl, {});
  assert.equal(res1.status, 401);
  assert.equal((await res1.json()).error, "missing_token");

  // 2. bad signature (signed with different key)
  const { privateKey: otherPrivateKey } = await generateKeyPair("RS256", { extractable: true });
  const otherPrivateKeyPem = await exportPKCS8(otherPrivateKey);
  const wrongToken = await signTestToken(otherPrivateKeyPem);
  const res2 = await post(baseUrl, { token: wrongToken });
  assert.equal(res2.status, 401);
  assert.equal((await res2.json()).error, "verification_failed");

  // 3. unsigned / malformed
  const res3 = await post(baseUrl, { token: "not-a-real-token" });
  assert.equal(res3.status, 401);
  assert.equal((await res3.json()).error, "unsigned_or_malformed_token");

  // 4. expired
  const now = Math.floor(Date.now() / 1000);
  const expiredToken = await signTestToken(privateKeyPem, { exp: now - 10 });
  const res4 = await post(baseUrl, { token: expiredToken });
  assert.equal(res4.status, 401);
  assert.equal((await res4.json()).error, "expired_token");
});

test("a correctly test-signed token verifies and mints a PIPELINE session (isolated config only)", async (t) => {
  const db = makeTempDb();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, {
    integrationEnabled: true,
    handoffPublicKeys: { "key-1": publicKeyPem },
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline"
  }));
  t.after(() => { app.close(); db.cleanup(); });

  const token = await signTestToken(privateKeyPem);
  const res = await post(baseUrl, { token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.subject, "user-genaro");
  assert.equal(body.destination, "/opportunities");
  assert.deepEqual(body.roles, ["administrator"]);
});

test("identity is never taken from the request body", async (t) => {
  const db = makeTempDb();
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, {
    integrationEnabled: true,
    handoffPublicKeys: {}
  }));
  t.after(() => { app.close(); db.cleanup(); });

  const res = await fetch(`${baseUrl}/auth/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sub: "attacker", roles: ["administrator"] })
  });
  assert.equal(res.status, 401);
});
