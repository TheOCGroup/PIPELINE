/**
 * PIPELINE authorization model (definitions only for Phase 3C).
 *
 * Roles and permissions are declared here for later enforcement. No Phase 3C
 * route performs a production operator action, so nothing is enforced yet beyond
 * the handoff stub. The model is documented in docs/architecture-boundary.md.
 */

export const ROLES = Object.freeze(["viewer", "operator", "manager", "administrator"]);

export const PERMISSIONS = Object.freeze([
  "pipeline.read",
  "pipeline.manage",
  "pipeline.operator.preview",
  "pipeline.operator.apply",
  "pipeline.admin",
]);

export const ROLE_PERMISSIONS = Object.freeze({
  viewer: ["pipeline.read"],
  operator: ["pipeline.read", "pipeline.operator.preview", "pipeline.operator.apply"],
  manager: ["pipeline.read", "pipeline.manage", "pipeline.operator.preview"],
  administrator: ["pipeline.read", "pipeline.manage", "pipeline.operator.preview", "pipeline.operator.apply", "pipeline.admin"],
});

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

export function can(role, permission) {
  return permissionsFor(role).includes(permission);
}
