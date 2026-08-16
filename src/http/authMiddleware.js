
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookieHeader(sessionId, { secure = false } = {}) {
  const attributes = [
    `pipeline_session=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=900"
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
