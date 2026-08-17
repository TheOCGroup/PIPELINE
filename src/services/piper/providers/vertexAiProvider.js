/**
 * Vertex AI, via its OpenAI-compatible endpoint.
 *
 * Reuses the existing OpenAI-compatible request path rather than adding a
 * second one: Vertex exposes `/chat/completions` with the same wire format, so
 * the only real differences are the URL and the credential.
 *
 * Auth is an OAuth access token minted from Application Default Credentials on
 * each request (cached until shortly before expiry). Nothing is stored in .env
 * — the token lives in memory and in the outbound Authorization header only.
 *
 * Endpoint shape differs by location, which is easy to get wrong:
 *   global      https://aiplatform.googleapis.com/v1/projects/{p}/locations/global/endpoints/openapi
 *   regional    https://{loc}-aiplatform.googleapis.com/v1/projects/{p}/locations/{loc}/endpoints/openapi
 *
 * A regional location needs the region-prefixed host; using the global host
 * with a regional path returns 404. `global` is preferred where the model
 * supports it, since it avoids pinning capacity to one region.
 *
 * Model ids carry the publisher prefix, e.g. `google/gemini-2.5-flash`.
 */

import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { GoogleAdcTokenSource } from "./googleAuth.js";

export function vertexBaseUrl({ project, location }) {
  if (!project) throw new Error("PIPELINE_PIPER_GCP_PROJECT is required for the vertex-ai provider");
  const loc = location || "global";
  const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${loc}/endpoints/openapi`;
}

export class VertexAiProvider {
  constructor({ project, location = "global", model, timeoutMs, env = process.env, tokenSource = null }) {
    if (!model) throw new Error("PIPELINE_PIPER_MODEL is required for the vertex-ai provider");

    this.kind = "vertex-ai";
    this.project = project;
    this.location = location || "global";
    this.model = model;
    this.connected = true;

    this.tokenSource = tokenSource || new GoogleAdcTokenSource({ env });
    this.baseUrl = vertexBaseUrl({ project, location: this.location });

    // Delegate the actual request. The credential is a function so a fresh
    // token is resolved per call and an expired one never goes out.
    this.transport = new OpenAiCompatibleProvider({
      baseUrl: this.baseUrl,
      model: this.model,
      apiKey: ({ signal } = {}) => this.tokenSource.getToken({ signal }),
      timeoutMs,
      kind: "vertex-ai",
    });
  }

  describe() {
    const adc = this.tokenSource.describe();
    return {
      provider: this.kind,
      model: this.model,
      baseUrl: this.baseUrl,
      project: this.project,
      location: this.location,
      connected: true,
      // Reports whether a credential is present, never its contents.
      credentials: { source: "adc", type: adc.type, available: adc.available },
    };
  }

  /** Reachability, authentication, and the tool-calling check. */
  async probe({ signal } = {}) {
    const adc = this.tokenSource.describe();
    if (!adc.available) {
      return {
        ok: false,
        reason: "adc_not_found",
        detail: "No Application Default Credentials found. Run: gcloud auth application-default login",
      };
    }
    return this.transport.probe({ signal });
  }

  async complete(args) {
    try {
      return await this.transport.complete(args);
    } catch (err) {
      // A rejected token is usually an expired ADC session. Drop the cached
      // token so the next attempt re-mints rather than replaying a dead one.
      if (err.code === "provider_unauthorized") {
        this.tokenSource.invalidate();
        err.message = "Vertex AI rejected the credential. Re-run: gcloud auth application-default login";
      }
      throw err;
    }
  }
}
