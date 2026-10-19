// SPDX-License-Identifier: AGPL-3.0-or-later
// What builds run on: the owner's model and effort (Settings › AI), what agents may ask for, the
// model a build reports, a pinned model that isn't there any more, refusals, and the cap on builds
// running at once.
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER, WEB_USER } from "@hewntools/core/auth.ts";
import { explainFailure } from "@hewntools/core/failure.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { writeConfig } from "@hewntools/cli/config.ts";
import { claudeCatalog, codexCatalogFrom, MODEL_REJECTED } from "@hewntools/cli/builders/models.ts";
import { claudeModelArgs, codexModelArgs, withModelFallback } from "@hewntools/cli/builders/cli.ts";
import { settingsProblems } from "@hewntools/host-workerd/surface/host.ts";
import { toolsFor } from "@hewntools/host-workerd/mcp.ts";
import { notesSince } from "@hewntools/cli/upgrade.ts";
import { platformWith, SEED, serve, setup } from "./helpers.ts";

/** A builder that records each job and writes the seed (or does what `run` says). */
function recorder(name = "fake", run?: (job: BuildJob) => Promise<void> | void): CapabilityBuilder & { jobs: BuildJob[] } {
  const jobs: BuildJob[] = [];
  return {
    name,
    jobs,
    async build(job) {
      jobs.push(job);
      if (run) await run(job);
      else cpSync(SEED, job.workspace, { recursive: true });
    },
  };
}

const ask = { name: "Running Log", purpose: "runs", requirements: "record runs" };

