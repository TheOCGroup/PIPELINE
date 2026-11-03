/**
 * ONCALL communications bridge client — PIPER -> ONCALL governed call requests.
 *
 * ONCALL is the estate's sole dispatch authority; PIPER never dials. This
 * client lets PIPER *request* one governed seller callback through ONCALL's
 * service bridge (POST /api/integrations/comms/request-call, contract:
 * oncall-os docs/communications-call-contract.md) and read the outcome back.
 *
 * Governance, enforced here as well as server-side:
 *
 *   - Disabled by default. Unless ONCALL_COMMS_BASE_URL and
 *     PIPER_ONCALL_BRIDGE_SECRET are both configured, every method refuses
 *     with a typed `disabled` result and no network call is made.
 *   - An approval reference is REQUIRED for every request. ONCALL rejects
 *     service-originated requests without one (400 approval_ref_required);
 *     this client refuses before the network for the same reason. In the
 *     Piper tool layer the reference is supplied by the operator's approval
 *     of a parked proposal — never by the model.
 *   - Purpose is fixed to seller_callback, and the consent binding ONCALL
 *     enforces for it (express_consent / callback_requested only) is checked
 *     here first so an impermissible request never leaves the process.
 *   - No automatic retries. A retry could double-place a call; a caller who
 *     wants to retry reuses the same idempotency key, which ONCALL replays
 *     safely.
 *   - The bridge secret travels only in the x-comms-bridge-secret header. It
 *     is never placed in a result, an error, or a log line.
 *
 * Honesty of outcomes: a `queued` result means the provider created a call.
 * It is NOT evidence that a phone rang or that the seller was spoken to, and
 * no result from this client ever claims otherwise. ONCALL additionally
 * fails PIPER dispatch closed (503 outbound_not_configured) until a PIPER
 * voice profile is provisioned; that surfaces here as the distinct
 * `voice_profile_not_provisioned` state — it is reported, never retried
 * around.
 */

const REQUEST_CALL_PATH = "/api/integrations/comms/request-call";
const CALLS_PATH = "/api/integrations/comms/calls";

/** Consent bases ONCALL permits for seller_callback (strict binding). */
export const SELLER_CALLBACK_CONSENT_BASES = Object.freeze(["express_consent", "callback_requested"]);

/** Plain-language outcome for an ONCALL call record. Never overclaims. */
export function summarizeCallStatus(status, providerEndReason = null) {
  switch (status) {
    case "initiating":
      return "ONCALL accepted the request and is dispatching it. No call has connected.";
    case "queued":
      return "The provider created the call. That is not evidence the phone rang or that the seller was spoken to.";
    case "completed":
      return `The provider reported the call ended${providerEndReason ? ` (${providerEndReason})` : ""}. Treat the seller as contacted only after reading the call record in ONCALL.`;
    case "failed":
      return `The provider refused or failed the call before it connected${providerEndReason ? ` (${providerEndReason})` : ""}. The seller was not contacted.`;
    case "policy_denied":
      return "ONCALL policy denied the request before any call was placed. The seller was not contacted.";
    default:
      return `ONCALL reports status "${status}".`;
  }
}

function mapCallRecord(r) {
  const rc = r && typeof r.request_context === "object" && r.request_context ? r.request_context : {};
  return {
    id: r.id,
    to: r.to_number,
    purpose: r.purpose,
    consentBasis: r.consent_basis,
    status: r.status,
    providerCallId: r.provider_call_id || null,
    providerEndReason: r.provider_end_reason || null,
    taskRef: rc.taskRef || null,
    approvalRef: rc.approvalRef || null,
    created: r.created,
    updated: r.updated,
    // The bridge record alone never proves a conversation happened.
    contacted: false,
    summary: summarizeCallStatus(r.status, r.provider_end_reason || null),
  };
}

export class OncallCommsClient {
  /**
   * @param {object} config loadConfig() output (reads oncallCommsBaseUrl /
   *   piperOncallBridgeSecret; a raw { oncallCommsBaseUrl,
   *   piperOncallBridgeSecret } object works too).
   * @param {object} deps { fetchImpl, timeoutMs } — injectable for tests.
   */
  constructor(config = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = String(config.oncallCommsBaseUrl || "").trim().replace(/\/+$/, "");
    this.secret = config.piperOncallBridgeSecret || "";
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get isEnabled() {
    return Boolean(this.baseUrl && this.secret);
  }

  /** Whether PIPER may request calls at all on this deployment. */
  capability() {
    if (this.isEnabled) return { enabled: true, state: "enabled" };
    return {
      enabled: false,
      state: "disabled",
      detail: "ONCALL_COMMS_BASE_URL and PIPER_ONCALL_BRIDGE_SECRET are not both configured; PIPER cannot request calls.",
    };
  }

  #disabled() {
    return { ok: false, state: "disabled", error: "comms_disabled", detail: this.capability().detail };
  }

