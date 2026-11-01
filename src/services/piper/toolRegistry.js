/**
 * Piper's tools.
 *
 * Two classes, and the distinction is the safety model:
 *
 *   READ tools execute immediately. They cannot mutate anything, so there is
 *   nothing to approve, and making the operator confirm a lookup would train
 *   them to click through prompts without reading.
 *
 *   WRITE tools are never executed by the model. They are recorded as proposals
 *   and executed only after the operator approves, through the same
 *   SqliteOperatorRepository the UI uses — so PIPELINE_READ_ONLY, validation and
 *   audit behave identically whether a human or Piper initiated the action.
 *
 * A model can therefore phrase an answer and suggest an action, but cannot
 * invent a record or write to the database on its own.
 */

import { buildBrief } from "../../domain/piper/briefModel.js";
import { buildIntelligenceReport } from "./intelligenceReportService.js";
import { createAgentWorkRoomService } from "../agentWorkRoomService.js";
import { buildAgentGovernance } from "../agentGovernance.js";
import { createGuidedWorkflowService } from "./guidedWorkflowService.js";
import { GUIDED_WORKFLOW_TEMPLATES, getGuidedWorkflowTemplate } from "../../domain/piper/guidedWorkflows.js";
import {
  findSellerCandidates,
  resolveSeller,
  sellerOpportunities,
  sellerTimeline,
  lastContact,
  tasksDue,
  searchPipeline,
  prepareCallPlan,
} from "./piperSellerData.js";

const str = (v, max = 300) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);

