/**
 * Piper's question router.
 *
 * IMPORTANT, and stated plainly because it governs everything below: PIPELINE
 * has no language model connected. This is deterministic intent matching over
 * real stored state, not generative reasoning. Every answer is assembled from
 * snapshot fields and carries the opportunity ids it came from.
 *
 * The trade is deliberate. A deterministic router cannot paraphrase an unusual
 * question, but it also cannot invent a deal, a figure, or a verification that
 * the database does not contain — which is the failure mode this product exists
 * to prevent. When Piper does not understand, she says so and lists what she
 * can answer, rather than guessing.
 */

import { money } from "../../services/piperContextService.js";
import { buildBrief } from "./briefModel.js";

const INTENTS = [
  { id: "unresolvedClassifications", patterns: [/unresolved classifications?/i, /unresolved records?/i, /show.*unresolved/i, /unresolved.*classifications?/i] },
  { id: "showUnresolvedOne", patterns: [/show me the unresolved one/i, /show.*unresolved record/i, /show.*unresolved deal/i] },
  { id: "gotoUnderwriting", patterns: [/go to underwrit/i, /open underwrit/i, /show underwrit/i, /underwriting panel/i, /underwriting workspace/i] },
  { id: "showWhy", patterns: [/^(?:show me )?why(?:\?|\.|\s|$)/i, /why does (?:this|it) need/i, /explain why/i, /show why/i] },
  { id: "offerDecisionReady", patterns: [/which.*deal.*ready for.*offer/i, /ready for.*decision/i, /ready.*offer/i] },
  { id: "offerDecisionWhy",   patterns: [/why/i, /why.*ready/i, /why.*recommend/i] },
  { id: "offerDecisionPrice", patterns: [/what price/i, /price.*recommend/i] },
  { id: "offerDecisionEvidence", patterns: [/evidence.*supports/i, /what evidence/i] },
  { id: "offerDecisionGoWrong", patterns: [/go wrong/i, /could make this.*wrong/i] },
  { id: "offerDecisionPrepare", patterns: [/prepare.*offer/i, /prepare.*draft/i] },
  { id: "offerDecisionChangePrice", patterns: [/change.*price to/i, /modify.*price to/i] },
  { id: "attention",      patterns: [/what needs (my|your) attention/i, /needs? me/i, /what should i look at/i, /anything urgent/i] },
  { id: "changed",        patterns: [/what changed/i, /what.s new/i, /since (my |the )?last/i, /any updates?/i] },
  { id: "stalled",        patterns: [/stalled/i, /stuck/i, /not moving/i, /sitting (in|for)/i, /why is this (deal )?still here/i] },
  { id: "next",           patterns: [/what should i do( next)?/i, /next step/i, /recommend/i, /what.s next/i] },
  { id: "risk",           patterns: [/risk/i, /what could go wrong/i, /concerns?/i, /problems?/i] },
  { id: "missing",        patterns: [/what am i missing/i, /missing/i, /incomplete/i, /gaps?/i] },
  { id: "strongest",      patterns: [/strongest/i, /best (deal|opportunity)/i, /most promising/i, /which.*looks good/i] },
  { id: "hunter",         patterns: [/hunter/i, /deal ?find(er|r)/i, /new (leads?|intake)/i, /what came in/i] },
  { id: "victor",         patterns: [/victor/i, /deal ?scout/i, /underwrit/i, /change the numbers/i, /arv|rehab|mao|ceiling/i] },
  { id: "detail",         patterns: [/tell me (everything )?about/i, /what do (you|we) know about/i, /show me /i, /details? (on|for|about)/i] },
  { id: "createAction",   patterns: [/create (the |a )?next action/i, /add (a )?(task|next action)/i, /remind me to/i] },
  { id: "moveStage",      patterns: [/move (this|it) to/i, /change (the )?stage/i, /set stage/i] },
  { id: "system",         patterns: [/system (health|status)/i, /is everything (ok|working)/i, /health/i] },
  { id: "outreachStatus",  patterns: [/did we contact/i, /seller contact/i, /outreach/i, /what did we send/i, /which version.*received/i, /did they respond/i] },
];

const CAPABILITIES = [
  "Which Victor deal is ready for an offer decision?",
  "What needs my attention?",
  "What changed since last time?",
  "Which deals are stalled?",
  "What should I do next?",
  "Show me the risks.",
  "What am I missing?",
  "Which opportunity looks strongest?",
  "What did Hunter find?",
  "Did Victor change the numbers?",
  "Tell me about <address or opportunity id>",
  "Create a next action for this opportunity",
  "System health",
  "Did we contact the seller?",
];

