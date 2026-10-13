import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const target = (ctx) => resolve(process.env.AIDEN_CALL_RECORD_FILE || resolve(dirname(ctx.config.dbPath), "aiden-call-records.jsonl"));

function auth(req) {
  const secret = process.env.AIDEN_CALL_INTAKE_TOKEN || "";
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (secret.length < 32 || supplied.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
}
function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("too_large");
  }
  return JSON.parse(text);
}
export async function handleAidenCallIntegration(req, res, ctx) {
  if (!auth(req)) return send(res, 401, { ok: false, error: "unauthorized" });
  if (req.method === "POST") {
    let record;
    try { record = await readBody(req); }
    catch { return send(res, 400, { ok: false, error: "invalid_report" }); }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" ||
        record.id.length > 160 || !record.id || typeof record.message !== "string") {
      return send(res, 400, { ok: false, error: "invalid_report" });
    }
    const file = target(ctx);
    await mkdir(dirname(file), { recursive: true });
    // Retries are idempotent: suppress duplicates keyed by the Vapi call ID.
    let previous = "";
    try { previous = await readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!previous.split("\n").some(line => {
      if (!line) return false;
      try { return JSON.parse(line).id === record.id; } catch { return false; }
    })) await appendFile(file, JSON.stringify(record) + "\n", "utf8");
    return send(res, 200, { ok: true, id: record.id });
  }
  if (req.method === "GET") {
    let raw = "";
    try { raw = await readFile(target(ctx), "utf8"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    const records = raw.split(/\r?\n/).filter(Boolean).slice(-50).reverse().map(line => JSON.parse(line));
    return send(res, 200, { ok: true, messages: records });
  }
  return send(res, 405, { ok: false, error: "method_not_allowed" });
}
