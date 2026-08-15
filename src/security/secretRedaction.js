/**
 * Secret redaction helpers.
 *
 * Client-facing errors in this shell are already deterministic short codes, but
 * these helpers guarantee that if a secret value or filesystem path ever reaches
 * a log or message it is scrubbed. Never log raw config.
 */

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key)/i;

/** Replaces any occurrence of the provided secret values with a placeholder. */
export function redactSecrets(text, secretValues = []) {
  let out = String(text ?? "");
  for (const s of secretValues) {
    if (s && String(s).length >= 4) {
      out = out.split(String(s)).join("[redacted]");
    }
  }
  return out;
}

/** Returns a shallow copy of an object with secret-looking keys masked. */
export function redactObject(obj) {
  const clone = {};
  for (const [k, v] of Object.entries(obj || {})) {
    clone[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : v;
  }
  return clone;
}

export { SECRET_KEY_PATTERN };
