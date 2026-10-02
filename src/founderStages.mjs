/**
 * Founder-stage mapping layer (PIPER-FIRST simplification).
 *
 * The backend keeps its detailed 20-stage model untouched — historical stage
 * data is never rewritten. The founder experience collapses those stages into
 * 8 plain-language buckets. This module is the single canonical mapping;
 * public/app.js carries a literal copy for the browser (kept in sync by
 * tests/founder-stage-map.test.mjs).
 */

export const FOUNDER_STAGES = Object.freeze([
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "appointment", label: "Appointment" },
  { key: "offer", label: "Offer" },
  { key: "negotiating", label: "Negotiating" },
  { key: "under_contract", label: "Under Contract" },
  { key: "closed", label: "Closed" },
  { key: "dead", label: "Dead" },
]);

/** Backend stage -> founder stage. Nurture is inactive, so it reads as Dead. */
export const STAGE_TO_FOUNDER = Object.freeze({
  new_lead: "new",
  needs_review: "new",
  attempting_contact: "contacted",
  contacted: "contacted",
  qualified: "contacted",
  appointment_scheduled: "appointment",
  property_review: "appointment",
  strategy_development: "offer",
  offer_preparation: "offer",
  offer_approval_required: "offer",
  offer_presented: "offer",
  negotiating: "negotiating",
  under_contract: "under_contract",
  due_diligence: "under_contract",
  closing_scheduled: "under_contract",
  closed: "closed",
  nurture: "dead",
  disqualified: "dead",
  lost: "dead",
  archived: "dead",
});

/**
 * When the founder picks a founder-stage in the UI, the backend stage written
 * is the natural entry stage of that bucket. History stays intact.
 */
export const FOUNDER_STAGE_DEFAULTS = Object.freeze({
  new: "new_lead",
  contacted: "attempting_contact",
  appointment: "appointment_scheduled",
  offer: "offer_preparation",
  negotiating: "negotiating",
  under_contract: "under_contract",
  closed: "closed",
  dead: "disqualified",
});

export function toFounderStage(stage) {
  return STAGE_TO_FOUNDER[stage] || "new";
}

export function founderStageLabel(key) {
  const found = FOUNDER_STAGES.find((s) => s.key === key);
  return found ? found.label : String(key || "new");
}

export function isFounderStageKey(key) {
  return FOUNDER_STAGES.some((s) => s.key === key);
}
