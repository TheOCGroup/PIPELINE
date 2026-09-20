/**
 * Piper's seller-data access layer (Phase 1 — intelligence).
 *
 * Pure, server-side read helpers over the canonical PIPELINE tables. These are
 * the functions behind Piper's seller tools; they are the ONLY path by which
 * the model reaches seller facts. The model never writes SQL and never touches
 * these tables directly.
 *
 * Grounding contract:
 *   - every field traces to a stored column; a missing fact is returned as
 *     null / found:false — never inferred;
 *   - find_seller never guesses: more than one strong match sets ambiguous.
 */

const norm = (v) => String(v || "").trim().toLowerCase();
const digits = (v) => String(v || "").replace(/\D/g, "");
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim();

/** One representative address per opportunity (earliest source = provenance). */
function addressByOpportunity(db) {
  const rows = db.prepare(`
    SELECT opportunity_id, original_address
    FROM seller_opportunity_sources
    GROUP BY opportunity_id
    HAVING MIN(conversion_timestamp)
  `).all();
  const map = new Map();
  for (const r of rows) map.set(r.opportunity_id, r.original_address || null);
  return map;
}

/**
 * Resolve sellers by name, address fragment, and/or phone.
 *
 * @returns {{candidates: Array, ambiguous: boolean}}
 *   candidate = { contactId, displayName, phone, email, matchQuality, matchOn,
 *                 opportunities: [{ opportunityId, address, stage, askingPrice }] }
 *   ambiguous = true when more than one candidate shares the top match quality.
 */
export function findSellerCandidates(db, { name = null, address = null, phone = null, limit = 10 } = {}) {
  const qName = norm(name);
  const qAddr = norm(address);
  const qPhone = digits(phone);
  if (!qName && !qAddr && !qPhone) {
    return { candidates: [], ambiguous: false, error: "no_criteria" };
  }

  const addresses = addressByOpportunity(db);
  const rows = db.prepare(`
    SELECT c.id AS contact_id, c.first_name, c.last_name, c.email, c.phone,
           p.opportunity_id, o.pipeline_stage, o.asking_price, o.opportunity_status
    FROM pipeline_contacts c
    JOIN seller_opportunity_participants p ON p.ocg_one_person_id = c.id
    JOIN seller_opportunities o ON o.id = p.opportunity_id
    WHERE p.participant_role IN ('primary_owner', 'co_owner', 'spouse', 'heir', 'decision_maker')
  `).all();

  const scored = [];
  for (const r of rows) {
    const nameOf = norm(`${r.first_name} ${r.last_name}`);
    const addr = norm(addresses.get(r.opportunity_id));
    const ph = digits(r.phone);
    let quality = null;
    const on = [];
    if (qName && nameOf === qName) { quality = "exact"; on.push("name"); }
    else if (qName && nameOf.includes(qName)) { quality = quality || "partial"; on.push("name"); }
    if (qPhone && ph && ph === qPhone) { quality = "phone"; on.push("phone"); }
    else if (qPhone && ph && (ph.endsWith(qPhone) || qPhone.endsWith(ph)) && qPhone.length >= 7) {
      if (!quality) quality = "partial";
      on.push("phone");
    }
    if (qAddr && addr && addr.includes(qAddr)) {
      // An address hit is a strong match: a property identifies its seller.
      if (!quality || quality === "partial") quality = quality === "partial" ? "partial" : "property";
      on.push("address");
    }
    if (!quality) continue;
    scored.push({ row: r, quality, on, address: addresses.get(r.opportunity_id) });
  }

  // Group by contact; one candidate per seller with all their opportunities.
  const byContact = new Map();
  const rank = { exact: 0, phone: 1, property: 2, partial: 3 };
  for (const s of scored) {
    const id = s.row.contact_id;
    if (!byContact.has(id)) {
      byContact.set(id, {
        contactId: id,
        displayName: fullName({ first_name: s.row.first_name, last_name: s.row.last_name }),
        phone: s.row.phone || null,
        email: s.row.email || null,
        matchQuality: s.quality,
        matchOn: s.on,
        opportunities: [],
      });
    }
    const cand = byContact.get(id);
    if (rank[s.quality] < rank[cand.matchQuality]) {
      cand.matchQuality = s.quality;
      cand.matchOn = s.on;
    }
    if (!cand.opportunities.some((o) => o.opportunityId === s.row.opportunity_id)) {
      cand.opportunities.push({
        opportunityId: s.row.opportunity_id,
        address: s.address,
        stage: s.row.pipeline_stage,
        askingPrice: s.row.asking_price ?? null,
      });
    }
  }

  const candidates = [...byContact.values()]
    .sort((a, b) => rank[a.matchQuality] - rank[b.matchQuality])
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 25)));

  const top = candidates[0]?.matchQuality;
  const ambiguous = !!top && candidates.filter((c) => c.matchQuality === top).length > 1;

  return { candidates, ambiguous };
}

