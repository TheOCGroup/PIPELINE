/**
 * Founder opportunity endpoints — /api/v1/opportunities/*
 *
 *  POST /api/v1/opportunities             create an opportunity (manual entry)
 *  POST /api/v1/opportunities/:id/stage   move the opportunity between stages
 *  POST /api/v1/opportunities/:id/contacts add a seller contact to the lead
 *
 * Writes require the operator gate (createServer): in production the
 * founder-operator bearer (or an integration session) must be present;
 * PIPELINE_READ_ONLY=true returns 503. Every mutation is transactional and
 * writes an append-only audit trail (seller_stage_events, operational_audit_events).
 */

import { randomUUID } from "node:crypto";
import { sendJson } from "../response.js";
import { STAGES, CLOSED_STAGES } from "../../domain/stages/stageModel.js";
import { persistSellerContact } from "../../services/sellerContactService.js";

const MAX_TEXT = 4000;

class BadRequest extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function readJson(req, { maxBytes = 256 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new BadRequest("body_too_large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest("invalid_json");
  }
}

function text(value, field, { required = true, max = MAX_TEXT } = {}) {
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v && required) throw new BadRequest(`missing_${field}`);
  if (v.length > max) throw new BadRequest(`${field}_too_long`);
  return v || null;
}

function num(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadRequest(`invalid_${field}`);
  return n;
}

const actorOf = (req) =>
  req.operatorAuth?.actor || req.pipelineSession?.userId || req.pipelineSession?.subject || "local-operator";

const ok = (res, payload, status = 200) => sendJson(res, status, { ok: true, ...payload });

const VALID_CLASSIFICATIONS = new Set([
  "retail_listing",
  "wholesale_target",
  "investment_rehab",
  "land_hold",
  "disqualified",
  "unknown",
]);

