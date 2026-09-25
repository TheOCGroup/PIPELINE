/**
 * Unified seller timeline (P2 — Pipeline continuation).
 *
 * Aggregates every recorded seller-facing event for one opportunity into a
 * single newest-first list so the founder can answer "What happened with this
 * seller?" at a glance:
 *
 *   lead created · stage changes · notes · follow-ups opened/completed ·
 *   offers · checklist completions · calls / texts / emails · outreach drafts ·
 *   Piper actions (runs + tool calls tied to the opportunity)
 *
 * Works in both data modes: fixture trees (in-memory stageTimeline) and the
 * canonical sqlite store (seller_stage_events table). No invented data — a
 * source with nothing recorded simply contributes no events. No audit noise:
 * raw ids and internal bookkeeping are kept out of the summaries.
 */

const MAX_EVENTS = 100;
const SUMMARY_LEN = 160;

function summarize(text, len = SUMMARY_LEN) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > len ? `${t.slice(0, len - 1).trimEnd()}…` : t;
}

function cleanActor(actor) {
  const a = String(actor ?? "").trim();
  if (!a) return null;
  // Keep human-meaningful actors; drop opaque system ids from the timeline.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a)) return null;
  if (a === "local-operator") return "operator";
  return a;
}

function ev(type, at, summary, actor = null, extra = {}) {
  return { type, at: at || null, summary, actor: cleanActor(actor), ...extra };
}

function channelType(channel) {
  const c = String(channel || "").toLowerCase();
  if (c === "call" || c === "phone") return "call";
  if (c === "sms" || c === "text") return "text";
  if (c === "email") return "email";
  return "interaction";
}

function prettyStage(stage) {
  return String(stage || "").replace(/_/g, " ");
}

const TERMINAL_ACTION = new Set(["done", "completed", "complete", "cancelled", "canceled"]);

