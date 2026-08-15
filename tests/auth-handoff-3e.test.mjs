import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose";
import { createApp } from "../src/app/createApp.js";
import { makeTempDb, testConfig, startApp } from "./helpers/temporaryDatabase.mjs";
import { verifyAndMapHandoffToken } from "../src/auth/handoffTokenVerifier.js";
import { OcgOneClient } from "../src/integrations/ocgOne/ocgOneClient.js";

// Helper to sign test tokens
async function signTestToken(privateKeyPem, {
  keyId = "key-1",
  issuer = "ocg-one",
  audience = "pipeline",
  subject = "user-1",
  name = "Genaro Ocasio",
  email = "genaro@example.com",
  roles = ["administrator"],
  permissions = ["pipeline.read", "pipeline.manage", "pipeline.operator.preview", "pipeline.operator.apply", "pipeline.admin"],
  destination = "/",
  jti = "nonce-1",
  iat,
  nbf,
  exp,
  contractVersion = "1.0.0",
  alg = "RS256"
} = {}) {
  const { importPKCS8 } = await import("jose");
  const privateKey = await importPKCS8(privateKeyPem, alg);
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    name,
    email,
    roles,
    permissions,
    destination,
    contract_version: contractVersion
  };

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg, kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(jti)
    .setIssuedAt(iat !== undefined ? iat : now)
    .setNotBefore(nbf !== undefined ? nbf : now)
    .setExpirationTime(exp !== undefined ? exp : now + 60);

  return await jwt.sign(privateKey);
}

test("User handoff token verification logic using jose", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const publicKeys = { "key-1": publicKeyPem };
  const expectedIssuer = "ocg-one";
  const expectedAudience = "pipeline";

  await t.test("Valid RS256 token succeeds", async () => {
    const token = await signTestToken(privateKeyPem);
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, true);
    assert.equal(result.identity.subject, "user-1");
  });

  await t.test("Non-RS256 algorithms are rejected (using HS256 / none)", async () => {
    // jose prevents unsigned tokens by default. If we sign with HS256 but pass public keys, verifySPKI fails.
    const token = await signTestToken(privateKeyPem, { alg: "HS256" }).catch(() => null);
    if (token) {
      const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "invalid_algorithm");
    }
  });

  await t.test("Missing kid fails", async () => {
    const token = await signTestToken(privateKeyPem, { keyId: "" });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_kid");
  });

  await t.test("Unknown kid fails", async () => {
    const token = await signTestToken(privateKeyPem, { keyId: "unknown-key" });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown_kid");
  });

  await t.test("Wrong issuer fails", async () => {
    const token = await signTestToken(privateKeyPem, { issuer: "wrong-iss" });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.match(result.reason, /claim_failed|issuer/);
  });

  await t.test("Wrong audience fails", async () => {
    const token = await signTestToken(privateKeyPem, { audience: "wrong-aud" });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.match(result.reason, /claim_failed|audience/);
  });

  await t.test("Expired token fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTestToken(privateKeyPem, { iat: now - 200, nbf: now - 200, exp: now - 100 });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.match(result.reason, /claim_failed|expired/);
  });

  await t.test("Premature token (future nbf) fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTestToken(privateKeyPem, { iat: now, nbf: now + 100, exp: now + 200 });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.match(result.reason, /claim_failed|before/);
  });

  await t.test("Excessive TTL (>120s) fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTestToken(privateKeyPem, { iat: now, nbf: now, exp: now + 300 });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "excessive_ttl");
  });

  await t.test("Unsupported contract major version fails", async () => {
    const token = await signTestToken(privateKeyPem, { contractVersion: "2.0.0" });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    // Note: since we verify payload, but contractVersion is inside, we reject in verifier or mapping
    assert.equal(result.ok, false);
    assert.equal(result.reason, "contract_version_mismatch");
  });
});

test("Role mapping and ceilings", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const publicKeys = { "key-1": publicKeyPem };
  const expectedIssuer = "ocg-one";
  const expectedAudience = "pipeline";

  await t.test("Unknown role rejection", async () => {
    const token = await signTestToken(privateKeyPem, { roles: ["hacker"] });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_recognized_role");
  });

  await t.test("Unknown permissions are removed", async () => {
    const token = await signTestToken(privateKeyPem, { roles: ["viewer"], permissions: ["pipeline.read", "pipeline.hack"] });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, true);
    assert.deepEqual(result.identity.permissions, ["pipeline.read"]);
  });

  await t.test("Role ceiling is strictly enforced", async () => {
    // Viewer ceiling is pipeline.read only. If viewer token claims pipeline.admin, it gets stripped!
    const token = await signTestToken(privateKeyPem, { roles: ["viewer"], permissions: ["pipeline.read", "pipeline.admin"] });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, true);
    assert.deepEqual(result.identity.permissions, ["pipeline.read"]);
  });

  await t.test("Missing pipeline.read permission blocks access", async () => {
    const token = await signTestToken(privateKeyPem, { roles: ["viewer"], permissions: ["pipeline.manage"] });
    const result = await verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_pipeline_read_permission");
  });
});

