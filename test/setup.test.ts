// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PendingRequest } from "@hewntools/core/agents.ts";
import { openHome, type Home } from "@hewntools/cli/home.ts";
import { MARKDOWN, removeBlock, SHELL, upsertBlock } from "@hewntools/cli/setup/blocks.ts";
import { type Exec, harnesses } from "@hewntools/cli/setup/harnesses.ts";
import { authorizeUrl } from "@hewntools/cli/setup/connect.ts";
import { runSetup } from "@hewntools/cli/setup/wizard.ts";

describe("managed blocks", () => {
  test("appends once, then replaces in place", () => {
    const once = upsertBlock("# Mine\n\nkeep me\n", "v1", MARKDOWN);
    assert.match(once, /keep me\n\n<!-- hewn:begin/);
    const twice = upsertBlock(once + "after\n", "v2", MARKDOWN);
    assert.equal(twice.split(MARKDOWN.begin).length, 2, "single block");
    assert.match(twice, /v2/);
    assert.doesNotMatch(twice, /v1/);
    assert.match(twice, /keep me/);
    assert.match(twice, /after\n$/);
  });

  test("creates content in an empty file", () => {
    assert.equal(upsertBlock("", "x", MARKDOWN), `${MARKDOWN.begin}\nx\n${MARKDOWN.end}\n`);
  });
});