function normalizeAddress(address) {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

function findDuplicate(db, { apn, normalizedAddress }) {
  try {
    if (apn) {
      const byApn = db
        .prepare(
          `SELECT opportunity_id FROM seller_opportunity_sources
           WHERE JSON_EXTRACT(provenance_metadata_json, '$.apn') = ?`
        )
        .get(apn);
      if (byApn) return { opportunityId: byApn.opportunity_id, matchType: "apn" };
    }
    const byAddress = db
      .prepare(
        `SELECT opportunity_id FROM seller_opportunity_sources
         WHERE LOWER(original_address) = ?`
      )
      .get(normalizedAddress);
    if (byAddress) return { opportunityId: byAddress.opportunity_id, matchType: "normalized_address" };
  } catch (err) {
    console.error("Opportunity dedupe query failed:", err.message);
  }
  return null;
}

function newOpportunityIds() {
  return {
    opportunityId: "opp_" + randomUUID().replace(/-/g, "").substring(0, 12),
    opportunityCode: "OPP-" + Math.floor(100000 + Math.random() * 900000),
    propertyId: "prop_" + randomUUID().replace(/-/g, "").substring(0, 12),
  };
}

function auditEvent(db, { eventType, actor, payload, correlationId }) {
  db.prepare(
    `INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), new Date().toISOString(), eventType, actor, JSON.stringify(payload), correlationId || randomUUID());
}

async function handleCreate(req, res, ctx) {
  const body = await readJson(req);
  const address = text(body.address, "address", { max: 500 });
  const normalizedAddress = normalizeAddress(address);
  const apn = text(body.apn, "apn", { required: false, max: 60 });
  const classification = body.classification && VALID_CLASSIFICATIONS.has(body.classification)
    ? body.classification
    : "unknown";

  const duplicate = findDuplicate(ctx.db, { apn, normalizedAddress });
  if (duplicate) {
    return ok(res, {
      duplicate: true,
      opportunityId: duplicate.opportunityId,
      matchType: duplicate.matchType,
    });
  }

  const { opportunityId, opportunityCode, propertyId } = newOpportunityIds();
  const actor = actorOf(req);
  const now = new Date().toISOString();
  const askingPrice = num(body.askingPrice, "askingPrice");
  const provenanceMetadata = {
    originSystem: "pipeline",
    originAgent: "founder-operator",
    entryChannel: "manual_entry",
    apn: apn || null,
    city: text(body.city, "city", { required: false, max: 120 }),
    state: text(body.state, "state", { required: false, max: 60 }),
    zip: text(body.zip, "zip", { required: false, max: 20 }),
    sourceNote: text(body.source, "source", { required: false, max: 500 }),
  };

  const db = ctx.db;
  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare(
      `INSERT INTO seller_opportunities (
         id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
         qualification_status, contact_status, opportunity_status, data_quality_status,
         seller_motivation_type, asking_price, property_condition_summary,
         created_by, updated_by
       ) VALUES (?, 'pipeline', ?, ?, 'new_lead',
         'needs_review', 'uncontacted', 'active', 'raw_ingestion',
         ?, ?, ?, ?, ?)`
    ).run(
      opportunityId,
      opportunityCode,
      propertyId,
      text(body.motivation, "motivation", { required: false, max: 200 }),
      askingPrice,
      text(body.notes, "notes", { required: false, max: 2000 }),
      actor,
      actor
    );

    db.prepare(
      `INSERT INTO seller_opportunity_sources (
         id, opportunity_id, source_type, source_record_id, source_message_id,
         original_address, source_timestamp, conversion_actor, conversion_timestamp,
         provenance_metadata_json
       ) VALUES (?, ?, 'manual_entry', ?, NULL, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      opportunityId,
      null,
      normalizedAddress,
      now,
      actor,
      now,
      JSON.stringify(provenanceMetadata)
    );

    db.prepare(
      `INSERT INTO source_provenance (id, opportunity_id, original_source_json, resolution_status)
       VALUES (?, ?, ?, 'manually_resolved')`
    ).run(
      randomUUID(),
      opportunityId,
      JSON.stringify({ source: "manual_entry", enteredBy: actor, apn: apn || null })
    );

    db.prepare(
      `INSERT INTO record_classifications
         (opportunity_id, classification_value, classification_rules_version, determined_by, reason)
       VALUES (?, ?, '1.0.0', ?, ?)`
    ).run(opportunityId, classification, actor, "Founder classification at manual entry");

    db.prepare(
      `INSERT INTO classification_history
         (id, opportunity_id, prior_classification, new_classification,
          classification_rules_version, determined_by, reason)
       VALUES (?, ?, NULL, ?, '1.0.0', ?, ?)`
    ).run(randomUUID(), opportunityId, classification, actor, "Founder classification at manual entry");

    db.prepare(
      `INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
       VALUES (?, ?, NULL, 'new_lead', ?, 'Manual opportunity creation')`
    ).run(randomUUID(), opportunityId, actor);

    const contact = persistSellerContact(db, opportunityId, {
      name: text(body.sellerName, "sellerName", { required: false, max: 200 }),
      phone: text(body.sellerPhone, "sellerPhone", { required: false, max: 60 }),
      email: text(body.sellerEmail, "sellerEmail", { required: false, max: 200 }),
      role: "primary_owner",
      actor,
    });

    auditEvent(db, {
      eventType: "MANUAL_OPPORTUNITY_CREATED",
      actor,
      payload: { opportunityId, opportunityCode, address: normalizedAddress, classification, contactId: contact?.id || null },
    });

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    console.error("Manual opportunity creation failed:", err.message);
    return sendJson(res, 500, { ok: false, error: "opportunity_create_failed" });
  }

  return ok(res, { opportunityId, opportunityCode, stage: "new_lead" }, 201);
}

async function handleStageMove(req, res, ctx, opportunityId) {
  const body = await readJson(req);
  const stage = text(body.stage, "stage", { max: 60 });
  if (!STAGES.includes(stage)) {
    return sendJson(res, 400, { ok: false, error: "invalid_stage" });
  }
  const reason = text(body.reason, "reason", { required: false, max: 1000 });
  const actor = actorOf(req);
  const db = ctx.db;

  const opp = db.prepare("SELECT id, pipeline_stage FROM seller_opportunities WHERE id = ?").get(opportunityId);
  if (!opp) return sendJson(res, 404, { ok: false, error: "opportunity_not_found" });
  if (opp.pipeline_stage === stage) {
    return ok(res, { opportunityId, stage, moved: false });
  }
  // Reopening a terminal record is a deliberate act — require a reason.
  if (CLOSED_STAGES.has(opp.pipeline_stage) && !CLOSED_STAGES.has(stage) && !reason) {
    return sendJson(res, 409, { ok: false, error: "reopen_requires_reason" });
  }

  const now = new Date().toISOString();
  // opportunity_status has its own CHECK vocabulary, distinct from stages.
  const STATUS_BY_STAGE = {
    under_contract: "under_contract",
    closed: "closed_purchased",
    disqualified: "closed_disqualified",
    lost: "closed_lost",
    archived: "archived",
  };
  const opportunityStatus = STATUS_BY_STAGE[stage] || "active";
  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare(
      `INSERT INTO seller_stage_events (id, opportunity_id, prior_stage, new_stage, changed_by, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), opportunityId, opp.pipeline_stage, stage, actor, reason);

    db.prepare(
      `UPDATE seller_opportunities
       SET pipeline_stage = ?, opportunity_status = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`
    ).run(stage, opportunityStatus, actor, now, opportunityId);

    auditEvent(db, {
      eventType: "OPPORTUNITY_STAGE_MOVED",
      actor,
      payload: { opportunityId, priorStage: opp.pipeline_stage, newStage: stage, reason: reason || null },
    });

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    console.error("Stage move failed:", err.message);
    return sendJson(res, 500, { ok: false, error: "stage_move_failed" });
  }

  return ok(res, { opportunityId, priorStage: opp.pipeline_stage, stage, moved: true });
}

async function handleAddContact(req, res, ctx, opportunityId) {
  const body = await readJson(req);
  const db = ctx.db;
  const opp = db.prepare("SELECT id FROM seller_opportunities WHERE id = ?").get(opportunityId);
  if (!opp) return sendJson(res, 404, { ok: false, error: "opportunity_not_found" });

  const actor = actorOf(req);
  db.exec("BEGIN TRANSACTION;");
  let contact;
  try {
    contact = persistSellerContact(db, opportunityId, {
      name: text(body.name, "name", { required: false, max: 200 }),
      phone: text(body.phone, "phone", { required: false, max: 60 }),
      email: text(body.email, "email", { required: false, max: 200 }),
      role: text(body.role, "role", { required: false, max: 40 }) || "primary_owner",
      actor,
    });
    if (!contact) {
      db.exec("ROLLBACK;");
      return sendJson(res, 400, { ok: false, error: "missing_contact_identity" });
    }
    auditEvent(db, {
      eventType: "SELLER_CONTACT_ADDED",
      actor,
      payload: { opportunityId, contactId: contact.id, role: contact.role },
    });
    db.exec("COMMIT;");
  } catch (err) {
    try { db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
    console.error("Add contact failed:", err.message);
    return sendJson(res, 500, { ok: false, error: "contact_add_failed" });
  }

  return ok(res, { contact }, 201);
}

export async function handleOpportunityRoutes(req, res, ctx, url, segments) {
  // segments: ["opportunities", ...]
  const [, id, action] = segments;

  if (!id) {
    if (req.method === "POST") {
      if (ctx.config.readOnly === true) {
        sendJson(res, 503, { ok: false, error: "read_only" });
        return true;
      }
      try {
        await handleCreate(req, res, ctx);
      } catch (err) {
        if (err instanceof BadRequest) {
          sendJson(res, 400, { ok: false, error: err.code });
          return true;
        }
        throw err;
      }
      return true;
    }
    return false; // GET list is served by the read API (apiRouter)
  }

  if (action === "stage" && req.method === "POST") {
    if (ctx.config.readOnly === true) {
      sendJson(res, 503, { ok: false, error: "read_only" });
      return true;
    }
    try {
      await handleStageMove(req, res, ctx, id);
    } catch (err) {
      if (err instanceof BadRequest) {
        sendJson(res, 400, { ok: false, error: err.code });
        return true;
      }
      throw err;
    }
    return true;
  }

  if (action === "contacts" && req.method === "POST") {
    if (ctx.config.readOnly === true) {
      sendJson(res, 503, { ok: false, error: "read_only" });
      return true;
    }
    try {
      await handleAddContact(req, res, ctx, id);
    } catch (err) {
      if (err instanceof BadRequest) {
        sendJson(res, 400, { ok: false, error: err.code });
        return true;
      }
      throw err;
    }
    return true;
  }

  // Known write sub-resources: anything other than POST is 405.
  if (id && (action === "stage" || action === "contacts")) {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
    return true;
  }

  return false; // not ours — fall through to the read API
}
