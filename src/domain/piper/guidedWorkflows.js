/**
 * Piper guided workflows — template definitions (Issue #1, item 5).
 *
 * Definitions live in code and are versioned; the database (migration 033)
 * stores only instances + step outcomes, so editing a template here never
 * rewrites the history of an instance already started — an instance records
 * the template version it was started from, and its step keys/labels were
 * materialized into the steps table at start.
 *
 * SAFETY RULE (binding): a step never executes a side effect. A step may
 * SUGGEST an existing Piper tool (`suggestedTool`) — nothing more. If the
 * operator chooses to run a suggested write tool, it goes through the same
 * proposal + approval path as every other Piper write. Advancing a step is
 * bookkeeping only: it records that the operator worked the step.
 */

const template = (key, title, steps) => Object.freeze({
  key,
  templateVersion: 1,
  title,
  steps: Object.freeze(steps.map((s) => Object.freeze({ suggestedTool: null, ...s }))),
});

export const GUIDED_WORKFLOW_TEMPLATES = Object.freeze([
  template("seller_follow_up", "Seller follow-up sequence", [
    { key: "review_record", label: "Review the seller record and the last recorded contact.", suggestedTool: "get_opportunity" },
    { key: "prepare_call", label: "Prepare the call: resolve the number, context, and open items.", suggestedTool: "prepare_call" },
    { key: "log_outcome", label: "Log the call outcome in PIPELINE.", suggestedTool: "log_interaction" },
    { key: "set_follow_up", label: "Set the next follow-up action with a due date.", suggestedTool: "create_next_action" },
  ]),
  template("new_lead_qualification", "New lead qualification", [
    { key: "review_lead", label: "Review the lead and its recorded provenance.", suggestedTool: "get_opportunity" },
    { key: "confirm_contact", label: "Confirm who the seller is and how they are reached.", suggestedTool: "find_seller" },
    { key: "prepare_first_call", label: "Prepare the first call from the recorded context.", suggestedTool: "prepare_call" },
    { key: "record_outcome", label: "Record the qualification outcome.", suggestedTool: "log_interaction" },
    { key: "schedule_follow_up", label: "Schedule the follow-up so the lead cannot go cold silently.", suggestedTool: "create_next_action" },
  ]),
  template("offer_preparation", "Offer preparation", [
    { key: "review_underwriting", label: "Review the Victor underwriting snapshot and its limitations.", suggestedTool: "get_opportunity" },
    { key: "check_offer_history", label: "Check every prior offer and version for this opportunity.", suggestedTool: "get_offer_history" },
    { key: "draft_offer", label: "Draft the offer on operator-reviewed terms (parks for approval like every offer).", suggestedTool: "prepare_offer" },
    { key: "record_decision", label: "Record the decision context as a note on the opportunity.", suggestedTool: "add_note" },
  ]),
]);

const BY_KEY = new Map(GUIDED_WORKFLOW_TEMPLATES.map((t) => [t.key, t]));

/** The current template for a workflow key, or null when unknown. */
export function getGuidedWorkflowTemplate(key) {
  return BY_KEY.get(String(key || "")) || null;
}

/** The suggested tool recorded for one step of a template, or null. */
export function suggestedToolFor(workflowKey, stepKey) {
  const t = getGuidedWorkflowTemplate(workflowKey);
  if (!t) return null;
  return t.steps.find((s) => s.key === stepKey)?.suggestedTool || null;
}
