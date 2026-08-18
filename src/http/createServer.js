/**
 * PIPELINE HTTP server.
 *
 * - GET /health, GET /version           liveness / identity
 * - GET /app.js, /styles.css            static assets
 * - GET /api/v1/*                        read-only JSON API (GET/HEAD only)
 * - POST /auth/handoff                   fail-closed handoff stub
 * - any other GET                        SPA shell (index.html) — client routes
 *                                        like /opportunities render in the app
 * Non-GET on non-API paths -> 405. Errors return deterministic codes only.
 */

import { createServer as httpCreateServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";

import { sendJson, sendHtml, sendAsset } from "./response.js";
import { healthPayload } from "./routes/health.js";
import { versionPayload } from "./routes/version.js";
import { handleAuthHandoff } from "./routes/authHandoff.js";
import { handleApi } from "./apiRouter.js";

import { createAuthDatabaseService } from "../auth/authDatabaseService.js";
import { authenticatePipelineSession } from "./authMiddleware.js";
import { handleGetSession, handlePostLogout } from "./routes/authRoutes.js";
import { handleConvertLead } from "./routes/opportunitiesConvert.js";
import { verifyServiceToken } from "../auth/tokenService.js";
import { handleDealFindrIntake } from "./routes/dealFindrIntake.js";
import { authorizePiperIntake } from "./routes/piperIntakeAuthorization.js";
import { handleOperatorRoutes } from "./routes/operatorRoutes.js";
import { handlePiperRoutes } from "./routes/piperRoutes.js";


const STATIC = {
  "/app.js": "application/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/reactor-runtime-fixes.css": "text/css; charset=utf-8",
  "/reactor-tone-lock.css": "text/css; charset=utf-8",
};

function readPublic(publicDir, file) {
  return readFileSync(normalize(join(publicDir, file)));
}

export function createServer(ctx) {
  const { publicDir } = ctx;

  // Initialize auth db service
  ctx.authDbService = createAuthDatabaseService(ctx.db);

  return httpCreateServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad_request" });
    }
    const path = url.pathname;

    try {
      // 1. Health endpoint (GET/HEAD only)
      if (path === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "GET, HEAD" });
        }
        return sendJson(res, 200, healthPayload(ctx));
      }

      // 2. Version endpoint (GET/HEAD only)
      if (path === "/version") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "GET, HEAD" });
        }
        return sendJson(res, 200, versionPayload(ctx));
      }

      // 3. API versioned boundary
      if (path.startsWith("/api/")) {
        if (path === "/api/integrations/deal-findr/intake") {
          if (req.method !== "POST") {
            return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "POST" });
          }
          const authorization = authorizePiperIntake(req, ctx.config);
          if (!authorization.ok) {
            return sendJson(res, authorization.status, { ok: false, error: authorization.error });
          }
          return handleDealFindrIntake(req, res, ctx);
        }

        if (path === "/api/v1" || path.startsWith("/api/v1/")) {
          if (path === "/api/v1/auth/session") {
            if (req.method !== "GET" && req.method !== "HEAD") {
              return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "GET, HEAD" });
            }
            return handleGetSession(req, res, ctx);
          }
          if (path === "/api/v1/auth/logout") {
            if (req.method !== "POST") {
              return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "POST" });
            }
            return handlePostLogout(req, res, ctx);
          }

          if (path === "/api/v1/opportunities/convert") {
            return handleConvertLead(req, res, ctx);
          }

          if (path !== "/api/v1/system/status" && path !== "/api/v1/opportunities/convert") {
            if (ctx.config.env === "production" && ctx.config.integrationEnabled) {
              let isS2S = false;
              let s2sError = null;
              const authHeader = req.headers.authorization;
              if (authHeader && authHeader.startsWith("Bearer ")) {
                const token = authHeader.substring(7);
                const issuer = ctx.config.handoffIssuer || "ocg-one";
                const audience = ctx.config.handoffAudience || "pipeline";
                const publicKeys = ctx.config.servicePublicKeys || {};
                const verification = await verifyServiceToken(token, { publicKeys, expectedIssuer: issuer, expectedAudience: audience });
                if (verification.ok) {
                  const scope = verification.payload.scope || "";
                  const permissions = Array.isArray(verification.payload.permissions) ? verification.payload.permissions : [verification.payload.permissions];
                  if (scope.includes("ocg-one.pipeline.read") || permissions.includes("pipeline.read") || permissions.includes("ocg-one.pipeline.read")) {
                    isS2S = true;
                  } else {
                    s2sError = "forbidden_insufficient_scope";
                  }
                } else {
                  s2sError = `forbidden_token_invalid: ${verification.reason}`;
                }
              }

              if (s2sError) {
                return sendJson(res, 403, { ok: false, error: s2sError });
              }

              if (!isS2S) {
                const session = authenticatePipelineSession(req, res, ctx);
                if (!session) {
                  return sendJson(res, 401, { ok: false, error: "Authentication required" });
                }
                if (!session.permissions || !session.permissions.includes("pipeline.read")) {
                  return sendJson(res, 403, { ok: false, error: "forbidden_insufficient_permissions" });
                }
                req.pipelineSession = session;
              }
            }
          }

          const seg = path.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
          if (seg[0] === "operator") {
            if (await handleOperatorRoutes(req, res, ctx, url, seg)) return;
          }
          if (seg[0] === "piper") {
            if (await handlePiperRoutes(req, res, ctx, url, seg)) return;
          }

          return handleApi(req, res, ctx, url);
        }
        return sendJson(res, 404, { ok: false, error: "not_found" });
      }

      if (path === "/auth/handoff") {
        if (req.method !== "POST") {
          return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "POST" });
        }
        return handleAuthHandoff(req, res, ctx);
      }

      if (path.startsWith("/auth/")) {
        return sendJson(res, 404, { ok: false, error: "not_found" });
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "GET, HEAD" });
      }

      if (STATIC[path]) {
        return sendAsset(res, 200, readPublic(publicDir, path.slice(1)), STATIC[path]);
      }

      return sendHtml(res, 200, readPublic(publicDir, "index.html").toString("utf8"));
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: "internal_error" });
    }
  });
}