describe("models for builds", () => {
  let t: ReturnType<typeof setup>;
  let platform: Platform;
  let b: ReturnType<typeof recorder>;
  const use = (builder: ReturnType<typeof recorder>, opts: { attempts?: number; maxRunningBuilds?: number } = {}) => {
    b = builder;
    platform = platformWith(t.home, () => b, { attempts: opts.attempts ?? 1, ...(opts.maxRunningBuilds ? { maxRunningBuilds: opts.maxRunningBuilds } : {}) });
  };

  beforeEach(() => (t = setup()));
  afterEach(() => {
    platform?.close();
    t.cleanup();
  });

  test("nothing asked: the owner's model and effort for that builder (Settings › AI)", async () => {
    writeConfig(t.home, { jobModels: { builder: { fake: { model: "fable", effort: "high" } } } });
    use(recorder());
    const done = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(b.jobs[0].model, "fable");
    assert.equal(b.jobs[0].effort, "high");
    assert.deepEqual(done.model, { model: "fable", effort: "high" });
  });

  test("no setting: the builder's own default (no model passed)", async () => {
    use(recorder());
    const done = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(b.jobs[0].model, undefined);
    assert.equal(done.model, undefined);
  });

  test("the owner may ask for any model; 'default' means the builder's own", async () => {
    writeConfig(t.home, { jobModels: { builder: { fake: { model: "fable" } } } });
    use(recorder());
    await platform.settle((await platform.create(WEB_USER, { ...ask, model: "claude-opus-4-1", effort: "max" })).buildId);
    assert.equal(b.jobs[0].model, "claude-opus-4-1");
    assert.equal(b.jobs[0].effort, "max");
    await platform.settle((await platform.modify(WEB_USER, { capabilityId: "running-log", request: "x", model: "default" })).buildId);
    assert.equal(b.jobs[1].model, undefined, "default: no --model at all, not the owner's setting");
  });

  test("an agent only gets models the owner allows; others are an error naming the allowed ones", async () => {
    use(recorder());
    await assert.rejects(platform.create(t.claude, { ...ask, model: "opus" }), (e: Error) => /doesn't let agents ask for 'opus'.*you may ask for: default$/.test(e.message));
    assert.equal(b.jobs.length, 0, "nothing was built");
    writeConfig(t.home, { agentModels: { fake: ["default", "opus"] } });
    assert.deepEqual(platform.agentModelChoices(), ["default", "opus"]);
    const done = await platform.settle((await platform.create(t.claude, { ...ask, model: "opus", effort: "low" })).buildId);
    assert.equal(done.status, "promoted");
    assert.equal(b.jobs[0].model, "opus");
    assert.deepEqual(done.model, { model: "opus", effort: "low" });
    // An effort alone keeps the owner's model.
    writeConfig(t.home, { jobModels: { builder: { fake: { model: "sonnet" } } } });
    await platform.settle((await platform.modify(t.claude, { capabilityId: "running-log", request: "x", effort: "high" })).buildId);
    assert.equal(b.jobs[1].model, "sonnet");
    assert.equal(b.jobs[1].effort, "high");
  });

  test("names and efforts are checked", async () => {
    use(recorder());
    await assert.rejects(platform.create(WEB_USER, { ...ask, model: "--dangerous" }), /model must be a model name/);
    await assert.rejects(platform.create(WEB_USER, { ...ask, effort: "HIGH!" }), /effort must be a level/);
  });

  test("a retry runs on what the build was asked to run on; an agent's own retry is checked again", async () => {
    writeConfig(t.home, { agentModels: { fake: ["default", "opus"] } });
    let fail = true;
    use(recorder("fake", (job) => {
      if (fail) throw new Error("boom");
      cpSync(SEED, job.workspace, { recursive: true });
    }));
    const first = await platform.settle((await platform.create(t.claude, { ...ask, model: "opus" })).buildId);
    assert.equal(first.status, "failed");
    writeConfig(t.home, { agentModels: { fake: ["default"] } });
    fail = false;
    await assert.rejects(platform.retryBuild(t.claude, first.buildId), /doesn't let agents ask for 'opus'/, "the owner unticked it since");
    // The owner's retry, and an automatic one after a restart, run on what was asked.
    const again = await platform.settle((await platform.retryBuild(USER, first.buildId)).buildId);
    assert.equal(again.status, "promoted", again.log.join("\n"));
    assert.equal(b.jobs.at(-1)!.model, "opus");
  });

  test("the model it ran on, and a fallback note, are kept on the build", async () => {
    writeConfig(t.home, { jobModels: { builder: { fake: { model: "fable-old" } } } });
    use(recorder("fake", (job) => {
      job.onNote?.({ kind: "fallback", model: "fable-old", text: "fable-old isn't available; building with the default model instead" });
      job.onModel?.("claude-fable-5-5");
      cpSync(SEED, job.workspace, { recursive: true });
    }));
    const done = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(done.status, "promoted");
    assert.equal(done.model!.ran, "claude-fable-5-5");
    assert.equal(done.model!.note!.model, "fable-old");
  });

  test("a refusal (over quota) fails at once with the host's reason, no further attempts", async () => {
    use(recorder("fake", () => {
      throw Object.assign(new Error("You've used this month's 40 builds; more on 1 November."), { refused: true });
    }), { attempts: 3 });
    const done = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(done.status, "failed");
    assert.equal(b.jobs.length, 1, "not retried");
    assert.equal(done.failure!.title, "Not built");
    assert.match(done.failure!.detail, /40 builds/);
    assert.deepEqual(explainFailure(["FAILED: refused: no"]).title, "Not built");
  });

  test("at most N builds run at once; the rest wait their turn, and a waiting one can be cancelled", async () => {
    const gates: (() => void)[] = [];
    // The seed, as the capability this build creates.
    const write = (job: BuildJob) => {
      cpSync(SEED, job.workspace, { recursive: true });
      const path = join(job.workspace, "capability.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), id: job.capabilityId }));
    };
    use(recorder("fake", (job) => new Promise<void>((ok) => gates.push(() => (write(job), ok())))), { maxRunningBuilds: 1 });
    const one = await platform.create(t.claude, ask);
    const two = await platform.create(t.claude, { ...ask, name: "Second Log" });
    const three = await platform.create(t.claude, { ...ask, name: "Third Log" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.jobs.length, 1, "only one builder runs");
    assert.match((await platform.workbench.transcript(two.buildId)) ?? "", /queued: 1 builds are running/);
    platform.cancelBuild(USER, three.buildId);
    gates.shift()!();
    assert.equal((await platform.settle(one.buildId)).status, "promoted");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.jobs.length, 2, "the next one started once a place was free");
    gates.shift()!();
    const second = await platform.settle(two.buildId);
    assert.equal(second.status, "promoted", second.log.join("\n"));
    assert.equal(platform.getBuild(USER, three.buildId).status, "cancelled");
    assert.equal(b.jobs.length, 2, "the cancelled one never ran");
  });

  test("agents' build tools name the models they may ask for", () => {
    use(recorder());
    writeConfig(t.home, { agentModels: { fake: ["default", "fable"] } });
    const create = toolsFor(platform, t.claude).find((x) => x.name === "capabilities_create")!;
    assert.match(create.description, /Models you may ask for \(model\): default, fable\./);
    assert.ok("model" in (create.inputSchema as { properties: object }).properties);
  });
});

describe("model lists and flags", () => {
  test("Claude Code: Default and the families; full names accepted", () => {
    const c = claudeCatalog();
    assert.deepEqual(c.models.map((m) => m.id), ["default", "fable", "opus", "sonnet", "haiku"]);
    assert.equal(c.models[1].kind, "family");
    assert.ok(c.other);
    assert.deepEqual(c.models[1].efforts, ["low", "medium", "high", "xhigh", "max"]);
  });

  test("Codex: its catalog, in its order, listed ones only, with efforts and successors", () => {
    const raw = JSON.stringify({
      models: [
        { slug: "gpt-b", display_name: "GPT-B", priority: 5, visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], upgrade: null },
        { slug: "hidden", priority: 1, visibility: "hide" },
        { slug: "gpt-a", display_name: "GPT-A", priority: 2, visibility: "list", supported_reasoning_levels: [{ effort: "low" }], upgrade: { model: "gpt-b" } },
      ],
    });
    const c = codexCatalogFrom(raw);
    assert.deepEqual(c.models.map((m) => m.id), ["default", "gpt-a", "gpt-b"]);
    assert.equal(c.models[1].kind, "pinned");
    assert.equal(c.models[1].upgrade, "gpt-b");
    assert.equal(c.models[2].defaultEffort, "medium");
    assert.deepEqual(c.models[2].efforts, ["low", "high"]);
    assert.ok(!c.other, "a readable catalog is the list");
  });

  test("flags: Claude Code --model/--effort, Codex -m and reasoning effort", () => {
    assert.deepEqual(claudeModelArgs({ model: "fable", effort: "high" }), ["--model", "fable", "--effort", "high"]);
    assert.deepEqual(claudeModelArgs({}), []);
    assert.deepEqual(codexModelArgs({ model: "gpt-a", effort: "low" }), ["-m", "gpt-a", "-c", 'model_reasoning_effort="low"']);
  });

  test("a model the CLI won't run: noted, then built on the default", async () => {
    assert.match("There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it.", MODEL_REJECTED);
    assert.match('{"type":"error","message":"The model `gpt-x` does not exist"}', MODEL_REJECTED);
    assert.doesNotMatch("→ Edit src/models.ts", MODEL_REJECTED);
    const runs: (string | undefined)[] = [];
    const notes: string[] = [];
    const job = { buildId: "b1", capabilityId: "x", kind: "create", workspace: "/tmp", attempt: 1, logPath: "/dev/null", model: "fable-5-1", onNote: (n: { text: string }) => notes.push(n.text) } as BuildJob;
    await withModelFallback(job, async (j) => {
      runs.push(j.model);
      if (j.model) throw Object.assign(new Error("issue with the selected model"), { modelRejected: true });
    });
    assert.deepEqual(runs, ["fable-5-1", undefined]);
    assert.match(notes[0], /fable-5-1 isn't available/);
    // Other failures aren't retried on the default.
    await assert.rejects(withModelFallback(job, async () => Promise.reject(new Error("boom"))), /boom/);
  });
});

describe("settings for models", () => {
  const base = { builder: "claude", intake: "claude", maxBuildAttempts: 3, sandbox: true, logRetentionDays: 14 };
  test("remote is a choice only where the host offers it; a saved one doesn't block other changes", () => {
    assert.deepEqual(settingsProblems({ ...base, builder: "remote" }), ["builder must be claude, codex"]);
    assert.deepEqual(settingsProblems({ ...base, builder: "remote" }, { changed: ["timeZone"] }), []);
    assert.deepEqual(settingsProblems({ ...base, builder: "remote", intake: "remote" }, { remote: true }), []);
  });
  test("jobModels and agentModels are checked", () => {
    assert.deepEqual(settingsProblems({ ...base, jobModels: { builder: { claude: { model: "fable", effort: "high" } }, intake: { codex: {} } }, agentModels: { claude: ["default", "fable"] } }), []);
    assert.equal(settingsProblems({ ...base, jobModels: { cook: {} } }).length, 1);
    assert.equal(settingsProblems({ ...base, jobModels: { builder: { claude: { model: "--x" } } } }).length, 1);
    assert.equal(settingsProblems({ ...base, agentModels: { claude: "fable" } }).length, 1);
  });
});

describe("release notes for About", () => {
  const changelog = `# Changelog

## 0.5.0 (2026-11-20)

- **Next line.** Not this one.

## 0.4.3 (unreleased)

- **Not out yet.**

## 0.4.2 (2026-10-21)

- **One choice for building.** Talking it through and building are
  one job now.
- Smaller fix.

## 0.4.1 (2026-10-19)

- **Old.**
`;
  test("newer releases in the same line, released only, bullets joined", () => {
    const notes = notesSince(changelog, "0.4.1");
    assert.deepEqual(notes, [{ version: "0.4.2", date: "2026-10-21", items: ["**One choice for building.** Talking it through and building are one job now.", "Smaller fix."] }]);
    assert.deepEqual(notesSince(changelog, "0.4.2"), []);
  });
});

describe("web: models for building", () => {
  let t: ReturnType<typeof setup>;
  let platform: Platform;
  let server: import("node:http").Server;
  let port: number;
  let cookie = "";
  const api = (path: string, o: { method?: string; body?: unknown } = {}) =>
    new Promise<{ status: number; json: any }>((res, rej) => {
      const body = o.body !== undefined ? JSON.stringify(o.body) : undefined;
      const r = request(
        { host: "127.0.0.1", port, path: `/api${path}`, method: o.method ?? "GET", headers: { host: `hewn.localhost:${port}`, cookie, "x-hewn-ui": "1", ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) } },
        (m) => {
          let text = "";
          m.on("data", (d) => (text += d));
          m.on("end", () => res({ status: m.statusCode!, json: text ? JSON.parse(text) : undefined }));
        },
      );
      r.on("error", rej);
      r.end(body);
    });

  beforeEach(async () => {
    t = setup();
    // Named like Claude Code, so Settings' builder ("claude") is this one.
    const builder = recorder("claude", (job) => {
      if (job.model === "gone-1") job.onNote?.({ kind: "fallback", model: "gone-1", text: "gone-1 isn't available; building with the default model instead" });
      cpSync(SEED, job.workspace, { recursive: true });
      const path = join(job.workspace, "capability.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), id: job.capabilityId }));
    });
    platform = platformWith(t.home, () => builder);
    server = await serve(platform, t.home);
    port = (server.address() as import("node:net").AddressInfo).port;
    const signin = await new Promise<string>((res, rej) =>
      request({ host: "127.0.0.1", port, path: `/auth?ticket=${platform.createWebTicket(USER)}`, headers: { host: `hewn.localhost:${port}` } }, (m) => (m.resume(), res(String(m.headers["set-cookie"]).split(";")[0]))).on("error", rej).end(),
    );
    cookie = signin;
  });
  afterEach(async () => {
    await platform.drain();
    await new Promise((r) => server.close(r));
    platform.close();
    t.cleanup();
  });

  test("each agent's model list; the owner's model per job and agent, checked", async () => {
    assert.deepEqual((await api("/tools/claude/models")).json.models.map((m: { id: string }) => m.id), ["default", "fable", "opus", "sonnet", "haiku"]);
    assert.equal((await api("/settings", { method: "PUT", body: { jobModels: { builder: { claude: { model: "--x" } } } } })).status, 400);
    assert.equal((await api("/settings", { method: "PUT", body: { builder: "remote" } })).status, 400, "no host builder here");
    const s = (await api("/settings", { method: "PUT", body: { jobModels: { builder: { claude: { model: "fable", effort: "high" } } }, agentModels: { claude: ["default", "fable"] } } })).json;
    assert.deepEqual(s.jobModels.builder.claude, { model: "fable", effort: "high" });
    assert.deepEqual(s.agentModels.claude, ["default", "fable"]);
  });

  test("the intake's + picks a model for one build; the build page and Activity say what it ran on", async () => {
    const b = (await api("/capabilities", { method: "POST", body: { name: "Model Pick", purpose: "p", requirements: "r", model: "opus", effort: "low" } })).json;
    assert.deepEqual(b.model, { model: "opus", effort: "low" });
    await platform.settle(b.buildId);
    const items = (await api("/activity?kinds=build")).json.items;
    assert.deepEqual(items.find((i: { buildId: string }) => i.buildId === b.buildId).buildModel, { model: "opus", effort: "low" });
  });

  test("a pinned model that's gone: the build runs on the default and the Inbox says so, until the owner picks another", async () => {
    await api("/settings", { method: "PUT", body: { jobModels: { builder: { claude: { model: "gone-1" } } } } });
    const b = (await api("/capabilities", { method: "POST", body: { name: "Fell Back", purpose: "p", requirements: "r" } })).json;
    assert.equal((await platform.settle(b.buildId)).status, "promoted");
    const notice = (await api("/inbox")).json.needs.find((n: { kind: string }) => n.kind === "builder-model");
    assert.ok(notice, "the Inbox names it");
    assert.match(notice.detail, /gone-1 isn't available any more/);
    await api("/settings", { method: "PUT", body: { jobModels: { builder: { claude: { model: "fable" } } } } });
    assert.ok(!(await api("/inbox")).json.needs.some((n: { kind: string }) => n.kind === "builder-model"), "gone once the owner picks another");
  });
});
