import { verifyUserHandoffToken } from "./tokenService.js";

// Role ceilings mapping
export const ROLE_CEILINGS = {
  viewer: new Set(["pipeline.read"]),
  operator: new Set(["pipeline.read", "pipeline.manage", "pipeline.operator.preview"]),
  manager: new Set(["pipeline.read", "pipeline.manage", "pipeline.operator.preview", "pipeline.operator.apply"]),
  administrator: new Set(["pipeline.read", "pipeline.manage", "pipeline.operator.preview", "pipeline.operator.apply", "pipeline.admin"])
};

export const ALLOWED_ROLES = new Set(["viewer", "operator", "manager", "administrator"]);

/**
 * Verifies the handoff token and maps its roles/permissions.
 * 
 * @param {string} token - The raw JWS token
 * @param {object} options - { publicKeys, expectedIssuer, expectedAudience }
 * @returns {Promise<object>} - { ok: true, identity } or { ok: false, reason }
 */
export async function verifyAndMapHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience }) {
  const result = await verifyUserHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  const payload = result.payload;

  // 0. Validate contract version
  const contractVersion = payload.contract_version;
  if (!contractVersion || !contractVersion.startsWith("1.")) {
    return { ok: false, reason: "contract_version_mismatch" };
  }

  // 1. Normalize roles and permissions as arrays
  let rawRoles = [];
  if (Array.isArray(payload.roles)) {
    rawRoles = payload.roles;
  } else if (typeof payload.roles === "string") {
    rawRoles = [payload.roles];
  }

  let rawPermissions = [];
  if (Array.isArray(payload.permissions)) {
    rawPermissions = payload.permissions;
  } else if (typeof payload.permissions === "string") {
    rawPermissions = [payload.permissions];
  }

  // 2. Identify recognized roles (preserve multiple recognized roles)
  const recognizedRoles = rawRoles.filter(role => ALLOWED_ROLES.has(role));
  if (recognizedRoles.length === 0) {
    return { ok: false, reason: "no_recognized_role" };
  }

  // 3. Calculate union of ceilings for recognized roles
  const unionCeiling = new Set();
  for (const role of recognizedRoles) {
    const ceiling = ROLE_CEILINGS[role];
    if (ceiling) {
      for (const p of ceiling) {
        unionCeiling.add(p);
      }
    }
  }

  // 4. Intersect incoming permissions with the union ceiling
  const finalPermissions = rawPermissions.filter(p => unionCeiling.has(p));

  // 5. Require pipeline.read for successful access
  if (!finalPermissions.includes("pipeline.read")) {
    return { ok: false, reason: "missing_pipeline_read_permission" };
  }

  return {
    ok: true,
    identity: {
      subject: payload.sub,
      displayName: payload.name || "User",
      email: payload.email || "",
      roles: recognizedRoles,
      permissions: finalPermissions,
      destination: payload.destination || "/",
      jti: payload.jti,
      exp: payload.exp
    }
  };
}
