/**
 * Vertex AI provider and Google ADC token handling.
 *
 * These exercise the auth and URL construction against injected fakes, so they
 * run without credentials or network. What they cannot prove is that Google
 * accepts the resulting request — that needs real ADC and is verified
 * separately by POST /api/v1/piper/probe.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAdcTokenSource, findAdcPath, adcCandidatePaths } from "../src/services/piper/providers/googleAuth.js";
import { VertexAiProvider, vertexBaseUrl } from "../src/services/piper/providers/vertexAiProvider.js";
import { createPiperProvider } from "../src/services/piper/providers/index.js";
import { loadConfig } from "../src/config/environment.js";

function writeAdc(contents) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-adc-"));
  const path = join(dir, "application_default_credentials.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const AUTHORIZED_USER = {
  type: "authorized_user",
  client_id: "test-client-id.apps.googleusercontent.com",
  client_secret: "test-client-secret",
  refresh_token: "test-refresh-token",
};

// --- endpoint shape --------------------------------------------------------

test("the base URL matches Vertex's global and regional forms", () => {
  assert.equal(
    vertexBaseUrl({ project: "ocg-pipeline", location: "global" }),
    "https://aiplatform.googleapis.com/v1/projects/ocg-pipeline/locations/global/endpoints/openapi"
  );

  // Regional uses a region-prefixed host; the global host with a regional path 404s.
  assert.equal(
    vertexBaseUrl({ project: "ocg-pipeline", location: "us-central1" }),
    "https://us-central1-aiplatform.googleapis.com/v1/projects/ocg-pipeline/locations/us-central1/endpoints/openapi"
  );

  assert.equal(
    vertexBaseUrl({ project: "ocg-pipeline" }),
    "https://aiplatform.googleapis.com/v1/projects/ocg-pipeline/locations/global/endpoints/openapi",
    "location defaults to global"
  );

  assert.throws(() => vertexBaseUrl({ project: "" }), /PIPELINE_PIPER_GCP_PROJECT/);
});

// --- ADC discovery ---------------------------------------------------------

test("ADC discovery checks the standard locations in order", () => {
  const paths = adcCandidatePaths({
    GOOGLE_APPLICATION_CREDENTIALS: "/explicit/key.json",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    HOME: "/home/x",
  });
  assert.equal(paths[0], "/explicit/key.json", "an explicit key file wins");
  assert.ok(paths.some((p) => p.includes("gcloud")), "the gcloud config location is checked");

  assert.equal(findAdcPath({ APPDATA: "/definitely/not/here" }), null);
});

test("a missing credential is reported, never silently skipped", async () => {
  const source = new GoogleAdcTokenSource({ env: {}, fetchImpl: async () => { throw new Error("should not be called"); } });
  assert.equal(source.describe().available, false);
  await assert.rejects(() => source.getToken(), /Application Default Credentials/);
});

// --- token minting ---------------------------------------------------------

test("an authorized_user credential is exchanged for an access token", async (t) => {
  const path = writeAdc(AUTHORIZED_USER);
  let sentBody = null;

  const source = new GoogleAdcTokenSource({
    env: {},
    credentialsPath: path,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      sentBody = init.body.toString();
      return { ok: true, status: 200, json: async () => ({ access_token: "ya29.fake", expires_in: 3600 }) };
    },
  });

  const token = await source.getToken();
  assert.equal(token, "ya29.fake");
  assert.match(sentBody, /grant_type=refresh_token/);
  assert.match(sentBody, /refresh_token=test-refresh-token/);
  assert.equal(source.describe().type, "authorized_user");
});

test("tokens are cached and reused until near expiry", async () => {
  const path = writeAdc(AUTHORIZED_USER);
  let calls = 0;
  const source = new GoogleAdcTokenSource({
    env: {},
    credentialsPath: path,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `t${calls}`, expires_in: 3600 }) };
    },
  });

  assert.equal(await source.getToken(), "t1");
  assert.equal(await source.getToken(), "t1", "the cached token is reused");
  assert.equal(calls, 1);

  source.invalidate();
  assert.equal(await source.getToken(), "t2", "invalidate forces a re-mint");
  assert.equal(calls, 2);
});

test("a near-expiry token is refreshed rather than replayed", async () => {
  const path = writeAdc(AUTHORIZED_USER);
  let calls = 0;
  const source = new GoogleAdcTokenSource({
    env: {},
    credentialsPath: path,
    fetchImpl: async () => {
      calls += 1;
      // 30s lifetime, inside the 60s refresh skew.
      return { ok: true, status: 200, json: async () => ({ access_token: `t${calls}`, expires_in: 30 }) };
    },
  });

  await source.getToken();
  await source.getToken();
  assert.equal(calls, 2, "a token expiring within the skew window is re-minted");
});

test("concurrent callers share a single refresh", async () => {
  const path = writeAdc(AUTHORIZED_USER);
  let calls = 0;
  const source = new GoogleAdcTokenSource({
    env: {},
    credentialsPath: path,
    fetchImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({ access_token: "shared", expires_in: 3600 }) };
    },
  });

  const tokens = await Promise.all([source.getToken(), source.getToken(), source.getToken()]);
  assert.deepEqual(tokens, ["shared", "shared", "shared"]);
  assert.equal(calls, 1, "one exchange, not three");
});

test("a rejected credential fails clearly without echoing the secret", async () => {
  const path = writeAdc(AUTHORIZED_USER);
  const source = new GoogleAdcTokenSource({
    env: {},
    credentialsPath: path,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }),
  });

  await assert.rejects(
    () => source.getToken(),
    (err) => {
      assert.equal(err.code, "adc_token_rejected");
      assert.ok(!err.message.includes("test-refresh-token"), "the refresh token is not echoed");
      assert.ok(!err.message.includes("test-client-secret"), "the client secret is not echoed");
      assert.match(err.message, /application-default login/);
      return true;
    }
  );
});

// --- provider wiring -------------------------------------------------------

test("the provider sends the minted token as a bearer credential", async () => {
  const path = writeAdc(AUTHORIZED_USER);
  const tokenSource = new GoogleAdcTokenSource({
    env: {},
    credentialsPath: path,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: "ya29.minted", expires_in: 3600 }) }),
  });

  const provider = new VertexAiProvider({
    project: "ocg-pipeline",
    location: "global",
    model: "google/gemini-2.5-flash",
    tokenSource,
  });

  let seenAuth = null;
  let seenUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: "google/gemini-2.5-flash", choices: [{ message: { content: "hello", tool_calls: [] } }] }),
    };
  };

  try {
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "hello");
    assert.equal(seenAuth, "Bearer ya29.minted", "the ADC token is used, not a stored key");
    assert.match(seenUrl, /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/ocg-pipeline\/locations\/global\/endpoints\/openapi\/chat\/completions$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("describe() reports credential presence but never the credential", () => {
  const path = writeAdc(AUTHORIZED_USER);
  const provider = new VertexAiProvider({
    project: "ocg-pipeline",
    model: "google/gemini-2.5-flash",
    tokenSource: new GoogleAdcTokenSource({ env: {}, credentialsPath: path, fetchImpl: async () => ({}) }),
  });

  const d = provider.describe();
  assert.equal(d.provider, "vertex-ai");
  assert.equal(d.project, "ocg-pipeline");
  assert.equal(d.location, "global");
  assert.equal(d.credentials.available, true);
  assert.equal(d.credentials.type, "authorized_user");

  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes("test-refresh-token"));
  assert.ok(!serialized.includes("test-client-secret"));
  assert.ok(!/ya29\./.test(serialized), "no access token is exposed");
});

test("probe reports missing ADC rather than attempting an unauthenticated call", async () => {
  const provider = new VertexAiProvider({
    project: "ocg-pipeline",
    model: "google/gemini-2.5-flash",
    tokenSource: new GoogleAdcTokenSource({ env: {}, fetchImpl: async () => { throw new Error("must not call"); } }),
  });
  const result = await provider.probe();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "adc_not_found");
});

// --- configuration ---------------------------------------------------------

test("vertex-ai configuration is validated", () => {
  const base = {
    PIPELINE_PIPER_PROVIDER: "vertex-ai",
    PIPELINE_PIPER_MODEL: "google/gemini-2.5-flash",
    PIPELINE_PIPER_GCP_PROJECT: "ocg-pipeline",
  };

  const cfg = loadConfig(base);
  assert.equal(cfg.piperProvider, "vertex-ai");
  assert.equal(cfg.piperGcpProject, "ocg-pipeline");
  assert.equal(cfg.piperGcpLocation, "global", "location defaults to global");

  assert.throws(
    () => loadConfig({ ...base, PIPELINE_PIPER_GCP_PROJECT: "" }),
    /PIPELINE_PIPER_GCP_PROJECT is required/
  );

  // A key here means someone thinks it is being used; Vertex uses ADC.
  assert.throws(
    () => loadConfig({ ...base, PIPELINE_PIPER_API_KEY: "should-not-be-here" }),
    /must not be set for the vertex-ai provider/
  );

  assert.throws(
    () => loadConfig({ PIPELINE_PIPER_PROVIDER: "gemini" }),
    /expected none, openai-compatible, anthropic, or vertex-ai/
  );
});

test("the existing providers are preserved", () => {
  assert.equal(createPiperProvider({ piperProvider: "none" }).kind, "none");
  assert.equal(createPiperProvider({}).kind, "none");

  const oai = createPiperProvider({
    piperProvider: "openai-compatible",
    piperBaseUrl: "http://127.0.0.1:11434/v1",
    piperModel: "qwen2.5",
  });
  assert.equal(oai.kind, "openai-compatible");
  assert.equal(oai.connected, true);

  const anthropic = createPiperProvider({
    piperProvider: "anthropic",
    piperModel: "claude-sonnet-5",
    piperApiKey: "test-key",
  });
  assert.equal(anthropic.kind, "anthropic");

  const vertex = createPiperProvider({
    piperProvider: "vertex-ai",
    piperGcpProject: "ocg-pipeline",
    piperGcpLocation: "global",
    piperModel: "google/gemini-2.5-flash",
  });
  assert.equal(vertex.kind, "vertex-ai");
});

test("a string apiKey still works, so existing providers are unaffected", async () => {
  const { OpenAiCompatibleProvider } = await import("../src/services/piper/providers/openAiCompatibleProvider.js");
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    model: "m",
    apiKey: "static-key",
  });

  let seenAuth = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenAuth = init.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  try {
    await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(seenAuth, "Bearer static-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
