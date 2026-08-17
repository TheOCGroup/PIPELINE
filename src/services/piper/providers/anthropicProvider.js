/**
 * Anthropic Messages API with tool use.
 *
 * Separate from the OpenAI-compatible adapter because the wire format differs:
 * a top-level `system` string rather than a system message, `input_schema`
 * rather than JSON-Schema-under-`parameters`, and tool calls arriving as
 * `tool_use` content blocks rather than a `tool_calls` array.
 *
 * Requires PIPELINE_PIPER_API_KEY. The key is read from the environment and is
 * never logged, echoed in an error, or sent to the browser.
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 60_000;

export class AnthropicProvider {
  constructor({ baseUrl, model, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!model) throw new Error("PIPELINE_PIPER_MODEL is required for the anthropic provider");
    if (!apiKey) throw new Error("PIPELINE_PIPER_API_KEY is required for the anthropic provider");

    this.kind = "anthropic";
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.connected = true;
  }

  describe() {
    // Deliberately omits the key.
    return { provider: this.kind, model: this.model, baseUrl: this.baseUrl, connected: true };
  }

  async probe({ signal } = {}) {
    try {
      const res = await this.complete({
        messages: [{ role: "user", content: "Call the probe tool with value 7." }],
        system: "You call tools when asked.",
        tools: [{
          type: "function",
          function: {
            name: "probe",
            description: "A connectivity probe.",
            parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
          },
        }],
        signal,
        maxTokens: 128,
      });
      const called = (res.toolCalls || []).some((c) => c.name === "probe");
      return called
        ? { ok: true, model: this.model, toolCalling: true }
        : { ok: true, model: this.model, toolCalling: false, reason: "model_did_not_call_tool" };
    } catch (err) {
      return { ok: false, reason: err.code || "provider_unreachable", detail: err.message };
    }
  }

  async complete({ messages, tools = [], system, signal, maxTokens = 1024, temperature = 0 }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Anthropic takes the system prompt at the top level, not as a message.
      const systemText = system || messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const turns = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));

      const body = {
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        messages: turns.length ? turns : [{ role: "user", content: "" }],
      };
      if (systemText) body.system = systemText;
      if (tools.length) {
        body.tools = tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }));
      }

      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = new Error(`provider returned ${res.status}`);
        err.code = res.status === 401 || res.status === 403 ? "provider_unauthorized" : "provider_error";
        throw err;
      }

      const json = await res.json();
      const blocks = Array.isArray(json.content) ? json.content : [];

      return {
        text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
        toolCalls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
        raw: { model: json.model, finishReason: json.stop_reason },
      };
    } catch (err) {
      if (err.name === "AbortError") {
        const e = new Error("canceled");
        e.code = signal?.aborted ? "canceled" : "provider_timeout";
        throw e;
      }
      if (!err.code) err.code = "provider_error";
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}
