import { sendJson } from "../response.js";
import { ingestPiperListing } from "../../services/piperIntakeService.js";
export { normalizePropertyAddress } from "../../domain/properties/addressNormalization.js";

export async function handleDealFindrIntake(req, res, ctx) {
  let body;
  try {
    const buffers = [];
    for await (const chunk of req) buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    body = Buffer.concat(buffers).toString("utf8");
  } catch {
    return sendJson(res, 500, { ok: false, error: "read_error" });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  try {
    const result = ingestPiperListing(ctx.db, payload);
    return sendJson(res, result.duplicate ? 200 : 201, {
      ok: true,
      duplicate: result.duplicate,
      opportunityId: result.opportunityId,
      opportunityCode: result.opportunityCode,
      piperScore: result.score,
      scoreReasons: result.reasons,
    });
  } catch (error) {
    const status = error.status || 500;
    return sendJson(res, status, {
      ok: false,
      error: status === 500 ? "intake_transaction_failed" : (error.code || "invalid_intake"),
    });
  }
}
