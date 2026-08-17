/**
 * The provider used when no model is configured.
 *
 * It does not pretend. `connected` is false, `complete()` refuses rather than
 * returning plausible text, and the runtime falls back to the deterministic
 * intent router — which answers real questions from real state, just without
 * language understanding.
 */

export class NullProvider {
  constructor() {
    this.kind = "none";
    this.model = null;
    this.connected = false;
  }

  describe() {
    return { provider: "none", model: null, connected: false };
  }

  async probe() {
    return {
      ok: false,
      reason: "no_provider_configured",
      detail: "Set PIPELINE_PIPER_PROVIDER, PIPELINE_PIPER_BASE_URL and PIPELINE_PIPER_MODEL to connect a model.",
    };
  }

  async complete() {
    const err = new Error("no_provider_configured");
    err.code = "no_provider_configured";
    throw err;
  }
}
