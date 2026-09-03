(() => {
  const ACTIVE_STATES = new Set(["retrieving", "generating", "executing"]);
  const ATTENTION_STATES = new Set(["awaiting_approval", "failed"]);
  const TERMINAL_STATES = new Set(["complete", "canceled"]);

  const lifecycleGroups = [
    { key: "discovery", label: "Hunter / Discovery", stages: ["new_lead", "needs_review", "attempting_contact", "contacted", "qualified", "appointment_scheduled"] },
    { key: "underwriting", label: "Victor / Underwriting", stages: ["property_review", "strategy_development"] },
    { key: "decision", label: "Committee / Offer", stages: ["offer_preparation", "offer_approval_required", "offer_presented", "negotiating"] },
    { key: "transaction", label: "Piper / Transaction", stages: ["under_contract", "due_diligence", "closing_scheduled"] },
    { key: "exit", label: "Mission Control / Exit", stages: ["closed", "nurture", "disqualified", "lost", "archived"] },
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

  function countLifecycle(opportunities) {
    return lifecycleGroups.map((group) => ({
      ...group,
      count: opportunities.filter((opp) => group.stages.includes(opp.stage || "new_lead")).length,
    }));
  }

  function getAttentionCount(brief) {
    const sections = Array.isArray(brief?.sections) ? brief.sections : [];
    return sections.reduce((sum, section) => {
      const title = String(section.title || "").toLowerCase();
      return title === "needs you" || title === "risk" || title === "stalled"
        ? sum + (Array.isArray(section.items) ? section.items.length : 0)
        : sum;
    }, 0);
  }

  async function buildSnapshot() {
    const showFixtures = localStorage.getItem("pipeline_show_fixtures") === "true";
    const [opps, brief, system] = await Promise.all([
      json("/api/v1/opportunities?pageSize=100"),
      json(`/api/v1/piper/brief?excludeFixtures=${!showFixtures}`).catch(() => ({ headline: "Brief unavailable", sections: [] })),
      json("/api/v1/system/status").catch(() => ({})),
    ]);
    const opportunities = Array.isArray(opps) ? opps.filter((o) => showFixtures || !o.isFixture) : [];
    return {
      lifecycle: countLifecycle(opportunities),
      attention: getAttentionCount(brief),
      total: opportunities.length,
      headline: brief?.headline || "OCG OS operating state",
      system,
    };
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
        <div class="ocg-command-metric"><span>Needs attention</span><strong>${snapshot.attention}</strong></div>
        <div class="ocg-command-metric"><span>System mode</span><strong>${esc(snapshot.system?.dataSource || "unknown")}</strong></div>
      </div>
      <div class="ocg-lifecycle" aria-label="Deal lifecycle">
        ${lifecycle}
      </div>
      <div class="ocg-command-truth">Live work status is derived from Piper's actual run state. No simulated progress percentage is shown.</div>
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
