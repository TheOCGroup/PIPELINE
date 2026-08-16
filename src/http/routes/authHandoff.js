import { sendJson } from "../response.js";
import { verifyAndMapHandoffToken } from "../../auth/handoffTokenVerifier.js";
import { sessionCookieHeader } from "../authMiddleware.js";
import { randomBytes } from "node:crypto";
import { parse } from "node:querystring";

export async function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", err => reject(err));
  });
}

export async function handleAuthHandoff(req, res, ctx) {
  const { config, authDbService } = ctx;

  if (!config.integrationEnabled) {
    return sendJson(res, 403, { ok: false, error: "integration_disabled" });
  }

  // Reject non-JSON / non-form Content-Type
  const contentType = req.headers["content-type"] || "";
  const isJson = contentType.includes("application/json");
  const isForm = contentType.includes("application/x-www-form-urlencoded");

  if (!isJson && !isForm) {
    return sendJson(res, 415, { ok: false, error: "unsupported_media_type" });
  }

  let bodyStr;
  try {
    bodyStr = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, error: err.message });
  }

  let body = {};
  try {
    if (isJson) {
      body = JSON.parse(bodyStr || "{}");
    } else {
      body = parse(bodyStr);
    }
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_body" });
  }

  // Read token from POST body only
  const token = body.token;
  if (!token) {
    return sendJson(res, 401, { ok: false, error: "missing_token" });
  }

  // Perform token verification and mapping
  const verification = await verifyAndMapHandoffToken(token, {
    publicKeys: config.handoffPublicKeys,
    expectedIssuer: config.handoffIssuer,
    expectedAudience: config.handoffAudience
  });

  if (!verification.ok) {
    return sendJson(res, 401, { ok: false, error: verification.reason });
  }

  const { identity } = verification;

  // Validate destination
  let redirectDest = "/";
  if (identity.destination && isValidDestination(identity.destination)) {
    redirectDest = identity.destination;
  }

  // Generate cryptographically random opaque session ID
  const sessionId = randomBytes(32).toString("hex");

  const sessionData = {
    id: sessionId,
    externalUserId: identity.subject,
    displayName: identity.displayName,
    email: identity.email,
    roles: identity.roles,
    permissions: identity.permissions,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 mins absolute expiry
  };

  try {
    // Perform transaction
    await authDbService.executeHandoffTransaction({
      jti: identity.jti,
      issuer: config.handoffIssuer,
      subject: identity.subject,
      expiresAt: new Date(identity.exp * 1000).toISOString(),
      session: sessionData,
      correlationId: req.headers["x-correlation-id"] || null
    });
  } catch (err) {
    if (err.message === "nonce_already_consumed") {
      return sendJson(res, 401, { ok: false, error: "nonce_replayed" });
    }
    return sendJson(res, 500, { ok: false, error: "auth_failed" });
  }

  // Session Cookie
  const secure = config.env === "production" || config.pipelineEnv === "production";
  const sessionCookie = sessionCookieHeader(sessionId, { secure });

  // Browser forms must leave the handoff endpoint after the cookie is minted.
  // JSON callers retain the documented response body for programmatic use.
  if (isForm) {
    res.writeHead(303, {
      "Set-Cookie": sessionCookie,
      "Location": redirectDest,
      "Cache-Control": "no-store"
    });
    return res.end();
  }

  res.writeHead(200, {
    "Set-Cookie": sessionCookie,
    "Content-Type": "application/json"
  });
  return res.end(JSON.stringify({
    ok: true,
    destination: redirectDest,
    subject: identity.subject,
    roles: identity.roles,
    permissions: identity.permissions
  }));
}

export function isValidDestination(dest) {
  if (typeof dest !== "string" || !dest) return false;
  // Reject absolute URLs, protocol-relative, backslash, control characters, URL encoding, query strings
  if (dest.includes(":") || dest.includes("\\") || dest.includes("//") || dest.includes("%") || dest.includes("?") || dest.includes("\r") || dest.includes("\n")) {
    return false;
  }
  const ALLOWED_STATIC = new Set(["/", "/opportunities", "/provenance", "/classifications", "/data-quality", "/system"]);
  if (ALLOWED_STATIC.has(dest)) return true;
  if (dest.startsWith("/opportunities/")) {
    const parts = dest.split("/");
    if (parts.length === 3 && parts[0] === "" && parts[1] === "opportunities" && /^[A-Za-z0-9_-]+$/.test(parts[2])) {
      return true;
    }
  }
  return false;
}
