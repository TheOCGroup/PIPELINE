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

function parseDiscoverySources(raw, appEnv) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("invalid PIPELINE_PIPER_DISCOVERY_SOURCES_JSON: must be valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length > 50) {
    throw new Error("invalid PIPELINE_PIPER_DISCOVERY_SOURCES_JSON: expected an array of at most 50 sources");
  }
  return parsed.map((source, index) => {
    if (!source || typeof source !== "object") throw new Error(`invalid PIPER discovery source at index ${index}`);
    const url = String(source.url || "");
    let parsedUrl;
    try { parsedUrl = new URL(url); }
    catch { throw new Error(`invalid PIPER discovery source URL at index ${index}`); }
    if (!["http:", "https:"].includes(parsedUrl.protocol) || (appEnv === "production" && parsedUrl.protocol !== "https:")) {
      throw new Error(`invalid PIPER discovery source protocol at index ${index}`);
    }
    const format = String(source.format || "").toLowerCase();
    if (!["json", "jsonld", "rss"].includes(format)) throw new Error(`invalid PIPER discovery source format at index ${index}`);
    return {
      id: source.id ? String(source.id).slice(0, 100) : undefined,
      name: String(source.name || parsedUrl.hostname).slice(0, 120),
      url: parsedUrl.toString(),
      format,
      enabled: source.enabled !== false,
      respectRobots: source.respectRobots !== false,
      configuration: source.configuration && typeof source.configuration === "object" ? source.configuration : {},
    };
  });
}

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
  const piperIntakeEnabled = asBool(env.PIPELINE_ENABLE_PIPER_INTAKE);
  const piperIntakeSecret = env.PIPELINE_PIPER_INTAKE_SECRET || "";
  const piperDiscoveryEnabled = asBool(env.PIPELINE_ENABLE_PIPER_DISCOVERY);
  const piperDiscoverySources = parseDiscoverySources(env.PIPELINE_PIPER_DISCOVERY_SOURCES_JSON, appEnv);
  const piperDiscoveryIntervalMinutes = Number(env.PIPELINE_PIPER_DISCOVERY_INTERVAL_MINUTES || 60);
  if (!Number.isInteger(piperDiscoveryIntervalMinutes) || piperDiscoveryIntervalMinutes < 5 || piperDiscoveryIntervalMinutes > 1440) {
    throw new Error("invalid PIPELINE_PIPER_DISCOVERY_INTERVAL_MINUTES: must be an integer between 5 and 1440");
  }
  const piperDiscoveryUserAgent = env.PIPELINE_PIPER_DISCOVERY_USER_AGENT || "OCG-PIPER/1.0 (+https://ocgict.com)";
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

  if (appEnv === "production" && piperIntakeEnabled && isWeak(piperIntakeSecret)) {
    throw new Error(`PIPELINE_PIPER_INTAKE_SECRET is missing or too weak for production intake (min ${MIN_SECRET_LEN} chars)`);
  }
  if (appEnv === "production" && piperDiscoveryEnabled && piperDiscoverySources.length === 0) {
    throw new Error("PIPELINE_PIPER_DISCOVERY_SOURCES_JSON is required when production discovery is enabled");
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
    piperIntakeEnabled,
    piperIntakeSecret,
    piperDiscoveryEnabled,
    piperDiscoverySources,
    piperDiscoveryIntervalMinutes,
    piperDiscoveryUserAgent,
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