export async function buildSellerTimeline(ctx, opportunityId) {
  const db = ctx.db;
  const services = ctx.services || {};
  const operator = services.operator;
  if (!db) {
    throw Object.assign(new Error("timeline_unavailable"), { code: "timeline_unavailable", status: 503 });
  }
  if (!opportunityId) {
    throw Object.assign(new Error("missing_opportunityId"), { code: "missing_opportunityId", status: 400 });
  }

  // Canonical opportunity read (works for fixtures and sqlite; 404 when unknown).
  let detail = null;
  try {
    detail = services.opportunities ? await services.opportunities.getById(opportunityId) : null;
  } catch (err) {
    if (err && (err.code === "opportunity_not_found" || err.status === 404)) {
      throw Object.assign(new Error("opportunity_not_found"), { code: "opportunity_not_found", status: 404 });
    }
    throw err;
  }
  if (!detail) {
    throw Object.assign(new Error("opportunity_not_found"), { code: "opportunity_not_found", status: 404 });
  }

  const events = [];
  const stageTimeline = Array.isArray(detail.stageTimeline) ? detail.stageTimeline : [];

  // 1. Lead created: earliest hard evidence, never invented.
  let leadAt = null;
  let leadBy = null;
  try {
    const lead = db
      .prepare("SELECT created_at, created_by FROM seller_opportunities WHERE id = ?")
      .get(opportunityId);
    if (lead && lead.created_at) {
      leadAt = lead.created_at;
      leadBy = lead.created_by;
    }
  } catch {
    /* table absent in some builds */
  }
  if (!leadAt && stageTimeline.length) {
    const first = [...stageTimeline].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))[0];
    leadAt = first.at || null;
    leadBy = first.changedBy || null;
  }
  if (leadAt) events.push(ev("lead_created", leadAt, "Lead created", leadBy));

  // 2. Stage changes — fixture trees first, then the authoritative table,
  // deduplicated on (at, stage) so nothing double-counts.
  const seenStages = new Set();
  const pushStage = (stage, at, by, priorStage = null) => {
    const key = `${at}|${stage}`;
    if (!stage || seenStages.has(key)) return;
    seenStages.add(key);
    events.push(
      ev("stage_change", at, `Moved to ${prettyStage(stage)}`, by, {
        stage: stage || null,
        priorStage: priorStage || null,
      })
    );
  };
  for (const s of stageTimeline) pushStage(s.stage, s.at, s.changedBy);
  try {
    const rows = db
      .prepare(
        "SELECT prior_stage, new_stage, changed_by, created_at FROM seller_stage_events WHERE opportunity_id = ? ORDER BY created_at ASC"
      )
      .all(opportunityId);
    for (const r of rows) pushStage(r.new_stage, r.created_at, r.changed_by, r.prior_stage);
  } catch {
    /* table absent in some builds */
  }

  if (operator) {
    // 3. Notes.
    try {
      for (const n of operator.listNotes(opportunityId) || []) {
        const body = summarize(n.body);
        events.push(ev("note", n.createdAt, body ? `Note: ${body}` : "Note added", n.createdBy));
      }
    } catch {
      /* operator surface unavailable */
    }

    // 4. Follow-ups / tasks.
    try {
      for (const a of operator.listNextActions(opportunityId) || []) {
        const done = TERMINAL_ACTION.has(String(a.status || "").toLowerCase());
        if (done && a.completedAt) {
          events.push(ev("followup_done", a.completedAt, `Completed: ${a.title || "follow-up"}`, a.createdBy));
        } else if (!done) {
          const due = a.dueDate ? ` (due ${String(a.dueDate).slice(0, 10)})` : "";
          events.push(ev("followup", a.createdAt, `Follow-up: ${a.title || "untitled"}${due}`, a.createdBy));
        }
      }
    } catch {
      /* operator surface unavailable */
    }

    // 5. Offers.
    try {
      for (const o of operator.listOffers(opportunityId) || []) {
        const latest = (o.versions || [])[0];
        const price =
          latest && Number.isFinite(Number(latest.purchasePrice))
            ? ` — $${Number(latest.purchasePrice).toLocaleString("en-US")}`
            : "";
        events.push(
          ev("offer", o.createdAt, `Offer ${prettyStage(o.status || "draft")}${price}`, o.createdBy)
        );
      }
    } catch {
      /* operator surface unavailable */
    }

    // 6. Checklist completions.
    try {
      for (const c of operator.listChecklist(opportunityId) || []) {
        if (c.checked) {
          events.push(ev("task_done", c.updatedAt, `Checklist: ${c.label || c.key} completed`, c.updatedBy));
        }
      }
    } catch {
      /* operator surface unavailable */
    }

    // 7. Calls / texts / emails.
    try {
      for (const i of operator.listInteractions(opportunityId) || []) {
        const type = channelType(i.channel);
        const dir = i.direction ? `${i.direction} ` : "";
        const detailText = summarize(i.summary || i.outcome);
        events.push(ev(type, i.occurredAt, `${dir}${type}${detailText ? ` — ${detailText}` : ""}`.trim(), i.createdBy));
      }
    } catch {
      /* operator surface unavailable */
    }

    // 8. Outreach drafts (Piper-authored drafts land here too).
    try {
      for (const c of operator.listCommunications(opportunityId) || []) {
        const ch = c.recipientChannel || c.direction || "message";
        const subj = c.subject ? `: ${summarize(c.subject, 80)}` : "";
        events.push(ev("outreach_draft", c.createdAt, `Draft ${ch} ${c.status || "prepared"}${subj}`, c.createdBy));
      }
    } catch {
      /* operator surface unavailable */
    }
  }

  // 9. Piper actions — runs explicitly tied to this opportunity, with the
  // tools each run used. Deterministic history, no model required.
  try {
    const runs = db
      .prepare(
        "SELECT id, question, state, created_at FROM piper_runs WHERE active_opportunity_id = ? ORDER BY created_at DESC LIMIT 25"
      )
      .all(opportunityId);
    const toolStmt = db.prepare("SELECT DISTINCT tool_name FROM piper_tool_calls WHERE run_id = ?");
    for (const r of runs) {
      let tools = [];
      try {
        tools = toolStmt.all(r.id).map((t) => t.tool_name).filter(Boolean);
      } catch {
        /* tool table absent */
      }
      const q = summarize(r.question, 120);
      events.push(
        ev("piper_action", r.created_at, `Piper: ${q || "(run)"}${tools.length ? ` — used ${tools.join(", ")}` : ""}`)
      );
    }
  } catch {
    /* piper tables absent in some builds */
  }

  // Newest first; undated events sink to the bottom. Cap the list.
  events.sort((a, b) => {
    if (!a.at && !b.at) return 0;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return String(b.at).localeCompare(String(a.at));
  });

  return { events: events.slice(0, MAX_EVENTS) };
}
