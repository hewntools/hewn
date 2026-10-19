// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

// Who may depend on whom (docs/internal/repo-layout.md). The licence line runs along these boundaries, and
// the core and the Worker run on workerd, so they may not reach for Node or for the CLI's code.
const PACKAGES = join(import.meta.dirname, "../packages");
const RULES: Record<string, { packages: string[]; external: (spec: string) => boolean }> = {
  spec: { packages: [], external: () => false },
  core: { packages: ["spec"], external: (s) => s === "@cfworker/json-schema" },
  "host-workerd": { packages: ["spec", "core"], external: (s) => s.startsWith("cloudflare:") || s === "node:async_hooks" || s.startsWith("@modelcontextprotocol/sdk") || s === "zod" || s.startsWith("zod/") },
  ui: { packages: [], external: () => false },
  cli: { packages: ["spec", "core", "host-workerd", "ui"], external: () => true },
  "test-host": { packages: ["spec", "core", "host-workerd", "ui", "cli"], external: () => true },
};

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|js|mjs)$/.test(f) ? [p] : [];
  });
}

test("every package depends only on what docs/internal/repo-layout.md allows", () => {
  const offenders: string[] = [];
  const found = [...readdirSync(PACKAGES).filter((d) => existsSync(join(PACKAGES, d, "package.json"))), "spec"];
  assert.deepEqual(found.sort(), Object.keys(RULES).sort(), "packages/ and the rules list the same packages");
  for (const [name, rule] of Object.entries(RULES)) {
    const root = name === "spec" ? join(PACKAGES, "..", "spec") : join(PACKAGES, name);
    for (const file of sources(join(root, "src"))) {
      const at = relative(PACKAGES, file);
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gm)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (spec.startsWith(".")) {
          if (!resolve(dirname(file), spec).startsWith(root + "/")) offenders.push(`${at}: ${spec} (outside the package; import it by name)`);
          continue;
        }
        const pkg = /^@hewntools\/([^/]+)/.exec(spec)?.[1];
        if (pkg) {
          if (pkg !== name && !rule.packages.includes(pkg)) offenders.push(`${at}: ${spec}`);
          continue;
        }
        if (!rule.external(spec)) offenders.push(`${at}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
