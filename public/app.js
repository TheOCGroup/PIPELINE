// ========================================================
// PIPELINE CLIENT APPLICATION ENGINE - FULLY INTERACTIVE
// ========================================================

(() => {
  const view = document.getElementById("view");
  const demoBanner = document.getElementById("demo-banner");
  const footerMode = document.getElementById("footer-mode");
  const appVersion = document.getElementById("app-version");
  const piperDrawer = document.getElementById("piper-drawer");
  const piperChatHistory = document.getElementById("piper-chat-history");
  const piperChatInput = document.getElementById("piper-chat-input");
  const piperChatForm = document.getElementById("piper-chat-form");
  const piperContextText = document.getElementById("piper-context-text");

  // State Ledger
  let state = {
    opportunities: [],
    provenance: [],
    classifications: [],
    dataQuality: {},
    systemStatus: {},
    csrfToken: null,
    activeOppId: null,
    piperMessages: [
      { sender: "bot", text: "Hello Genaro. I’m PIPER. I’ll ground every recommendation in the property, its source, and the active pipeline record." }
    ]
  };

  // Helper: Escape HTML
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Helper: Stage Labels mapping
  const stageLabels = {
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
    archived: "Archived"
  };
  const formatStage = (s) => stageLabels[s] || String(s || "any");

  // Helper: Money Formatter
  const money = (val) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val || 0);

  // Helper: Badges
  const badge = (cls, val) => `<span class="badge b-${esc(val)}">${esc(val)}</span>`;
  const loading = () => { view.innerHTML = `<div class="state">Loading…</div>`; };
  const errorState = (msg) => { view.innerHTML = `<div class="state error">${esc(msg)}</div>`; };
  const empty = (msg) => `<div class="state">${esc(msg)}</div>`;

  // API REST Client
  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" && method !== "HEAD" && state.csrfToken ? { "x-csrf-token": state.csrfToken } : {}),
      ...(options.headers || {})
    };
    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ? `${res.status} ${body.error}` : `${res.status}`);
    return body;
  }

  // Local Storage Overrides Helpers
  function getOverrides(id) {
    const data = JSON.parse(localStorage.getItem("pipeline_overrides") || "{}");
    return data[id] || {};
  }

  function setOverride(id, key, val) {
    const data = JSON.parse(localStorage.getItem("pipeline_overrides") || "{}");
    if (!data[id]) data[id] = {};
    data[id][key] = val;
    localStorage.setItem("pipeline_overrides", JSON.stringify(data));
  }

  // Local Tasks Checklist Helpers
  function getTasks(oppId) {
    const data = JSON.parse(localStorage.getItem("pipeline_tasks") || "{}");
    if (!data[oppId]) {
      // Default checklists for new deals
      data[oppId] = [
        { title: "Skiptrace owner contact details", done: false },
        { title: "Verify APN/GIS records", done: false },
        { title: "Run 70% MAO calculations", done: false },
        { title: "Schedule walk-through / inspection", done: false },
        { title: "Draft escrow purchase agreement", done: false }
      ];
      localStorage.setItem("pipeline_tasks", JSON.stringify(data));
    }
    return data[oppId];
  }

  function toggleTask(oppId, index) {
    const data = JSON.parse(localStorage.getItem("pipeline_tasks") || "{}");
    if (data[oppId] && data[oppId][index]) {
      data[oppId][index].done = !data[oppId][index].done;
      localStorage.setItem("pipeline_tasks", JSON.stringify(data));
    }
  }

  // Local Seller Logs Helpers
  function getSellerLogs(oppId) {
    const data = JSON.parse(localStorage.getItem("pipeline_logs") || "{}");
    return data[oppId] || [];
  }

  function addSellerLog(oppId, text) {
    const data = JSON.parse(localStorage.getItem("pipeline_logs") || "{}");
    if (!data[oppId]) data[oppId] = [];
    data[oppId].push({ text, date: new Date().toLocaleDateString() });
    localStorage.setItem("pipeline_logs", JSON.stringify(data));
  }

  // Global System Info Sync
  async function refreshMode() {
    try {
      const { data } = await api("/api/v1/system/status");
      state.systemStatus = data;
      appVersion.textContent = "v" + data.version;
      demoBanner.hidden = !(data.demo === true);
      footerMode.textContent = `data source: ${data.dataSource} · integration: ${data.integration}`;
      if (data.integration === "enabled") {
        const session = await api("/api/v1/auth/session");
        state.csrfToken = session.csrfToken;
      }
    } catch { /* status is best-effort */ }
  }

  // ---- views ----
  async function overview() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const [dq, sys, opps, piper, recommendations] = await Promise.all([
      api("/api/v1/data-quality"),
      api("/api/v1/system/status"),
      api("/api/v1/opportunities?limit=100"),
      api("/api/v1/piper/status"),
      api("/api/v1/piper/recommendations?limit=3")
    ]);
    const d = dq.data, s = sys.data;
    state.opportunities = opps.data;

    // Compile local overrides to get actual stage metrics
    const stageCounts = {};
    state.opportunities.forEach(o => {
      const overrides = getOverrides(o.id);
      const actualStage = overrides.stage || o.stage || "new_lead";
      stageCounts[actualStage] = (stageCounts[actualStage] || 0) + 1;
    });

    view.innerHTML = `
      <h1>Overview</h1>
      <p class="sub">Standalone PIPELINE experience · data source: <strong>${esc(s.dataSource)}</strong> · OCG ONE integration: <strong>${esc(s.integration)}</strong></p>

      <section class="piper-command-panel">
        <div class="piper-orb" aria-hidden="true"><span></span></div>
        <div>
          <div class="eyebrow">PIPER · PROACTIVE ACQUISITION INTELLIGENCE</div>
          <h2>${piper.data.sources.enabled ? `${piper.data.sources.enabled} approved source${piper.data.sources.enabled === 1 ? "" : "s"} under watch` : "Discovery sources ready to configure"}</h2>
          <p>${piper.data.latestRun ? `Latest run found ${piper.data.latestRun.recordsFound} properties and created ${piper.data.latestRun.recordsCreated} new opportunities.` : "PIPER will scan only approved public sources, preserve provenance, and explain every recommendation."}</p>
        </div>
        <a class="command-link" href="/piper" data-nav>Open intelligence →</a>
      </section>

      ${recommendations.data.length ? `<div class="priority-strip">${recommendations.data.map((item) => `
        <a href="/opportunities/${esc(item.opportunityId)}" data-nav class="priority-item priority-${esc(item.priority)}">
          <span>${esc(item.priority)}</span><strong>${esc(item.address)}</strong><small>${esc(item.summary)}</small>
        </a>`).join("")}</div>` : ""}

      <!-- Metrics summary cards -->
      <div class="cards">
        ${card(state.opportunities.length, "Total opportunities")}
        ${card(d.originalProvenance, "Original provenance")}
        ${card(d.recoveredProvenance, "Recovered provenance")}
        ${card(d.unresolvedProvenance, "Unresolved provenance")}
        ${card(`${d.classificationCoverage.classified}/${d.classificationCoverage.total}`, "Classified")}
        ${card(d.staleOpportunities, "Stale")}
      </div>

      <!-- Funnel Breakdown panel -->
      <h2> funnel stage breakdown</h2>
      <div class="panel">
        <div style="display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.82rem;">
          ${Object.keys(stageCounts).map(stage => `
            <div style="background: var(--bg); border: 1px solid var(--line); padding: 8px 12px; border-radius: 6px;">
              <strong>${esc(formatStage(stage))}</strong>: ${stageCounts[stage]}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="panel"><strong>Fixture / demo disclosure.</strong> ${s.demo ? "This view is backed by <strong>DEMO fixtures</strong>, not production data." : "Empty data mode — no records loaded."}</div>`;
  }
  const card = (n, l) => `<div class="card"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;

  async function opportunities() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const params = new URLSearchParams(location.search);
    const qs = new URLSearchParams();
    for (const k of ["stage", "provenanceState", "classification", "status", "page"]) if (params.get(k)) qs.set(k, params.get(k));
    let body;
    try { body = await api("/api/v1/opportunities?" + qs.toString()); }
    catch (e) { return errorState("Could not load opportunities: " + e.message); }

    // Apply local stage overrides to list view
    state.opportunities = body.data.map(o => {
      const overrides = getOverrides(o.id);
      return {
        ...o,
        stage: overrides.stage || o.stage
      };
    });

    const pg = body.meta.pagination;
    view.innerHTML = `
      <h1>Opportunities</h1>
      <p class="sub">${pg.total} record(s)${body.meta.demo ? " · DEMO DATA" : ""}</p>
      ${filterBar(params)}
      ${state.opportunities.length === 0 ? empty("No opportunities match these filters.") : `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>ID</th><th>Seller</th><th>Property</th><th>Stage</th><th>Provenance</th><th>Classification</th><th>Status</th><th>Operator</th><th>Last activity</th>
        </tr></thead>
        <tbody>${state.opportunities.map(oppRow).join("")}</tbody>
      </table></div>
      <div class="pager">
        <button class="secondary" ${pg.page <= 1 ? "disabled" : ""} data-page="${pg.page - 1}">Prev</button>
        <span class="muted">Page ${pg.page} / ${pg.totalPages}</span>
        <button class="secondary" ${pg.page >= pg.totalPages ? "disabled" : ""} data-page="${pg.page + 1}">Next</button>
      </div>`}`;
    view.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
      const p = new URLSearchParams(location.search); p.set("page", b.dataset.page); navigate("/opportunities?" + p.toString());
    }));
    wireFilters();
  }
  const oppRow = (o) => `<tr>
      <td><a href="/opportunities/${esc(o.id)}" data-nav>${esc(o.id)}</a></td>
      <td>${esc(o.sellerDisplayName)}</td>
      <td>${o.propertyRef ? esc(o.propertyRef) : '<span class="muted">— missing —</span>'}</td>
      <td>${esc(formatStage(o.stage))}</td>
      <td>${badge("prov", o.provenanceState)}</td>
      <td>${badge("cls", o.classification)}</td>
      <td>${badge("st", o.status)}</td>
      <td>${esc(o.assignedOperator)}</td>
      <td>${esc((o.lastActivity || "").slice(0, 10))}</td></tr>`;

  function filterBar(params) {
    const opt = (val, cur) => `<option value="${esc(val)}" ${cur === val ? "selected" : ""}>${esc(formatStage(val))}</option>`;
    const sel = (name, values) => `<label>${name}<select data-filter="${name}">${["", ...values].map((v) => opt(v, params.get(name) || "")).join("")}</select></label>`;
    return `<div class="filters">
      ${sel("stage", ["new_lead", "needs_review", "attempting_contact", "contacted", "qualified", "appointment_scheduled", "property_review", "strategy_development", "offer_preparation", "offer_approval_required", "offer_presented", "negotiating", "under_contract", "due_diligence", "closing_scheduled", "closed", "nurture", "disqualified", "lost", "archived"])}
      ${sel("provenanceState", ["original", "recovered", "unresolved"])}
      ${sel("classification", ["REAL", "SYNTHETIC", "AMBIGUOUS"])}
      ${sel("status", ["active", "closed"])}
      <label>&nbsp;<button class="secondary" data-clear>Clear</button></label>
    </div>`;
  }
  function wireFilters() {
    view.querySelectorAll("[data-filter]").forEach((s) => s.addEventListener("change", () => {
      const p = new URLSearchParams(location.search); const v = s.value;
      v ? p.set(s.dataset.filter, v) : p.delete(s.dataset.filter); p.delete("page");
      navigate("/opportunities?" + p.toString());
    }));
    const clr = view.querySelector("[data-clear]"); if (clr) clr.addEventListener("click", () => navigate("/opportunities"));
  }

  async function opportunityDetail(id) {
    loading();
    state.activeOppId = id;
    updatePiperContext();
    let body;
    try { body = await api("/api/v1/opportunities/" + encodeURIComponent(id)); }
    catch (e) { return errorState(e.message.includes("404") ? "Opportunity not found." : "Could not load opportunity: " + e.message); }
    const o = body.data;

    // Load Local overrides
    const overrides = getOverrides(o.id);
    const stageVal = overrides.stage || o.stage || "new_lead";
    const arvVal = overrides.arv || 250000;
    const rehabVal = overrides.rehab || 50000;
    const feeVal = overrides.fee || 5000;
    const holdingVal = overrides.holding || 8000;
    const askingVal = overrides.askingPrice || 120000;

    // Calculate MAO
    const mao = Math.max(0, Math.round(arvVal * 0.70 - rehabVal - feeVal - holdingVal));
    const isWarning = askingVal > mao;

    // Render columns
    view.innerHTML = `
      <p><a href="/opportunities" data-nav>← Opportunities</a></p>
      <h1>${esc(o.sellerDisplayName)} <span class="muted">${esc(o.id)}</span></h1>
      <p class="sub">${badge("cls", o.classification)} ${badge("prov", o.provenance.state)} ${badge("st", o.status)}${body.meta.demo ? " · DEMO DATA" : ""}</p>

      <div class="detail-grid">

        <!-- COLUMN 1: Underwriting Calculator & Info -->
        <div>
          <div class="panel">
            <h2>Opportunity Details</h2>
            <dl class="kv">
              <dt>Opportunity code</dt><dd>${esc(o.code)}</dd>
              <dt>Current Stage</dt>
              <dd>
                <select id="detail-stage-select" onchange="window.saveStageChange('${o.id}')">
                  ${["new_lead", "needs_review", "attempting_contact", "contacted", "qualified", "appointment_scheduled", "property_review", "strategy_development", "offer_preparation", "offer_approval_required", "offer_presented", "negotiating", "under_contract", "due_diligence", "closing_scheduled", "closed", "nurture", "disqualified", "lost", "archived"].map(st => `
                    <option value="${st}" ${st === stageVal ? 'selected' : ''}>${esc(formatStage(st))}</option>
                  `).join("")}
                </select>
              </dd>
              <dt>Assigned operator</dt><dd>${esc(o.assignedOperator)}</dd>
              <dt>External property ref</dt><dd>${o.property.externalPropertyId ? esc(o.property.externalPropertyId) : '<span class="muted">— missing (PIPELINE-owned) —</span>'}</dd>
              <dt>Property address</dt><dd>${esc(o.property.address)}</dd>
              <dt>Last activity</dt><dd>${esc((o.lastActivity || "").slice(0, 10))}</dd>
            </dl>
          </div>

          <!-- 70% Underwriting math calculator -->
          <div class="panel">
            <h2>Deal Underwriting Analyzer</h2>
            <div class="calc-card">
              <div class="form-grid">
                <div class="form-group">
                  <label>ARV Target ($)</label>
                  <input type="number" id="detail-arv" value="${arvVal}" oninput="window.recalcMao()" />
                </div>
                <div class="form-group">
                  <label>Estimated Rehab ($)</label>
                  <input type="number" id="detail-rehab" value="${rehabVal}" oninput="window.recalcMao()" />
                </div>
                <div class="form-group">
                  <label>Wholesale Fee ($)</label>
                  <input type="number" id="detail-fee" value="${feeVal}" oninput="window.recalcMao()" />
                </div>
                <div class="form-group">
                  <label>Holding Costs ($)</label>
                  <input type="number" id="detail-holding" value="${holdingVal}" oninput="window.recalcMao()" />
                </div>
                <div class="form-group">
                  <label>Asking Purchase Price ($)</label>
                  <input type="number" id="detail-asking" value="${askingVal}" oninput="window.recalcMao()" />
                </div>
              </div>

              <div class="calc-output">
                <div class="calc-output-row">
                  <span>Standard Rule</span>
                  <span>70% of ARV</span>
                </div>
                <div class="calc-output-row highlight">
                  <span>Maximum Allowable Offer (MAO)</span>
                  <span id="detail-mao-val" style="color: var(--ok);">${money(mao)}</span>
                </div>
              </div>

              <div id="detail-mao-alert" class="alert-box ${isWarning ? 'warn' : 'ok'}">
                ${isWarning ?
                  `<strong>OFFER EXCEEDS 70% MAO:</strong> Current asking price is above the preliminary acquisition limit. Offer must be reduced.`
                  : `<strong>70% RULE SATISFIED:</strong> Purchase price falls within the preliminary acquisition limit.`
                }
              </div>

              <div style="margin-top: 12px; text-align: right;">
                <button onclick="window.saveDetailUnderwriting('${o.id}')">Save Underwriting Metrics</button>
              </div>
            </div>
          </div>
        </div>

        <!-- COLUMN 2: Tasks Checklist & Negotiation Logs -->
        <div>
          <!-- Interactive Task checklist -->
          <div class="panel">
            <h2>Acquisitions Checklist</h2>
            <div class="checklist-box" id="detail-tasks-box">
              ${getTasks(o.id).map((t, idx) => `
                <div class="task-item">
                  <input type="checkbox" ${t.done ? 'checked' : ''} class="task-checkbox" onchange="window.toggleDetailTask('${o.id}', ${idx})" />
                  <span class="task-text ${t.done ? 'done' : ''}">${esc(t.title)}</span>
                </div>
              `).join("")}
            </div>
          </div>

          <!-- Negotiation Logs -->
          <div class="panel">
            <h2>Seller Call Log & Notes</h2>
            <form class="log-form" onsubmit="window.submitSellerLog(event, '${o.id}')">
              <input type="text" id="detail-log-input" placeholder="Type new seller update..." required />
              <button type="submit">Add Log</button>
            </form>
            <div class="logs-list" id="detail-logs-list">
              ${getSellerLogs(o.id).map(l => `
                <div class="log-card">
                  <div>"${esc(l.text)}"</div>
                  <span class="log-date">${esc(l.date)}</span>
                </div>
              `).join("")}
            </div>
          </div>
        </div>

      </div>

      <h2>Provenance resolution</h2>
      <div class="panel"><dl class="kv">
        <dt>State</dt><dd>${badge("prov", o.provenance.state)}</dd>
        <dt>Resolved message</dt><dd>${o.provenance.resolvedSourceMessageId ? esc(o.provenance.resolvedSourceMessageId) : '<span class="muted">unresolved</span>'}</dd>
        <dt>Original</dt><dd>${esc(o.provenance.originalSourceMessageId || "—")}</dd>
        <dt>Recovered</dt><dd>${esc(o.provenance.recoveredSourceMessageId || "—")}</dd>
        <dt>Recovery method</dt><dd>${esc(o.provenance.recoveryMethod || "—")}</dd>
        <dt>Confidence</dt><dd>${esc(o.provenance.recoveryConfidence || "—")}</dd>
      </dl></div>
      <h2>Stage timeline</h2>
      ${o.stageTimeline.length ? tbl(["Stage", "At", "By"], o.stageTimeline.map((s) => [formatStage(s.stage), (s.at || "").slice(0, 10), s.changedBy])) : empty("No stage events.")}
      <h2>Offers</h2>
      ${o.offers.length ? tbl(["ID", "Amount", "Status", "Version"], o.offers.map((f) => [f.id, f.amount, f.status, f.version])) : empty("No offers.")}
      <h2>Outcome</h2>
      <div class="panel">${o.outcome ? esc(o.outcome.result + " — " + o.outcome.reason) : '<span class="muted">No outcome recorded.</span>'}</div>
    `;
  }

  async function provenance() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const { data, meta } = await api("/api/v1/provenance");
    view.innerHTML = `<h1>Provenance</h1><p class="sub">${data.length} source(s)${meta.demo ? " · DEMO DATA" : ""}. Unresolved is <strong>not</strong> synthetic.</p>
      ${data.length ? tbl(
        ["Opportunity", "State", "Original", "Recovered", "Method", "Confidence"],
        data.map((r) => [linkOpp(r.opportunityId), badgeHtml(r.provenanceState), r.originalSourceMessageId || "—", r.recoveredSourceMessageId || "—", r.recoveryMethodLabel, r.recoveryConfidence || "—"]),
        true
      ) : empty("No provenance records (empty mode).")}`;
  }

  async function classifications() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const { data, meta } = await api("/api/v1/classifications");
    const cur = data.current, hist = data.history;
    view.innerHTML = `<h1>Classifications</h1><p class="sub">${cur.length} record(s)${meta.demo ? " · DEMO DATA" : ""}. Unresolved provenance is never auto-synthetic.</p>
      ${cur.length ? tbl(["Opportunity", "Classification", "Provenance", "Reason"], cur.map((c) => [linkOpp(c.opportunityId), badgeHtml(c.classification), badgeHtml(c.provenanceState), c.reason]), true) : empty("No classifications (empty mode).")}
      <h2>History (append-only)</h2>
      ${hist.length ? tbl(["Opportunity", "Prior", "New", "Reason", "At"], hist.map((h) => [linkOpp(h.opportunityId), h.priorClassification || "—", h.newClassification, h.reason, (h.changedAt || "").slice(0, 10)]), true) : empty("No history.")}`;
  }

  async function dataQuality() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const { data, meta } = await api("/api/v1/data-quality");
    view.innerHTML = `<h1>Data Quality</h1><p class="sub">${meta.demo ? "DEMO DATA" : "Empty mode"}</p>
      <div class="cards">
        ${card(data.totalOpportunities, "Total opportunities")}
        ${card(data.missingProvenance, "Missing provenance")}
        ${card(data.recoveredProvenance, "Recovered provenance")}
        ${card(data.unresolvedProvenance, "Unresolved provenance")}
        ${card(`${data.classificationCoverage.classified}/${data.classificationCoverage.total}`, "Classification coverage")}
        ${card(data.missingPropertyReferences, "Missing property refs")}
        ${card(data.missingParticipantReferences, "Missing participant refs")}
        ${card(data.staleOpportunities, "Stale opportunities")}
      </div>`;
  }

  async function system() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const { data } = await api("/api/v1/system/status");
    view.innerHTML = `<h1>System</h1>
      <div class="panel"><dl class="kv">
        <dt>Application</dt><dd>${esc(data.name)}</dd>
        <dt>Version</dt><dd>${esc(data.version)}</dd>
        <dt>Schema version</dt><dd>${esc(data.schemaVersion)}</dd>
        <dt>Runtime mode</dt><dd>${esc(data.runtimeMode)}</dd>
        <dt>Data source</dt><dd>${esc(data.dataSource)} ${data.demo ? "(DEMO DATA)" : ""}</dd>
        <dt>Database</dt><dd>${esc(data.database)}</dd>
        <dt>OCG ONE integration</dt><dd>${esc(data.integration)}</dd>
        <dt>Handoff</dt><dd>${esc(data.handoff)}</dd>
        <dt>API contract version</dt><dd>${esc(data.apiContractVersion)}</dd>
      </dl></div>`;
  }

  async function piperIntelligence() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const [statusBody, recommendationsBody] = await Promise.all([
      api("/api/v1/piper/status"),
      api("/api/v1/piper/recommendations?limit=20")
    ]);
    const status = statusBody.data;
    const recommendations = recommendationsBody.data;
    const latest = status.latestRun;
    const top = status.topFinding;

    view.innerHTML = `
      <div class="intelligence-hero">
        <div class="piper-orb piper-orb-large" aria-hidden="true"><span></span></div>
        <div>
          <div class="eyebrow">PIPER · ACQUISITION INTELLIGENCE</div>
          <h1>See the opportunity before it becomes obvious.</h1>
          <p class="sub">Grounded discovery, explainable scoring, clean provenance, and proactive next actions—inside the pipeline where your team works.</p>
        </div>
        <button id="piper-run-discovery" ${status.sources.enabled ? "" : "disabled"}>Run discovery</button>
      </div>

      <div class="intelligence-metrics">
        ${card(status.sources.enabled, "Approved sources live")}
        ${card(status.activeOpportunities, "Active opportunities")}
        ${card(Object.values(status.recommendations).reduce((sum, count) => sum + count, 0), "Open recommendations")}
        ${card(top ? top.score : "—", "Top PIPER score")}
      </div>

      <div class="intelligence-grid">
        <section class="panel signal-panel">
          <div class="section-heading"><div><div class="eyebrow">LATEST SIGNAL</div><h2>Discovery pulse</h2></div><span class="live-indicator">LIVE</span></div>
          ${latest ? `
            <dl class="kv intelligence-kv">
              <dt>Source</dt><dd>${esc(latest.sourceName)}</dd>
              <dt>Status</dt><dd>${badge("st", latest.status)}</dd>
              <dt>Properties found</dt><dd>${esc(latest.recordsFound)}</dd>
              <dt>New opportunities</dt><dd>${esc(latest.recordsCreated)}</dd>
              <dt>Duplicates reconciled</dt><dd>${esc(latest.recordsReconciled)}</dd>
              <dt>Finished</dt><dd>${esc(latest.finishedAt ? new Date(latest.finishedAt).toLocaleString() : "In progress")}</dd>
            </dl>` : `<div class="empty-signal"><strong>No completed scan yet.</strong><span>${status.sources.enabled ? "Run discovery to establish the first signal." : "Add an approved JSON, JSON-LD, or RSS source to activate discovery."}</span></div>`}
        </section>

        <section class="panel signal-panel">
          <div class="eyebrow">STRONGEST FINDING</div>
          <h2>${top ? esc(top.address) : "Waiting for a qualified signal"}</h2>
          ${top ? `<div class="score-ring"><strong>${esc(top.score)}</strong><span>PIPER score</span></div>
            <p>Found through <strong>${esc(top.sourceName)}</strong>. The score is deterministic and its reasons remain attached to the opportunity.</p>
            <a href="/opportunities/${esc(top.opportunityId)}" data-nav class="command-link">Open property →</a>`
            : `<p class="muted">PIPER will rank new properties after discovery without fabricating missing underwriting data.</p>`}
        </section>
      </div>

      <section class="recommendations-section">
        <div class="section-heading"><div><div class="eyebrow">PROACTIVE QUEUE</div><h2>What PIPER recommends next</h2></div><button class="secondary" id="ask-piper-priority">Ask PIPER</button></div>
        ${recommendations.length ? `<div class="recommendation-grid">${recommendations.map((item) => `
          <a class="recommendation-card priority-${esc(item.priority)}" href="/opportunities/${esc(item.opportunityId)}" data-nav>
            <div><span class="priority-label">${esc(item.priority)}</span><span class="muted">${esc(new Date(item.createdAt).toLocaleDateString())}</span></div>
            <h3>${esc(item.address || item.opportunityId)}</h3>
            <p>${esc(item.summary)}</p>
            ${item.rationale?.length ? `<ul>${item.rationale.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}
          </a>`).join("")}</div>` : empty("No open recommendations yet. Run discovery or ingest a property to create the first prioritized action.")}
      </section>`;

    const runButton = document.getElementById("piper-run-discovery");
    if (runButton) runButton.addEventListener("click", async () => {
      runButton.disabled = true;
      runButton.textContent = "Scanning…";
      try {
        const result = await api("/api/v1/piper/run", { method: "POST", body: JSON.stringify({}) });
        const runs = result.data.results || [];
        const created = runs.reduce((sum, run) => sum + Number(run.counts?.created || 0), 0);
        state.piperMessages.push({ sender: "bot", text: `Discovery finished. I created ${created} new opportunit${created === 1 ? "y" : "ies"} and preserved source lineage for every result.` });
        await piperIntelligence();
      } catch (error) {
        runButton.disabled = false;
        runButton.textContent = "Run discovery";
        state.piperMessages.push({ sender: "bot", text: `I could not run discovery: ${error.message}. Check the approved source configuration and try again.` });
        piperDrawer.classList.remove("hidden");
        renderPiperHistory();
      }
    });
    const askButton = document.getElementById("ask-piper-priority");
    if (askButton) askButton.addEventListener("click", () => submitPiperMessage("What is my highest-priority next action?"));
  }

  // Interactive Underwriting math updates
  window.recalcMao = () => {
    const arv = Number(document.getElementById("detail-arv").value || 0);
    const rehab = Number(document.getElementById("detail-rehab").value || 0);
    const fee = Number(document.getElementById("detail-fee").value || 0);
    const holding = Number(document.getElementById("detail-holding").value || 0);
    const asking = Number(document.getElementById("detail-asking").value || 0);

    const newMao = Math.max(0, Math.round(arv * 0.70 - rehab - fee - holding));
    const isWarning = asking > newMao;

    const maoEl = document.getElementById("detail-mao-val");
    if (maoEl) maoEl.textContent = money(newMao);

    const alertEl = document.getElementById("detail-mao-alert");
    if (alertEl) {
      alertEl.className = `alert-box ${isWarning ? 'warn' : 'ok'}`;
      alertEl.innerHTML = isWarning ?
        `<strong>OFFER EXCEEDS 70% MAO:</strong> Current asking price is above the preliminary acquisition limit. Offer must be reduced.`
        : `<strong>70% RULE SATISFIED:</strong> Purchase price falls within the preliminary acquisition limit.`;
    }
  };

  window.saveDetailUnderwriting = (oppId) => {
    const arv = Number(document.getElementById("detail-arv").value || 0);
    const rehab = Number(document.getElementById("detail-rehab").value || 0);
    const fee = Number(document.getElementById("detail-fee").value || 0);
    const holding = Number(document.getElementById("detail-holding").value || 0);
    const asking = Number(document.getElementById("detail-asking").value || 0);

    setOverride(oppId, "arv", arv);
    setOverride(oppId, "rehab", rehab);
    setOverride(oppId, "fee", fee);
    setOverride(oppId, "holding", holding);
    setOverride(oppId, "askingPrice", asking);

    alert("Underwriting assumptions saved locally.");
  };

  window.saveStageChange = (oppId) => {
    const select = document.getElementById("detail-stage-select");
    if (select) {
      setOverride(oppId, "stage", select.value);
      alert(`Opportunity stage updated to: ${formatStage(select.value)}`);
    }
  };

  window.toggleDetailTask = (oppId, index) => {
    toggleTask(oppId, index);
    const label = view.querySelectorAll(".task-text")[index];
    if (label) {
      label.classList.toggle("done");
    }
  };

  window.submitSellerLog = (e, oppId) => {
    e.preventDefault();
    const input = document.getElementById("detail-log-input");
    if (!input || !input.value.trim()) return;

    const text = input.value.trim();
    input.value = "";

    addSellerLog(oppId, text);

    // Refresh log list view
    const list = document.getElementById("detail-logs-list");
    if (list) {
      list.innerHTML = getSellerLogs(oppId).map(l => `
        <div class="log-card">
          <div>"${esc(l.text)}"</div>
          <span class="log-date">${esc(l.date)}</span>
        </div>
      `).join("");
    }
  };

  // PIPER Co-pilot Widget Controls
  function initPiperWidget() {
    const toggle = document.getElementById("piper-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        piperDrawer.classList.toggle("hidden");
        renderPiperHistory();
      });
    }

    if (piperChatForm) {
      piperChatForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = piperChatInput.value.trim();
        if (!text) return;
        piperChatInput.value = "";
        await submitPiperMessage(text);
      });
    }
  }

  async function submitPiperMessage(text) {
    state.piperMessages.push({ sender: "user", text });
    state.piperMessages.push({ sender: "bot", text: "Thinking against the live pipeline…", pending: true });
    piperDrawer.classList.remove("hidden");
    renderPiperHistory();
    try {
      const body = await api("/api/v1/piper/chat", {
        method: "POST",
        body: JSON.stringify({ message: text, opportunityId: state.activeOppId })
      });
      state.piperMessages.pop();
      state.piperMessages.push({ sender: "bot", text: body.data.answer, actions: body.data.actions || [] });
    } catch (error) {
      state.piperMessages.pop();
      state.piperMessages.push({ sender: "bot", text: `I could not reach pipeline intelligence: ${error.message}. Your request was not acted on.` });
    }
    renderPiperHistory();
  }

  function renderPiperHistory() {
    if (!piperChatHistory) return;
    piperChatHistory.innerHTML = state.piperMessages.map(m => `
      <div class="msg ${m.sender === 'bot' ? 'bot' : 'user'} ${m.pending ? "pending" : ""}">
        <div>${esc(m.text).replace(/\n/g, "<br>")}</div>
        ${m.actions?.length ? `<div class="message-actions">${m.actions.map((action) => `<button class="quick-action-btn" data-piper-action="${esc(action.type)}" data-opportunity-id="${esc(action.opportunityId || "")}">${esc(action.label)}</button>`).join("")}</div>` : ""}
      </div>
    `).join("");
    piperChatHistory.scrollTop = piperChatHistory.scrollHeight;
  }

  window.triggerPiperQuickAction = (action) => {
    let query = "";
    if (action === "analyze") query = "Analyze this deal using the 70% MAO rule";
    else if (action === "verify") query = "Verify this property's source and provenance";
    else if (action === "script") query = "Generate a grounded seller conversation opener";
    else if (action === "scan") query = "Give me the latest website discovery status";

    if (piperChatInput) {
      piperChatInput.value = query;
      piperChatForm.dispatchEvent(new Event("submit"));
    }
  };

  function updatePiperContext() {
    if (!piperContextText) return;
    let text = `Sensing active view: ${location.pathname}`;
    if (state.activeOppId) {
      text = `Sensing active deal: ${state.activeOppId}`;
    }
    piperContextText.textContent = text;
  }

  piperChatHistory?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-piper-action]");
    if (!button) return;
    const opportunityId = button.dataset.opportunityId;
    if (button.dataset.piperAction === "run_discovery") navigate("/piper");
    else if (button.dataset.piperAction === "view_recommendations") navigate("/piper");
    else if (opportunityId) navigate(`/opportunities/${encodeURIComponent(opportunityId)}`);
  });

  // ---- helpers ----
  const linkOpp = (id) => `<a href="/opportunities/${esc(id)}" data-nav>${esc(id)}</a>`;
  const badgeHtml = (v) => `<span class="badge b-${esc(v)}">${esc(v)}</span>`;
  function tbl(headers, rows, rawCells = false) {
    const cell = (c) => rawCells ? c : esc(c);
    return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  // ---- router ----
  function render() {
    const path = location.pathname;
    document.querySelectorAll("[data-nav]").forEach((a) => {
      if (a.closest(".nav")) a.setAttribute("aria-current", a.getAttribute("href") === path ? "page" : "false");
    });
    const detail = path.match(/^\/opportunities\/([^/]+)$/);
    let p;
    if (path === "/" || path === "/index.html") p = overview();
    else if (path === "/opportunities") p = opportunities();
    else if (detail) p = opportunityDetail(decodeURIComponent(detail[1]));
    else if (path === "/provenance") p = provenance();
    else if (path === "/classifications") p = classifications();
    else if (path === "/data-quality") p = dataQuality();
    else if (path === "/piper") p = piperIntelligence();
    else if (path === "/system") p = system();
    else { view.innerHTML = `<div class="state">Page not found. <a href="/" data-nav>Overview</a></div>`; return; }
    Promise.resolve(p).catch((e) => errorState("Something went wrong: " + e.message));
  }

  function navigate(to) { history.pushState({}, "", to); render(); }
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-nav]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("http")) return;
    e.preventDefault(); navigate(href);
  });
  window.addEventListener("popstate", render);

  // Initialize
  (async () => {
    await refreshMode();
    initPiperWidget();
    render();
  })();
})();
