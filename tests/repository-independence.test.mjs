import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");

function scanDir(dir, forbiddenRegexes, filesList = []) {
  const files = readdirSync(dir);
  for (const file of files) {
    if (file === "node_modules" || file === ".git" || file === "runtime" || file === "tests") continue;
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, forbiddenRegexes, filesList);
    } else if (stat.isFile() && (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".html") || file.endsWith(".json") || file.endsWith(".md"))) {
      const content = readFileSync(fullPath, "utf8");
      for (const { regex, label } of forbiddenRegexes) {
        if (regex.test(content)) {
          filesList.push({ file: fullPath, label });
        }
      }
    }
  }
  return filesList;
}

test("Independence: No references to OCG ONE codebase or runtimes", () => {
  const forbidden = [
    { regex: /import.*from.*"\.\.\/ocg-one/i, label: "relative import referencing OCG ONE" },
    { regex: /apps\/ocg-one\/runtime/i, label: "hardcoded OCG ONE runtime path" },
    { regex: /\.cache\/codex-runtimes/i, label: "Codex runtime path reference" },
  ];

  const violations = scanDir(APP_ROOT, forbidden);
  assert.equal(violations.length, 0, `Independence violations found:\n${JSON.stringify(violations, null, 2)}`);
});
