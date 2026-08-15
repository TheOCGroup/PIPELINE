function sections(text) {
  const result = [];
  let current = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const split = line.indexOf(":");
    if (split < 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (key === "user-agent") {
      current = { agent: value.toLowerCase(), disallow: [], allow: [] };
      result.push(current);
    } else if (current && (key === "disallow" || key === "allow")) {
      current[key].push(value);
    }
  }
  return result;
}

export function isPathAllowedByRobots(text, targetUrl, userAgent = "ocg-piper") {
  const path = new URL(targetUrl).pathname || "/";
  const agent = userAgent.toLowerCase();
  const applicable = sections(text).filter((section) => section.agent === "*" || agent.includes(section.agent));
  const rules = applicable.flatMap((section) => [
    ...section.disallow.filter(Boolean).map((value) => ({ type: "disallow", value })),
    ...section.allow.filter(Boolean).map((value) => ({ type: "allow", value })),
  ]).filter((rule) => path.startsWith(rule.value)).sort((a, b) => b.value.length - a.value.length);
  return rules[0]?.type !== "disallow";
}

export async function robotsAllows(fetchImpl, targetUrl, userAgent) {
  const url = new URL(targetUrl);
  const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
  try {
    const response = await fetchImpl(robotsUrl, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return true;
    return isPathAllowedByRobots(await response.text(), targetUrl, userAgent);
  } catch {
    return true;
  }
}
