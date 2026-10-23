// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenCode as a builder, an intake and an MCP client: its home, its arguments, its events, its model list, its sign-in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { opencodeActivity, USED_TOOL } from "@hewntools/cli/builders/activity.ts";
import {
  forgetSession,
  loopbackPorts,
  noteSession,
  OPENCODE_BUILDER_RULES,
  OPENCODE_INTAKE_RULES,
  opencodeArgs,
  opencodeBuildHome,
  opencodeBuilder,
  opencodeHasModel,
  opencodeHome,
  opencodeModelArgs,
  opencodeProviders,
  resumePrompt,
  sessionOf,
  UNAVAILABLE,
} from "@hewntools/cli/builders/cli.ts";
import { MODEL_REJECTED, opencodeCatalogFrom } from "@hewntools/cli/builders/models.ts";
import { builderProfile, builderSandboxAvailable, PRIVATE_HOME_DIRS, wrapBuilder } from "@hewntools/cli/builders/sandbox.ts";
import type { BuildJob } from "@hewntools/cli/builders/types.ts";
import { opencodeOutput } from "@hewntools/cli/intake.ts";
import { harnesses, opencodeConfigDir, opencodeMcpUrl, parseJsonc } from "@hewntools/cli/setup/harnesses.ts";
import { toolStatus } from "@hewntools/cli/setup/tools.ts";
import { uninstallPlan } from "@hewntools/cli/uninstall.ts";
import { localWorkbench } from "@hewntools/cli/workbench.ts";
import { isBuilderConfig } from "@hewntools/core/files.ts";
import { DEFAULT_AGENT_MODELS, jobAgents } from "@hewntools/host-workerd/surface/host.ts";

const ws = "/data/builds/b-1";
const job = (extra: Partial<BuildJob> = {}): BuildJob => ({ buildId: "b-9", capabilityId: "notes", kind: "create", workspace: "/tmp/ws", attempt: 1, logPath: "/tmp/b-9.log", platformRoot: "/tmp/home", ...extra });

describe("OpenCode's events become activity lines", () => {
  test("text, reasoning, tool calls (a failed one with its error), the turn's end, errors", () => {
    assert.equal(opencodeActivity({ type: "text", part: { type: "text", text: "Adding notes.\n" } }, ws), "💬 Adding notes.");
    assert.equal(opencodeActivity({ type: "text", part: { type: "text", text: "  " } }, ws), null);
    assert.equal(opencodeActivity({ type: "reasoning", part: { type: "reasoning", text: "The brief asks for a list." } }, ws), "… The brief asks for a list.");
    assert.equal(opencodeActivity({ type: "tool_use", part: { type: "tool", tool: "write", state: { status: "completed", input: { filePath: `${ws}/src/index.ts`, content: "x" } } } }, ws), "→ write src/index.ts");
    assert.equal(opencodeActivity({ type: "tool_use", part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: `/private${ws}` } } } }, ws), "→ read /private/data/builds/b-1");
    assert.equal(opencodeActivity({ type: "tool_use", part: { type: "tool", tool: "grep", state: { status: "completed", input: { pattern: "TODO" } } } }, ws), "→ grep TODO");
    assert.equal(
      opencodeActivity({ type: "tool_use", part: { type: "tool", tool: "edit", state: { status: "error", input: { filePath: `${ws}/a.ts` }, error: "oldString not found" } } }, ws),
      "→ edit a.ts\n  ↳ oldString not found",
    );
    assert.equal(opencodeActivity({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }, ws), "✔ builder finished its turn");
    assert.equal(opencodeActivity({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } }, ws), null, "a step that ends in tool calls is noise");
    assert.equal(opencodeActivity({ type: "step_start", part: { type: "step-start" } }, ws), null);
    assert.equal(opencodeActivity({ type: "error", sessionID: "", error: { name: "ProviderModelNotFoundError", data: { message: "Model not found: opencode/nope" } } }, ws), "✖ Model not found: opencode/nope");
    assert.equal(opencodeActivity({ type: "error", error: { type: "unknown", message: "You must provide a message" } }, ws), "✖ You must provide a message");
  });

  test("a tool call counts as having used a tool; its model and login failures are told apart", () => {
    assert.ok(USED_TOOL.test(opencodeActivity({ type: "tool_use", part: { type: "tool", tool: "write", state: { status: "completed", input: { filePath: `${ws}/a` } } } }, ws)!));
    assert.ok(!USED_TOOL.test(opencodeActivity({ type: "text", part: { type: "text", text: "hi" } }, ws)!));
    assert.match('{"type":"error","error":{"name":"ProviderModelNotFoundError","data":{"message":"Model not found"}}}', MODEL_REJECTED);
    assert.match("model not found: anthropic/claude-x (not in opencode models)", MODEL_REJECTED);
    // The free tier, for a model it still lists (seen in the 0.4.7 smoke test): the owner is told to pick another, not shown the raw text.
    assert.match('{"type":"error","error":{"name":"APIError","data":{"message":"Upstream request failed: Model is unavailable.","statusCode":400}}}', MODEL_REJECTED);
    assert.match('{"type":"error","error":{"name":"ProviderAuthError","data":{"message":"no credentials"}}}', UNAVAILABLE);
    assert.doesNotMatch("→ write src/models.ts", MODEL_REJECTED);
  });
});