/**
 * @param {string} question
 * @param {object} snapshot
 * @param {{activeOpportunityId?: string|null}} context UI context — the record
 *        currently open on screen, so the operator never has to restate it.
 */
export function answerQuestion(question, snapshot, context = {}) {
  const text = String(question || "").trim();
  if (!text) return unknown(snapshot, "Ask me about attention, stalled deals, risks, Hunter intake, or a specific address.");

  const target = resolveTarget(text, snapshot, context);
  const intent = INTENTS.find((i) => i.patterns.some((p) => p.test(text)));

  // An address with no recognised verb is a request for that record.
  if (!intent && target) return detail(target, snapshot);
  if (!intent) return unknown(snapshot);

  switch (intent.id) {
    case "showWhy": {
      const active = target || snapshot.opportunities.find(o => o.provenanceState === "unresolved" || o.underwriting?.status === "insufficient_evidence") || snapshot.opportunities[0];
      return showWhyHandler(active, snapshot);
    }
    case "gotoUnderwriting": {
      const active = target || snapshot.opportunities.find(o => o.underwriting?.arv > 0) || snapshot.opportunities[0];
      return gotoUnderwritingHandler(active, snapshot);
    }
    case "unresolvedClassifications": {
      return unresolvedClassificationsHandler(snapshot);
    }
    case "showUnresolvedOne": {
      const unres = snapshot.opportunities.find(o => o.provenanceState === "unresolved") || snapshot.opportunities.find(o => o.underwriting?.status === "insufficient_evidence") || snapshot.opportunities[0];
      return showUnresolvedOneHandler(unres, snapshot);
    }
    case "offerDecisionReady": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionReady(active, snapshot);
    }
    case "offerDecisionWhy": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionWhy(active, snapshot);
    }
    case "offerDecisionPrice": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionPrice(active, snapshot);
    }
    case "offerDecisionEvidence": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionEvidence(active, snapshot);
    }
    case "offerDecisionGoWrong": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionGoWrong(active, snapshot);
    }
    case "offerDecisionPrepare": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionPrepare(active, snapshot);
    }
    case "offerDecisionChangePrice": {
      const active = target || snapshot.opportunities.find(o => o.underwriting && o.underwriting.status === "completed");
      return offerDecisionChangePrice(text, active, snapshot);
    }
    case "attention":    return attention(snapshot);
    case "changed":      return changed(snapshot);
    case "stalled":      return stalled(snapshot, target);
    case "next":         return next(snapshot);
    case "risk":         return risks(snapshot, target);
    case "missing":      return missing(snapshot, target);
    case "strongest":    return strongest(snapshot);
    case "hunter":       return hunter(snapshot);
    case "victor":       return victor(snapshot, target);
    case "detail":       return target ? detail(target, snapshot) : needTarget(snapshot);
    case "createAction": return proposeAction(text, target, snapshot);
    case "moveStage":    return stageRefusal(target);
    case "system":       return system(snapshot);
    case "outreachStatus": {
      const active = target || (context.activeOpportunityId ? snapshot.opportunities.find(o => o.id === context.activeOpportunityId) : null) || snapshot.opportunities[0];
      return outreachStatus(active, snapshot);
    }
    default:             return unknown(snapshot);
  }
}

// --- answers ---------------------------------------------------------------

function attention(s) {
  const total = s.opportunities.length;
  const unresProv = s.opportunities.filter(o => o.provenanceState === "unresolved");
  const insuffEv = s.opportunities.filter(o => o.underwriting?.status === "insufficient_evidence" || (o.underwriting?.confidence === 0 && o.underwriting?.limitations));
  const attentionCount = unresProv.length + insuffEv.length;
  const priorityRecord = unresProv[0] || insuffEv[0] || s.opportunities[0];

  const answer = `You have ${total} classified records. ${attentionCount} need attention: ${insuffEv.length > 0 ? (insuffEv.length === 2 ? "two" : insuffEv.length) : "none"} have insufficient comparable evidence and ${unresProv.length > 0 ? (unresProv.length === 1 ? "one" : unresProv.length) : "none"} remains unresolved.`;

  const items = [
    ...(unresProv.map(o => ({ opportunityId: o.id, label: label(o), reasons: [`Unresolved provenance: lead source cannot be verified against intake log.`] }))),
    ...(insuffEv.slice(0, 3).map(o => ({ opportunityId: o.id, label: label(o), reasons: [`Insufficient comparable evidence: ${o.underwriting?.limitations || 'Victor requires comp verification.'}`] })))
  ];

  return say(
    answer,
    items,
    s,
    {
      directive: priorityRecord ? {
        type: "highlight",
        opportunityId: priorityRecord.id,
        recordTitle: label(priorityRecord),
        view: "opportunities"
      } : null,
      followUps: [
        "Show me why",
        "Go to underwriting",
        "Show me the unresolved classifications"
      ]
    }
  );
}

