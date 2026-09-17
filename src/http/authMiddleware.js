import { timingSafeEqual } from "node:crypto";
import { sendJson } from "./response.js";
import { verifyServiceToken } from "../auth/tokenService.js";
import { verifyCsrfToken } from "../auth/csrfService.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard for session-cookie authenticated writes.
 *
 * Bearer <redacted> (founder operator secret, S2S tokens) are not auto-attached by
 * browsers, so they need no CSRF token. Session cookies ARE auto-attached, so
 * any state-changing request authenticated via the pipeline_session cookie
 * must present the X-CSRF-Token header issued with the session.
 */
export function requireSessionCsrf(req, res, ctx) {
  if (!WRITE_METHODS.has(String(req.method || "").toUpperCase())) return true;
  if (!req.pipelineSession) return true; // not session-authenticated; nothing to guard
  const session = req.pipelineSession;
  const supplied = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"];
  if (!verifyCsrfToken(supplied, session.csrfTokenHash, session.csrfIssuedAt)) {
    sendJson(res, 403, { ok: false, error: "invalid_csrf_token" });
    return false;
  }
  return true;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookieHeader(sessionId, { secure = false, maxAgeSeconds = 900 } = {}) {
  const attributes = [
    `pipeline_session=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(60, Math.floor(maxAgeSeconds))}`
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookieHeader({ secure = false } = {}) {
  const attributes = ["pipeline_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * Validates the pipeline session cookie.
 * Clears the cookie if it is invalid, expired, or revoked.
 * Updates the last seen timestamp on success.
 */
export function authenticatePipelineSession(req, res, ctx) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.pipeline_session;
  
  if (!sessionId) {
    return null;
  }

  const session = ctx.authDbService.getSession(sessionId);
  if (!session || session.revokedAt) {
    const secure = ctx.config.env === "production" || ctx.config.pipelineEnv === "production";
    res.setHeader("Set-Cookie", clearSessionCookieHeader({ secure }));
    return null;
  }

  const now = Date.now();
  if (new Date(session.expiresAt).getTime() <= now) {
    ctx.authDbService.revokeSession(sessionId);
    const secure = ctx.config.env === "production" || ctx.config.pipelineEnv === "production";
    res.setHeader("Set-Cookie", clearSessionCookieHeader({ secure }));
    return null;
  }

  ctx.authDbService.updateSessionLastSeen(sessionId);
  return session;
}

/**
 * Founder operator bearer authentication.
 *
 * When PIPELINE_OPERATOR_SECRET is configured, `Authorization: Bearer <secret>`
 * authenticates the single founder-operator with full pipeline permissions.
 * This is the direct-access path for the standalone deployment; the OCG ONE
 * handoff remains the SSO path when integration is enabled.
 *
 * Comparison is constant-time; the secret value is never logged or returned.
 * Returns the operator auth record, or null when no valid bearer is present.
 */

const OPERATOR_PERMISSIONS = Object.freeze([
  "pipeline.read",
  "pipeline.manage",
  "pipeline.operator.preview",
  "pipeline.operator.apply",
  "pipeline.admin",
]);

export function authenticateOperatorBearer(req, config) {
  const secret = config && config.operatorSecret;
  if (!secret || secret.length < 32) return null;
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const presented = Buffer.from(header.substring(7));
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length) return null;
  let ok = false;
  try {
    ok = timingSafeEqual(presented, expected);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  return {
    actor: "founder-operator",
    userId: "founder-operator",
    subject: "founder-operator",
    roles: ["administrator"],
    permissions: [...OPERATOR_PERMISSIONS],
    via: "operator_secret",
  };
}

export function operatorPermissions() {
  return [...OPERATOR_PERMISSIONS];
}

/**
 * API authorization gate for /api/v1/*.
 *
 * Modes:
 *  1. production + OCG ONE integration enabled: service-to-service RS256
 *     token or handoff session (existing behavior, unchanged).
 *  2. operator bearer: when PIPELINE_OPERATOR_SECRET is configured, a valid
 *     `Authorization: Bearer <secret>` authenticates the founder-operator in
 *     any mode. Sets req.operatorAuth.
 *  3. production without integration and without a valid bearer: 401.
 *     Unauthenticated writes are never allowed in production (fail closed).
 *  4. development: existing localhost behavior (unauthenticated local use).
 *
 * Returns true when the request may proceed, false when a response was sent.
 */

export async function authorizeApiRequest(req, res, ctx) {
  const config = ctx.config;

  if (config.env === "production" && config.integrationEnabled) {
    let isS2S = false;
    let s2sError = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const issuer = config.handoffIssuer || "ocg-one";
      const audience = config.handoffAudience || "pipeline";
      const publicKeys = config.servicePublicKeys || {};
      const verification = await verifyServiceToken(token, {
        publicKeys,
        expectedIssuer: issuer,
        expectedAudience: audience,
      });
      if (verification.ok) {
        const scope = verification.payload.scope || "";
        const permissions = Array.isArray(verification.payload.permissions)
          ? verification.payload.permissions
          : [verification.payload.permissions];
        if (
          scope.includes("ocg-one.pipeline.read") ||
          permissions.includes("pipeline.read") ||
          permissions.includes("ocg-one.pipeline.read")
        ) {
          isS2S = true;
        } else {
          s2sError = "forbidden_insufficient_scope";
        }
      } else {
        s2sError = `forbidden_token_invalid: ${verification.reason}`;
      }
    }
    if (s2sError) {
      sendJson(res, 403, { ok: false, error: s2sError });
      return false;
    }
    if (!isS2S) {
      const session = authenticatePipelineSession(req, res, ctx);
      if (!session) {
        sendJson(res, 401, { ok: false, error: "Authentication required" });
        return false;
      }
      if (!session.permissions || !session.permissions.includes("pipeline.read")) {
        sendJson(res, 403, { ok: false, error: "forbidden_insufficient_permissions" });
        return false;
      }
      req.pipelineSession = session;
    }
    // Session-cookie writes (the OCG ONE handoff path) require a CSRF token;
    // S2S bearer requests are exempt (requireSessionCsrf checks for a session).
    return requireSessionCsrf(req, res, ctx);
  }

  const operatorAuth = authenticateOperatorBearer(req, config);
  if (operatorAuth) {
    req.operatorAuth = operatorAuth;
    return true;
  }

  if (config.env === "production") {
    sendJson(res, 401, { ok: false, error: "authentication_required" });
    return false;
  }

  // Development-local: still enforce CSRF on session-cookie writes when a
  // session is present, so the guard is exercised outside production too.
  return requireSessionCsrf(req, res, ctx);
}
