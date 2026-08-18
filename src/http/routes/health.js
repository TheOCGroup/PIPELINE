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
  };
}
