/**
 * PIPELINE runtime version guard.
 *
 * PIPELINE persists through the built-in `node:sqlite` module, which is only
 * available from Node 22.5 onward. Running on an older runtime fails deep in
 * the database layer with an opaque module error, so this guard runs first in
 * `server.js` and fails closed with an actionable message.
 *
 * The minimum mirrors `engines.node` in package.json — keep the two in step.
 */

export const MINIMUM_NODE_VERSION = "22.5.0";

const parse = (version) =>
  String(version)
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** @returns {{ok:true,version:string}|{ok:false,reason:string,version:string}} */
export function inspectNodeVersion(version = process.versions.node) {
  const [major, minor, patch] = parse(version);
  const [minMajor, minMinor, minPatch] = parse(MINIMUM_NODE_VERSION);

  const satisfied =
    major > minMajor ||
    (major === minMajor && minor > minMinor) ||
    (major === minMajor && minor === minMinor && patch >= minPatch);

  return satisfied
    ? { ok: true, version }
    : { ok: false, reason: "node_version_below_minimum", version };
}

/** Exits the process before boot unless the runtime can provide `node:sqlite`. */
export function assertNodeVersion(version = process.versions.node) {
  const verdict = inspectNodeVersion(version);
  if (!verdict.ok) {
    console.error(
      `[pipeline-runtime] Node ${MINIMUM_NODE_VERSION} or newer is required ` +
        `(running ${verdict.version}). PIPELINE uses the built-in node:sqlite module.`
    );
    process.exit(1);
  }
  return verdict.version;
}