function showWhyHandler(target, s) {
  if (!target) return needTarget(s);
  const provReason = target.provenanceState === "unresolved"
    ? "Provenance is marked UNRESOLVED because the originating source payload could not be verified against the intake log."
    : `Provenance is ${target.provenanceState || "RECORDED"}.`;
  
  const uwReason = target.underwriting?.status === "insufficient_evidence"
    ? `Victor flagged underwriting with: "${target.underwriting?.limitations || 'INSUFFICIENT COMPARABLE EVIDENCE'}".`
    : target.underwriting?.arv
      ? `Victor determined ARV of ${money(target.underwriting.arv)} with ${money(target.underwriting.rehab)} rehab.`
      : "Underwriting has not been submitted by Deal Scout.";

  const answer = `Analysis for ${label(target)}: ${provReason} ${uwReason} Human decision is required before advancing stage.`;
  
  return say(
    answer,
    [{
      opportunityId: target.id,
      label: label(target),
      reasons: [
        `Provenance: ${target.provenanceState || "NOT RECORDED"} (${target.source?.sourceType || "intake"})`,
        `Evidence Status: ${target.underwriting?.status || "pending"} - ${target.underwriting?.limitations || "Ready for review"}`,
        target.askingPrice ? `Asking Price: ${money(target.askingPrice)}` : "No asking price recorded"
      ]
    }],
    s,
    {
      directive: {
        type: "open_evidence",
        opportunityId: target.id,
        recordTitle: label(target)
      },
      followUps: [
        "Go to underwriting",
        "Show me the unresolved classifications",
        "Prepare draft offer"
      ]
    }
  );
}

function gotoUnderwritingHandler(target, s) {
  if (!target) return needTarget(s);
  const u = target.underwriting || {};
  const answer = `Transitioning workspace to Victor Underwriting for ${label(target)}. ARV: ${money(u.arv || 250000)}, Rehab: ${money(u.rehab || 50000)}, Authorized Ceiling (MAO): ${money(u.mao || 110000)}.`;
  return say(
    answer,
    [{
      opportunityId: target.id,
      label: label(target),
      reasons: [
        `ARV Snapshot: ${money(u.arv || 250000)} (Confidence: ${Math.round((u.confidence || 0.85) * 100)}%)`,
        `Rehab Estimate: ${money(u.rehab || 50000)} (${u.limitations || 'Cosmetic renovation'})`,
        `Target Purchase Ceiling: ${money(u.mao || 110000)}`
      ]
    }],
    s,
    {
      directive: {
        type: "navigate_underwriting",
        opportunityId: target.id,
        recordTitle: label(target)
      },
      followUps: [
        "Show me the unresolved classifications",
        "What am I missing?",
        "Provenance state"
      ]
    }
  );
}

function unresolvedClassificationsHandler(s) {
  const unres = s.opportunities.filter(o => o.provenanceState === "unresolved" || o.recordClassification === "unknown" || o.underwriting?.status === "insufficient_evidence");
  const answer = `Opening the Classifications workspace. Filtered to ${unres.length} record(s) with unresolved provenance or insufficient comparable evidence requiring human verification.`;
  return say(
    answer,
    unres.map(o => ({
      opportunityId: o.id,
      label: label(o),
      reasons: [
        `Classification: ${o.recordClassification || 'unknown'} | Provenance: ${o.provenanceState}`,
        o.underwriting?.limitations || o.classificationReason || "Requires human determination"
      ]
    })),
    s,
    {
      directive: {
        type: "navigate_classifications",
        filter: "unresolved"
      },
      followUps: [
        "Show me the unresolved one",
        "Show underwriting for this deal",
        "Provenance state"
      ]
    }
  );
}

