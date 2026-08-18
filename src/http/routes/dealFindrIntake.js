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

  const { 
    address, apn, askingPrice, arv, rehab, sellerName, phone, email,
    sourceRecordId, sourceMessageId, sourceTimestamp, classification, classificationReason 
  } = payload;

  if (!address) {
    return sendJson(res, 400, { ok: false, error: "missing_address" });
  }

  // Address Normalization
  const normalizedAddress = address.trim().toLowerCase().replace(/\s+/g, " ");
  const db = ctx.db;

  // Real Deduplication (source_record_id, APN in JSON, or normalized address)
  let existingOpp = null;
  let matchType = null;

  try {
    // 1. Exact source_type + source_record_id
    if (sourceRecordId) {
      existingOpp = db.prepare(`
        SELECT opportunity_id FROM seller_opportunity_sources
        WHERE source_type = 'deal_scout_handoff' AND source_record_id = ?
      `).get(sourceRecordId);
      if (existingOpp) matchType = "source_record_id";
    }

    // 2. APN in provenance_metadata_json
    if (!existingOpp && apn) {
      existingOpp = db.prepare(`
        SELECT opportunity_id FROM seller_opportunity_sources
        WHERE JSON_EXTRACT(provenance_metadata_json, '$.apn') = ?
      `).get(apn);
      if (existingOpp) matchType = "apn";
    }

    // 3. Normalized property address
    if (!existingOpp) {
      existingOpp = db.prepare(`
        SELECT opportunity_id FROM seller_opportunity_sources
        WHERE LOWER(original_address) = ?
      `).get(normalizedAddress);
      if (existingOpp) matchType = "normalized_address";
    }
  } catch (err) {
    console.error("Deduplication query failed:", err.message);
  }

  if (existingOpp) {
    // Reconcile and log duplicate audit event
    try {
      db.prepare(`
        INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
        VALUES (?, ?, 'DEAL_FINDR_DUPLICATE_RECONCILED', 'deal-findr', ?, ?)
      `).run(
        randomUUID(), 
        new Date().toISOString(), 
        JSON.stringify({ 
          matchType, 
          incomingSourceRecordId: sourceRecordId || null, 
          existingOpportunityId: existingOpp.opportunity_id 
        }),
        randomUUID()
      );
    } catch (_) {}

    return sendJson(res, 200, { ok: true, duplicate: true, opportunityId: existingOpp.opportunity_id });
  }

  // Address Verification & Image Metadata Verification through Google Maps (if API Key is configured)
  let addressVerification = {
    status: "ADDRESS_VERIFICATION_PENDING",
    normalizedAddress: normalizedAddress,
    latitude: null,
    longitude: null,
    placeId: null,
    verifiedAt: null,
    source: "NONE"
  };

  let imageVerification = {
    status: "STREET_VIEW_UNVERIFIED",
    source: "NONE",
    url: null,
    verifiedAt: null
  };

  const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || ctx.config.googleMapsApiKey || "";

  if (googleMapsKey) {
    try {
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${googleMapsKey}`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json();
      if (geoData.status === "OK" && geoData.results && geoData.results.length > 0) {
        const result = geoData.results[0];
        const isPrecise = result.types.includes("street_address") || result.types.includes("premise") || result.types.includes("subpremise");
        if (isPrecise) {
          addressVerification = {
            status: "GOOGLE_VERIFIED",
            normalizedAddress: result.formatted_address,
            latitude: result.geometry.location.lat,
            longitude: result.geometry.location.lng,
            placeId: result.place_id,
            verifiedAt: new Date().toISOString(),
            source: "GOOGLE_GEOCODING_API"
          };

          const svMetaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${addressVerification.latitude},${addressVerification.longitude}&key=${googleMapsKey}`;
          const svMetaRes = await fetch(svMetaUrl);
          const svMetaData = await svMetaRes.json();
          if (svMetaData.status === "OK") {
            imageVerification = {
              status: "GOOGLE_STREET_VIEW",
              source: "GOOGLE_STREET_VIEW",
              url: `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${addressVerification.latitude},${addressVerification.longitude}&key=${googleMapsKey}`,
              verifiedAt: new Date().toISOString()
            };
          } else {
            imageVerification = {
              status: "NO_IMAGE",
              source: "NONE",
              url: null,
              verifiedAt: new Date().toISOString()
            };
          }
        } else {
          addressVerification.status = "ADDRESS_NEEDS_REVIEW";
        }
      } else {
        addressVerification.status = "ADDRESS_NEEDS_REVIEW";
      }
    } catch (err) {
      console.error("Google Geocoding API call failed:", err.message);
      addressVerification.status = "ADDRESS_NEEDS_REVIEW";
    }
  }

  // Canonical classification validation: Accept only if explicitly present and valid
  const validClassifications = new Set(['retail_listing', 'wholesale_target', 'investment_rehab', 'land_hold', 'disqualified', 'unknown']);
  const classificationValue = (classification && validClassifications.has(classification)) ? classification : 'unknown';
  const classReason = (classification && validClassifications.has(classification)) 
    ? (classificationReason || 'Explicit Deal Finder classification supplied at intake') 
    : 'No explicit Deal Finder classification supplied at intake';

  // Legacy compatibility metadata mapping
  const provenanceMetadata = {
    originSystem: "deal-finder",
    originAgent: "Hunter",
    legacySourceType: "deal_scout_handoff",
    addressVerification,
    imageVerification,
    apn: apn || null,
    arv: arv || null,
    rehab: rehab || null,
    sourceTimestampProvided: !!sourceTimestamp,
    originalSourceTimestamp: sourceTimestamp || null
  };

  // Insert new lead into SQLite
  const opportunityId = "opp_" + randomUUID().replace(/-/g, "").substring(0, 12);
  const opportunityCode = "OPP-" + Math.floor(100000 + Math.random() * 900000);
  const propertyId = "prop_" + randomUUID().replace(/-/g, "").substring(0, 12);

  const conversionTime = new Date().toISOString();
  const sourceTimestampValue = sourceTimestamp || conversionTime;

  db.exec("BEGIN TRANSACTION;");
  try {
    // Insert into seller_opportunities
    db.prepare(`
      INSERT INTO seller_opportunities (
        id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
        qualification_status, contact_status, opportunity_status, data_quality_status,
        asking_price, property_condition_summary, created_by, updated_by
      ) VALUES (?, 'ocg-one', ?, ?, 'new_lead', 'needs_review', 'uncontacted', 'active', 'raw_ingestion', ?, ?, 'deal-findr', 'deal-findr')
    `).run(opportunityId, opportunityCode, propertyId, askingPrice || null, "Ingested via Deal Finder");

    // Insert source (satisfies enum constraint with deal_scout_handoff, preserves deal-findr actor and timestamps)
    db.prepare(`
      INSERT INTO seller_opportunity_sources (
        id, opportunity_id, source_type, source_record_id, source_message_id,
        original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json
      ) VALUES (?, ?, 'deal_scout_handoff', ?, ?, ?, ?, 'deal-findr', ?, ?)
    `).run(
      randomUUID(), opportunityId, sourceRecordId || null, sourceMessageId || null, 
      normalizedAddress, sourceTimestampValue, conversionTime, JSON.stringify(provenanceMetadata)
    );

    // Insert source provenance
    db.prepare(`
      INSERT INTO source_provenance (
        id, opportunity_id, original_source_json, resolution_status
      ) VALUES (?, ?, ?, 'original_resolved')
    `).run(randomUUID(), opportunityId, JSON.stringify({ source: "deal-findr", apn: apn || null }));

    // Insert classification
    db.prepare(`
      INSERT INTO record_classifications (
        opportunity_id, classification_value, classification_rules_version, determined_by, reason
      ) VALUES (?, ?, '1.0.0', 'deal-findr', ?)
    `).run(opportunityId, classificationValue, classReason);

    // Record classification history
    db.prepare(`
      INSERT INTO classification_history (
        id, opportunity_id, prior_classification, new_classification,
        classification_rules_version, determined_by, reason
      ) VALUES (?, ?, NULL, ?, '1.0.0', 'deal-findr', ?)
    `).run(randomUUID(), opportunityId, classificationValue, classReason);

    // Log audit event
    db.prepare(`
      INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
      VALUES (?, ?, 'DEAL_FINDR_INTAKE', 'deal-findr', ?, ?)
    `).run(
      randomUUID(), 
      conversionTime, 
      JSON.stringify({ opportunityId, address, arv, askingPrice, rehab, sourceRecordId }),
      randomUUID()
    );

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    console.error("Deal Findr intake transaction failed:", err.message);
    return sendJson(res, 500, { ok: false, error: "intake_transaction_failed" });
  }

  return sendJson(res, 201, { ok: true, duplicate: false, opportunityId, opportunityCode });
}
