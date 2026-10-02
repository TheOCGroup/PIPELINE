
  function executeWorkspaceDirective(d) {
    if (!d || !d.type) return;
    
    if (d.type === "highlight") {
      if (d.view === "opportunities" && location.pathname !== "/opportunities" && !location.pathname.startsWith("/opportunities/")) {
        navigate("/opportunities");
      }
      setTimeout(() => {
        highlightRecord(d.opportunityId);
      }, 150);
    } else if (d.type === "open_evidence" || d.type === "open_opportunity") {
      if (d.opportunityId) {
        if (location.pathname !== "/opportunities/" + encodeURIComponent(d.opportunityId)) {
          navigate("/opportunities/" + encodeURIComponent(d.opportunityId));
        }
        setTimeout(() => {
          const target = document.getElementById("detail-provenance-section") || document.getElementById("detail-hero");
          if (target) {
            target.classList.add("highlight-target");
            target.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 150);
      }
    } else if (d.type === "navigate_underwriting") {
      if (d.opportunityId) {
        if (location.pathname !== "/opportunities/" + encodeURIComponent(d.opportunityId)) {
          navigate("/opportunities/" + encodeURIComponent(d.opportunityId));
        }
        setTimeout(() => {
          const target = document.getElementById("detail-underwriting-section");
          if (target) {
            target.classList.add("highlight-target");
            target.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 150);
      }
    } else if (d.type === "navigate_classifications") {
      if (location.pathname !== "/classifications") {
        navigate("/classifications");
      }
      setTimeout(() => {
        if (d.filter && window.filterClassifications) {
          window.filterClassifications(d.filter);
        }
      }, 150);
    }
  }

  function highlightRecord(id) {
    if (!id) return;
    document.querySelectorAll(".highlight-target").forEach((el) => el.classList.remove("highlight-target"));
    const selector = `tr[data-opp-id="${id}"], .kanban-card[data-opp-id="${id}"], [data-opportunity-id="${id}"], tr:has(a[href*="${id}"]), .opp-card:has(a[href*="${id}"])`;
    const el = document.querySelector(selector);
    if (el) {
      el.classList.add("highlight-target");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  window.sendPiperPrompt = (text) => {
    const input = document.getElementById("piper-chat-input");
    const form = document.getElementById("piper-chat-form");
    if (input && form) {
      input.value = text;
      form.dispatchEvent(new Event("submit"));
    }
  };

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

  // Inline navigation helper used by anchor onclick handlers across views.
  window.routeTo = (event, path) => {
    if (event) event.preventDefault();
    navigate(path);
  };

  // Dashboard quick action: bring the Piper drawer into view and focus it.
  window.scrollToPiper = () => {
    const widget = document.getElementById("piper-widget");
    if (widget && widget.classList.contains("collapsed")) {
      widget.classList.remove("collapsed");
      document.body.classList.remove("has-collapsed-piper");
      try { localStorage.setItem("piper_collapsed", "false"); } catch { /* noop */ }
    }
    const drawer = document.getElementById("piper-drawer");
    if (drawer) drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const input = document.getElementById("piper-chat-input");
    if (input) input.focus({ preventScroll: true });
  };

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

  // ---- Founder-stage mapping layer (PIPER-FIRST simplification) ----
  // The backend keeps its detailed stage model; the founder sees 8 buckets.
  // Canonical mapping lives in src/founderStages.mjs — keep this copy in sync.
  const FOUNDER_STAGES = [
    { key: "new", label: "New" },
    { key: "contacted", label: "Contacted" },
    { key: "appointment", label: "Appointment" },
    { key: "offer", label: "Offer" },
    { key: "negotiating", label: "Negotiating" },
    { key: "under_contract", label: "Under Contract" },
    { key: "closed", label: "Closed" },
    { key: "dead", label: "Dead" },
  ];
  const STAGE_TO_FOUNDER = {
    new_lead: "new", needs_review: "new",
    attempting_contact: "contacted", contacted: "contacted", qualified: "contacted",
    appointment_scheduled: "appointment", property_review: "appointment",
    strategy_development: "offer", offer_preparation: "offer",
    offer_approval_required: "offer", offer_presented: "offer",
    negotiating: "negotiating",
    under_contract: "under_contract", due_diligence: "under_contract",
    closing_scheduled: "under_contract",
    closed: "closed",
    nurture: "dead", disqualified: "dead", lost: "dead", archived: "dead",
  };
  const FOUNDER_STAGE_DEFAULTS = {
    new: "new_lead", contacted: "attempting_contact",
    appointment: "appointment_scheduled", offer: "offer_preparation",
    negotiating: "negotiating", under_contract: "under_contract",
    closed: "closed", dead: "disqualified",
  };
  const toFounderStage = (s) => STAGE_TO_FOUNDER[s] || "new";
  const founderStageLabel = (k) => (FOUNDER_STAGES.find((x) => x.key === k) || {}).label || String(k || "new");

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
  //
  // Operator auth: production PIPELINE requires the founder-operator bearer on
  // every API call. The secret lives in sessionStorage (this tab only — never
  // localStorage, never in source) and is attached as a Bearer token.
  function authHeaders() {
    try {
      const s = sessionStorage.getItem("pipeline_operator_secret");
      return s ? { Authorization: "Bearer " + s } : {};
    } catch { return {}; }
  }

  function pfetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}), ...authHeaders() };
    return fetch(path, { ...opts, headers });
  }

  let operatorAuthBannerShown = false;
  function noteOperatorAuthRequired() {
    if (operatorAuthBannerShown) return;
    operatorAuthBannerShown = true;
    window.showCustomAlert(
      "PIPELINE requires operator access for this. Enter the founder-operator secret (stored in this tab only, never written to disk).",
      "Operator Access Required"
    );
  }

  window.setOperatorSecret = (secret) => {
    try { sessionStorage.setItem("pipeline_operator_secret", String(secret || "")); }
    catch { /* storage unavailable */ }
    operatorAuthBannerShown = false;
    render();
  };
  window.clearOperatorSecret = () => {
    try { sessionStorage.removeItem("pipeline_operator_secret"); } catch { /* noop */ }
    render();
  };
  window.hasOperatorSecret = () => {
    try { return !!sessionStorage.getItem("pipeline_operator_secret"); } catch { return false; }
  };

  async function api(path) {
    const res = await pfetch(path, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && body.error === "operator_auth_required") noteOperatorAuthRequired();
      const err = new Error(body.error ? `${res.status} ${body.error}` : `${res.status}`);
      err.code = body.error;
      throw err;
    }
    return body;
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
    const res = await pfetch(`/api/v1/operator/${resource}?opportunityId=${encodeURIComponent(oppId)}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "operator_read_failed");
    return body.data;
  }

  async function operatorPost(resource, payload) {
    const res = await pfetch(`/api/v1/operator/${resource}`, {
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

  // ============ PIPER-FIRST HOME ============
  // One screen: Piper input, Today briefing, 8-stage pipeline, 4 quick actions.
  async function overview() {
    loading();
    state.activeOppId = null;
    state.activeOpp = null;
    updatePiperContext();
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    const [briefRes, oppsRes] = await Promise.all([
      api(`/api/v1/piper/brief?excludeFixtures=${!showFixtures}`).catch(() => ({ ok: true, data: { headline: "Pipeline active", sections: [] } })),
      api("/api/v1/opportunities?pageSize=100").catch(() => ({ ok: true, data: [] })),
    ]);
    const b = briefRes.data || {};
    const opps = (oppsRes.data || []).filter((o) => showFixtures || !o.isFixture);
    state.opportunities = opps;

    const fixtureIds = new Set((oppsRes.data || []).filter((o) => o.isFixture).map((o) => o.id));
    let sections = (b.sections || []).map((sec) => ({
      ...sec,
      items: (sec.items || []).filter((item) => !item.opportunityId || !fixtureIds.has(item.opportunityId)),
    })).filter((sec) => (sec.items || []).length > 0);

    // Founder-friendly Today rows, in a stable order.
    const ROW_ORDER = ["Needs You", "Next Actions", "Risk", "Stalled", "Changed", "New"];
    const ROW_LABEL = {
      "Needs You": (n) => `${n} seller${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`,
      "Next Actions": (n) => `${n} follow-up${n === 1 ? "" : "s"}`,
      "Risk": (n) => `${n} at risk`,
      "Stalled": (n) => `${n} stalled`,
      "Changed": (n) => `${n} updated recently`,
      "New": (n) => `${n} new`,
    };
    const todayRows = sections
      .slice()
      .sort((a, c) => ROW_ORDER.indexOf(a.title) - ROW_ORDER.indexOf(c.title))
      .map((sec, i) => {
        const n = sec.items.length;
        const label = (ROW_LABEL[sec.title] || ((m) => `${m} in ${sec.title.toLowerCase()}`))(n);
        const items = sec.items.slice(0, 8).map((item) => `
          <a class="today-item-link" href="/opportunities/${esc(item.opportunityId)}" onclick="window.routeTo(event, '/opportunities/${esc(item.opportunityId)}')">
            ${esc(item.address || item.opportunityId)}
            <span class="today-item-reasons">${esc((item.reasons || []).slice(0, 2).join(" · "))}</span>
          </a>`).join("");
        const more = sec.items.length > 8 ? `<div class="muted" style="font-size:12px">+ ${sec.items.length - 8} more</div>` : "";
        return `
          <div class="today-row" data-today-row="${i}">
            <button class="today-row-main" data-today-toggle="${i}" aria-expanded="false">
              <span class="today-count">${n}</span>
              <span class="today-label">${esc(label)}</span>
              <span class="today-chevron" aria-hidden="true">›</span>
            </button>
            <div class="today-row-detail" id="today-detail-${i}" hidden>
              <div class="today-item-list">${items}${more}</div>
              <button class="linklike" data-today-ask="${esc(sec.title)}">Ask Piper to summarize</button>
            </div>
          </div>`;
      }).join("");

    const counts = {};
    FOUNDER_STAGES.forEach((s) => { counts[s.key] = 0; });
    opps.forEach((o) => { counts[toFounderStage(o.stage)] += 1; });
    const stageStrip = FOUNDER_STAGES.map((s) => `
      <button class="fstage" data-fstage="${s.key}" onclick="window.routeTo(event, '/opportunities?fstage=${s.key}')">
        <span class="fstage-count">${counts[s.key]}</span>
        <span class="fstage-label">${esc(s.label)}</span>
      </button>`).join("");

    view.innerHTML = `
      <div class="ph-home">
        <header class="ph-header">
          <div>
            <div class="ph-title">OCG PIPELINE</div>
            <div class="ph-sub">${esc(b.headline || "Your acquisitions, through Piper.")}</div>
          </div>
          <span class="ph-limited" title="Piper is answering from Pipeline data with its built-in tools. No language model is connected.">Piper limited</span>
        </header>

        <form class="ph-ask" id="ph-ask-form">
          <input id="ph-ask-input" type="text" autocomplete="off"
            placeholder="Ask Piper anything about your sellers or deals…" aria-label="Ask Piper" />
          <button type="submit" class="ph-ask-btn" aria-label="Ask Piper">▲</button>
        </form>
        <div class="ph-hints">
          <button class="ph-hint" data-hint="Who do I need to call today?">Who do I need to call today?</button>
          <button class="ph-hint" data-hint="What deals need my attention?">What deals need attention?</button>
          <button class="ph-hint" data-hint="What changed today?">What changed today?</button>
        </div>

        <section class="ph-panel" aria-label="Today">
          <h2 class="ph-panel-title">Today</h2>
          ${todayRows || `<div class="empty-state">Nothing needs attention. All quiet.</div>`}
        </section>

        <section class="ph-panel" aria-label="Pipeline">
          <h2 class="ph-panel-title">Pipeline</h2>
          <div class="fstage-strip">${stageStrip}</div>
        </section>

        <section class="ph-actions" aria-label="Quick actions">
          <button class="ph-action primary" onclick="window.openNewOpportunityModal()">＋ New Seller</button>
          <button class="ph-action" onclick="window.focusPiperHome()">Ask Piper</button>
          <button class="ph-action" onclick="window.routeTo(event, '/opportunities?focus=search')">Search</button>
          <button class="ph-action" onclick="window.routeTo(event, '/tasks')">Today&apos;s Follow-Ups</button>
        </section>
      </div>
    `;

    // Wire central Piper input -> the one shared Piper conversation.
    const form = document.getElementById("ph-ask-form");
    const input = document.getElementById("ph-ask-input");
    window.focusPiperHome = () => { if (input) input.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    if (form && input) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = input.value;
        input.value = "";
        openPiperDrawer();
        await window.submitPiperText(text);
      });
      view.querySelectorAll("[data-hint]").forEach((btn) => btn.addEventListener("click", async () => {
        openPiperDrawer();
        await window.submitPiperText(btn.getAttribute("data-hint"));
      }));
    }
    // Today rows: expand inline, or hand the section to Piper.
    view.querySelectorAll("[data-today-toggle]").forEach((btn) => btn.addEventListener("click", () => {
      const i = btn.getAttribute("data-today-toggle");
      const detail = document.getElementById("today-detail-" + i);
      const open = detail.hidden;
      detail.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }));
    view.querySelectorAll("[data-today-ask]").forEach((btn) => btn.addEventListener("click", async () => {
      openPiperDrawer();
      await window.submitPiperText("Summarize: " + btn.getAttribute("data-today-ask"));
    }));
  }

  // Opens the persistent Piper drawer if it is closed.
  function openPiperDrawer() {
    const drawer = document.getElementById("piper-drawer");
    if (drawer && drawer.classList.contains("hidden")) {
      document.getElementById("piper-toggle").click();
    }
  }


  // ============ PIPELINE (founder view) ============
  // Compact 8-stage visualization. No dense kanban, no data tables on mobile.
  async function opportunities() {
    loading();
    state.activeOppId = null;
    state.activeOpp = null;
    updatePiperContext();
    const params = new URLSearchParams(location.search);
    const fstage = params.get("fstage") || "";
    const q = (params.get("q") || "").trim();
    const focusSearch = params.get("focus") === "search";
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";

    let body;
    try { body = await api("/api/v1/opportunities?pageSize=100"); }
    catch (e) { return errorState("Could not load the pipeline: " + e.message); }
    let opps = (body.data || []).filter((o) => showFixtures || !o.isFixture);
    if (q) {
      const needle = q.toLowerCase();
      opps = opps.filter((o) => [o.sellerDisplayName, o.property && o.property.address, o.id]
        .some((h) => h && String(h).toLowerCase().includes(needle)));
    }
    const inStage = fstage && FOUNDER_STAGES.some((s) => s.key === fstage)
      ? opps.filter((o) => toFounderStage(o.stage) === fstage) : opps;
    state.opportunities = opps;

    const counts = {};
    FOUNDER_STAGES.forEach((s) => { counts[s.key] = 0; });
    opps.forEach((o) => { counts[toFounderStage(o.stage)] += 1; });

    const chips = FOUNDER_STAGES.map((s) => `
      <button class="fchip ${fstage === s.key ? "active" : ""}"
        onclick="window.routeTo(event, '/opportunities${q ? "?q=" + encodeURIComponent(q) + "&" : "?"}fstage=${s.key}')">
        ${esc(s.label)} · ${counts[s.key]}
      </button>`).join("");

    const groups = FOUNDER_STAGES.map((s) => {
      const members = inStage.filter((o) => toFounderStage(o.stage) === s.key)
        .sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
      if (!members.length) return "";
      const cards = members.map((o) => `
        <a class="pcard" href="/opportunities/${esc(o.id)}" onclick="window.routeTo(event, '/opportunities/${esc(o.id)}')">
          <span class="pcard-name">${esc(o.sellerDisplayName || "Unknown seller")}</span>
          <span class="pcard-prop">${esc((o.property && o.property.address) || "No property recorded")}</span>
          <span class="pcard-meta">${esc(founderStageLabel(toFounderStage(o.stage)))}${o.lastActivity ? " · " + esc(String(o.lastActivity).slice(0, 10)) : ""}</span>
        </a>`).join("");
      return `
        <section class="pgroup" aria-label="${esc(s.label)}">
          <h3 class="pgroup-title">${esc(s.label)} <span class="pgroup-count">${members.length}</span></h3>
          <div class="pgroup-cards">${cards}</div>
        </section>`;
    }).join("");

    view.innerHTML = `
      <div class="ph-pipeline">
        <header class="ph-header">
          <div>
            <div class="ph-title">Pipeline</div>
            <div class="ph-sub">${opps.length} seller${opps.length === 1 ? "" : "s"}${fstage ? " · " + esc(founderStageLabel(fstage)) : ""}${q ? ` · “${esc(q)}”` : ""}</div>
          </div>
          <button class="ph-action primary" onclick="window.openNewOpportunityModal()">＋ New Seller</button>
        </header>
        <form class="ph-search" id="ph-search-form">
          <input id="ph-search-input" type="search" placeholder="Search sellers, properties…" value="${esc(q)}" aria-label="Search pipeline" />
          ${q || fstage ? `<button type="button" class="linklike" onclick="window.routeTo(event, '/opportunities')">Clear</button>` : ""}
        </form>
        <div class="fchip-row">${chips}</div>
        ${groups || `<div class="empty-state">No sellers match.</div>`}
      </div>
    `;

    const form = document.getElementById("ph-search-form");
    const input = document.getElementById("ph-search-input");
    if (focusSearch && input) input.focus();
    if (form && input) {
      let t = null;
      input.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => {
          const v = input.value.trim();
          const p = new URLSearchParams();
          if (v) p.set("q", v);
          if (fstage) p.set("fstage", fstage);
          navigate("/opportunities" + (p.toString() ? "?" + p.toString() : ""));
        }, 450);
      });
      form.addEventListener("submit", (e) => e.preventDefault());
    }
  }

  // ============ PEOPLE ============
  // Simple seller directory derived from live opportunities.
  async function people() {
    loading();
    state.activeOppId = null;
    state.activeOpp = null;
    updatePiperContext();
    const params = new URLSearchParams(location.search);
    const q = (params.get("q") || "").trim().toLowerCase();
    let body;
    try { body = await api("/api/v1/opportunities?pageSize=100"); }
    catch (e) { return errorState("Could not load sellers: " + e.message); }
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    let opps = (body.data || []).filter((o) => showFixtures || !o.isFixture);
    if (q) {
      opps = opps.filter((o) => [o.sellerDisplayName, o.property && o.property.address]
        .some((h) => h && String(h).toLowerCase().includes(q)));
    }
    opps.sort((a, b) => String(a.sellerDisplayName || "").localeCompare(String(b.sellerDisplayName || "")));
    const rows = opps.map((o) => {
      const phone = o.contact && o.contact.channel !== "email" ? o.contact.value : null;
      return `
      <a class="person-row" href="/opportunities/${esc(o.id)}" onclick="window.routeTo(event, '/opportunities/${esc(o.id)}')">
        <span class="person-name">${esc(o.sellerDisplayName || "Unknown seller")}</span>
        <span class="person-prop">${esc((o.property && o.property.address) || "No property recorded")}</span>
        <span class="person-meta">
          <span class="fstage-tag">${esc(founderStageLabel(toFounderStage(o.stage)))}</span>
          ${phone ? `<span class="person-phone">${esc(phone)}</span>` : ""}
        </span>
      </a>`;
    }).join("");

    view.innerHTML = `
      <div class="ph-people">
        <header class="ph-header">
          <div>
            <div class="ph-title">People</div>
            <div class="ph-sub">${opps.length} seller${opps.length === 1 ? "" : "s"}</div>
          </div>
        </header>
        <form class="ph-search" id="ph-people-search" onsubmit="return false;">
          <input id="ph-people-input" type="search" placeholder="Search sellers…" value="${esc(params.get("q") || "")}" aria-label="Search sellers" />
        </form>
        <div class="person-list">${rows || `<div class="empty-state">No sellers found.</div>`}</div>
      </div>
    `;
    const input = document.getElementById("ph-people-input");
    if (input) {
      let t = null;
      input.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => {
          const v = input.value.trim();
          navigate("/people" + (v ? "?q=" + encodeURIComponent(v) : ""));
        }, 450);
      });
    }
  }

  // ============ TASKS ============
  // Follow-ups and next actions across the pipeline, grouped by urgency.
  async function tasks() {
    loading();
    state.activeOppId = null;
    state.activeOpp = null;
    updatePiperContext();
    let items = [];
    try {
      const res = await operatorGet("next-actions", null);
      items = res.nextActions || res.data || [];
    } catch (e) { return errorState("Could not load follow-ups: " + e.message); }

    const today = new Date().toISOString().slice(0, 10);
    const open = items.filter((t) => (t.status || "open") !== "done");
    const done = items.filter((t) => (t.status || "open") === "done");
    const overdue = open.filter((t) => t.dueDate && String(t.dueDate).slice(0, 10) < today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const dueToday = open.filter((t) => t.dueDate && String(t.dueDate).slice(0, 10) === today);
    const upcoming = open.filter((t) => !t.dueDate || String(t.dueDate).slice(0, 10) > today)
      .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));

    const sellerName = (id) => {
      const o = (state.opportunities || []).find((x) => x.id === id);
      return o ? o.sellerDisplayName : null;
    };
    const row = (t) => `
      <div class="task-row">
        <div class="task-main">
          <span class="task-title">${esc(t.title || "Follow-up")}</span>
          ${t.opportunityId ? `<a class="task-seller" href="/opportunities/${esc(t.opportunityId)}" onclick="window.routeTo(event, '/opportunities/${esc(t.opportunityId)}')">${esc(sellerName(t.opportunityId) || "Open seller")}</a>` : ""}
          ${t.details ? `<div class="task-details">${esc(t.details)}</div>` : ""}
        </div>
        <div class="task-side">
          ${t.dueDate ? `<span class="task-due">${esc(String(t.dueDate).slice(0, 10))}</span>` : `<span class="task-due muted">no date</span>`}
          ${(t.status || "open") !== "done" ? `<button class="linklike" data-task-done="${esc(t.id)}">Done</button>` : ""}
        </div>
      </div>`;
    const group = (title, list) => list.length ? `
      <section class="ph-panel"><h2 class="ph-panel-title">${title} <span class="pgroup-count">${list.length}</span></h2>
      <div class="task-list">${list.map(row).join("")}</div></section>` : "";

    view.innerHTML = `
      <div class="ph-tasks">
        <header class="ph-header">
          <div>
            <div class="ph-title">Tasks</div>
            <div class="ph-sub">${open.length} open follow-up${open.length === 1 ? "" : "s"}</div>
          </div>
          <button class="ph-action" onclick="window.askPiperFor('What am I forgetting?')">Ask Piper</button>
        </header>
        ${group("Overdue", overdue)}
        ${group("Due today", dueToday)}
        ${group("Upcoming", upcoming)}
        ${group("Done", done.slice(0, 10))}
        ${!open.length ? `<div class="empty-state">No open follow-ups. Ask Piper “What am I forgetting?”</div>` : ""}
      </div>
    `;
    view.querySelectorAll("[data-task-done]").forEach((btn) => btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-task-done");
      try {
        await pfetch("/api/v1/operator/next-actions/" + encodeURIComponent(id), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });
        tasks();
      } catch { window.showCustomAlert("Could not mark done.", "Tasks"); }
    }));
  }

  // Ask Piper something from anywhere, opening the drawer first.
  window.askPiperFor = async (question) => {
    openPiperDrawer();
    await window.submitPiperText(question);
  };

  // ============ ADMIN (dev surface, out of the founder path) ============
  async function admin() {
    loading();
    state.activeOppId = null;
    state.activeOpp = null;
    updatePiperContext();
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    view.innerHTML = `
      <div class="ph-admin">
        <header class="ph-header">
          <div><div class="ph-title">Admin</div><div class="ph-sub">Developer and data tooling. Not part of the founder experience.</div></div>
        </header>
        <section class="ph-panel"><h2 class="ph-panel-title">Data &amp; system</h2>
          <div class="admin-links">
            <a href="/system" data-nav>System status</a>
            <a href="/data-quality" data-nav>Data quality</a>
            <a href="/provenance" data-nav>Provenance</a>
            <a href="/classifications" data-nav>Classifications</a>
          </div>
        </section>
        <section class="ph-panel"><h2 class="ph-panel-title">Demo fixtures</h2>
          <label class="switch-label"><input type="checkbox" id="admin-fixtures" ${showFixtures ? "checked" : ""} />
          <span>Show demo fixtures</span></label>
        </section>
      </div>
    `;
    const cb = document.getElementById("admin-fixtures");
    if (cb) cb.addEventListener("change", () => {
      localStorage.setItem("pipeline_show_fixtures", cb.checked ? "true" : "false");
    });
  }

  window.setViewMode = (mode) => { localStorage.setItem("pipeline_view_mode", mode); };
  window.toggleFixtures = (checked) => {
    localStorage.setItem("pipeline_show_fixtures", checked ? "true" : "false");
  };

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

    const stageVal = o.stage || "new_lead";
    // Operator assumptions live in PIPELINE (server), never the browser.
    let assumptions = null;
    try { ({ assumptions } = await operatorGet("underwriting", o.id)); } catch { assumptions = null; }
    const arvVal = assumptions?.arv ?? 0;
    const rehabVal = assumptions?.rehab ?? 0;
    const feeVal = assumptions?.fee ?? 0;
    const holdingVal = assumptions?.holding ?? 0;
    const askingVal = assumptions?.askingPrice ?? 0;
    const basisVal = assumptions?.basis ?? "";

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
        `;
      }
    }
          let offersHtml = "";
    // Offers need deal math: Victor underwriting or founder-recorded assumptions.
    const dealMath = o.underwriting || (assumptions && assumptions.mao != null
      ? { status: "completed", mao: assumptions.mao, arv: assumptions.arv, rehab: assumptions.rehab,
          evidence: { comps: [] }, operatorAssumption: true }
      : null);
    if (dealMath) {
      const hasOffer = o.offers && o.offers.length > 0;
      if (!hasOffer) {
        let recText = "";
        let recActionHtml = "";
        
        if (dealMath.status === "insufficient_evidence") {
          recText = "Hold. Insufficient comparable sales evidence is available for this property. Do not prepare an offer at this time.";
          recActionHtml = `<div style="color: #ff4444; font-weight: 600; font-size: 13px; margin-top: 8px;">HOLD / INSUFFICIENT EVIDENCE</div>`;
        } else if (dealMath.operatorAssumption) {
          recText = `Operator assumptions recorded (not Victor underwriting). MAO ${money(dealMath.mao)} is a working estimate — verify before presenting.`;
        } else {
          const compsCount = dealMath.evidence?.comps?.length;
          const compLabel = compsCount !== undefined ? `${compsCount} comps` : "Comparable count unavailable";
          recText = `High-confidence underwriting exists based on ${compLabel}.`;
          
          recActionHtml = `
            <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
              <button class="primary" style="background: var(--ok); border-color: var(--ok); color: #000; font-size: 12px; padding: 6px 12px; align-self: flex-start;" onclick="window.togglePrepareOfferForm()">Prepare Offer</button>
              
              <div id="prepare-offer-form" style="display: none; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; margin-top: 12px; width: 100%;">
                <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase;">Prepare Offer terms</h4>
                <div style="font-size: 12px; margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px;">
                  <div><strong>${dealMath.operatorAssumption ? "Operator Assumptions (working MAO)" : "Victor Analysis (Victor MAO)"}:</strong> ${money(dealMath.mao)}</div>
                  <div><strong>Piper Recommended Opening Price:</strong> ${money(Math.round(dealMath.mao))}</div>
                  <div class="muted" style="margin-top: 4px;">(Recommendation is based on Cash Purchase under standard 75% rule pricing guidelines)</div>
                </div>
                <div class="form-grid-compact">
                  <div class="form-group-compact">
                    <label>Proposed Purchase Price</label>
                    <input type="number" id="prep-price" value="${Math.round(dealMath.mao)}" />
                  </div>
                  <div class="form-group-compact">
                    <label>Strategy Type (Piper Suggested)</label>
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
                    <label>Earnest Money (Piper Suggested)</label>
                    <input type="number" id="prep-earnest" value="1000" />
                  </div>
                  <div class="form-group-compact">
                    <label>Inspection Days (Piper Suggested)</label>
                    <input type="number" id="prep-inspection" value="10" />
                  </div>
                  <div class="form-group-compact">
                    <label>Closing Days (Piper Suggested)</label>
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
              <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8;">Investment Committee</h4>
              <p class="muted" style="font-size: 11px; margin: 0 0 8px;">The committee rules engine reviews the active offer against underwriting. Approval is blocked until the latest review is <strong>approve</strong>.</p>
              <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                <button class="secondary" style="font-size: 12px; padding: 6px 12px;" onclick="window.runCommitteeReview('${esc(o.id)}')">Run Committee Review</button>
                <span id="committee-review-result" style="font-size: 12px;"></span>
              </div>
            </div>
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

    const outreachHtml = buildOutreachHtml(o);

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

    // ---- Priority: derived from the live Piper brief (CRM-grounded, not stored) ----
    let needsAttention = false;
    try {
      const br = await api("/api/v1/piper/brief?excludeFixtures=true").catch(() => null);
      const secs = (br && br.data && br.data.sections) || [];
      needsAttention = secs.some((s) => ["Needs You", "Risk"].includes(s.title) &&
        (s.items || []).some((it) => it.opportunityId === o.id));
    } catch { needsAttention = false; }

    const contact = o.contact || {};
    const sellerPhone = contact.channel && contact.channel !== "email" ? contact.value : null;
    const founderStage = toFounderStage(stageVal);

    // Render columns — PIPER-FIRST seller view
    view.innerHTML = `
      <p class="back-link"><a href="/opportunities" data-nav onclick="window.routeTo(event, '/opportunities')">← Back to Pipeline</a></p>

      <div class="seller-card">
        <div class="seller-top">
          <div class="seller-id">
            <h1 class="seller-name">${esc(o.sellerDisplayName || "Unknown seller")}</h1>
            <div class="seller-prop">${esc((o.property && o.property.address) || "No property recorded")}</div>
            <div class="seller-phone">${sellerPhone
              ? `<a href="tel:${esc(sellerPhone)}">${esc(sellerPhone)}</a>`
              : `<span class="muted">Phone not recorded</span>`}</div>
          </div>
          <span class="priority-pill ${needsAttention ? "high" : ""}">${needsAttention ? "Needs attention" : "Normal"}</span>
        </div>
        <div class="seller-stage-row">
          <label for="detail-stage-select">Stage</label>
          <select id="detail-stage-select" onchange="window.saveFounderStage('${o.id}')">
            ${FOUNDER_STAGES.map((s) => `
              <option value="${s.key}" ${s.key === founderStage ? "selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
        </div>
        <div class="seller-actions" role="group" aria-label="Seller actions">
          <button class="sact" onclick="window.piperCallSeller('${o.id}')">Call <span class="sact-tag">prep</span></button>
          <button class="sact" onclick="window.piperTextSeller('${o.id}')">Text <span class="sact-tag">draft</span></button>
          <button class="sact" onclick="window.focusSellerNote()">Add Note</button>
          <button class="sact" onclick="window.toggleFollowUpForm('${o.id}')">Follow Up</button>
          <button class="sact primary" onclick="window.scrollToOffer()">Offer</button>
        </div>
        <div class="followup-inline" id="followup-inline" hidden>
          <input type="text" id="followup-title" placeholder="Follow up about…" value="Follow up with ${esc(o.sellerDisplayName || "seller")}" />
          <input type="date" id="followup-date" />
          <div class="followup-inline-actions">
            <button class="primary" onclick="window.submitQuickFollowUp('${o.id}')">Save</button>
            <button class="linklike" onclick="window.toggleFollowUpForm()">Cancel</button>
          </div>
        </div>
      </div>

      <div class="piper-summary">
        <div class="piper-summary-head"><span class="piper-orb-mini" aria-hidden="true"></span><span>Piper summary</span></div>
        <div id="seller-piper-summary-body"><div class="state">Reading the record…</div></div>
      </div>

      <div class="num-strip">
        <div class="num"><span class="num-label">Asking</span><span class="num-val">${askingVal ? money(askingVal) : "not recorded"}</span></div>
        <div class="num"><span class="num-label">MAO</span><span class="num-val">${money(mao)}</span></div>
        <div class="num"><span class="num-label">ARV</span><span class="num-val">${arvVal ? money(arvVal) : "not recorded"}</span></div>
        <div class="num"><span class="num-label">Deal math</span><span class="num-val ${isWarning ? "bad" : "good"}">${isWarning ? "Over MAO" : "Within MAO"}</span></div>
      </div>

      <div class="ph-panel">
        <h2 class="ph-panel-title">Timeline</h2>
        <div id="detail-timeline"><div class="state">Loading timeline…</div></div>
      </div>

      <div class="ph-panel" id="seller-offers">
        <h2 class="ph-panel-title">Offers</h2>
        ${offersHtml || `<div class="empty-state">No offers recorded.</div>`}
      </div>

      <div class="ph-panel" id="seller-notes">
        <h2 class="ph-panel-title">Notes</h2>
        <form class="log-form" onsubmit="window.submitSellerLog(event, '${o.id}')">
          <input type="text" id="detail-log-input" placeholder="Add a note…" required />
          <button type="submit">Add Note</button>
        </form>
        <div class="logs-list" id="detail-logs-list">Loading…</div>
      </div>

      <details class="deal-tools">
        <summary>Deal tools</summary>
        <div class="ph-panel"><h2 class="ph-panel-title">Checklist</h2><div id="detail-tasks-box">Loading…</div></div>
        <div class="ph-panel"><h2 class="ph-panel-title">Follow-ups</h2><div id="detail-next-actions">Loading…</div></div>
        <div class="ph-panel">
          <h2 class="ph-panel-title">Working numbers</h2>
          <p class="muted" style="font-size:12px">Your working estimates (not Victor underwriting). Verify before presenting an offer.</p>
          <div class="form-grid-compact">
            <div class="form-group-compact"><label>ARV Target</label><input type="number" id="detail-arv" value="${arvVal}" oninput="window.recalcMao()" /></div>
            <div class="form-group-compact"><label>Est Rehab</label><input type="number" id="detail-rehab" value="${rehabVal}" oninput="window.recalcMao()" /></div>
            <div class="form-group-compact"><label>Fee</label><input type="number" id="detail-fee" value="${feeVal}" oninput="window.recalcMao()" /></div>
            <div class="form-group-compact"><label>Holding</label><input type="number" id="detail-holding" value="${holdingVal}" oninput="window.recalcMao()" /></div>
            <div class="form-group-compact"><label>Asking Price</label><input type="number" id="detail-asking" value="${askingVal}" oninput="window.recalcMao()" /></div>
          </div>
          <div class="calc-output-compact">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
              <span>Maximum Allowable Offer:</span>
              <strong id="detail-mao-val" style="color:var(--ok)">${money(mao)}</strong>
            </div>
            <div id="detail-mao-alert" class="alert-box-compact ${isWarning ? "warn" : "ok"}">
              ${isWarning ? "Exceeds standard 75% MAO threshold" : "75% purchase rule satisfied"}
            </div>
          </div>
          <div class="form-group-compact" style="margin-top:10px;"><label>Basis for these numbers</label>
            <input type="text" id="detail-basis" value="${esc(basisVal)}" placeholder="e.g. comp pull, contractor walk-through" /></div>
          <div style="margin-top:12px;text-align:right;">
            <button class="primary" onclick="window.saveDetailUnderwriting('${o.id}')">Save Assumptions</button>
          </div>
        </div>
        ${victorHtml}
        ${outreachHtml}
        <div class="ph-panel"><h2 class="ph-panel-title">Record</h2>
          <dl class="kv-compact">
            <dt>Source</dt><dd>${esc(o.provenance.state)}</dd>
            <dt>Recovery</dt><dd>${esc(o.provenance.recoveryMethod || "—")}</dd>
            <dt>Confidence</dt><dd>${esc(o.provenance.recoveryConfidence || "—")}</dd>
          </dl>
        </div>
      </details>
    `;

    renderChecklist(o.id);
    renderNotes(o.id);
    renderNextActions(o.id);
    renderTimeline(o.id);
    renderPiperSummary(o.id, { askingVal, mao, arvVal });
    renderChecklist(o.id);
    renderNotes(o.id);
    renderNextActions(o.id);
    renderTimeline(o.id);
  }

  /** Unified seller timeline: every recorded event for the seller, newest first. */
  const TIMELINE_LABELS = {
    lead_created: "Lead",
    stage_change: "Stage",
    note: "Note",
    follow_up: "Follow-up",
    offer: "Offer",
    checklist: "Checklist",
    call: "Call",
    text: "Text",
    email: "Email",
    interaction: "Activity",
    communication: "Draft",
    piper: "Piper",
  };
  const TIMELINE_ICONS = {
    lead_created: "✦", stage_change: "⇄", note: "✎", follow_up: "⏰",
    offer: "◈", checklist: "✓", call: "☎", text: "✉",
    email: "✉", interaction: "•", communication: "✉", piper: "⦿",
  };
  async function fetchTimelineEvents(oppId) {
    try {
      const { timeline } = await operatorGet("timeline", oppId);
      return (timeline && timeline.events) || [];
    } catch { return []; }
  }

  // Deterministic, CRM-grounded seller briefing. No LLM, no invention:
  // every sentence comes from the record, otherwise it says "not recorded".
  async function renderPiperSummary(oppId, nums) {
    const host = document.getElementById("seller-piper-summary-body");
    if (!host) return;
    const o = state.activeOpp;
    if (!o) { host.innerHTML = `<div class="empty-state">Record not loaded.</div>`; return; }
    try {
      const [events, naRes] = await Promise.all([
        fetchTimelineEvents(oppId),
        operatorGet("next-actions", oppId).catch(() => ({ nextActions: [] })),
      ]);
      const contactTypes = new Set(["call", "text", "email", "interaction", "communication", "note"]);
      const contacts = events.filter((e) => contactTypes.has(e.type) && e.at)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const lastContact = contacts.length ? String(contacts[0].at).slice(0, 10) : null;

      const offers = o.offers || [];
      let offerTxt = "No offers recorded.";
      if (offers.length) {
        const offer = offers[0];
        const v = (offer.versions || []).find((x) => x.id === offer.activeVersionId) || (offer.versions || [])[0];
        if (v) {
          offerTxt = `Latest offer ${money(v.purchasePrice)} (${String(v.strategyType || "offer").replace(/_/g, " ")})`
            + (v.createdAt ? ` on ${String(v.createdAt).slice(0, 10)}` : "") + ".";
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const open = ((naRes && naRes.nextActions) || []).filter((n) => (n.status || "open") !== "done")
        .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
      let fuTxt = "No follow-up scheduled.";
      if (open.length) {
        const d = String(open[0].dueDate || "").slice(0, 10);
        const overdue = d && d < today;
        fuTxt = `Next follow-up${d ? ` ${d}` : ""}${overdue ? " — overdue" : ""}: ${open[0].title || "follow up"}.`;
      }

      const seller = o.sellerDisplayName || "Unknown seller";
      const prop = (o.property && o.property.address) || "no property recorded";
      const fmtDate = (d) => {
        if (!d) return "not recorded";
        const dt = new Date(d + "T12:00:00");
        return isNaN(dt) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      };
      host.innerHTML = `
        <p class="piper-summary-text"><strong>${esc(seller)}</strong> · ${esc(prop)}.</p>
        <p class="piper-summary-text">Last contact ${fmtDate(lastContact)}. Asking ${nums.askingVal ? money(nums.askingVal) : "not recorded"}.</p>
        <p class="piper-summary-text">${esc(offerTxt)} Working MAO ${money(nums.mao)}.</p>
        <p class="piper-summary-text">${esc(fuTxt)}</p>`;
    } catch {
      host.innerHTML = `<div class="state error">Could not read the record.</div>`;
    }
  }

  // Founder picks one of 8 stages; the backend records the bucket's entry stage.
  // History is never rewritten — this is the same stage endpoint as before.
  window.saveFounderStage = async (oppId) => {
    const select = document.getElementById("detail-stage-select");
    const founderKey = select ? select.value : null;
    if (!founderKey || !FOUNDER_STAGE_DEFAULTS[founderKey]) return;
    const target = FOUNDER_STAGE_DEFAULTS[founderKey];
    const current = state.activeOpp ? state.activeOpp.stage : null;
    if (target === current) return;
    const closed = ["closed", "nurture", "disqualified", "lost", "archived"];
    let reason = null;
    if (closed.includes(current) && !closed.includes(target)) {
      reason = window.prompt("Reopening a closed record — reason (required):");
      if (!reason || !reason.trim()) { if (select) select.value = toFounderStage(current); return; }
    }
    try {
      const res = await pfetch(`/api/v1/opportunities/${encodeURIComponent(oppId)}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: target, reason }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || "stage_move_failed");
      window.showCustomAlert(`Stage moved to ${esc(founderStageLabel(founderKey))}.`, "Stage Updated");
      opportunityDetail(oppId);
    } catch (e) {
      window.showCustomAlert("Could not move stage: " + esc(e.message), "Stage Move Failed");
      if (select && current) select.value = toFounderStage(current);
    }
  };

  // Call / Text route through Piper's governed preparation tools.
  // prepare_call is plan-only and draft_sms is draft-only — Piper says so honestly.
  window.piperCallSeller = async (oppId) => {
    const o = state.activeOpp;
    const name = (o && o.sellerDisplayName) || "this seller";
    const prop = (o && o.property && o.property.address) || "";
    openPiperDrawer();
    await window.submitPiperText(`Prepare a call to ${name}${prop ? " about " + prop : ""}. Preparation only — do not dial.`);
  };
  window.piperTextSeller = async (oppId) => {
    const o = state.activeOpp;
    const name = (o && o.sellerDisplayName) || "this seller";
    openPiperDrawer();
    await window.submitPiperText(`Draft a text message to ${name}. Draft only — do not send.`);
  };
  window.focusSellerNote = () => {
    const panel = document.getElementById("seller-notes");
    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    const input = document.getElementById("detail-log-input");
    if (input) setTimeout(() => input.focus(), 350);
  };
  window.toggleFollowUpForm = () => {
    const el = document.getElementById("followup-inline");
    if (el) el.hidden = !el.hidden;
  };
  window.submitQuickFollowUp = async (oppId) => {
    const title = (document.getElementById("followup-title") || {}).value || "Follow up";
    const dueDate = (document.getElementById("followup-date") || {}).value || null;
    try {
      const res = await pfetch("/api/v1/operator/next-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId: oppId, title, dueDate }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || "save_failed");
      window.showCustomAlert("Follow-up saved.", "Follow Up");
      opportunityDetail(oppId);
    } catch (e) {
      window.showCustomAlert("Could not save follow-up: " + esc(e.message), "Follow Up");
    }
  };
  window.scrollToOffer = () => {
    const form = document.getElementById("prepare-offer-form");
    if (form) {
      window.togglePrepareOfferForm(true);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const panel = document.getElementById("seller-offers");
    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  async function renderTimeline(oppId) {
    const host = document.getElementById("detail-timeline");
    if (!host) return;
    try {
      const events = await fetchTimelineEvents(oppId);
      if (!events.length) {
        host.innerHTML = `<div class="empty-state">No events recorded yet.</div>`;
        return;
      }
      let lastDay = "";
      const rows = [];
      for (const e of events) {
        const day = String(e.at || "").slice(0, 10);
        if (day && day !== lastDay) {
          lastDay = day;
          rows.push(`<div class="timeline-date-divider">${esc(day)}</div>`);
        }
        rows.push(`
          <div class="timeline-event">
            <span class="timeline-icon" aria-hidden="true">${esc(TIMELINE_ICONS[e.type] || "•")}</span>
            <div class="timeline-event-body">
              <div class="timeline-summary">
                <span class="timeline-kind">${esc(TIMELINE_LABELS[e.type] || e.type)}</span>${esc(e.summary)}
              </div>
              <div class="timeline-meta">${esc((e.at || "").replace("T", " ").slice(0, 16))}${e.actor ? ` · ${esc(e.actor)}` : ""}</div>
            </div>
          </div>`);
      }
      host.innerHTML = rows.join("");
    } catch {
      host.innerHTML = `<div class="state error">Could not load the timeline from PIPELINE.</div>`;
    }
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
      const res = await pfetch(`/api/v1/operator/next-actions/${encodeURIComponent(id)}`, {
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
        <dt>Piper provider</dt><dd>${esc(data.piperProvider || "AVAILABLE BUT NEEDS CREDENTIALS")}</dd>
        <dt>Outreach providers</dt><dd>${esc(data.outreachProviders || "NOT IMPLEMENTED")}</dd>
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

  window.saveDetailUnderwriting = async (oppId) => {
    const numOrNull = (id) => {
      const el = document.getElementById(id);
      if (!el || el.value === "" || el.value == null) return null;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : null;
    };
    const payload = {
      opportunityId: oppId,
      arv: numOrNull("detail-arv"),
      rehab: numOrNull("detail-rehab"),
      fee: numOrNull("detail-fee"),
      holding: numOrNull("detail-holding"),
      askingPrice: numOrNull("detail-asking"),
      basis: (document.getElementById("detail-basis") || {}).value || null,
    };
    try {
      await operatorPost("underwriting", payload);
      window.showCustomAlert("Saved to PIPELINE. These are your working estimates — not Victor underwriting.", "Assumptions Saved");
      opportunityDetail(oppId);
    } catch (e) {
      window.showCustomAlert("Could not save assumptions: " + esc(e.message), "Save Failed");
    }
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
      const res = await pfetch("/api/v1/operator/offers", {
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
      const res = await pfetch(`/api/v1/operator/offers/${encodeURIComponent(offerId)}`, {
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
      const res = await pfetch(`/api/v1/operator/offers/${encodeURIComponent(offerId)}`, {
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

  window.createOutreachDraft = async (opportunityId, offerVersionId, recipientPersonId, recipientValueSnapshot, recipientChannel) => {
    try {
      const subject = document.getElementById("outreach-subject")?.value || null;
      const contentText = document.getElementById("outreach-content")?.value;
      if (!contentText || !contentText.trim()) {
        throw new Error("Message content cannot be empty.");
      }

      const res = await pfetch(`/api/v1/operator/outreach/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opportunityId,
          offerVersionId,
          recipientPersonId,
          recipientValueSnapshot,
          recipientChannel,
          subject,
          contentText,
          templateVersion: "1.0.0"
        })
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      window.showCustomAlert("Outreach draft created successfully.", "Draft Created");
      await loadOpportunity(opportunityId);
    } catch (err) {
      window.showCustomAlert(`Could not create outreach draft (${err.message}).`, "Drafting Failed");
    }
  };

  window.authorizeOutreach = async (commId, opportunityId) => {
    try {
      const res = await pfetch(`/api/v1/operator/outreach/${encodeURIComponent(commId)}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      window.showCustomAlert("Outreach message authorized.", "Outreach Authorized");
      await loadOpportunity(opportunityId);
    } catch (err) {
      window.showCustomAlert(`Could not authorize outreach (${err.message}).`, "Authorization Failed");
    }
  };

  window.sendOutreach = async (commId, opportunityId) => {
    try {
      const res = await pfetch(`/api/v1/operator/outreach/${encodeURIComponent(commId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      
      const comm = body.data.communication;
      if (comm.status === "failed") {
        window.showCustomAlert(`Outreach send attempt completed: ${comm.events.find(e => e.eventType === "failed")?.outcome || "Failed"}`, "Send Attempt Finished");
      } else {
        window.showCustomAlert(`Outreach successfully sent!`, "Send Succeeded");
      }
      await loadOpportunity(opportunityId);
    } catch (err) {
      window.showCustomAlert(`Could not execute outreach send (${err.message}).`, "Send Failed");
    }
  };

  window.runCommitteeReview = async (oppId) => {
    const box = document.getElementById("committee-review-result");
    if (box) box.innerHTML = `<span class="muted">Running committee rules…</span>`;
    try {
      const res = await pfetch("/api/v1/investment-committee/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId: oppId }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || "committee_review_failed");
      const r = body.review;
      const color = r.decision === "approve" ? "var(--ok)" : r.decision === "kill" ? "#ff4444" : "var(--accent)";
      const risks = (r.risks || []).map((x) => `<div style="font-size: 11px; opacity: 0.85;">• ${esc(x)}</div>`).join("");
      if (box) box.innerHTML = `<strong style="color: ${color};">${esc(String(r.decision).toUpperCase())}</strong> <span class="muted">by ${esc(r.reviewedBy || "committee")}</span>${risks ? `<div style="margin-top: 4px;">${risks}</div>` : ""}`;
      if (r.decision !== "approve") {
        window.showCustomAlert(`Committee decision: <strong>${esc(String(r.decision).toUpperCase())}</strong><br/><br/>${esc(r.rationale || "")}<br/><br/>Revise the offer terms and re-run the review. Approval stays blocked until the review is approve.`, "Committee Review");
      }
    } catch (e) {
      const msg = e.message === "active_offer_required" ? "No active offer to review — prepare an offer draft first."
        : e.message === "underwriting_required" ? "No underwriting on file — record operator assumptions or wait for Victor analysis."
        : e.message;
      if (box) box.innerHTML = `<span style="color: #ff4444;">${esc(msg)}</span>`;
    }
  };

  window.openNewOpportunityModal = () => {
    const backdrop = document.createElement("div");
    backdrop.className = "custom-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "custom-modal";
    modal.innerHTML = `
      <div class="custom-modal-header">NEW OPPORTUNITY</div>
      <div class="custom-modal-body">
        <p class="muted" style="font-size: 12px; margin-top: 0;">Manual entry. The address is checked for duplicates before anything is written.</p>
        <div class="form-grid-compact">
          <div class="form-group-compact" style="grid-column: span 2;"><label>Property address *</label><input type="text" id="newopp-address" style="width:100%;" /></div>
          <div class="form-group-compact"><label>City</label><input type="text" id="newopp-city" /></div>
          <div class="form-group-compact"><label>State</label><input type="text" id="newopp-state" /></div>
          <div class="form-group-compact"><label>ZIP</label><input type="text" id="newopp-zip" /></div>
          <div class="form-group-compact"><label>APN</label><input type="text" id="newopp-apn" /></div>
          <div class="form-group-compact"><label>Seller name</label><input type="text" id="newopp-sellername" /></div>
          <div class="form-group-compact"><label>Seller phone</label><input type="text" id="newopp-sellerphone" /></div>
          <div class="form-group-compact"><label>Seller email</label><input type="text" id="newopp-selleremail" /></div>
          <div class="form-group-compact"><label>Asking price</label><input type="number" id="newopp-asking" /></div>
          <div class="form-group-compact"><label>Classification</label><select id="newopp-classification">
            <option value="unknown">Unknown</option><option value="retail_listing">Retail listing</option>
            <option value="wholesale_target">Wholesale target</option><option value="investment_rehab">Investment rehab</option>
            <option value="land_hold">Land hold</option><option value="disqualified">Disqualified</option>
          </select></div>
          <div class="form-group-compact" style="grid-column: span 2;"><label>Notes</label><input type="text" id="newopp-notes" style="width:100%;" /></div>
        </div>
        <div id="newopp-error" style="color:#ff4444; font-size:12px; margin-top:8px;"></div>
      </div>
      <div class="custom-modal-actions">
        <button class="primary" id="newopp-save">Create Opportunity</button>
        <button class="secondary" id="newopp-cancel">Cancel</button>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const close = () => document.body.removeChild(backdrop);
    backdrop.querySelector("#newopp-cancel").addEventListener("click", close);
    backdrop.querySelector("#newopp-save").addEventListener("click", async () => {
      const v = (id) => (document.getElementById(id) || {}).value || "";
      const err = backdrop.querySelector("#newopp-error");
      const numOrNull = (id) => { const n = Number(v(id)); return v(id) === "" || !Number.isFinite(n) ? null : n; };
      if (!v("newopp-address").trim()) { err.textContent = "Address is required."; return; }
      err.textContent = "";
      try {
        const res = await pfetch("/api/v1/opportunities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: v("newopp-address"), city: v("newopp-city"), state: v("newopp-state"), zip: v("newopp-zip"),
            apn: v("newopp-apn"), sellerName: v("newopp-sellername"), sellerPhone: v("newopp-sellerphone"),
            sellerEmail: v("newopp-selleremail"), askingPrice: numOrNull("newopp-asking"),
            classification: v("newopp-classification"), notes: v("newopp-notes"),
          }),
        });
        const body = await res.json();
        if (body.duplicate && body.opportunityId) {
          err.innerHTML = `A matching opportunity already exists (${esc(body.matchType || "duplicate")}). <a href="/opportunities/${esc(body.opportunityId)}" onclick="window.routeTo(event, '/opportunities/${esc(body.opportunityId)}')">Open it</a>`;
          return;
        }
        if (!body.ok) {
          throw new Error(body.error || "create_failed");
        }
        close();
        navigate("/opportunities/" + encodeURIComponent(body.opportunityId));
      } catch (e) {
        err.textContent = "Could not create: " + e.message;
      }
    });
    const addr = backdrop.querySelector("#newopp-address");
    if (addr) addr.focus();
  };

  window.saveStageChange = async (oppId) => {
    const select = document.getElementById("detail-stage-select");
    const target = select ? select.value : null;
    if (!target) return;
    const current = state.activeOpp ? state.activeOpp.stage : null;
    if (target === current) return;
    const closed = ["closed", "nurture", "disqualified", "lost", "archived"];
    let reason = null;
    if (closed.includes(current) && !closed.includes(target)) {
      reason = window.prompt("Reopening a closed record — reason (required):");
      if (!reason || !reason.trim()) { if (select) select.value = current; return; }
    }
    try {
      const res = await pfetch(`/api/v1/opportunities/${encodeURIComponent(oppId)}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: target, reason }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || "stage_move_failed");
      window.showCustomAlert(`Stage moved: ${esc(formatStage(current))} \u2192 ${esc(formatStage(target))}. Recorded in PIPELINE with an audit trail.`, "Stage Updated");
      opportunityDetail(oppId);
    } catch (e) {
      window.showCustomAlert("Could not move stage: " + esc(e.message), "Stage Move Failed");
      if (select && current) select.value = current;
    }
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

    // Shared Piper conversation contract (P2 voice prep): text input and the
    // future voice path both submit through this one function, so the
    // conversation state, interrupts, and rendering stay identical.
    async function submitPiperText(rawText) {
      const text = (rawText || "").trim();
      if (!text) return;

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
          const res = await pfetch("/api/v1/piper/ask", {
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
            executeWorkspaceDirective(body.data.directive);
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
    }

    if (piperChatForm) {
      piperChatForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = piperChatInput.value;
        piperChatInput.value = "";
        await submitPiperText(text);
      });
    }

    // ---- Voice-prep shell (P2 directive, P7 detail) ----
    // The microphone UI exists so the layout is settled, but voice input is
    // NOT wired: no speech service is provisioned, no media is captured, and
    // no claim is made that voice works. The state machine below models the
    // future flow (idle -> requesting -> listening -> transcribing ->
    // submitting -> idle) and stays parked in `unavailable` until a founder
    // approves a provider. Transcripts, when they exist, will enter through
    // submitPiperText — the same contract as typed input — so text and voice
    // share one conversation state.
    const PiperVoice = {
      enabled: false, // no speech provider; founder has not approved one
      state: "unavailable",
      setState(next) {
        this.state = next;
        const btn = document.getElementById("piper-voice-btn");
        if (btn) {
          btn.dataset.voiceState = next;
          btn.title = next === "unavailable"
            ? "Voice input arrives in a future update — no speech service is connected."
            : `Voice: ${next}`;
        }
        const note = document.getElementById("piper-voice-note");
        if (note) note.textContent = next === "unavailable" ? "Voice input is not available yet." : "";
      },
      // Future entry point: a transcript from any speech service lands here.
      async submitTranscript(transcript) {
        if (!this.enabled) return;
        this.setState("submitting");
        await submitPiperText(transcript);
        this.setState("idle");
      },
    };
    window.PiperVoice = PiperVoice;
    // Expose the shared contract for the future voice path.
    window.submitPiperText = submitPiperText;
    // Park the shell in `unavailable`: honest label, no capture, no claim.
    PiperVoice.setState("unavailable");
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
        else if (runState === "generating") canvasTitle.textContent = "Model Stream Active";
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
      const res = await pfetch("/api/v1/piper/cancel", {
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
      const res = await pfetch("/api/v1/piper/approve", {
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
      const res = await pfetch("/api/v1/operator/next-actions", {
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
      const resOffers = await pfetch(`/api/v1/operator/offers?opportunityId=${encodeURIComponent(oppId)}`);
      const bodyOffers = await resOffers.json();
      if (!bodyOffers.ok || !bodyOffers.data.offers || !bodyOffers.data.offers.length) {
        throw new Error("No active offer found to modify.");
      }
      const offerId = bodyOffers.data.offers[0].id;
      const res = await pfetch(`/api/v1/operator/offers/${encodeURIComponent(offerId)}`, {
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
      const res = await pfetch("/api/v1/piper/status");
      const body = await res.json();
      if (!body.ok) return;
      const p = body.data.provider;
      // Live badges, driven by /status: never a hard-coded model claim.
      const pill = document.getElementById("piper-provider");
      const pillText = document.getElementById("piper-provider-text");
      if (pill && pillText) {
        pill.classList.toggle("connected", !!p.connected);
        pillText.textContent = p.connected && p.model
          ? `Piper · ${p.model}`
          : "Piper limited — no model";
        pill.title = p.connected
          ? `Piper intelligence: ${p.provider || "model"} (${p.model})`
          : "No language model is connected. Piper answers from stored PIPELINE state only.";
      }
      const sidePill = document.getElementById("sidebar-active-provider");
      if (sidePill) {
        sidePill.classList.toggle("limited", !p.connected);
        sidePill.textContent = p.connected && p.model
          ? `Piper · ${p.model}`
          : "Piper limited";
        sidePill.title = p.connected
          ? `Piper intelligence: ${p.provider || "model"} (${p.model})`
          : "No language model is connected. Piper answers from stored PIPELINE state only.";
      }
      const footerMode = document.getElementById("footer-mode");
      if (footerMode) {
        footerMode.textContent = p.connected && p.model
          ? `Piper intelligence: ${p.model}`
          : "Piper limited — no model";
      }
      setPiperState(p.connected ? "idle" : "not_connected",
        p.connected ? "" : "No model provider is configured. Piper answers from stored PIPELINE state only.");
      const disc = document.getElementById("piper-disclosure");
      if (disc && !p.connected) {
        disc.textContent = "No language model is connected. Piper answers deterministically from stored PIPELINE state; actions are written only after you approve them.";
      } else if (disc && p.connected) {
        disc.textContent = "";
      }
    } catch { /* status is best-effort */ }
  }

  /** The operating brief, fetched from real state when the panel opens. */
  async function loadPiperBrief() {
    try {
      refreshPiperStatus();
      const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
      const res = await pfetch(`/api/v1/piper/brief?excludeFixtures=${!showFixtures}`);
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
    else if (action === "attention") query = "What needs my attention?";
    else if (action === "changed") query = "What changed today?";
    else if (action === "forgetting") query = "What am I forgetting?";
    if (piperChatInput) {
      piperChatInput.value = query;
      piperChatForm.dispatchEvent(new Event("submit"));
    }
  };

  function updatePiperContext() {
    if (!piperContextText) return;
    const activeOppCard = document.getElementById("piper-active-deal-card");
    
    if (state.activeOppId) {
      const o = state.activeOpp || (state.opportunities || []).find(x => x.id === state.activeOppId);
      const label = o ? (o.sellerDisplayName || (o.property && o.property.address) || "this deal") : "this deal";
      piperContextText.textContent = `Looking at ${label} — ask me anything about it.`;
      if (o && activeOppCard) {
        activeOppCard.innerHTML = `
          <div class="active-deal-header">
            <span class="deal-icon">✦</span>
            <div class="deal-meta">
              <span class="deal-address">${esc((o.property && o.property.address) || label)}</span>
            </div>
          </div>
          <div class="active-deal-metrics">
            <div class="metric-mini">
              <span class="lbl">Stage</span>
              <span class="val stage-badge">${esc(founderStageLabel(toFounderStage(o.stage)))}</span>
            </div>
            <div class="metric-mini">
              <span class="lbl">MAO (75%)</span>
              <span class="val">${mao != null ? money(mao) : "—"}</span>
            </div>
          </div>
        `;
        activeOppCard.classList.remove("hidden");
      } else if (activeOppCard) {
        activeOppCard.classList.add("hidden");
      }
    } else {
      piperContextText.textContent = "Piper is ready — ask about any seller or deal.";
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
    else if (path === "/people") p = people();
    else if (path === "/tasks") p = tasks();
    else if (path === "/admin") p = admin();
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
    initOperatorAccess();
    render();
    // Keep every provider claim honest: sidebar pill, footer, and Piper
    // drawer all come from /api/v1/piper/status. Best-effort; the static
    // defaults already state "limited".
    refreshPiperStatus();
  })();

  // Operator access entry: founder-operator secret, sessionStorage only.
  function initOperatorAccess() {
    const btn = document.getElementById("operator-access-btn");
    if (!btn) return;
    const paint = () => {
      const has = window.hasOperatorSecret();
      btn.textContent = has ? "Operator: unlocked" : "Operator: locked";
      btn.setAttribute("aria-pressed", has ? "true" : "false");
      btn.classList.toggle("unlocked", has);
    };
    btn.addEventListener("click", () => {
      if (window.hasOperatorSecret()) {
        if (confirm("Clear the operator secret for this tab?")) {
          window.clearOperatorSecret();
          paint();
        }
        return;
      }
      openOperatorLoginDialog();
    });
    const origSet = window.setOperatorSecret;
    window.setOperatorSecret = (s) => { origSet(s); paint(); };
    const origClear = window.clearOperatorSecret;
    window.clearOperatorSecret = () => { origClear(); paint(); };
    paint();
  }

  // Masked operator login (P2 hardening). Replaces the unmasked
  // window.prompt() flow. The secret is typed into a password field (never
  // displayed), never written to logs, and never persisted by this dialog —
  // on success it is handed to the existing sessionStorage mechanism
  // (window.setOperatorSecret), preserving current authorization behavior.
  // The candidate is validated against a live authenticated endpoint before
  // it is accepted, so a wrong secret produces an honest failure message.
  // The exact entered value is submitted and stored (no trimming), matching
  // the server's exact-match operator-secret contract.
  function openOperatorLoginDialog() {
    if (document.getElementById("operator-login-backdrop")) return;
    const backdrop = document.createElement("div");
    backdrop.className = "custom-modal-backdrop";
    backdrop.id = "operator-login-backdrop";

    const modal = document.createElement("div");
    modal.className = "custom-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "operator-login-title");
    modal.innerHTML = `
      <div class="custom-modal-header" id="operator-login-title">OPERATOR ACCESS</div>
      <div class="custom-modal-body">
        <p class="muted" style="margin-top:0">Enter the founder-operator secret. It stays in this tab only and is never written to disk or logs.</p>
        <label class="field-label" for="operator-login-secret">Operator secret</label>
        <input type="password" id="operator-login-secret" class="text-input" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <div class="field-error" id="operator-login-error" role="alert" hidden></div>
      </div>
      <div class="custom-modal-actions">
        <button class="primary" id="operator-login-submit">Unlock</button>
        <button class="secondary" id="operator-login-cancel">Cancel</button>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const input = modal.querySelector("#operator-login-secret");
    const errBox = modal.querySelector("#operator-login-error");
    const submitBtn = modal.querySelector("#operator-login-submit");

    const close = () => {
      input.value = "";
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      const btn = document.getElementById("operator-access-btn");
      if (btn) btn.focus();
    };
    const fail = (msg) => {
      errBox.textContent = msg;
      errBox.hidden = false;
      input.value = "";
      submitBtn.disabled = false;
      submitBtn.textContent = "Unlock";
      input.focus();
    };
    const submit = async () => {
      const candidate = input.value;
      if (!candidate.length) { fail("Enter the operator secret to continue."); return; }
      errBox.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Verifying…";
      try {
        // A live authenticated probe: 401/403 means the secret was rejected.
        // Any other response proves the bearer was accepted (auth runs first).
        const res = await fetch("/api/v1/piper/status", {
          headers: { Authorization: "Bearer " + candidate },
        });
        if (res.status === 401 || res.status === 403) {
          fail("Secret not accepted. Check the value and try again.");
          return;
        }
        if (!res.ok) { fail("Could not verify the secret right now. Try again."); return; }
        window.setOperatorSecret(candidate);
        close();
      } catch {
        fail("Could not reach PIPELINE. Check the connection and try again.");
      }
    };

    modal.querySelector("#operator-login-cancel").addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    input.focus();
  }
  function buildOutreachHtml(o) {
    const contact = o.contact || { status: "MISSING", value: null, channel: null };
    const hasContact = contact.status !== "MISSING" && contact.value;
    
    // Get active approved offer version
    const hasApprovedOffer = o.offers && o.offers.length > 0 && o.offers[0].status === "approved";
    const activeOffer = o.offers && o.offers.length > 0 ? o.offers[0] : null;
    const activeVer = activeOffer ? activeOffer.versions.find(v => v.id === activeOffer.activeVersionId) : null;
    const isApproved = activeVer && activeVer.versionStatus === "approved";

    let contactStatusColor = "#ff4444";
    if (contact.status === "VERIFIED") contactStatusColor = "var(--ok)";
    else if (contact.status === "SOURCE_SUPPLIED") contactStatusColor = "var(--accent)";

    let contactCard = `
      <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 4px; font-size: 12px; margin-bottom: 12px;">
        <div style="font-weight:600; margin-bottom: 4px; display: flex; justify-content: space-between;">
          <span>Recipient Contact Card</span>
          <span style="color: ${contactStatusColor}; font-weight: 700;">${esc(contact.status)}</span>
        </div>
        ${hasContact ? `
          <div style="display: grid; grid-template-columns: 80px 1fr; gap: 4px; font-size: 11px;">
            <span class="muted">Name:</span><span>${esc(contact.displayName || "N/A")}</span>
            <span class="muted">Channel:</span><span>${esc(contact.channel || "N/A")}</span>
            <span class="muted">Value:</span><span>${esc(contact.value || "N/A")}</span>
            <span class="muted">Person ID:</span><span>${esc(contact.personId || "N/A")}</span>
          </div>
        ` : `
          <div style="color: #ff4444; font-size: 11px;">⚠️ No verified or source-supplied contact details available for this seller.</div>
        `}
      </div>
    `;

    let actionHtml = "";
    if (!isApproved) {
      actionHtml = `<div class="muted" style="font-size: 11px;">Prepare and approve an offer version before drafting outreach.</div>`;
    } else if (!hasContact) {
      actionHtml = `<div class="muted" style="font-size: 11px; color: #ff4444;">Drafting and sending outreach is blocked because seller contact information is missing.</div>`;
    } else {
      // We have contact + approved offer.
      // Check if there is an active draft.
      const activeDraft = o.communications ? o.communications.find(c => ["drafted", "authorized", "send_attempted"].includes(c.status)) : null;

      if (activeDraft) {
        let statusColor = "var(--accent)";
        if (activeDraft.status === "authorized") statusColor = "var(--ok)";
        
        let buttonsHtml = "";
        if (activeDraft.status === "drafted") {
          buttonsHtml = `
            <button class="primary" style="background: var(--ok); color: #000; font-size: 11px; padding: 4px 8px;" onclick="window.authorizeOutreach('${esc(activeDraft.id)}', '${esc(o.id)}')">Authorize Outreach</button>
          `;
        } else if (activeDraft.status === "authorized") {
          buttonsHtml = `
            <button class="primary" style="background: var(--accent); color: #000; font-size: 11px; padding: 4px 8px;" onclick="window.sendOutreach('${esc(activeDraft.id)}', '${esc(o.id)}')">Send Outreach</button>
          `;
        }

        actionHtml = `
          <div style="background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); padding: 8px; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 6px;">
              <strong>ACTIVE OUTREACH PIPELINE</strong>
              <span style="color: ${statusColor}; font-weight:700;">${activeDraft.status.toUpperCase()}</span>
            </div>
            <div style="font-size: 11px; border: 1px solid rgba(255,255,255,0.05); padding: 6px; background:#111; color:#fff; border-radius:4px; font-family: var(--mono); white-space: pre-wrap; margin-bottom: 8px;">${esc(activeDraft.contentText)}</div>
            <div style="display:flex; gap:8px;">
              ${buttonsHtml}
            </div>
          </div>
        `;
      } else {
        // Let operator create a draft outreach.
        const defaultText = `Hello ${contact.displayName || "Owner"},\n\nWe would like to make an offer of ${money(activeVer.purchasePrice)} for your property at ${o.property.address || "Wichita Property"} with ${activeVer.inspectionDays} inspection days and ${activeVer.closingDays} closing days.\n\nBest regards,\nOperator`;

        actionHtml = `
          <div id="create-outreach-form">
            <div class="form-group-compact" style="margin-bottom: 8px;">
              <label>Subject</label>
              <input type="text" id="outreach-subject" value="Offer for ${o.property.address || "Wichita Property"}" style="width:100%; background:#111; color:#fff; border:1px solid #333; padding:4px;" />
            </div>
            <div class="form-group-compact" style="margin-bottom: 8px;">
              <label>Outreach Message</label>
              <textarea id="outreach-content" style="width:100%; height:80px; background:#111; color:#fff; border:1px solid #333; padding:4px; font-family: var(--mono); font-size:11px;">${esc(defaultText)}</textarea>
            </div>
            <button class="primary" style="background: var(--ok); color: #000; font-size: 11px; padding: 4px 8px;" onclick="window.createOutreachDraft('${esc(o.id)}', '${esc(activeVer.id)}', '${esc(contact.personId)}', '${esc(contact.value)}', '${esc(contact.channel)}')">Create Outreach Draft</button>
          </div>
        `;
      }
    }

    // History timeline
    let historyHtml = "";
    if (o.communications && o.communications.length > 0) {
      historyHtml = `
        <div style="margin-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
          <h4 style="margin: 0 0 8px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8;">Outreach Audit History</h4>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${o.communications.map(c => {
              let statusColor = "var(--accent)";
              if (c.status === "failed") statusColor = "#ff4444";
              else if (c.status === "sent" || c.status === "delivered") statusColor = "var(--ok)";

              const latestEvent = c.events[c.events.length - 1];
              const outcomeText = latestEvent?.outcome ? ` - Outcome: ${latestEvent.outcome}` : "";

              return `
                <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); padding: 8px; border-radius: 4px; font-size: 11px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <strong>${c.direction.toUpperCase()} (${esc(c.recipientChannel.toUpperCase())})</strong>
                    <span style="color: ${statusColor}; font-weight:700;">${c.status.toUpperCase()}</span>
                  </div>
                  <div style="font-style: italic; margin-bottom: 4px; color: #fff;">"${esc(c.contentText)}"</div>
                  <div class="muted" style="font-size: 9px; display: flex; justify-content: space-between;">
                    <span>Ref: ${esc(c.id.slice(0, 8))}...${outcomeText}</span>
                    <span>${esc(new Date(c.createdAt).toLocaleString())}</span>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }

    return `
      <div class="panel" style="border-left: 2px solid var(--accent); background: var(--accent-sf); margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h2 style="margin:0; font-size: 16px;">Seller Outreach & Audit Gate</h2>
          <span class="badge" style="background: var(--accent-sf); color: var(--accent); border-color: var(--accent);">Outreach</span>
        </div>
        ${contactCard}
        ${actionHtml}
        ${historyHtml}
      </div>
    `;
  }
})();
