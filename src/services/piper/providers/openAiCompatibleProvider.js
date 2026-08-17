/**
 * OpenAI-compatible chat completions with tool calling.
 *
 * Targets Ollama (`http://127.0.0.1:11434/v1`), LM Studio, llama.cpp's server,
 * vLLM, and the hosted OpenAI API — they share this wire format. Local runtimes
 * generally need no API key.
 *
 * Every request carries an AbortSignal so a run can be cancelled for real: the
 * socket closes, the model stops, and the operator's "stop" means stopped
 * rather than hidden.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAiCompatibleProvider {
  constructor({ baseUrl, model, apiKey = "", timeoutMs = DEFAULT_TIMEOUT_MS, kind = "openai-compatible" }) {
    if (!baseUrl) throw new Error("PIPELINE_PIPER_BASE_URL is required for the openai-compatible provider");
    if (!model) throw new Error("PIPELINE_PIPER_MODEL is required for the openai-compatible provider");

    this.kind = kind;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.connected = true;
  }

  describe() {
    return { provider: this.kind, model: this.model, baseUrl: this.baseUrl, connected: true };
  }

  /**
   * `apiKey` may be a string or an async function returning one. The function
   * form lets a provider supply a short-lived credential that is refreshed per
   * request — Vertex AI mints an OAuth token from ADC this way — without a
   * second request path or a token stored on disk.
   */
  async #headers({ signal } = {}) {
    const h = { "Content-Type": "application/json" };
    const key = typeof this.apiKey === "function" ? await this.apiKey({ signal }) : this.apiKey;
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  /**
   * Reachability plus a tool-calling check, because tool-calling is the
   * capability most likely to rule a small local model out.
   */
  async probe({ signal } = {}) {
    try {
      const res = await this.complete({
        messages: [
          { role: "system", content: "You call tools when asked. Reply with a tool call only." },
          { role: "user", content: "Call the probe tool with value 7." },
        ],
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
        : { ok: true, model: this.model, toolCalling: false, reason: "model_did_not_call_tool",
            detail: "The model responded but did not emit a tool call. Actions will not persist reliably." };
    } catch (err) {
      return { ok: false, reason: err.code || "provider_unreachable", detail: err.message };
    }
  }

  async complete({ messages, tools = [], signal, maxTokens = 1024, temperature = 0 }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };
      if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: await this.#headers({ signal: controller.signal }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = new Error(`provider returned ${res.status}`);
        err.code = res.status === 401 || res.status === 403 ? "provider_unauthorized" : "provider_error";
        throw err;
      }

      const json = await res.json();
      const choice = json.choices?.[0]?.message || {};

      return {
        text: choice.content || "",
        toolCalls: (choice.tool_calls || []).map((c) => ({
          id: c.id,
          name: c.function?.name,
          arguments: safeParse(c.function?.arguments),
        })),
        raw: { model: json.model, finishReason: json.choices?.[0]?.finish_reason },
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

function safeParse(s) {
  if (!s) return {};
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    // A malformed tool-call payload is a real failure mode for small models.
    return { __malformed: true, raw: String(s).slice(0, 500) };
  }
}
