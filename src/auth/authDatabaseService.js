import { createHash } from "node:crypto";

export function createAuthDatabaseService(db) {
  const hashJti = (jti) => createHash("sha256").update(String(jti || "")).digest("hex");

  return {
    /**
     * Executes the user handoff atomically: nonce verification/insertion, session creation, and audit logging.
     * Everything is committed in a single database transaction.
     */
    executeHandoffTransaction({
      jti,
      issuer,
      subject,
      expiresAt,
      session, // { id, externalUserId, displayName, email, roles, permissions, expiresAt }
      correlationId
    }) {
      const now = new Date().toISOString();
      const jtiHash = hashJti(jti);

      db.exec("BEGIN IMMEDIATE");
      try {
        // 1. Replay check and insertion of nonce
        const existingNonce = db.prepare(
          "SELECT 1 FROM pipeline_handoff_nonces WHERE issuer = ? AND jti = ?"
        ).get(issuer, jti);

        if (existingNonce) {
          throw new Error("nonce_already_consumed");
        }

        db.prepare(`
          INSERT INTO pipeline_handoff_nonces (jti, issuer, subject, expires_at, consumed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(jti, issuer, subject, expiresAt, now, now);

        // 2. Create the PIPELINE session
        db.prepare(`
          INSERT INTO pipeline_sessions (
            id, external_user_id, issuer, display_name, email,
            roles_json, permissions_json, csrf_token_hash, csrf_issued_at,
            created_at, expires_at, last_seen_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)
        `).run(
          session.id,
          session.externalUserId,
          issuer,
          session.displayName,
          session.email,
          JSON.stringify(session.roles),
          JSON.stringify(session.permissions),
          now,
          session.expiresAt,
          now
        );

        // 3. Write successful audit log
        const auditId = "aud-" + Math.random().toString(36).substring(2, 11);
        db.prepare(`
          INSERT INTO pipeline_auth_audit (
            id, event_type, external_user_id, session_id, jti_hash,
            issuer, correlation_id, result, reason_code, created_at
          ) VALUES (?, 'user_handoff_login', ?, ?, ?, ?, ?, 'Success', 'handoff_completed', ?)
        `).run(auditId, subject, session.id, jtiHash, issuer, correlationId || null, now);

        db.exec("COMMIT");
        return { success: true };
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (_) {}

        // Best-effort failed authentication audit trail (recorded outside the main transaction)
        try {
          const auditId = "aud-" + Math.random().toString(36).substring(2, 11);
          const reason = err.message === "nonce_already_consumed" ? "nonce_replayed" : "transaction_failed";
          db.prepare(`
            INSERT INTO pipeline_auth_audit (
              id, event_type, external_user_id, session_id, jti_hash,
              issuer, correlation_id, result, reason_code, created_at
            ) VALUES (?, 'user_handoff_login', ?, NULL, ?, ?, ?, 'Failure', ?, CURRENT_TIMESTAMP)
          `).run(auditId, subject || "unknown", jtiHash, issuer, correlationId || null, reason);
        } catch (_) {}

        throw err;
      }
    },

    getSession(sessionId) {
      try {
        const row = db.prepare("SELECT * FROM pipeline_sessions WHERE id = ?").get(sessionId);
        if (!row) return null;
        return {
          id: row.id,
          externalUserId: row.external_user_id,
          issuer: row.issuer,
          displayName: row.display_name,
          email: row.email,
          roles: JSON.parse(row.roles_json),
          permissions: JSON.parse(row.permissions_json),
          csrfTokenHash: row.csrf_token_hash,
          csrfIssuedAt: row.csrf_issued_at,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastSeenAt: row.last_seen_at,
          revokedAt: row.revoked_at
        };
      } catch (_) {
        return null;
      }
    },

    updateSessionLastSeen(sessionId) {
      const now = new Date().toISOString();
      db.prepare("UPDATE pipeline_sessions SET last_seen_at = ? WHERE id = ?").run(now, sessionId);
    },

    updateSessionCsrf(sessionId, csrfTokenHash) {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE pipeline_sessions 
        SET csrf_token_hash = ?, csrf_issued_at = ? 
        WHERE id = ?
      `).run(csrfTokenHash, now, sessionId);
    },

    revokeSession(sessionId) {
      const now = new Date().toISOString();
      db.prepare("UPDATE pipeline_sessions SET revoked_at = ? WHERE id = ?").run(now, sessionId);
    },

    cleanupExpired() {
      const now = new Date().toISOString();
      db.prepare("DELETE FROM pipeline_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
      db.prepare("DELETE FROM pipeline_handoff_nonces WHERE expires_at <= ?").run(now);
    }
  };
}
