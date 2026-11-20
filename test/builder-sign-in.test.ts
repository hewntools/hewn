// SPDX-License-Identifier: AGPL-3.0-or-later
// The builder's sign-in: a home per vendor on this Hewn, signed in by the vendor's own flow, which Hewn never reads,
// copies or writes; a build or a talk without it stops in the owner's words; an unattended build's API key; the
// `claude -p` tripwire.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { claudeBuilder, forgetSession, inBuilderHome } from "@hewntools/cli/builders/cli.ts";
import { type AskCli, builderHome, claudeBareDefault, notSignedInWords, removeOldBuilderHomes, signedIn, signIn } from "@hewntools/cli/builders/sign-in.ts";
import type { BuildJob } from "@hewntools/cli/builders/types.ts";
import { runDoctor } from "@hewntools/cli/doctor.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { USER } from "@hewntools/core/auth.ts";
import { cpSync } from "node:fs";
import { editJson, SEED, setup } from "./helpers.ts";

const answer = (stdout: string, code = 0): ReturnType<AskCli> => Promise.resolve({ code, stdout, stderr: "" });

describe("a builder home per vendor, signed in by the vendor's own flow", () => {
  test("signed in is what the vendor's own CLI says in the home; no home is not signed in, and nothing is asked", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-signin-"));
    try {
      const asked: string[][] = [];
      const ask: AskCli = (cmd, args, env) => (asked.push([cmd, ...args, `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR ?? ""}`, `CODEX_HOME=${env.CODEX_HOME ?? ""}`]), cmd === "claude" ? answer('{"loggedIn":true,"authMethod":"claude.ai"}') : answer("Logged in using ChatGPT"));
      for (const v of ["claude", "codex", "opencode"] as const) assert.equal(await signedIn(v, root, ask), false);
      assert.deepEqual(asked, [], "no home: nothing to ask");
      for (const v of ["claude", "codex", "opencode"] as const) mkdirSync(builderHome(root, v), { recursive: true });
      assert.equal(await signedIn("claude", root, ask), true);
      assert.equal(await signedIn("codex", root, ask), true);
      assert.deepEqual(asked, [
        ["claude", "auth", "status", "--json", `CLAUDE_CONFIG_DIR=${builderHome(root, "claude")}`, "CODEX_HOME="],
        ["codex", "login", "status", "-c", 'cli_auth_credentials_store="file"', "CLAUDE_CONFIG_DIR=", `CODEX_HOME=${join(builderHome(root, "codex"), ".codex")}`],
      ]);
      assert.equal(await signedIn("claude", root, () => answer('{"loggedIn":false,"authMethod":"none"}', 1)), false);
      assert.equal(await signedIn("codex", root, () => answer("Not logged in", 1)), false);
      assert.equal(await signedIn("claude", root, () => answer("Error: something else", 1)), undefined, "can't tell");
      // OpenCode runs on its free tier too: ready once its sign-in has run here.
      assert.equal(await signedIn("opencode", root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hewn builder sign-in runs the vendor's own sign-in in this terminal, pointed at the builder's home; your own stays", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-signin-"));
    try {
      const ran: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const run = async (cmd: string, args: string[], env: NodeJS.ProcessEnv) => (ran.push({ cmd, args, env }), 0);
      const lines: string[] = [];
      const io = { print: (l: string) => lines.push(l) };
      assert.equal(await signIn("claude", root, { io, run, ask: () => answer('{"loggedIn":true}') }), true);
      assert.equal(await signIn("codex", root, { io, run, extra: ["--device-auth"], ask: () => answer("Not logged in", 1) }), false);
      assert.deepEqual(ran.map((r) => [r.cmd, ...r.args]), [
        ["claude", "auth", "login"],
        ["codex", "login", "-c", 'cli_auth_credentials_store="file"', "--device-auth"],
      ]);
      assert.equal(ran[0].env.CLAUDE_CONFIG_DIR, builderHome(root, "claude"));
      assert.equal(ran[1].env.CODEX_HOME, join(builderHome(root, "codex"), ".codex"));
      assert.equal(ran[0].env.PATH, process.env.PATH, "the rest of your environment: its browser, your terminal");
      assert.match(lines.join("\n"), /✔ Claude Code is signed in for this Hewn's builds/);
      assert.match(lines.join("\n"), /✖ Codex isn't signed in for this Hewn's builds\. Try again: hewn builder sign-in codex/);
      assert.match(lines.join("\n"), /your own Claude Code stays signed in as it is/);
      // Not installed: says so.
      assert.equal(await signIn("claude", root, { io, run: async () => 127 }), false);
      assert.match(lines.at(-1)!, /claude isn't on PATH/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run without the sign-in stops in the owner's words (the build's log, which the web shows, too), hewn.log names the command; a login that fails is checked with the vendor; a key needs no sign-in", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-signin-"));
    try {
      const notes: string[] = [];
      const logged: string[] = [];
      const note = (l: string) => notes.push(l);
      const log = (l: string) => logged.push(l);
      let ran = 0;
      const ok = async () => void ran++;
      await assert.rejects(inBuilderHome("claude", root, { note, log }, ok), (e: Error & { notSignedIn?: boolean; unavailable?: boolean }) => e.notSignedIn === true && e.unavailable === true && e.message === notSignedInWords("claude"));
      assert.equal(ran, 0);
      assert.deepEqual(notes, ["Claude Code isn't signed in on this Hewn. Sign in from the terminal on the machine that runs it."]);
      assert.deepEqual(logged, ["Claude Code isn't signed in on this Hewn. Sign in from the terminal on the machine that runs it. In a terminal there: hewn builder sign-in claude"]);
      assert.doesNotMatch(notSignedInWords("claude"), /hewn |`/, "the web's words name no command");
      // A run on an API key needs no sign-in (its home is made for it).
      await inBuilderHome("claude", root, { apiKey: "sk-ant-key", note, log }, ok);
      assert.equal(ran, 1);
      // Signed out since: the vendor says so, the run stops with the same words.
      const signedOut = Object.assign(new Error("Invalid API key · Please run /login"), { unavailable: true });
      const fail = async () => {
        throw signedOut;
      };
      await assert.rejects(inBuilderHome("claude", root, { note, log, ask: () => answer('{"loggedIn":false}', 1) }, fail), (e: Error & { notSignedIn?: boolean }) => e.notSignedIn === true);
      // The tripwire: Claude Code says it's signed in, but `claude -p` didn't use the sign-in.
      await assert.rejects(inBuilderHome("claude", root, { note, log, ask: () => answer('{"loggedIn":true}') }, fail), (e: Error & { notSignedIn?: boolean }) => !e.notSignedIn && /signed in on this Hewn, but didn't use the sign-in/.test(e.message) && !/hewn |`/.test(e.message));
      assert.match(logged.at(-1)!, /didn't use the sign-in: see hewn doctor's "Claude -p" line/);
      assert.ok(notes.every((l) => !/hewn /.test(l)), "no command in the build's log");
      // Anything else (a usage limit, a crash) is the run's own failure: the vendor isn't asked.
      let asked = 0;
      const limit = Object.assign(new Error("usage limit reached"), { unavailable: true });
      await assert.rejects(inBuilderHome("claude", root, { note, log, ask: () => (asked++, answer("{}")) }, async () => { throw limit; }), (e) => e === limit);
      assert.equal(asked, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builder homes from before (one per build and per talk, which held a copy of the login) go when Hewn starts", () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-signin-"));
    try {
      for (const d of ["builder-home/claude/b-0a1b2c3d", "builder-home/codex/b-12ab34cd/.codex", "builder-home/intake-claude/hewn-intake-x", "builder-home/intake-codex/.codex", "builder-home/intake-opencode-abc", "builder-home/claude/projects", "builder-home/opencode/builds"]) mkdirSync(join(root, d), { recursive: true });
      removeOldBuilderHomes(root);
      assert.deepEqual(readdirSync(join(root, "builder-home")).sort(), ["claude", "codex", "opencode"]);
      assert.deepEqual(readdirSync(join(root, "builder-home", "claude")), ["projects"], "the signed-in home's own folders stay");
      assert.deepEqual(readdirSync(join(root, "builder-home", "codex")), []);
      assert.deepEqual(readdirSync(join(root, "builder-home", "opencode")), ["builds"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Claude Code builds in its builder home", () => {
  /** A `claude` on PATH: `auth status` per the status file; `-p` records its environment, then finishes or fails to sign in. And a `security` that records being called. */
  function fakes() {
    const bin = mkdtempSync(join(tmpdir(), "hewn-fake-claude-"));
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
d=$(dirname "$0")
if [ "$1" = auth ]; then cat "$d/status"; exit 0; fi
echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR KEY=\${ANTHROPIC_API_KEY:-none}" >> "$d/env"
if [ -f "$d/fail" ]; then echo '{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}'; exit 1; fi
echo '{"type":"system","subtype":"init","session_id":"s-1","model":"claude-fable-5-1"}'
echo '{"type":"result","is_error":false,"result":"done"}'
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "security"), `#!/bin/sh\necho "$*" >> "$(dirname "$0")/security-calls"\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, "status"), '{"loggedIn":true}');
    return {
      bin,
      env: () => (existsSync(join(bin, "env")) ? readFileSync(join(bin, "env"), "utf8").trim().split("\n") : []),
      security: () => existsSync(join(bin, "security-calls")),
      status: (s: string) => writeFileSync(join(bin, "status"), s),
      fail: (on: boolean) => (on ? writeFileSync(join(bin, "fail"), "") : rmSync(join(bin, "fail"), { force: true })),
    };
  }
  const job = (root: string, extra: Partial<BuildJob> = {}): BuildJob => ({ buildId: "b-1", capabilityId: "notes", kind: "create", workspace: join(root, "builds", "b-1"), attempt: 1, logPath: join(root, "builds", "b-1.log"), ...extra });

  test("the builder home holds the login: no token is ever read from your ~/.claude or the Keychain, nor written anywhere by Hewn; an unattended build's key goes in its environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-cc-"));
    const f = fakes();
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.PATH = `${f.bin}:${process.env.PATH}`;
    process.env.HOME = join(root, "you");
    delete process.env.ANTHROPIC_API_KEY;
    mkdirSync(join(root, "you", ".claude"), { recursive: true });
    writeFileSync(join(root, "you", ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"YOURS"}}');
    mkdirSync(join(root, "builds", "b-1"), { recursive: true });
    try {
      // Not signed in on this Hewn: stops in words, Claude Code never runs.
      await assert.rejects(claudeBuilder.build(job(root)), (e: Error & { notSignedIn?: boolean }) => e.notSignedIn === true);
      assert.deepEqual(f.env(), []);
      assert.match(readFileSync(job(root).logPath, "utf8"), /Claude Code isn't signed in on this Hewn\. Sign in from the terminal/);
      assert.doesNotMatch(readFileSync(job(root).logPath, "utf8"), /hewn builder/, "the build's log is on the web: no command");
      // Signed in (Claude Code's own flow made the home): builds run there.
      const home = builderHome(root, "claude");
      mkdirSync(home, { recursive: true });
      await claudeBuilder.build(job(root));
      assert.deepEqual(f.env(), [`CLAUDE_CONFIG_DIR=${home} KEY=none`]);
      // An unattended build with a key set: the key, in its environment.
      await claudeBuilder.build(job(root, { buildId: "b-2", apiKey: "sk-ant-unattended" }));
      assert.equal(f.env().at(-1), `CLAUDE_CONFIG_DIR=${home} KEY=sk-ant-unattended`);
      // Signed out since: Claude Code's own status says so, and the build stops with the sign-in words.
      f.fail(true);
      f.status('{"loggedIn":false}');
      await assert.rejects(claudeBuilder.build(job(root, { buildId: "b-3" })), (e: Error & { notSignedIn?: boolean }) => e.notSignedIn === true);
      // Hewn read no Keychain and no ~/.claude, and wrote no login anywhere.
      assert.equal(f.security(), false, "the Keychain is never asked");
      assert.equal(readFileSync(join(root, "you", ".claude", ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"YOURS"}}');
      const all = execFileSync("find", [root, "-name", ".credentials.json"], { encoding: "utf8" }).trim().split("\n");
      assert.deepEqual(all, [join(root, "you", ".claude", ".credentials.json")], "no copy of a login anywhere");
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      for (const b of ["b-1", "b-2", "b-3"]) forgetSession(b);
      rmSync(root, { recursive: true, force: true });
      rmSync(f.bin, { recursive: true, force: true });
    }
  });
});

describe("an unattended build's account", () => {
  test("an agent's build runs on the owner's API key for the builder's vendor when one is set, else on the sign-in, and says so; the owner's own build runs on the sign-in", async () => {
    const jobs: { capabilityId: string; apiKey?: string }[] = [];
    const t = setup({
      modelFetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }),
      builders: {
        claude: {
          name: "claude",
          build: async (job) => {
            jobs.push({ capabilityId: job.capabilityId, ...(job.apiKey ? { apiKey: job.apiKey } : {}) });
            cpSync(SEED, job.workspace, { recursive: true });
            editJson(join(job.workspace, "capability.json"), (m) => (m.id = job.capabilityId));
          },
        },
      },
      builder: () => "claude",
    });
    const req = (name: string) => ({ name, purpose: "Keep a running history.", requirements: "Runs." });
    // The build's log, as the web shows it.
    const log = (b: { buildId: string }) => readFileSync(join(t.home.builds, `${b.buildId}.log`), "utf8");
    // No key yet: an agent's build runs on the sign-in, and says so.
    const noKey = await t.platform.settle((await t.platform.create(t.claude, req("Log A"))).buildId);
    assert.equal(t.platform.registry.buildModel(noKey.buildId)?.ranOn, "sign-in");
    assert.match(log(noKey), /runs on your Claude sign-in \(no Anthropic API key set in Settings › AI\)/);
    await t.platform.setModelKey(USER, "anthropic", "sk-ant-api03-for-builds");
    const agents = await t.platform.settle((await t.platform.create(t.claude, req("Log B"))).buildId);
    const owners = await t.platform.settle((await t.platform.create(USER, req("Log C"))).buildId);
    assert.deepEqual(jobs, [{ capabilityId: "log-a" }, { capabilityId: "log-b", apiKey: "sk-ant-api03-for-builds" }, { capabilityId: "log-c" }]);
    assert.equal(t.platform.registry.buildModel(agents.buildId)?.ranOn, "key");
    assert.match(log(agents), /runs on your Anthropic API key \(Settings › AI\): an agent asked for it/);
    assert.doesNotMatch(log(agents), /sk-ant/, "never the key itself");
    assert.equal(t.platform.registry.buildModel(owners.buildId)?.ranOn, undefined, "the owner's build: the sign-in, nothing to say");
  });
});

describe("the claude -p tripwire", () => {
  const today = `  --bare                                Minimal mode: skip hooks (those defined
                                        in settings and by installed plugins),
                                        keychain reads, and CLAUDE.md
                                        auto-discovery. Anthropic auth is
                                        strictly ANTHROPIC_API_KEY or
                                        apiKeyHelper via --settings (OAuth and
                                        keychain are never read). Explicitly
                                        provide context via:
                                        --system-prompt[-file],
                                        --append-system-prompt[-file]
  --betas <betas...>                    Beta headers to include in API requests
                                        default, except under --bare outside
`;

  test("today's help: -p uses the sign-in; a --no-bare option, or --bare calling itself the default, trips it", () => {
    assert.equal(claudeBareDefault(today), undefined, "another option's 'default' is not --bare's");
    assert.match(claudeBareDefault(today.replace("  --betas", "  --no-bare                             Read the sign-in in -p mode\n  --betas"))!, /--no-bare/);
    assert.match(claudeBareDefault(today.replace("Minimal mode:", "Minimal mode (the default for -p):"))!, /says --bare is the default/);
    assert.equal(claudeBareDefault("usage: claude [options]\n  -p, --print  Print response\n"), undefined, "a Claude Code without --bare");
  });

  // Loud on a machine with Claude Code: the day an update makes -p bare by default, this fails.
  const installed = (() => {
    try {
      return execFileSync("claude", ["--help"], { encoding: "utf8", timeout: 20_000 });
    } catch {
      return undefined;
    }
  })();
  test("the Claude Code installed here still lets -p use the sign-in", { skip: !installed && "Claude Code isn't installed here" }, () => {
    assert.equal(claudeBareDefault(installed!), undefined);
  });

  test("doctor: a line for it, and the sign-in line names the command", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-doctor-"));
    try {
      const home = openHome(root);
      const base = { home, port: 1, userHome: root, harnesses: [], health: async () => false, service: () => ({ installed: true, running: true }), bundle: async () => undefined, hasWorkerd: () => true, sandbox: () => ({ ok: true, how: "x" }), keySource: () => "file" as const, browser: () => "x", which: () => true, settings: async () => ({ builder: "claude", intake: "claude" }) };
      const ok = await runDoctor({ ...base, loggedIn: async () => true, claudeHelp: async () => today });
      assert.deepEqual(ok.find((c) => c.name === "Claude -p"), { name: "Claude -p", state: "ok", detail: "uses the builder's sign-in" });
      const bad = await runDoctor({ ...base, loggedIn: async () => false, claudeHelp: async () => `${today}  --no-bare  x\n` });
      assert.equal(bad.find((c) => c.name === "Claude -p")?.state, "fail");
      assert.deepEqual(bad.find((c) => c.name === "Builds tools"), { name: "Builds tools", state: "fail", detail: "Claude Code isn't signed in on this Hewn (it signs in once, in a home of its own)", fix: "hewn builder sign-in claude" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
