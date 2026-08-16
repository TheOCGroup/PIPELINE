/**
 * Piper's operating brief — pure derivation from a context snapshot.
 *
 * Every item carries the opportunity ids it was computed from, so any claim on
 * screen can be checked against the database. Categories with nothing in them
 * are omitted rather than padded: an empty brief is a valid answer and is more
 * useful than a manufactured one.
 */

import { money } from "../../services/piperContextService.js";

/**
 * @param {object} snapshot from PiperContextService
 * @returns {{headline: string, sections: Array, counts: object, evidence: object}}
 */
export function buildBrief(snapshot) {
  const open = snapshot.opportunities.filter((o) => !o.closed);

  const needsYou = open
    .filter((o) => decisionsFor(o).length > 0)
    .map((o) => ({
      opportunityId: o.id,
      label: describe(o),
      reasons: decisionsFor(o),
    }));

  const stalled = open
    .filter((o) => o.stalled)
    .sort((a, b) => (b.daysSinceActivity || 0) - (a.daysSinceActivity || 0))
    .map((o) => ({
      opportunityId: o.id,
      label: describe(o),
      reasons: [
        `No movement for ${o.daysSinceActivity} day(s) in ${o.stageLabel}, and no open next action.`,
      ],
    }));

  const changed = [
    ...snapshot.recent.stageEvents.map((e) => ({
      opportunityId: e.opportunity_id,
      label: `Stage moved ${e.prior_stage || "—"} → ${e.new_stage}`,
      reasons: [`Changed by ${e.changed_by}${e.reason ? ` — ${e.reason}` : ""}.`],
    })),
    ...snapshot.recent.classificationChanges.map((c) => ({
      opportunityId: c.opportunity_id,
      label: `Classification ${c.prior_classification || "NONE"} → ${c.new_classification}`,
      reasons: [`Determined by ${c.determined_by} — ${c.reason}`],
    })),
    ...snapshot.recent.victorUpdates.map((v) => ({
      opportunityId: v.opportunity_id,
      label: `Underwriting snapshot recorded${v.attributedTo.agent ? ` from ${v.attributedTo.agent} (${v.attributedTo.system})` : ""}`,
      reasons: [
        `Ceiling ${money(v.underwriting_mao_snapshot)}, ARV ${money(v.underwriting_arv_snapshot)}` +
          `${v.underwriting_confidence ? `, confidence ${v.underwriting_confidence}` : ""}.`,
      ],
    })),
  ];

  // Only genuine Deal Finder deliveries. Seeded fixtures also carry the
  // DEAL_FINDR_INTAKE event type but are written by `system-seed`, and
  // presenting those as inbound leads would be a fabrication.
  const newIntake = snapshot.recent.intakes
    .filter((i) => i.attributedTo.agent === "Hunter")
    .map((i) => ({
      opportunityId: i.opportunityId,
      label: i.address ? `New intake — ${i.address}` : "New intake",
      reasons: [`Delivered by ${i.attributedTo.agent} (${i.attributedTo.system}); stored actor "${i.attributedTo.storedActor}".`],
    }));

  const risk = open
    .filter((o) => o.risks.length > 0)
    .map((o) => ({
      opportunityId: o.id,
      label: describe(o),
      reasons: o.risks.map((r) => r.detail),
    }));

  const next = recommendActions({ needsYou, stalled, risk, open });

  const sections = [
    section("NEEDS YOU", "Decisions that require you.", needsYou),
    section("STALLED", "No movement and no next action.", stalled),
    section("CHANGED", "Since your last brief.", changed),
    section("NEW", "Fresh intake from Deal Finder.", newIntake),
    section("RISK", "Missing data, conflicts, weak economics.", risk),
    section("NEXT", "What Piper recommends.", next),
  ].filter((s) => s.items.length > 0);

  return {
    headline: headline({ needsYou, stalled, changed, newIntake, risk, total: open.length }),
    sections,
    counts: {
      needsYou: needsYou.length,
      stalled: stalled.length,
      changed: changed.length,
      new: newIntake.length,
      risk: risk.length,
      next: next.length,
    },
    evidence: {
      generatedAt: snapshot.generatedAt,
      since: snapshot.since,
      staleThresholdDays: snapshot.staleThresholdDays,
      opportunitiesConsidered: snapshot.opportunities.length,
    },
  };
}

function section(title, subtitle, items) {
  return { title, subtitle, items };
}

/** What genuinely needs a human decision, each traceable to a stored value. */
function decisionsFor(o) {
  const reasons = [];
  if (!o.underwriting.sourceType) {
    reasons.push("No underwriting on record from Victor or Deal Scout, so there is no authorized ceiling to act on.");
  }
  if (o.provenanceState === "unresolved") {
    reasons.push("Provenance is unresolved — it needs deterministic evidence, and it is not a synthetic determination.");
  }
  if (o.maxAuthorizedOffer !== null && o.askingPrice !== null && o.maxAuthorizedOffer < o.askingPrice) {
    reasons.push(`Authorized ceiling ${money(o.maxAuthorizedOffer)} is below the ${money(o.askingPrice)} ask, so proceeding needs your call.`);
  }
  return reasons;
}

function recommendActions({ needsYou, stalled, risk, open }) {
  const out = [];

  for (const s of stalled.slice(0, 5)) {
    out.push({
      opportunityId: s.opportunityId,
      label: "Set a next action or move the stage",
      reasons: [`${s.label} has stalled; recording a next action puts it back in the working set.`],
      action: { kind: "create_next_action", opportunityId: s.opportunityId },
    });
  }

  for (const n of needsYou.slice(0, 5)) {
    out.push({
      opportunityId: n.opportunityId,
      label: "Review and decide",
      reasons: [n.reasons[0]],
      action: { kind: "open_opportunity", opportunityId: n.opportunityId },
    });
  }

  const missingUnderwriting = open.filter((o) => !o.underwriting.sourceType);
  if (missingUnderwriting.length > 2) {
    out.push({
      opportunityId: null,
      label: `Request Deal Scout underwriting for ${missingUnderwriting.length} opportunities`,
      reasons: ["PIPELINE snapshots underwriting from Victor; it never computes it, so these cannot be priced here."],
      action: { kind: "none" },
    });
  }

  void risk;
  return out;
}

function headline({ needsYou, stalled, changed, newIntake, risk, total }) {
  if (total === 0) return "No active opportunities in PIPELINE right now.";

  const parts = [];
  if (needsYou.length) parts.push(`${needsYou.length} need${needsYou.length === 1 ? "s" : ""} your decision`);
  if (stalled.length) parts.push(`${stalled.length} stalled`);
  if (changed.length) parts.push(`${changed.length} change${changed.length === 1 ? "" : "s"} since your last brief`);
  if (newIntake.length) parts.push(`${newIntake.length} new from Deal Finder`);
  if (!parts.length && risk.length) parts.push(`${risk.length} carrying data risk`);

  if (!parts.length) return `${total} active opportunit${total === 1 ? "y" : "ies"}, nothing flagged.`;
  return `${sentence(parts)}.`;
}

function sentence(parts) {
  if (parts.length === 1) return capitalize(parts[0]);
  return capitalize(parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const describe = (o) => `${o.address || o.code || o.id} (${o.stageLabel})`;
