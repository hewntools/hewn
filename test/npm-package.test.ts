// SPDX-License-Identifier: AGPL-3.0-or-later
// The npm packages as built for publishing (scripts/build-npm.ts): what's in them, and that they run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";
import { newestInLine, publishedTags } from "@hewntools/cli/upgrade.ts";
import { DOC_PAGES } from "@hewntools/core/docs.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "build", "npm", "cli");
const SPEC = join(ROOT, "build", "npm", "spec");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)).map((x) => `${f}/${x}`) : [f]));
const packed = (dir: string): string[] => JSON.parse(spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" }).stdout)[0].files.map((f: { path: string }) => f.path);

describe("the npm packages", () => {
  before(() => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "scripts", "build-npm.ts")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  test("@hewntools/cli ships the bundle, the prebuilt host, the web client, the UI kit, the docs pages, the Official tools and the licences; nothing else", () => {
    const pkg = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8"));
    assert.equal(pkg.name, "@hewntools/cli");
    assert.equal(pkg.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    assert.deepEqual(pkg.bin, { hewn: "dist/cli.js" });
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["esbuild", "workerd"]);
    assert.equal(pkg.private, undefined);
    const list = packed(CLI);
    for (const f of list) assert.match(f, /^(dist\/(cli\.js|host\/(worker\.js|capability-runtime\.js|builder-brief\.md)|web\/.+|platform-ui\/.+|seeds\/.+|docs\/(spec\/)?([\w-]+\.md|LICENSE))|README\.md|LICENSE|LICENSING\.md|CHANGELOG\.md|package\.json)$/, f);
    for (const f of ["dist/cli.js", "dist/host/worker.js", "dist/web/index.html", "dist/platform-ui/session.js", "dist/platform-ui/LICENSE", "dist/docs/spec/LICENSE", "dist/seeds/shelf.json", "dist/seeds/habits/capability.json", "dist/seeds/LICENSE", "LICENSE"]) assert.ok(list.includes(f), f);
    for (const f of files(join(ROOT, "packages", "host-workerd", "web"))) assert.ok(list.includes(`dist/web/${f}`), `the web client's ${f}`);
    // Every tool on the shelf with its listing (the Hub leaves out a tool without one, silently).
    for (const id of JSON.parse(readFileSync(join(ROOT, "seeds", "shelf.json"), "utf8")).tools) assert.ok(list.includes(`dist/seeds/${id}/.hub/listing.json`), `${id}'s listing`);
    // The docs hewn_docs and the intake read, where assetDirs() looks for them: docs/x.md in dist/docs/, spec/x.md in dist/docs/spec/.
    for (const page of DOC_PAGES) {
      const f = `dist/docs/${page.replace(/^docs\//, "")}`;
      assert.ok(list.includes(f), f);
      assert.equal(readFileSync(join(CLI, f), "utf8"), readFileSync(join(ROOT, page), "utf8"), f);
    }
  });

  test("no paths from the machine it was built on", () => {
    for (const dir of [join(CLI, "dist"), join(SPEC, "dist")]) {
      for (const f of files(dir)) {
        const text = readFileSync(join(dir, f), "utf8");
        for (const bad of [homedir(), ROOT, "/Users/"]) {
          const at = text.indexOf(bad);
          assert.equal(at, -1, `${f}: …${text.slice(Math.max(0, at - 40), at + 60)}…`);
        }
      }
    }
  });

  test("the bundle runs as plain JavaScript and knows it's the npm package", () => {
    const r = spawnSync(process.execPath, [join(CLI, "dist", "cli.js"), "version"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")).version);
    assert.match(readFileSync(join(CLI, "dist", "cli.js"), "utf8").split("\n")[0], /^#!\/usr\/bin\/env -S node /);
  });

  test("@hewntools/spec ships JavaScript and declarations that import each other as .js", async () => {
    const list = packed(SPEC);
    assert.ok(list.includes("dist/manifest.js") && list.includes("dist/manifest.d.ts") && list.includes("schemas/capability.schema.json"));
    for (const f of list.filter((f) => f.startsWith("dist/"))) assert.doesNotMatch(readFileSync(join(SPEC, f), "utf8"), /from\s+["']\.\.?\/[^"']+\.ts["']/, f);
    const abi = await import(join(SPEC, "dist", "abi.js"));
    assert.ok(Object.keys(abi).length > 0);
  });
});

describe("the one-line install (hewn.tools/install.sh)", () => {
  test("installs the package with npm and says what's next; falls back to ~/.local when npm's folder isn't writable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hewn-webinst-"));
    try {
      const tgz = join(tmp, JSON.parse(spawnSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: CLI, encoding: "utf8" }).stdout)[0].filename);
      const locked = join(tmp, "locked");
      mkdirSync(join(locked, "lib", "node_modules"), { recursive: true });
      chmodSync(join(locked, "lib", "node_modules"), 0o555);
      const home = join(tmp, "home");
      mkdirSync(home);
      const script = readFileSync(join(ROOT, "scripts", "web-install.sh"), "utf8");
      // As `curl … | sh`: the script on stdin. npm's global folder: a read-only one.
      const r = spawnSync("sh", [], { input: script, encoding: "utf8", env: { ...process.env, HOME: home, npm_config_prefix: locked, npm_config_offline: "false", HEWN_PACKAGE: tgz } });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /needs sudo; installing into .*\/home\/\.local instead/);
      assert.match(r.stdout, /✔ Hewn \d+\.\d+\.\d+/);
      assert.match(r.stdout, /hewn service install/);
      assert.ok(existsSync(join(home, ".local", "bin", "hewn")));
      chmodSync(join(locked, "lib", "node_modules"), 0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("upgrading the npm package", () => {
  test("the newest published version in this 0.x line; stable before pre-releases", () => {
    const tags = publishedTags(() => JSON.stringify(["0.3.2", "0.4.0-rc.1", "0.4.0", "0.4.1", "0.5.0"]));
    assert.deepEqual(tags.slice(0, 2), ["v0.5.0", "v0.4.1"]);
    assert.equal(newestInLine("0.4.0", tags), "v0.4.1");
    assert.equal(newestInLine("0.3.2", tags), "v0.3.2", "a move to 0.4 is deliberate (--to)");
    assert.deepEqual(publishedTags(() => JSON.stringify("0.4.0")), ["v0.4.0"], "one version: npm answers a string");
  });
});
