// SPDX-License-Identifier: AGPL-3.0-or-later
// Build the workerd host: the Worker bundle and the capability runtime wrapper (a text module
// loaded into every capability's isolate). A checkout builds them from the TypeScript sources at
// start; the npm package ships them prebuilt (dist/host/, by scripts/build-npm.ts).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DIR, BUNDLED } from "../app-dir.ts";

/** A workspace package's folder, found by name (each exports its package.json). Checkout only. */
const packageDir = (name: string) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));

const common = {
  bundle: true,
  write: false,
  format: "esm" as const,
  platform: "neutral" as const,
  target: "es2023",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  mainFields: ["module", "main"],
  logLevel: "silent" as const,
};

/** The host's files, built from the sources: { "worker.js", "capability-runtime.js", "builder-brief.md" }. */
export async function buildHostFiles(root = APP_DIR): Promise<Record<string, string>> {
  const { build } = await import("esbuild");
  const host = packageDir("@hewntools/host-workerd");
  const worker = await build({
    ...common,
    entryPoints: [join(host, "src", "worker.ts")],
    external: ["cloudflare:*", "node:*", "./builder-brief.md", "./capability-runtime.js"],
  });
  const runtime = await build({
    ...common,
    entryPoints: [join(host, "src", "capability-main.ts")],
    external: ["cloudflare:*", "node:*", "./capability.js"],
  });
  const { readFileSync } = await import("node:fs");
  return {
    "worker.js": worker.outputFiles![0].text,
    "capability-runtime.js": runtime.outputFiles![0].text,
    "builder-brief.md": readFileSync(join(root, "spec", "builder-brief.md"), "utf8"),
  };
}

const HOST_FILES = ["worker.js", "capability-runtime.js", "builder-brief.md"];

/** Write worker.js, capability-runtime.js and builder-brief.md into `dir`. */
export async function buildHost(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (BUNDLED) {
    for (const f of HOST_FILES) copyFileSync(join(APP_DIR, "dist", "host", f), join(dir, f));
    return;
  }
  for (const [name, text] of Object.entries(await buildHostFiles())) writeFileSync(join(dir, name), text);
}

/** The web client's and the UI kit's static files. */
export const assetDirs = () =>
  BUNDLED ? { web: join(APP_DIR, "dist", "web"), ui: join(APP_DIR, "dist", "platform-ui") } : { web: join(packageDir("@hewntools/host-workerd"), "web"), ui: join(packageDir("@hewntools/ui"), "src") };
