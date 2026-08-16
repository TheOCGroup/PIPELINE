/**
 * Authorization for the intake boundary.
 *
 * Intake is the ONLY write path in PIPELINE: a single request inserts across
 * seller_opportunities, seller_opportunity_sources, source_provenance,
 * record_classifications, classification_history and operational_audit_events.
 * It is dispatched ahead of the session/S2S branch in createServer.js, so it
 * carries its own gate and that gate must fail closed.
 *
 * Three refusals, in this order:
 *   1. disabled      — the feature flag is off, so the write path does not exist
 *   2. unauthorized  — the shared secret did not match
 *   3. read_only     — the deployment forbids mutations
 *
 * Read-only is evaluated only AFTER the caller authenticates, so an anonymous
 * request cannot probe the deployment's mutation posture. The 401 is generic
 * and the comparison is constant-time: a caller learns only that the secret was
 * wrong, never how wrong.
 */

import { timingSafeEqual } from "node:crypto";

function equalSecret(actual, expected) {
  const left = Buffer.from(String(actual || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  if (left.length !== right.length || right.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function authorizePiperIntake(req, config) {
  if (!config.piperIntakeEnabled) {
    return { ok: false, status: 503, error: "piper_intake_disabled" };
  }

  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!equalSecret(supplied, config.piperIntakeSecret)) {
    return { ok: false, status: 401, error: "piper_intake_unauthorized" };
  }

  // Mirrors the refusal the conversion route already returns, so every mutation
  // in the application answers read-only mode the same way.
  if (config.readOnly === true) {
    return { ok: false, status: 503, error: "read_only" };
  }

  return { ok: true };
}
