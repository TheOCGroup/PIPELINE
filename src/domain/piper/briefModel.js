/** Piper's operating brief — pure derivation from a context snapshot. */
import { money } from "../../services/piperContextService.js";

export function buildBrief(snapshot) {
  const open = snapshot.opportunities.filter((o) => !o.closed);
  const dispositionWork = snapshot.opportunities
    .filter((o) => o.disposition && o.disposition.status !== "completed")
    .map((o) => ({
      opportunityId:o.id,
      label:`${o.address || o.code || o.id} — ${o.disposition.dispositionType.toUpperCase()} execution`,
      reasons:[o.dispositionNextAction || `Continue approved ${o.disposition.dispositionType} disposition execution.`],
      status:o.disposition.status,
      action:{kind:"open_opportunity",opportunityId:o.id},
    }));

  const needsYou = open.filter((o) => decisionsFor(o).length > 0).map((o) => ({opportunityId:o.id,label:describe(o),reasons:decisionsFor(o)}));
  const stalled = open.filter((o) => o.stalled).sort((a,b)=>(b.daysSinceActivity||0)-(a.daysSinceActivity||0)).map((o)=>({opportunityId:o.id,label:describe(o),reasons:[`No movement for ${o.daysSinceActivity} day(s) in ${o.stageLabel}, and no open next action.`]}));

  const changed = [
    ...snapshot.recent.stageEvents.map((e)=>({opportunityId:e.opportunity_id,label:`Stage moved ${e.prior_stage||"—"} → ${e.new_stage}`,reasons:[`Changed by ${e.changed_by}${e.reason?` — ${e.reason}`:""}.`]})),
    ...snapshot.recent.classificationChanges.map((c)=>({opportunityId:c.opportunity_id,label:`Classification ${c.prior_classification||"NONE"} → ${c.new_classification}`,reasons:[`Determined by ${c.determined_by} — ${c.reason}`]})),
    ...snapshot.recent.victorUpdates.map((v)=>({opportunityId:v.opportunity_id,label:`Underwriting snapshot recorded${v.attributedTo.agent?` from ${v.attributedTo.agent} (${v.attributedTo.system})`:""}`,reasons:[`Ceiling ${money(v.underwriting_mao_snapshot)}, ARV ${money(v.underwriting_arv_snapshot)}${v.underwriting_confidence?`, confidence ${v.underwriting_confidence}`:""}.`]})),
  ];

  const newIntake = snapshot.recent.intakes.filter((i)=>i.attributedTo.agent==="Hunter").map((i)=>({opportunityId:i.opportunityId,label:i.address?`New intake — ${i.address}`:"New intake",reasons:[`Delivered by ${i.attributedTo.agent} (${i.attributedTo.system}); stored actor "${i.attributedTo.storedActor}".`]}));
  const risk = snapshot.opportunities.filter((o)=>o.risks?.length>0 && (!o.closed || (o.disposition && o.disposition.status!=="completed"))).map((o)=>({opportunityId:o.id,label:describe(o),reasons:o.risks.map((r)=>r.detail)}));
  const next = recommendActions({needsYou,stalled,dispositionWork,open});

  const sections=[
    section("NEEDS YOU","Decisions that require you.",needsYou),
    section("EXIT EXECUTION","Approved sell, hold, or refinance work still in motion.",dispositionWork),
    section("STALLED","No movement and no next action.",stalled),
    section("CHANGED","Since your last brief.",changed),
    section("NEW","Fresh intake from Deal Finder.",newIntake),
    section("RISK","Missing data, conflicts, weak economics, and blocked execution.",risk),
    section("NEXT","What Piper recommends.",next),
  ].filter((s)=>s.items.length>0);

  return {headline:headline({needsYou,stalled,changed,newIntake,risk,dispositionWork,total:open.length}),sections,counts:{needsYou:needsYou.length,dispositionExecution:dispositionWork.length,stalled:stalled.length,changed:changed.length,new:newIntake.length,risk:risk.length,next:next.length},evidence:{generatedAt:snapshot.generatedAt,since:snapshot.since,staleThresholdDays:snapshot.staleThresholdDays,opportunitiesConsidered:snapshot.opportunities.length}};
}
function section(title,subtitle,items){return{title,subtitle,items};}
function decisionsFor(o){const reasons=[];if(!o.underwriting.sourceType)reasons.push("No underwriting on record from Victor or Deal Scout, so there is no authorized ceiling to act on.");if(o.provenanceState==="unresolved")reasons.push("Provenance is unresolved — it needs deterministic evidence, and it is not a synthetic determination.");if(o.maxAuthorizedOffer!==null&&o.askingPrice!==null&&o.maxAuthorizedOffer<o.askingPrice)reasons.push(`Authorized ceiling ${money(o.maxAuthorizedOffer)} is below the ${money(o.askingPrice)} ask, so proceeding needs your call.`);return reasons;}
function recommendActions({needsYou,stalled,dispositionWork,open}){const out=[];for(const d of dispositionWork.slice(0,5))out.push({opportunityId:d.opportunityId,label:d.reasons[0],reasons:[`${d.label} remains ${d.status}.`],action:d.action});for(const s of stalled.slice(0,5))out.push({opportunityId:s.opportunityId,label:"Set a next action or move the stage",reasons:[`${s.label} has stalled; recording a next action puts it back in the working set.`],action:{kind:"create_next_action",opportunityId:s.opportunityId}});for(const n of needsYou.slice(0,5))out.push({opportunityId:n.opportunityId,label:"Review and decide",reasons:[n.reasons[0]],action:{kind:"open_opportunity",opportunityId:n.opportunityId}});const missing=open.filter((o)=>!o.underwriting.sourceType);if(missing.length>2)out.push({opportunityId:null,label:`Request Deal Scout underwriting for ${missing.length} opportunities`,reasons:["PIPELINE snapshots underwriting from Victor; it never computes it, so these cannot be priced here."],action:{kind:"none"}});return out;}
function headline({needsYou,stalled,changed,newIntake,risk,dispositionWork,total}){if(total===0&&!dispositionWork.length)return"No active opportunities or disposition work in PIPELINE right now.";const parts=[];if(needsYou.length)parts.push(`${needsYou.length} need${needsYou.length===1?"s":""} your decision`);if(dispositionWork.length)parts.push(`${dispositionWork.length} exit execution${dispositionWork.length===1?"":"s"} in motion`);if(stalled.length)parts.push(`${stalled.length} stalled`);if(changed.length)parts.push(`${changed.length} change${changed.length===1?"":"s"} since your last brief`);if(newIntake.length)parts.push(`${newIntake.length} new from Deal Finder`);if(!parts.length&&risk.length)parts.push(`${risk.length} carrying data or execution risk`);if(!parts.length)return`${total} active opportunit${total===1?"y":"ies"}, nothing flagged.`;return`${sentence(parts)}.`;}
function sentence(parts){if(parts.length===1)return capitalize(parts[0]);return capitalize(parts.slice(0,-1).join(", ")+" and "+parts[parts.length-1]);}
const capitalize=(s)=>s.charAt(0).toUpperCase()+s.slice(1);
const describe=(o)=>`${o.address||o.code||o.id} (${o.stageLabel})`;