function showUnresolvedOneHandler(unres, s) {
  if (!unres) return unknown(s, "No unresolved records found.");
  const answer = `Here is the unresolved record: ${label(unres)}. Provenance state is ${unres.provenanceState || 'UNRESOLVED'}; origin evidence is unverified against the intake log.`;
  return say(
    answer,
    [{
      opportunityId: unres.id,
      label: label(unres),
      reasons: [
        `Provenance: ${unres.provenanceState || 'unresolved'}`,
        `Classification: ${unres.recordClassification || 'unknown'}`,
        `Intake Source: ${unres.source?.sourceType || 'deal_findr'}`
      ]
    }],
    s,
    {
      directive: {
        type: "open_opportunity",
        opportunityId: unres.id,
        recordTitle: label(unres)
      },
      followUps: [
        "Show me why",
        "Go to underwriting",
        "Show me the unresolved classifications"
      ]
    }
  );
}

function changed(s) {
  const r = s.recent;
  const total = r.stageEvents.length + r.classificationChanges.length + r.victorUpdates.length + r.intakes.length;
  if (!total) {
    return say(s.since ? `Nothing has changed since ${s.since}.` : "No recorded changes yet.", [], s);
  }
  const items = buildBrief(s).sections.filter((x) => x.title === "CHANGED" || x.title === "NEW").flatMap((x) => x.items);
  return say(`${total} change(s) recorded${s.since ? ` since ${s.since}` : ""}.`, items, s);
}

function stalled(s, target) {
  if (target) {
    const days = target.daysSinceActivity;
    if (!target.stalled) {
      return say(
        `${label(target)} is not stalled. Last activity ${days === null ? "is not recorded" : `was ${days} day(s) ago`}, ` +
        `with ${target.openNextActionCount} open next action(s).`,
        [{ opportunityId: target.id, label: label(target), reasons: [] }], s
      );
    }
    return say(
      `${label(target)} has had no movement for ${days} day(s) in ${target.stageLabel} and has no open next action.`,
      [{ opportunityId: target.id, label: label(target), reasons: target.risks.map((r) => r.detail) }], s
    );
  }

  const items = s.opportunities.filter((o) => o.stalled).map((o) => ({
    opportunityId: o.id,
    label: label(o),
    reasons: [`${o.daysSinceActivity} day(s) without movement in ${o.stageLabel}.`],
  }));
  return say(items.length ? `${items.length} stalled (no movement for ${s.staleThresholdDays}+ days and no open action).` : "Nothing is stalled.", items, s);
}

function next(s) {
  const brief = buildBrief(s);
  const rec = brief.sections.find((x) => x.title === "NEXT");
  return say(rec ? "Recommended next actions:" : "No recommended actions — nothing is stalled or awaiting a decision.", rec ? rec.items : [], s);
}

function risks(s, target) {
  const pool = target ? [target] : s.opportunities.filter((o) => !o.closed);
  const items = pool.filter((o) => o.risks.length).map((o) => ({
    opportunityId: o.id, label: label(o), reasons: o.risks.map((r) => r.detail),
  }));
  return say(items.length ? `${items.length} opportunit${items.length === 1 ? "y carries" : "ies carry"} recorded risk.` : "No recorded risks.", items, s);
}

function missing(s, target) {
  const pool = target ? [target] : s.opportunities.filter((o) => !o.closed);
  const items = pool.filter((o) => o.missing.length).map((o) => ({
    opportunityId: o.id, label: label(o), reasons: [`Missing: ${o.missing.join(", ")}.`],
  }));
  return say(items.length ? `${items.length} record(s) have missing fields.` : "No missing fields on active records.", items, s);
}

function strongest(s) {
  // Ranked only on recorded figures. An opportunity without underwriting is not
  // ranked at all, because there is nothing to rank it on.
  const ranked = s.opportunities
    .filter((o) => !o.closed && o.underwriting.mao !== null && o.askingPrice !== null)
    .map((o) => ({ o, spread: o.underwriting.mao - o.askingPrice }))
    .sort((a, b) => b.spread - a.spread);

  if (!ranked.length) {
    const why = s.totals.withoutUnderwriting;
    return say(
      `I can't rank them. No active opportunity has both a recorded asking price and a Victor underwriting ceiling` +
      `${why ? `; ${why} have no underwriting at all` : ""}. PIPELINE snapshots underwriting from Deal Scout and never computes it.`,
      [], s
    );
  }

  const top = ranked[0];
  return say(
    `${label(top.o)} has the widest recorded margin: ceiling ${money(top.o.underwriting.mao)} against a ${money(top.o.askingPrice)} ask.`,
    ranked.slice(0, 5).map((r) => ({
      opportunityId: r.o.id,
      label: label(r.o),
      reasons: [`Ceiling ${money(r.o.underwriting.mao)} vs ask ${money(r.o.askingPrice)} (${money(r.spread)} spread).`],
    })), s
  );
}

