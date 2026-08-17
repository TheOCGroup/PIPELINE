/**
 * Piper model providers.
 *
 * Piper works with no provider at all — the deterministic router answers from
 * stored state. A provider adds language understanding on top; it never becomes
 * the source of facts. Retrieval and tool execution stay server-side, so a model
 * can phrase an answer but cannot invent an opportunity or write to the database
 * without an approved tool call.
 *
 * Configure with:
 *   PIPELINE_PIPER_PROVIDER   none | openai-compatible | anthropic
 *   PIPELINE_PIPER_BASE_URL   e.g. http://127.0.0.1:11434/v1  (Ollama, LM Studio)
 *   PIPELINE_PIPER_MODEL      e.g. qwen2.5:14b-instruct
 *   PIPELINE_PIPER_API_KEY    required for hosted providers, omit for local
 *
 * Tool-calling reliability is the binding requirement for a local model, not
 * latency: a model that writes fluent prose but emits malformed tool calls fails
 * the only thing that matters here — the operator saying "do it" and the action
 * actually persisting. `probe()` exists to test exactly that before you commit.
 */

import { NullProvider } from "./nullProvider.js";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { AnthropicProvider } from "./anthropicProvider.js";

export function createPiperProvider(config = {}) {
  const kind = String(config.piperProvider || "none").toLowerCase();

  switch (kind) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider({
        baseUrl: config.piperBaseUrl,
        model: config.piperModel,
        apiKey: config.piperApiKey,
        timeoutMs: config.piperTimeoutMs,
      });
    case "anthropic":
      return new AnthropicProvider({
        baseUrl: config.piperBaseUrl,
        model: config.piperModel,
        apiKey: config.piperApiKey,
        timeoutMs: config.piperTimeoutMs,
      });
    case "none":
    case "":
      return new NullProvider();
    default:
      // Fail closed and visibly rather than silently degrading to no model.
      throw new Error(`invalid PIPELINE_PIPER_PROVIDER: "${kind}" (expected none, openai-compatible, or anthropic)`);
  }
}

export { NullProvider, OpenAiCompatibleProvider, AnthropicProvider };
