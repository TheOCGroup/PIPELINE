import { existsSync } from "node:fs";
/**
 * PIPELINE environment / configuration contract.
 *
 * Pure and testable: loadConfig() takes an env object (defaults to process.env)
 * and returns a validated, fully-resolved config. It never reads the OCG ONE
 * database path and never falls back to it. Error messages reference variable
 * NAMES only — never secret values.
 */

import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url)); // <app>/src/config
/** Application root: <app>/src/config -> <app>. */
export const APP_ROOT = resolve(__dirname, "../..");

// Auto-load .env from APP_ROOT if present
const rootEnv = resolve(APP_ROOT, ".env");
if (existsSync(rootEnv) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(rootEnv);
  } catch (_) {}
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8090,
  dbPath: "./runtime/pipeline.db",
  env: "development",
  ocgOneBaseUrl: "http://127.0.0.1:8080",
};

const MIN_SECRET_LEN = 16;
const asBool = (v) => String(v).toLowerCase() === "true";
const isWeak = (s) => !s || String(s).length < MIN_SECRET_LEN;

export function loadConfig(env = process.env) {
  const host = env.PIPELINE_HOST || DEFAULTS.host;

  const rawPort =
    env.PIPELINE_PORT !== undefined && String(env.PIPELINE_PORT).trim() !== ""
      ? env.PIPELINE_PORT
      : String(DEFAULTS.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid PIPELINE_PORT: must be an integer between 1 and 65535");
  }

  const rawDbPath =
    env.PIPELINE_DB_PATH && String(env.PIPELINE_DB_PATH).trim()
      ? String(env.PIPELINE_DB_PATH).trim()
      : DEFAULTS.dbPath;
  const dbPath = isAbsolute(rawDbPath) ? resolve(rawDbPath) : resolve(APP_ROOT, rawDbPath);

  const appEnv = (env.PIPELINE_ENV || DEFAULTS.env).toLowerCase();
  const integrationEnabled = asBool(env.PIPELINE_ALLOW_OCG_ONE_INTEGRATION);
  // Conversion is a deliberate cutover action. Keep production read-only until
  // the operator explicitly enables it after data migration verification.
  const readOnly = env.PIPELINE_READ_ONLY === undefined
    ? appEnv === "production"
    : asBool(env.PIPELINE_READ_ONLY);
  const sessionSecret = env.PIPELINE_SESSION_SECRET || "";
  const handoffSecret = env.PIPELINE_HANDOFF_SECRET || "";
  // Machine-to-machine intake boundary (Deal Findr / PIPER). Disabled unless
  // explicitly turned on, so a default deployment exposes no write path.
  const piperIntakeEnabled = asBool(env.PIPELINE_ENABLE_PIPER_INTAKE);
  const piperIntakeSecret = env.PIPELINE_PIPER_INTAKE_SECRET || "";

  // Founder operator credential. When set, `Authorization: Bearer <secret>`
  // on /api/v1/* authenticates the founder as operator with full pipeline
  // permissions. This is the direct-access path for the single-operator
  // deployment; the OCG ONE handoff remains the SSO path when integration
  // is enabled. Never logged, never returned to clients.
  const operatorSecret = env.PIPELINE_OPERATOR_SECRET || "";
  const OPERATOR_SECRET_MIN = 32;

  // Session TTL for handoff-created sessions (minutes). Absolute expiry,
  // no sliding refresh. Default 8 hours — an acquisition workday — instead
  // of a hard 15-minute logout in the middle of operator work.
  const sessionTtlMinutes = env.PIPELINE_SESSION_TTL_MINUTES === undefined
    || String(env.PIPELINE_SESSION_TTL_MINUTES).trim() === ""
    ? 480
    : Number(env.PIPELINE_SESSION_TTL_MINUTES);
  if (!Number.isInteger(sessionTtlMinutes) || sessionTtlMinutes < 5 || sessionTtlMinutes > 10080) {
    throw new Error("invalid PIPELINE_SESSION_TTL_MINUTES: must be an integer between 5 and 10080");
  }

  // Piper's model provider. Absent by default: Piper answers from stored state
  // deterministically, and only gains language understanding once a provider is
  // configured. Facts always come from retrieval, never from the model.
  const piperProvider = (env.PIPELINE_PIPER_PROVIDER || "none").toLowerCase();
  if (!["none", "openai-compatible", "anthropic", "vertex-ai"].includes(piperProvider)) {
    throw new Error("invalid PIPELINE_PIPER_PROVIDER: expected none, openai-compatible, anthropic, or vertex-ai");
  }
  const piperBaseUrl = env.PIPELINE_PIPER_BASE_URL || "";
  const piperModel = env.PIPELINE_PIPER_MODEL || "";
  const piperApiKey = env.PIPELINE_PIPER_API_KEY || "";
  // Vertex authenticates from ADC, so there is deliberately no key here.
  const piperGcpProject = env.PIPELINE_PIPER_GCP_PROJECT || "";
  const piperGcpLocation = env.PIPELINE_PIPER_GCP_LOCATION || "global";
  const piperTimeoutMs = Number(env.PIPELINE_PIPER_TIMEOUT_MS || 60000);
  if (!Number.isInteger(piperTimeoutMs) || piperTimeoutMs < 1000 || piperTimeoutMs > 600000) {
    throw new Error("invalid PIPELINE_PIPER_TIMEOUT_MS: must be an integer between 1000 and 600000");
  }
  if (piperProvider !== "none" && !piperModel) {
    throw new Error("PIPELINE_PIPER_MODEL is required when PIPELINE_PIPER_PROVIDER is set");
  }
  if (piperProvider === "openai-compatible" && !piperBaseUrl) {
    throw new Error("PIPELINE_PIPER_BASE_URL is required for the openai-compatible provider");
  }
  if (piperProvider === "anthropic" && !piperApiKey) {
    throw new Error("PIPELINE_PIPER_API_KEY is required for the anthropic provider");
  }
  if (piperProvider === "vertex-ai") {
    if (!piperGcpProject) {
      throw new Error("PIPELINE_PIPER_GCP_PROJECT is required for the vertex-ai provider");
    }
    if (piperApiKey) {
      // Refusing rather than ignoring: a key here means someone believes it is
      // being used, and Vertex authenticates from ADC instead.
      throw new Error("PIPELINE_PIPER_API_KEY must not be set for the vertex-ai provider; it authenticates from Application Default Credentials");
    }
  }
  const ocgOneBaseUrl = env.OCG_ONE_BASE_URL || DEFAULTS.ocgOneBaseUrl;

  const handoffIssuer = env.OCG_ONE_HANDOFF_ISSUER || "ocg-one";
  const handoffAudience = env.OCG_ONE_HANDOFF_AUDIENCE || "pipeline";
  
  let handoffPublicKeys = {};
  try {
    if (env.OCG_ONE_HANDOFF_PUBLIC_KEYS_JSON) {
      handoffPublicKeys = JSON.parse(env.OCG_ONE_HANDOFF_PUBLIC_KEYS_JSON);
    }
  } catch (err) {
    throw new Error("invalid OCG_ONE_HANDOFF_PUBLIC_KEYS_JSON: must be valid JSON");
  }

  let servicePublicKeys = {};
  try {
    if (env.OCG_ONE_SERVICE_PUBLIC_KEYS_JSON) {
      servicePublicKeys = JSON.parse(env.OCG_ONE_SERVICE_PUBLIC_KEYS_JSON);
    }
  } catch (err) {
    throw new Error("invalid OCG_ONE_SERVICE_PUBLIC_KEYS_JSON: must be valid JSON");
  }

  const serviceIssuer = env.OCG_ONE_SERVICE_ISSUER || "pipeline";
  const serviceAudience = env.OCG_ONE_SERVICE_AUDIENCE || "ocg-one-pipeline-integration";
  const servicePrivateKey = env.OCG_ONE_SERVICE_PRIVATE_KEY_B64
    ? Buffer.from(env.OCG_ONE_SERVICE_PRIVATE_KEY_B64, "base64").toString("utf8")
    : "";
  const serviceKeyId = env.OCG_ONE_SERVICE_KEY_ID || "";

  // Data source: 'empty' or 'fixtures'. Default to empty;
  // production defaults to empty and must never silently use fixtures.
  const dataSource = (env.PIPELINE_DATA_SOURCE || "empty").toLowerCase();
  if (dataSource !== "empty" && dataSource !== "fixtures") {
    throw new Error("invalid PIPELINE_DATA_SOURCE: must be 'empty' or 'fixtures'");
  }
  if (appEnv === "production" && dataSource === "fixtures") {
    throw new Error("PIPELINE_DATA_SOURCE=fixtures is not permitted in production");
  }

  // Fail closed: production integration must not run on weak/missing secrets.
  if (appEnv === "production" && integrationEnabled) {
    if (isWeak(sessionSecret)) {
      throw new Error(`PIPELINE_SESSION_SECRET is missing or too weak for production integration (min ${MIN_SECRET_LEN} chars)`);
    }
    if (Object.keys(handoffPublicKeys).length === 0) {
      throw new Error("OCG_ONE_HANDOFF_PUBLIC_KEYS_JSON is missing or empty in production with integration enabled");
    }
    if (Object.keys(servicePublicKeys).length === 0) {
      throw new Error("OCG_ONE_SERVICE_PUBLIC_KEYS_JSON is missing or empty in production with integration enabled");
    }
    if (!servicePrivateKey) {
      throw new Error("OCG_ONE_SERVICE_PRIVATE_KEY_B64 is missing in production with integration enabled");
    }
    if (!serviceKeyId) {
      throw new Error("OCG_ONE_SERVICE_KEY_ID is missing in production with integration enabled");
    }
  }

  // Write paths (intake, manual opportunity creation, stage moves, operator
  // state, committee review) are authenticated in production. If an operator
  // enables intake in production, refuse to boot on a guessable shared secret.
  if (appEnv === "production" && piperIntakeEnabled && isWeak(piperIntakeSecret)) {
    throw new Error(`PIPELINE_PIPER_INTAKE_SECRET is missing or too weak for production intake (min ${MIN_SECRET_LEN} chars)`);
  }

  // Fail closed: a production deployment with writes enabled must have an
  // operator credential. Without it, every operator/piper/work-room write
  // would be unauthenticated ("local-operator"). Refuse to boot instead.
  if (appEnv === "production" && !readOnly && !integrationEnabled) {
    if (!operatorSecret || operatorSecret.length < OPERATOR_SECRET_MIN) {
      throw new Error(`PIPELINE_OPERATOR_SECRET is required in production when PIPELINE_READ_ONLY=false and OCG ONE integration is disabled (min ${OPERATOR_SECRET_MIN} chars)`);
    }
  }
  if (operatorSecret && operatorSecret.length < OPERATOR_SECRET_MIN && appEnv === "production") {
    throw new Error(`PIPELINE_OPERATOR_SECRET is too weak for production (min ${OPERATOR_SECRET_MIN} chars)`);
  }

  return {
    host,
    port,
    dbPath,
    env: appEnv,
    integrationEnabled,
    readOnly,
    sessionSecret,
    handoffSecret,
    operatorSecret,
    operatorAuthEnabled: operatorSecret.length >= OPERATOR_SECRET_MIN,
    sessionTtlMinutes,
    piperIntakeEnabled,
    piperIntakeSecret,
    piperProvider,
    piperBaseUrl,
    piperModel,
    piperApiKey,
    piperGcpProject,
    piperGcpLocation,
    piperTimeoutMs,
    ocgOneBaseUrl,
    dataSource,
    handoffIssuer,
    handoffAudience,
    handoffPublicKeys,
    serviceIssuer,
    serviceAudience,
    servicePrivateKey,
    serviceKeyId,
    servicePublicKeys
  };
}