describe("OpenCode's arguments", () => {
  test("a fresh attempt, and a resume of the build's session with the failure; the model and its reasoning level", () => {
    const first = opencodeArgs(job());
    assert.deepEqual(first.slice(0, 5), ["run", "--format", "json", "--pure", "--auto"]);
    assert.match(first.at(-1)!, /Read BUILDER\.md/);
    assert.ok(!first.includes("-s"));
    const again = opencodeArgs(job({ attempt: 2, feedback: "nope", model: "anthropic/claude-sonnet-4-5", effort: "high" }), "ses_abc");
    assert.deepEqual(again.slice(5), ["-m", "anthropic/claude-sonnet-4-5", "--variant", "high", "-s", "ses_abc", resumePrompt(job({ attempt: 2, feedback: "nope" }))]);
    assert.deepEqual(opencodeModelArgs({ model: "ollama/qwen3", effort: "max" }), ["-m", "ollama/qwen3", "--variant", "max"]);
    assert.deepEqual(opencodeModelArgs({ effort: "bad level!" }), [], "a level that isn't one never reaches the CLI");
    assert.deepEqual(opencodeModelArgs({}), []);
  });

  test("the rules: the builder reads and writes, nothing else; the intake reads and fetches, nothing else; both shell names", () => {
    for (const rules of [OPENCODE_BUILDER_RULES, OPENCODE_INTAKE_RULES]) {
      for (const name of ["bash", "shell", "task", "skill", "question", "websearch", "external_directory"]) assert.equal(rules.permission[name], "deny", name);
      assert.equal(rules.tools.bash, false);
      assert.equal(rules.tools.shell, false);
    }
    assert.equal(OPENCODE_BUILDER_RULES.permission.edit, "allow");
    assert.equal(OPENCODE_BUILDER_RULES.permission.webfetch, "deny");
    assert.equal(OPENCODE_INTAKE_RULES.permission.edit, "deny");
    assert.equal(OPENCODE_INTAKE_RULES.permission.webfetch, "allow");
    assert.equal(OPENCODE_INTAKE_RULES.tools.write, false);
  });
});

