/**
 * Google Application Default Credentials → OAuth access tokens.
 *
 * Reads ADC directly rather than shelling out to `gcloud`, so PIPELINE has no
 * dependency on the SDK being installed or on PATH. The credential file is the
 * one `gcloud auth application-default login` writes.
 *
 * Tokens are minted on demand, cached in memory, and refreshed before expiry.
 * A token is never written to .env, never logged, and never sent to the
 * browser — it exists only in this process and in the Authorization header of
 * the outbound request.
 *
 * Credential types handled:
 *   authorized_user  what `gcloud auth application-default login` produces
 *   service_account  a key file pointed at by GOOGLE_APPLICATION_CREDENTIALS
 *
 * Workload identity federation (external_account) and the GCE metadata server
 * are not handled; both fail with a message naming what to do instead, rather
 * than silently producing an unauthenticated request.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Refresh this far before actual expiry so a request never races the clock. */
const EXPIRY_SKEW_MS = 60_000;

/** Standard ADC locations, in the order Google's own libraries check them. */
export function adcCandidatePaths(env = process.env) {
  const paths = [];
  if (env.GOOGLE_APPLICATION_CREDENTIALS) paths.push(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (env.CLOUDSDK_CONFIG) paths.push(join(env.CLOUDSDK_CONFIG, "application_default_credentials.json"));
  if (env.APPDATA) paths.push(join(env.APPDATA, "gcloud", "application_default_credentials.json"));
  if (env.HOME) paths.push(join(env.HOME, ".config", "gcloud", "application_default_credentials.json"));
  if (env.USERPROFILE) {
    paths.push(join(env.USERPROFILE, "AppData", "Roaming", "gcloud", "application_default_credentials.json"));
    paths.push(join(env.USERPROFILE, ".config", "gcloud", "application_default_credentials.json"));
  }
  return paths;
}

export function findAdcPath(env = process.env) {
  return adcCandidatePaths(env).find((p) => { try { return existsSync(p); } catch { return false; } }) || null;
}

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Mints and caches Google access tokens from ADC.
 *
 * Injectable `fetchImpl` and `readCredentials` keep this testable without
 * touching the network or a real credential file.
 */
export class GoogleAdcTokenSource {
  constructor({ env = process.env, fetchImpl = fetch, credentialsPath = null, scope = CLOUD_PLATFORM_SCOPE } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.scope = scope;
    this.explicitPath = credentialsPath;
    this.cached = null;      // { token, expiresAt }
    this.inFlight = null;    // dedupes concurrent refreshes
  }

  /** @returns {{path:string|null, type:string|null, available:boolean}} */
  describe() {
    const path = this.explicitPath || findAdcPath(this.env);
    if (!path) return { path: null, type: null, available: false };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return { path, type: parsed.type || "unknown", available: true };
    } catch {
      return { path, type: null, available: false };
    }
  }

  #loadCredentials() {
    const path = this.explicitPath || findAdcPath(this.env);
    if (!path) {
      throw new AuthError(
        "adc_not_found",
        "No Application Default Credentials found. Run: gcloud auth application-default login"
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new AuthError("adc_unreadable", `Could not read ADC at ${path}: ${err.message}`);
    }
    return parsed;
  }

  /** Current access token, refreshing when absent or near expiry. */
  async getToken({ signal } = {}) {
    if (this.cached && Date.now() < this.cached.expiresAt - EXPIRY_SKEW_MS) {
      return this.cached.token;
    }
    // Concurrent callers share one refresh rather than stampeding the endpoint.
    if (!this.inFlight) {
      this.inFlight = this.#refresh({ signal }).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async #refresh({ signal }) {
    const creds = this.#loadCredentials();

    if (creds.type === "authorized_user") {
      return this.#exchange({
        signal,
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: creds.refresh_token,
        }),
      });
    }

    if (creds.type === "service_account") {
      return this.#exchange({
        signal,
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: this.#signServiceAccountJwt(creds),
        }),
      });
    }

    throw new AuthError(
      "adc_unsupported_type",
      `Unsupported ADC credential type "${creds.type}". Use gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS to a service account key.`
    );
  }

  async #exchange({ body, signal }) {
    let res;
    try {
      res = await this.fetchImpl(TOKEN_URI, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw new AuthError("canceled", "Token request canceled.");
      throw new AuthError("adc_token_unreachable", `Could not reach Google's token endpoint: ${err.message}`);
    }

    if (!res.ok) {
      // Google echoes the credential in error bodies for some failures, so the
      // body is deliberately not included in the thrown message.
      throw new AuthError(
        res.status === 400 || res.status === 401 ? "adc_token_rejected" : "adc_token_error",
        `Google rejected the credential exchange (HTTP ${res.status}). Re-run: gcloud auth application-default login`
      );
    }

    const json = await res.json();
    if (!json.access_token) throw new AuthError("adc_token_missing", "Google returned no access_token.");

    const ttlMs = (Number(json.expires_in) || 3600) * 1000;
    this.cached = { token: json.access_token, expiresAt: Date.now() + ttlMs };
    return json.access_token;
  }

  /** RS256 self-signed JWT for the service-account grant. */
  #signServiceAccountJwt(creds) {
    const iat = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: creds.private_key_id };
    const claims = {
      iss: creds.client_email,
      scope: this.scope,
      aud: creds.token_uri || TOKEN_URI,
      iat,
      exp: iat + 3600,
    };
    const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${encode(header)}.${encode(claims)}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    return `${unsigned}.${signer.sign(creds.private_key, "base64url")}`;
  }

  /** Drops the cached token; the next call mints a fresh one. */
  invalidate() {
    this.cached = null;
  }
}

export { CLOUD_PLATFORM_SCOPE };
