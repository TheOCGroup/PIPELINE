import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as schemas from "./contracts/schemas.js";

// Exact SHA-256 hashes generated from the schema files to verify zero structural drift.
const EXPECTED_HASHES = {
  ERROR_RESPONSE: "7cbfd4888e63d51d6c8fd105e61a950b96f819bb4301fd3204ab9c15429f02d4",
  HANDOFF_RESPONSE: "d8be25b6692f711a42f163cf597c86f8963db29ab7518b37c9215654cd40369f",
  LEAD_RESPONSE: "2d174b13d9f5db8b2b5e0094945194f074307447ddaf011ec642d91ed7662aad",
  PERMISSION_MAPPING: "a8de2172179c35e7009f31da33843817443be165e22d4130b0f3fb2f8935785f",
  PERSON_RESPONSE: "6e7035f4c2856fba7908cdd417b02eea7802fc73341d454725f2aeb62c497ff1",
  PROPERTY_RESPONSE: "5802d6dde21de06da1fc5792e30a72a6768574a932e3c5d6cf1ce0e8894da62b",
  ROLE_MAPPING: "3b23f0a40a5983b7b2a936557f9d372bb988b4b280120c685611007fe78ab0df",
  SERVICE_TOKEN_CLAIMS: "8ad8215c397a5f497d5bc54625bda8f36b2a070f6f6010770183f0186cd92375",
  USER_HANDOFF_CLAIMS: "812a0ccb6108c3baaa1e231cb1e35beaa71ab964493994c49f52fc4f7821f9a5"
};

function hashString(str) {
  // Normalize newline endings to ensure cross-platform hash consistency
  const normalized = str.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized).digest("hex");
}

test("contract schemas match certified hashes (no drift)", () => {
  for (const [name, schemaStr] of Object.entries(schemas)) {
    const hash = hashString(schemaStr);
    assert.equal(hash, EXPECTED_HASHES[name], `Schema ${name} has drifted!`);
  }
});
