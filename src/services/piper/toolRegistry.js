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
      description: "Everything PIPELINE holds about one opportunity, including provenance, classification, underwriting attribution, risks and missing fields.",
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
]);

const WRITE_TOOLS = new Set(["create_next_action", "add_note", "log_interaction"]);

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
    default:
      return `${name}(${Object.keys(args).join(", ")})`;
  }
}
