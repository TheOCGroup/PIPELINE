// OCG OS Issue #8 — seller-to-deal journey certification battery.
// Boots the REAL server (child process) from THIS tree (remediation/work-journey2)
// against a disposable database only. No production access. All data is
// SYNTHETIC and labeled synthetic. Implements the SCOPE-AUDIT §A.12 battery
// J1–J8 plus the remediation J9 legs (durable briefs, call-prep REST,
// persisted recommendations, follow-up history, QUINCEY F6):
//   J1 intake -> seller brief        J5 recommended action
//   J2 call preparation              J6 restart persistence
//   J3 call outcome + follow-up      J7 abuse / tenant legs
//   J4 underwriting + committee     J8 buyer criteria -> discovery -> ranking
//   J9 durable journey artifacts (migration 036) + F6
// Execution order: J1 J2 J3 J4 J5 J8 J7 J9 J6 (J6 last: it re-reads
// everything after a restart; J8 before J7 so the foreign-tenant seed
// cannot pollute the ranking legs; J9 after J7 because its ghost legs use
// the foreign seed, and it performs its own restart for the artifact
// byte-identity legs).
//
// Surface honesty: legs with an operator REST surface run over real HTTP.
// Since the remediation build, the per-seller brief and call preparation
// DO have operator REST surfaces (migration 036 + JourneyService), so J9
// exercises them over HTTP and asserts the REST call preparation is
// identical to the Piper tool result. J1/J2 retain their original
// tool-surface legs as regression coverage of the tool dispatch itself.
// Nothing is faked: where a leg is verified by mapping, the check name
// says so.
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = HERE;
const RESULTS = join(HERE, "journey-battery-results.md");
const OP_SECRET = process.env.JB_OP_SECRET || "jb-operator-secret-0123456789abcdef0123456789";
const SES_SECRET = process.env.JB_SES_SECRET || "jb-session-secret-0123456789abcdef0123456789";
const INTAKE_SECRET = process.env.JB_INTAKE_SECRET || "jb-intake-secret-0123456789abcdef01234567";

