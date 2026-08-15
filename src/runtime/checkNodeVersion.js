/**
 * Independent Node runtime check. PIPELINE requires Node >= 22.5 (built-in
 * node:sqlite). This is a self-contained prerequisite — PIPELINE does not depend
 * on any OCG ONE runtime.
 */

export const MIN_NODE = { major: 22, minor: 5 };

export function isSupportedNode(versionString = process.versions.node) {
  const [major, minor] = String(versionString).split(".").map((n) => parseInt(n, 10));
  if (!Number.isInteger(major)) return false;
  if (major > MIN_NODE.major) return true;
  if (major < MIN_NODE.major) return false;
  return (Number.isInteger(minor) ? minor : 0) >= MIN_NODE.minor;
}

export function assertNodeVersion(versionString = process.versions.node) {
  if (!isSupportedNode(versionString)) {
    throw new Error(
      `OCG PIPELINE requires Node.js >= ${MIN_NODE.major}.${MIN_NODE.minor} (found ${versionString}). ` +
        "Install a supported Node runtime; PIPELINE has no bundled runtime and no dependency on any other app."
    );
  }
}