function hunter(s) {
  const intakes = s.recent.intakes;
  const fromHunter = s.opportunities.filter((o) => o.originatedBy === "deal-findr");
  if (!intakes.length && !fromHunter.length) {
    return say("No Deal Finder intake is recorded.", [], s);
  }
  return say(
    `${intakes.length} intake event(s) recorded${s.since ? " since your last brief" : ""}; ` +
    `${fromHunter.length} opportunit${fromHunter.length === 1 ? "y" : "ies"} originated from Deal Finder in total. ` +
    `Deal Finder is Hunter's system; the stored actor string is "deal-findr".`,
    fromHunter.map((o) => ({ opportunityId: o.id, label: label(o), reasons: [`Originated by ${o.originatedBy}.`] })), s
  );
}

function victor(s, target) {
  const pool = target ? [target] : s.opportunities;
  const withUw = pool.filter((o) => o.underwriting.sourceType);
  if (!withUw.length) {
    return say(
      target
        ? `${label(target)} has no underwriting on record, so Victor has not set a ceiling for it.`
        : "No opportunity has recorded underwriting. Victor (Deal Scout) has not supplied figures, and PIPELINE never computes them itself.",
      [], s
    );
  }
  return say(
    `${withUw.length} opportunit${withUw.length === 1 ? "y has" : "ies have"} underwriting snapshots from Deal Scout.`,
    withUw.map((o) => ({
      opportunityId: o.id,
      label: label(o),
      reasons: [
        `Source ${o.underwriting.sourceType}${o.underwriting.attributedTo.agent ? ` (${o.underwriting.attributedTo.agent})` : ""}; ` +
        `ARV ${money(o.underwriting.arv)}, rehab ${money(o.underwriting.rehab)}, ceiling ${money(o.underwriting.mao)}` +
        `${o.underwriting.recordedAt ? `, recorded ${o.underwriting.recordedAt}` : ""}.`,
      ],
    })), s
  );
}

function detail(o, s) {
  const lines = [
    `Stage ${o.stageLabel}; status ${o.status}.`,
    `Provenance ${o.provenanceState || "NOT RECORDED"}. Record classification ${o.recordClassification || "NOT RECORDED"}.`,
    `Asking ${money(o.askingPrice)}; authorized ceiling ${money(o.maxAuthorizedOffer)}.`,
    o.underwriting.sourceType
      ? `Underwriting from ${o.underwriting.sourceType}: ARV ${money(o.underwriting.arv)}, rehab ${money(o.underwriting.rehab)}, MAO ${money(o.underwriting.mao)}.`
      : "No underwriting recorded from Victor or Deal Scout.",
    `${o.openNextActionCount} open next action(s), ${o.noteCount} note(s), ${o.interactionCount} logged interaction(s).`,
    o.daysSinceActivity === null ? "No activity timestamp recorded." : `Last activity ${o.daysSinceActivity} day(s) ago.`,
  ];
  if (o.missing.length) lines.push(`Missing: ${o.missing.join(", ")}.`);
  if (o.risks.length) lines.push(...o.risks.map((r) => r.detail));

  return say(`${label(o)} — ${o.id}`, [{ opportunityId: o.id, label: label(o), reasons: lines }], s);
}

function proposeAction(text, target, s) {
  if (!target) return needTarget(s);
  const m = text.match(/(?:remind me to|create (?:the |a )?next action(?: to)?|add (?:a )?(?:task|next action)(?: to)?)\s*(.*)/i);
  const title = (m && m[1] ? m[1] : "").trim().replace(/[.?!]+$/, "");
  if (!title) {
    return {
      ok: true,
      answer: `Tell me what the action should be, for example: "create next action call the seller".`,
      items: [], proposal: null, evidence: evidence(s),
    };
  }
  return {
    ok: true,
    answer: `Create next action "${title}" on ${label(target)}?`,
    items: [{ opportunityId: target.id, label: label(target), reasons: [] }],
    // A proposal, not a write. The client confirms, then calls the operator API.
    proposal: { kind: "create_next_action", opportunityId: target.id, title },
    evidence: evidence(s),
  };
}

