import { sendJson } from "../response.js";
import { randomUUID } from "node:crypto";

export async function handleDealFindrIntake(req, res, ctx) {
  // Read body
  let body = "";
  try {
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    body = Buffer.concat(buffers).toString("utf8");
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: "read_error" });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  const { address, apn, askingPrice, arv, rehab, sellerName, phone, email } = payload;
  if (!address) {
    return sendJson(res, 400, { ok: false, error: "missing_address" });
  }

  // Address Normalization
  const normalizedAddress = address.trim().toLowerCase().replace(/\s+/g, " ");

  const db = ctx.db;

  // Check for duplicates in SQLite
  let existingOpp = null;
  try {
    existingOpp = db.prepare(`
      SELECT opportunity_id FROM seller_opportunity_sources 
      WHERE LOWER(original_address) = ?
    `).get(normalizedAddress);
  } catch (err) {
    console.error("Deal Findr duplicate check failed.");
  }

  if (existingOpp) {
    // Reconcile and log audit event
    try {
      db.prepare(`
        INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
        VALUES (?, ?, 'DEAL_FINDR_DUPLICATE_RECONCILED', 'deal-findr', ?, ?)
      `).run(
        randomUUID(), 
        new Date().toISOString(), 
        JSON.stringify({ address, normalizedAddress, opportunityId: existingOpp.opportunity_id }),
        randomUUID()
      );
    } catch (_) {}

    return sendJson(res, 200, { ok: true, duplicate: true, opportunityId: existingOpp.opportunity_id });
  }

  // Insert new lead into SQLite
  const opportunityId = "opp_" + randomUUID().replace(/-/g, "").substring(0, 12);
  const opportunityCode = "OPP-" + Math.floor(100000 + Math.random() * 900000);
  const propertyId = "prop_" + randomUUID().replace(/-/g, "").substring(0, 12);

  db.exec("BEGIN TRANSACTION;");
  try {
    // Insert into seller_opportunities
    db.prepare(`
      INSERT INTO seller_opportunities (
        id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
        qualification_status, contact_status, opportunity_status, data_quality_status,
        asking_price, property_condition_summary, created_by, updated_by
      ) VALUES (?, 'ocg-one', ?, ?, 'new_lead', 'needs_review', 'uncontacted', 'active', 'raw_ingestion', ?, ?, 'deal-findr', 'deal-findr')
    `).run(opportunityId, opportunityCode, propertyId, askingPrice || null, "Ingested via Deal Findr");

    // Insert source
    db.prepare(`
      INSERT INTO seller_opportunity_sources (
        id, opportunity_id, source_type, source_record_id, source_message_id,
        original_address, source_timestamp, conversion_actor
      ) VALUES (?, ?, 'deal_scout_handoff', ?, ?, ?, ?, 'deal-findr')
    `).run(
      randomUUID(), opportunityId, propertyId, apn || null, 
      normalizedAddress, new Date().toISOString()
    );

    // Insert provenance
    db.prepare(`
      INSERT INTO source_provenance (
        id, opportunity_id, original_source_json, resolution_status
      ) VALUES (?, ?, ?, 'original_resolved')
    `).run(randomUUID(), opportunityId, JSON.stringify({ source: "deal-findr", apn }));

    // Insert classification
    db.prepare(`
      INSERT INTO record_classifications (
        opportunity_id, classification_value, classification_rules_version, determined_by, reason
      ) VALUES (?, 'investment_rehab', '1.0.0', 'deal-findr', 'Auto-classified on intake')
    `).run(opportunityId);

    // Append-only history: the initial classification is still a classification
    // event, and migration 007 protects this table from update and delete.
    db.prepare(`
      INSERT INTO classification_history (
        id, opportunity_id, prior_classification, new_classification,
        classification_rules_version, determined_by, reason
      ) VALUES (?, ?, NULL, 'investment_rehab', '1.0.0', 'deal-findr', 'Auto-classified on intake')
    `).run(randomUUID(), opportunityId);

    // Log audit event
    db.prepare(`
      INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
      VALUES (?, ?, 'DEAL_FINDR_INTAKE', 'deal-findr', ?, ?)
    `).run(
      randomUUID(), 
      new Date().toISOString(), 
      JSON.stringify({ opportunityId, address, arv, askingPrice, rehab }),
      randomUUID()
    );

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    console.error("Deal Findr intake transaction failed.");
    return sendJson(res, 500, { ok: false, error: "intake_transaction_failed" });
  }

  return sendJson(res, 201, { ok: true, duplicate: false, opportunityId, opportunityCode });
}
