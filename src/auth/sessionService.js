/**
 * PIPELINE-owned session issuance.
 *
 * A session is a PIPELINE artifact, distinct from any OCG ONE session. It is
 * minted only from an already-verified handoff identity. No session is created
 * without a session secret (fails closed). Phase 3C does not persist sessions.
 */

import { createHmac } from "node:crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class SessionService {
  constructor({ secret } = {}) {
    this.secret = secret || "";
  }

  /** @param {{subject:string, role:string}} identity */
  issue(identity, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!this.secret) throw new Error("session secret required to issue a session");
    if (!identity || !identity.subject) throw new Error("a verified identity is required");

    const payload = { sub: identity.subject, role: identity.role || "viewer", iss: "pipeline", exp: now + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(body).digest("base64url");
    return { token: `${body}.${sig}`, role: payload.role, expiresAt: payload.exp, issuer: "pipeline" };
  }
}