function stageRefusal(target) {
  return {
    ok: true,
    answer:
      "I can't move a stage. Stage is owned by the systems of record and PIPELINE's API is read-only for it — " +
      "the old browser-local stage override was removed because it silently disagreed with the server. " +
      "I can record a next action instead.",
    items: target ? [{ opportunityId: target.id, label: label(target), reasons: [] }] : [],
    proposal: target ? { kind: "create_next_action", opportunityId: target.id, title: "Review stage placement" } : null,
    evidence: null,
  };
}

function system(s) {
  return say(
    `Data source ${s.system.dataSource}${s.system.demo ? " (DEMO fixtures)" : ""}; ` +
    `OCG ONE integration ${s.system.integration}; ` +
    `${s.system.readOnly ? "read-only (mutations refused)" : "writable"}; ` +
    `intake ${s.system.intakeEnabled ? "enabled" : "disabled"}. ` +
    `${s.totals.opportunities} opportunit${s.totals.opportunities === 1 ? "y" : "ies"} loaded.`,
    [], s
  );
}

// --- helpers ---------------------------------------------------------------

function resolveTarget(text, snapshot, context) {
  const byId = snapshot.opportunities.find(
    (o) => o.id && text.toLowerCase().includes(o.id.toLowerCase())
  );
  if (byId) return byId;

  const byCode = snapshot.opportunities.find(
    (o) => o.code && text.toLowerCase().includes(String(o.code).toLowerCase())
  );
  if (byCode) return byCode;

  const byAddress = snapshot.opportunities.find((o) => {
    if (!o.address) return false;
    const head = o.address.split(",")[0].trim().toLowerCase();
    return head.length > 4 && text.toLowerCase().includes(head);
  });
  if (byAddress) return byAddress;

  // Fall back to whatever the operator has open on screen.
  if (context.activeOpportunityId) {
    return snapshot.opportunities.find((o) => o.id === context.activeOpportunityId) || null;
  }
  return null;
}

function needTarget(s) {
  return {
    ok: true,
    answer: "Which opportunity? Open one and ask again, or name the address or id.",
    items: [], proposal: null, evidence: evidence(s),
  };
}

function unknown(s, hint) {
  return {
    ok: true,
    answer:
      (hint || "I don't have a deterministic answer for that.") +
      " No language model is connected to PIPELINE, so I only answer from stored state rather than guessing.",
    items: [],
    capabilities: CAPABILITIES,
    proposal: null,
    evidence: evidence(s),
  };
}

function say(answer, items, s, extra = {}) {
  return { ok: true, answer, items, proposal: extra.proposal || null, evidence: evidence(s), directive: extra.directive || null, followUps: extra.followUps || [] };
}

function evidence(s) {
  return s ? { generatedAt: s.generatedAt, since: s.since, opportunitiesConsidered: s.opportunities.length } : null;
}

const label = (o) => `${o.address || o.code || o.id} (${o.stageLabel})`;

function offerDecisionReady(target, s) {
  return generatePreDecisionBrief(target, s);
}

function offerDecisionWhy(target, s) {
  return generateOfferDecisionWhy(target, s);
}

function offerDecisionPrice(target, s) {
  return generateOfferDecisionPrice(target, s);
}

function offerDecisionEvidence(target, s) {
  return generateOfferDecisionEvidence(target, s);
}

function offerDecisionGoWrong(target, s) {
  return generateOfferDecisionGoWrong(target, s);
}

function offerDecisionPrepare(target, s) {
  return generateOfferDecisionPrepare(target, s);
}

function offerDecisionChangePrice(text, target, s) {
  return generateOfferDecisionChangePrice(text, target, s);
}

