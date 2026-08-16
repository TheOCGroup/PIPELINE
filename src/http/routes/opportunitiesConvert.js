import { verifyServiceToken } from "../../auth/tokenService.js";
import { sendJson } from "../response.js";
import { randomUUID } from "node:crypto";

export async function handleConvertLead(req, res, ctx) {
  // 1. Enforce POST method
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { "Allow": "POST" });
  }


  // Conversion changes standalone data. It is unavailable unless the explicit
  // integration switch is on and the production cutover has left read-only mode.
  if (!ctx.config.integrationEnabled) {
    return sendJson(res, 403, { ok: false, error: "integration_disabled" });
  }
  if (ctx.config.readOnly === true) {
    return sendJson(res, 503, { ok: false, error: "read_only" });
  }

  // 2. Validate S2S Authorization Header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return sendJson(res, 401, { ok: false, error: "unauthorized_missing_token" });
  }
  const token = authHeader.substring(7);

  const issuer = ctx.config.handoffIssuer || "ocg-one";
  const audience = ctx.config.handoffAudience || "pipeline";
  const publicKeys = ctx.config.servicePublicKeys || {};

  const verification = await verifyServiceToken(token, { publicKeys, expectedIssuer: issuer, expectedAudience: audience });
  if (!verification.ok) {
    return sendJson(res, 403, { ok: false, error: `forbidden_token_invalid: ${verification.reason}` });
  }

  const payload = verification.payload;

  // 3. Enforce contract version check (major version 1)
  const contractVersion = payload.contract_version;
  if (!contractVersion || !contractVersion.startsWith("1.")) {
    return sendJson(res, 400, { ok: false, error: "contract_version_mismatch" });
  }

  // 4. Assert S2S permission scope
  const scope = payload.scope || "";
  const permissions = Array.isArray(payload.permissions) ? payload.permissions : [payload.permissions];
  const hasWriteScope = scope.includes("pipeline.opportunity.create") ||
                        scope.includes("ocg-one.pipeline.write") ||
                        permissions.includes("pipeline.opportunity.create") ||
                        permissions.includes("ocg-one.pipeline.write");
  if (!hasWriteScope) {
    return sendJson(res, 403, { ok: false, error: "forbidden_insufficient_scope" });
  }

  // 5. Safely parse JSON body
  let body = "";
  try {
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
      // Enforce limit of 50KB to prevent memory DOS
      const totalSize = buffers.reduce((acc, b) => acc + b.length, 0);
      if (totalSize > 50 * 1024) {
        return sendJson(res, 413, { ok: false, error: "payload_too_large" });
      }
    }
    body = Buffer.concat(buffers).toString("utf8");
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: "read_error" });
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  // 6. Enforce required parameters
  const { idempotencyKey, correlationId, sourceLeadId, sourceSystem, tenantId = "ocg-one", property, participants, sourceMessage } = data;

  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return sendJson(res, 400, { ok: false, error: "missing_idempotency_key" });
  }
  if (!correlationId || typeof correlationId !== "string") {
    return sendJson(res, 400, { ok: false, error: "missing_correlation_id" });
  }
  if (!sourceLeadId || typeof sourceLeadId !== "string") {
    return sendJson(res, 400, { ok: false, error: "missing_source_lead_id" });
  }
  if (!sourceSystem || typeof sourceSystem !== "string") {
    return sendJson(res, 400, { ok: false, error: "missing_source_system" });
  }
  if (!property || !property.externalId) {
    return sendJson(res, 400, { ok: false, error: "missing_property_external_id" });
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    return sendJson(res, 400, { ok: false, error: "missing_participants" });
  }

  const db = ctx.db;

  // 7. Duplicate Conversion Protection / Idempotency Check
  // Check if lead was already converted
  const existingSource = db.prepare(`
    SELECT opportunity_id FROM seller_opportunity_sources
    WHERE source_record_id = ? AND source_type = ?
  `).get(sourceLeadId, sourceSystem);

  if (existingSource) {
    return sendJson(res, 200, {
      ok: true,
      opportunityId: existingSource.opportunity_id,
      status: "already_converted"
    });
  }

  // Check if idempotency key was already used
  const existingAudit = db.prepare(`
    SELECT payload_json FROM operational_audit_events
    WHERE correlation_id = ? AND event_type = 'OPPORTUNITY_CONVERSION'
  `).get(idempotencyKey);

  if (existingAudit) {
    try {
      const payload = JSON.parse(existingAudit.payload_json);
      return sendJson(res, 200, {
        ok: true,
        opportunityId: payload.opportunityId,
        status: "already_converted"
      });
    } catch (_) {}
  }

  // 8. Execute conversion in a transaction
  db.exec("BEGIN TRANSACTION;");
  try {
    const opportunityId = randomUUID();
    const opportunityCode = `OPP-${Math.floor(100000 + Math.random() * 900000)}`;

    // A. Insert opportunity
    db.prepare(`
      INSERT INTO seller_opportunities (
        id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
        qualification_status, contact_status, opportunity_status, data_quality_status,
        seller_motivation_type, asking_price, seller_expected_price, property_condition_summary,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'new_lead', 'needs_review', 'uncontacted', 'active', 'raw_ingestion', ?, ?, ?, ?, 's2s', 's2s', ?, ?)
    `).run(
      opportunityId, tenantId, opportunityCode, property.externalId,
      property.motivationType || null, property.askingPrice || null, property.expectedPrice || null, property.propertyCondition || null,
      new Date().toISOString(), new Date().toISOString()
    );

    // B. Insert participants
    for (const p of participants) {
      if (!p.externalId || !p.role) {
        throw new Error("invalid_participant_data");
      }
      db.prepare(`
        INSERT INTO seller_opportunity_participants (
          id, opportunity_id, ocg_one_person_id, participant_role, is_primary,
          decision_authority_status, verification_status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, 'full_authority', 'unverified', 's2s', ?)
      `).run(
        randomUUID(), opportunityId, p.externalId, p.role, p.isPrimary ? 1 : 0, new Date().toISOString()
      );
    }

    // C. Insert source
    const sourceId = randomUUID();
    db.prepare(`
      INSERT INTO seller_opportunity_sources (
        id, opportunity_id, source_type, source_record_id, source_message_id,
        original_address, source_timestamp, conversion_actor, conversion_timestamp,
        provenance_metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 's2s', ?, ?, ?)
    `).run(
      sourceId, opportunityId, sourceSystem, sourceLeadId, sourceMessage?.sourceMessageId || null,
      property.address || null, sourceMessage?.sourceTimestamp || new Date().toISOString(),
      new Date().toISOString(), sourceMessage ? JSON.stringify(sourceMessage) : null, new Date().toISOString()
    );

    // D. Insert stage event
    db.prepare(`
      INSERT INTO seller_stage_events (
        id, opportunity_id, prior_stage, new_stage, changed_by, reason, created_at
      ) VALUES (?, ?, NULL, 'new_lead', 's2s', 'Lead converted via S2S API', ?)
    `).run(
      randomUUID(), opportunityId, new Date().toISOString()
    );

    // E. Recover provenance
    const resolvedStatus = sourceMessage?.sourceMessageId ? "original_resolved" : "unresolved";
    db.prepare(`
      INSERT INTO source_provenance (
        id, opportunity_id, original_source_json, resolution_status, recovery_attempts, last_recovery_error, resolved_at
      ) VALUES (?, ?, ?, ?, 0, NULL, ?)
    `).run(
      randomUUID(), opportunityId, JSON.stringify({ original_message_id: sourceMessage?.sourceMessageId || null }),
      resolvedStatus, resolvedStatus === "original_resolved" ? new Date().toISOString() : null
    );

    // F. Map classification
    let cls = "unknown";
    const motivation = property.motivationType || "";
    if (motivation.toLowerCase().includes("retail")) {
      cls = "retail_listing";
    } else if (motivation.toLowerCase().includes("wholesale")) {
      cls = "wholesale_target";
    } else if (motivation.toLowerCase().includes("rehab")) {
      cls = "investment_rehab";
    } else if (motivation.toLowerCase().includes("land")) {
      cls = "land_hold";
    }

    db.prepare(`
      INSERT INTO record_classifications (
        opportunity_id, classification_value, classification_rules_version, determined_at, determined_by, reason
      ) VALUES (?, ?, '1.0.0', ?, 's2s', 'Initial conversion classification')
    `).run(
      opportunityId, cls, new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO classification_history (
        id, opportunity_id, prior_classification, new_classification,
        classification_rules_version, determined_at, determined_by, reason
      ) VALUES (?, ?, NULL, ?, '1.0.0', ?, 's2s', 'Initial conversion classification')
    `).run(
      randomUUID(), opportunityId, cls, new Date().toISOString()
    );

    // G. Audit event (keyed by idempotencyKey as correlation_id)
    db.prepare(`
      INSERT INTO operational_audit_events (
        id, event_timestamp, event_type, actor_id, payload_json, correlation_id
      ) VALUES (?, ?, 'OPPORTUNITY_CONVERSION', 's2s', ?, ?)
    `).run(
      randomUUID(), new Date().toISOString(), JSON.stringify({ opportunityId, sourceLeadId, sourceSystem }), idempotencyKey
    );

    db.exec("COMMIT;");

    return sendJson(res, 201, {
      ok: true,
      opportunityId,
      opportunityCode,
      status: "converted"
    });

  } catch (err) {
    db.exec("ROLLBACK;");
    return sendJson(res, 500, { ok: false, error: "conversion_transaction_failed" });
  }
}
