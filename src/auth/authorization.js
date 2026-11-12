/**
 * PIPELINE role-to-permission matrix.
 *
 * API enforcement is performed by authMiddleware and the operator route layer.
 * The founder operator bearer receives the administrator permission set;
 * OCG ONE SSO role mapping remains gated until its signing keys and trust
 * configuration are provisioned and verified. See docs/architecture-boundary.md.
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
