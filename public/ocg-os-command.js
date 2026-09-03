(() => {
  const ACTIVE_STATES = new Set(["retrieving", "generating", "executing"]);

  const lifecycleGroups = [
    { key: "discovery", label: "Hunter / Discovery", stages: ["new_lead", "needs_review", "attempting_contact", "contacted", "qualified", "appointment_scheduled"] },
    { key: "underwriting", label: "Victor / Underwriting", stages: ["property_review", "strategy_development"] },
    { key: "decision", label: "Committee / Offer", stages: ["offer_preparation", "offer_approval_required", "offer_presented", "negotiating"] },
    { key: "transaction", label: "Piper / Transaction", stages: ["under_contract", "due_diligence", "closing_scheduled"] },
  ];

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  async function json(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return body.data;
  }

  function piperState() {
    const chip = document.getElementById("piper-state-chip");
    return String(chip?.textContent || "idle").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function workSummary(state) {
    if (ACTIVE_STATES.has(state)) return { tone: "active", label: "WORKING", detail: `Piper is ${state.replace(/_/g, " ")}.` };
    if (state === "awaiting_approval") return { tone: "attention", label: "NEEDS GENARO", detail: "A governed action is awaiting approval." };
    if (state === "failed") return { tone: "danger", label: "FAILED", detail: "The latest Piper run failed. No success is being claimed." };
    if (state === "canceled") return { tone: "muted", label: "CANCELED", detail: "The latest Piper run was canceled." };
    if (state === "complete") return { tone: "complete", label: "FINISHED", detail: "The latest Piper run completed." };
    return { tone: "muted", label: "IDLE", detail: "No active Piper task is running." };
  }

  function countPipelineLifecycle(opportunities) {
    return lifecycleGroups.map((group) => ({
      ...group,
      count: opportunities.filter((opp) => group.stages.includes(opp.stage || "new_lead")).length,
    }));
  }

  function briefAttention(brief) {
    const sections = Array.isArray(brief?.sections) ? brief.sections : [];
    const seen = new Set();
    const items = [];
    for (const section of sections) {
      const title = String(section.title || "").toLowerCase();
      if (title !== "needs you" && title !== "risk" && title !== "stalled") continue;
      for (const item of Array.isArray(section.items) ? section.items : []) {
        const key = item?.opportunityId ? `opp:${item.opportunityId}` : `${title}:${item?.title || item?.label || items.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          opportunityId: item?.opportunityId || null,
          title: item?.title || item?.label || item?.summary || "Needs review",
          detail: item?.detail || item?.reason || item?.description || section.title || "Requires attention",
          source: section.title || "Attention",
        });
      }
    }
    return items;
  }

  async function postCloseState(opportunities) {
    const closed = opportunities.filter((opp) => opp.stage === "closed");
    if (!closed.length) return { missionControl: 0, exitExecution: 0, verified: true };

    const rows = await Promise.all(closed.map(async (opp) => {
      const id = encodeURIComponent(opp.id);
      const [handoffData, dispositionData] = await Promise.all([
        json(`/api/v1/operator/acquisition-handoffs?opportunityId=${id}`).catch(() => null),
        json(`/api/v1/operator/dispositions?opportunityId=${id}`).catch(() => null),
      ]);
      const handoffs = Array.isArray(handoffData?.handoffs) ? handoffData.handoffs : [];
      const plans = Array.isArray(dispositionData?.plans) ? dispositionData.plans : [];
      return {
        handoff: handoffs.length > 0,
        disposition: plans.some((plan) => String(plan.status || "").toLowerCase() !== "completed"),
        readable: handoffData !== null && dispositionData !== null,
      };
    }));

    return {
      missionControl: rows.filter((row) => row.handoff).length,
      exitExecution: rows.filter((row) => row.disposition).length,
      verified: rows.every((row) => row.readable),
    };
  }

  async function committeeState(opportunities) {
    const candidates = opportunities
      .filter((opp) => ["offer_preparation", "offer_approval_required", "offer_presented", "negotiating"].includes(opp.stage))
      .slice(0, 12);
    const rows = await Promise.all(candidates.map(async (opp) => {
      const data = await json(`/api/v1/investment-committee?opportunityId=${encodeURIComponent(opp.id)}`).catch(() => null);
      const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
      const latest = reviews[reviews.length - 1] || null;
      return {
        opportunityId: opp.id,
        address: opp.propertyAddress || opp.address || opp.property?.address || opp.id,
        stage: opp.stage,
        decision: latest?.decision || latest?.recommendation || (opp.stage === "offer_approval_required" ? "approval_required" : "not_reviewed"),
        rationale: latest?.rationale || latest?.reason || null,
        readable: data !== null,
      };
    }));
    return { rows, verified: rows.every((row) => row.readable) };
  }

  function riskSeverity(risk) {
    const value = String(risk?.severity || risk?.level || risk?.status || "").toLowerCase();
    if (["critical", "high", "blocked", "overdue"].some((x) => value.includes(x))) return 3;
    if (["medium", "at_risk", "warning", "imminent"].some((x) => value.includes(x))) return 2;
    if (value) return 1;
    return 0;
  }

  async function transactionState(opportunities) {
    const candidates = opportunities
      .filter((opp) => ["under_contract", "due_diligence", "closing_scheduled"].includes(opp.stage))
      .slice(0, 12);
    const rows = await Promise.all(candidates.map(async (opp) => {
      const data = await json(`/api/v1/operator/transactions?opportunityId=${encodeURIComponent(opp.id)}`).catch(() => null);
      const risk = data?.risk || {};
      const readiness = data?.readiness || {};
      return {
        opportunityId: opp.id,
        address: opp.propertyAddress || opp.address || opp.property?.address || opp.id,
        stage: opp.stage,
        risk,
        readiness,
        severity: riskSeverity(risk),
        readable: data !== null,
      };
    }));
    rows.sort((a, b) => b.severity - a.severity);
    return { rows, verified: rows.every((row) => row.readable) };
  }

  async function buildSnapshot() {
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    const [opps, brief, system] = await Promise.all([
      json("/api/v1/opportunities?pageSize=100"),
      json(`/api/v1/piper/brief?excludeFixtures=${!showFixtures}`).catch(() => ({ headline: "Brief unavailable", sections: [] })),
      json("/api/v1/system/status").catch(() => ({})),
    ]);
    const opportunities = Array.isArray(opps) ? opps.filter((o) => showFixtures || !o.isFixture) : [];
    const [postClose, committee, transactions] = await Promise.all([
      postCloseState(opportunities), committeeState(opportunities), transactionState(opportunities),
    ]);
    const lifecycle = countPipelineLifecycle(opportunities);
    lifecycle.push(
      { key: "mission-control", label: "Mission Control / Renovation", count: postClose.missionControl },
      { key: "exit", label: "OCG OS / Exit Execution", count: postClose.exitExecution },
    );
    const attentionItems = briefAttention(brief);
    return {
      lifecycle,
      attention: attentionItems.length,
      attentionItems,
      total: opportunities.length,
      headline: brief?.headline || "OCG OS operating state",
      system,
      committee: committee.rows,
      transactions: transactions.rows,
      verified: postClose.verified && committee.verified && transactions.verified,
    };
  }

  function decisionTone(decision) {
    const value = String(decision || "").toLowerCase();
    if (value.includes("kill") || value.includes("reject")) return "danger";
    if (value.includes("hold") || value.includes("revise") || value.includes("required")) return "attention";
    if (value.includes("approve")) return "complete";
    return "muted";
  }

  function renderRows(items, emptyText, formatter) {
    if (!items.length) return `<div class="ocg-empty">${esc(emptyText)}</div>`;
    return items.slice(0, 5).map(formatter).join("");
  }

  function render(snapshot) {
    if (location.pathname !== "/" && location.pathname !== "/index.html") return;
    const view = document.getElementById("view");
    if (!view || document.getElementById("ocg-command-center")) return;
    const work = workSummary(piperState());
    const lifecycle = snapshot.lifecycle.map((item) => `
      <div class="ocg-lifecycle-step">
        <div class="ocg-lifecycle-count">${item.count}</div>
        <div class="ocg-lifecycle-label">${esc(item.label)}</div>
      </div>
    `).join("");

    const attentionRows = renderRows(snapshot.attentionItems, "Nothing currently surfaced for Genaro.", (item) => `
      <div class="ocg-priority-row">
        <div><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></div>
        <span class="ocg-source">${esc(item.source)}</span>
      </div>`);

    const committeeRows = renderRows(snapshot.committee, "No active capital decision is waiting in the current pipeline.", (row) => `
      <div class="ocg-priority-row">
        <div><strong>${esc(row.address)}</strong><span>${esc(row.rationale || row.stage.replace(/_/g, " "))}</span></div>
        <span class="ocg-decision ocg-live-${decisionTone(row.decision)}">${esc(String(row.decision).replace(/_/g, " "))}</span>
      </div>`);

    const transactionRows = renderRows(snapshot.transactions, "No active transaction risk is surfaced.", (row) => {
      const blockers = Array.isArray(row.risk?.blockers) ? row.risk.blockers.length : Number(row.risk?.blockerCount || 0);
      const label = row.severity >= 3 ? "HIGH RISK" : row.severity === 2 ? "WATCH" : "ON TRACK";
      return `
        <div class="ocg-priority-row">
          <div><strong>${esc(row.address)}</strong><span>${esc(row.stage.replace(/_/g, " "))}${blockers ? ` · ${blockers} blocker${blockers === 1 ? "" : "s"}` : ""}</span></div>
          <span class="ocg-decision ${row.severity >= 3 ? "ocg-live-danger" : row.severity === 2 ? "ocg-live-attention" : "ocg-live-complete"}">${label}</span>
        </div>`;
    });

    const section = document.createElement("section");
    section.id = "ocg-command-center";
    section.className = "ocg-command-center";
    section.setAttribute("aria-label", "OCG OS executive command center");
    section.innerHTML = `
      <div class="ocg-command-head">
        <div>
          <div class="ocg-command-kicker">OCG OS · REAL ESTATE COMMAND</div>
          <h1>What matters now</h1>
          <p>${esc(snapshot.headline)}</p>
        </div>
        <div class="ocg-live-work ocg-live-${work.tone}" id="ocg-live-work">
          <span class="ocg-live-dot" aria-hidden="true"></span>
          <div><strong>${esc(work.label)}</strong><span id="ocg-live-detail">${esc(work.detail)}</span></div>
        </div>
      </div>
      <div class="ocg-command-metrics">
        <div class="ocg-command-metric"><span>Active opportunities</span><strong>${snapshot.total}</strong></div>
        <div class="ocg-command-metric"><span>Needs Genaro</span><strong>${snapshot.attention}</strong></div>
        <div class="ocg-command-metric"><span>System mode</span><strong>${esc(snapshot.system?.dataSource || "unknown")}</strong></div>
      </div>
      <div class="ocg-lifecycle" aria-label="Deal lifecycle">${lifecycle}</div>
      <div class="ocg-executive-grid">
        <section class="ocg-executive-panel"><div class="ocg-panel-head"><span>NEEDS GENARO</span><strong>${snapshot.attention}</strong></div>${attentionRows}</section>
        <section class="ocg-executive-panel"><div class="ocg-panel-head"><span>CAPITAL DECISIONS</span><strong>${snapshot.committee.length}</strong></div>${committeeRows}</section>
        <section class="ocg-executive-panel"><div class="ocg-panel-head"><span>TRANSACTION RISK</span><strong>${snapshot.transactions.length}</strong></div>${transactionRows}</section>
      </div>
      <div class="ocg-command-truth">Live work is derived from Piper's real run state. Committee decisions, transaction risk, post-close handoffs and disposition counts are read from governed OCG OS records${snapshot.verified ? "." : " where those records are currently readable."} No simulated completion percentage is shown.</div>
    `;
    view.prepend(section);
  }

  function syncLiveWork() {
    const box = document.getElementById("ocg-live-work");
    const detail = document.getElementById("ocg-live-detail");
    if (!box || !detail) return;
    const work = workSummary(piperState());
    box.className = `ocg-live-work ocg-live-${work.tone}`;
    const strong = box.querySelector("strong");
    if (strong) strong.textContent = work.label;
    detail.textContent = work.detail;
  }

  let rendering = false;
  async function ensure() {
    if (rendering) return;
    if (location.pathname !== "/" && location.pathname !== "/index.html") return;
    if (document.getElementById("ocg-command-center")) {
      syncLiveWork();
      return;
    }
    rendering = true;
    try {
      const snapshot = await buildSnapshot();
      render(snapshot);
    } catch {
      // Existing PIPELINE views remain authoritative if this enhancement cannot load.
    } finally {
      rendering = false;
    }
  }

  const observer = new MutationObserver(() => {
    syncLiveWork();
    if (!document.getElementById("ocg-command-center")) ensure();
  });

  window.addEventListener("popstate", () => setTimeout(ensure, 0));
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-nav]");
    if (link) setTimeout(ensure, 50);
  });

  const view = document.getElementById("view");
  if (view) observer.observe(view, { childList: true, subtree: true });
  const chip = document.getElementById("piper-state-chip");
  if (chip) observer.observe(chip, { childList: true, characterData: true, subtree: true, attributes: true });
  setTimeout(ensure, 0);
})();
