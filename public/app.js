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
      { sender: "bot", text: "I read stage, provenance, classification, and data-quality state from PIPELINE's read-only API. Ask about any opportunity, or open one and ask what its provenance actually shows." }
    ]
  };

  // Helper: Escape HTML
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Custom Modals
  window.showCustomConfirm = (message, title, onConfirm, onCancel) => {
    const backdrop = document.createElement("div");
    backdrop.className = "custom-modal-backdrop";
    
    const modal = document.createElement("div");
    modal.className = "custom-modal";
    modal.innerHTML = `
      <div class="custom-modal-header">${esc(title || "PIPELINE DECISION PORTAL")}</div>
      <div class="custom-modal-body">${message}</div>
      <div class="custom-modal-actions">
        <button class="primary" id="confirm-btn">Approve</button>
        <button class="secondary" id="cancel-btn">Decline</button>
      </div>
    `;
    
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    
    backdrop.querySelector("#confirm-btn").focus();
    
    backdrop.querySelector("#confirm-btn").addEventListener("click", () => {
      document.body.removeChild(backdrop);
      if (onConfirm) onConfirm();
    });
    
    backdrop.querySelector("#cancel-btn").addEventListener("click", () => {
      document.body.removeChild(backdrop);
      if (onCancel) onCancel();
    });
  };

  window.showCustomAlert = (message, title) => {
    const backdrop = document.createElement("div");
    backdrop.className = "custom-modal-backdrop";
    
    const modal = document.createElement("div");
    modal.className = "custom-modal";
    modal.innerHTML = `
      <div class="custom-modal-header">${esc(title || "SYSTEM NOTIFICATION")}</div>
      <div class="custom-modal-body">${message}</div>
      <div class="custom-modal-actions">
        <button class="primary" id="ok-btn">Acknowledge</button>
      </div>
    `;
    
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    
    backdrop.querySelector("#ok-btn").focus();
    
    backdrop.querySelector("#ok-btn").addEventListener("click", () => {
      document.body.removeChild(backdrop);
    });
  };

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
  const formatStage = (s) => stageLabels[s] || String(s || "any").replace(/_/g, " ");

  // Helper: Money Formatter
  const money = (val) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val || 0);

  // Helper: Badges
  const badge = (cls, val) => `<span class="badge b-${esc(val)}">${esc(val)}</span>`;
  const loading = () => {
    const path = location.pathname;
    const isDetail = path.match(/^\/opportunities\/([^/]+)$/);
    
    let skeletonHtml = '';
    if (path === "/" || path === "/index.html") {
      skeletonHtml = `
        <div class="skeleton-narrative-panel skeleton-pulse"></div>
        <div class="skeleton-bridge-grid" style="margin-top: 20px;">
          <div class="skeleton-main-col">
            <div class="skeleton-panel skeleton-pulse" style="height: 300px; margin-bottom: 20px;"></div>
            <div class="skeleton-panel skeleton-pulse" style="height: 250px;"></div>
          </div>
          <div class="skeleton-side-col">
            <div class="skeleton-panel skeleton-pulse" style="height: 200px; margin-bottom: 20px;"></div>
            <div class="skeleton-panel skeleton-pulse" style="height: 350px;"></div>
          </div>
        </div>
      `;
    } else if (path === "/opportunities") {
      skeletonHtml = `
        <div class="skeleton-header skeleton-pulse" style="height: 60px; margin-bottom: 20px; width: 300px;"></div>
        <div class="skeleton-filters skeleton-pulse" style="height: 50px; margin-bottom: 20px;"></div>
        <div class="skeleton-board">
          <div class="skeleton-column skeleton-pulse"></div>
          <div class="skeleton-column skeleton-pulse"></div>
          <div class="skeleton-column skeleton-pulse"></div>
          <div class="skeleton-column skeleton-pulse"></div>
          <div class="skeleton-column skeleton-pulse"></div>
          <div class="skeleton-column skeleton-pulse"></div>
        </div>
      `;
    } else if (isDetail) {
      skeletonHtml = `
        <div class="skeleton-hero skeleton-pulse" style="height: 120px; margin-bottom: 20px;"></div>
        <div class="skeleton-strip skeleton-pulse" style="height: 60px; margin-bottom: 20px;"></div>
        <div class="skeleton-deal-room-grid">
          <div class="skeleton-room-main">
            <div class="skeleton-panel skeleton-pulse" style="height: 200px; margin-bottom: 20px;"></div>
            <div class="skeleton-panel skeleton-pulse" style="height: 250px; margin-bottom: 20px;"></div>
          </div>
          <div class="skeleton-room-side">
            <div class="skeleton-panel skeleton-pulse" style="height: 300px; margin-bottom: 20px;"></div>
            <div class="skeleton-panel skeleton-pulse" style="height: 200px; margin-bottom: 20px;"></div>
          </div>
        </div>
      `;
    } else {
      skeletonHtml = `
        <div class="skeleton-header skeleton-pulse" style="height: 50px; margin-bottom: 20px; width: 250px;"></div>
        <div class="skeleton-panel skeleton-pulse" style="height: 400px;"></div>
      `;
    }
    view.innerHTML = `<div class="skeleton-container">${skeletonHtml}</div>`;
  };
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
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
      
      const tiltX = -(dy / yc) * 2.5;
      const tiltY = (dx / xc) * 2.5;
      
      element.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translateY(-2px)`;
      element.style.boxShadow = "0 8px 24px rgba(0,0,0,0.5)";
      element.style.borderColor = "rgba(0, 240, 255, 0.25)";
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
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    const [dq, sys, opps, briefRes] = await Promise.all([
      api("/api/v1/data-quality"),
      api("/api/v1/system/status"),
      api("/api/v1/opportunities?pageSize=100"),
      api(`/api/v1/piper/brief?excludeFixtures=${!showFixtures}`).catch(() => ({ ok: true, data: { headline: "Pipeline active", sections: [] } }))
    ]);
    const d = dq.data, s = sys.data, b = briefRes.data;
    
    const fixtureIds = new Set(opps.data.filter(o => o.isFixture).map(o => o.id));
    state.opportunities = showFixtures ? opps.data : opps.data.filter(o => !o.isFixture);

    const stageCounts = {};
    state.opportunities.forEach(o => {
      const actualStage = o.stage || "new_lead";
      stageCounts[actualStage] = (stageCounts[actualStage] || 0) + 1;
    });

    let filteredSections = b.sections || [];
    if (!showFixtures) {
      filteredSections = filteredSections.map(sec => ({
        ...sec,
        items: sec.items.filter(item => !item.opportunityId || !fixtureIds.has(item.opportunityId))
      })).filter(sec => sec.items.length > 0);
    }

    let narrativeParts = [];
    if (filteredSections) {
      for (const sec of filteredSections) {
        const count = sec.items.length;
        if (count > 0) {
          const t = sec.title;
          if (t === "Needs You") {
            narrativeParts.push(`${count} require(s) operator attention`);
          } else if (t === "Risk") {
            narrativeParts.push(`${count} flagged as risk`);
          } else if (t === "Stalled") {
            narrativeParts.push(`${count} stalled`);
          } else if (t === "Changed") {
            narrativeParts.push(`${count} updated recently`);
          } else if (t === "New") {
            narrativeParts.push(`${count} new arrival(s)`);
          } else if (t === "Next Actions") {
            narrativeParts.push(`${count} pending action(s)`);
          } else {
            narrativeParts.push(`${count} in ${esc(t.toLowerCase())}`);
          }
        }
      }
    }
    const narrativeText = narrativeParts.length 
      ? `Currently, ${narrativeParts.join(", ")}.` 
      : "All systems nominal.";

    view.innerHTML = `
      <!-- 1. Top Piper Operating Statement -->
      <div class="operating-narrative-panel">
        <div class="narrative-badge">✦ PIPER HEAD AGENT BRIEF</div>
        <div class="narrative-text">
          "${esc(b?.headline || "Pipeline Operational")}. ${narrativeText}"
        </div>
        <div class="narrative-meta">
          System mode: <span class="mode-tag">${esc(s.dataSource)}</span> · Handoff keys: <span class="mode-tag">${esc(s.handoff)}</span>
        </div>
      </div>

      <!-- 2. Asymmetric Columns -->
      <div class="bridge-grid">
        <!-- Main Column -->
        <div class="bridge-main-col">
          <div class="bridge-panel">
            <h2 class="bridge-section-header">Needs Attention / Priority Queue</h2>
            <div class="priority-list">
              ${filteredSections && filteredSections.length ? filteredSections.map(sec => `
                <div class="priority-group">
                  <div class="priority-group-title">${esc(sec.title)}</div>
                  ${sec.items.map(item => `
                    <div class="priority-row">
                      <div class="priority-row-left">
                        <a class="deal-link" href="/opportunities/${esc(item.opportunityId)}" onclick="window.routeTo(event, '/opportunities/${esc(item.opportunityId)}')">
                          ${esc(item.address || item.opportunityId)}
                        </a>
                        <div class="priority-meta-row">
                          ${(item.reasons || []).map(r => `<span class="reason-tag">${esc(r)}</span>`).join("")}
                        </div>
                      </div>
                      <div class="priority-row-right">
                        <span class="status-indicator-pill">needs review</span>
                      </div>
                    </div>
                  `).join("")}
                </div>
              `).join("") : `<div class="empty-state">No listings require attention. All systems nominal.</div>`}
            </div>
          </div>

          <div class="bridge-panel">
            <h2 class="bridge-section-header">Pipeline Pulse</h2>
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

        <!-- Sidebar Column -->
        <div class="bridge-side-col">
          <div class="bridge-panel telemetry-panel-compact">
            <h2 class="bridge-section-header">KPI Telemetry</h2>
            <div class="telemetry-grid">
              <div class="telemetry-item">
                <span class="telemetry-label">Total Listings</span>
                <span class="telemetry-value">${esc(state.opportunities.length)}</span>
              </div>
              <div class="telemetry-item">
                <span class="telemetry-label">Original Prov</span>
                <span class="telemetry-value">${esc(d.originalProvenance)}</span>
              </div>
              <div class="telemetry-item">
                <span class="telemetry-label">Recovered Prov</span>
                <span class="telemetry-value">${esc(d.recoveredProvenance)}</span>
              </div>
              <div class="telemetry-item">
                <span class="telemetry-label">Unresolved Prov</span>
                <span class="telemetry-value">${esc(d.unresolvedProvenance)}</span>
              </div>
              <div class="telemetry-item">
                <span class="telemetry-label">Stale Listings</span>
                <span class="telemetry-value warning-val">${esc(d.staleOpportunities)}</span>
              </div>
            </div>
          </div>

          <div class="bridge-panel">
            <h2 class="bridge-section-header">Active Opportunities</h2>
            <div class="active-deals-list">
              ${[...state.opportunities]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 5)
                .map(opp => `
                  <div class="active-deal-row">
                    <a class="active-deal-title" href="/opportunities/${esc(opp.id)}" onclick="window.routeTo(event, '/opportunities/${esc(opp.id)}')">
                      ${esc(opp.address)}
                    </a>
                    <div class="active-deal-meta">
                      <span class="stage-tag">${esc(formatStage(opp.stage))}</span>
                      <span class="date-tag">${esc(opp.updatedAt.slice(0, 10))}</span>
                    </div>
                  </div>
                `).join("")}
            </div>
          </div>
        </div>
      </div>
    `;
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
        
        let underwritingLabel = "";
        let underwritingClass = "underwriting-unavailable";
        if (o.underwriting) {
          if (o.underwriting.status === "insufficient_evidence" || o.underwriting.arv === null || o.underwriting.arv === undefined) {
            underwritingLabel = "Underwriting: Insufficient Evidence";
            underwritingClass = "underwriting-unavailable";
          } else {
            const arv = o.underwriting.arv || 0;
            const rehab = o.underwriting.rehab || 0;
            const fee = o.underwriting.fee || 5000;
            const holding = o.underwriting.holding || 8000;
            const victorMao = Math.max(0, Math.round(arv * 0.75 - rehab - fee - holding));
            underwritingLabel = `75% Rule Ref — Victor inputs: ${money(victorMao)}`;
            underwritingClass = "underwriting-victor";
          }
        } else if (overrides.arv) {
          const localMao = Math.max(0, Math.round(overrides.arv * 0.75 - (overrides.rehab || 0) - (overrides.fee || 0) - (overrides.holding || 0)));
          underwritingLabel = `Scratchpad MAO: ${money(localMao)}`;
          underwritingClass = "underwriting-scratchpad";
        } else {
          underwritingLabel = "Underwriting: unavailable";
        }

        const isHighPriority = o.provenanceState === "unresolved" || o.status === "stalled";
        const priorityClass = isHighPriority ? "board-card-priority-high" : "";

        return `
          <div class="board-card ${priorityClass}" draggable="true" data-opp-id="${esc(o.id)}" data-stage="${esc(o.stage)}">
            <div class="board-card-header">
              <span class="board-card-id"><a href="/opportunities/${esc(o.id)}" onclick="window.routeTo(event, '/opportunities/${esc(o.id)}')">${esc(o.id)}</a></span>
              <span class="board-card-badge prov-${esc(o.provenanceState)}">${esc(o.provenanceState)}</span>
            </div>
            
            <div class="board-card-body">
              <span class="board-card-address">${esc(o.property.address)}</span>
              <div class="board-card-sub">Seller: ${esc(o.sellerDisplayName)}</div>
            </div>

            <div class="board-card-footer">
              <span class="board-card-underwriting ${underwritingClass}">${esc(underwritingLabel)}</span>
              <span class="board-card-stage-pill">${esc(formatStage(o.stage))}</span>
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
        
        window.showCustomConfirm(
          `PIPELINE has no stage-change endpoint, so the record cannot be moved from here.<br/><br/>Record a proposed stage change as a Next Action instead?<br/><br/><strong>"${title}"</strong>`,
          "Proposed Stage Change Approval",
          async () => {
            try {
              const res = await fetch("/api/v1/operator/next-actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ opportunityId: oppId, title }),
              });
              const body = await res.json();
              if (body.ok) {
                window.showCustomAlert(`Stage change proposed: ${currentStageLabel} → ${proposedStageLabel}. Persisted as a Next Action waiting for approval.`, "Proposal Recorded");
                opportunities();
              } else {
                window.showCustomAlert(`Could not save next action: ${body.error}`, "Error Recording Proposal");
              }
            } catch {
              window.showCustomAlert("Could not reach PIPELINE.", "Network Error");
            }
          }
        );
      });
    });
  }

  window.setViewMode = (mode) => {
    localStorage.setItem("pipeline_view_mode", mode);
    opportunities();
  };

  window.toggleFixtures = (checked) => {
    localStorage.setItem("pipeline_show_fixtures", checked ? "true" : "false");
    opportunities();
  };

  async function opportunities() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const params = new URLSearchParams(location.search);
    const qs = new URLSearchParams();
    for (const k of ["stage", "provenanceState", "classification", "status", "page", "pageSize"]) if (params.get(k)) qs.set(k, params.get(k));
    const currentView = localStorage.getItem("pipeline_view_mode") || "board";
    if (currentView === "board" && !qs.has("pageSize")) {
      qs.set("pageSize", "100");
    }
    let body;
    try { body = await api("/api/v1/opportunities?" + qs.toString()); }
    catch (e) { return errorState("Could not load opportunities: " + e.message); }
    
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    state.opportunities = showFixtures ? body.data : body.data.filter(o => !o.isFixture);
    const pg = body.meta.pagination;
    const currentTotal = state.opportunities.length;
    
    let viewHtml = `
      <div class="view-header-row">
        <div>
          <h1>Opportunities</h1>
          <p class="sub">${currentTotal} record(s) active${!showFixtures && body.data.some(o => o.isFixture) ? " (demo fixtures hidden)" : ""}</p>
        </div>
        <div class="toggle-group" style="display:flex; align-items:center; gap:16px;">
          <label class="switch-label" style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; user-select:none;">
            <input type="checkbox" id="show-fixtures-checkbox" ${showFixtures ? 'checked' : ''} onchange="window.toggleFixtures(this.checked)">
            <span class="muted" style="font-weight: 500;">Show Demo Fixtures</span>
          </label>
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
      ${sel("classification", ["retail_listing", "wholesale_target", "investment_rehab", "land_hold", "disqualified", "unknown"])}
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
            <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${maoThreshold}%; background: linear-gradient(90deg, #00f0ff, #10b981); opacity: 0.85; border-radius: 999px;"></div>
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
      if (o.underwriting.status === "insufficient_evidence" || o.underwriting.arv === null || o.underwriting.arv === undefined) {
        victorHtml = `
          <div class="panel" style="border-left: 2px solid var(--accent); background: var(--accent-sf); margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h2 style="margin:0; font-size: 16px;">Victor / Deal Scout — Underwriting</h2>
              <span class="badge" style="background: rgba(255, 68, 68, 0.1); color: #ff4444; border-color: #ff4444;">Victor</span>
            </div>
            <div style="margin-bottom: 16px;">
              <strong style="color: #ff4444; display: block; font-size: 14px; margin-bottom: 4px;">INSUFFICIENT COMPARABLE EVIDENCE</strong>
              <span style="opacity: 0.7; font-size: 13px;">Rehab Cost: <span style="font-family: var(--mono);">REHAB NOT DETERMINED</span></span>
            </div>
            <dl class="kv" style="font-size: 13px; margin-bottom: 12px;">
              <dt>Comps Found</dt><dd>0 traceable comps</dd>
              <dt>Confidence</dt><dd>Low (0%)</dd>
              <dt>Limitations</dt><dd style="color: #ffb83d;">${esc(o.underwriting.limitations || "No local comps match coordinates.")}</dd>
              <dt>Analyzed At</dt><dd>${esc(o.underwriting.analyzedAt ? new Date(o.underwriting.analyzedAt).toLocaleString() : "N/A")}</dd>
            </dl>
            <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.06); margin: 12px 0;">
            <div style="font-size: 12px; opacity: 0.6; line-height: 1.4;">
              <strong>PIPELINE — 75% Rule Reference</strong><br>
              Reference math requires active ARV and Rehab inputs. Use the scratchpad below to test custom assumptions.
            </div>
          </div>
        `;
      } else {
        const arv = o.underwriting.arv || 0;
        const rehab = o.underwriting.rehab || 0;
        const fee = o.underwriting.fee || 5000;
        const holding = o.underwriting.holding || 8000;
        const victorMao = Math.max(0, Math.round(arv * 0.75 - rehab - fee - holding));
        const victorWarning = o.underwriting.askingPrice > victorMao;
        
        let compsHtml = "";
        if (o.underwriting.evidence && o.underwriting.evidence.comps && o.underwriting.evidence.comps.length) {
          compsHtml = `
            <div style="margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
              <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8;">Comparable Evidence</h4>
              <div style="display: flex; flex-direction: column; gap: 8px;">
                ${o.underwriting.evidence.comps.map(c => `
                  <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 4px; font-size: 12px;">
                    <div style="display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 2px;">
                      <span>${esc(c.address)}</span>
                      <span style="color: var(--accent); font-family: var(--mono);">${money(c.salePrice)}</span>
                    </div>
                    <div style="opacity: 0.6; display: flex; justify-content: space-between;">
                      <span>${c.beds || 3}b / ${c.baths || 2}ba · ${c.sqft || 1200} sqft</span>
                      <span>Distance: ${c.distance ? c.distance.toFixed(1) + ' mi' : 'N/A'}</span>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        }

        victorHtml = `
          <div class="panel" style="border-left: 2px solid var(--accent); background: var(--accent-sf); margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h2 style="margin:0; font-size: 16px;">Victor / Deal Scout — Underwriting</h2>
              <span class="badge" style="background: var(--accent-sf); color: var(--accent); border-color: var(--accent);">Victor</span>
            </div>
            <dl class="kv" style="font-size: 13px; margin-bottom: 12px;">
              <dt>ARV Target</dt><dd>${money(arv)}</dd>
              <dt>Estimated Rehab</dt><dd>${money(rehab)}</dd>
              <dt>Calculated MAO (75%)</dt><dd style="font-weight: 700; color: var(--ok); font-family: var(--mono);">${money(o.underwriting.mao || victorMao)}</dd>
              <dt>Confidence</dt><dd>${Math.round(o.underwriting.confidence * 100)}%</dd>
              <dt>Limitations</dt><dd style="color: #ffb83d;">${esc(o.underwriting.limitations || "None")}</dd>
              <dt>Analyzed At</dt><dd>${esc(o.underwriting.analyzedAt ? new Date(o.underwriting.analyzedAt).toLocaleString() : "N/A")}</dd>
            </dl>
            ${compsHtml}
            <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.06); margin: 12px 0;">
            <div style="font-size: 12px; margin-bottom: 8px; opacity: 0.8; font-weight: 600;">PIPELINE — 75% Rule Reference</div>
            ${calcChartHtml(arv, rehab, fee, holding, o.underwriting.askingPrice || 0, victorMao, victorWarning)}
          </div>
          let offersHtml = "";
    if (o.underwriting) {
      const hasOffer = o.offers && o.offers.length > 0;
      if (!hasOffer) {
        let recText = "";
        let recActionHtml = "";
        
        if (o.underwriting.status === "insufficient_evidence") {
          recText = "Hold. Insufficient comparable sales evidence is available for this property. Do not prepare an offer at this time.";
          recActionHtml = `<div style="color: #ff4444; font-weight: 600; font-size: 13px; margin-top: 8px;">HOLD / INSUFFICIENT EVIDENCE</div>`;
        } else {
          const compsCount = o.underwriting.evidence?.comps?.length;
          const compLabel = compsCount !== undefined ? `${compsCount} comps` : "Comparable count unavailable";
          recText = `High-confidence underwriting exists based on ${compLabel}.`;
          
          recActionHtml = `
            <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
              <button class="primary" style="background: var(--ok); border-color: var(--ok); color: #000; font-size: 12px; padding: 6px 12px; align-self: flex-start;" onclick="window.togglePrepareOfferForm()">Prepare Offer</button>
              
              <div id="prepare-offer-form" style="display: none; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; margin-top: 12px; width: 100%;">
                <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase;">Prepare Offer terms</h4>
                <div style="font-size: 12px; margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px;">
                  <div><strong>Victor Analysis (Victor MAO):</strong> ${money(o.underwriting.mao)}</div>
                  <div><strong>Piper Recommended Opening Price:</strong> ${money(Math.round(o.underwriting.mao))}</div>
                  <div class="muted" style="margin-top: 4px;">(Recommendation is based on Cash Purchase under standard 75% rule pricing guidelines)</div>
                </div>
                <div class="form-grid-compact">
                  <div class="form-group-compact">
                    <label>Proposed Purchase Price</label>
                    <input type="number" id="prep-price" value="${Math.round(o.underwriting.mao)}" />
                  </div>
                  <div class="form-group-compact">
                    <label>Strategy Type (Operator Default)</label>
                    <select id="prep-strategy" style="background:#111; color:#fff; border:1px solid #333; padding: 4px; border-radius: 4px;">
                      <option value="cash_purchase" selected>Cash Purchase</option>
                      <option value="assignment">Assignment</option>
                      <option value="novation">Novation</option>
                      <option value="seller_finance">Seller Finance</option>
                      <option value="subject_to">Subject To</option>
                      <option value="lease_option">Lease Option</option>
                      <option value="listing_referral">Listing Referral</option>
                      <option value="no_offer">No Offer</option>
                    </select>
                  </div>
                  <div class="form-group-compact">
                    <label>Earnest Money (Operator Default)</label>
                    <input type="number" id="prep-earnest" value="1000" />
                  </div>
                  <div class="form-group-compact">
                    <label>Inspection Days (Operator Default)</label>
                    <input type="number" id="prep-inspection" value="10" />
                  </div>
                  <div class="form-group-compact">
                    <label>Closing Days (Operator Default)</label>
                    <input type="number" id="prep-closing" value="30" />
                  </div>
                  <div class="form-group-compact" style="grid-column: span 2;">
                    <label>Contingencies</label>
                    <input type="text" id="prep-contingencies" style="width: 100%; background:#111; color:#fff; border: 1px solid #333; padding:4px;" value="Subject to satisfactory inspection of major systems" />
                  </div>
                  <div class="form-group-compact" style="grid-column: span 2;">
                    <label>Internal Notes</label>
                    <textarea id="prep-notes" style="width: 100%; height: 40px; background:#111; color:#fff; border: 1px solid #333; padding:4px; border-radius:4px;">Initial draft prepared by operator.</textarea>
                  </div>
                </div>
                <div style="margin-top: 12px; text-align: right; display: flex; gap: 8px; justify-content: flex-end;">
                  <button class="primary" style="font-size: 11px; padding: 4px 8px; background: var(--ok); color: #000; border-color: var(--ok);" onclick="window.submitPrepareOffer('${esc(o.id)}')">Submit Draft Offer</button>
                  <button style="font-size: 11px; padding: 4px 8px;" onclick="window.togglePrepareOfferForm(false)">Cancel</button>
                </div>
              </div>
            </div>
          `;
        }
 
        offersHtml = `
          <div class="panel" style="border-left: 2px solid var(--accent); background: var(--accent-sf); margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h2 style="margin:0; font-size: 16px;">Piper Recommendation</h2>
              <span class="badge" style="background: var(--accent-sf); color: var(--accent); border-color: var(--accent);">Piper</span>
            </div>
            <div style="font-size: 13px; margin-bottom: 12px; line-height: 1.4;">
              <strong>Recommendation:</strong> ${esc(recText)}
            </div>
            ${recActionHtml}
          </div>
        `;
      } else {
        const offer = o.offers[0];
        const activeVer = offer.versions.find(v => v.id === offer.activeVersionId) || offer.versions[0];
        
        let gateHtml = "";
        if (activeVer.versionStatus === "draft") {
          gateHtml = `
            <div style="margin-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
              <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8;">Operator Approval Gate</h4>
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="primary" style="background: var(--ok); border-color: var(--ok); color: #000; font-size: 12px; padding: 6px 12px;" onclick="window.decideOffer('${esc(o.id)}', '${esc(offer.id)}', 'approve')">Approve</button>
                <button class="primary" style="background: var(--accent); border-color: var(--accent); color: #000; font-size: 12px; padding: 6px 12px;" onclick="window.toggleModifyOfferForm()">Modify</button>
                <button class="primary" style="background: rgba(255, 68, 68, 0.2); border-color: #ff4444; color: #ff4444; font-size: 12px; padding: 6px 12px;" onclick="window.decideOffer('${esc(o.id)}', '${esc(offer.id)}', 'decline')">Decline</button>
                <button class="primary" style="background: rgba(255, 255, 255, 0.1); border-color: rgba(255,255,255,0.2); color: #fff; font-size: 12px; padding: 6px 12px;" onclick="window.decideOffer('${esc(o.id)}', '${esc(offer.id)}', 'hold')">Hold</button>
              </div>
            </div>
          `;
        } else {
          let statusColor = "var(--ok)";
          if (activeVer.versionStatus === "rejected") statusColor = "#ff4444";
          gateHtml = `
            <div style="margin-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; font-weight: 600; color: ${statusColor}; font-size: 13px;">
              Offer Status: ${activeVer.versionStatus.toUpperCase()}
            </div>
          `;
        }

        const modifyFormHtml = `
          <div id="modify-offer-form" style="display: none; margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase;">Modify Offer Terms</h4>
            <div class="form-grid-compact">
              <div class="form-group-compact">
                <label>Proposed Price</label>
                <input type="number" id="mod-price" value="${activeVer.purchasePrice}" />
              </div>
              <div class="form-group-compact">
                <label>Strategy Type</label>
                <select id="mod-strategy" style="background:#111; color:#fff; border:1px solid #333; padding: 4px; border-radius: 4px;">
                  <option value="cash_purchase" ${activeVer.strategyType === 'cash_purchase' ? 'selected' : ''}>Cash Purchase</option>
                  <option value="assignment" ${activeVer.strategyType === 'assignment' ? 'selected' : ''}>Assignment</option>
                  <option value="novation" ${activeVer.strategyType === 'novation' ? 'selected' : ''}>Novation</option>
                  <option value="seller_finance" ${activeVer.strategyType === 'seller_finance' ? 'selected' : ''}>Seller Finance</option>
                  <option value="subject_to" ${activeVer.strategyType === 'subject_to' ? 'selected' : ''}>Subject To</option>
                  <option value="lease_option" ${activeVer.strategyType === 'lease_option' ? 'selected' : ''}>Lease Option</option>
                  <option value="listing_referral" ${activeVer.strategyType === 'listing_referral' ? 'selected' : ''}>Listing Referral</option>
                  <option value="no_offer" ${activeVer.strategyType === 'no_offer' ? 'selected' : ''}>No Offer</option>
                </select>
              </div>
              <div class="form-group-compact">
                <label>Earnest Money</label>
                <input type="number" id="mod-earnest" value="${activeVer.earnestMoney}" />
              </div>
              <div class="form-group-compact">
                <label>Inspection Days</label>
                <input type="number" id="mod-inspection" value="${activeVer.inspectionDays}" />
              </div>
              <div class="form-group-compact">
                <label>Closing Days</label>
                <input type="number" id="mod-closing" value="${activeVer.closingDays}" />
              </div>
            </div>
            <div style="margin-top: 8px; text-align: right;">
              <button class="primary" style="font-size: 11px; padding: 4px 8px; background: var(--ok); color: #000;" onclick="window.submitModifyOffer('${esc(o.id)}', '${esc(offer.id)}')">Save New Version</button>
              <button style="font-size: 11px; padding: 4px 8px;" onclick="window.toggleModifyOfferForm()">Cancel</button>
            </div>
          </div>
        `;

        const historyHtml = `
          <div style="margin-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8;">Offer Version History</h4>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              ${offer.versions.map(v => `
                <div style="background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); padding: 6px; border-radius: 4px; font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <strong>v${v.versionNumber}</strong>: ${esc(v.strategyType.replace('_', ' '))} at <strong>${money(v.purchasePrice)}</strong>
                    <div style="font-size: 10px; opacity: 0.6;">By ${esc(v.createdBy)} on ${esc(new Date(v.createdAt).toLocaleDateString())}</div>
                  </div>
                  <span class="badge" style="font-size: 10px; padding: 2px 6px;">${esc(v.versionStatus.toUpperCase())}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;

        offersHtml = `
          <div class="panel" style="border-left: 2px solid var(--accent); background: var(--accent-sf); margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h2 style="margin:0; font-size: 16px;">Seller Offer: ${esc(offer.id)}</h2>
              <span class="badge" style="background: var(--accent-sf); color: var(--accent); border-color: var(--accent);">Active v${activeVer.versionNumber}</span>
            </div>
            <dl class="kv" style="font-size: 13px; margin-bottom: 12px;">
              <dt>Strategy</dt><dd>${esc(activeVer.strategyType.replace('_', ' '))}</dd>
              <dt>Purchase Price</dt><dd style="font-weight: 700; color: var(--ok); font-family: var(--mono);">${money(activeVer.purchasePrice)}</dd>
              <dt>Earnest Money</dt><dd>${money(activeVer.earnestMoney)}</dd>
              <dt>Inspection / Closing</dt><dd>${activeVer.inspectionDays} days / ${activeVer.closingDays} days</dd>
              <dt>Contingencies</dt><dd style="font-size: 11px;">${esc(JSON.parse(activeVer.contingenciesJson).join(', '))}</dd>
              <dt>Internal Notes</dt><dd style="font-style: italic; opacity: 0.8;">${esc(activeVer.internalNotes || "—")}</dd>
            </dl>
            <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 4px; font-size: 12px; margin-top: 12px;">
              <div style="font-weight: 600; margin-bottom: 4px; opacity: 0.8;">Victor Underwriting Snapshot</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px;">
                <span>ARV: ${money(activeVer.underwritingArvSnapshot)}</span>
                <span>Rehab: ${money(activeVer.underwritingRehabSnapshot)}</span>
                <span>MAO: ${money(activeVer.underwritingMaoSnapshot)}</span>
                <span>Confidence: ${Math.round(activeVer.underwritingConfidence * 100)}%</span>
              </div>
            </div>
            ${gateHtml}
            ${modifyFormHtml}
            ${historyHtml}
          </div>
        `;
      }
    }

    let heroImgUrl = "";
    let heroImgBadge = "";
    
    const meta = o.provenance?.metadata || {};
    const imgVerification = meta.imageVerification || {};

    if (meta.operatorPhotoUrl) {
      heroImgUrl = meta.operatorPhotoUrl;
      heroImgBadge = "OPERATOR PHOTO";
    } else if (meta.verifiedSourcePhotoUrl) {
      heroImgUrl = meta.verifiedSourcePhotoUrl;
      heroImgBadge = "SOURCE PHOTO";
    } else if (imgVerification.status === "GOOGLE_STREET_VIEW" && imgVerification.url) {
      heroImgUrl = imgVerification.url;
      heroImgBadge = "GOOGLE STREET VIEW";
    } else if (meta.googlePlaceImageUrl) {
      heroImgUrl = meta.googlePlaceImageUrl;
      heroImgBadge = "GOOGLE PLACE IMAGERY";
    } else if (o.isFixture && o.property && o.property.image) {
      heroImgUrl = o.property.image;
      heroImgBadge = "FIXTURE SOURCE PHOTO";
    }

    let heroImageHtml = "";
    if (heroImgUrl) {
      heroImageHtml = `
        <div class="deal-hero-image-wrap">
          <img class="deal-hero-img" src="${esc(heroImgUrl)}" alt="Property Image">
          <span class="deal-hero-img-badge">${esc(heroImgBadge)}</span>
        </div>
      `;
    } else {
      heroImageHtml = `
        <div class="deal-hero-image-wrap no-image">
          <svg class="deal-hero-empty-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 24px; height: 24px; opacity: 0.6; margin-bottom: 4px;">
            <path d="M3 9.5L12 4l9 5.5M19 8.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8.5m7 5.5v5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="deal-hero-empty-text">NO VERIFIED PROPERTY IMAGE</div>
        </div>
      `;
    }

    // Render columns
    view.innerHTML = `
      <p class="back-link"><a href="/opportunities" data-nav onclick="window.routeTo(event, '/opportunities')">← Back to Opportunities</a></p>
      
      <!-- Property Hero -->
      <div class="deal-hero" style="display: flex; gap: 24px; align-items: center;">
        ${heroImageHtml}
        <div class="deal-hero-main" style="flex: 1;">
          <div class="deal-hero-badge">${esc(o.id)}</div>
          <h1>${esc(o.property.address)}</h1>
          <div class="deal-hero-sub">
            Seller Contact: <strong>${esc(o.sellerDisplayName)}</strong> · Assigned Operator: <strong>${esc(o.assignedOperator)}</strong>
          </div>
        </div>
        <div class="deal-hero-actions">
          <div class="stage-control-group">
            <label for="detail-stage-select">Current Stage</label>
            <select id="detail-stage-select" onchange="window.saveStageChange('${o.id}')">
              ${["new_lead", "needs_review", "attempting_contact", "contacted", "qualified", "appointment_scheduled", "property_review", "strategy_development", "offer_preparation", "offer_approval_required", "offer_presented", "negotiating", "under_contract", "due_diligence", "closing_scheduled", "closed", "nurture", "disqualified", "lost", "archived"].map(st => `
                <option value="${st}" ${st === stageVal ? 'selected' : ''}>${esc(formatStage(st))}</option>
              `).join("")}
            </select>
          </div>
        </div>
      </div>

      <!-- Decision Strip -->
      <div class="decision-strip">
        <div class="decision-item">
          <span class="decision-label">Status</span>
          <span class="decision-val active-status">${esc(o.status)}</span>
        </div>
        <div class="decision-item">
          <span class="decision-label">Classification</span>
          <span class="decision-val">${badge("cls", o.classification)}</span>
        </div>
        <div class="decision-item">
          <span class="decision-label">Provenance State</span>
          <span class="decision-val">${badge("prov", o.provenance.state)}</span>
        </div>
        <div class="decision-item">
          <span class="decision-label">Underwriting Status</span>
          <span class="decision-val ${isWarning ? 'bad-val' : 'good-val'}">
            ${isWarning ? 'Exceeds MAO' : 'Under MAO'}
          </span>
        </div>
      </div>

      <!-- Split Columns -->
      <div class="deal-room-grid">
        <!-- Left Column: Deal Intelligence Canvas -->
        <div class="deal-room-main">
          <div class="bridge-panel">
            <h2 class="bridge-section-header">Acquisitions Checklist</h2>
            <div class="checklist-box" id="detail-tasks-box">Loading…</div>
          </div>

          <div class="bridge-panel">
            <h2 class="bridge-section-header">Next Actions Queue</h2>
            <div id="detail-next-actions">Loading…</div>
          </div>

          <div class="bridge-panel">
            <h2 class="bridge-section-header">Call Logs & Notes</h2>
            <form class="log-form" onsubmit="window.submitSellerLog(event, '${o.id}')">
              <input type="text" id="detail-log-input" placeholder="Type new seller update..." required />
              <button type="submit">Add Log</button>
            </form>
            <div class="logs-list" id="detail-logs-list">Loading…</div>
          </div>
        </div>

        <!-- Right Column: Economics Desk & Evidence Canvas -->
        <div class="deal-room-side">
          <!-- Victor Underwriting -->
          ${victorHtml}
          ${offersHtml}

          <!-- Operator Scratchpad -->
          <div class="bridge-panel scratchpad-panel">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 8px;">
              <h2 style="margin:0; font-size: 14px;">Operator Underwriting Scratchpad</h2>
              <span class="scratchpad-badge">Local Only</span>
            </div>
            <div class="form-grid-compact">
              <div class="form-group-compact">
                <label>ARV Target</label>
                <input type="number" id="detail-arv" value="${arvVal}" oninput="window.recalcMao()" />
              </div>
              <div class="form-group-compact">
                <label>Est Rehab</label>
                <input type="number" id="detail-rehab" value="${rehabVal}" oninput="window.recalcMao()" />
              </div>
              <div class="form-group-compact">
                <label>Fee</label>
                <input type="number" id="detail-fee" value="${feeVal}" oninput="window.recalcMao()" />
              </div>
              <div class="form-group-compact">
                <label>Holding</label>
                <input type="number" id="detail-holding" value="${holdingVal}" oninput="window.recalcMao()" />
              </div>
              <div class="form-group-compact">
                <label>Asking Price</label>
                <input type="number" id="detail-asking" value="${askingVal}" oninput="window.recalcMao()" />
              </div>
            </div>

            <div class="calc-output-compact">
              <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                <span>Maximum Allowable Offer:</span>
                <strong id="detail-mao-val" style="color: var(--ok); font-family: var(--mono);">${money(mao)}</strong>
              </div>
              <div id="detail-mao-alert" class="alert-box-compact ${isWarning ? 'warn' : 'ok'}">
                ${isWarning ? 'Exceeds standard 75% MAO threshold' : '75% purchase rule satisfied'}
              </div>
            </div>

            ${calcChartHtml(arvVal, rehabVal, feeVal, holdingVal, askingVal, mao, isWarning)}

            <div style="margin-top: 14px; text-align: right;">
              <button class="primary" onclick="window.saveDetailUnderwriting('${o.id}')">Save Local Assumptions</button>
            </div>
          </div>

          <!-- Evidence & Provenance Canvas -->
          <div class="bridge-panel">
            <h2 class="bridge-section-header">Provenance & Evidence</h2>
            <dl class="kv-compact">
              <dt>Message ID</dt><dd class="code-val">${esc(o.provenance.resolvedSourceMessageId || "unresolved")}</dd>
              <dt>Original Source</dt><dd class="code-val">${esc(o.provenance.originalSourceMessageId || "—")}</dd>
              <dt>Recovered Source</dt><dd class="code-val">${esc(o.provenance.recoveredSourceMessageId || "—")}</dd>
              <dt>Method</dt><dd>${esc(o.provenance.recoveryMethod || "—")}</dd>
              <dt>Confidence</dt><dd>${esc(o.provenance.recoveryConfidence || "—")}</dd>
            </dl>
          </div>

          <!-- Historical timeline / Offers -->
          <div class="bridge-panel">
            <h2 class="bridge-section-header">Stage History</h2>
            ${o.stageTimeline.length ? `
              <div class="timeline-compact">
                ${o.stageTimeline.map(s => `
                  <div class="timeline-row">
                    <span class="timeline-time">${esc((s.at || "").slice(0, 10))}</span>
                    <span class="timeline-desc"><strong>${esc(formatStage(s.stage))}</strong> by ${esc(s.changedBy)}</span>
                  </div>
                `).join("")}
              </div>
            ` : `<div class="empty-state">No events.</div>`}
          </div>
        </div>
      </div>
    `;

    renderChecklist(o.id);
    renderNotes(o.id);
    renderNextActions(o.id);
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
      window.showCustomAlert(`Could not save the next action to PIPELINE (${err.message}).`, "Action Save Failed");
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
      window.showCustomAlert(`Could not update the next action (${err.message}).`, "Action Update Failed");
      await renderNextActions(oppId);
    }
  };

  async function provenance() {
    loading();
    state.activeOppId = null;
    updatePiperContext();
    const { data, meta } = await api("/api/v1/provenance");
    view.innerHTML = `<h1>Provenance</h1><p class="sub">${data.length} source(s)${meta.demo ? " · DEMO DATA" : ""}.</p>
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
    
    view.innerHTML = `<h1>Classifications</h1><p class="sub">${cur.length} record(s)${meta.demo ? " · DEMO DATA" : ""}.</p>
      ${cur.length ? tbl(
        ["Opportunity", "Current Classification", "Provenance State", "Determined by", "Reason"], 
        cur.map((c) => [
          linkOpp(c.opportunityId), 
          badgeHtml(c.recordClassification || "NOT RECORDED"), 
          badgeHtml(c.provenanceState), 
          esc(c.determinedBy || "—"), 
          esc(c.reason)
        ]), 
        true
      ) : empty("No classifications recorded.")}
      <h2>History (append-only)</h2>
      ${hist.length ? tbl(
        ["Opportunity", "Prior Classification", "New Classification", "Determined by", "Reason", "At"], 
        hist.map((h) => [
          linkOpp(h.opportunityId), 
          badgeHtml(h.priorClassification || "NOT RECORDED"), 
          badgeHtml(h.newClassification || "NOT RECORDED"), 
          esc(h.determinedBy || "—"), 
          esc(h.reason), 
          esc((h.changedAt || "").slice(0, 10))
        ]), 
        true
      ) : empty("No classification history recorded.")}`;
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

    window.showCustomAlert("Saved to this browser only. PIPELINE does not persist underwriting assumptions \u2014 the API is read-only.", "Local Underwriting Saved");
  };

  window.prepareOffer = async (oppId) => {
    window.togglePrepareOfferForm(true);
  };

  window.togglePrepareOfferForm = (forceOpen) => {
    const el = document.getElementById("prepare-offer-form");
    if (el) {
      if (forceOpen === true) {
        el.style.display = "block";
      } else if (forceOpen === false) {
        el.style.display = "none";
      } else {
        el.style.display = el.style.display === "none" ? "block" : "none";
      }
    }
  };

  window.submitPrepareOffer = async (oppId) => {
    const price = Number(document.getElementById("prep-price").value || 0);
    const strategyType = document.getElementById("prep-strategy").value;
    const earnestMoney = Number(document.getElementById("prep-earnest").value || 0);
    const inspectionDays = Number(document.getElementById("prep-inspection").value || 0);
    const closingDays = Number(document.getElementById("prep-closing").value || 0);
    const contingencies = JSON.stringify([document.getElementById("prep-contingencies").value]);
    const internalNotes = document.getElementById("prep-notes").value;

    try {
      const res = await fetch("/api/v1/operator/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opportunityId: oppId,
          proposedPrice: price,
          strategyType,
          earnestMoney,
          inspectionDays,
          closingDays,
          contingencies,
          internalNotes
        })
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      window.showCustomAlert("Offer draft created successfully.", "Offer Prepared");
      await loadOpportunity(oppId);
    } catch (err) {
      window.showCustomAlert(`Could not prepare offer (${err.message}).`, "Preparation Failed");
    }
  };

  window.toggleModifyOfferForm = () => {
    const el = document.getElementById("modify-offer-form");
    if (el) {
      el.style.display = el.style.display === "none" ? "block" : "none";
    }
  };

  window.submitModifyOffer = async (oppId, offerId) => {
    const price = Number(document.getElementById("mod-price").value || 0);
    const strategyType = document.getElementById("mod-strategy").value;
    const earnestMoney = Number(document.getElementById("mod-earnest").value || 0);
    const inspectionDays = Number(document.getElementById("mod-inspection").value || 0);
    const closingDays = Number(document.getElementById("mod-closing").value || 0);
    
    try {
      const res = await fetch(`/api/v1/operator/offers/${encodeURIComponent(offerId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "modify",
          proposedPrice: price,
          strategyType,
          earnestMoney,
          inspectionDays,
          closingDays
        })
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      window.showCustomAlert("Offer draft modified, new version created.", "Offer Modified");
      await loadOpportunity(oppId);
    } catch (err) {
      window.showCustomAlert(`Could not modify offer (${err.message}).`, "Modification Failed");
    }
  };

  window.decideOffer = async (oppId, offerId, action) => {
    try {
      const res = await fetch(`/api/v1/operator/offers/${encodeURIComponent(offerId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      window.showCustomAlert(`Offer status updated to ${action.toUpperCase()}.`, "Offer Decision Saved");
      await loadOpportunity(oppId);
    } catch (err) {
      window.showCustomAlert(`Could not save offer decision (${err.message}).`, "Decision Failed");
    }
  };

  window.saveStageChange = (oppId) => {
    // Stage is owned by the systems of record. The browser-local override this
    // replaces silently outranked the server's stage in the list and in the
    // Overview funnel counts, so two operators saw different totals for the
    // same database. Recording a next action is the honest alternative.
    const select = document.getElementById("detail-stage-select");
    const target = select ? formatStage(select.value) : "another stage";
    const title = `Review stage placement — proposed: ${target}`;
    window.showCustomConfirm(
      `PIPELINE has no stage-change endpoint, so the record cannot be moved from here.<br/><br/>Record a Next Action instead?<br/><br/><strong>"${title}"</strong>`,
      "Stage Mutation Gated",
      () => {
        fetch("/api/v1/operator/next-actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opportunityId: oppId, title }),
        })
          .then((r) => r.json())
          .then((b) => {
            if (b.ok) {
              window.showCustomAlert("Saved as a next action in PIPELINE. The stage itself is unchanged.", "Next Action Saved");
            } else {
              window.showCustomAlert(`Could not save the next action (${b.error || "unknown error"}).`, "Error Saving Next Action");
            }
          })
          .catch(() => window.showCustomAlert("Could not reach PIPELINE to save the next action.", "Network Error"));
      }
    );
  };

  window.toggleDetailTask = async (oppId, key, label, checked) => {
    try {
      await operatorPost("checklist", { opportunityId: oppId, key, label, checked });
      await renderChecklist(oppId);
    } catch (err) {
      window.showCustomAlert(`Could not save checklist state to PIPELINE (${err.message}).`, "Checklist Error");
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
      window.showCustomAlert(`Could not save the note to PIPELINE (${err.message}).`, "Note Save Error");
    }
  };

  // PIPER Co-pilot Widget Controls
  function initPiperWidget() {
    const toggle = document.getElementById("piper-toggle");
    const collapseBtn = document.getElementById("piper-collapse-btn");
    const widget = document.getElementById("piper-widget");
    
    if (collapseBtn && widget) {
      const expandBtn = document.getElementById("piper-expand-btn");

      collapseBtn.addEventListener("click", () => {
        const collapsed = !widget.classList.contains("collapsed");
        if (collapsed) {
          widget.classList.remove("expanded");
          document.body.classList.remove("has-expanded-piper");
          widget.classList.add("collapsed");
          document.body.classList.add("has-collapsed-piper");
        } else {
          widget.classList.remove("collapsed");
          document.body.classList.remove("has-collapsed-piper");
          loadPiperBrief();
        }
        collapseBtn.textContent = collapsed ? "‹" : "›";
        localStorage.setItem("piper_collapsed", collapsed);
        localStorage.setItem("piper_expanded", "false");
      });

      if (expandBtn) {
        expandBtn.addEventListener("click", () => {
          const expanded = !widget.classList.contains("expanded");
          if (expanded) {
            widget.classList.remove("collapsed");
            document.body.classList.remove("has-collapsed-piper");
            widget.classList.add("expanded");
            document.body.classList.add("has-expanded-piper");
            collapseBtn.textContent = "›";
            loadPiperBrief();
          } else {
            widget.classList.remove("expanded");
            document.body.classList.remove("has-expanded-piper");
          }
          localStorage.setItem("piper_expanded", expanded);
          localStorage.setItem("piper_collapsed", "false");
        });
      }

      if (localStorage.getItem("piper_collapsed") === "true") {
        widget.classList.add("collapsed");
        document.body.classList.add("has-collapsed-piper");
        collapseBtn.textContent = "‹";
      } else if (localStorage.getItem("piper_expanded") === "true") {
        widget.classList.add("expanded");
        document.body.classList.add("has-expanded-piper");
        loadPiperBrief();
      } else {
        loadPiperBrief();
      }
      
      const statusDot = widget.querySelector(".status-dot");
      if (statusDot) {
        statusDot.addEventListener("click", () => {
          if (widget.classList.contains("collapsed")) {
            widget.classList.remove("collapsed");
            document.body.classList.remove("has-collapsed-piper");
            collapseBtn.textContent = "›";
            localStorage.setItem("piper_collapsed", "false");
            loadPiperBrief();
          }
        });
      }
    }

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
      const statusDot = drawer.querySelector(".status-dot");
      if (statusDot) {
        statusDot.className = "status-dot";
        if (busy) {
          statusDot.classList.add("active-work");
        } else if (runState === "awaiting_approval") {
          statusDot.classList.add("active-approval");
        } else if (["failed", "canceled", "not_connected"].includes(runState)) {
          statusDot.classList.add("active-error");
        } else {
          statusDot.classList.add("active-idle");
        }
      }
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

    let proposal = "";
    if (data.proposal) {
      if (data.proposal.kind === "create_next_action") {
        proposal = `<div class="piper-item"><button type="button" onclick="piperConfirmAction('${esc(data.proposal.opportunityId)}', '${esc(data.proposal.title).replace(/'/g, "\\'")}')">Create this next action</button></div>`;
      } else if (data.proposal.kind === "prepare_offer") {
        proposal = `<div class="piper-item"><button type="button" onclick="window.prepareOffer('${esc(data.proposal.opportunityId)}')">Prepare Offer Draft</button></div>`;
      } else if (data.proposal.kind === "modify_offer_price") {
        proposal = `<div class="piper-item"><button type="button" onclick="window.submitModifyOfferPrice('${esc(data.proposal.opportunityId)}', ${data.proposal.proposedPrice})">Modify Price to ${money(data.proposal.proposedPrice)}</button></div>`;
      }
    }

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

  window.submitModifyOfferPrice = async (oppId, price) => {
    try {
      const resOffers = await fetch(`/api/v1/operator/offers?opportunityId=${encodeURIComponent(oppId)}`);
      const bodyOffers = await resOffers.json();
      if (!bodyOffers.ok || !bodyOffers.data.offers || !bodyOffers.data.offers.length) {
        throw new Error("No active offer found to modify.");
      }
      const offerId = bodyOffers.data.offers[0].id;
      const res = await fetch(`/api/v1/operator/offers/${encodeURIComponent(offerId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "modify", proposedPrice: price })
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      window.showCustomAlert(`Offer price modified to ${money(price)}.`, "Offer Modified");
      
      state.piperMessages.push({
        sender: "bot",
        text: `Modified offer price to ${money(price)} on ${linkOpp(oppId)}. A new draft version has been created.`
      });
      renderPiperHistory();
      await loadOpportunity(oppId);
    } catch (err) {
      window.showCustomAlert(`Could not modify offer price (${err.message}).`, "Modification Failed");
    }
  };
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
      const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
      const res = await fetch(`/api/v1/piper/brief?excludeFixtures=${!showFixtures}`);
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
