import { createHash, randomUUID } from "node:crypto";
import { normalizePropertyAddress } from "../domain/properties/addressNormalization.js";
import { recommendationForScore, scorePiperOpportunity } from "./piperOpportunityScoring.js";

const ALLOWED_SOURCE_TYPES = new Set(["property_lead_inbox", "gmail_digest", "website_form", "referral", "manual_entry"]);

const text = (value, max = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, max) : null;
};

const money = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export function normalizePiperListing(payload) {
  const address = text(payload.address, 300);
  if (!address) throw Object.assign(new Error("missing_address"), { code: "missing_address", status: 400 });

  const normalizedAddress = normalizePropertyAddress(address);
  const sourceType = ALLOWED_SOURCE_TYPES.has(payload.sourceType) ? payload.sourceType : "website_form";
  const sourceName = text(payload.sourceName, 120) || "PIPER Discovery";
  const externalId = text(payload.externalId, 200) || text(payload.apn, 120) || `piper:${normalizedAddress}`;
  const sourceUrl = text(payload.sourceUrl, 2000);
  const discoveredAt = text(payload.discoveredAt, 80) || new Date().toISOString();
  const listing = {
    address,
    normalizedAddress,
    sourceType,
    sourceName,
    externalId,
    sourceUrl,
    discoveredAt,
    sourceMessageId: text(payload.sourceMessageId, 200),
    apn: text(payload.apn, 120),
    askingPrice: money(payload.askingPrice),
    arv: money(payload.arv),
    rehab: money(payload.rehab),
    sellerName: text(payload.sellerName, 200),
    phone: text(payload.phone, 80),
    email: text(payload.email, 320),
    description: text(payload.description, 4000),
    propertyCondition: text(payload.propertyCondition, 1000),
  };
  listing.fingerprint = createHash("sha256").update(`${sourceType}|${externalId}|${normalizedAddress}`).digest("hex");
  return listing;
}

export function ingestPiperListing(db, payload, options = {}) {
  const listing = normalizePiperListing(payload);
  const scored = scorePiperOpportunity(listing);

  const existing = db.prepare(`
    SELECT opportunity_id FROM seller_opportunity_sources
    WHERE LOWER(original_address) = ? OR (source_type = ? AND source_record_id = ?)
    LIMIT 1
  `).get(listing.normalizedAddress, listing.sourceType, listing.externalId);

  if (existing) {
    db.prepare(`
      INSERT INTO operational_audit_events (id, event_timestamp, event_type, actor_id, opportunity_id, payload_json, correlation_id)
      VALUES (?, ?, 'PIPER_DUPLICATE_RECONCILED', 'piper', ?, ?, ?)
    `).run(randomUUID(), new Date().toISOString(), existing.opportunity_id, JSON.stringify({ ...listing, score: scored.score }), randomUUID());
    return { duplicate: true, opportunityId: existing.opportunity_id, listing, ...scored };
  }

  const opportunityId = `opp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const opportunityCode = `OPP-${Math.floor(100000 + Math.random() * 900000)}`;
  const propertyId = `prop_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare(`
      INSERT INTO seller_opportunities (
        id, tenant_id, opportunity_code, ocg_one_property_id, pipeline_stage,
        qualification_status, contact_status, opportunity_status, data_quality_status,
        asking_price, property_condition_summary, created_by, updated_by
      ) VALUES (?, 'ocg-one', ?, ?, 'new_lead', 'needs_review', 'uncontacted', 'active', 'raw_ingestion', ?, ?, 'piper', 'piper')
    `).run(opportunityId, opportunityCode, propertyId, listing.askingPrice, listing.propertyCondition || "Discovered by PIPER");

    db.prepare(`
      INSERT INTO seller_opportunity_sources (
        id, opportunity_id, source_type, source_record_id, source_message_id,
        original_address, source_timestamp, conversion_actor, provenance_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'piper', ?)
    `).run(randomUUID(), opportunityId, listing.sourceType, listing.externalId, listing.sourceMessageId,
      listing.normalizedAddress, listing.discoveredAt, JSON.stringify({ sourceName: listing.sourceName, sourceUrl: listing.sourceUrl }));

    db.prepare(`
      INSERT INTO source_provenance (id, opportunity_id, original_source_json, resolution_status)
      VALUES (?, ?, ?, 'original_resolved')
    `).run(randomUUID(), opportunityId, JSON.stringify({ source: "piper", ...listing }));

    db.prepare(`
      INSERT INTO record_classifications (
        opportunity_id, classification_value, classification_rules_version, determined_by, reason
      ) VALUES (?, 'investment_rehab', '1.0.0', 'piper', 'PIPER preliminary classification; requires operator review')
    `).run(opportunityId);

    db.prepare(`
      INSERT INTO operational_audit_events (
        id, event_timestamp, event_type, actor_id, opportunity_id, payload_json, correlation_id
      ) VALUES (?, ?, 'PIPER_INTAKE', 'piper', ?, ?, ?)
    `).run(randomUUID(), new Date().toISOString(), opportunityId, JSON.stringify({ ...listing, score: scored.score, scoreReasons: scored.reasons }), randomUUID());

    const recommendation = recommendationForScore(scored.score);
    db.prepare(`
      INSERT INTO piper_recommendations (
        id, opportunity_id, recommendation_type, priority, summary, rationale_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), opportunityId, recommendation.type, recommendation.priority,
      `PIPER scored ${listing.address} at ${scored.score}/100.`, JSON.stringify(scored.reasons));

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  return { duplicate: false, opportunityId, opportunityCode, listing, ...scored };
}