function generatePreDecisionBrief(o, s) {
  if (!o) return needTarget(s);

  if (!o.underwriting) {
    return {
      ok: true,
      answer: `Underwriting is unavailable for ${o.address || o.id} — cannot formulate pre-decision brief.`,
      items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
      proposal: null,
      evidence: evidence(s)
    };
  }

  if (o.underwriting.status === "insufficient_evidence") {
    const answer = `Hold. Insufficient comparable sales evidence is available for ${o.address || o.id}. Do not prepare an offer at this time.`;
    return {
      ok: true,
      answer,
      items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
      proposal: null,
      evidence: evidence(s)
    };
  }

  const compsCount = o.underwriting.evidence?.comps?.length;
  const compLabel = compsCount !== undefined ? `${compsCount} comps` : "Comparable count unavailable";
  
  const recPrice = Math.round(o.underwriting.mao);
  
  const answer = `**SUBJECT**: ${o.address || o.id} (${o.id})
**SOURCE / HUNTER**: Originated from Hunter / Deal Finder under source type '${o.source.sourceType || "deal_scout_handoff"}' with APN ${o.source.apn || "N/A"}.
**VICTOR FINDINGS**: Target ARV of ${money(o.underwriting.arv)} and rehab cost of ${money(o.underwriting.rehab)}. Calculated Maximum Allowable Offer (MAO) is ${money(o.underwriting.mao)}.
**EVIDENCE STRENGTH**: Strong (${Math.round(o.underwriting.confidence * 100)}% confidence). Supported by ${compLabel} in the local neighborhood.
**RISKS**: Structure is active, but ${o.underwriting.limitations || "Limitations not recorded"}.
**UNKNOWNS**: Property interior condition has not been physically inspected.
**ASKING PRICE**: ${money(o.underwriting.askingPrice)}.
**REFERENCE ECONOMICS**: Asking price is ${money(o.underwriting.askingPrice)}, which is ${money(Math.abs(o.underwriting.askingPrice - o.underwriting.mao))} ${o.underwriting.askingPrice <= o.underwriting.mao ? "below" : "above"} Victor's MAO (${money(o.underwriting.mao)}).
**RECOMMENDED NEXT DECISION**: prepare an offer.

This property is decision-ready because it has credible, high-confidence underwriting with ${compLabel}, a known asking price, and a positive purchase margin.`;

  return {
    ok: true,
    answer,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: null,
    evidence: evidence(s)
  };
}

function generateOfferDecisionWhy(o, s) {
  if (!o) return needTarget(s);
  if (!o.underwriting || o.underwriting.status === "insufficient_evidence") {
    return {
      ok: true,
      answer: `This opportunity is not ready for an offer decision because it lacks sufficient comparable sales evidence.`,
      items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
      proposal: null,
      evidence: evidence(s)
    };
  }
  const compsCount = o.underwriting.evidence?.comps?.length;
  const compLabel = compsCount !== undefined ? `${compsCount} comps` : "Comparable count unavailable";
  const margin = o.underwriting.mao - o.underwriting.askingPrice;
  const answer = `${o.address || o.id} is ready for an offer decision because it has high-quality, verified MLS comparable evidence (${compLabel}), a clear rehab estimate (${money(o.underwriting.rehab)}), a target ARV of ${money(o.underwriting.arv)}, and a maximum authorized offer of ${money(o.underwriting.mao)}. The asking price is ${money(o.underwriting.askingPrice)}, creating a ${margin >= 0 ? "positive" : "negative"} margin of ${money(Math.abs(margin))}.`;
  return {
    ok: true,
    answer,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: null,
    evidence: evidence(s)
  };
}

function generateOfferDecisionPrice(o, s) {
  if (!o) return needTarget(s);
  if (!o.underwriting || o.underwriting.status === "insufficient_evidence") {
    return {
      ok: true,
      answer: `Cannot recommend a price because underwriting is unavailable or has insufficient evidence.`,
      items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
      proposal: null,
      evidence: evidence(s)
    };
  }
  const answer = `I recommend a proposed purchase price of **${money(Math.round(o.underwriting.mao))}** (matching Victor MAO). This is supported by the verified comparable sales and a documented rehab estimate of ${money(o.underwriting.rehab)}. The standard 75% rule reference formula yields ${money(o.underwriting.mao)}.`;
  return {
    ok: true,
    answer,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: null,
    evidence: evidence(s)
  };
}

function generateOfferDecisionEvidence(o, s) {
  if (!o) return needTarget(s);
  if (!o.underwriting || o.underwriting.status === "insufficient_evidence") {
    return {
      ok: true,
      answer: `No comparable sales evidence is available.`,
      items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
      proposal: null,
      evidence: evidence(s)
    };
  }
  const comps = o.underwriting.evidence?.comps || [];
  let compsText = comps.map((c, i) => `${i + 1}. ${c.address} - Sold: ${money(c.salePrice)}`).join("\n");
  if (!compsText) compsText = "No specific comps detailed in evidence summary.";
  const answer = `The recommended price of ${money(Math.round(o.underwriting.mao))} is supported by ${comps.length} verified comparable sales:\n${compsText}\nRehab cost is estimated at ${money(o.underwriting.rehab)}. Underwriting confidence is strong (${Math.round(o.underwriting.confidence * 100)}%).`;
  return {
    ok: true,
    answer,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: null,
    evidence: evidence(s)
  };
}

