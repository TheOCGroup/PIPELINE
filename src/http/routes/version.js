/** GET /version — application and schema identity. */

import { applicationInfo } from "../../app/applicationInfo.js";
import { readSchemaVersion } from "../../database/migrationRunner.js";

export function versionPayload({ db, config }) {
  return {
    name: applicationInfo.name,
    service: applicationInfo.service,
    version: applicationInfo.version,
    schemaVersion: readSchemaVersion(db),
    runtimeMode: config.env,
    integrationContractVersion: applicationInfo.integrationContractVersion,
  };
}