describe("hewn setup", () => {
  let root: string;
  let home: Home;
  let userHome: string;
  let calls: string[][];
  let logins: string[][];
  let out: string[];
  const exec: Exec = (command, args) => void calls.push([command, ...args]);
  const allDetected = () => harnesses(exec).map((h) => ({ ...h, detect: () => true }));
  const scripted = (answers: string[]) => ({
    ask: async (q: string) => (out.push(q), answers.shift() ?? ""),
    print: (l: string) => void out.push(l),
  });
  const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
    id: "r1", clientName: "Codex", redirectHost: "127.0.0.1:5555", requested: ["discover", "invoke", "create", "modify"], suggested: ["discover", "invoke", "create", "modify"],
    userCode: "ABC-DEF", via: "local", address: "127.0.0.1:7717", createdAt: new Date().toISOString(), reconnects: null, current: null, suggestedName: "codex", ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hewn-setup-"));
    home = openHome(join(root, "data"));
    userHome = join(root, "user");
    calls = [];
    logins = [];
    out = [];
    process.env.SHELL = "/bin/zsh";
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A login that "opens the browser", and finishes once the request was decided. */
  const flow = (decided: { d?: { approve: boolean; scopes?: string[] } }, pending: PendingRequest[]) => ({
    login: async (argv: string[]) => {
      logins.push(argv);
      while (!decided.d) await new Promise((r) => setTimeout(r, 5));
      return decided.d.approve ? 0 : 1;
    },
    approvals: {
      pending: async () => (logins.length && !decided.d ? pending : []),
      decide: async (_id: string, d: { approve: boolean; scopes?: string[] }) => void (decided.d = d),
    },
    pollMs: 5,
  });

  const run = (over: Partial<Parameters<typeof runSetup>[0]> = {}) =>
    runSetup({ home, url: "http://127.0.0.1:7717/mcp", userHome, harnesses: allDetected(), io: scripted([]), login: async (argv) => (logins.push(argv), 0), ...over });

  test("codex: old registration removed, pointer added, then `codex mcp add` signs in; approved in the terminal", async () => {
    const decided: { d?: { approve: boolean; scopes?: string[] } } = {};
    const r = await run({ agents: ["codex"], yes: true, ...flow(decided, [request()]) });
    assert.deepEqual(r.applied, ["codex"]);
    assert.match(readFileSync(join(userHome, ".codex", "AGENTS.md"), "utf8"), /live in the `hewn` MCP server/);
    assert.deepEqual(calls, [["codex", "mcp", "remove", "hewn"]]);
    assert.deepEqual(logins, [["codex", "mcp", "add", "hewn", "--url", "http://127.0.0.1:7717/mcp"]]);
    assert.deepEqual(decided.d, { approve: true, scopes: ["discover", "invoke", "create", "modify"] });
    assert.match(out.join("\n"), /Code ABC-DEF/);
    assert.ok(!existsSync(join(userHome, ".zshrc")), "no token in the shell profile");
  });

  test("approved in Hewn's web page while the terminal asks: the question stops, no stale [Y/n]", async () => {
    const decided: { d?: { approve: boolean; scopes?: string[] } } = {};
    let asked = 0;
    const io = {
      // Never answered in the terminal: only the abort ends it.
      ask: (q: string, signal?: AbortSignal) => (out.push(q), asked++, new Promise<string>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))))),
      print: (l: string) => void out.push(l),
    };
    const f = flow(decided, [request()]);
    const decide = f.approvals.decide;
    let terminalDecided = false;
    f.approvals.decide = async (id, d) => ((terminalDecided = true), decide(id, d));
    // The owner approves in the browser shortly after the question appears.
    setTimeout(() => (decided.d = { approve: true }), 40);
    const r = await run({ agents: ["codex"], pointer: false, io: { ...io, ask: (q, signal) => (q.includes("Apply") ? Promise.resolve("") : io.ask(q, signal)) }, ...f });
    assert.deepEqual(r.applied, ["codex"]);
    assert.equal(asked, 1);
    assert.equal(terminalDecided, false, "the terminal didn't decide it again");
    assert.match(out.join("\n"), /Decided in Hewn/);
  });

  test("declining in the terminal fails the setup for that agent", async () => {
    const decided: { d?: { approve: boolean; scopes?: string[] } } = {};
    const r = await run({ agents: ["codex"], io: scripted(["", "n"]), ...flow(decided, [request()]) });
    assert.deepEqual(r.failed, ["codex"]);
    assert.deepEqual(decided.d, { approve: false });
  });

  test("claude: registered without a header; sign-in runs under a pty; pointer only when asked", async () => {
    await run({ agents: ["claude-code"], yes: true, pointer: false });
    assert.deepEqual(calls.at(-1), ["claude", "mcp", "add", "--scope", "user", "--transport", "http", "hewn", "http://127.0.0.1:7717/mcp"]);
    assert.ok(logins[0][0] === "script" && logins[0].join(" ").replace(/'/g, "").includes("claude mcp login hewn")); // quoted on Linux
    assert.ok(!existsSync(join(userHome, ".claude", "CLAUDE.md")));
    await run({ agents: ["claude-code"], yes: true, pointer: true });
    assert.match(readFileSync(join(userHome, ".claude", "CLAUDE.md"), "utf8"), /hewn:begin/);
  });

  test("a Claude Code too old for `claude mcp login`: says to update, or sign in with /mcp", async () => {
    const r = await run({ agents: ["claude-code"], yes: true, login: async (argv, onLine) => (logins.push(argv), onLine("error: unknown command 'login'"), 1) });
    assert.deepEqual(r.failed, ["claude-code"]);
    assert.match(out.join("\n"), /Claude Code couldn't sign in\. This Claude Code is too old .*claude update.*\/mcp/);
  });

  test("the static token export from before OAuth is removed from the shell profile", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(userHome, { recursive: true });
    const profile = join(userHome, ".zshrc");
    writeFileSync(profile, `alias x=y\n\n${SHELL.begin}\nexport HEWN_CODEX_TOKEN=old\n${SHELL.end}\nexport PATH=/x\n`);
    await run({ agents: ["codex"], yes: true });
    assert.equal(readFileSync(profile, "utf8"), "alias x=y\nexport PATH=/x\n");
    assert.equal(removeBlock(profile, SHELL), false, "gone");
  });

  test("re-running is idempotent and keeps user edits", async () => {
    await run({ agents: ["codex"], yes: true });
    const agentsMd = join(userHome, ".codex", "AGENTS.md");
    writeFileSync(agentsMd, "# My own rules\n\n" + readFileSync(agentsMd, "utf8"));
    await run({ agents: ["codex"], yes: true });
    const md = readFileSync(agentsMd, "utf8");
    assert.equal(md.split("hewn:begin").length, 2);
    assert.match(md, /^# My own rules/);
  });

  test("dry run changes nothing", async () => {
    await run({ agents: ["codex", "claude-code"], dryRun: true, pointer: true });
    assert.deepEqual(calls, []);
    assert.deepEqual(logins, []);
    assert.match(out.join("\n"), /Dry run/);
  });

  test("interactive: asks per detected harness, skips missing, confirms before applying", async () => {
    const hs = allDetected().map((h) => (h.agentId === "claude-code" ? { ...h, detect: () => false } : h));
    await run({ harnesses: hs, io: scripted(["", "", "n"]) }); // yes to Codex and OpenCode, then decline apply
    assert.match(out.join("\n"), /Claude Code: not found on PATH/);
    assert.ok(out.some((l) => l.startsWith("Set up Codex?")));
    assert.ok(out.some((l) => l.startsWith("Set up OpenCode?")));
    assert.match(out.join("\n"), /Aborted/);
    assert.deepEqual(calls, []);
  });
});

describe("connect from the web: the sign-in page when no browser opens", () => {
  const hewn = "http://127.0.0.1:7717/mcp";
  test("found in the login's output, even when its UI wraps the URL", () => {
    const url = "http://127.0.0.1:7717/authorize?response_type=code&client_id=abc&code_challenge=x-Y_z&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&state=s";
    assert.equal(authorizeUrl(`Opening your browser…\nIf it doesn't open, visit: ${url}\n`, hewn), url);
    assert.equal(authorizeUrl(`visit:\n${url.slice(0, 40)}\n${url.slice(40, 90)}\n${url.slice(90)}\nWaiting…`, hewn), url);
    assert.equal(authorizeUrl(`(${url}).`, hewn), url);
    assert.equal(authorizeUrl("Waiting for authorization…", hewn), undefined);
    assert.equal(authorizeUrl("https://evil.example/authorize?x=1", hewn), undefined, "only Hewn's own sign-in page");
  });
});
