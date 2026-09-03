(() => {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  async function json(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return body.data;
  }

  function opportunityIdFromPath() {
    const match = location.pathname.match(/^\/opportunities\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function addressOf(o) {
    return o?.propertyAddress || o?.address || o?.property?.address || o?.property_address || o?.id || "Opportunity";
  }

  function latest(items) {
    return Array.isArray(items) && items.length ? items[items.length - 1] : null;
  }

  function status(label, detail, tone = "muted") {
    return { label, detail, tone };
  }

  function buildUnderwriting(o) {
    const refs = o?.underwritingReferences || o?.underwriting_refs || o?.underwriting || [];
    const current = Array.isArray(refs) ? latest(refs) : refs;
    if (!current) return status("Not yet available", "Victor underwriting has not been persisted for this property.");
    const bits = [];
    if (current.arv != null) bits.push(`ARV ${current.arv}`);
    if (current.rehab != null || current.rehabEstimate != null) bits.push(`rehab ${current.rehab ?? current.rehabEstimate}`);
    if (current.mao != null) bits.push(`MAO ${current.mao}`);
    if (current.confidence != null) bits.push(`confidence ${current.confidence}`);
    return status("Underwriting recorded", bits.join(" · ") || "Victor evidence is attached to the canonical opportunity.", "complete");
  }

  async function snapshot(id) {
    const encoded = encodeURIComponent(id);
    const opportunity = await json(`/api/v1/opportunities/${encoded}`);
    const [committee, tx, handoffs, dispositions] = await Promise.all([
      json(`/api/v1/investment-committee?opportunityId=${encoded}`).catch(() => null),
      json(`/api/v1/operator/transactions?opportunityId=${encoded}`).catch(() => null),
      json(`/api/v1/operator/acquisition-handoffs?opportunityId=${encoded}`).catch(() => null),
      json(`/api/v1/operator/dispositions?opportunityId=${encoded}`).catch(() => null),
    ]);

    const reviews = Array.isArray(committee?.reviews) ? committee.reviews : [];
    const review = latest(reviews);
    const milestones = Array.isArray(tx?.milestones) ? tx.milestones : [];
    const handoffRows = Array.isArray(handoffs?.handoffs) ? handoffs.handoffs : [];
    const plans = Array.isArray(dispositions?.plans) ? dispositions.plans : [];
    const currentPlan = latest(plans);
    const risk = tx?.risk || null;
    const readiness = tx?.readiness || null;

    const discovery = status(
      "Property record established",
      `${String(opportunity.stage || "new_lead").replace(/_/g, " ")} · ${opportunity.provenanceState || opportunity.provenance_state || "source tracked"}`,
      "complete"
    );

    const underwriting = buildUnderwriting(opportunity);

    const decision = review
      ? status(String(review.decision || review.recommendation || "reviewed").replace(/_/g, " "), review.rationale || review.reason || "Investment Committee review recorded.", String(review.decision || "").includes("approve") ? "complete" : "attention")
      : status("No committee decision", "No Investment Committee review is recorded for this property.");

    const txDetail = milestones.length
      ? `${milestones.length} milestone${milestones.length === 1 ? "" : "s"} recorded${risk?.severity ? ` · risk ${risk.severity}` : ""}`
      : "No governed transaction milestone is recorded yet.";
    const transaction = milestones.length
      ? status(readiness?.readyToClose ? "Closing ready" : "Transaction active", txDetail, risk?.severity === "critical" || risk?.severity === "high" ? "danger" : "complete")
      : status("Not in transaction", txDetail);

    const renovation = handoffRows.length
      ? status("Mission Control handoff created", `${handoffRows.length} acquisition handoff${handoffRows.length === 1 ? "" : "s"} recorded. Field scope validation remains governed by Mission Control.`, "complete")
      : status("Not handed to Mission Control", "A closed-purchase acquisition handoff has not been recorded.");

    const exit = currentPlan
      ? status(String(currentPlan.status || "exit plan").replace(/_/g, " "), `${String(currentPlan.strategy || currentPlan.strategyType || "approved strategy").replace(/_/g, " ")} · evidence-gated disposition execution`, currentPlan.status === "completed" ? "complete" : "attention")
      : status("No exit execution plan", "No governed post-renovation disposition plan is recorded.");

    return { opportunity, stages: [
      { owner: "Hunter", title: "Discovery & Intake", ...discovery },
      { owner: "Victor", title: "Deal Intelligence & Underwriting", ...underwriting },
      { owner: "Investment Committee", title: "Capital Decision", ...decision },
      { owner: "Piper", title: "Offer, Contract & Closing", ...transaction },
      { owner: "Mission Control", title: "Renovation Execution", ...renovation },
      { owner: "OCG OS", title: "Sell / Hold / Refinance", ...exit },
    ]};
  }

  function render(data) {
    const view = document.getElementById("view");
    if (!view || document.getElementById("ocg-deal-story")) return;
    const rows = data.stages.map((stage, index) => `
      <div class="ocg-story-stage ocg-story-${esc(stage.tone)}">
        <div class="ocg-story-index">${index + 1}</div>
        <div class="ocg-story-copy">
          <span class="ocg-story-owner">${esc(stage.owner)}</span>
          <strong>${esc(stage.title)}</strong>
          <span class="ocg-story-status">${esc(stage.label)}</span>
          <p>${esc(stage.detail)}</p>
        </div>
      </div>`).join("");

    const section = document.createElement("section");
    section.id = "ocg-deal-story";
    section.className = "ocg-deal-story";
    section.setAttribute("aria-label", "OCG OS chronological deal record");
    section.innerHTML = `
      <div class="ocg-story-head">
        <div>
          <div class="ocg-command-kicker">CANONICAL PROPERTY RECORD · ${esc(data.opportunity.id)}</div>
          <h1>${esc(addressOf(data.opportunity))}</h1>
          <p>One property story across the OCG OS workforce. Each stage below is derived from the governed subsystem record that owns it.</p>
        </div>
        <div class="ocg-story-stage-chip">${esc(String(data.opportunity.stage || "unknown").replace(/_/g, " "))}</div>
      </div>
      <div class="ocg-story-flow">${rows}</div>
      <div class="ocg-command-truth">No stage is marked complete unless its owning subsystem exposes supporting state. Missing records stay visibly incomplete rather than being inferred.</div>`;
    view.prepend(section);
  }

  let loading = false;
  async function ensure() {
    const id = opportunityIdFromPath();
    if (!id || loading || document.getElementById("ocg-deal-story")) return;
    loading = true;
    try { render(await snapshot(id)); } catch { /* canonical PIPELINE detail remains usable */ }
    finally { loading = false; }
  }

  const observer = new MutationObserver(() => setTimeout(ensure, 0));
  const view = document.getElementById("view");
  if (view) observer.observe(view, { childList: true, subtree: true });
  window.addEventListener("popstate", () => setTimeout(ensure, 0));
  document.addEventListener("click", (event) => {
    if (event.target.closest("a")) setTimeout(ensure, 75);
  });
  setTimeout(ensure, 0);
})();
