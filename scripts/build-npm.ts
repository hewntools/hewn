// SPDX-License-Identifier: AGPL-3.0-or-later
// Build the npm packages into build/npm/ (nothing is published here; see docs/internal/releasing.md):
//   cli/   @hewntools/cli: the CLI bundled to dist/cli.js, the workerd host prebuilt (dist/host/),
//          the web client (dist/web/) and the UI kit (dist/platform-ui/)
//   spec/  @hewntools/spec: the contract compiled to JavaScript with type declarations, and its JSON Schemas
// Run: npm run build:npm   Then: npm pack build/npm/cli (a tarball, local only).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { buildHostFiles } from "../packages/cli/src/supervisor/bundle.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "build", "npm");
const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
/** What the published CLI installs: the two native runtimes it starts (bundling can't carry their binaries). */
const RUNTIME_DEPS = ["workerd", "esbuild"];

const write = (path: string, text: string) => (mkdirSync(resolve(path, ".."), { recursive: true }), writeFileSync(path, text));
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

async function cli() {
  const out = join(OUT, "cli");
  rmSync(out, { recursive: true, force: true });
  await build({
    entryPoints: [join(ROOT, "packages", "cli", "src", "cli.ts")],
    outfile: join(out, "dist", "cli.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: RUNTIME_DEPS,
    define: { __HEWN_BUNDLED__: "true" },
    // Bundled CommonJS dependencies may require() Node's built-ins. (esbuild keeps cli.ts's shebang on top.)
    banner: { js: 'import { createRequire as __hewnRequire } from "node:module";\nconst require = __hewnRequire(import.meta.url);' },
    legalComments: "linked",
    logLevel: "warning",
  });
  chmodSync(join(out, "dist", "cli.js"), 0o755);

  for (const [name, text] of Object.entries(await buildHostFiles(ROOT))) write(join(out, "dist", "host", name), text);
  cpSync(join(ROOT, "packages", "host-workerd", "web"), join(out, "dist", "web"), { recursive: true });
  cpSync(join(ROOT, "packages", "ui", "src"), join(out, "dist", "platform-ui"), { recursive: true });
  copyFileSync(join(ROOT, "packages", "ui", "LICENSE"), join(out, "dist", "platform-ui", "LICENSE"));
  for (const f of ["LICENSE", "LICENSING.md"]) copyFileSync(join(ROOT, f), join(out, f));
  for (const f of ["README.md", "CHANGELOG.md"]) write(join(out, f), absoluteLinks(readFileSync(join(ROOT, f), "utf8")));

  write(
    join(out, "package.json"),
    json({
      name: "@hewntools/cli",
      version: root.version,
      description: root.description,
      license: root.license,
      homepage: "https://hewn.tools",
      repository: { type: "git", url: "git+https://github.com/hewntools/hewn.git", directory: "packages/cli" },
      bugs: "https://github.com/hewntools/hewn/issues",
      type: "module",
      bin: { hewn: "dist/cli.js" },
      files: ["dist", "README.md", "LICENSE", "LICENSING.md", "CHANGELOG.md"],
      engines: root.engines,
      dependencies: Object.fromEntries(RUNTIME_DEPS.map((d) => [d, root.dependencies[d]])),
      publishConfig: { access: "public" },
    }),
  );
}

async function spec() {
  const src = join(ROOT, "spec");
  const out = join(OUT, "spec");
  rmSync(out, { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  // JavaScript: each module on its own, with its relative imports pointing at .js.
  for (const f of readdirSync(join(src, "src")).filter((f) => f.endsWith(".ts"))) {
    const r = await build({ entryPoints: [join(src, "src", f)], bundle: false, write: false, format: "esm", platform: "neutral", target: "es2023", logLevel: "warning" });
    write(join(out, "dist", f.replace(/\.ts$/, ".js")), r.outputFiles[0].text.replace(/(from\s+["']\.\.?\/[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
  // Type declarations, with the same rewrite.
  const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(ROOT, "spec", "tsconfig.build.json"), "--outDir", join(out, "types")], { encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`spec declarations failed:\n${tsc.stdout}${tsc.stderr}`);
  for (const f of readdirSync(join(out, "types"))) {
    const p = join(out, "types", f);
    writeFileSync(join(out, "dist", f), readFileSync(p, "utf8").replace(/(from\s+["']\.\.?\/[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
  rmSync(join(out, "types"), { recursive: true });
  cpSync(join(src, "schemas"), join(out, "schemas"), { recursive: true });
  for (const f of readdirSync(src).filter((f) => f.endsWith(".md") || f === "LICENSE")) copyFileSync(join(src, f), join(out, f));
  write(
    join(out, "package.json"),
    json({
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      homepage: "https://hewn.tools",
      repository: { type: "git", url: "git+https://github.com/hewntools/hewn.git", directory: "spec" },
      bugs: "https://github.com/hewntools/hewn/issues",
      type: "module",
      exports: { "./package.json": "./package.json", "./schemas/*": "./schemas/*", "./*.ts": { types: "./dist/*.d.ts", default: "./dist/*.js" }, "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
      files: ["dist", "schemas", "*.md", "LICENSE"],
      publishConfig: { access: "public" },
    }),
  );
}

await cli();
await spec();
console.log(`✔ build/npm/cli (@hewntools/cli ${root.version}) and build/npm/spec`);

/**
 * npmjs.com shows the package's README, but resolves relative links against the package's folder
 * in the repo (packages/cli), where docs/ isn't. Point them at the repo on GitHub instead.
 */
function absoluteLinks(md: string): string {
  const REPO = "https://github.com/hewntools/hewn/blob/main/";
  const RAW = "https://raw.githubusercontent.com/hewntools/hewn/main/";
  const abs = (url: string) => (/^([a-z]+:|#|\/)/.test(url) ? url : (/\.(svg|png|jpe?g|gif)$/i.test(url) ? RAW : REPO) + url);
  return md
    .replace(/\]\(([^)\s]+)\)/g, (_, url) => `](${abs(url)})`)
    .replace(/\b(href|src|srcset)="([^"]+)"/g, (_, attr, url) => `${attr}="${abs(url)}"`);
}
