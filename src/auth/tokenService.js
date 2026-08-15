import { jwtVerify, importSPKI, SignJWT, importPKCS8, decodeProtectedHeader } from "jose";

export async function verifyUserHandoffToken(token, { publicKeys, expectedIssuer, expectedAudience }) {
  if (typeof token !== "string" || !token) {
    return { ok: false, reason: "missing_token" };
  }

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch (err) {
    return { ok: false, reason: "unsigned_or_malformed_token" };
  }

  if (!header || header.alg !== "RS256") {
    return { ok: false, reason: "invalid_algorithm" };
  }

  if (header.typ !== "JWT") {
    return { ok: false, reason: "invalid_token_type" };
  }

  const kid = header.kid;
  if (!kid) {
    return { ok: false, reason: "missing_kid" };
  }

  const pem = publicKeys[kid];
  if (!pem) {
    return { ok: false, reason: "unknown_kid" };
  }

  let publicKey;
  try {
    publicKey = await importSPKI(pem, "RS256");
  } catch (err) {
    return { ok: false, reason: "invalid_public_key" };
  }

  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      clockTolerance: "5s",
      algorithms: ["RS256"]
    });

    const iat = payload.iat;
    const exp = payload.exp;
    if (!iat || !exp) {
      return { ok: false, reason: "missing_time_claims" };
    }
    if (exp - iat > 120) {
      return { ok: false, reason: "excessive_ttl" };
    }

    return { ok: true, payload };
  } catch (err) {
    let reason = "verification_failed";
    if (err.code === "ERR_JWT_EXPIRED") {
      reason = "expired_token";
    } else if (err.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      reason = "claim_failed";
    }
    return { ok: false, reason };
  }
}

export async function signUserHandoffToken(privateKeyPem, { keyId, issuer, audience, subject, name, email, roles, permissions, destination, jti }) {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  
  return await new SignJWT({
    name,
    email,
    roles,
    permissions,
    destination,
    contract_version: "1.0.0"
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120) // TTL <= 120s
    .sign(privateKey);
}

export async function verifyServiceToken(token, { publicKeys, expectedIssuer, expectedAudience }) {
  if (typeof token !== "string" || !token) {
    return { ok: false, reason: "missing_token" };
  }

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch (err) {
    return { ok: false, reason: "unsigned_or_malformed_token" };
  }

  if (!header || header.alg !== "RS256") {
    return { ok: false, reason: "invalid_algorithm" };
  }

  if (header.typ !== "JWT") {
    return { ok: false, reason: "invalid_token_type" };
  }

  const kid = header.kid;
  if (!kid) {
    return { ok: false, reason: "missing_kid" };
  }

  const pem = publicKeys[kid];
  if (!pem) {
    return { ok: false, reason: "unknown_kid" };
  }

  let publicKey;
  try {
    publicKey = await importSPKI(pem, "RS256");
  } catch (err) {
    return { ok: false, reason: "invalid_public_key" };
  }

  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      clockTolerance: "5s",
      algorithms: ["RS256"]
    });

    const iat = payload.iat;
    const exp = payload.exp;
    if (!iat || !exp) {
      return { ok: false, reason: "missing_time_claims" };
    }
    if (exp - iat > 60) {
      return { ok: false, reason: "excessive_ttl" };
    }

    return { ok: true, payload };
  } catch (err) {
    let reason = "verification_failed";
    if (err.code === "ERR_JWT_EXPIRED") {
      reason = "expired_token";
    } else if (err.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      reason = "claim_failed";
    }
    return { ok: false, reason };
  }
}

export async function signServiceToken(privateKeyPem, { keyId, issuer, audience, subject, method, path, jti }) {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  
  return await new SignJWT({
    scope: "ocg-one.pipeline.read",
    method,
    path,
    contract_version: "1.0.0"
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 60) // TTL <= 60s
    .sign(privateKey);
}
