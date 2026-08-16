/**
 * Read-only versioned API (/api/v1/*). GET/HEAD only — any other method is 405.
 * There are NO mutation endpoints. Errors are structured and leak no internals.
 */

import { randomUUID } from "node:crypto";
import { sendJson } from "./response.js";
import { applicationInfo } from "../app/applicationInfo.js";
import { readSchemaVersion } from "../database/migrationRunner.js";

function meta(ctx, req, extra = {}) {
  const correlationId = req.headers["x-correlation-id"] || randomUUID();
  return {
    dataSource: ctx.config.dataSource,
    demo: ctx.config.dataSource === "fixtures",
    integration: ctx.config.integrationEnabled ? "enabled" : "disabled",
    correlationId,
    ...extra,
  };
}

export async function handleApi(req, res, ctx, url) {
  const pathname = url.pathname;
  const seg = pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const q = url.searchParams;

  // Determine if this is a known read resource endpoint
  let isKnown = false;
  if (seg[0] === "opportunities" && (seg.length === 1 || seg.length === 2)) {
    isKnown = true;
  } else if (seg[0] === "provenance" && seg.length === 1) {
    isKnown = true;
  } else if (seg[0] === "classifications" && seg.length === 1) {
    isKnown = true;
  } else if (seg[0] === "data-quality" && seg.length === 1) {
    isKnown = true;
  } else if (seg[0] === "system" && seg[1] === "status" && seg.length === 2) {
    isKnown = true;
  }

  if (!isKnown) {
    return sendJson(res, 404, { ok: false, error: "not_found", meta: meta(ctx, req) });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed", meta: meta(ctx, req) }, { "Allow": "GET, HEAD" });
  }

  try {
    if (seg[0] === "opportunities" && seg.length === 1) {
      const result = await ctx.services.opportunities.list({
        filters: {
          stage: q.get("stage"), provenanceState: q.get("provenanceState"),
          classification: q.get("classification"), assignedOperator: q.get("assignedOperator"),
          status: q.get("status"),
        },
        page: q.get("page"), pageSize: q.get("pageSize"),
      });
      return sendJson(res, 200, {
        ok: true,
        meta: meta(ctx, req, { pagination: result.pagination, appliedFilters: result.appliedFilters }),
        data: result.items,
      });
    }

    if (seg[0] === "opportunities" && seg.length === 2) {
      const detail = await ctx.services.opportunities.getById(seg[1]);
      return sendJson(res, 200, { ok: true, meta: meta(ctx, req), data: detail });
    }

    if (seg[0] === "provenance" && seg.length === 1) {
      return sendJson(res, 200, { ok: true, meta: meta(ctx, req), data: await ctx.services.provenance.list() });
    }

    if (seg[0] === "classifications" && seg.length === 1) {
      const [current, history] = await Promise.all([
        ctx.services.classifications.list(),
        ctx.services.classifications.history(),
      ]);
      return sendJson(res, 200, { ok: true, meta: meta(ctx, req), data: { current, history } });
    }

    if (seg[0] === "data-quality" && seg.length === 1) {
      return sendJson(res, 200, { ok: true, meta: meta(ctx, req), data: await ctx.services.dataQuality.summarize() });
    }

    if (seg[0] === "system" && seg[1] === "status" && seg.length === 2) {
      return sendJson(res, 200, {
        ok: true, meta: meta(ctx, req),
        data: {
          name: applicationInfo.name,
          version: applicationInfo.version,
          schemaVersion: readSchemaVersion(ctx.db),
          runtimeMode: ctx.config.env,
          dataSource: ctx.config.dataSource,
          demo: ctx.config.dataSource === "fixtures",
          database: "available",
          integration: ctx.config.integrationEnabled ? "enabled" : "disabled",
          handoff: ctx.config.integrationEnabled && Object.keys(ctx.config.handoffPublicKeys || {}).length > 0 ? "configured" : "disabled",
          apiContractVersion: applicationInfo.integrationContractVersion,
        },
      });
    }

    return sendJson(res, 404, { ok: false, error: "not_found", meta: meta(ctx, req) });
  } catch (err) {
    const status = err.status || 500;
    const body = { ok: false, error: err.code || "internal_error", meta: meta(ctx, req) };
    if (err.field) body.field = err.field;
    if (status === 500) return sendJson(res, 500, { ok: false, error: "internal_error", meta: meta(ctx, req) });
    return sendJson(res, status, body);
  }
}
