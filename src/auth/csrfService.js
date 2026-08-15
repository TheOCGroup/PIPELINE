import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const CSRF_TTL_MS = 15 * 60 * 1000; // 15 minutes matching session lifetime

export function generateCsrfToken() {
  return randomBytes(32).toString("hex");
}

export function hashCsrfToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function verifyCsrfToken(suppliedToken, storedHash, csrfIssuedAt) {
  if (!suppliedToken || !storedHash || !csrfIssuedAt) {
    return false;
  }

  // Check TTL
  const issuedTime = new Date(csrfIssuedAt).getTime();
  if (Date.now() - issuedTime > CSRF_TTL_MS) {
    return false;
  }

  const suppliedHash = hashCsrfToken(suppliedToken);
  const a = Buffer.from(suppliedHash, "hex");
  const b = Buffer.from(storedHash, "hex");

  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