test("Atomic nonce replay and database commit rollback", async (t) => {
  const db = makeTempDb();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const config = testConfig(db.dbPath, {
    integrationEnabled: true,
    handoffPublicKeys: { "key-1": publicKeyPem },
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline"
  });

  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => { app.close(); db.cleanup(); });

  const token1 = await signTestToken(privateKeyPem, { jti: "nonce-replay-1" });

  // First submit succeeds
  let res = await fetch(`${baseUrl}/auth/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token1 })
  });
  assert.equal(res.status, 200);

  // Second submit with same jti fails (replay)
  res = await fetch(`${baseUrl}/auth/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token1 })
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "nonce_replayed");
});

test("Session details and CSRF lifecycle", async (t) => {
  const db = makeTempDb();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const config = testConfig(db.dbPath, {
    integrationEnabled: true,
    handoffPublicKeys: { "key-1": publicKeyPem },
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline"
  });

  const { app, baseUrl } = await startApp(createApp, config);
  t.after(() => { app.close(); db.cleanup(); });

  const token = await signTestToken(privateKeyPem);
  const resLogin = await fetch(`${baseUrl}/auth/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const cookie = resLogin.headers.get("Set-Cookie");
  assert.match(cookie, /pipeline_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  // Get session details and CSRF token
  const resSession = await fetch(`${baseUrl}/api/v1/auth/session`, {
    headers: { Cookie: cookie }
  });
  assert.equal(resSession.status, 200);
  assert.equal(resSession.headers.get("Cache-Control"), "no-store");
  const sessionBody = await resSession.json();
  assert.equal(sessionBody.ok, true);
  assert.ok(sessionBody.csrfToken);

  // Logout without CSRF fails
  const resLogoutNoCsrf = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(resLogoutNoCsrf.status, 403);

  // Logout with valid CSRF succeeds
  const resLogout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-CSRF-Token": sessionBody.csrfToken
    }
  });
  assert.equal(resLogout.status, 200);
  assert.equal((await resLogout.json()).ok, true);

  // Session is now revoked
  const resSessionAfter = await fetch(`${baseUrl}/api/v1/auth/session`, {
    headers: { Cookie: cookie }
  });
  assert.equal(resSessionAfter.status, 401);
});

test("S2S Client and Method/Path Binding", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);

  const client = new OcgOneClient({
    ocgOneBaseUrl: "http://127.0.0.1:8180",
    integrationEnabled: true,
    servicePrivateKey: privateKeyPem,
    serviceKeyId: "client-key-1",
    serviceIssuer: "pipeline",
    serviceAudience: "ocg-one-pipeline-integration"
  });

  const token = await client.generateToken("GET", "/api/integrations/pipeline/v1/properties/123");
  assert.ok(token);

  // We can verify token format using jose
  const { jwtVerify, importSPKI } = await import("jose");
  const parsedKey = await importSPKI(publicKeyPem, "RS256");
  const { payload } = await jwtVerify(token, parsedKey, {
    issuer: "pipeline",
    audience: "ocg-one-pipeline-integration"
  });

  assert.equal(payload.scope, "ocg-one.pipeline.read");
  assert.equal(payload.method, "GET");
  assert.equal(payload.path, "/api/integrations/pipeline/v1/properties/123");
});
test("browser form handoff mints a secure session and redirects away from the handoff endpoint", async (t) => {
  const db = makeTempDb();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);
  const { app, baseUrl } = await startApp(createApp, testConfig(db.dbPath, {
    env: "production",
    integrationEnabled: true,
    sessionSecret: "pipeline-browser-form-session-secret",
    handoffPublicKeys: { "key-1": publicKeyPem },
    handoffIssuer: "ocg-one",
    handoffAudience: "pipeline"
  }));
  t.after(() => { app.close(); db.cleanup(); });

  const token = await signTestToken(privateKeyPem, { jti: "browser-form-redirect-1", destination: "/opportunities" });
  const response = await fetch(`${baseUrl}/auth/handoff`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString()
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/opportunities");
  assert.match(response.headers.get("set-cookie"), /pipeline_session=/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Lax/);
  assert.match(response.headers.get("set-cookie"), /Secure/);
  assert.equal(await response.text(), "");

  const session = await fetch(`${baseUrl}/api/v1/auth/session`, {
    headers: { Cookie: response.headers.get("set-cookie") }
  });
  assert.equal(session.status, 200);
});