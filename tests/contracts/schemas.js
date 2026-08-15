export const USER_HANDOFF_CLAIMS = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "UserHandoffClaims",
  "type": "object",
  "properties": {
    "iss": { "type": "string" },
    "aud": { "type": "string" },
    "sub": { "type": "string" },
    "jti": { "type": "string" },
    "iat": { "type": "integer" },
    "nbf": { "type": "integer" },
    "exp": { "type": "integer" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "roles": {
      "type": "array",
      "items": { "type": "string" }
    },
    "permissions": {
      "type": "array",
      "items": { "type": "string" }
    },
    "destination": { "type": "string" },
    "contract_version": { "type": "string" }
  },
  "required": ["iss", "aud", "sub", "jti", "iat", "nbf", "exp", "roles", "permissions", "contract_version"]
}`;

export const SERVICE_TOKEN_CLAIMS = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ServiceTokenClaims",
  "type": "object",
  "properties": {
    "iss": { "type": "string" },
    "aud": { "type": "string" },
    "sub": { "type": "string" },
    "jti": { "type": "string" },
    "iat": { "type": "integer" },
    "nbf": { "type": "integer" },
    "exp": { "type": "integer" },
    "scope": { "type": "string", "enum": ["ocg-one.pipeline.read"] },
    "method": { "type": "string", "enum": ["GET"] },
    "path": { "type": "string" },
    "contract_version": { "type": "string" }
  },
  "required": ["iss", "aud", "sub", "jti", "iat", "nbf", "exp", "scope", "method", "path", "contract_version"]
}`;

export const HANDOFF_RESPONSE = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "HandoffResponse",
  "type": "object",
  "properties": {
    "ok": { "type": "boolean" },
    "meta": {
      "type": "object",
      "properties": {
        "contractVersion": { "type": "string" },
        "correlationId": { "type": "string" }
      },
      "required": ["contractVersion", "correlationId"]
    },
    "data": {
      "type": "object",
      "properties": {
        "token": { "type": "string" },
        "expiresAt": { "type": "string" },
        "destination": { "type": "string" }
      },
      "required": ["token", "expiresAt", "destination"]
    }
  },
  "required": ["ok", "meta", "data"]
}`;

export const PROPERTY_RESPONSE = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PropertyResponse",
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "recordType": { "type": "string", "enum": ["property"] },
    "address": { "type": "string" },
    "status": { "type": "string" },
    "ownerPersonIds": {
      "type": "array",
      "items": { "type": "string" }
    },
    "updatedAt": { "type": "string" }
  },
  "required": ["id", "recordType", "address", "status", "ownerPersonIds", "updatedAt"]
}`;

export const PERSON_RESPONSE = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PersonResponse",
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "recordType": { "type": "string", "enum": ["person"] },
    "displayName": { "type": "string" },
    "emailPresent": { "type": "boolean" },
    "phonePresent": { "type": "boolean" },
    "role": { "type": "string" },
    "updatedAt": { "type": "string" }
  },
  "required": ["id", "recordType", "displayName", "emailPresent", "phonePresent", "role", "updatedAt"]
}`;

export const LEAD_RESPONSE = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "LeadResponse",
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "recordType": { "type": "string", "enum": ["lead"] },
    "leadSource": { "type": "string" },
    "classification": { "type": "string" },
    "stale": { "type": "boolean" },
    "propertyId": { "type": "string" },
    "personIds": {
      "type": "array",
      "items": { "type": "string" }
    },
    "updatedAt": { "type": "string" }
  },
  "required": ["id", "recordType", "leadSource", "classification", "stale", "propertyId", "personIds", "updatedAt"]
}`;

export const ERROR_RESPONSE = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ErrorResponse",
  "type": "object",
  "properties": {
    "ok": { "type": "boolean", "enum": [false] },
    "error": { "type": "string" },
    "code": { "type": "string" },
    "correlationId": { "type": "string" }
  },
  "required": ["ok", "error"]
}`;

export const ROLE_MAPPING = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "RoleMapping",
  "type": "object",
  "properties": {
    "roles": {
      "type": "array",
      "items": { "type": "string", "enum": ["viewer", "operator", "manager", "administrator"] }
    }
  },
  "required": ["roles"]
}`;

export const PERMISSION_MAPPING = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PermissionMapping",
  "type": "object",
  "properties": {
    "permissions": {
      "type": "array",
      "items": { "type": "string", "enum": ["pipeline.read", "pipeline.manage", "pipeline.operator.preview", "pipeline.operator.apply", "pipeline.admin"] }
    }
  },
  "required": ["permissions"]
}`;