/** JSON-Schema definitions handed to the provider. */
export const TOOL_SCHEMAS = Object.freeze([
  {
    type: "function",
    function: {
      name: "get_operating_brief",
      description: "The current operating brief: what needs a decision, what is stalled, what changed, new intake, risks, and recommended next actions. Derived from stored PIPELINE state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_intelligence_report",
      description: "The structured intelligence report (Charlie format): portfolio totals, per-opportunity basis-labeled figures, underwriting status and confidence, open decisions, risks, and open founder escalations. Read-only; derived entirely from stored PIPELINE state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_guided_workflow",
      description: "Read guided-workflow state: one workflow by id, the in-flight workflow and history for an opportunity, or the tenant's active workflows. Read-only bookkeeping — a guided workflow never executes anything itself.",
      parameters: {
        type: "object",
        properties: {
          workflowId: { type: "string" },
          opportunityId: { type: "string" },
          limit: { type: "number", description: "Default 50, maximum 100." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_opportunities",
      description: "Search opportunities held in PIPELINE. Returns summary rows only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Match against address, opportunity id or code." },
          stage: { type: "string", description: "Canonical stage id, e.g. negotiating." },
          stalledOnly: { type: "boolean", description: "Only opportunities with no movement and no open next action." },
          limit: { type: "number", description: "Default 10, maximum 50." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_opportunity",
      description: "Everything PIPELINE's bounded operating snapshot holds about one opportunity, including provenance, classification, underwriting attribution, risks and missing fields.",
      parameters: {
        type: "object",
        properties: { opportunityId: { type: "string" } },
        required: ["opportunityId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_outreach_state",
      description: "Read the canonical seller contact, offer versions, and immutable communication history for one opportunity. Use this before discussing seller outreach, whether the seller was contacted, or which offer version was sent.",
      parameters: {
        type: "object",
        properties: { opportunityId: { type: "string" } },
        required: ["opportunityId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_next_action",
      description: "Propose a next action on an opportunity. Requires operator approval before it is written.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          title: { type: "string" },
          dueDate: { type: "string", description: "ISO date, optional." },
        },
        required: ["opportunityId", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Propose an append-only note on an opportunity. Requires operator approval.",
      parameters: {
        type: "object",
        properties: { opportunityId: { type: "string" }, body: { type: "string" } },
        required: ["opportunityId", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_interaction",
      description: "Propose a call or contact log entry. Requires operator approval.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          channel: { type: "string", enum: ["email", "phone", "sms", "in_person", "mail"] },
          direction: { type: "string", enum: ["inbound", "outbound"] },
          summary: { type: "string" },
          outcome: { type: "string" },
        },
        required: ["opportunityId", "channel", "direction", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_offer",
      description: "Propose a draft seller offer using explicit operator-reviewed terms. Requires operator approval before PIPELINE writes the draft.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          proposedPrice: { type: "number" },
          strategyType: { type: "string" },
          earnestMoney: { type: "number" },
          inspectionDays: { type: "number" },
          closingDays: { type: "number" },
          contingencies: { type: ["string", "array"], items: { type: "string" } },
          internalNotes: { type: "string" }
        },
        required: ["opportunityId", "proposedPrice", "strategyType", "earnestMoney", "inspectionDays", "closingDays"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "modify_offer",
      description: "Propose a new immutable version of an existing seller offer. Requires operator approval.",
      parameters: {
        type: "object",
        properties: {
          offerId: { type: "string" },
          proposedPrice: { type: "number" },
          strategyType: { type: "string" },
          earnestMoney: { type: "number" },
          inspectionDays: { type: "number" },
          closingDays: { type: "number" },
          contingencies: { type: ["string", "array"], items: { type: "string" } },
          internalNotes: { type: "string" }
        },
        required: ["offerId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "prepare_outreach_draft",
      description: "Propose creation of an immutable seller outreach draft tied to a real approved offer version and the canonical resolved contact. This only creates a draft after operator approval; it never authorizes or sends outreach.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          offerVersionId: { type: "string" },
          subject: { type: "string" },
          contentText: { type: "string" },
          templateVersion: { type: "string" }
        },
        required: ["opportunityId", "offerVersionId", "contentText"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_seller",
      description: "Resolve a seller by exact or partial name, property address fragment, and/or phone number. Returns candidates with match quality; sets ambiguous=true when more than one strong match exists — in that case ask the operator which seller they mean instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Seller name, exact or partial, e.g. \"Robert Chen\" or \"Robert\"." },
          address: { type: "string", description: "Property address fragment, e.g. \"Maple\" or \"123 Main\"." },
          phone: { type: "string", description: "Phone number; digits are compared." },
          limit: { type: "number", description: "Default 10, maximum 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_seller_summary",
      description: "A grounded summary of one seller: contact details and every opportunity tied to them with address, stage, and asking price. Resolve the seller with find_seller first, or pass the opportunity.",
      parameters: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          opportunityId: { type: "string", description: "Uses the primary seller of this opportunity when contactId is absent." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_seller_timeline",
      description: "One unified chronological seller-activity timeline for an opportunity: lead intake, stage changes, interactions, communications, notes, offers, tasks, appointments, and Piper's executed actions. Answers \"what happened with this seller?\".",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          limit: { type: "number", description: "Default 60, maximum 200." },
        },
        required: ["opportunityId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_last_contact",
      description: "When the seller was last contacted: the most recent interaction or communication, with channel, direction, and summary. Returns found:false when nothing is recorded.",
      parameters: {
        type: "object",
        properties: { opportunityId: { type: "string" } },
        required: ["opportunityId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_offer_history",
      description: "Every offer and offer version for an opportunity, newest first, with prices, strategy, and status.",
      parameters: {
        type: "object",
        properties: { opportunityId: { type: "string" } },
        required: ["opportunityId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tasks",
      description: "Next actions / follow-ups. filter: open (default), due (open and due today or earlier — includes overdue), overdue (open and due before today), all. Answers \"who do I need to follow up with\" and \"who has gone cold\".",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string", description: "Omit to search across all opportunities." },
          filter: { type: "string", enum: ["open", "due", "overdue", "all"] },
          limit: { type: "number", description: "Default 25, maximum 100." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_pipeline",
      description: "Descriptive pipeline search: street fragment, seller name fragment, asking-price target (dollars; matched within 20%) or price band, stage. E.g. street \"Maple\" with askingPrice 180000 finds \"the guy on Maple who wanted 180\".",
      parameters: {
        type: "object",
        properties: {
          street: { type: "string" },
          name: { type: "string" },
          askingPrice: { type: "number", description: "Target asking price in dollars." },
          minPrice: { type: "number" },
          maxPrice: { type: "number" },
          stage: { type: "string", description: "Canonical stage id." },
          limit: { type: "number", description: "Default 10, maximum 50." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_call",
      description: "Resolve the seller's phone number and assemble a call plan: contact, opportunity context, last contact, open tasks. This NEVER dials — it only prepares. Dialing arrives in Phase 3 as execute_call.",
      parameters: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          opportunityId: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_sms",
      description: "Propose an immutable SMS draft to the seller's recorded phone number. Requires operator approval; never sends. Sending is not wired.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          offerVersionId: { type: "string", description: "Optional; when present it must be an approved version." },
          contentText: { type: "string" },
        },
        required: ["opportunityId", "contentText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_founder",
      description: "Propose a founder escalation for a blocked, high-risk, or decision-critical item. Requires operator approval; on approval it records the escalation as an auditable work-room task awaiting the founder, with the reason and evidence references. It notifies no one externally — the escalation is the record the founder reviews.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string", description: "Optional; the opportunity the escalation concerns." },
          reason: { type: "string", description: "Why this needs the founder: the blocker, risk, or decision required." },
          severity: { type: "string", enum: ["normal", "high", "critical"] },
          evidenceRefs: { type: "array", items: { type: "string" }, description: "Pointers to the stored evidence behind the escalation (record ids, brief sections, review ids)." },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_agent",
      description: "Propose handing work to another OCG OS agent. Requires operator approval; on approval it creates a work-room task for that agent in the same append-only audit as operator-driven delegation. The target is validated against the Director identity registry: it must be a registered, active agent identity (HUNTER, VICTOR, PIPER, or a registered specialist) — unknown or retired identities are refused. It does not contact anyone — it records the handoff.",
      parameters: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "The registered agent identity's name, e.g. \"VICTOR\" or a specialist's directory name." },
          summary: { type: "string", description: "What the receiving agent is being asked to do, and why." },
          opportunityId: { type: "string", description: "Optional; links the handoff to an opportunity." },
          title: { type: "string", description: "Optional short task title." },
        },
        required: ["targetAgent", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_guided_workflow",
      description: "Propose starting a persisted guided workflow (a code-defined step sequence) on an opportunity. Requires operator approval; on approval it records the workflow instance with its first step current. Starting executes nothing — the operator works each step, and a step's suggested tool still parks for its own approval.",
      parameters: {
        type: "object",
        properties: {
          workflowKey: { type: "string", enum: GUIDED_WORKFLOW_TEMPLATES.map((t) => t.key), description: "Which guided workflow template to start." },
          opportunityId: { type: "string", description: "Optional; the opportunity the sequence is worked on." },
          title: { type: "string", description: "Optional title override." },
        },
        required: ["workflowKey"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "advance_guided_workflow",
      description: "Propose moving a guided workflow: advance (mark the current step done), skip, pause, resume, or abandon. Requires operator approval. Bookkeeping only — advancing never runs the step's suggested tool or any other action.",
      parameters: {
        type: "object",
        properties: {
          workflowId: { type: "string" },
          action: { type: "string", enum: ["advance", "skip", "pause", "resume", "abandon"], description: "Default advance." },
          note: { type: "string", description: "Optional note recorded with the step decision." },
        },
        required: ["workflowId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description: "Propose an immutable email draft to the seller's recorded email address. Requires operator approval; never sends. Sending is not wired.",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          offerVersionId: { type: "string", description: "Optional; when present it must be an approved version." },
          subject: { type: "string" },
          contentText: { type: "string" },
        },
        required: ["opportunityId", "contentText"],
      },
    },
  },
]);

const WRITE_TOOLS = new Set([
  "create_next_action",
  "add_note",
  "log_interaction",
  "prepare_offer",
  "modify_offer",
  "prepare_outreach_draft",
  "draft_sms",
  "draft_email",
  "escalate_to_founder",
  "handoff_to_agent",
  "start_guided_workflow",
  "advance_guided_workflow",
]);

export const isWriteTool = (name) => WRITE_TOOLS.has(name);
export const isKnownTool = (name) => TOOL_SCHEMAS.some((t) => t.function.name === name);

/**
 * Executes a tool. Write tools reach here only after approval — the runtime is
 * responsible for the gate; this function assumes it has already been passed.
 */
/** Kinds that can hold handed-off work. The founder is reached through
 * escalate_to_founder, not handoff; system identities are not agents. */
const HANDOFF_TARGET_KINDS = new Set(["orchestrator", "director", "lead", "specialist"]);

/** Resolve a handoff target against the Director identity registry: by id,
 * by canonical name, or by case-insensitive name. Null when absent. */
function resolveDirectoryAgent(directory, ref) {
  if (!directory || !ref) return null;
  const direct = directory.resolve(ref);
  if (direct) return direct;
  const wanted = String(ref).trim().toLowerCase();
  return directory.list().find((a) => a.name.toLowerCase() === wanted) || null;
}

export async function executeTool({ name, args = {}, snapshot, operator, actor = "piper", workRoom = null, agentDirectory = null, guidedWorkflows = null }) {
  // Tenant scope for seller-data tools: the operator repository carries the
  // deployment's configured tenant; every opportunity id entering below is
  // resolved against it (a foreign id reads exactly like a nonexistent one).
  const tenantId = operator ? operator.tenantId || null : null;
  // Work room + agent directory: the runtime passes the shared instances
  // built by buildServices. A direct caller without them falls back to the
  // SAME governed construction (agentGovernance.js) from the operator's own
  // db + tenant — there is no ungoverned work-room construction anywhere
  // (QUINCEY F7). A database too old for the governance tables degrades to
  // the legacy bare room and no directory; handoff then fails closed,
  // because without a registry there is no validated target.
  let room = workRoom || null;
  let directory = agentDirectory || null;
  if ((!room || !directory) && operator?.db) {
    try {
      const gov = buildAgentGovernance(operator.db, tenantId);
      room = room || gov.workRoom;
      directory = directory || gov.directory;
    } catch {
      room = room || createAgentWorkRoomService(operator.db, tenantId);
    }
  }
  const workflows = guidedWorkflows || (operator?.db ? createGuidedWorkflowService(operator.db, tenantId) : null);
  const opportunityExists = (opportunityId) =>
    tenantId
      ? !!operator.db.prepare("SELECT 1 FROM seller_opportunities WHERE id = ? AND tenant_id = ?").get(opportunityId, tenantId)
      : !!operator.db.prepare("SELECT 1 FROM seller_opportunities WHERE id = ?").get(opportunityId);
  switch (name) {
    case "get_operating_brief":
      return { ok: true, data: buildBrief(snapshot) };

    case "get_intelligence_report":
      return { ok: true, data: buildIntelligenceReport(snapshot, { workRoom: room }) };

    case "find_opportunities": {
      const limit = Math.min(Number(args.limit) || 10, 50);
      const q = str(args.query, 200)?.toLowerCase();
      let rows = snapshot.opportunities;

      if (args.stalledOnly === true) rows = rows.filter((o) => o.stalled);
      if (args.stage) rows = rows.filter((o) => o.stage === args.stage);
      if (q) {
        rows = rows.filter((o) =>
          [o.id, o.code, o.address].filter(Boolean).some((f) => String(f).toLowerCase().includes(q))
        );
      }

      return {
        ok: true,
        data: {
          matched: rows.length,
          opportunities: rows.slice(0, limit).map((o) => ({
            id: o.id,
            address: o.address,
            stage: o.stageLabel,
            status: o.status,
            provenanceState: o.provenanceState,
            recordClassification: o.recordClassification,
            openNextActionCount: o.openNextActionCount,
            daysSinceActivity: o.daysSinceActivity,
            stalled: o.stalled,
          })),
        },
      };
    }

    case "get_opportunity": {
      const o = snapshot.opportunities.find((x) => x.id === args.opportunityId);
      if (!o) return { ok: false, error: "not_found", detail: `No opportunity ${args.opportunityId} in PIPELINE.` };
      return { ok: true, data: o };
    }

    case "get_outreach_state": {
      const opportunityId = str(args.opportunityId, 200);
      const exists = snapshot.opportunities.some((o) => o.id === opportunityId);
      if (!exists) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      const contact = operator.resolveContact(opportunityId);
      const offers = operator.listOffers(opportunityId);
      const communications = operator.listCommunications(opportunityId);
      const activeApprovedOffer = offers.find((o) => o.status === "approved" || o.status === "presented") || null;
      return {
        ok: true,
        data: {
          opportunityId,
          contact,
          activeApprovedOffer,
          offers,
          communications,
          sellerContacted: communications.some((c) => c.direction === "outbound" && ["sent", "delivered"].includes(c.status)),
          sellerReplied: communications.some((c) => c.direction === "inbound" && c.status === "received"),
        },
      };
    }

    case "create_next_action": {
      const created = operator.createNextAction({
        opportunityId: str(args.opportunityId, 200),
        title: str(args.title, 300),
        dueDate: str(args.dueDate, 40),
        actor,
      });
      return { ok: true, data: { nextAction: created } };
    }

    case "add_note": {
      const note = operator.createNote({
        opportunityId: str(args.opportunityId, 200),
        body: str(args.body, 4000),
        actor,
      });
      return { ok: true, data: { note } };
    }

    case "log_interaction": {
      const interaction = operator.createInteraction({
        opportunityId: str(args.opportunityId, 200),
        channel: str(args.channel, 40),
        direction: str(args.direction, 20),
        summary: str(args.summary, 4000),
        outcome: str(args.outcome, 200),
        actor,
      });
      return { ok: true, data: { interaction } };
    }

    case "prepare_offer": {
      const offer = operator.prepareOffer({
        opportunityId: str(args.opportunityId, 200),
        proposedPrice: args.proposedPrice,
        strategyType: str(args.strategyType, 100),
        earnestMoney: args.earnestMoney,
        inspectionDays: args.inspectionDays,
        closingDays: args.closingDays,
        contingencies: args.contingencies,
        internalNotes: str(args.internalNotes, 4000),
        actor,
      });
      return { ok: true, data: { offer } };
    }

    case "modify_offer": {
      const offer = operator.decideOffer({
        offerId: str(args.offerId, 200),
        action: "modify",
        proposedPrice: args.proposedPrice,
        strategyType: str(args.strategyType, 100),
        earnestMoney: args.earnestMoney,
        inspectionDays: args.inspectionDays,
        closingDays: args.closingDays,
        contingencies: args.contingencies,
        internalNotes: str(args.internalNotes, 4000),
        actor,
      });
      return { ok: true, data: { offer } };
    }

    case "prepare_outreach_draft": {
      const opportunityId = str(args.opportunityId, 200);
      const contact = operator.resolveContact(opportunityId);
      if (!contact || contact.status === "MISSING" || !contact.value || !contact.channel || !contact.personId) {
        return { ok: false, error: "seller_contact_required" };
      }
      const communication = operator.createOutreachDraft({
        opportunityId,
        offerVersionId: str(args.offerVersionId, 200),
        recipientPersonId: contact.personId,
        recipientValueSnapshot: contact.value,
        recipientChannel: contact.channel,
        subject: str(args.subject, 300),
        contentText: str(args.contentText, 12000),
        templateVersion: str(args.templateVersion, 100),
        actor,
      });
      return { ok: true, data: { communication } };
    }

    // --- Phase 1 seller tools ------------------------------------------------
    // All reads execute immediately; they cannot mutate anything.

    case "find_seller": {
      const result = findSellerCandidates(operator.db, {
        name: str(args.name, 200),
        address: str(args.address, 200),
        phone: str(args.phone, 60),
        limit: args.limit,
        tenantId,
      });
      if (result.error) return { ok: false, error: result.error, detail: "Pass a seller name, address fragment, or phone number." };
      return { ok: true, data: result };
    }

    case "get_seller_summary": {
      const seller = resolveSeller(operator.db, {
        contactId: str(args.contactId, 200),
        opportunityId: str(args.opportunityId, 200),
        tenantId,
      });
      if (!seller) return { ok: false, error: "seller_not_found" };
      return { ok: true, data: { seller, opportunities: sellerOpportunities(operator.db, seller.contactId, tenantId) } };
    }

    case "get_seller_timeline": {
      const opportunityId = str(args.opportunityId, 200);
      if (!opportunityId) return { ok: false, error: "missing_opportunityId" };
      const timeline = sellerTimeline(operator.db, operator, opportunityId, { limit: args.limit, tenantId });
      if (!timeline.found) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      return { ok: true, data: timeline };
    }

    case "get_last_contact": {
      const opportunityId = str(args.opportunityId, 200);
      if (!opportunityId) return { ok: false, error: "missing_opportunityId" };
      if (!opportunityExists(opportunityId)) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      return { ok: true, data: lastContact(operator.db, opportunityId, tenantId) };
    }

    case "get_offer_history": {
      const opportunityId = str(args.opportunityId, 200);
      if (!opportunityId) return { ok: false, error: "missing_opportunityId" };
      if (!opportunityExists(opportunityId)) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      return { ok: true, data: { opportunityId, offers: operator.listOffers(opportunityId) } };
    }

    case "get_tasks": {
      return { ok: true, data: tasksDue(operator.db, operator, {
        opportunityId: str(args.opportunityId, 200),
        filter: str(args.filter, 20),
        limit: args.limit,
      }) };
    }

    case "search_pipeline": {
      const result = searchPipeline(operator.db, {
        street: str(args.street, 200),
        name: str(args.name, 200),
        askingPrice: args.askingPrice,
        minPrice: args.minPrice,
        maxPrice: args.maxPrice,
        stage: str(args.stage, 60),
        limit: args.limit,
        tenantId,
      });
      if (result.error) return { ok: false, error: result.error, detail: "Pass a street, name, price, or stage to search on." };
      return { ok: true, data: result };
    }

    case "prepare_call": {
      const plan = prepareCallPlan(operator.db, operator, {
        contactId: str(args.contactId, 200),
        opportunityId: str(args.opportunityId, 200),
        tenantId,
      });
      if (!plan.ok) return { ok: false, error: plan.error, detail: plan.detail };
      return { ok: true, data: plan };
    }

    // --- Phase 1 draft tools (write: approval-gated, never send) --------------

    case "draft_sms": {
      const draft = operator.createChannelDraft({
        opportunityId: str(args.opportunityId, 200),
        channel: "sms",
        offerVersionId: str(args.offerVersionId, 200),
        contentText: str(args.contentText, 4000),
        actor,
      });
      return { ok: true, data: { communication: draft, sends: false } };
    }

    case "draft_email": {
      const draft = operator.createChannelDraft({
        opportunityId: str(args.opportunityId, 200),
        channel: "email",
        offerVersionId: str(args.offerVersionId, 200),
        subject: str(args.subject, 300),
        contentText: str(args.contentText, 12000),
        actor,
      });
      return { ok: true, data: { communication: draft, sends: false } };
    }

    // --- Cross-agent work room (write: approval-gated, records only) --------
    // Escalations and handoffs land in the migration-023 work room — the same
    // append-only audit as operator-driven delegation. Neither tool contacts
    // anyone; each records a durable, reviewable fact.

    case "escalate_to_founder": {
      const reason = str(args.reason, 1000);
      if (!reason) return { ok: false, error: "missing_reason", detail: "An escalation needs the blocker, risk, or decision it is raising." };
      const opportunityId = str(args.opportunityId, 200);
      if (opportunityId && !opportunityExists(opportunityId)) {
        return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      }
      if (!room) return { ok: false, error: "work_room_unavailable" };
      const severity = ["normal", "high", "critical"].includes(args.severity) ? args.severity : "normal";
      const evidenceRefs = Array.isArray(args.evidenceRefs)
        ? args.evidenceRefs.map((e) => str(e, 300)).filter(Boolean).slice(0, 10)
        : [];
      const task = room.create({
        department: "OCG OS",
        title: `Founder escalation: ${reason}`.slice(0, 300),
        requestedBy: actor,
        orchestrator: "Aiden",
        director: "Founder",
        leadAgent: "Piper",
        opportunityId: opportunityId || null,
        state: "awaiting_approval",
        approvalRequired: true,
        currentAction: "Escalated to the founder by Piper; awaiting founder review.",
        blocker: reason,
      });
      room.event({
        taskId: task.id,
        eventType: "approval_requested",
        actor: "Piper",
        fromActor: "Piper",
        toActor: "Founder",
        summary: `Escalation (${severity}): ${reason}`,
        evidenceRef: evidenceRefs[0] || null,
        metadata: { via: "piper_escalate_to_founder", severity, evidenceRefs },
      });
      return { ok: true, data: { escalation: { id: task.id, state: task.state, severity, opportunityId: opportunityId || null, reason } } };
    }

    case "handoff_to_agent": {
      const summary = str(args.summary, 2000);
      if (!summary) return { ok: false, error: "missing_summary", detail: "A handoff needs what the receiving agent is being asked to do." };
      // The target is validated against the Director identity registry
      // (Issue #7): the identity must exist in the directory, be active,
      // and be an agent kind that can hold work. Unknown names and retired
      // identities are refused — there is no hardcoded agent list anymore
      // (QUINCEY F7).
      const rawTarget = str(args.targetAgent, 200);
      const target = rawTarget ? resolveDirectoryAgent(directory, rawTarget) : null;
      if (!target || !HANDOFF_TARGET_KINDS.has(target.kind)) {
        return { ok: false, error: "unknown_agent", detail: "Piper can hand off to an agent registered in the OCG OS directory (HUNTER, VICTOR, PIPER, or an active registered specialist). For a founder decision, use escalate_to_founder." };
      }
      if (target.status !== "active") {
        return { ok: false, error: "agent_not_active", detail: `${target.name} is retired in the agent directory and cannot receive work.` };
      }
      const opportunityId = str(args.opportunityId, 200);
      if (opportunityId && !opportunityExists(opportunityId)) {
        return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      }
      if (!room) return { ok: false, error: "work_room_unavailable" };
      const task = room.create({
        department: "OCG OS",
        title: str(args.title, 300) || `Handoff to ${target.name}: ${summary}`.slice(0, 300),
        requestedBy: actor,
        orchestrator: "Aiden",
        director: "OCG OS Director",
        leadAgent: target.name,
        opportunityId: opportunityId || null,
        state: "queued",
        currentAction: summary,
      });
      room.event({
        taskId: task.id,
        eventType: "handoff",
        actor: "Piper",
        fromActor: "Piper",
        toActor: target.name,
        summary,
        evidenceRef: str(args.evidenceRef, 300),
        metadata: { via: "piper_handoff_to_agent", targetAgentId: target.id },
      });
      return { ok: true, data: { handoff: { id: task.id, targetAgent: target.name, targetAgentId: target.id, state: task.state, opportunityId: opportunityId || null } } };
    }

    // --- Guided workflows (migration 033; bookkeeping only) ----------------
    // Starting/advancing a workflow writes instance + step bookkeeping and
    // NOTHING else: a step never executes its suggested tool, and write
    // tools below still park for their own approval when actually proposed.

    case "start_guided_workflow": {
      const workflowKey = str(args.workflowKey, 100);
      if (!getGuidedWorkflowTemplate(workflowKey)) {
        return { ok: false, error: "unknown_workflow", detail: `Guided workflows: ${GUIDED_WORKFLOW_TEMPLATES.map((t) => t.key).join(", ")}.` };
      }
      const opportunityId = str(args.opportunityId, 200);
      if (opportunityId && !opportunityExists(opportunityId)) {
        return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      }
      if (!workflows) return { ok: false, error: "guided_workflows_unavailable" };
      try {
        const workflow = workflows.start({
          workflowKey,
          opportunityId: opportunityId || null,
          title: str(args.title, 300),
          actor,
        });
        return { ok: true, data: { workflow } };
      } catch (err) {
        return { ok: false, error: err.message || "guided_workflow_failed" };
      }
    }

    case "advance_guided_workflow": {
      const workflowId = str(args.workflowId, 200);
      if (!workflowId) return { ok: false, error: "missing_workflow_id", detail: "Which guided workflow? get_guided_workflow lists them." };
      if (!workflows) return { ok: false, error: "guided_workflows_unavailable" };
      const action = ["advance", "skip", "pause", "resume", "abandon"].includes(args.action) ? args.action : "advance";
      try {
        const workflow = workflows[action](workflowId, { actor, note: str(args.note, 1000) });
        return { ok: true, data: { workflow } };
      } catch (err) {
        const code = err.message || "guided_workflow_failed";
        // Ghost equality: a foreign workflow id reads exactly like a
        // nonexistent one, in the same vocabulary as every other tool.
        return { ok: false, error: code === "guided_workflow_not_found" ? "not_found" : code };
      }
    }

    case "get_guided_workflow": {
      if (!workflows) return { ok: false, error: "guided_workflows_unavailable" };
      const workflowId = str(args.workflowId, 200);
      if (workflowId) {
        const workflow = workflows.get(workflowId);
        if (!workflow) return { ok: false, error: "not_found", detail: `No guided workflow ${workflowId} in PIPELINE.` };
        return { ok: true, data: { workflow } };
      }
      const opportunityId = str(args.opportunityId, 200);
      if (opportunityId) {
        if (!opportunityExists(opportunityId)) {
          return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
        }
        return {
          ok: true,
          data: {
            active: workflows.activeForOpportunity(opportunityId),
            workflows: workflows.list({ opportunityId, limit: args.limit }),
          },
        };
      }
      return { ok: true, data: { workflows: workflows.list({ state: "active", limit: args.limit }) } };
    }

    default:
      return { ok: false, error: "unknown_tool", detail: `Piper has no tool named ${name}.` };
  }
}

/** Human-readable one-liner for an approval prompt. Never speculative. */
export function describeToolCall(name, args = {}) {
  switch (name) {
    case "create_next_action":
      return `Create next action "${args.title}" on ${args.opportunityId}${args.dueDate ? `, due ${args.dueDate}` : ""}`;
    case "add_note":
      return `Add a note to ${args.opportunityId}: "${String(args.body || "").slice(0, 120)}"`;
    case "log_interaction":
      return `Log a ${args.direction} ${args.channel} on ${args.opportunityId}: "${String(args.summary || "").slice(0, 120)}"`;
    case "prepare_offer":
      return `Prepare a draft seller offer for ${args.opportunityId} at ${args.proposedPrice} (${args.strategyType}, ${args.earnestMoney} earnest, ${args.inspectionDays} inspection days, ${args.closingDays} closing days)`;
    case "modify_offer":
      return `Create a new version of offer ${args.offerId}${args.proposedPrice !== undefined ? ` at ${args.proposedPrice}` : ""}`;
    case "prepare_outreach_draft":
      return `Create an immutable outreach draft for ${args.opportunityId} tied to approved offer version ${args.offerVersionId}. This does not authorize or send it.`;
    case "find_seller":
      return `Find seller matching ${[args.name && `name "${args.name}"`, args.address && `address "${args.address}"`, args.phone && `phone "${args.phone}"`].filter(Boolean).join(", ") || "?"}`;
    case "get_seller_summary":
      return `Summarize seller ${args.contactId || args.opportunityId}`;
    case "get_seller_timeline":
      return `Show the seller activity timeline for ${args.opportunityId}`;
    case "get_last_contact":
      return `Show the last recorded contact for ${args.opportunityId}`;
    case "get_offer_history":
      return `Show the offer history for ${args.opportunityId}`;
    case "get_tasks":
      return `List ${args.filter || "open"} next actions${args.opportunityId ? ` for ${args.opportunityId}` : ""}`;
    case "search_pipeline":
      return `Search the pipeline${args.street ? ` near "${args.street}"` : ""}${args.name ? ` for "${args.name}"` : ""}`;
    case "prepare_call":
      return `Prepare a call plan for ${args.contactId || args.opportunityId} (does not dial)`;
    case "draft_sms":
      return `Draft an SMS for ${args.opportunityId}. This does not send it.`;
    case "draft_email":
      return `Draft an email for ${args.opportunityId}. This does not send it.`;
    case "get_intelligence_report":
      return "Build the structured intelligence report from stored PIPELINE state";
    case "escalate_to_founder":
      return `Escalate to the founder${args.opportunityId ? ` on ${args.opportunityId}` : ""}: "${String(args.reason || "").slice(0, 120)}"`;
    case "handoff_to_agent":
      return `Hand off to ${args.targetAgent || "?"}${args.opportunityId ? ` on ${args.opportunityId}` : ""}: "${String(args.summary || "").slice(0, 120)}"`;
    case "get_guided_workflow":
      return args.workflowId
        ? `Show guided workflow ${args.workflowId}`
        : args.opportunityId
          ? `Show the guided workflow state for ${args.opportunityId}`
          : "List active guided workflows";
    case "start_guided_workflow":
      return `Start the ${args.workflowKey || "?"} guided workflow${args.opportunityId ? ` on ${args.opportunityId}` : ""}. This records the sequence only — it runs nothing.`;
    case "advance_guided_workflow": {
      const action = ["advance", "skip", "pause", "resume", "abandon"].includes(args.action) ? args.action : "advance";
      return `${action[0].toUpperCase()}${action.slice(1)} guided workflow ${args.workflowId || "?"} (bookkeeping only — no step action runs)`;
    }
    default:
      return `${name}(${Object.keys(args).join(", ")})`;
  }
}
