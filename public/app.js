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
    activeOppId: null,
    piperMessages: [
      { sender: "bot", text: "I read stage, provenance, classification, and data-quality state from PIPELINE's read-only API. Ask about any opportunity, or open one and ask what its lineage actually shows." }
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
  async function api(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
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

  // Operator state lives in PIPELINE, not the browser. These call the
  // /api/v1/operator/* endpoints so checklist progress and notes survive a
  // cleared cache and are visible to every operator.
  const CHECKLIST_TEMPLATE = [
    { key: "skiptrace", label: "Skiptrace owner contact details" },
    { key: "apn", label: "Verify APN/GIS records" },
    { key: "mao", label: "Run MAO calculations" },
    { key: "walkthrough", label: "Schedule walk-through / inspection" },
    { key: "escrow", label: "Draft escrow purchase agreement" },
  ];

  async function operatorGet(resource, oppId) {
    const res = await fetch(`/api/v1/operator/${resource}?opportunityId=${encodeURIComponent(oppId)}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "operator_read_failed");
    return body.data;
  }

  async function operatorPost(resource, payload) {
    const res = await fetch(`/api/v1/operator/${resource}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "operator_write_failed");
    return body.data;
  }

  /** Renders the checklist, merging stored state over the standard template. */
  async function renderChecklist(oppId) {
    const box = document.getElementById("detail-tasks-box");
    if (!box) return;
    try {
      const { checklist } = await operatorGet("checklist", oppId);
      const stored = new Map(checklist.map((i) => [i.key, i]));
      box.innerHTML = CHECKLIST_TEMPLATE.map((t) => {
        const done = stored.get(t.key)?.checked === true;
        return `<div class="task-item">
          <input type="checkbox" ${done ? "checked" : ""} class="task-checkbox"
                 onchange="window.toggleDetailTask('${esc(oppId)}','${esc(t.key)}','${esc(t.label)}',this.checked)" />
          <span class="task-text ${done ? "done" : ""}">${esc(t.label)}</span>
        </div>`;
      }).join("");
    } catch {
      box.innerHTML = `<div class="state error">Could not load checklist from PIPELINE.</div>`;
    }
  }

  async function renderNotes(oppId) {
    const list = document.getElementById("detail-logs-list");
    if (!list) return;
    try {
      const { notes } = await operatorGet("notes", oppId);
      list.innerHTML = notes.length
        ? notes.map((n) => `<div class="log-card"><div>"${esc(n.body)}"</div>
            <span class="log-date">${esc((n.createdAt || "").slice(0, 10))} · ${esc(n.createdBy)}</span></div>`).join("")
        : `<div class="state">No notes recorded.</div>`;
    } catch {
      list.innerHTML = `<div class="state error">Could not load notes from PIPELINE.</div>`;
    }
  }

  // Global System Info Sync
  async function refreshMode() {
    try {
      const { data } = await api("/api/v1/system/status");
      state.systemStatus = data;
      appVersion.textContent = "v" + data.version;
      demoBanner.hidden = !(data.demo === true);
      footerMode.textContent = `data source: ${data.dataSource} · integration: ${data.integration}`;
    } catch { /* status is best-effort */ }
  }

  // ---- views ----
  function bindTiltEffect(element) {
    if (!element) return;
    element.style.transition = "transform 0.15s ease-out, box-shadow 0.15s ease-out, border-color 0.15s ease-out";
    element.style.transformStyle = "preserve-3d";
    
    element.addEventListener("mousemove", (e) => {
      const rect = element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const xc = rect.width / 2;
      const yc = rect.height / 2;
      const dx = x - xc;
      const dy = y - yc;
      
      const tiltX = -(dy / yc) * 6;
      const tiltY = (dx / xc) * 6;
      
      element.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translateY(-4px)`;
      element.style.boxShadow = "0 20px 40px rgba(0,0,0,0.6), 0 0 20px rgba(139,92,246,0.15)";
      element.style.borderColor = "rgba(139, 92, 246, 0.4)";
    });
    
    element.addEventListener("mouseleave", () => {
      element.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)";
      element.style.boxShadow = "";
      element.style.borderColor = "";
    });
  }

  async function overview() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const [dq, sys, opps, briefRes] = await Promise.all([
      api("/api/v1/data-quality"),
      api("/api/v1/system/status"),
      api("/api/v1/opportunities?limit=100"),
      api("/api/v1/piper/brief").catch(() => ({ ok: true, data: { headline: "Pipeline active", sections: [] } }))
    ]);
    const d = dq.data, s = sys.data, b = briefRes.data;
    state.opportunities = opps.data;

    const stageCounts = {};
    state.opportunities.forEach(o => {
      const actualStage = o.stage || "new_lead";
      stageCounts[actualStage] = (stageCounts[actualStage] || 0) + 1;
    });

    let briefHtml = "";
    if (b && b.sections && b.sections.length > 0) {
      briefHtml = b.sections.map(sec => {
        const itemsHtml = sec.items.map(item => {
          return `
            <div class="priority-item" style="border-left: 2px solid var(--accent); padding-left: 10px; margin-bottom: 8px;">
              <a href="/opportunities/${esc(item.opportunityId)}" onclick="window.routeTo(event, '/opportunities/${esc(item.opportunityId)}')">
                <strong>${esc(item.address || item.opportunityId)}</strong>
              </a>
              <div class="priority-reasons" style="font-size: 11px; color: var(--muted); margin-top: 2px;">
                ${(item.reasons || []).map(r => `<span style="background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 4px; margin-right: 4px;">${esc(r)}</span>`).join("")}
              </div>
            </div>
          `;
        }).join("");
        
        return `
          <div class="card" style="margin-bottom: 12px; border-color: rgba(255,255,255,0.08);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid var(--line-soft); padding-bottom: 6px;">
              <h3 style="margin:0; font-size: 13px; color: #fff;">${esc(sec.title)}</h3>
              <span class="badge" style="font-size: 9px; padding: 1px 5px;">${sec.items.length}</span>
            </div>
            <div>
              ${itemsHtml}
            </div>
          </div>
        `;
      }).join("");
    } else {
      briefHtml = `<div class="muted" style="padding: 20px; text-align: center;">No active issues flagged by Piper.</div>`;
    }

    view.innerHTML = `
      <div style="background: linear-gradient(135deg, rgba(79, 70, 229, 0.1), rgba(217, 70, 239, 0.05)); border: 1px solid var(--line); padding: 30px; border-radius: var(--radius); position: relative; overflow: hidden; margin-bottom: 24px;">
        <div style="position: absolute; inset: 0; background: radial-gradient(circle at 10% 20%, rgba(139, 92, 246, 0.15) 0%, transparent 50%); pointer-events: none;"></div>
        <div style="position: relative; z-index: 2;">
          <div style="font-size: 9px; font-weight: 900; letter-spacing: 0.18em; text-transform: uppercase; color: #a78bfa; margin-bottom: 6px;">✦ PIPELINE COMMAND CENTER</div>
          <h1 style="margin: 0 0 10px 0; font-size: 26px; line-height: 1.25; font-weight: 900; letter-spacing: -0.02em; color: #fff;">${esc(b?.headline || "Pipeline Operational")}</h1>
          <p style="margin: 0; color: var(--muted); font-size: 13px;">Data Source: <strong>${esc(s.dataSource)}</strong> · Integration: <strong>${esc(s.integration)}</strong></p>
        </div>
      </div>

      <h2>KPI Constellation</h2>
      <div class="cards" style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); margin-bottom: 28px;">
        ${card(state.opportunities.length, "Total Opportunities")}
        ${card(d.originalProvenance, "Original Provenance")}
        ${card(d.recoveredProvenance, "Recovered Provenance")}
        ${card(d.unresolvedProvenance, "Unresolved Provenance")}
        ${card(`${d.classificationCoverage.classified}/${d.classificationCoverage.total}`, "Classified")}
        ${card(d.staleOpportunities, "Stale")}
      </div>

      <div class="detail-grid" style="grid-template-columns: 1fr; gap: 20px; display: grid;">
        <div>
          <h2>Piper Priorities Queue</h2>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;">
            ${briefHtml}
          </div>
        </div>
        
        <div>
          <h2>Funnel stage breakdown</h2>
          <div class="panel">
            <div class="funnel-stage-container">
              ${Object.keys(stageCounts).map(stage => `
                <div class="funnel-stage-item">
                  <span class="funnel-stage-name">${esc(formatStage(stage))}</span>
                  <span class="funnel-stage-val">${stageCounts[stage]}</span>
                </div>
              `).join("")}
            </div>
          </div>
        </div>
      </div>
    `;
    view.querySelectorAll(".card, .funnel-stage-item").forEach(bindTiltEffect);
  }
  const card = (n, l) => `<div class="card"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;

  const KANBAN_COLUMNS = [
    { key: "intake", title: "Intake", stages: ["new_lead", "needs_review"], defaultStage: "new_lead" },
    { key: "qualifying", title: "Qualifying", stages: ["attempting_contact", "contacted", "qualified", "appointment_scheduled"], defaultStage: "attempting_contact" },
    { key: "evaluation", title: "Evaluation", stages: ["property_review", "strategy_development"], defaultStage: "property_review" },
    { key: "negotiation", title: "Negotiation", stages: ["offer_preparation", "offer_approval_required", "offer_presented", "negotiating"], defaultStage: "offer_preparation" },
    { key: "contracting", title: "Contracting", stages: ["under_contract", "due_diligence", "closing_scheduled"], defaultStage: "under_contract" },
    { key: "settle", title: "Archived & Settle", stages: ["closed", "nurture", "disqualified", "lost", "archived"], defaultStage: "closed" }
  ];

  function getColumnKey(stage) {
    const col = KANBAN_COLUMNS.find(c => c.stages.includes(stage));
    return col ? col.key : "intake";
  }

  function renderKanbanBoard(opps) {
    const groups = {};
    KANBAN_COLUMNS.forEach(c => { groups[c.key] = []; });
    opps.forEach(o => {
      const colKey = getColumnKey(o.stage);
      groups[colKey].push(o);
    });

    const columnsHtml = KANBAN_COLUMNS.map(col => {
      const cards = groups[col.key];
      const cardsHtml = cards.map(o => {
        const overrides = getOverrides(o.id);
        const arvVal = overrides.arv || 250000;
        const rehabVal = overrides.rehab || 50000;
        const feeVal = overrides.fee || 5000;
        const holdingVal = overrides.holding || 8000;
        const mao = Math.max(0, Math.round(arvVal * 0.75 - rehabVal - feeVal - holdingVal));
        
        return `
          <div class="board-card" draggable="true" data-opp-id="${esc(o.id)}" data-stage="${esc(o.stage)}">
            <div class="board-card-header">
              <span class="board-card-id"><a href="/opportunities/${esc(o.id)}" onclick="window.routeTo(event, '/opportunities/${esc(o.id)}')">${esc(o.id)}</a></span>
              <span class="board-card-badge prov-${esc(o.provenanceState)}">${esc(o.provenanceState)}</span>
            </div>
            <span class="board-card-address">${esc(o.property.address)}</span>
            <div class="board-card-sub">Seller: ${esc(o.sellerDisplayName)}</div>
            <div class="board-card-meta">
              <span class="board-card-badge" style="background: rgba(255,255,255,0.05); color: #fff; font-size: 8px;">${esc(formatStage(o.stage))}</span>
              <span style="font-family: var(--mono); font-size: 11px; font-weight: 700; color: #34d399;">${money(mao)}</span>
            </div>
          </div>
        `;
      }).join("");

      return `
        <div class="board-column" data-col-key="${esc(col.key)}">
          <div class="column-header">
            <span class="column-title">${esc(col.title)}</span>
            <span class="column-count">${cards.length}</span>
          </div>
          <div class="column-cards">
            ${cardsHtml || `<div class="muted" style="text-align: center; padding: 20px; font-size: 11px;">Drag here</div>`}
          </div>
        </div>
      `;
    }).join("");

    return `<div class="board-container">${columnsHtml}</div>`;
  }

  function wireKanbanDragAndDrop() {
    const cards = view.querySelectorAll(".board-card");
    const columns = view.querySelectorAll(".board-column");

    cards.forEach(card => {
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", card.dataset.oppId);
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
      });
    });

    columns.forEach(col => {
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("drag-over");
      });
      col.addEventListener("dragleave", () => {
        col.classList.remove("drag-over");
      });
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const oppId = e.dataTransfer.getData("text/plain");
        if (!oppId) return;

        const card = view.querySelector(`.board-card[data-opp-id="${oppId}"]`);
        if (!card) return;

        const originalStage = card.dataset.stage;
        const colKey = col.dataset.colKey;
        const targetCol = KANBAN_COLUMNS.find(c => c.key === colKey);
        if (!targetCol) return;

        const targetStage = targetCol.defaultStage;
        if (originalStage === targetStage) return;

        const currentStageLabel = formatStage(originalStage);
        const proposedStageLabel = formatStage(targetStage);
        
        const title = `Proposed stage change: ${currentStageLabel} → ${proposedStageLabel} [AWAITING APPROVAL]`;
        
        if (!confirm(`PIPELINE has no stage-change endpoint, so the record cannot be moved from here.\n\nRecord a proposed stage change as a Next Action instead?\n\n"${title}"`)) {
          return;
        }

        try {
          const res = await fetch("/api/v1/operator/next-actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ opportunityId: oppId, title }),
          });
          const body = await res.json();
          if (body.ok) {
            alert(`Stage change proposed: ${currentStageLabel} → ${proposedStageLabel}. Persisted as a Next Action waiting for approval.`);
            opportunities();
          } else {
            alert(`Could not save next action: ${body.error}`);
          }
        } catch {
          alert("Could not reach PIPELINE.");
        }
      });
    });
  }

  window.setViewMode = (mode) => {
    localStorage.setItem("pipeline_view_mode", mode);
    opportunities();
  };

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
    
    state.opportunities = body.data;
    
    const currentView = localStorage.getItem("pipeline_view_mode") || "board";
    const pg = body.meta.pagination;
    
    let viewHtml = `
      <div class="view-header-row">
        <div>
          <h1>Opportunities</h1>
          <p class="sub">${pg.total} record(s)${body.meta.demo ? " · DEMO DATA" : ""}</p>
        </div>
        <div class="toggle-group">
          <button class="toggle-btn ${currentView === 'board' ? 'active' : ''}" onclick="window.setViewMode('board')">Board</button>
          <button class="toggle-btn ${currentView === 'table' ? 'active' : ''}" onclick="window.setViewMode('table')">Table</button>
        </div>
      </div>
      ${filterBar(params)}
    `;
    
    if (state.opportunities.length === 0) {
      viewHtml += empty("No opportunities match these filters.");
    } else if (currentView === "table") {
      viewHtml += `
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
        </div>
      `;
    } else {
      viewHtml += renderKanbanBoard(state.opportunities);
    }
    
    view.innerHTML = viewHtml;

    view.querySelectorAll(".pager [data-page]").forEach((b) => b.addEventListener("click", () => {
      const p = new URLSearchParams(location.search); p.set("page", b.dataset.page); navigate("/opportunities?" + p.toString());
    }));
    wireFilters();
    if (currentView === "board") {
      wireKanbanDragAndDrop();
      view.querySelectorAll(".board-card").forEach(bindTiltEffect);
    }
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
    state.activeOpp = o;
    updatePiperContext();

    // Load Local overrides
    const overrides = getOverrides(o.id);
    const stageVal = o.stage || "new_lead";
    const arvVal = overrides.arv || 250000;
    const rehabVal = overrides.rehab || 50000;
    const feeVal = overrides.fee || 5000;
    const holdingVal = overrides.holding || 8000;
    const askingVal = overrides.askingPrice || 120000;

    // Calculate MAO
    const mao = Math.max(0, Math.round(arvVal * 0.75 - rehabVal - feeVal - holdingVal));
    const isWarning = askingVal > mao;

    // Underwriting Micro-chart logic
    const calcChartHtml = (arv, rehab, fee, holding, asking, maoLimit, warn) => {
      const totalARV = arv || 1;
      const maoThreshold = Math.min(100, Math.round((maoLimit / totalARV) * 100));
      const askingPct = Math.min(100, Math.round((asking / totalARV) * 100));
      return `
        <div style="margin-top: 20px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid rgba(255,255,255,0.03);">
          <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 6px;">
            <span>75% MAO Limit: <strong>${money(maoLimit)}</strong></span>
            <span>ARV Target: ${money(arv)}</span>
          </div>
          <div style="height: 8px; background: rgba(255,255,255,0.05); border-radius: 999px; overflow: hidden; position: relative;">
            <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${maoThreshold}%; background: linear-gradient(90deg, #7c3aed, #10b981); opacity: 0.85; border-radius: 999px;"></div>
            <div style="position: absolute; left: ${maoThreshold}%; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 6px #fff; z-index: 10;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 8px;">
            <span>Asking Price: ${money(asking)}</span>
            <span style="font-weight: 700; color: ${warn ? 'var(--bad)' : 'var(--ok)'};">
              ${warn ? `Exceeds MAO by ${money(asking - maoLimit)}` : `Under MAO by ${money(maoLimit - asking)}`}
            </span>
          </div>
          <div style="height: 4px; background: rgba(255,255,255,0.03); border-radius: 999px; overflow: hidden; margin-top: 4px;">
            <div style="height: 100%; width: ${askingPct}%; background: ${warn ? 'var(--bad)' : 'var(--ok)'}; border-radius: 999px; box-shadow: 0 0 6px ${warn ? 'var(--bad)' : 'var(--ok)'};"></div>
          </div>
        </div>
      `;
    };

    // Show authoritative Victor underwriting if available
    let victorHtml = "";
    if (o.underwriting) {
      const victorMao = Math.max(0, Math.round(o.underwriting.arv * 0.75 - o.underwriting.rehab - o.underwriting.fee - o.underwriting.holding));
      const victorWarning = o.underwriting.askingPrice > victorMao;
      victorHtml = `
        <div class="panel" style="border-left: 2px solid var(--accent); background: rgba(139, 92, 246, 0.02);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h2 style="margin:0;">Authoritative Underwriting (Victor)</h2>
            <span class="badge" style="background: var(--accent-sf); color: var(--accent); border-color: var(--accent);">Victor</span>
          </div>
          <dl class="kv">
            <dt>ARV Target</dt><dd>${money(o.underwriting.arv)}</dd>
            <dt>Estimated Rehab</dt><dd>${money(o.underwriting.rehab)}</dd>
            <dt>Wholesale Fee</dt><dd>${money(o.underwriting.fee)}</dd>
            <dt>Holding Costs</dt><dd>${money(o.underwriting.holding)}</dd>
            <dt>Asking Price</dt><dd>${money(o.underwriting.askingPrice)}</dd>
            <dt>Victor 75% MAO</dt><dd style="font-family: var(--mono); font-weight: 700; color: var(--ok); font-size: 15px;">${money(victorMao)}</dd>
          </dl>
          ${calcChartHtml(o.underwriting.arv, o.underwriting.rehab, o.underwriting.fee, o.underwriting.holding, o.underwriting.askingPrice, victorMao, victorWarning)}
        </div>
      `;
    }

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

          ${victorHtml}

          <!-- 75% Underwriting math calculator -->
          <div class="panel" style="border: 1px dashed rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.02);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h2 style="margin:0;">Operator Underwriting Scratchpad</h2>
              <span class="scratchpad-badge">Local Scratchpad</span>
            </div>
            <p class="scratchpad-note"><span>⚠</span><span>Local overrides exist only in this browser and do NOT affect the database or Victor's authoritative analysis.</span></p>
            <div class="calc-card" style="background: transparent; border: 0; padding: 0;">
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
                  <span>75% of ARV</span>
                </div>
                <div class="calc-output-row highlight">
                  <span>Maximum Allowable Offer (MAO)</span>
                  <span id="detail-mao-val" style="color: var(--ok);">${money(mao)}</span>
                </div>
              </div>

              <div id="detail-mao-alert" class="alert-box ${isWarning ? 'warn' : 'ok'}">
                ${isWarning ? 
                  `<strong>OFFER EXCEEDS 75% MAO:</strong> Current asking price is above standard institutional purchase limits. Offer must be reduced.` 
                  : `<strong>75% RULE SATISFIED:</strong> Purchase price falls within standard safety constraints.`
                }
              </div>

              ${calcChartHtml(arvVal, rehabVal, feeVal, holdingVal, askingVal, mao, isWarning)}
              
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
            <p class="scratchpad-note"><span>✓</span><span>Saved in PIPELINE. Checklist state is stored server-side and is visible to every operator.</span></p>
            <div class="checklist-box" id="detail-tasks-box">Loading…</div>
          </div>

          <!-- Next actions (server-backed) -->
          <div class="panel">
            <h2>Next Actions</h2>
            <p class="scratchpad-note"><span>✓</span><span>Saved in PIPELINE. Piper reads these when deciding what is stalled and what needs you.</span></p>
            <div id="detail-next-actions">Loading…</div>
          </div>

          <!-- Negotiation Logs -->
          <div class="panel">
            <h2>Seller Call Log &amp; Notes</h2>
            <p class="scratchpad-note"><span>✓</span><span>Saved in PIPELINE. Notes are stored server-side, append-only, and visible to every operator.</span></p>
            <form class="log-form" onsubmit="window.submitSellerLog(event, '${o.id}')">
              <input type="text" id="detail-log-input" placeholder="Type new seller update..." required />
              <button type="submit">Add Log</button>
            </form>
            <div class="logs-list" id="detail-logs-list">Loading…</div>
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

    renderChecklist(o.id);
    renderNotes(o.id);
    renderNextActions(o.id);
    view.querySelectorAll(".panel").forEach(bindTiltEffect);
  }

  /** Server-backed next actions for the open opportunity. */
  async function renderNextActions(oppId) {
    const host = document.getElementById("detail-next-actions");
    if (!host) return;
    try {
      const { nextActions } = await operatorGet("next-actions", oppId);
      const open = nextActions.filter((a) => a.status === "open");
      host.innerHTML = `
        <form class="log-form" onsubmit="window.submitNextAction(event, '${esc(oppId)}')">
          <input type="text" id="detail-action-input" placeholder="Add a next action..." required />
          <button type="submit">Add</button>
        </form>
        ${nextActions.length ? nextActions.map((a) => `
          <div class="task-item">
            <input type="checkbox" class="task-checkbox" ${a.status === "done" ? "checked" : ""}
                   onchange="window.completeNextAction('${esc(a.id)}','${esc(oppId)}',this.checked)" />
            <span class="task-text ${a.status === "done" ? "done" : ""}">${esc(a.title)}${a.dueDate ? ` <span class="muted">· due ${esc(a.dueDate)}</span>` : ""}</span>
          </div>`).join("") : `<div class="state">No next actions recorded.</div>`}
        ${open.length === 0 && nextActions.length ? `<div class="piper-reason">All actions complete — this record will read as stalled once it passes the inactivity threshold.</div>` : ""}`;
    } catch {
      host.innerHTML = `<div class="state error">Could not load next actions from PIPELINE.</div>`;
    }
  }

  window.submitNextAction = async (e, oppId) => {
    e.preventDefault();
    const input = document.getElementById("detail-action-input");
    if (!input || !input.value.trim()) return;
    const title = input.value.trim();
    input.value = "";
    try {
      await operatorPost("next-actions", { opportunityId: oppId, title });
      await renderNextActions(oppId);
    } catch (err) {
      input.value = title;
      alert(`Could not save the next action to PIPELINE (${err.message}).`);
    }
  };

  window.completeNextAction = async (id, oppId, checked) => {
    try {
      const res = await fetch(`/api/v1/operator/next-actions/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: checked ? "done" : "open" }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      await renderNextActions(oppId);
    } catch (err) {
      alert(`Could not update the next action (${err.message}).`);
      await renderNextActions(oppId);
    }
  };

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
    const anyLineage = cur.some((c) => c.classification && c.classification !== "NOT_RECORDED");
    view.innerHTML = `<h1>Classifications</h1><p class="sub">${cur.length} record(s)${meta.demo ? " · DEMO DATA" : ""}. Unresolved provenance is never auto-synthetic.</p>
      ${!anyLineage && cur.length ? `<div class="panel"><strong>Lineage is not recorded.</strong> REAL / SYNTHETIC / AMBIGUOUS is a determination about a source lead's lineage, and this database has no column storing it. The record classification and provenance columns below are read from stored values; lineage is shown as NOT RECORDED rather than inferred.</div>` : ""}
      ${cur.length ? tbl(["Opportunity", "Record classification", "Lineage", "Provenance", "Determined by", "Reason"], cur.map((c) => [linkOpp(c.opportunityId), badgeHtml(c.recordClassification), badgeHtml(c.classification), badgeHtml(c.provenanceState), esc(c.determinedBy || "—"), esc(c.reason)]), true) : empty("No classifications recorded.")}
      <h2>History (append-only)</h2>
      ${hist.length ? tbl(["Opportunity", "Prior", "New", "Determined by", "Reason", "At"], hist.map((h) => [linkOpp(h.opportunityId), esc(h.priorClassification || "—"), esc(h.newClassification), esc(h.determinedBy || "—"), esc(h.reason), esc((h.changedAt || "").slice(0, 10))]), true) : empty("No classification history recorded.")}`;
  }

  async function dataQuality() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const { data, meta } = await api("/api/v1/data-quality");
    view.innerHTML = `<h1>Data Quality</h1><p class="sub">${meta.demo ? "DEMO DATA" : `Live data · ${data.totalOpportunities} record(s)`}</p>
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

  // Interactive Underwriting math updates
  window.recalcMao = () => {
    const arv = Number(document.getElementById("detail-arv").value || 0);
    const rehab = Number(document.getElementById("detail-rehab").value || 0);
    const fee = Number(document.getElementById("detail-fee").value || 0);
    const holding = Number(document.getElementById("detail-holding").value || 0);
    const asking = Number(document.getElementById("detail-asking").value || 0);

    const newMao = Math.max(0, Math.round(arv * 0.75 - rehab - fee - holding));
    const isWarning = asking > newMao;

    const maoEl = document.getElementById("detail-mao-val");
    if (maoEl) maoEl.textContent = money(newMao);

    const alertEl = document.getElementById("detail-mao-alert");
    if (alertEl) {
      alertEl.className = `alert-box ${isWarning ? 'warn' : 'ok'}`;
      alertEl.innerHTML = isWarning ? 
        `<strong>OFFER EXCEEDS 75% MAO:</strong> Current asking price is above standard institutional purchase limits. Offer must be reduced.` 
        : `<strong>75% RULE SATISFIED:</strong> Purchase price falls within standard safety constraints.`;
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

    alert("Saved to this browser only. PIPELINE does not persist underwriting assumptions \u2014 the API is read-only.");
  };

  window.saveStageChange = (oppId) => {
    // Stage is owned by the systems of record. The browser-local override this
    // replaces silently outranked the server's stage in the list and in the
    // Overview funnel counts, so two operators saw different totals for the
    // same database. Recording a next action is the honest alternative.
    const select = document.getElementById("detail-stage-select");
    const target = select ? formatStage(select.value) : "another stage";
    const title = `Review stage placement — proposed: ${target}`;
    if (!confirm(`PIPELINE has no stage-change endpoint, so the record cannot be moved from here.\n\nRecord a next action instead?\n\n"${title}"`)) return;

    fetch("/api/v1/operator/next-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opportunityId: oppId, title }),
    })
      .then((r) => r.json())
      .then((b) => alert(b.ok
        ? "Saved as a next action in PIPELINE. The stage itself is unchanged."
        : `Could not save the next action (${b.error || "unknown error"}).`))
      .catch(() => alert("Could not reach PIPELINE to save the next action."));
  };

  window.toggleDetailTask = async (oppId, key, label, checked) => {
    try {
      await operatorPost("checklist", { opportunityId: oppId, key, label, checked });
      await renderChecklist(oppId);
    } catch (err) {
      alert(`Could not save checklist state to PIPELINE (${err.message}).`);
      await renderChecklist(oppId);
    }
  };

  window.submitSellerLog = async (e, oppId) => {
    e.preventDefault();
    const input = document.getElementById("detail-log-input");
    if (!input || !input.value.trim()) return;

    const text = input.value.trim();
    input.value = "";

    try {
      await operatorPost("notes", { opportunityId: oppId, body: text });
      await renderNotes(oppId);
    } catch (err) {
      input.value = text;
      alert(`Could not save the note to PIPELINE (${err.message}).`);
    }
  };

  // PIPER Co-pilot Widget Controls
  function initPiperWidget() {
    const toggle = document.getElementById("piper-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        piperDrawer.classList.toggle("hidden");
        const opened = !piperDrawer.classList.contains("hidden");
        // Brief on open, so Piper is already oriented before being asked.
        if (opened && !state.piperBriefLoaded) {
          state.piperBriefLoaded = true;
          loadPiperBrief();
        } else {
          renderPiperHistory();
        }
      });
    }

    if (piperChatForm) {
      piperChatForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = piperChatInput.value.trim();
        if (!text) return;
        piperChatInput.value = "";

        // Interrupt current work if busy
        const busyStates = ["retrieving", "generating", "running_tool", "awaiting_approval"];
        if (busyStates.includes(state.piperState)) {
          state.piperMessages = state.piperMessages.filter((m) => !m.pending);
          state.piperMessages.push({ sender: "system-interrupted", text: `[Interrupted: "${text}"]` });
          renderPiperHistory();
          await window.piperCancel();
        }

        state.piperMessages.push({ sender: "user", text });
        state.piperMessages.push({ sender: "bot", text: "Retrieving context...", pending: true });
        setPiperState("retrieving");
        renderPiperHistory();

        let reply;
        try {
          const res = await fetch("/api/v1/piper/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: text,
              threadId: state.piperThreadId || null,
              activeOpportunityId: state.activeOppId || null,
            }),
          });
          const body = await res.json();
          if (body.ok) {
            state.piperThreadId = body.data.threadId;
            state.piperRunId = body.data.runId;
            setPiperState(body.data.state, body.data.stateLabel);
            reply = renderPiperAnswer(body.data);
          } else {
            setPiperState("failed");
            reply = "I couldn't read PIPELINE state just now. Nothing was written.";
          }
        } catch {
          setPiperState("failed");
          reply = "I couldn't reach PIPELINE to answer that. Nothing was written.";
        }

        state.piperMessages = state.piperMessages.filter((m) => !m.pending);
        state.piperMessages.push({ sender: "bot", text: reply });
        renderPiperHistory();
      });
    }
  }

  /**
   * Reflects the run's real state. Busy states pulse; settled states don't, so
   * "is Piper working" is answerable at a glance. Stop appears only while there
   * is something to stop.
   */
  function setPiperState(runState, label) {
    state.piperState = runState;
    const chip = document.getElementById("piper-state-chip");
    const foot = document.getElementById("piper-state-note");
    const stop = document.getElementById("piper-stop");
    const canvas = document.getElementById("piper-canvas");
    const canvasTitle = document.getElementById("piper-canvas-title");
    const canvasDetails = document.getElementById("piper-canvas-details");
    const drawer = document.getElementById("piper-drawer");

    if (!chip) return;

    const busy = ["retrieving", "generating", "running_tool"].includes(runState);
    const cancellable = ["retrieving", "generating", "awaiting_approval"].includes(runState);

    chip.textContent = String(runState || "idle").replace(/_/g, " ");
    chip.className = `piper-state-chip s-${runState}${busy ? " pulsing" : ""}`;
    if (foot) foot.textContent = label || "";
    if (stop) stop.hidden = !cancellable;

    // Control background pulse & glow based on state
    if (drawer) {
      drawer.className = `piper-drawer state-${runState}`;
    }

    // Live Work Canvas control
    if (canvas && busy) {
      canvas.classList.remove("hidden");
      if (canvasTitle) {
        if (runState === "retrieving") canvasTitle.textContent = "Querying SQLite Context";
        else if (runState === "generating") canvasTitle.textContent = "Vertex AI Stream Active";
        else if (runState === "running_tool") canvasTitle.textContent = "Executing Database Mutator";
        else canvasTitle.textContent = "Piper Working";
      }
      if (canvasDetails) {
        canvasDetails.textContent = label || (runState === "retrieving" ? "Reading opportunity status & history..." : runState === "generating" ? "Generating response..." : "Executing tool call...");
      }
    } else if (canvas) {
      canvas.classList.add("hidden");
    }
  }

  window.piperCancel = async () => {
    if (!state.piperRunId) return;
    try {
      const res = await fetch("/api/v1/piper/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: state.piperRunId }),
      });
      const body = await res.json();
      setPiperState(body.ok ? "canceled" : state.piperState, body.ok ? body.data.stateLabel : undefined);
      if (body.ok) {
        state.piperMessages = state.piperMessages.filter((m) => !m.pending);
        state.piperMessages.push({ sender: "bot", text: "Canceled. Nothing was written." });
        renderPiperHistory();
      }
    } catch { /* the run settles server-side regardless */ }
  };

  /** Approve or decline a proposed action. The only path to a Piper write. */
  window.piperDecide = async (toolCallId, approve) => {
    try {
      const res = await fetch("/api/v1/piper/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId, approve }),
      });
      const body = await res.json();
      const text = body.ok
        ? (body.data.wrote ? "Written to PIPELINE." : "Declined. Nothing was written.")
        : `Could not complete that (${esc(body.error || "unknown")}). Nothing was written.`;
      setPiperState(body.ok ? (body.data.wrote ? "complete" : "complete") : "failed");
      state.piperMessages.push({ sender: "bot", text });
      renderPiperHistory();
    } catch {
      state.piperMessages.push({ sender: "bot", text: "Could not reach PIPELINE. Nothing was written." });
      renderPiperHistory();
    }
  };

  /** Renders a Piper answer plus the records it was derived from. */
  function renderPiperAnswer(data) {
    const items = (data.items || []).slice(0, 6).map((i) => {
      const link = i.opportunityId ? linkOpp(i.opportunityId) : "";
      const why = (i.reasons || []).map((r) => `<div class="piper-reason">${esc(r)}</div>`).join("");
      return `<div class="piper-item">${link} <span>${esc(i.label)}</span>${why}</div>`;
    }).join("");

    const caps = data.capabilities
      ? `<div class="piper-reason">Try: ${data.capabilities.slice(0, 5).map(esc).join(" · ")}</div>`
      : "";

    const proposal = data.proposal && data.proposal.kind === "create_next_action"
      ? `<div class="piper-item"><button type="button" onclick="piperConfirmAction('${esc(data.proposal.opportunityId)}', '${esc(data.proposal.title).replace(/'/g, "\\'")}')">Create this next action</button></div>`
      : "";

    // Model-proposed writes. Explicitly labelled as unwritten until approved,
    // so a recommendation can never read as an executed action.
    const approvals = (data.pendingApprovals || []).map((p) => `
      <div class="piper-item piper-approval">
        <div class="piper-approval-title">Proposed — nothing written yet</div>
        <div>${esc(p.summary)}</div>
        <div class="piper-approval-actions">
          <button type="button" onclick="piperDecide('${esc(p.id)}', true)">Approve &amp; write</button>
          <button type="button" class="ghost" onclick="piperDecide('${esc(p.id)}', false)">Decline</button>
        </div>
      </div>`).join("");

    return `${esc(data.answer)}${items}${approvals}${proposal}${caps}`;
  }

  window.piperConfirmAction = async (opportunityId, title) => {
    try {
      const res = await fetch("/api/v1/operator/next-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId, title }),
      });
      const body = await res.json();
      state.piperMessages.push({
        sender: "bot",
        text: body.ok
          ? `Recorded "${esc(title)}" as a next action on ${linkOpp(opportunityId)}. It is saved in PIPELINE, not this browser.`
          : `I couldn't save that (${esc(body.error || "unknown error")}).`,
      });
      renderPiperHistory();
    } catch {
      state.piperMessages.push({ sender: "bot", text: "I couldn't reach PIPELINE to save that." });
      renderPiperHistory();
    }
  };

  /** Reports the provider actually configured, including when there is none. */
  async function refreshPiperStatus() {
    try {
      const res = await fetch("/api/v1/piper/status");
      const body = await res.json();
      if (!body.ok) return;
      const p = body.data.provider;
      const el = document.getElementById("piper-provider");
      if (el) el.textContent = p.connected ? `model ${p.model}` : "model none";
      setPiperState(p.connected ? "idle" : "not_connected",
        p.connected ? "" : "No model provider is configured. Piper answers from stored PIPELINE state only.");
      const disc = document.getElementById("piper-disclosure");
      if (disc && !p.connected) {
        disc.textContent = "No language model is connected. Piper answers deterministically from stored PIPELINE state; actions are written only after you approve them.";
      }
    } catch { /* status is best-effort */ }
  }

  /** The operating brief, fetched from real state when the panel opens. */
  async function loadPiperBrief() {
    try {
      refreshPiperStatus();
      const res = await fetch("/api/v1/piper/brief");
      const body = await res.json();
      if (!body.ok) return;
      const b = body.data;

      const sections = b.sections.map((s) => `
        <div class="piper-brief-section">
          <div class="piper-brief-title">${esc(s.title)} <span>${s.items.length}</span></div>
          ${s.items.slice(0, 4).map((i) => `
            <div class="piper-item">
              ${i.opportunityId ? linkOpp(i.opportunityId) : ""} <span>${esc(i.label)}</span>
              ${(i.reasons || []).slice(0, 1).map((r) => `<div class="piper-reason">${esc(r)}</div>`).join("")}
            </div>`).join("")}
        </div>`).join("");

      state.piperMessages = [{
        sender: "bot",
        text: `<strong>${esc(b.headline)}</strong>${sections || `<div class="piper-reason">Nothing flagged across ${b.evidence.opportunitiesConsidered} record(s).</div>`}`,
      }];
      renderPiperHistory();
    } catch {
      /* brief is best-effort; the panel still works for questions */
    }
  }

  function renderPiperHistory() {
    if (!piperChatHistory) return;
    piperChatHistory.innerHTML = state.piperMessages.map(m => {
      let cls = m.sender;
      if (cls === 'bot') cls = 'bot';
      else if (cls === 'user') cls = 'user';
      else if (cls === 'system-interrupted') cls = 'system-interrupted';
      else cls = 'system';
      return `
        <div class="msg ${cls}">
          ${m.text}
        </div>
      `;
    }).join("");
    piperChatHistory.scrollTop = piperChatHistory.scrollHeight;
  }

  window.triggerPiperQuickAction = (action) => {
    let query = "";
    if (action === "analyze") query = "Explain the underwriting panel";
    else if (action === "verify") query = "Show provenance and classification";
    else if (action === "unresolved") query = "Which records are unresolved?";

    if (piperChatInput) {
      piperChatInput.value = query;
      piperChatForm.dispatchEvent(new Event("submit"));
    }
  };

  function updatePiperContext() {
    if (!piperContextText) return;
    const activeOppCard = document.getElementById("piper-active-deal-card");
    
    if (state.activeOppId) {
      const o = state.activeOpp || state.opportunities.find(x => x.id === state.activeOppId);
      const text = `focused on deal #${state.activeOppId.slice(0, 8)}`;
      piperContextText.textContent = text;
      
      if (o && activeOppCard) {
        const overrides = getOverrides(o.id);
        const arvVal = overrides.arv || 250000;
        const rehabVal = overrides.rehab || 50000;
        const feeVal = overrides.fee || 5000;
        const holdingVal = overrides.holding || 8000;
        const mao = Math.max(0, Math.round(arvVal * 0.75 - rehabVal - feeVal - holdingVal));
        
        activeOppCard.innerHTML = `
          <div class="active-deal-header">
            <span class="deal-icon">✦</span>
            <div class="deal-meta">
              <span class="deal-address">${esc(o.property.address)}</span>
              <span class="deal-apn">APN: ${esc(o.property.apn || "Unknown")}</span>
            </div>
          </div>
          <div class="active-deal-metrics">
            <div class="metric-mini">
              <span class="lbl">Stage</span>
              <span class="val stage-badge s-${esc(o.stage)}">${esc(formatStage(o.stage))}</span>
            </div>
            <div class="metric-mini">
              <span class="lbl">MAO (75%)</span>
              <span class="val">${money(mao)}</span>
            </div>
          </div>
        `;
        activeOppCard.classList.remove("hidden");
      } else if (activeOppCard) {
        activeOppCard.classList.add("hidden");
      }
    } else {
      piperContextText.textContent = `view ${location.pathname}`;
      if (activeOppCard) {
        activeOppCard.innerHTML = "";
        activeOppCard.classList.add("hidden");
      }
      state.activeOpp = null;
    }
  }

  // ---- helpers ----
  const linkOpp = (id) => `<a href="/opportunities/${esc(id)}" data-nav>${esc(id)}</a>`;
  // Class comes from a slug so unrecorded values ("NOT_RECORDED") fall through
  // to the neutral default badge instead of producing a broken class name.
  const badgeHtml = (v) => {
    const raw = v === null || v === undefined || v === "" ? "NOT_RECORDED" : String(v);
    const slug = raw.replace(/[^A-Za-z0-9_-]/g, "-");
    return `<span class="badge b-${esc(slug)}">${esc(raw.replace(/_/g, " "))}</span>`;
  };
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