/** Resolve the primary seller contact for an opportunity, or a contact directly. */
export function resolveSeller(db, { contactId = null, opportunityId = null } = {}) {
  let contact = null;
  if (contactId) {
    contact = db.prepare("SELECT * FROM pipeline_contacts WHERE id = ?").get(contactId);
  } else if (opportunityId) {
    contact = db.prepare(`
      SELECT c.* FROM pipeline_contacts c
      JOIN seller_opportunity_participants p ON p.ocg_one_person_id = c.id
      WHERE p.opportunity_id = ? AND p.participant_role = 'primary_owner'
      ORDER BY p.created_at ASC LIMIT 1
    `).get(opportunityId);
  }
  if (!contact) return null;
  return {
    contactId: contact.id,
    displayName: fullName(contact) || "Seller",
    firstName: contact.first_name || null,
    lastName: contact.last_name || null,
    phone: contact.phone || null,
    email: contact.email || null,
  };
}

/** Opportunities tied to a seller contact, with addresses and stages. */
export function sellerOpportunities(db, contactId) {
  const addresses = addressByOpportunity(db);
  const rows = db.prepare(`
    SELECT o.id, o.opportunity_code, o.pipeline_stage, o.opportunity_status,
           o.asking_price, o.last_contacted_at, o.next_scheduled_contact_at,
           o.created_at
    FROM seller_opportunities o
    JOIN seller_opportunity_participants p ON p.opportunity_id = o.id
    WHERE p.ocg_one_person_id = ?
    ORDER BY o.created_at DESC
  `).all(contactId);
  return rows.map((o) => ({
    opportunityId: o.id,
    code: o.opportunity_code,
    address: addresses.get(o.id) || null,
    stage: o.pipeline_stage,
    status: o.opportunity_status,
    askingPrice: o.asking_price ?? null,
    lastContactedAt: o.last_contacted_at,
    nextScheduledContactAt: o.next_scheduled_contact_at,
    createdAt: o.created_at,
  }));
}

/**
 * One unified, founder-readable chronological timeline for an opportunity's
 * seller relationship. Merges lead intake, stage changes, interactions, comms,
 * notes, offers, tasks, appointments, and Piper's own executed actions.
 * Raw audit noise is deliberately excluded.
 */
