// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { type BuilderSandboxOptions, wrapBuilder } from "@hewntools/cli/builders/sandbox.ts";

import { builderSandboxAvailable } from "@hewntools/cli/builders/sandbox.ts";
import { builderEnv, type ClaudeLogin, claudeHome } from "@hewntools/cli/builders/cli.ts";

const sb = builderSandboxAvailable();
const mac = process.platform === "darwin";

describe(`builder sandbox (${sb.how})`, { skip: !sb.ok && `${sb.how} isn't installed` }, () => {
  let root: string;
  let opts: BuilderSandboxOptions;
  const run = (cmd: string, args: string[], o = opts) => {
    const w = wrapBuilder(cmd, args, o);
    return spawnSync(w.command, w.args, { encoding: "utf8" });
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "builder-sb-"));
    const workspace = join(root, "builds", "b-1");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "BUILDER.md"), "brief");
    writeFileSync(join(root, "agents.json"), "{\"secret\":1}");
    opts = { workspace, platformRoot: root, ownState: [], denyKeychain: true };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("reads and writes its workspace", () => {
    assert.equal(run("/bin/cat", [join(opts.workspace, "BUILDER.md")]).stdout, "brief");
    assert.equal(run("/usr/bin/touch", [join(opts.workspace, "src.ts")]).status, 0);
  });

  test("cannot read the rest of the platform home", () => {
    const r = run("/bin/cat", [join(root, "agents.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, mac ? /Operation not permitted/ : /No such file or directory/);
  });

  test("cannot write outside the workspace", () => {
    const r = run("/usr/bin/touch", [join(root, "pwned")]);
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(root, "pwned")));
    const inHome = join(homedir(), "hewn-builder-escape-test");
    assert.notEqual(run("/usr/bin/touch", [inHome]).status, 0);
    assert.ok(!existsSync(inHome));
  });

  test("cannot write outside the home either (a program on PATH would run unsandboxed)", { skip: !mac && "bubblewrap mounts / read-only" }, () => {
    // Places a user can usually write outside $HOME on macOS.
    for (const dir of ["/Users/Shared", "/opt/homebrew/bin", "/Applications"].filter(existsSync)) {
      const f = join(dir, `hewn-sandbox-probe-${process.pid}`);
      assert.notEqual(run("/usr/bin/touch", [f]).status, 0, dir);
      assert.ok(!existsSync(f), dir);
    }
    assert.equal(run("/usr/bin/touch", [join(tmpdir(), `hewn-sandbox-tmp-${process.pid}`)]).status, 0, "temp stays writable");
    rmSync(join(tmpdir(), `hewn-sandbox-tmp-${process.pid}`), { force: true });
  });

  test("its own state may live inside the platform home (an isolated builder home) and stays usable", () => {
    const own = join(root, "builder-home", "codex");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "auth.json"), "token");
    const o = { ...opts, ownState: [own] };
    assert.equal(run("/bin/cat", [join(own, "auth.json")], o).stdout, "token");
    assert.equal(run("/usr/bin/touch", [join(own, "refreshed")], o).status, 0);
    assert.notEqual(run("/bin/cat", [join(root, "agents.json")], o).status, 0, "the rest of the home stays closed");
  });

  test("hides the user's private dirs (repositories, keys)", () => {
    const fake = mkdtempSync(join(tmpdir(), "builder-home-"));
    mkdirSync(join(fake, ".ssh"));
    writeFileSync(join(fake, ".ssh", "id_ed25519"), "PRIVATE KEY");
    const r = run("/bin/cat", [join(fake, ".ssh", "id_ed25519")], { ...opts, home: fake });
    assert.notEqual(r.stdout, "PRIVATE KEY");
    rmSync(fake, { recursive: true, force: true });
  });

  test("hides credential files and other builders' logins; a builder's own login stays readable", () => {
    const fake = mkdtempSync(join(tmpdir(), "builder-home-"));
    for (const f of [".npmrc", ".claude.json", ".zsh_history"]) writeFileSync(join(fake, f), "SECRET");
    mkdirSync(join(fake, ".docker"));
    writeFileSync(join(fake, ".docker", "config.json"), "SECRET");
    for (const f of [".npmrc", ".claude.json", ".zsh_history", ".docker/config.json"]) {
      assert.notEqual(run("/bin/cat", [join(fake, f)], { ...opts, home: fake }).stdout, "SECRET", f);
    }
    assert.equal(run("/bin/cat", [join(fake, ".claude.json")], { ...opts, home: fake, ownState: [join(fake, ".claude.json")] }).stdout, "SECRET");
    rmSync(fake, { recursive: true, force: true });
  });

  test("cannot reach this machine over the network (Hewn's ports)", { skip: !mac && "bubblewrap shares loopback (a known gap on Linux)" }, async () => {
    const server = createServer((_req, res) => res.end("hewn")).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const r = await new Promise<number | null>((resolve) => {
      const w = wrapBuilder("/usr/bin/curl", ["-s", "--max-time", "3", url], opts);
      spawn(w.command, w.args).once("close", resolve);
    });
    server.close();
    assert.notEqual(r, 0);
  });

  test("the builder's environment keeps its login settings, not the rest", () => {
    const env = builderEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "c", HTTPS_PROXY: "p", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "s", HEWN_HOME: "x" });
    assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "HTTPS_PROXY", "PATH"]);
  });

  test("cannot read the user's repositories", { skip: !existsSync(join(homedir(), "github")) && "no ~/github" }, () => {
    const repoFile = resolve(import.meta.dirname, "..", "package.json");
    const r = run("/bin/cat", [repoFile]);
    if (repoFile.startsWith(join(homedir(), "github"))) assert.notEqual(r.status, 0, "repo under ~/github must be unreadable");
  });

  test("Keychain is denied when the builder has a shell", { skip: !mac && "macOS Keychain" }, () => {
    assert.notEqual(run("/usr/bin/security", ["list-keychains"]).status, 0);
    assert.equal(run("/usr/bin/security", ["list-keychains"], { ...opts, denyKeychain: false }).status, 0);
  });
});

