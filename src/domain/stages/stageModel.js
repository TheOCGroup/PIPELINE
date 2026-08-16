/**
 * Seller-opportunity stage model (PIPELINE-native, presentation only).
 *
 * Preserves the exact 20 canonical stages from the committed OCG ONE database
 * constraints and views.
 */

export const STAGES = Object.freeze([
  "new_lead",
  "needs_review",
  "attempting_contact",
  "contacted",
  "qualified",
  "appointment_scheduled",
  "property_review",
  "strategy_development",
  "offer_preparation",
  "offer_approval_required",
  "offer_presented",
  "negotiating",
  "under_contract",
  "due_diligence",
  "closing_scheduled",
  "closed",
  "nurture",
  "disqualified",
  "lost",
  "archived",
]);

export const CLOSED_STAGES = new Set(["closed", "lost", "disqualified", "archived"]);

const STAGE_LABELS = {
  new_lead: "New Lead",
  needs_review: "Needs Review",
  attempting_contact: "Attempting Contact",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment_scheduled: "Appointment Scheduled",
  property_review: "Property Review",
  strategy_development: "Strategy Development",
  offer_preparation: "Offer Preparation",
  offer_approval_required: "Approval Required",
  offer_presented: "Offer Presented",
  negotiating: "Negotiating",
  under_contract: "Under Contract",
  due_diligence: "Due Diligence",
  closing_scheduled: "Closing Scheduled",
  closed: "Closed",
  nurture: "Nurture",
  disqualified: "Disqualified",
  lost: "Lost",
  archived: "Archived",
};

export function isClosedStage(stage) {
  return CLOSED_STAGES.has(stage);
}

export function formatStage(stage) {
  return STAGE_LABELS[stage] || String(stage || "—");
}
