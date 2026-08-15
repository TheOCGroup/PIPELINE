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

  return { ok: true };
}