const sections = [];
let current = null;
function beginSection(id, title) {
  current = { id, title, checks: [] };
  sections.push(current);
  console.log(`\n=== ${id}: ${title} ===`);
}
function check(name, ok, detail = "") {
  current.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
function flushSection() {
  const s = current;
  const pass = s.checks.filter(c => c.ok).length;
  let md = `\n## ${s.id} — ${s.title}\n\n**${pass}/${s.checks.length} assertions passed.**\n\n`;
  for (const c of s.checks) md += `- ${c.ok ? "PASS" : "**FAIL**"} — ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`;
  appendFileSync(RESULTS, md);
}

function envFor(port, dbPath) {
  return {
    ...process.env,
    PIPELINE_ENV: "production",
    PIPELINE_READ_ONLY: "false",
    PIPELINE_HOST: "127.0.0.1",
    PIPELINE_PORT: String(port),
    PIPELINE_DB_PATH: dbPath,
    PIPELINE_OPERATOR_SECRET: OP_SECRET,
    PIPELINE_SESSION_SECRET: SES_SECRET,
    PIPELINE_TENANT_ID: "ocg-one",
    PIPELINE_ENABLE_PIPER_INTAKE: "true",
    PIPELINE_PIPER_INTAKE_SECRET: INTAKE_SECRET,
    PIPELINE_PIPER_PROVIDER: "none"
  };
}

async function boot(port, dbPath) {
  const child = spawn("node", ["server.js"], { cwd: REPO, env: envFor(port, dbPath), stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) return { child, base, log: () => log };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy on ${port}: ${log}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(r => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise(r => setTimeout(r, 10000))]);
}

async function call(base, method, path, { token, intake, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (intake) headers.Authorization = `Bearer ${intake}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json, text };
}

function dbRO(dbPath) { return new DatabaseSync(dbPath, { readOnly: true }); }
const stripVolatile = (v) => JSON.parse(JSON.stringify(v ?? null, (k, val) =>
  (k === "correlationId" || k === "meta" || k === "requestId") ? undefined : val));

// ------------------------------------------------------------------ state
const PORT = 18951;
let server = null;
let dbPath = null;
let sellerOppId = null;
let candIds = {};
let criteriaId = null;
let preRestart = null;

const SELLER = {
  address: "1200 Journey Test Ln, Wichita, KS 67202",
  apn: "JRN-0001",
  askingPrice: 150000,
  sourceRecordId: "journey-seller-1",
  sellerName: "Journey Seller (synthetic fixture)",
  phone: "316-555-0142",
  email: "journey-seller@synthetic.invalid"
};

const CANDIDATES = [
  { key: "alpha", address: "1201 Candidate Alpha St, Wichita, KS 67203", apn: "JRN-C1", askingPrice: 100000, sourceRecordId: "journey-cand-alpha",
    underwriting: { analysisStatus: "completed", arv: 210000, rehab: 40000, mao: 160000, confidence: 0.85, limitations: "[]" } },
  { key: "beta", address: "1202 Candidate Beta St, Wichita, KS 67204", apn: "JRN-C2", askingPrice: 130000, sourceRecordId: "journey-cand-beta",
    underwriting: { analysisStatus: "completed", arv: 190000, rehab: 30000, mao: 150000, confidence: 0.9, limitations: "[]" } },
  { key: "gamma", address: "1203 Candidate Gamma St, Tulsa, OK 74101", apn: "JRN-C3", askingPrice: 90000, sourceRecordId: "journey-cand-gamma",
    underwriting: { analysisStatus: "completed", arv: 400000, rehab: 50000, mao: 300000, confidence: 0.9, limitations: "[]" } },
  { key: "delta", address: "1204 Candidate Delta St, Wichita, KS 67205", apn: "JRN-C4", askingPrice: 110000, sourceRecordId: "journey-cand-delta",
    underwriting: { analysisStatus: "insufficient_evidence", arv: null, rehab: null, mao: null, confidence: null, limitations: "[\"no verified comps — synthetic battery fixture\"]" } },
];

// Tool-level harness for the Piper-only legs (J1 summary, J2 call prep):
// the real executeTool dispatch against the server's own disposable DB.
async function toolLegs() {
  const { openPipelineDatabase } = await import(join(REPO, "src/database/openDatabase.js"));
  const { SqliteOperatorRepository } = await import(join(REPO, "src/repositories/sqlite/sqliteOperatorRepository.js"));
  const { executeTool } = await import(join(REPO, "src/services/piper/toolRegistry.js"));
  const db = openPipelineDatabase(dbPath);
  const operator = new SqliteOperatorRepository(db, { tenantId: "ocg-one" });
  return { db, run: (name, args) => executeTool({ name, args, snapshot: null, operator, actor: "journey-battery" }) };
}

// ------------------------------------------------------------------ J1
async function j1() {
  beginSection("J1", "Seller intake -> seller brief");
  const base = server.base;

  const first = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: SELLER });
  sellerOppId = first.json?.opportunityId;
  check("J1.1 flat HUNTER intake creates the seller opportunity (201)", first.status === 201 && !!sellerOppId, `status=${first.status} body=${first.text.slice(0, 200)}`);

  const dup = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: SELLER });
  check("J1.2 identical replay reconciles as duplicate (200, same opportunity)",
    dup.status === 200 && dup.json?.duplicate === true && dup.json?.opportunityId === sellerOppId,
    `status=${dup.status} duplicate=${dup.json?.duplicate}`);

  const detail = await call(base, "GET", `/api/v1/opportunities/${sellerOppId}`, { token: OP_SECRET });
  const d = detail.json?.data || {};
  check("J1.3 detail carries the recorded address, source record id, and APN provenance",
    detail.status === 200 && d.property?.address === SELLER.address.toLowerCase() &&
    d.property?.externalPropertyId === SELLER.sourceRecordId && d.provenance?.metadata?.apn === SELLER.apn,
    `status=${detail.status} address=${d.property?.address} extId=${d.property?.externalPropertyId} apn=${d.provenance?.metadata?.apn}`);
  const dbAsk = (() => { const db = dbRO(dbPath); const r = db.prepare("SELECT asking_price FROM seller_opportunities WHERE id = ?").get(sellerOppId); db.close(); return r?.asking_price; })();
  check("J1.3b asking price is recorded on the opportunity row (the detail read model itself does not surface asking; the seller summary in J1.5 does)",
    dbAsk === SELLER.askingPrice, `asking_price=${dbAsk}`);
  check("J1.4 detail fabricates no underwriting before any snapshot exists",
    !JSON.stringify(d.underwriting || {}).match(/"(arv|mao|rehab)":\s*\d/),
    `underwriting=${JSON.stringify(d.underwriting || null).slice(0, 160)}`);

  const tools = await toolLegs();
  const summary = await tools.run("get_seller_summary", { opportunityId: sellerOppId });
  const sData = summary.data || {};
  const summaryText = JSON.stringify(sData);
  check("J1.5 [tool surface] get_seller_summary resolves the recorded seller and their opportunity",
    summary.ok === true && sData.seller?.displayName === SELLER.sellerName &&
    (sData.opportunities || []).some(o => o.opportunityId === sellerOppId && o.askingPrice === SELLER.askingPrice),
    `ok=${summary.ok} seller=${sData.seller?.displayName} opps=${JSON.stringify(sData.opportunities || []).slice(0, 200)}`);
  check("J1.6 [tool surface] seller summary contains only recorded facts (no ARV/MAO figure appears)",
    !summaryText.match(/"(arv|mao)":\s*\d/) && summaryText.includes("150000"),
    `excerpt=${summaryText.slice(0, 240)}`);
  tools.db.close();

  const ask = await call(base, "POST", "/api/v1/piper/ask", { token: OP_SECRET, body: { question: "Tell me everything about this property", activeOpportunityId: sellerOppId } });
  check("J1.7 deterministic Piper detail answer responds from real state over HTTP",
    ask.status === 200 && ask.json?.data?.deterministic === true && String(ask.json?.data?.answer || "").toLowerCase().includes("journey test ln"),
    `status=${ask.status} deterministic=${ask.json?.data?.deterministic} answer=${String(ask.json?.data?.answer || "").slice(0, 200)}`);
  flushSection();
}

// ------------------------------------------------------------------ J2
async function j2() {
  beginSection("J2", "Call preparation (Piper tool surface — the operator REST surface added by the remediation build is certified in J9)");
  const before = (() => { const db = dbRO(dbPath); const n = {
    interactions: db.prepare("SELECT COUNT(*) c FROM seller_interactions").get().c,
    audit: db.prepare("SELECT COUNT(*) c FROM operational_audit_events").get().c,
  }; db.close(); return n; })();

  const tools = await toolLegs();
  const plan = await tools.run("prepare_call", { opportunityId: sellerOppId });
  const p = plan.data || {};
  check("J2.1 prepare_call returns a plan for the recorded seller (ok, never dials)",
    plan.ok === true && p.dials === false, `ok=${plan.ok} dials=${p.dials} error=${plan.error || ""}`);
  check("J2.2 plan carries the recorded phone and opportunity context",
    p.contact?.phone === SELLER.phone && p.opportunity?.opportunityId === sellerOppId && p.opportunity?.askingPrice === SELLER.askingPrice,
    `phone=${p.contact?.phone} opp=${p.opportunity?.opportunityId} asking=${p.opportunity?.askingPrice}`);
  check("J2.3 plan states last contact honestly: none recorded yet (null, not invented)",
    p.lastContact === null, `lastContact=${JSON.stringify(p.lastContact)}`);
  check("J2.4 plan reports the open-task count from stored state",
    typeof p.openTaskCount === "number", `openTaskCount=${p.openTaskCount}`);
  tools.db.close();

  const after = (() => { const db = dbRO(dbPath); const n = {
    interactions: db.prepare("SELECT COUNT(*) c FROM seller_interactions").get().c,
    audit: db.prepare("SELECT COUNT(*) c FROM operational_audit_events").get().c,
  }; db.close(); return n; })();
  check("J2.5 preparation is read-only: no interaction row and no audit write resulted",
    after.interactions === before.interactions && after.audit === before.audit,
    `interactions ${before.interactions}->${after.interactions}, audit ${before.audit}->${after.audit}`);
  flushSection();
}

// ------------------------------------------------------------------ J3
async function j3() {
  beginSection("J3", "Call outcome + follow-up capture");
  const base = server.base;

  const interaction = await call(base, "POST", "/api/v1/operator/interactions", { token: OP_SECRET, body: {
    opportunityId: sellerOppId, channel: "phone", direction: "outbound",
    outcome: "spoke_with_seller", summary: "SYNTHETIC journey battery call outcome — no real seller contact."
  }});
  check("J3.1 call outcome recorded via operator interactions (201)",
    interaction.status === 201 && !!interaction.json?.data?.interaction?.id,
    `status=${interaction.status} body=${interaction.text.slice(0, 200)}`);

  const na = await call(base, "POST", "/api/v1/operator/next-actions", { token: OP_SECRET, body: {
    opportunityId: sellerOppId, title: "SYNTHETIC follow-up: send document checklist (battery fixture)"
  }});
  const naId = na.json?.data?.nextAction?.id;
  check("J3.2 follow-up next-action created (201)", na.status === 201 && !!naId, `status=${na.status}`);

  const interactions = await call(base, "GET", `/api/v1/operator/interactions?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  check("J3.3 interaction reads back with its recorded outcome",
    interactions.status === 200 && (interactions.json?.data?.interactions || []).some(i => i.outcome === "spoke_with_seller"),
    `status=${interactions.status} count=${(interactions.json?.data?.interactions || []).length}`);

  const done = await call(base, "POST", `/api/v1/operator/next-actions/${naId}`, { token: OP_SECRET, body: { status: "done" } });
  check("J3.4 follow-up can be completed and the completion persists",
    done.status === 200 && done.json?.data?.nextAction?.status === "done",
    `status=${done.status} naStatus=${done.json?.data?.nextAction?.status}`);

  const actions = await call(base, "GET", `/api/v1/operator/next-actions?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  check("J3.5 completed follow-up reads back as done",
    (actions.json?.data?.nextActions || []).some(a => a.id === naId && a.status === "done"),
    `actions=${JSON.stringify(actions.json?.data?.nextActions || []).slice(0, 200)}`);
  flushSection();
}

// ------------------------------------------------------------------ J4
async function j4() {
  beginSection("J4", "VICTOR underwriting -> committee review (null-honest)");
  const base = server.base;

  await call(base, "POST", `/api/v1/opportunities/${sellerOppId}/stage`, { token: OP_SECRET, body: { stage: "needs_review", reason: "journey battery: intake accepted for review" } });
  await call(base, "POST", `/api/v1/opportunities/${sellerOppId}/stage`, { token: OP_SECRET, body: { stage: "property_review", reason: "journey battery: property context reviewed" } });

  const pkg = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: {
    property: { id: SELLER.sourceRecordId, address: SELLER.address, apn: SELLER.apn, askingPrice: SELLER.askingPrice },
    underwriting: { analysisStatus: "insufficient_evidence", arv: null, rehab: null, mao: null, confidence: null,
      limitations: "[\"no verified comps — synthetic battery fixture\"]" },
    marketEvidence: { comps: [] },
    timestamp: new Date().toISOString()
  }});
  check("J4.1 VICTOR package accepted against the existing opportunity (no second record minted)",
    pkg.status === 200 && pkg.json?.opportunityId === sellerOppId,
    `status=${pkg.status} opportunityId=${pkg.json?.opportunityId}`);

  const db = dbRO(dbPath);
  const ref = db.prepare(`SELECT * FROM opportunity_underwriting_refs WHERE opportunity_id = ?
    ORDER BY analyzed_at DESC, created_at DESC, rowid DESC LIMIT 1`).get(sellerOppId);
  check("J4.2 snapshot persists insufficient_evidence with ARV/rehab/MAO/confidence NULL",
    !!ref && ref.analysis_status === "insufficient_evidence" && ref.arv === null && ref.rehab === null && ref.mao === null && ref.confidence === null,
    `ref=${ref ? JSON.stringify({ status: ref.analysis_status, arv: ref.arv, rehab: ref.rehab, mao: ref.mao, conf: ref.confidence }) : "none"}`);
  db.close();

  const offerRes = await call(base, "POST", "/api/v1/operator/offers", { token: OP_SECRET, body: {
    opportunityId: sellerOppId, proposedPrice: 140000, strategyType: "cash_purchase",
    earnestMoney: 1000, inspectionDays: 10, closingDays: 30
  }});
  const offer = offerRes.json?.data?.offer;
  const version = (offer?.versions || [])[0];
  check("J4.3 internal draft offer created, citing the newest underwriting reference explicitly",
    offerRes.status === 201 && !!offer && version?.underwritingRefId === ref.id,
    `status=${offerRes.status} offer=${offer?.id} versionRef=${version?.underwritingRefId} expectedRef=${ref.id}`);

  const earlyApprove = await call(base, "POST", `/api/v1/operator/offers/${offer.id}`, { token: OP_SECRET, body: { action: "approve" } });
  check("J4.4 approval before any committee review is REFUSED (409 committee_approval_required)",
    earlyApprove.status === 409 && earlyApprove.json?.error === "committee_approval_required",
    `status=${earlyApprove.status} error=${earlyApprove.json?.error}`);

  const review = await call(base, "POST", "/api/v1/investment-committee/review", { token: OP_SECRET, body: { opportunityId: sellerOppId } });
  const rec = review.json?.review;
  check("J4.5 committee reviews and HOLDS on missing evidence",
    review.status === 200 && rec?.decision === "hold", `status=${review.status} decision=${rec?.decision}`);
  check("J4.6 committee metrics stay NULL (no fabricated MAO/DSCR) and the rationale names missing underwriting",
    rec?.metrics?.mao === null && rec?.metrics?.dscr === null &&
    !/DSCR|0\.00/.test(rec?.rationale || "") && /underwriting/i.test(rec?.rationale || ""),
    `metrics=${JSON.stringify(rec?.metrics)} rationale=${String(rec?.rationale || "").slice(0, 200)}`);

  const lateApprove = await call(base, "POST", `/api/v1/operator/offers/${offer.id}`, { token: OP_SECRET, body: { action: "approve" } });
  check("J4.7 approval after the HOLD is still REFUSED (409) — the gate fails closed",
    lateApprove.status === 409 && lateApprove.json?.error === "committee_approval_required",
    `status=${lateApprove.status} error=${lateApprove.json?.error}`);

  const offersList = await call(base, "GET", `/api/v1/operator/offers?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const mine = (offersList.json?.data?.offers || []).find(o => o.id === offer.id);
  check("J4.8 the offer remains an unsent internal draft",
    !!mine && mine.status === "draft", `status=${mine?.status}`);
  flushSection();
}

// ------------------------------------------------------------------ J5
async function j5() {
  beginSection("J5", "Recommended action (brief NEXT section + committee recommendation of record)");
  const base = server.base;

  const ask = await call(base, "POST", "/api/v1/piper/ask", { token: OP_SECRET, body: { question: "What should I do next?" } });
  check("J5.1 deterministic 'next' answer responds from real state",
    ask.status === 200 && ask.json?.data?.deterministic === true && typeof ask.json?.data?.answer === "string" && ask.json.data.answer.length > 0,
    `status=${ask.status} deterministic=${ask.json?.data?.deterministic}`);

  // The brief's NEXT section is produced by recommendActions over real
  // triggers (disposition work, stalled records, operator-decision flags).
  // Its decision-flag trigger fires when the recorded authorized ceiling
  // (newest ref MAO) sits below the recorded asking price — so this leg
  // uses a fixture built on exactly that recorded state. (For the journey
  // seller itself, J5.5 below certifies the audit's stated alternative:
  // the persisted committee review as the recommendation of record.)
  const ceilFlat = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: {
    address: "1300 Ceiling Test Ave, Wichita, KS 67211", apn: "JRN-CEIL", askingPrice: 250000,
    sourceRecordId: "journey-ceiling-1", sellerName: "Ceiling Seller (synthetic fixture)", phone: "316-555-0177", email: "ceiling@synthetic.invalid"
  }});
  const ceilId = ceilFlat.json?.opportunityId;
  const ceilVictor = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: {
    property: { id: "journey-ceiling-1", address: "1300 Ceiling Test Ave, Wichita, KS 67211", apn: "JRN-CEIL", askingPrice: 250000 },
    underwriting: { analysisStatus: "completed", arv: 300000, rehab: 60000, mao: 200000, confidence: 0.9, limitations: "[]" },
    marketEvidence: { comps: [] }, timestamp: new Date().toISOString()
  }});
  check("J5.2 ceiling fixture recorded through the intake contract (asking 250000, recorded MAO 200000)",
    ceilFlat.status === 201 && ceilVictor.status === 200 && ceilVictor.json?.opportunityId === ceilId,
    `flat=${ceilFlat.status} victor=${ceilVictor.status}`);

  const brief = await call(base, "GET", "/api/v1/piper/brief", { token: OP_SECRET });
  const sections = brief.json?.data?.sections || [];
  const next = sections.find(s => s.title === "NEXT");
  check("J5.3 operating brief carries a NEXT recommendations section",
    brief.status === 200 && !!next && Array.isArray(next.items), `sections=${sections.map(s => s.title).join(",")}`);
  const ceilItems = (next?.items || []).filter(i => i.opportunityId === ceilId);
  check("J5.4 NEXT recommends 'Review and decide' for the ceiling opportunity, its reason tracing to the recorded ceiling-vs-ask figures",
    ceilItems.length >= 1 && ceilItems[0].action?.kind === "open_opportunity" && /below/i.test((ceilItems[0].reasons || []).join(" ")),
    `items=${JSON.stringify(ceilItems).slice(0, 300)}`);

  const timeline = await call(base, "GET", `/api/v1/operator/timeline?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const events = timeline.json?.data?.timeline?.events || [];
  check("J5.5 for the journey seller, the recommendation of record is the persisted committee HOLD from J4 (audit §A.12 alternative leg)",
    events.some(e => e.type === "committee_review" && /hold/i.test(e.summary || "")),
    `eventTypes=${[...new Set(events.map(e => e.type))].join(",")}`);
  flushSection();
}

// ------------------------------------------------------------------ J8
async function j8() {
  beginSection("J8", "Buyer criteria -> external discovery (intake) -> candidate ranking [NEW BUILD]");
  const base = server.base;

  // Discovery stays external: candidates arrive through the HUNTER intake
  // contract exactly as production discovery would deliver them.
  for (const c of CANDIDATES) {
    const flat = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: {
      address: c.address, apn: c.apn, askingPrice: c.askingPrice, sourceRecordId: c.sourceRecordId,
      sellerName: `Candidate Seller ${c.key} (synthetic fixture)`, phone: "316-555-0199", email: `${c.key}@synthetic.invalid`
    }});
    candIds[c.key] = flat.json?.opportunityId;
    const victor = await call(base, "POST", "/api/integrations/deal-findr/intake", { intake: INTAKE_SECRET, body: {
      property: { id: c.sourceRecordId, address: c.address, apn: c.apn, askingPrice: c.askingPrice },
      underwriting: c.underwriting, marketEvidence: { comps: [] }, timestamp: new Date().toISOString()
    }});
    check(`J8.disc ${c.key}: discovery push + VICTOR snapshot accepted through the intake contract`,
      flat.status === 201 && victor.status === 200 && victor.json?.opportunityId === candIds[c.key],
      `flat=${flat.status} victor=${victor.status}`);
  }

  const created = await call(base, "POST", "/api/v1/operator/buyer-criteria", { token: OP_SECRET, body: {
    label: "Journey buyer (synthetic)", markets: ["Wichita"], maxPrice: 200000, criteria: { minConfidence: 0.5 }
  }});
  criteriaId = created.json?.data?.criteria?.id;
  check("J8.1 buyer criteria created under operator auth, tenant-stamped (201)",
    created.status === 201 && !!criteriaId, `status=${created.status} id=${criteriaId}`);

  const res = await call(base, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`, { token: OP_SECRET });
  const ranking = res.json?.data?.ranking || {};
  check("J8.2 ranking returns ranked/excluded/unrankable with a recorded-data basis statement",
    res.status === 200 && Array.isArray(ranking.ranked) && Array.isArray(ranking.excluded) && Array.isArray(ranking.unrankable) &&
    /recorded figures only/i.test(ranking.basis || ""),
    `status=${res.status} basis=${String(ranking.basis || "").slice(0, 120)}`);
  check("J8.3 ranked order follows the criteria + recorded economics (alpha headroom 60000 before beta 20000)",
    JSON.stringify((ranking.ranked || []).map(r => r.opportunityId)) === JSON.stringify([candIds.alpha, candIds.beta]),
    `ranked=${JSON.stringify((ranking.ranked || []).map(r => [r.opportunityId, r.headroom]))}`);
  const gamma = (ranking.excluded || []).find(r => r.opportunityId === candIds.gamma);
  check("J8.4 out-of-market candidate is EXCLUDED with the market bound named (its big MAO cannot leak in)",
    !!gamma && gamma.reasons.some(x => /market/.test(x)), `gamma=${JSON.stringify(gamma || null).slice(0, 200)}`);
  const delta = (ranking.unrankable || []).find(r => r.opportunityId === candIds.delta);
  check("J8.5 insufficient-evidence candidate is UNRANKABLE with the missing figure named — never scored",
    !!delta && delta.headroom === null && delta.reasons.some(x => /MAO not recorded/.test(x)),
    `delta=${JSON.stringify(delta || null).slice(0, 240)}`);
  const sellerEntry = [...(ranking.ranked || []), ...(ranking.excluded || []), ...(ranking.unrankable || [])].find(r => r.opportunityId === sellerOppId);
  check("J8.6 the journey seller (no recorded MAO) is likewise unrankable, not scored",
    !!sellerEntry && [...(ranking.unrankable || [])].some(r => r.opportunityId === sellerOppId),
    `sellerEntry=${JSON.stringify(sellerEntry || null).slice(0, 200)}`);

  const strongest = await call(base, "POST", "/api/v1/piper/ask", { token: OP_SECRET, body: { question: "Which opportunity looks strongest?" } });
  check("J8.7 conversational portfolio ranking (pre-existing) still answers and names the widest recorded spread",
    strongest.status === 200 && (strongest.json?.data?.items || [])[0]?.opportunityId === candIds.gamma,
    `items=${JSON.stringify((strongest.json?.data?.items || []).slice(0, 2)).slice(0, 240)}`);
  flushSection();
}

