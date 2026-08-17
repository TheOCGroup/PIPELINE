/**
 * Piper run states.
 *
 * The governing rule: every state corresponds to work that is actually
 * happening. There is no "thinking" state, because a spinner that does not
 * track a real operation is a lie about what the system is doing — and this
 * application's whole subject is not asserting things it cannot support.
 *
 *   not_connected      no provider configured; no model was contacted
 *   retrieving         reading PIPELINE state out of SQLite
 *   generating         a request is in flight to the provider
 *   awaiting_approval  a proposed action needs the operator's decision
 *   running_tool       an approved tool is executing against the database
 *   complete           settled, succeeded
 *   failed             settled, errored
 *   canceled           settled, operator aborted
 */

export const RUN_STATES = Object.freeze({
  NOT_CONNECTED: "not_connected",
  RETRIEVING: "retrieving",
  GENERATING: "generating",
  AWAITING_APPROVAL: "awaiting_approval",
  RUNNING_TOOL: "running_tool",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELED: "canceled",
});

/** States where a real operation is in flight. The UI pulses only for these. */
const BUSY = new Set([RUN_STATES.RETRIEVING, RUN_STATES.GENERATING, RUN_STATES.RUNNING_TOOL]);

/** Terminal states. Nothing further happens without a new run. */
const SETTLED = new Set([RUN_STATES.COMPLETE, RUN_STATES.FAILED, RUN_STATES.CANCELED, RUN_STATES.NOT_CONNECTED]);

/** States where the operator can abort. */
const CANCELLABLE = new Set([RUN_STATES.RETRIEVING, RUN_STATES.GENERATING, RUN_STATES.AWAITING_APPROVAL]);

export const isBusy = (s) => BUSY.has(s);
export const isSettled = (s) => SETTLED.has(s);
export const isCancellable = (s) => CANCELLABLE.has(s);

/**
 * Whether a settled run may have written to the database.
 *
 * `failed` and `canceled` are reported as having written nothing — true because
 * a tool only runs after explicit approval, and an approved tool that executes
 * moves the run to running_tool and then complete. A run that never reached
 * running_tool cannot have mutated anything.
 */
export const mayHaveWritten = (state, executedToolCount = 0) =>
  state === RUN_STATES.COMPLETE && executedToolCount > 0;

/** One line of operator-facing explanation. Never speculative. */
export function describeState(state, { toolName = null, executedToolCount = 0, errorCode = null } = {}) {
  switch (state) {
    case RUN_STATES.NOT_CONNECTED:
      return "No model provider is configured. Piper answers from stored PIPELINE state only.";
    case RUN_STATES.RETRIEVING:
      return "Reading PIPELINE state from the database.";
    case RUN_STATES.GENERATING:
      return "Waiting on the model.";
    case RUN_STATES.AWAITING_APPROVAL:
      return toolName
        ? `Piper proposes "${toolName}". Nothing has been written — approve it to run.`
        : "Piper proposed an action. Nothing has been written yet.";
    case RUN_STATES.RUNNING_TOOL:
      return toolName ? `Running ${toolName} against PIPELINE.` : "Running an approved action.";
    case RUN_STATES.COMPLETE:
      return executedToolCount > 0
        ? `Done. ${executedToolCount} action(s) written to PIPELINE.`
        : "Done. Nothing was written — this was a read.";
    case RUN_STATES.FAILED:
      return `Failed${errorCode ? ` (${errorCode})` : ""}. Nothing was written.`;
    case RUN_STATES.CANCELED:
      return "Canceled. Nothing was written.";
    default:
      return "Unknown state.";
  }
}

/**
 * Legal transitions. Enforced so a run cannot report a state its work never
 * reached — e.g. jumping to complete without generating.
 */
const TRANSITIONS = {
  [RUN_STATES.NOT_CONNECTED]: [],
  [RUN_STATES.RETRIEVING]: [RUN_STATES.GENERATING, RUN_STATES.COMPLETE, RUN_STATES.FAILED, RUN_STATES.CANCELED],
  [RUN_STATES.GENERATING]: [RUN_STATES.AWAITING_APPROVAL, RUN_STATES.COMPLETE, RUN_STATES.FAILED, RUN_STATES.CANCELED],
  [RUN_STATES.AWAITING_APPROVAL]: [RUN_STATES.RUNNING_TOOL, RUN_STATES.COMPLETE, RUN_STATES.CANCELED, RUN_STATES.FAILED],
  [RUN_STATES.RUNNING_TOOL]: [RUN_STATES.COMPLETE, RUN_STATES.FAILED, RUN_STATES.GENERATING],
  [RUN_STATES.COMPLETE]: [],
  [RUN_STATES.FAILED]: [],
  [RUN_STATES.CANCELED]: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`[piper] illegal run transition ${from} -> ${to}`);
  }
  return to;
}

export const ALL_RUN_STATES = Object.freeze(Object.values(RUN_STATES));