  async #send(path, { method = "GET", payload = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "x-comms-bridge-secret": this.secret,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      let body = {};
      try { body = await res.json(); } catch { body = {}; }
      return { status: res.status, body };
    } catch {
      // Network failure or timeout. Deliberately not retried (see header).
      return { status: 0, body: {} };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Request one governed seller callback.
   *
   * @param {object} req { phone, consentBasis, approvalRef, taskRef,
   *   idempotencyKey, instructions, customerName, calleeTimezone, language }
   * @returns {Promise<object>} a typed result; `state` is one of:
   *   disabled | approval_ref_required | consent_basis_not_permitted |
   *   invalid_request | queued | policy_denied | provider_failed |
   *   voice_profile_not_provisioned | outbound_disabled | unauthorized |
   *   idempotency_conflict | request_rejected | unreachable |
   *   unexpected_response. `ok` is true only when ONCALL accepted the
   *   request (201, or a 200 idempotent replay of an accepted/failed
   *   attempt — inspect `status`/`duplicate`).
   */
  async requestCallback({ phone, consentBasis, approvalRef, taskRef = null, idempotencyKey = null, instructions = null, customerName = null, calleeTimezone = null, language = null } = {}) {
    if (!this.isEnabled) return this.#disabled();

    if (!approvalRef || !String(approvalRef).trim()) {
      return {
        ok: false,
        state: "approval_ref_required",
        error: "approval_ref_required",
        detail: "ONCALL requires an approval reference for every service-originated call request; none was supplied, so nothing was sent.",
      };
    }
    if (!phone || !String(phone).trim()) {
      return { ok: false, state: "invalid_request", error: "phone_required", detail: "A destination phone number is required." };
    }
    if (!SELLER_CALLBACK_CONSENT_BASES.includes(consentBasis)) {
      return {
        ok: false,
        state: "consent_basis_not_permitted",
        error: "consent_basis_not_permitted",
        detail: `seller_callback accepts only ${SELLER_CALLBACK_CONSENT_BASES.join(" or ")}; "${consentBasis || ""}" is not permitted and the request was not sent.`,
      };
    }

    const requestContext = { approvalRef: String(approvalRef) };
    if (taskRef) requestContext.taskRef = String(taskRef);
    if (instructions) requestContext.instructions = String(instructions);
    const payload = {
      to: String(phone),
      purpose: "seller_callback",
      consentBasis,
      requestContext,
    };
    if (idempotencyKey) payload.idempotencyKey = String(idempotencyKey);
    if (customerName) payload.customerName = String(customerName);
    if (calleeTimezone) payload.calleeTimezone = String(calleeTimezone);
    if (language) payload.language = String(language);

    const { status, body } = await this.#send(REQUEST_CALL_PATH, { method: "POST", payload });

    if (status === 0) {
      return { ok: false, state: "unreachable", error: "oncall_unreachable", detail: "ONCALL could not be reached. The request was not retried; retrying with the same idempotency key is safe." };
    }
    if (status === 201) {
      return {
        ok: true,
        state: "queued",
        outboundId: body.outboundId,
        status: "queued",
        providerCallId: body.providerCallId || null,
        duplicate: false,
        contacted: false,
        summary: summarizeCallStatus("queued"),
      };
    }
    if (status === 200 && body.duplicate) {
      // Idempotent replay of an earlier attempt under the same key.
      const failed = body.status === "failed";
      return {
        ok: !failed,
        state: failed ? "provider_failed" : body.status,
        outboundId: body.outboundId,
        status: body.status,
        providerCallId: body.providerCallId || null,
        duplicate: true,
        contacted: false,
        ...(failed ? { error: "provider_call_failed" } : {}),
        summary: summarizeCallStatus(body.status),
      };
    }
    if (status === 403 && body.error === "policy_denied") {
      const reasons = Array.isArray(body.reasons) ? body.reasons : [];
      return {
        ok: false,
        state: "policy_denied",
        error: "policy_denied",
        reasons,
        outboundId: body.outboundId || null,
        contacted: false,
        summary: `ONCALL policy denied this request before any call was placed${reasons.length ? ` (${reasons.join(", ")})` : ""}. The seller was not contacted.`,
      };
    }
    if (status === 409) {
      return {
        ok: false,
        state: "idempotency_conflict",
        error: body.error || "idempotency_key_conflict",
        outboundId: body.outboundId || null,
        status: body.status || null,
        summary: "This idempotency key was already used for a different call request; ONCALL refused to alias it. No new call was placed.",
      };
    }
    if (status === 502) {
      return {
        ok: false,
        state: "provider_failed",
        error: "provider_call_failed",
        providerStatus: body.providerStatus || null,
        outboundId: body.outboundId || null,
        contacted: false,
        summary: `The provider failed the call${body.providerStatus ? ` (${body.providerStatus})` : ""} before it connected. The seller was not contacted.`,
      };
    }
    if (status === 503 && body.error === "outbound_not_configured") {
      return {
        ok: false,
        state: "voice_profile_not_provisioned",
        error: "outbound_not_configured",
        detail: "ONCALL reports its dispatch configuration incomplete. For PIPER requests this is the unprovisioned PIPER voice profile: ONCALL fails PIPER dispatch closed until the founder provisions one. No call was placed and this is not retried around.",
      };
    }
    if (status === 503 && body.error === "outbound_not_enabled") {
      return {
        ok: false,
        state: "outbound_disabled",
        error: "outbound_not_enabled",
        detail: "ONCALL outbound calling is disabled (kill switch off). No call was placed.",
      };
    }
    if (status === 401) {
      return {
        ok: false,
        state: "unauthorized",
        error: "unauthorized",
        detail: "ONCALL rejected the bridge credential (or the PIPER bridge secret is not configured on ONCALL). No call was placed.",
      };
    }
    if (status === 400) {
      return { ok: false, state: "request_rejected", error: body.error || "bad_request", detail: "ONCALL rejected the request as malformed." };
    }
    return { ok: false, state: "unexpected_response", error: body.error || `http_${status}`, detail: `ONCALL answered with an unexpected status (${status}).` };
  }

  /**
   * Read one PIPER-originated call record back from ONCALL. Records are
   * scoped server-side to the requesting agent: another requester's record
   * (or an unknown id) returns `not_found`.
   */
  async getResult(outboundId) {
    if (!this.isEnabled) return this.#disabled();
    if (!outboundId || !String(outboundId).trim()) {
      return { ok: false, state: "invalid_request", error: "outbound_id_required", detail: "An outboundId is required." };
    }
    const { status, body } = await this.#send(`${CALLS_PATH}/${encodeURIComponent(String(outboundId))}`);
    if (status === 0) return { ok: false, state: "unreachable", error: "oncall_unreachable", detail: "ONCALL could not be reached." };
    if (status === 401) return { ok: false, state: "unauthorized", error: "unauthorized", detail: "ONCALL rejected the bridge credential." };
    if (status === 404 || !body.call) {
      return { ok: false, state: "not_found", error: "not_found", detail: "No PIPER call record with that id is visible to this bridge credential." };
    }
    if (status !== 200) return { ok: false, state: "unexpected_response", error: body.error || `http_${status}` };
    return { ok: true, state: "found", call: mapCallRecord(body.call) };
  }

  /** List PIPER-originated call records, optionally filtered by taskRef. */
  async listResults({ taskRef = null } = {}) {
    if (!this.isEnabled) return this.#disabled();
    const query = taskRef ? `?taskRef=${encodeURIComponent(String(taskRef))}` : "";
    const { status, body } = await this.#send(`${CALLS_PATH}${query}`);
    if (status === 0) return { ok: false, state: "unreachable", error: "oncall_unreachable", detail: "ONCALL could not be reached." };
    if (status === 401) return { ok: false, state: "unauthorized", error: "unauthorized", detail: "ONCALL rejected the bridge credential." };
    if (status !== 200) return { ok: false, state: "unexpected_response", error: body.error || `http_${status}` };
    return { ok: true, state: "found", calls: (Array.isArray(body.calls) ? body.calls : []).map(mapCallRecord) };
  }
}
