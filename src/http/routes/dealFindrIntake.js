import { sendJson } from "../response.js";
import { randomUUID } from "node:crypto";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function persistVictorUnderwriting(db, opportunityId, { underwriting, marketEvidence, packageId, sourceRecordId, timestamp } = {}) {
  if (!underwriting) return false;

  const arv = numberOrNull(underwriting.arv);
  const rehab = numberOrNull(underwriting.renovationBudget ?? underwriting.rehab);
  const mao = numberOrNull(underwriting.mao ?? underwriting.mao70Rule);
  const confidence = numberOrNull(underwriting.confidenceScore ?? underwriting.confidence);
  const status = underwriting.analysisStatus || ((arv !== null || numberOrNull(underwriting.dscr) !== null) ? "completed" : "insufficient_evidence");

  // opportunity_underwriting_refs is the current cross-system snapshot. Replace only
  // Deal Scout's snapshot for this opportunity; never clear unrelated underwriting rows.
  db.prepare(`
    DELETE FROM opportunity_underwriting_refs
    WHERE opportunity_id = ? AND source_system = 'deal-scout'
  `).run(opportunityId);

  const evidence = {
    comps: Array.isArray(marketEvidence?.comps) ? marketEvidence.comps : [],
    compsCount: numberOrNull(marketEvidence?.compsCount),
    recommendation: underwriting.recommendation ?? null,
    scenarios: Array.isArray(underwriting.scenarios) ? underwriting.scenarios : [],
    hold: {
      strategy: underwriting.holdStrategy ?? null,
      monthlyRent: numberOrNull(underwriting.monthlyRent),
      monthlyEffectiveGrossIncome: numberOrNull(underwriting.monthlyEffectiveGrossIncome),
      monthlyOperatingExpenses: numberOrNull(underwriting.monthlyOperatingExpenses),
      noi: numberOrNull(underwriting.noi),
      monthlyDebtService: numberOrNull(underwriting.monthlyDebtService),
      annualDebtService: numberOrNull(underwriting.annualDebtService),
      dscr: numberOrNull(underwriting.dscr)
    },
    sourcePackageId: packageId ?? null
  };

  db.prepare(`
    INSERT INTO opportunity_underwriting_refs (
      id, opportunity_id, source_system, source_agent, source_project_id,
      source_underwriting_id, source_version_id, analysis_status, arv, rehab, mao,
      confidence, limitations, evidence_summary_json, analyzed_at
    ) VALUES (?, ?, 'deal-scout', 'Victor', ?, ?, '2.0', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    opportunityId,
    sourceRecordId || null,
    packageId || null,
    status,
    arv,
    rehab,
    mao,
    confidence,
    underwriting.limitations || null,
    JSON.stringify(evidence),
    timestamp || new Date().toISOString()
  );

  return true;
}

export async function handleDealFindrIntake(req, res, ctx) {
  let body = "";
  try {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    body = Buffer.concat(buffers).toString("utf8");
  } catch {
    return sendJson(res, 500, { ok: false, error: "read_error" });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  const victorPackage = payload?.property && payload?.underwriting ? payload : null;
  const incoming = victorPackage?.property || payload;
  const underwriting = victorPackage?.underwriting || null;
  const marketEvidence = victorPackage?.marketEvidence || null;

  const {
    address, apn, askingPrice, sellerName, phone, email,
    sourceMessageId, sourceTimestamp, classification, classificationReason
  } = incoming;

  const sourceRecordId = victorPackage?.property?.id || payload.sourceRecordId || null;
  const arv = underwriting?.arv ?? payload.arv ?? null;
  const rehab = underwriting?.renovationBudget ?? underwriting?.rehab ?? payload.rehab ?? null;
  const intakeTimestamp = victorPackage?.timestamp || sourceTimestamp || null;
  const intakeActor = victorPackage ? "victor" : "deal-findr";

  if (!address) {
    return sendJson(res, 400, { ok: false, error: "missing_address" });
  }

  const normalizedAddress = address.trim().toLowerCase().replace(/\s+/g, " ");
  const db = ctx.db;

  let existingOpp = null;
  let matchType = null;

  try {
    if (sourceRecordId) {
      existingOpp = db.prepare(`
        SELECT opportunity_id FROM seller_opportunity_sources
        WHERE source_type = 'deal_scout_handoff' AND source_record_id = ?
      `).get(sourceRecordId);
      if (existingOpp) matchType = "source_record_id";
    }

    if (!existingOpp && apn) {
      existingOpp = db.prepare(`
        SELECT opportunity_id FROM seller_opportunity_sources
        WHERE JSON_EXTRACT(provenance_metadata_json, '$.apn') = ?
      `).get(apn);
      if (existingOpp) matchType = "apn";
    }

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
    db.exec("BEGIN TRANSACTION;");
    try {
      persistVictorUnderwriting(db, existingOpp.opportunity_id, {
        underwriting,
        marketEvidence,
        packageId: victorPackage?.packageId,
        sourceRecordId,
        timestamp: victorPackage?.timestamp
      });

      db.prepare(`
        INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
        VALUES (?, ?, 'DEAL_FINDR_DUPLICATE_RECONCILED', ?, ?, ?)
      `).run(
        randomUUID(),
        new Date().toISOString(),
        intakeActor,
        JSON.stringify({
          matchType,
          incomingSourceRecordId: sourceRecordId || null,
          existingOpportunityId: existingOpp.opportunity_id,
          victorUnderwritingAttached: Boolean(underwriting)
        }),
        randomUUID()
      );
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      console.error("Duplicate reconciliation failed:", err.message);
      return sendJson(res, 500, { ok: false, error: "duplicate_reconciliation_failed" });
    }

    return sendJson(res, 200, {
      ok: true,
      duplicate: true,
      opportunityId: existingOpp.opportunity_id,
      dealId: existingOpp.opportunity_id
    });
  }

  let addressVerification = {
    status: "ADDRESS_VERIFICATION_PENDING",
    normalizedAddress,
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
            imageVerification = { status: "NO_IMAGE", source: "NONE", url: null, verifiedAt: new Date().toISOString() };
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

  const validClassifications = new Set(['retail_listing', 'wholesale_target', 'investment_rehab', 'land_hold', 'disqualified', 'unknown']);
  const classificationValue = (classification && validClassifications.has(classification)) ? classification : 'unknown';
  const classReason = (classification && validClassifications.has(classification))
    ? (classificationReason || 'Explicit Deal Finder classification supplied at intake')
    : 'No explicit Deal Finder classification supplied at intake';

  const provenanceMetadata = {
    originSystem: victorPackage ? "deal-scout" : "deal-finder",
    originAgent: victorPackage ? "Victor" : "Hunter",
    legacySourceType: "deal_scout_handoff",
    addressVerification,
    imageVerification,
    apn: apn || null,
    arv: arv || null,
    rehab: rehab || null,
    sourceTimestampProvided: !!intakeTimestamp,
    originalSourceTimestamp: intakeTimestamp || null
  };

  const opportunityId = "opp_" + randomUUID().replace(/-/g, "").substring(0, 12);
  const opportunityCode = "OPP-" + Math.floor(100000 + Math.random() * 900000);
  const propertyId = "prop_" + randomUUID().replace(/-/g, "").substring(0, 12);
  const conversionTime = new Date().toISOString();
  const sourceTimestampValue = intakeTimestamp || conversionTime;

  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare(`
      INSERT INTO seller_opportunities (
        id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
        qualification_status, contact_status, opportunity_status, data_quality_status,
        asking_price, property_condition_summary, created_by, updated_by
      ) VALUES (?, 'ocg-one', ?, ?, 'new_lead', 'needs_review', 'uncontacted', 'active', 'raw_ingestion', ?, ?, ?, ?)
    `).run(
      opportunityId,
      opportunityCode,
      propertyId,
      askingPrice || null,
      victorPackage ? "Ingested via Deal Scout / Victor" : "Ingested via Deal Finder",
      intakeActor,
      intakeActor
    );

    db.prepare(`
      INSERT INTO seller_opportunity_sources (
        id, opportunity_id, source_type, source_record_id, source_message_id,
        original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json
      ) VALUES (?, ?, 'deal_scout_handoff', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), opportunityId, sourceRecordId || null, sourceMessageId || null,
      normalizedAddress, sourceTimestampValue, intakeActor, conversionTime, JSON.stringify(provenanceMetadata)
    );

    db.prepare(`
      INSERT INTO source_provenance (
        id, opportunity_id, original_source_json, resolution_status
      ) VALUES (?, ?, ?, 'original_resolved')
    `).run(randomUUID(), opportunityId, JSON.stringify({ source: victorPackage ? "deal-scout" : "deal-findr", apn: apn || null }));

    db.prepare(`
      INSERT INTO record_classifications (
        opportunity_id, classification_value, classification_rules_version, determined_by, reason
      ) VALUES (?, ?, '1.0.0', ?, ?)
    `).run(opportunityId, classificationValue, intakeActor, classReason);

    db.prepare(`
      INSERT INTO classification_history (
        id, opportunity_id, prior_classification, new_classification,
        classification_rules_version, determined_by, reason
      ) VALUES (?, ?, NULL, ?, '1.0.0', ?, ?)
    `).run(randomUUID(), opportunityId, classificationValue, intakeActor, classReason);

    persistVictorUnderwriting(db, opportunityId, {
      underwriting,
      marketEvidence,
      packageId: victorPackage?.packageId,
      sourceRecordId,
      timestamp: victorPackage?.timestamp
    });

    db.prepare(`
      INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, payload_json, correlation_id)
      VALUES (?, ?, 'DEAL_FINDR_INTAKE', ?, ?, ?)
    `).run(
      randomUUID(),
      conversionTime,
      intakeActor,
      JSON.stringify({
        opportunityId,
        address,
        arv,
        askingPrice,
        rehab,
        sourceRecordId,
        victorUnderwritingAttached: Boolean(underwriting)
      }),
      randomUUID()
    );

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    console.error("Deal Findr intake transaction failed:", err.message);
    return sendJson(res, 500, { ok: false, error: "intake_transaction_failed" });
  }

  return sendJson(res, 201, {
    ok: true,
    duplicate: false,
    opportunityId,
    dealId: opportunityId,
    opportunityCode
  });
}