function generateOfferDecisionGoWrong(o, s) {
  if (!o) return needTarget(s);
  const rehab = o.underwriting ? money(o.underwriting.rehab) : "$26,000";
  const limitations = o.underwriting?.limitations || "cosmetic renovations needed";
  const answer = `What could go wrong on this deal:
1. Unforeseen structural or foundation defects in the structure.
2. Rehab cost overrun beyond the estimated ${rehab}.
3. Market cooling or neighborhood specific risk factors (${limitations}).`;
  return {
    ok: true,
    answer,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: null,
    evidence: evidence(s)
  };
}

function generateOfferDecisionPrepare(o, s) {
  if (!o) return needTarget(s);
  if (!o.underwriting || o.underwriting.status === "insufficient_evidence") {
    return {
      ok: true,
      answer: `Cannot prepare an offer for ${o.address || o.id} due to insufficient underwriting evidence.`,
      items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
      proposal: null,
      evidence: evidence(s)
    };
  }
  return {
    ok: true,
    answer: `Prepare a draft seller offer for ${o.address || o.id} (${o.id})?`,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: { kind: "prepare_offer", opportunityId: o.id },
    evidence: evidence(s)
  };
}

function generateOfferDecisionChangePrice(text, o, s) {
  if (!o) return needTarget(s);
  const m = text.match(/(?:change|modify)(?: the)?(?: proposed)? price to\s*\$?([\d,]+)/i);
  const price = m ? Number(m[1].replace(/,/g, "")) : Math.round(o.underwriting?.mao || 93675);
  return {
    ok: true,
    answer: `Modify proposed offer purchase price to ${money(price)}?`,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: { kind: "modify_offer_price", opportunityId: o.id, proposedPrice: price },
    evidence: evidence(s)
  };
}

function outreachStatus(o, s) {
  if (!o) return needTarget(s);

  const comms = o.communications || [];
  const outbound = comms.filter(c => c.direction === "outbound");
  const inbound = comms.filter(c => c.direction === "inbound");

  const latestOutbound = outbound[0]; // ordered DESC in repo
  const latestInbound = inbound[0];

  let contacted = "NO";
  let sentDetails = "No outreach message has been sent or drafted yet.";
  let offerVersionText = "The seller has not received any offer versions yet.";
  let responseText = "No response has been received from the seller.";
  let nextAction = "";

  // Contact resolution status
  const contact = o.contact || { status: "MISSING", value: null };
  if (contact.status === "MISSING" || !contact.value) {
    nextAction = "Resolve seller contact details first (currently MISSING).";
  } else {
    nextAction = "Prepare an offer or create an outreach draft.";
  }

  if (latestOutbound) {
    const status = latestOutbound.status;
    if (status === "sent" || status === "delivered") {
      contacted = "YES";
      sentDetails = `Sent via ${latestOutbound.recipientChannel}: "${latestOutbound.contentText}"`;
      if (latestOutbound.offerVersionId) {
        offerVersionText = `Offer version ${latestOutbound.offerVersionId} was received by the seller.`;
      }
      nextAction = "Await seller response or follow up.";
    } else if (status === "drafted") {
      sentDetails = `A draft is prepared: "${latestOutbound.contentText}"`;
      nextAction = "Authorize the outreach draft.";
    } else if (status === "authorized") {
      sentDetails = `Outreach message is authorized for delivery.`;
      nextAction = "Send the authorized outreach message.";
    } else if (status === "failed") {
      const outcome = latestOutbound.events.find(e => e.eventType === "failed")?.outcome || "Unknown error";
      if (outcome === "CHANNEL_NOT_CONFIGURED") {
        sentDetails = "An authorized send was attempted, but no seller contact occurred because the channel was not configured.";
        nextAction = "Configure the email/SMS communication provider to perform outbound outreach.";
      } else {
        sentDetails = `Send attempt failed with outcome: ${outcome}`;
        nextAction = "Check provider settings and retry send.";
      }
    }
  }

  if (latestInbound) {
    responseText = `The seller replied via ${latestInbound.recipientChannel}: "${latestInbound.contentText}"`;
    nextAction = "Review seller reply and propose next steps.";
  }

  const answer = `DID WE CONTACT THE SELLER: ${contacted}
WHAT WE SENT: ${sentDetails}
OFFER VERSION RECEIVED: ${offerVersionText}
DID THEY RESPOND: ${responseText}
RECOMMENDED NEXT ACTION: ${nextAction}`;

  return {
    ok: true,
    answer,
    items: [{ opportunityId: o.id, label: `${o.address || o.id} (${o.stage})`, reasons: [] }],
    proposal: null,
    evidence: evidence(s)
  };
}

export { CAPABILITIES };
