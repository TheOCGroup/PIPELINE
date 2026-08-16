import { sendJson } from "../response.js";
import { generateCsrfToken, hashCsrfToken, verifyCsrfToken } from "../../auth/csrfService.js";
import { authenticatePipelineSession, clearSessionCookieHeader } from "../authMiddleware.js";

export function handleGetSession(req, res, ctx) {
  const session = authenticatePipelineSession(req, res, ctx);
  if (!session) {
    return sendJson(res, 401, { ok: false, error: "Authentication required" });
  }

  // Generate fresh CSRF token
  const csrfToken = generateCsrfToken();
  const csrfHash = hashCsrfToken(csrfToken);

  // Update session record
  ctx.authDbService.updateSessionCsrf(session.id, csrfHash);

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  return res.end(JSON.stringify({
    ok: true,
    csrfToken,
    session: {
      displayName: session.displayName,
      email: session.email,
      roles: session.roles,
      permissions: session.permissions,
      expiresAt: session.expiresAt,
      issuer: session.issuer
    }
  }));
}

export function handlePostLogout(req, res, ctx) {
  const session = authenticatePipelineSession(req, res, ctx);
  const secure = ctx.config.env === "production" || ctx.config.pipelineEnv === "production";

  if (!session) {
    // Idempotent success even if already logged out/cookie expired
    res.writeHead(200, {
      "Set-Cookie": clearSessionCookieHeader({ secure }),
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });
    return res.end(JSON.stringify({ ok: true, loggedOut: true }));
  }

  // Validate CSRF token
  const suppliedCsrf = req.headers["x-csrf-token"];
  if (!suppliedCsrf || !verifyCsrfToken(suppliedCsrf, session.csrfTokenHash, session.csrfIssuedAt)) {
    return sendJson(res, 403, { ok: false, error: "invalid_csrf_token" });
  }

  ctx.authDbService.revokeSession(session.id);

  res.writeHead(200, {
    "Set-Cookie": clearSessionCookieHeader({ secure }),
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  return res.end(JSON.stringify({ ok: true, loggedOut: true }));
}
