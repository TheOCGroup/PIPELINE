/**
 * The structured intelligence report — the Charlie-format aggregation the
 * founder's brief tooling consumes (Issue #1, OCG System Owner Agent
 * Standard).
 *
 * Pure derivation from the same bounded snapshot Piper reasons over, plus —
 * when a work room is supplied — the live count of founder escalations Piper
 * has recorded. Every figure is the snapshot's basis-labeled figure object
 * ({ value, basis, source }); nothing is recomputed, estimated, or rounded
 * here. A figure PIPELINE does not hold appears as basis "unknown" with a
 * null value — never as a zero and never as a guess.
 *
 * Versioned on purpose: `reportVersion` is the contract. Consumers key off
 * it, so the shape only changes with a version bump.
 *
 * v2 (F2 correction): portfolio totals now count each opportunity ONCE.
 * v1 inherited the snapshot's old one-row-per-(opportunity × ref) JOIN, so
 * a multi-ref opportunity was counted once per ref (QUINCEY F2). The
 * snapshot now carries one entry per opportunity citing its governing ref
 * (Delta B newest-first selection, disclosed per opportunity as
 * `underwriting.governingRefId` and once at the top in
 * `evidence.governingRefSelection`); every stored ref remains visible per
 * opportunity under `underwriting.references` with its own basis-labeled
 * figures, so per-reference provenance survives the dedupe.
 */

import { buildBrief } from "../../domain/piper/briefModel.js";
import { NEWEST_REF_ORDER } from "../piperContextService.js";

export const INTELLIGENCE_REPORT_VERSION = 2;

export function buildIntelligenceReport(snapshot, { workRoom = null } = {}) {
  const brief = buildBrief(snapshot);
  const needsYou = brief.sections.find((s) => s.title === "NEEDS YOU");

  const openDecisions = (needsYou?.items || []).map((i) => ({
    opportunityId: i.opportunityId,
    label: i.label,
    reasons: i.reasons,
  }));

  const risks = [];
  for (const o of snapshot.opportunities) {
    for (const r of o.risks || []) {
      risks.push({ opportunityId: o.id, kind: r.kind, detail: r.detail });
    }
  }

  const byStage = {};
  for (const o of snapshot.opportunities) {
    if (!o.closed) byStage[o.stage] = (byStage[o.stage] || 0) + 1;
  }

  // Open founder escalations: Piper-recorded work-room tasks directed to the
  // Founder and still awaiting founder action. Read from the same append-only
  // substrate the escalation tool writes — never from a parallel store.
  let escalations = null;
  if (workRoom) {
    const open = workRoom
      .list({ state: "awaiting_approval", limit: 250 })
      .filter((t) => t.director === "Founder");
    escalations = {
      open: open.length,
      items: open.map((t) => ({
        id: t.id,
        title: t.title,
        opportunityId: t.opportunity_id,
        blocker: t.blocker,
        updatedAt: t.updated_at,
      })),
    };
  }

  return {
    reportVersion: INTELLIGENCE_REPORT_VERSION,
    kind: "charlie_intelligence_report",
    generatedAt: snapshot.generatedAt,
    evidence: {
      since: snapshot.since,
      opportunitiesConsidered: snapshot.opportunities.length,
      staleThresholdDays: snapshot.staleThresholdDays,
      governingRefSelection: `one governing underwriting reference per opportunity — newest first (${NEWEST_REF_ORDER})`,
    },
    headline: brief.headline,
    briefCounts: brief.counts,
    portfolio: { totals: snapshot.totals, byStage },
    openDecisions,
    risks,
    escalations,
    opportunities: snapshot.opportunities.map((o) => ({
      id: o.id,
      code: o.code,
      address: o.address,
      stage: o.stage,
      stageLabel: o.stageLabel,
      status: o.status,
      closed: o.closed,
      stalled: o.stalled,
      daysSinceActivity: o.daysSinceActivity,
      provenanceState: o.provenanceState,
      recordClassification: o.recordClassification,
      figures: o.figures || null,
      underwriting: {
        status: o.underwriting.status,
        source: o.underwriting.sourceType,
        attributedTo: o.underwriting.attributedTo,
        confidence: o.underwriting.confidence,
        limitations: o.underwriting.limitations,
        recordedAt: o.underwriting.recordedAt,
        // The deterministic ref the row's figures (and therefore every
        // portfolio total) cite, plus the full per-reference detail.
        governingRefId: o.underwriting.refId ?? null,
        references: (o.underwritingRefs || []).map((ref) => ({
          refId: ref.id,
          sourceId: ref.sourceId,
          source: ref.sourceSystem,
          status: ref.status,
          analyzedAt: ref.analyzedAt,
          recordedAt: ref.recordedAt,
          governing: ref.governing,
          confidence: ref.confidence,
          limitations: ref.limitations,
          figures: ref.figures,
        })),
      },
      missing: o.missing,
      riskKinds: (o.risks || []).map((r) => r.kind),
      openNextActionCount: o.openNextActionCount,
    })),
  };
}