// ------------------------------------------------------------------ J7
async function j7() {
  beginSection("J7", "Abuse / tenant legs (byte-identical 401s; foreign tenant is a ghost)");
  const base = server.base;

  const noAuth = await call(base, "GET", `/api/v1/opportunities/${sellerOppId}`);
  const wrongAuth = await call(base, "GET", `/api/v1/opportunities/${sellerOppId}`, { token: "wrong-credential-value-0123456789abcdef" });
  check("J7.1 unauthenticated and wrong-credential requests get the same generic 401 (no oracle)",
    noAuth.status === 401 && wrongAuth.status === 401 && noAuth.text === wrongAuth.text,
    `noAuth=${noAuth.status} wrongAuth=${wrongAuth.status} bodiesIdentical=${noAuth.text === wrongAuth.text}`);

  // Seed a foreign-tenant opportunity + criteria directly (the intake stamps
  // the configured tenant, so a foreign record can only exist from another
  // deployment writer — exactly the isolation boundary under test).
  const { openPipelineDatabase } = await import(join(REPO, "src/database/openDatabase.js"));
  const db = openPipelineDatabase(dbPath);
  db.prepare(`INSERT INTO seller_opportunities (id, tenant_id, opportunity_code, ocg_one_property_id,
    pipeline_stage, asking_price, created_by, created_at, updated_at)
    VALUES ('opp_journey_foreign', 'tenant-b', 'OPP-JB-FOREIGN', 'prop-jb-foreign', 'new_lead', 50000, 'journey-battery', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')`).run();
  db.prepare(`INSERT INTO seller_opportunity_sources (id, opportunity_id, source_type, source_record_id,
    original_address, source_timestamp, conversion_actor, conversion_timestamp, provenance_metadata_json)
    VALUES ('src-jb-foreign', 'opp_journey_foreign', 'deal_finder_intake', 'jb-foreign-1',
    '999 Foreign Tenant Way, Wichita, KS 67209', '2026-10-31T00:00:00Z', 'deal-findr', '2026-10-31T00:00:00Z', '{}')`).run();
  db.prepare(`INSERT INTO buyer_criteria (id, tenant_id, label, markets_json, property_types_json, criteria_json, status, created_by, created_at, updated_at)
    VALUES ('crit-jb-foreign', 'tenant-b', 'Foreign buyer', '[]', '[]', '{}', 'active', 'journey-battery', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')`).run();
  db.close();

  const ghosts = [
    ["detail", await call(base, "GET", "/api/v1/opportunities/opp_journey_foreign", { token: OP_SECRET })],
    ["timeline", await call(base, "GET", "/api/v1/operator/timeline?opportunityId=opp_journey_foreign", { token: OP_SECRET })],
  ];
  for (const [name, res] of ghosts) {
    check(`J7.2 foreign opportunity ${name} is indistinguishable from nonexistent (404)`,
      res.status === 404, `status=${res.status}`);
  }
  const fOffers = await call(base, "GET", "/api/v1/operator/offers?opportunityId=opp_journey_foreign", { token: OP_SECRET });
  const fInteractions = await call(base, "GET", "/api/v1/operator/interactions?opportunityId=opp_journey_foreign", { token: OP_SECRET });
  check("J7.3 foreign offers/interactions leak nothing",
    !fOffers.text.includes("999 Foreign") && !fInteractions.text.includes("999 Foreign") &&
    (fOffers.json?.data?.offers || []).length === 0 && (fInteractions.json?.data?.interactions || []).length === 0,
    `offersStatus=${fOffers.status} interactionsStatus=${fInteractions.status}`);
  const fCrit = await call(base, "GET", "/api/v1/operator/buyer-criteria/crit-jb-foreign", { token: OP_SECRET });
  const fRank = await call(base, "GET", "/api/v1/operator/candidate-ranking?criteriaId=crit-jb-foreign", { token: OP_SECRET });
  check("J7.4 foreign buyer criteria and its ranking are ghosts (404)",
    fCrit.status === 404 && fRank.status === 404, `criteria=${fCrit.status} ranking=${fRank.status}`);
  const rankNow = await call(base, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`, { token: OP_SECRET });
  const allIds = JSON.stringify(rankNow.json?.data?.ranking || {});
  check("J7.5 the foreign candidate never enters this tenant's ranking",
    !allIds.includes("opp_journey_foreign"), `rankingMentionsForeign=${allIds.includes("opp_journey_foreign")}`);
  flushSection();
}

// ------------------------------------------------------------------ J9
// Durable journey artifacts (remediation build, migration 036): the legs
// J1/J2/J5 previously had to verify at the tool level or by mapping now
// have real persisted REST surfaces, and QUINCEY F6 is closed.
let briefId = null;
let recId = null;

async function j9() {
  beginSection("J9", "Durable journey artifacts: seller briefs, call-prep REST, recommendations, follow-up history, F6");
  const base = server.base;

  const gen = await call(base, "POST", "/api/v1/operator/seller-briefs", { token: OP_SECRET, body: { opportunityId: sellerOppId } });
  const brief = gen.json?.data?.brief || {};
  briefId = brief.id;
  check("J9.1 per-seller brief artifact is generated and PERSISTED via operator REST (201)",
    gen.status === 201 && !!briefId, `status=${gen.status} briefId=${briefId}`);
  check("J9.2 brief is grounded in the journey record: recorded seller, asking price basis 'recorded', VICTOR snapshot insufficient_evidence with MAO null + basis 'unknown' (never invented)",
    brief.seller?.displayName === SELLER.sellerName &&
    brief.opportunity?.askingPrice?.value === SELLER.askingPrice && brief.opportunity?.askingPrice?.basis === "recorded" &&
    brief.underwriting?.analysisStatus === "insufficient_evidence" &&
    brief.underwriting?.figures?.mao?.value === null && brief.underwriting?.figures?.mao?.basis === "unknown",
    `seller=${brief.seller?.displayName} asking=${JSON.stringify(brief.opportunity?.askingPrice)} uw=${JSON.stringify(brief.underwriting?.figures?.mao)}`);
  check("J9.3 brief carries its generation provenance (underwriting ref id, source ids, record counts)",
    !!brief.artifactProvenance?.underwritingRefId && (brief.artifactProvenance?.sourceRowIds || []).length >= 1 &&
    brief.artifactProvenance?.counts?.interactions === 1,
    `provenance=${JSON.stringify(brief.artifactProvenance || {}).slice(0, 240)}`);

  const prep = await call(base, "GET", `/api/v1/operator/call-preparation?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const tools = await toolLegs();
  const toolPlan = await tools.run("prepare_call", { opportunityId: sellerOppId });
  tools.db.close();
  check("J9.4 call preparation is now an operator REST surface returning the recorded plan (never dials)",
    prep.status === 200 && prep.json?.data?.callPreparation?.dials === false &&
    prep.json?.data?.callPreparation?.contact?.phone === SELLER.phone,
    `status=${prep.status} phone=${prep.json?.data?.callPreparation?.contact?.phone}`);
  check("J9.5 REST call preparation is identical to the Piper prepare_call tool result (one implementation, two surfaces)",
    JSON.stringify(prep.json?.data?.callPreparation) === JSON.stringify(toolPlan.data),
    `identical=${JSON.stringify(prep.json?.data?.callPreparation) === JSON.stringify(toolPlan.data)}`);

  const rec = await call(base, "POST", "/api/v1/operator/journey-recommendations", { token: OP_SECRET, body: { opportunityId: sellerOppId } });
  recId = rec.json?.data?.recommendation?.id;
  check("J9.6 journey recommendation is RECORDED from real decision state (201, basis = the J4 committee review)",
    rec.status === 201 && !!recId && rec.json?.data?.recommendation?.basisType === "committee_review",
    `status=${rec.status} basisType=${rec.json?.data?.recommendation?.basisType}`);
  check("J9.7 the recorded recommendation preserves the committee HOLD verbatim — recording never upgrades a decision",
    rec.json?.data?.recommendation?.actionKind === "committee_hold" && rec.json?.data?.recommendation?.basis?.decision === "hold",
    `kind=${rec.json?.data?.recommendation?.actionKind} decision=${rec.json?.data?.recommendation?.basis?.decision}`);

  const timeline = await call(base, "GET", `/api/v1/operator/timeline?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  check("J9.8 the recorded recommendation is readable on the journey timeline",
    (timeline.json?.data?.timeline?.events || []).some(e => e.type === "recommendation" && /Hold/.test(e.summary || "")),
    `eventTypes=${[...new Set((timeline.json?.data?.timeline?.events || []).map(e => e.type))].join(",")}`);

  const hist = await call(base, "GET", `/api/v1/operator/follow-up-history?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const h = hist.json?.data?.followUpHistory || {};
  const ats = (h.events || []).map(e => e.at);
  check("J9.9 follow-up history exposes interactions + next-actions + stage events merged in chronological order",
    hist.status === 200 && h.counts?.interactions === 1 && h.counts?.nextActions >= 1 && h.counts?.stageEvents >= 2 &&
    JSON.stringify(ats) === JSON.stringify([...ats].sort()),
    `counts=${JSON.stringify(h.counts || {})} chronological=${JSON.stringify(ats) === JSON.stringify([...ats].sort())}`);

  // F6 with its OWN criteria (the J8 criteria stays active for J6).
  const f6 = await call(base, "POST", "/api/v1/operator/buyer-criteria", { token: OP_SECRET, body: { label: "F6 battery buyer (synthetic)", markets: ["Wichita"] } });
  const f6Id = f6.json?.data?.criteria?.id;
  const f6Active = await call(base, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${f6Id}`, { token: OP_SECRET });
  const f6Arch = await call(base, "POST", `/api/v1/operator/buyer-criteria/${f6Id}`, { token: OP_SECRET, body: { status: "archived" } });
  const f6Refused = await call(base, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${f6Id}`, { token: OP_SECRET });
  const f6Readable = await call(base, "GET", `/api/v1/operator/buyer-criteria/${f6Id}`, { token: OP_SECRET });
  check("J9.10 F6 CLOSED: an archived buyer criteria can no longer produce a ranking (409 criteria_archived) but remains readable as history",
    f6Active.status === 200 && f6Arch.status === 200 && f6Refused.status === 409 && f6Refused.json?.error === "criteria_archived" &&
    f6Readable.status === 200 && f6Readable.json?.data?.criteria?.status === "archived",
    `active=${f6Active.status} archived=${f6Arch.status} rankingAfter=${f6Refused.status}/${f6Refused.json?.error} read=${f6Readable.status}`);

  // Tenant ghosts on every new surface (foreign opportunity seeded in J7).
  const { openPipelineDatabase } = await import(join(REPO, "src/database/openDatabase.js"));
  const gdb = openPipelineDatabase(dbPath);
  gdb.prepare(`INSERT INTO seller_briefs (id, tenant_id, opportunity_id, brief_json, provenance_json, generated_by, generated_at, created_at)
    VALUES ('brief-jb-foreign', 'tenant-b', 'opp_journey_foreign', '{"id":"brief-jb-foreign"}', '{}', 'journey-battery', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')`).run();
  gdb.close();
  const ghosts = [
    ["brief generate", await call(base, "POST", "/api/v1/operator/seller-briefs", { token: OP_SECRET, body: { opportunityId: "opp_journey_foreign" } })],
    ["brief list", await call(base, "GET", "/api/v1/operator/seller-briefs?opportunityId=opp_journey_foreign", { token: OP_SECRET })],
    ["foreign brief get", await call(base, "GET", "/api/v1/operator/seller-briefs/brief-jb-foreign", { token: OP_SECRET })],
    ["call preparation", await call(base, "GET", "/api/v1/operator/call-preparation?opportunityId=opp_journey_foreign", { token: OP_SECRET })],
    ["recommendation record", await call(base, "POST", "/api/v1/operator/journey-recommendations", { token: OP_SECRET, body: { opportunityId: "opp_journey_foreign" } })],
    ["recommendation list", await call(base, "GET", "/api/v1/operator/journey-recommendations?opportunityId=opp_journey_foreign", { token: OP_SECRET })],
    ["follow-up history", await call(base, "GET", "/api/v1/operator/follow-up-history?opportunityId=opp_journey_foreign", { token: OP_SECRET })],
  ];
  for (const [name, res] of ghosts) {
    check(`J9.11 foreign tenant is a ghost on the new surface: ${name} (404)`,
      res.status === 404, `status=${res.status}`);
  }

  // Restart: the brief + recommendation are stored artifacts — the exact
  // documents must come back, not recomputations.
  const briefBefore = await call(base, "GET", `/api/v1/operator/seller-briefs/${briefId}`, { token: OP_SECRET });
  const recBefore = await call(base, "GET", `/api/v1/operator/journey-recommendations/${recId}`, { token: OP_SECRET });
  await stop(server.child);
  server = await boot(PORT, dbPath);
  const briefAfter = await call(server.base, "GET", `/api/v1/operator/seller-briefs/${briefId}`, { token: OP_SECRET });
  const recAfter = await call(server.base, "GET", `/api/v1/operator/journey-recommendations/${recId}`, { token: OP_SECRET });
  check("J9.12 stored brief document reads back BYTE-IDENTICAL after a full restart (artifact, not recomputation)",
    JSON.stringify(briefBefore.json?.data?.brief) === JSON.stringify(briefAfter.json?.data?.brief),
    `identical=${JSON.stringify(briefBefore.json?.data?.brief) === JSON.stringify(briefAfter.json?.data?.brief)}`);
  check("J9.13 stored recommendation reads back byte-identical after restart",
    JSON.stringify(recBefore.json?.data?.recommendation) === JSON.stringify(recAfter.json?.data?.recommendation),
    `identical=${JSON.stringify(recBefore.json?.data?.recommendation) === JSON.stringify(recAfter.json?.data?.recommendation)}`);
  flushSection();
}

// ------------------------------------------------------------------ J6
async function captureState(base) {
  const detail = await call(base, "GET", `/api/v1/opportunities/${sellerOppId}`, { token: OP_SECRET });
  const under = await call(base, "GET", `/api/v1/operator/underwriting?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const offers = await call(base, "GET", `/api/v1/operator/offers?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const timeline = await call(base, "GET", `/api/v1/operator/timeline?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const actions = await call(base, "GET", `/api/v1/operator/next-actions?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const interactions = await call(base, "GET", `/api/v1/operator/interactions?opportunityId=${sellerOppId}`, { token: OP_SECRET });
  const ranking = await call(base, "GET", `/api/v1/operator/candidate-ranking?criteriaId=${criteriaId}`, { token: OP_SECRET });
  return stripVolatile({ detail: detail.json, under: under.json, offers: offers.json, timeline: timeline.json, actions: actions.json, interactions: interactions.json, ranking: ranking.json });
}

async function j6() {
  beginSection("J6", "Restart persistence + audit read-back");
  preRestart = await captureState(server.base);
  const db0 = dbRO(dbPath);
  const auditBefore = db0.prepare("SELECT COUNT(*) c FROM operational_audit_events").get().c;
  const stageEventsBefore = db0.prepare("SELECT COUNT(*) c FROM seller_stage_events").get().c;
  db0.close();

  await stop(server.child);
  server = await boot(PORT, dbPath);

  const postRestart = await captureState(server.base);
  check("J6.1 journey artifacts read back byte-identical after a full process restart",
    JSON.stringify(postRestart) === JSON.stringify(preRestart),
    `equal=${JSON.stringify(postRestart) === JSON.stringify(preRestart)}`);

  const db1 = dbRO(dbPath);
  const auditAfter = db1.prepare("SELECT COUNT(*) c FROM operational_audit_events").get().c;
  const stageEventsAfter = db1.prepare("SELECT COUNT(*) c FROM seller_stage_events").get().c;
  const types = db1.prepare("SELECT DISTINCT event_type FROM operational_audit_events").all().map(r => r.event_type);
  const chain = db1.prepare("SELECT prior_stage, new_stage FROM seller_stage_events WHERE opportunity_id = ? ORDER BY created_at, rowid").all(sellerOppId);
  const interactionsCount = db1.prepare("SELECT COUNT(*) c FROM seller_interactions WHERE opportunity_id = ?").get(sellerOppId).c;
  db1.close();
  check("J6.2 the restart itself wrote nothing (audit + stage-event counts unchanged)",
    auditAfter === auditBefore && stageEventsAfter === stageEventsBefore,
    `audit ${auditBefore}->${auditAfter}, stageEvents ${stageEventsBefore}->${stageEventsAfter}`);
  check("J6.3 audit trail covers every write leg the journey actually executed",
    ["DEAL_FINDR_INTAKE", "DEAL_FINDR_DUPLICATE_RECONCILED", "OPPORTUNITY_STAGE_MOVED", "OFFER_PREPARED", "INVESTMENT_COMMITTEE_REVIEW", "OFFER_APPROVAL_REFUSED"]
      .every(t => types.includes(t)),
    `types=${types.join(",")}`);
  check("J6.4 stage chain is unbroken and includes the committee hold attestation",
    chain.length >= 3 && chain[0].prior_stage === "new_lead" &&
    chain.every((s, i) => i === 0 || s.prior_stage === chain[i - 1].new_stage) &&
    chain.some(s => s.prior_stage === "offer_preparation" && s.new_stage === "strategy_development"),
    `chain=${chain.map(s => `${s.prior_stage}->${s.new_stage}`).join(" | ")}`);
  check("J6.5 interaction ledger holds exactly the one operator-recorded J3 outcome — no simulated or sent seller contact beyond it",
    interactionsCount === 1, `seller_interactions=${interactionsCount}`);
  flushSection();
}

// ------------------------------------------------------------------ main
async function main() {
  const stamp = new Date().toISOString();
  const dir = mkdtempSync(join(tmpdir(), "issue8-journey-"));
  dbPath = join(dir, "journey.db");
  writeFileSync(RESULTS, [
    "# Issue #8 — seller-to-deal journey battery results (Builder JOURNEY2, remediation)",
    "",
    `- Run (UTC): ${stamp}`,
    `- Tree: remediation/work-journey2 (combined candidate + migration 036 journey artifacts build)`,
    `- Server: real child process, production posture, PIPER provider "none" (PIPER LIMITED), disposable DB only`,
    "- Fixtures: synthetic, labeled synthetic. No production access, no seller contact.",
    ""
  ].join("\n"));

  console.log(`journey battery: booting ${REPO} on ${dbPath}`);
  server = await boot(PORT, dbPath);
  const health = await call(server.base, "GET", "/health");
  console.log(`health: ${health.status} ${health.text.slice(0, 200)}`);

  await j1(); await j2(); await j3(); await j4(); await j5(); await j8(); await j7(); await j9(); await j6();
  await stop(server.child);

  let total = 0, passed = 0;
  for (const s of sections) { total += s.checks.length; passed += s.checks.filter(c => c.ok).length; }
  appendFileSync(RESULTS, `\n## TOTAL\n\n**${passed}/${total} assertions passed across ${sections.length} journey legs (J1–J9).**\n`);
  console.log(`\n==== JOURNEY BATTERY TOTAL: ${passed}/${total} ====`);
  process.exitCode = passed === total ? 0 : 1;
}

main().catch(async (err) => {
  console.error("BATTERY ERROR:", err);
  try { await stop(server?.child); } catch { /* ignore */ }
  process.exitCode = 2;
});