export function sellerTimeline(db, operator, opportunityId, { limit = 60 } = {}) {
  const opp = db.prepare("SELECT id, created_at FROM seller_opportunities WHERE id = ?").get(opportunityId);
  if (!opp) return { found: false };
  const addresses = addressByOpportunity(db);
  const address = addresses.get(opportunityId);
  const events = [];
  const push = (at, kind, title, detail = null) => {
    if (at) events.push({ at, kind, title, detail });
  };

  push(opp.created_at, "lead", "Lead entered PIPELINE", address ? `Property: ${address}` : null);

  for (const s of db.prepare(`
      SELECT new_stage, prior_stage, changed_by, reason, created_at
      FROM seller_stage_events WHERE opportunity_id = ? ORDER BY created_at ASC
    `).all(opportunityId)) {
    push(s.created_at, "stage_change",
      `Stage: ${s.prior_stage || "—"} → ${s.new_stage}`,
      [s.reason ? `Reason: ${s.reason}` : null, s.changed_by ? `By: ${s.changed_by}` : null].filter(Boolean).join(" · ") || null);
  }

  for (const i of db.prepare(`
      SELECT channel, direction, summary, outcome, occurred_at
      FROM seller_interactions WHERE opportunity_id = ? ORDER BY occurred_at ASC
    `).all(opportunityId)) {
    push(i.occurred_at, "interaction",
      `${i.direction === "inbound" ? "Inbound" : "Outbound"} ${i.channel}`,
      [i.summary, i.outcome ? `Outcome: ${i.outcome}` : null].filter(Boolean).join(" · ") || null);
  }

  const comms = db.prepare(`
    SELECT c.id, c.recipient_channel, c.direction, c.subject,
           substr(c.content_text, 1, 220) AS snippet, c.created_at,
           (SELECT event_type FROM seller_communication_events e
             WHERE e.communication_id = c.id ORDER BY e.occurred_at DESC LIMIT 1) AS latest_event
    FROM seller_communications c WHERE c.opportunity_id = ? ORDER BY c.created_at ASC
  `).all(opportunityId);
  for (const c of comms) {
    push(c.created_at, "communication",
      `${c.direction === "inbound" ? "Inbound" : "Outbound"} ${c.recipient_channel} — ${c.latest_event || "recorded"}`,
      [c.subject ? `Subject: ${c.subject}` : null, c.snippet].filter(Boolean).join(" · ") || null);
  }

  for (const n of db.prepare(`
      SELECT substr(body, 1, 280) AS body, created_by, created_at
      FROM operator_notes WHERE opportunity_id = ? ORDER BY created_at ASC
    `).all(opportunityId)) {
    push(n.created_at, "note", `Note by ${n.created_by || "operator"}`, n.body);
  }

  for (const offer of operator.listOffers(opportunityId)) {
    push(offer.createdAt, "offer", `Offer ${offer.id} (${offer.status})`,
      offer.versions.map((v) => `v${v.versionNumber}: ${v.purchasePrice ?? "—"} [${v.versionStatus}]`).join("; ") || null);
  }

  for (const t of db.prepare(`
      SELECT title, due_date, status, created_at FROM operator_next_actions
      WHERE opportunity_id = ? ORDER BY created_at ASC
    `).all(opportunityId)) {
    push(t.created_at, "task",
      `Task: ${t.title} [${t.status}]`,
      t.due_date ? `Due: ${t.due_date}` : null);
  }

  for (const a of db.prepare(`
      SELECT appointment_type, meeting_method, status, outcome, local_display_start, starts_at_utc
      FROM seller_appointments WHERE opportunity_id = ? ORDER BY starts_at_utc ASC
    `).all(opportunityId)) {
    push(a.starts_at_utc, "appointment",
      `Appointment: ${a.appointment_type} (${a.meeting_method}) [${a.status}]`,
      [a.local_display_start ? `When: ${a.local_display_start}` : null, a.outcome ? `Outcome: ${a.outcome}` : null].filter(Boolean).join(" · ") || null);
  }

  // Piper's own executed actions that reference this opportunity.
  const like = `%${opportunityId}%`;
  for (const tc of db.prepare(`
      SELECT tool_name, arguments_json, settled_at FROM piper_tool_calls
      WHERE status = 'executed' AND arguments_json LIKE ? ORDER BY settled_at ASC LIMIT 25
    `).all(like)) {
    push(tc.settled_at, "piper_action", `Piper: ${tc.tool_name}`, null);
  }

  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const capped = events.slice(0, Math.max(1, Math.min(Number(limit) || 60, 200)));
  return { found: true, opportunityId, address, eventCount: events.length, events: capped };
}

/** The most recent recorded contact (interaction or communication). */
export function lastContact(db, opportunityId) {
  const interaction = db.prepare(`
    SELECT channel, direction, summary, outcome, occurred_at AS at
    FROM seller_interactions WHERE opportunity_id = ? ORDER BY occurred_at DESC LIMIT 1
  `).get(opportunityId);
  const comm = db.prepare(`
    SELECT c.recipient_channel AS channel, c.direction, substr(c.content_text, 1, 220) AS summary,
           (SELECT event_type FROM seller_communication_events e
             WHERE e.communication_id = c.id ORDER BY e.occurred_at DESC LIMIT 1) AS outcome,
           c.created_at AS at
    FROM seller_communications c WHERE c.opportunity_id = ? ORDER BY c.created_at DESC LIMIT 1
  `).get(opportunityId);
  const best = [interaction, comm].filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (!best) return { found: false };
  return {
    found: true,
    at: best.at,
    channel: best.channel,
    direction: best.direction,
    summary: best.summary || null,
    outcome: best.outcome || null,
  };
}

/**
 * Open / due / overdue next actions, optionally scoped to an opportunity.
 * "due" = open and due today or earlier (needs attention now, includes
 * overdue); "overdue" = open and due before today.
 */
export function tasksDue(db, operator, { opportunityId = null, filter = "open", limit = 25 } = {}) {
  const f = ["open", "due", "overdue", "all"].includes(filter) ? filter : "open";
  const today = new Date().toISOString().slice(0, 10);
  const addresses = addressByOpportunity(db);
  let tasks = operator.listNextActions(opportunityId);
  if (f !== "all") tasks = tasks.filter((t) => t.status === "open");
  if (f === "overdue") tasks = tasks.filter((t) => t.dueDate && t.dueDate < today);
  if (f === "due") tasks = tasks.filter((t) => t.dueDate && t.dueDate <= today);
  tasks = tasks.slice(0, Math.max(1, Math.min(Number(limit) || 25, 100)));
  return {
    filter: f,
    count: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      opportunityId: t.opportunityId,
      address: addresses.get(t.opportunityId) || null,
      title: t.title,
      dueDate: t.dueDate,
      overdue: !!t.dueDate && t.dueDate < today,
      status: t.status,
      createdBy: t.createdBy,
    })),
  };
}

