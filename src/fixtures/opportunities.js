/**
 * Deterministic, obviously-fictional PIPELINE fixtures. DEMO DATA ONLY.
 *
 * Contains NO real client, seller, or property information, no production
 * identifiers, and nothing derived from ocg_one.db. Ids use the FX-/DEMO- prefix
 * so they can never collide with production ids. Stable so tests are deterministic.
 *
 * Deterministic clock for stale calculations in tests: 2026-08-01T00:00:00Z
 * (STALE_DAYS = 60 -> stale cutoff 2026-06-02).
 */

import { REAL, SYNTHETIC } from "../domain/classifications/classificationModel.js";
import { RECOVERY_METHODS } from "../domain/provenance/provenanceModel.js";

export const FIXTURE_CLOCK = "2026-08-01T00:00:00Z";

export const OPPORTUNITY_FIXTURES = Object.freeze([
  {
    id: "FX-OPP-0001",
    code: "DEMO-OPP-0001",
    sellerDisplayName: "Ada Fixtureton",
    property: { externalPropertyId: "DEMO-PROP-0001", address: "100 Placeholder Lane, Sampleton" },
    assignedOperator: "operator.demo",
    stage: "negotiating",
    classification: REAL,
    leadClassification: REAL,
    lastActivity: "2026-07-20T00:00:00Z",
    source: { sourceType: "property_lead_inbox", originalSourceMessageId: "DEMO-MSG-0001", recoveredSourceMessageId: null, recoveryMethod: null, recoveryConfidence: null },
    participants: [
      { id: "FX-PART-0001", name: "Ada Fixtureton", role: "Seller", externalPersonId: "DEMO-PERSON-0001" },
      { id: "FX-PART-0002", name: "Sam Placeholder", role: "Attorney", externalPersonId: "DEMO-PERSON-0002" },
    ],
    sources: [{ sourceType: "property_lead_inbox", originalSourceMessageId: "DEMO-MSG-0001", recoveredSourceMessageId: null }],
    stageTimeline: [
      { stage: "new_lead", at: "2026-06-30T00:00:00Z", changedBy: "operator.demo" },
      { stage: "contacted", at: "2026-07-05T00:00:00Z", changedBy: "operator.demo" },
      { stage: "negotiating", at: "2026-07-20T00:00:00Z", changedBy: "operator.demo" },
    ],
    offers: [{ id: "FX-OFFER-0001", amount: 182000, status: "Draft", version: 1 }],
    outcome: null,
  },
  {
    id: "FX-OPP-0002",
    code: "DEMO-OPP-0002",
    sellerDisplayName: "Ben Sampleman",
    property: { externalPropertyId: "DEMO-PROP-0002", address: "200 Example Court, Sampleton" },
    assignedOperator: "operator.demo",
    stage: "contacted",
    classification: REAL,
    leadClassification: REAL,
    lastActivity: "2026-07-10T00:00:00Z",
    // Original absent; recovered via lead-claims path.
    source: { sourceType: "property_lead_inbox", originalSourceMessageId: null, recoveredSourceMessageId: "DEMO-MSG-0002", recoveryMethod: RECOVERY_METHODS.CLAIMS, recoveryConfidence: "High" },
    participants: [{ id: "FX-PART-0003", name: "Ben Sampleman", role: "Seller", externalPersonId: "DEMO-PERSON-0003" }],
    sources: [{ sourceType: "property_lead_inbox", originalSourceMessageId: null, recoveredSourceMessageId: "DEMO-MSG-0002" }],
    stageTimeline: [
      { stage: "new_lead", at: "2026-07-01T00:00:00Z", changedBy: "operator.demo" },
      { stage: "contacted", at: "2026-07-10T00:00:00Z", changedBy: "operator.demo" },
    ],
    offers: [],
    outcome: null,
  },
  {
    id: "FX-OPP-0003",
    code: "DEMO-OPP-0003",
    sellerDisplayName: "Cora Demarco",
    property: { externalPropertyId: "DEMO-PROP-0003", address: "300 Demo Ridge, Sampleton" },
    assignedOperator: "operator.demo",
    stage: "qualified",
    classification: "AMBIGUOUS",
    leadClassification: null, // no lineage evidence
    lastActivity: "2026-05-01T00:00:00Z", // STALE (< 2026-06-02)
    // Unresolved: neither original nor recovered. Must NOT be called synthetic.
    source: { sourceType: "property_lead_inbox", originalSourceMessageId: null, recoveredSourceMessageId: null, recoveryMethod: null, recoveryConfidence: null },
    participants: [{ id: "FX-PART-0004", name: "Cora Demarco", role: "Seller", externalPersonId: "DEMO-PERSON-0004" }],
    sources: [{ sourceType: "property_lead_inbox", originalSourceMessageId: null, recoveredSourceMessageId: null }],
    stageTimeline: [{ stage: "qualified", at: "2026-05-01T00:00:00Z", changedBy: "operator.demo" }],
    offers: [],
    outcome: null,
  },
  {
    id: "FX-OPP-0004",
    code: "DEMO-OPP-0004", // deliberately real-looking; lineage must still win
    sellerDisplayName: "Test Synthetic Dolan",
    property: { externalPropertyId: null, address: "400 Synthetic Way, Sampleton" }, // missing external property ref
    assignedOperator: "operator.demo",
    stage: "lost",
    classification: SYNTHETIC,
    leadClassification: SYNTHETIC,
    lastActivity: "2026-06-15T00:00:00Z",
    source: { sourceType: "property_lead_inbox", originalSourceMessageId: "DEMO-MSG-0004", recoveredSourceMessageId: null, recoveryMethod: null, recoveryConfidence: null },
    participants: [{ id: "FX-PART-0005", name: "Test Synthetic Dolan", role: "Seller", externalPersonId: "DEMO-PERSON-0005" }],
    sources: [{ sourceType: "property_lead_inbox", originalSourceMessageId: "DEMO-MSG-0004", recoveredSourceMessageId: null }],
    stageTimeline: [
      { stage: "new_lead", at: "2026-06-01T00:00:00Z", changedBy: "operator.demo" },
      { stage: "contacted", at: "2026-06-08T00:00:00Z", changedBy: "operator.demo" },
      { stage: "lost", at: "2026-06-15T00:00:00Z", changedBy: "operator.demo" },
    ],
    offers: [{ id: "FX-OFFER-0004", amount: 95000, status: "Withdrawn", version: 1 }],
    outcome: { result: "lost", reason: "demo outcome" },
  },
  {
    id: "FX-OPP-0005",
    code: "DEMO-OPP-0005",
    sellerDisplayName: "Ella Prototype",
    property: { externalPropertyId: "DEMO-PROP-0005", address: "500 Prototype Blvd, Sampleton" },
    assignedOperator: "operator.demo",
    stage: "closed",
    classification: REAL,
    leadClassification: REAL,
    lastActivity: "2026-07-01T00:00:00Z",
    // Recovered via the direct source-message path.
    source: { sourceType: "property_lead_inbox", originalSourceMessageId: null, recoveredSourceMessageId: "DEMO-MSG-0005", recoveryMethod: RECOVERY_METHODS.DIRECT, recoveryConfidence: "High" },
    participants: [
      { id: "FX-PART-0006", name: "Ella Prototype", role: "Seller", externalPersonId: "DEMO-PERSON-0006" },
      { id: "FX-PART-0007", name: "Iris Example", role: "Buyer Agent", externalPersonId: "DEMO-PERSON-0007" },
    ],
    sources: [{ sourceType: "property_lead_inbox", originalSourceMessageId: null, recoveredSourceMessageId: "DEMO-MSG-0005" }],
    stageTimeline: [
      { stage: "new_lead", at: "2026-05-20T00:00:00Z", changedBy: "operator.demo" },
      { stage: "under_contract", at: "2026-06-20T00:00:00Z", changedBy: "operator.demo" },
      { stage: "closed", at: "2026-07-01T00:00:00Z", changedBy: "operator.demo" },
    ],
    offers: [{ id: "FX-OFFER-0005", amount: 210000, status: "Accepted", version: 2 }],
    outcome: { result: "closed", reason: "demo outcome" },
  },
  {
    id: "FX-OPP-0006",
    code: "DEMO-OPP-0006",
    sellerDisplayName: "Finn Placeholder",
    property: { externalPropertyId: null, address: "600 Sample Street, Sampleton" }, // missing external property ref
    assignedOperator: "operator.demo",
    stage: "new_lead",
    classification: REAL,
    leadClassification: REAL,
    lastActivity: "2026-07-15T00:00:00Z",
    source: { sourceType: "property_lead_inbox", originalSourceMessageId: "DEMO-MSG-0006", recoveredSourceMessageId: null, recoveryMethod: null, recoveryConfidence: null },
    // Participant with a missing external person reference.
    participants: [{ id: "FX-PART-0008", name: "Finn Placeholder", role: "Seller", externalPersonId: null }],
    sources: [{ sourceType: "property_lead_inbox", originalSourceMessageId: "DEMO-MSG-0006", recoveredSourceMessageId: null }],
    stageTimeline: [{ stage: "new_lead", at: "2026-07-15T00:00:00Z", changedBy: "operator.demo" }],
    offers: [],
    outcome: null,
  },
]);

/** Classification history is append-only (nothing overwritten). DEMO DATA. */
export const CLASSIFICATION_HISTORY_FIXTURES = Object.freeze([
  { opportunityId: "FX-OPP-0004", priorClassification: null, newClassification: "SYNTHETIC", reason: "initial classification", changedBy: "classifier.demo", changedAt: "2026-06-02T00:00:00Z" },
  { opportunityId: "FX-OPP-0004", priorClassification: "SYNTHETIC", newClassification: "SYNTHETIC", reason: "re-review confirmed", changedBy: "classifier.demo", changedAt: "2026-06-16T00:00:00Z" },
  { opportunityId: "FX-OPP-0003", priorClassification: null, newClassification: "AMBIGUOUS", reason: "unresolved provenance; not synthetic", changedBy: "classifier.demo", changedAt: "2026-05-02T00:00:00Z" },
  { opportunityId: "FX-OPP-0001", priorClassification: null, newClassification: "REAL", reason: "initial classification", changedBy: "classifier.demo", changedAt: "2026-07-01T00:00:00Z" },
]);
