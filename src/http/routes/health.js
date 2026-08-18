/** GET /health — safe, unauthenticated liveness. Exposes no paths or secrets. */

import { applicationInfo } from "../../app/applicationInfo.js";

export function healthPayload({ db, config }) {
  let database = "unavailable";
  try {
    db.prepare("SELECT 1 AS ok").get();
    database = "available";
  } catch {
    database = "unavailable";
  }
  return {
    status: "ok",
    application: applicationInfo.name,
    service: applicationInfo.service,
    version: applicationInfo.version,
    database,
    integration: config.integrationEnabled ? "enabled" : "disabled",
    // Safe operational metadata only. Never expose keys, credentials, paths,
    // tokens, or provider secrets through this unauthenticated endpoint.
    piperProvider: config.piperProvider || "none",
    piperModelConfigured: Boolean(config.piperModel),
  };
}