/**
 * Descriptive pipeline search: street fragment, seller name fragment, price
 * band, stage. One row per opportunity; every row names why it matched.
 */
export function searchPipeline(db, { street = null, name = null, askingPrice = null, minPrice = null, maxPrice = null, stage = null, limit = 10 } = {}) {
  const qStreet = norm(street);
  const qName = norm(name);
  if (!qStreet && !qName && askingPrice == null && minPrice == null && maxPrice == null && !stage) {
    return { results: [], error: "no_criteria" };
  }
  const addresses = addressByOpportunity(db);
  const sellers = new Map();
  for (const r of db.prepare(`
      SELECT p.opportunity_id, c.first_name, c.last_name
      FROM seller_opportunity_participants p
      JOIN pipeline_contacts c ON c.id = p.ocg_one_person_id
      WHERE p.participant_role = 'primary_owner'
    `).all()) {
    if (!sellers.has(r.opportunity_id)) sellers.set(r.opportunity_id, fullName(r));
  }

  let rows = db.prepare(`
    SELECT id, pipeline_stage, asking_price, opportunity_status, created_at
    FROM seller_opportunities
  `).all();

  if (stage) rows = rows.filter((o) => o.pipeline_stage === stage);
  if (askingPrice != null && Number.isFinite(Number(askingPrice))) {
    const target = Number(askingPrice);
    rows = rows.filter((o) => o.asking_price != null && Math.abs(o.asking_price - target) <= target * 0.2);
  }
  if (minPrice != null) rows = rows.filter((o) => o.asking_price != null && o.asking_price >= Number(minPrice));
  if (maxPrice != null) rows = rows.filter((o) => o.asking_price != null && o.asking_price <= Number(maxPrice));

  const results = [];
  for (const o of rows) {
    const addr = norm(addresses.get(o.id));
    const seller = norm(sellers.get(o.id));
    const reasons = [];
    if (qStreet && addr.includes(qStreet)) reasons.push(`address matches "${street}"`);
    if (qName && seller.includes(qName)) reasons.push(`seller matches "${name}"`);
    if (askingPrice != null && o.asking_price != null) reasons.push(`asking price ${o.asking_price} near ${askingPrice}`);
    if ((minPrice != null || maxPrice != null) && o.asking_price != null) reasons.push(`asking price ${o.asking_price} in range`);
    if (qStreet && !addr.includes(qStreet)) continue;
    if (qName && !seller.includes(qName)) continue;
    results.push({
      opportunityId: o.id,
      address: addresses.get(o.id) || null,
      seller: sellers.get(o.id) || "Seller",
      stage: o.pipeline_stage,
      askingPrice: o.asking_price ?? null,
      matchReasons: reasons,
    });
  }
  return { results: results.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50))) };
}

/**
 * Build a call plan for a seller. Resolves the contact and assembles context —
 * it NEVER initiates a call. Dialing is Phase 3 (execute_call, not built).
 */
export function prepareCallPlan(db, operator, { contactId = null, opportunityId = null } = {}) {
  const seller = resolveSeller(db, { contactId, opportunityId });
  if (!seller) return { ok: false, error: "seller_not_found" };
  if (!seller.phone) {
    return { ok: false, error: "no_phone_on_record", detail: `No phone number is recorded for ${seller.displayName}.` };
  }
  const opps = sellerOpportunities(db, seller.contactId);
  const focus = opportunityId
    ? opps.find((o) => o.opportunityId === opportunityId) || null
    : opps[0] || null;
  const lc = focus ? lastContact(db, focus.opportunityId) : { found: false };
  const openTasks = focus
    ? db.prepare("SELECT COUNT(*) AS n FROM operator_next_actions WHERE opportunity_id = ? AND status = 'open'").get(focus.opportunityId).n
    : 0;
  return {
    ok: true,
    dials: false,
    note: "This is a call plan only. Piper does not dial in Phase 1.",
    contact: { contactId: seller.contactId, name: seller.displayName, phone: seller.phone, email: seller.email },
    opportunity: focus ? {
      opportunityId: focus.opportunityId,
      address: focus.address,
      stage: focus.stage,
      askingPrice: focus.askingPrice,
    } : null,
    lastContact: lc.found ? { at: lc.at, channel: lc.channel, direction: lc.direction, summary: lc.summary } : null,
    openTaskCount: openTasks,
  };
}