describe("OpenCode's home", () => {
  const yoursIn = (root: string) => {
    const yours = { config: join(root, "yours", ".config", "opencode"), data: join(root, "yours", ".local", "share", "opencode"), cache: join(root, "yours", ".cache", "opencode") };
    mkdirSync(join(yours.config, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
    writeFileSync(join(yours.config, "node_modules", "@opencode-ai", "plugin", "package.json"), '{"version":"1.18.18"}');
    writeFileSync(join(yours.config, "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.18.18"}}');
    writeFileSync(join(yours.config, "opencode.jsonc"), '{"plugin":["mine"]}');
    mkdirSync(yours.data, { recursive: true });
    writeFileSync(join(yours.data, "auth.json"), '{"anthropic":{"type":"oauth"}}');
    writeFileSync(join(yours.data, "mcp-auth.json"), '{"hewn":"token"}');
    mkdirSync(join(yours.cache, "bin"), { recursive: true });
    writeFileSync(join(yours.cache, "models.json"), "{}");
    writeFileSync(join(yours.cache, "bin", "rg"), "#!/bin/sh\n");
    return yours;
  };

  test("its own HOME and XDG dirs, with your logins for the run, your providers, the plugin SDK copied from yours; never your config, plugins or MCP tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-oc-home-"));
    try {
      const yours = yoursIn(root);
      const dir = join(root, "platform", "builder-home", "opencode", "b-1");
      const providers = { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1" } } };
      const h = await opencodeHome(dir, { rules: OPENCODE_BUILDER_RULES, yours, providers: () => providers });
      assert.equal(h.dir, dir);
      assert.equal(h.env.HOME, dir);
      assert.equal(h.env.XDG_CONFIG_HOME, join(dir, "config"));
      assert.equal(h.env.XDG_DATA_HOME, join(dir, "data"));
      assert.equal(h.env.XDG_CACHE_HOME, join(dir, "cache"));
      assert.equal(h.env.XDG_STATE_HOME, join(dir, "state"));
      assert.equal(h.env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
      assert.equal(h.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      const inline = JSON.parse(h.env.OPENCODE_CONFIG_CONTENT!);
      assert.equal(inline.autoupdate, false);
      assert.equal(inline.share, "disabled");
      assert.equal(inline.permission.shell, "deny");
      assert.deepEqual(h.loopback, [11434]);
      const cfg = JSON.parse(readFileSync(join(dir, "config", "opencode", "opencode.json"), "utf8"));
      assert.equal(cfg.autoupdate, false);
      assert.deepEqual(cfg.provider, providers);
      assert.equal(cfg.permission.edit, "allow");
      assert.equal(cfg.plugin, undefined, "none of your plugins");
      assert.ok(existsSync(join(dir, "config", "opencode", "node_modules", "@opencode-ai", "plugin", "package.json")), "the SDK install, so OpenCode doesn't fetch it");
      assert.ok(existsSync(join(dir, "config", "opencode", "package.json")));
      assert.ok(existsSync(join(dir, "cache", "opencode", "models.json")));
      assert.ok(existsSync(join(dir, "cache", "opencode", "bin", "rg")));
      assert.equal(readFileSync(join(dir, "data", "opencode", "auth.json"), "utf8"), '{"anthropic":{"type":"oauth"}}');
      assert.ok(!existsSync(join(dir, "data", "opencode", "mcp-auth.json")), "never your MCP tokens");
      assert.ok(!existsSync(join(dir, "config", "opencode", "opencode.jsonc")), "never your config");
      // Unchanged: nothing copied back; the login goes.
      h.done();
      assert.ok(!existsSync(join(dir, "data", "opencode", "auth.json")));
      // Your provider config (keys and all) goes with it; the rules stay in the file.
      const afterRun = JSON.parse(readFileSync(join(dir, "config", "opencode", "opencode.json"), "utf8"));
      assert.equal(afterRun.provider, undefined);
      assert.deepEqual(afterRun.permission, OPENCODE_BUILDER_RULES.permission);
      assert.equal(readFileSync(join(yours.data, "auth.json"), "utf8"), '{"anthropic":{"type":"oauth"}}');
      // A later attempt: the same home, nothing copied twice, the login back for the run.
      const again = await opencodeHome(dir, { rules: OPENCODE_BUILDER_RULES, yours, providers: () => undefined });
      assert.ok(existsSync(join(dir, "data", "opencode", "auth.json")));
      assert.equal(JSON.parse(readFileSync(join(dir, "config", "opencode", "opencode.json"), "utf8")).provider, undefined);
      assert.deepEqual(again.loopback, []);
      // Refreshed by OpenCode: copied back to yours.
      writeFileSync(join(dir, "data", "opencode", "auth.json"), '{"anthropic":{"type":"oauth","refreshed":true}}');
      const later = Date.now() / 1000 + 5;
      utimesSync(join(dir, "data", "opencode", "auth.json"), later, later);
      again.done();
      assert.match(readFileSync(join(yours.data, "auth.json"), "utf8"), /refreshed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without an OpenCode of your own: an empty home that still runs (OpenCode installs its SDK itself)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-oc-home-"));
    try {
      const yours = { config: join(root, "none", "config"), data: join(root, "none", "data"), cache: join(root, "none", "cache") };
      const h = await opencodeHome(join(root, "home"), { rules: OPENCODE_INTAKE_RULES, yours, providers: () => undefined });
      assert.ok(existsSync(join(h.dir, "config", "opencode", "opencode.json")));
      assert.ok(!existsSync(join(h.dir, "config", "opencode", "node_modules")));
      assert.ok(!existsSync(join(h.dir, "data", "opencode", "auth.json")));
      h.done();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("your custom providers come from OpenCode's resolved config; a local model server's port is the one loopback allowance", async () => {
    const lmstudio = { lmstudio: { options: { baseURL: "http://127.0.0.1:1234/v1" } } };
    assert.deepEqual(await opencodeProviders(() => JSON.stringify({ provider: lmstudio })), lmstudio);
    assert.deepEqual(await opencodeProviders(() => { throw new Error("not asked again for a while"); }), lmstudio, "kept for a while");
    assert.deepEqual(loopbackPorts({ a: { options: { baseURL: "http://localhost:11434/v1" } }, b: { options: { baseURL: "https://api.example.com/v1" } }, c: { options: { baseURL: "http://127.0.0.1:1234" } }, d: { options: { baseURL: "not a url" } }, e: {} }), [1234, 11434]);
    assert.deepEqual(loopbackPorts(undefined), []);
    const profile = builderProfile({ workspace: "/tmp/ws", platformRoot: "/tmp/home", ownState: [], denyKeychain: true, allowLoopback: [11434, 70000, -1] });
    assert.match(profile, /\(deny network-outbound \(remote ip "localhost:\*"\)\)\n\(allow network-outbound \(remote ip "localhost:11434"\)\)/);
    assert.doesNotMatch(profile, /70000|-1/);
    assert.ok(PRIVATE_HOME_DIRS.includes(".local/share/opencode"), "your OpenCode logins and sessions stay closed to builders");
  });

  test("the model is checked against `opencode models` first: one it doesn't list stops the run (a run with it would hang)", async () => {
    const list = () => "opencode/big-pickle\nanthropic/claude-sonnet-4-5\n";
    assert.ok(await opencodeHasModel("anthropic/claude-sonnet-4-5", {}, "/tmp", list));
    assert.ok(!(await opencodeHasModel("anthropic/claude-sonnet-4-6", {}, "/tmp", list)));
    assert.ok(!(await opencodeHasModel("big-pickle", {}, "/tmp", list)), "the provider is part of the name");
    assert.ok(await opencodeHasModel("anything", {}, "/tmp", () => { throw new Error("no opencode"); }), "can't tell: run anyway");
  });

  const sb = builderSandboxAvailable();
  test("macOS: a local model server's port is reachable from the sandbox, other local ports stay closed", { skip: process.platform !== "darwin" || !sb.ok }, async () => {
    const server = createServer((_req, res) => res.end("model")).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const root = mkdtempSync(join(tmpdir(), "hewn-oc-sb-"));
    try {
      const workspace = join(root, "builds", "b-1");
      mkdirSync(workspace, { recursive: true });
      // Spawned asynchronously: the server answering is this process (a synchronous spawn would block it).
      const curl = (o: { allowLoopback?: number[] }) =>
        new Promise<string>((resolve) => {
          const w = wrapBuilder("/usr/bin/curl", ["-s", "-m", "5", `http://127.0.0.1:${port}/`], { workspace, platformRoot: root, ownState: [], denyKeychain: true, ...o });
          const child = spawn(w.command, w.args);
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.once("close", () => resolve(out));
        });
      assert.notEqual(await curl({}), "model", "closed by default");
      assert.equal(await curl({ allowLoopback: [port] }), "model", "open when allowed");
      assert.notEqual(await curl({ allowLoopback: [port + 1] }), "model", "only that port");
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode through its CLI", () => {
  /** An `opencode` on PATH: lists models, resolves config, runs (noting the session; a resume of a gone session fails before any tool, per `mode`). */
  function fakeOpencode(models: string[]) {
    const bin = mkdtempSync(join(tmpdir(), "hewn-fake-oc-"));
    writeFileSync(
      join(bin, "opencode"),
      `#!/bin/sh
d=$(dirname "$0")
case "$1" in
  models) printf '%s\\n' ${models.map((m) => `'${m}'`).join(" ")}; exit 0;;
  debug) echo '{"provider":{}}'; exit 0;;
esac
printf '%s' "$*" | tr '\\n' ' ' >> "$d/calls"; echo >> "$d/calls"
echo "HOME=$HOME XDG=$XDG_DATA_HOME RULES=$OPENCODE_CONFIG_CONTENT" >> "$d/env"
case " $* " in *" -s "*) resuming=1;; esac
if [ -n "$resuming" ]; then
  if [ "$(cat "$d/mode")" = after ]; then echo '{"type":"tool_use","sessionID":"ses_old","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"/tmp/ws/src/index.ts"}}}}'; echo '{"type":"error","sessionID":"ses_old","error":{"name":"UnknownError","data":{"message":"boom"}}}'; exit 1; fi
  echo '{"type":"error","sessionID":"","error":{"type":"unknown","message":"Session not found"}}'; exit 1
fi
echo '{"type":"step_start","sessionID":"ses_new","part":{"type":"step-start"}}'
echo '{"type":"text","sessionID":"ses_new","part":{"type":"text","text":"Done."}}'
echo '{"type":"step_finish","sessionID":"ses_new","part":{"type":"step-finish","reason":"stop"}}'
`,
      { mode: 0o755 },
    );
    return {
      bin,
      mode: (m: "before" | "after") => writeFileSync(join(bin, "mode"), m),
      calls: () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n") : []),
      env: () => (existsSync(join(bin, "env")) ? readFileSync(join(bin, "env"), "utf8") : ""),
    };
  }

  test("a resume that fails after a tool is a failed attempt; one that fails before starts over; the session comes from its events; a model it doesn't list never runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "hewn-oc-run-"));
    const fake = fakeOpencode(["opencode/big-pickle", "anthropic/claude-sonnet-4-5"]);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    process.env.PATH = `${fake.bin}:${process.env.PATH}`;
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), '{"yours":true}');
    try {
      const ws = join(home, "ws");
      const logPath = join(home, "builds", "b-7.log");
      mkdirSync(ws);
      mkdirSync(dirname(logPath));
      const j = job({ buildId: "b-7", workspace: ws, logPath, platformRoot: undefined, attempt: 2, feedback: "nope", model: "anthropic/claude-sonnet-4-5" });
      noteSession("opencode", "b-7", "ses_old");
      fake.mode("after");
      await assert.rejects(opencodeBuilder.build(j), /opencode exited with 1/);
      assert.equal(fake.calls().length, 1, "no restart on a half-changed workspace");
      assert.match(fake.calls()[0], /-s ses_old/);
      assert.equal(sessionOf("opencode", j), "ses_old", "the session stays for the next attempt");
      fake.mode("before");
      await opencodeBuilder.build(j);
      assert.deepEqual(fake.calls().slice(1).map((c) => / -s /.test(c)), [true, false], "resumed, then fresh");
      assert.match(readFileSync(logPath, "utf8"), /couldn't resume the earlier session; starting over/);
      assert.match(readFileSync(logPath, "utf8"), /💬 Done\./);
      assert.equal(sessionOf("opencode", j), "ses_new", "the fresh run's session is the one to resume next");
      // Its home is the build's own, with the rules in its environment; the login is there for a run only.
      const own = opencodeBuildHome(home, "b-7");
      assert.match(fake.env(), new RegExp(`HOME=${own} XDG=${join(own, "data")} RULES=\\{"autoupdate":false`));
      assert.ok(existsSync(join(own, "config", "opencode", "opencode.json")));
      assert.ok(!existsSync(join(own, "data", "opencode", "auth.json")));
      assert.equal(readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8"), '{"yours":true}');
      // A model it doesn't list: the build stops at once, in the owner's words, and OpenCode never runs.
      const calls = fake.calls().length;
      await assert.rejects(opencodeBuilder.build(job({ buildId: "b-8", workspace: ws, logPath, platformRoot: undefined, model: "anthropic/claude-sonnet-4-6" })), (e: Error & { modelUnavailable?: boolean }) => e.modelUnavailable === true && /claude-sonnet-4-6 isn't available \(OpenCode doesn't list it\)\. Pick another/.test(e.message));
      assert.equal(fake.calls().length, calls);
    } finally {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      forgetSession("b-7");
      forgetSession("b-8");
      rmSync(home, { recursive: true, force: true });
      rmSync(fake.bin, { recursive: true, force: true });
    }
  });

  test("the workbench removes the build's OpenCode home with the workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "hewn-oc-wb-"));
    try {
      const wb = localWorkbench({ root: join(home, "builds"), builders: {} });
      const mine = opencodeBuildHome(home, "b-1");
      const other = opencodeBuildHome(home, "b-2");
      for (const d of [join(mine, "data", "opencode"), join(other, "data")]) mkdirSync(d, { recursive: true });
      noteSession("opencode", "b-1", "s");
      await wb.remove("b-1");
      assert.ok(!existsSync(mine) && existsSync(other));
      assert.equal(sessionOf("opencode", job({ buildId: "b-1", attempt: 2 })), undefined);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the intake on OpenCode", () => {
  test("a run that says nothing is stopped early, with a reason (the full timeout is for runs that talk)", async () => {
    const { run } = await import("@hewntools/cli/intake.ts");
    const hang = ["-e", "setTimeout(() => {}, 60_000)"];
    await assert.rejects(run(process.execPath, hang, tmpdir(), process.env, 60_000, undefined, undefined, undefined, 300), /said nothing for 0 minutes, so Hewn stopped it \(it never started\); try again$/);
    const talks = ["-e", "console.log('{\"type\":\"step_start\"}'); setTimeout(() => console.log('late'), 600)"];
    assert.match(await run(process.execPath, talks, tmpdir(), process.env, 60_000, undefined, undefined, undefined, 300), /late/, "once it has spoken, only the full timeout counts");
  });

  test("its reply is the run's last text part; an error event is the reason it failed", () => {
    const seen: string[] = [];
    const out = opencodeOutput((e) => seen.push(e.type));
    out.line('{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}');
    out.line('{"type":"text","sessionID":"s","part":{"type":"text","text":"Let me check that service."}}');
    out.line('{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"webfetch","state":{"status":"completed","input":{"url":"https://x"}}}}');
    out.line("not json at all");
    out.line('{"type":"text","sessionID":"s","part":{"type":"text","text":"{\\"kind\\":\\"draft\\"}"}}');
    assert.equal(out.text(), '{"kind":"draft"}');
    assert.equal(out.error(), undefined);
    assert.deepEqual(seen, ["step_start", "text", "tool_use", "text"]);
    out.line('{"type":"error","sessionID":"s","error":{"name":"ProviderAuthError","data":{"message":"no credentials for anthropic"}}}');
    assert.equal(out.error(), "no credentials for anthropic");
    const plain = opencodeOutput();
    plain.line('{"type":"error","sessionID":"","error":{"type":"unknown","message":"You must provide a message"}}');
    assert.equal(plain.error(), "You must provide a message");
  });
});

describe("OpenCode's model list", () => {
  test("`opencode models --verbose`: each model pinned, with its provider and the reasoning levels it takes; the plain list reads too", () => {
    const raw = [
      "anthropic/claude-sonnet-4-5",
      "{",
      '  "id": "claude-sonnet-4-5",',
      '  "providerID": "anthropic",',
      '  "name": "Claude Sonnet 4.5",',
      '  "status": "active",',
      '  "variants": {',
      '    "low": { "reasoningEffort": "low" },',
      '    "high": { "reasoningEffort": "high" }',
      "  }",
      "}",
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "providerID": "opencode",',
      '  "name": "Big Pickle",',
      '  "variants": {}',
      "}",
      "opencode/old",
      "{",
      '  "id": "old",',
      '  "status": "retired"',
      "}",
      "",
    ].join("\n");
    const c = opencodeCatalogFrom(raw);
    assert.equal(c.agent, "opencode");
    assert.deepEqual(c.models.map((m) => m.id), ["default", "anthropic/claude-sonnet-4-5", "opencode/big-pickle"]);
    assert.equal(c.models[0].kind, "default");
    assert.deepEqual(c.models[1], { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", kind: "pinned", description: "anthropic", efforts: ["low", "high"] });
    assert.deepEqual(c.models[2].efforts, []);
    assert.ok(c.other, "any provider/model may be typed: the list depends on what it's signed in to");
    const plain = opencodeCatalogFrom("opencode/big-pickle\nollama/qwen3:8b\n\n");
    assert.deepEqual(plain.models.map((m) => [m.id, m.label, m.description]), [["default", "Default", "OpenCode's own choice"], ["opencode/big-pickle", "big-pickle", "opencode"], ["ollama/qwen3:8b", "qwen3:8b", "ollama"]]);
    assert.deepEqual(opencodeCatalogFrom("").models.map((m) => m.id), ["default"]);
  });

  test("OpenCode is an agent for Hewn's jobs, on its default model until the owner says", () => {
    assert.ok(jobAgents(false).includes("opencode"));
    assert.deepEqual(DEFAULT_AGENT_MODELS.opencode, ["default"]);
    assert.ok(isBuilderConfig("opencode.json") && isBuilderConfig("sub/opencode.jsonc") && !isBuilderConfig("src/opencode.ts"), "its project config never becomes part of a version");
  });
});

describe("OpenCode as an MCP client", () => {
  test("registered: Hewn's address in its global config, JSON or JSONC, in either shape", () => {
    const root = mkdtempSync(join(tmpdir(), "hewn-oc-mcp-"));
    try {
      const dir = opencodeConfigDir(root, {});
      assert.equal(dir, join(root, ".config", "opencode"));
      assert.equal(opencodeConfigDir(root, { XDG_CONFIG_HOME: "/x/cfg" }), join(root, ".config", "opencode"), "XDG applies to your own home only (CI sets it)");
      assert.equal(opencodeConfigDir(homedir(), { XDG_CONFIG_HOME: "/x/cfg" }), "/x/cfg/opencode");
      mkdirSync(dir, { recursive: true });
      assert.equal(opencodeMcpUrl(root), undefined);
      writeFileSync(join(dir, "opencode.jsonc"), '{\n  // my config\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "hewn": { "type": "remote", "url": "http://127.0.0.1:7717/mcp", },\n  },\n}\n');
      assert.equal(opencodeMcpUrl(root), "http://127.0.0.1:7717/mcp");
      writeFileSync(join(dir, "opencode.json"), JSON.stringify({ mcp: { servers: { hewn: { type: "remote", url: "http://127.0.0.1:7718/mcp" } } } }));
      assert.equal(opencodeMcpUrl(root), "http://127.0.0.1:7718/mcp", "opencode.json first, the newer nested shape");
      writeFileSync(join(dir, "opencode.json"), "{ not json");
      assert.equal(opencodeMcpUrl(root), "http://127.0.0.1:7717/mcp", "an unreadable file is skipped");
      assert.deepEqual(parseJsonc('{"a": "// not a comment", /* c */ "b": [1, 2,], }'), { a: "// not a comment", b: [1, 2] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("connecting: `opencode mcp add` in its global config dir, the pointer in its global AGENTS.md, then `opencode mcp auth`", () => {
    const calls: { argv: string[]; cwd?: string }[] = [];
    const h = harnesses((command, args, opts) => void calls.push({ argv: [command, ...args], cwd: opts?.cwd })).find((x) => x.agentId === "opencode")!;
    assert.equal(h.label, "OpenCode");
    assert.ok(h.pointerRequired);
    const root = mkdtempSync(join(tmpdir(), "hewn-oc-setup-"));
    try {
      const steps = h.steps({ url: "http://127.0.0.1:7717/mcp", home: root, pointer: true });
      assert.deepEqual(steps.map((s) => s.kind), ["register", "pointer"]);
      for (const s of steps) s.run();
      assert.deepEqual(calls, [{ argv: ["opencode", "mcp", "add", "hewn", "--url", "http://127.0.0.1:7717/mcp"], cwd: join(root, ".config", "opencode") }]);
      assert.match(readFileSync(join(root, ".config", "opencode", "AGENTS.md"), "utf8"), /live in the `hewn` MCP server/);
      assert.deepEqual(h.login("http://127.0.0.1:7717/mcp"), ["opencode", "mcp", "auth", "hewn"]);
      assert.match(h.loginFix("Unknown command: mcp"), /too old/);
      assert.match(h.loginFix("MCP server not found: hewn"), /too old/);
      assert.match(h.loginFix("Error: connect ECONNREFUSED"), /opencode mcp auth hewn/);
      // Uninstall: no `mcp remove` to run, so Hewn edits the config itself (plain JSON), and drops its sign-in from OpenCode's MCP logins.
      writeFileSync(join(root, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { hewn: { type: "remote", url: "http://127.0.0.1:7717/mcp" }, other: { type: "remote", url: "http://x/mcp" } }, theme: "dark" }));
      mkdirSync(join(root, ".local", "share", "opencode"), { recursive: true });
      writeFileSync(join(root, ".local", "share", "opencode", "mcp-auth.json"), JSON.stringify({ hewn: { tokens: { access: "t" } }, other: { tokens: {} } }));
      const plan = uninstallPlan({ homeRoot: join(root, "data"), backupDir: join(root, "backups"), appDir: root, bundled: true, userHome: root, harnesses: harnesses(), exec: () => {}, service: { installed: false, uninstall: () => {} }, binDirs: [], keySource: "file", linux: false });
      const cfgFile = join(root, ".config", "opencode", "opencode.json");
      assert.deepEqual(plan.steps.map((s) => s.describe), [`remove Hewn from OpenCode (take "hewn" out of "mcp" in ${cfgFile}, and its sign-in to Hewn)`, `remove the Hewn pointer block from ${join(root, ".config", "opencode", "AGENTS.md")}`]);
      assert.doesNotMatch(plan.leftovers.join("\n"), /OpenCode/);
      plan.steps[0].run();
      assert.deepEqual(JSON.parse(readFileSync(cfgFile, "utf8")), { mcp: { other: { type: "remote", url: "http://x/mcp" } }, theme: "dark" }, "the rest of the config stays");
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".local", "share", "opencode", "mcp-auth.json"), "utf8")), { other: { tokens: {} } }, "its sign-in to Hewn goes, others stay");
      assert.equal(harnesses().find((x) => x.agentId === "opencode")!.registered(root), false);
      // A .jsonc with comments isn't rewritten: the entry is listed for the owner instead.
      rmSync(cfgFile);
      writeFileSync(join(root, ".config", "opencode", "opencode.jsonc"), '{\n  // mine\n  "mcp": { "servers": { "hewn": { "url": "http://127.0.0.1:7717/mcp" } } },\n}\n');
      const plan2 = uninstallPlan({ homeRoot: join(root, "data"), backupDir: join(root, "backups"), appDir: root, bundled: true, userHome: root, harnesses: harnesses(), exec: () => {}, service: { installed: false, uninstall: () => {} }, binDirs: [], keySource: "file", linux: false });
      assert.ok(!plan2.steps.some((s) => /remove Hewn from OpenCode/.test(s.describe)));
      assert.match(plan2.leftovers.join("\n"), /Hewn in OpenCode: take "hewn" out of "mcp" in .*opencode\.jsonc \(it has comments/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the first run and doctor list it: installed, and signed in when it has a credential", () => {
    const s = toolStatus((bin) => bin === "opencode", (name) => (name === "opencode" ? true : undefined));
    assert.deepEqual(s.find((t) => t.name === "opencode"), { name: "opencode", label: "OpenCode", found: true, loggedIn: true });
    assert.equal(toolStatus(() => false).find((t) => t.name === "opencode")?.fix, "Install it: curl -fsSL https://opencode.ai/install | bash");
  });
});
