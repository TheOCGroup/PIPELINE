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
]);

export const isWriteTool = (name) => WRITE_TOOLS.has(name);
export const isKnownTool = (name) => TOOL_SCHEMAS.some((t) => t.function.name === name);

/**
 * Executes a tool. Write tools reach here only after approval — the runtime is
 * responsible for the gate; this function assumes it has already been passed.
 */
export async function executeTool({ name, args = {}, snapshot, operator, actor = "piper" }) {
  switch (name) {
    case "get_operating_brief":
      return { ok: true, data: buildBrief(snapshot) };

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
      });
      if (result.error) return { ok: false, error: result.error, detail: "Pass a seller name, address fragment, or phone number." };
      return { ok: true, data: result };
    }

    case "get_seller_summary": {
      const seller = resolveSeller(operator.db, {
        contactId: str(args.contactId, 200),
        opportunityId: str(args.opportunityId, 200),
      });
      if (!seller) return { ok: false, error: "seller_not_found" };
      return { ok: true, data: { seller, opportunities: sellerOpportunities(operator.db, seller.contactId) } };
    }

    case "get_seller_timeline": {
      const opportunityId = str(args.opportunityId, 200);
      if (!opportunityId) return { ok: false, error: "missing_opportunityId" };
      const timeline = sellerTimeline(operator.db, operator, opportunityId, { limit: args.limit });
      if (!timeline.found) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      return { ok: true, data: timeline };
    }

    case "get_last_contact": {
      const opportunityId = str(args.opportunityId, 200);
      if (!opportunityId) return { ok: false, error: "missing_opportunityId" };
      const exists = operator.db.prepare("SELECT 1 FROM seller_opportunities WHERE id = ?").get(opportunityId);
      if (!exists) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
      return { ok: true, data: lastContact(operator.db, opportunityId) };
    }

    case "get_offer_history": {
      const opportunityId = str(args.opportunityId, 200);
      if (!opportunityId) return { ok: false, error: "missing_opportunityId" };
      const exists = operator.db.prepare("SELECT 1 FROM seller_opportunities WHERE id = ?").get(opportunityId);
      if (!exists) return { ok: false, error: "not_found", detail: `No opportunity ${opportunityId} in PIPELINE.` };
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
      });
      if (result.error) return { ok: false, error: result.error, detail: "Pass a street, name, price, or stage to search on." };
      return { ok: true, data: result };
    }

    case "prepare_call": {
      const plan = prepareCallPlan(operator.db, operator, {
        contactId: str(args.contactId, 200),
        opportunityId: str(args.opportunityId, 200),
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
    default:
      return `${name}(${Object.keys(args).join(", ")})`;
  }
}