describe("the Claude builder's own config dir", () => {
  const fake = (blob: ClaudeLogin["blob"]) => {
    let current: ClaudeLogin = { blob, file: "/nowhere" };
    const writes: ClaudeLogin["blob"][] = [];
    return { writes, set: (b: ClaudeLogin["blob"]) => (current = { blob: b, file: "/nowhere" }), store: { read: () => current, write: (_: ClaudeLogin, b: ClaudeLogin["blob"]) => (writes.push(b), (current = { blob: b, file: "/nowhere" })) } };
  };
  const yours = { claudeAiOauth: { accessToken: "a1", refreshToken: "r1" }, mcpOAuth: { hewn: { accessToken: "HEWN-TOKEN" } } };

  test("gets your model login only, never your MCP tokens; the dir goes after the run", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cc-home-")), "b-1");
    const f = fake(structuredClone(yours));
    const home = claudeHome(dir, f.store);
    assert.equal(home.env.CLAUDE_CONFIG_DIR, dir);
    const given = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    assert.deepEqual(given, { claudeAiOauth: yours.claudeAiOauth });
    assert.ok(!JSON.stringify(given).includes("HEWN-TOKEN"));
    home.done();
    assert.ok(!existsSync(dir), "login copy deleted");
    assert.deepEqual(f.writes, [], "nothing refreshed: nothing written back");
  });

  test("keepSessions (a build between attempts): the login goes after the run, the dir and its sessions stay", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cc-home-")), "b-4");
    const f = fake(structuredClone(yours));
    const home = claudeHome(dir, f.store, { keepSessions: true });
    mkdirSync(join(dir, "projects", "ws"), { recursive: true });
    writeFileSync(join(dir, "projects", "ws", "s1.jsonl"), "{}");
    home.done();
    assert.ok(!existsSync(join(dir, ".credentials.json")), "login copy deleted");
    assert.ok(existsSync(join(dir, "projects", "ws", "s1.jsonl")), "the session stays for the next attempt");
    // The next attempt gets the login again, in the same dir.
    claudeHome(dir, f.store, { keepSessions: true });
    assert.ok(existsSync(join(dir, ".credentials.json")));
  });

  test("a refreshed login is copied back, keeping your MCP tokens; unless yours changed meanwhile", () => {
    const refresh = (dir: string) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a2", refreshToken: "r2" } }));
    const f = fake(structuredClone(yours));
    const dir = join(mkdtempSync(join(tmpdir(), "cc-home-")), "b-2");
    const home = claudeHome(dir, f.store);
    refresh(dir);
    home.done();
    assert.deepEqual(f.writes, [{ claudeAiOauth: { accessToken: "a2", refreshToken: "r2" }, mcpOAuth: yours.mcpOAuth }]);

    const g = fake(structuredClone(yours));
    const dir2 = join(mkdtempSync(join(tmpdir(), "cc-home-")), "b-3");
    const home2 = claudeHome(dir2, g.store);
    refresh(dir2);
    g.set({ ...yours, claudeAiOauth: { accessToken: "mine", refreshToken: "mine" } });
    home2.done();
    assert.deepEqual(g.writes, [], "your own newer login wins");
  });
});
