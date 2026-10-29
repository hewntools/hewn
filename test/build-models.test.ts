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
import { claudeCatalog, codexCatalogFrom, MODEL_REJECTED, modelCatalogs, modelRejectReason, noteModelFailure, noteModelRan, opencodeCatalogFrom } from "@hewntools/cli/builders/models.ts";
import { builderEnv, claudeModelArgs, codexModelArgs, modelUnavailableText, OPENCODE_PROVIDER_ENV, withModelCheck } from "@hewntools/cli/builders/cli.ts";
import { builderProfile } from "@hewntools/cli/builders/sandbox.ts";
import { intakeJob, type ModelCatalog, settingsProblems } from "@hewntools/host-workerd/surface/host.ts";
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
  const use = (builder: ReturnType<typeof recorder>, opts: { attempts?: number; maxRunningBuilds?: number; models?: (agent: string) => Promise<ModelCatalog> } = {}) => {
    b = builder;
    platform = platformWith(t.home, () => b, { attempts: opts.attempts ?? 1, ...(opts.maxRunningBuilds ? { maxRunningBuilds: opts.maxRunningBuilds } : {}), ...(opts.models ? { models: opts.models } : {}) });
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

  test("an agent's effort must be one its model takes (when the list can be read); the owner's isn't limited", async () => {
    writeConfig(t.home, { agentModels: { fake: ["default", "opus"] } });
    let readable = true;
    const models = async (agent: string): Promise<ModelCatalog> => {
      if (!readable) throw new Error("no list");
      return { agent, models: [{ id: "default", label: "Default", kind: "default", efforts: ["low", "high"] }, { id: "opus", label: "Opus", kind: "family", efforts: ["low", "max"] }] };
    };
    use(recorder(), { models });
    await assert.rejects(platform.create(t.claude, { ...ask, model: "opus", effort: "high" }), (e: Error) => /opus doesn't take effort 'high'; it takes: low, max$/.test(e.message));
    await assert.rejects(platform.create(t.claude, { ...ask, effort: "max" }), /default doesn't take effort 'max'; it takes: low, high$/);
    assert.equal(b.jobs.length, 0, "nothing was built");
    const done = await platform.settle((await platform.create(t.claude, { ...ask, model: "opus", effort: "max" })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    await assert.rejects(platform.addWidgets(t.claude, { capabilityId: "running-log", effort: "max" }), /it takes: low, high/);
    await platform.settle((await platform.modify(WEB_USER, { capabilityId: "running-log", request: "x", effort: "xhigh" })).buildId);
    assert.equal(b.jobs.at(-1)!.effort, "xhigh", "the owner may ask for any level");
    readable = false;
    await platform.settle((await platform.modify(t.claude, { capabilityId: "running-log", request: "y", effort: "max" })).buildId);
    assert.equal(b.jobs.at(-1)!.effort, "max", "no list: not checked");
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

  test("the model it ran on is kept on the build; a model that can't run fails it at once, saying so", async () => {
    writeConfig(t.home, { jobModels: { builder: { fake: { model: "fable" } } } });
    use(recorder("fake", (job) => {
      if (job.model === "gone-1") throw Object.assign(new Error("gone-1 isn't available. Pick another model (in the chat box or Settings › AI)."), { modelUnavailable: true });
      job.onModel?.("claude-fable-5-5");
      cpSync(SEED, job.workspace, { recursive: true });
    }), { attempts: 3 });
    const done = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(done.status, "promoted");
    assert.equal(done.model!.ran, "claude-fable-5-5");
    const gone = await platform.settle((await platform.modify(WEB_USER, { capabilityId: "running-log", request: "x", model: "gone-1" })).buildId);
    assert.equal(gone.status, "failed");
    assert.equal(b.jobs.length, 2, "not retried");
    assert.equal(gone.failure!.title, "Model not available");
    assert.match(gone.failure!.detail, /gone-1 isn't available\. Pick another/);
  });

  test("a host's charge: summed over attempts, shown as given; nonsense is dropped", async () => {
    let n = 0;
    use(recorder("fake", (job) => {
      job.onCharge?.({ amount: 4, unit: "points" });
      job.onCharge?.({ amount: -1, unit: "points" });
      job.onCharge?.({ amount: 1, unit: "<script>" });
      if (n++ === 0) return; // the first attempt writes nothing: validation fails, attempt 2 runs
      cpSync(SEED, job.workspace, { recursive: true });
    }), { attempts: 2 });
    const done = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(done.charge, { amount: 8, unit: "points" });
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

  test("paused by the host: no further attempts, shown as paused; only the owner continues it (a retry), Stop ends it", async () => {
    const pause = () => {
      throw Object.assign(new Error("This build has used 300 points and isn't finished. Its work is kept: Continue lets it go on for up to 300 more, or Stop it."), { paused: true });
    };
    use(recorder("fake", pause), { attempts: 3 });
    const first = await platform.settle((await platform.create(t.claude, ask)).buildId);
    assert.equal(first.status, "failed", "final for agents and waits");
    assert.equal(b.jobs.length, 1, "not retried by Hewn");
    assert.equal(first.failure!.title, "Paused");
    assert.equal(first.failure!.paused, true);
    assert.match(first.failure!.detail, /300 points[^]*Continue/);
    assert.match(first.instructions!, /Tell the owner; they Continue or Stop it in Hewn/);
    // Going on spends more of the owner's allowance: the agent that asked for it can't.
    await assert.rejects(platform.retryBuild(t.claude, first.buildId), /the owner continues a paused build in Hewn/);
    await assert.rejects(platform.retryBuild(t.claude, first.buildId, { fix: true }), /the owner continues a paused build in Hewn/);
    // Continue: a retry of it, which the host picks up from the kept work.
    const second = await platform.settle((await platform.retryBuild(USER, first.buildId)).buildId);
    assert.equal(b.jobs.at(-1)!.retryOf, first.buildId);
    const continued = platform.getBuild(t.claude, first.buildId);
    assert.equal(continued.continuedAs, second.buildId);
    assert.match(continued.instructions!, new RegExp(`continued this build as build ${second.buildId}`));
    assert.throws(() => platform.cancelBuild(t.claude, first.buildId), new RegExp(`was continued as ${second.buildId}`), "continued: no Stop for it");
    // Stop: the paused one ends (cancelled), by the owner or whoever asked for it; a build that really failed can't be stopped.
    assert.throws(() => platform.cancelBuild(t.claude, second.buildId), /only the owner or user can cancel/, "the owner continued it");
    assert.equal(platform.cancelBuild(USER, second.buildId).status, "cancelled");
    assert.match(platform.getBuild(USER, second.buildId).log.at(-1)!, /CANCELLED by user \(stopped while paused\)/);
    const third = await platform.settle((await platform.create(t.claude, { ...ask, name: "Bike Log" })).buildId);
    assert.equal(platform.cancelBuild(t.claude, third.buildId).status, "cancelled");
    assert.match(platform.getBuild(t.claude, third.buildId).log.at(-1)!, /CANCELLED by claude-code \(stopped while paused\)/);
    use(recorder("fake", () => {
      throw Object.assign(new Error("You've used this month's 40 builds."), { refused: true });
    }), { attempts: 1 });
    const refused = await platform.settle((await platform.create(t.claude, { ...ask, name: "Other Log" })).buildId);
    assert.throws(() => platform.cancelBuild(t.claude, refused.buildId), /already failed/);
    assert.deepEqual(explainFailure(["attempt 1: …", "FAILED: 1 of 2 test cases failed", "PAUSED: kept"]), { title: "Paused", detail: "kept", attempt: 1, paused: true });
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

  test("a model the CLI won't run stops the build, saying so; other failures pass through", async () => {
    assert.match("There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it.", MODEL_REJECTED);
    assert.match('{"type":"error","message":"The model `gpt-x` does not exist"}', MODEL_REJECTED);
    assert.doesNotMatch("→ Edit src/models.ts", MODEL_REJECTED);
    const job = { buildId: "b1", capabilityId: "x", kind: "create", workspace: "/tmp", attempt: 1, logPath: "/dev/null", model: "fable-5-1" } as BuildJob;
    await assert.rejects(
      withModelCheck("claude", job, async () => Promise.reject(Object.assign(new Error("issue with the selected model"), { modelRejected: true }))),
      (e: Error & { modelUnavailable?: boolean }) => e.modelUnavailable === true && /^fable-5-1 isn't available \(issue with the selected model\)\. Pick another/.test(e.message),
    );
    await assert.rejects(withModelCheck("claude", job, async () => Promise.reject(new Error("boom"))), /boom/);
  });

  test("the reason comes in the agent's words, and the lists mark a model that failed lately", async () => {
    assert.equal(modelRejectReason('{"type":"error","error":{"name":"APIError","data":{"message":"Upstream request failed: Model is unavailable.","statusCode":400}}}'), "Upstream request failed: Model is unavailable");
    assert.equal(modelRejectReason("intake failed: Upstream request failed: Model is unavailable."), "Upstream request failed: Model is unavailable");
    assert.equal(modelRejectReason("model not found: opencode/foo (not in opencode models)"), "OpenCode doesn't list it");
    assert.equal(modelRejectReason('{"type":"turn.failed","error":{"message":"The model `gpt-x` does not exist"}}'), "The model `gpt-x` does not exist");
    assert.equal(modelRejectReason("There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it."), "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it");
    // OpenCode's free tier: why the list offered it anyway. A misspelled one gets no such note.
    assert.equal(
      modelUnavailableText("opencode/deepseek-v4-flash-free", "Upstream request failed: Model is unavailable"),
      "opencode/deepseek-v4-flash-free isn't available (Upstream request failed: Model is unavailable). Pick another model (in the chat box or Settings › AI). OpenCode's free tier changes which models it serves, and its list can lag behind; Hewn's lists mark the ones that failed lately.",
    );
    assert.equal(modelUnavailableText("opencode/big-pickel", "OpenCode doesn't list it"), "opencode/big-pickel isn't available (OpenCode doesn't list it). Pick another model (in the chat box or Settings › AI).");
    assert.equal(modelUnavailableText("gpt-x"), "gpt-x isn't available. Pick another model (in the chat box or Settings › AI).");
    // The mark: on the list for the model that failed, gone once a run on it goes through.
    const catalogs = modelCatalogs({ catalogs: { opencode: async () => opencodeCatalogFrom("opencode/big-pickle\nopencode/hy3-free\n"), claude: async () => claudeCatalog() } });
    noteModelFailure("opencode", "opencode/hy3-free", "Upstream request failed: Model is unavailable");
    let cat = await catalogs("opencode");
    assert.equal(cat.models.find((m) => m.id === "opencode/big-pickle")?.failed, undefined);
    assert.equal(cat.models.find((m) => m.id === "opencode/hy3-free")?.failed?.reason, "Upstream request failed: Model is unavailable");
    assert.ok(Date.now() - Date.parse(cat.models.find((m) => m.id === "opencode/hy3-free")!.failed!.at) < 5_000);
    noteModelRan("opencode", "opencode/hy3-free");
    cat = await catalogs("opencode");
    assert.equal(cat.models.find((m) => m.id === "opencode/hy3-free")?.failed, undefined);
    // The builder's check marks it too (and a different agent's list doesn't show it).
    const job = { buildId: "b2", capabilityId: "x", kind: "create", workspace: "/tmp", attempt: 1, logPath: "/dev/null", model: "fable" } as BuildJob;
    await assert.rejects(withModelCheck("claude", job, async () => Promise.reject(Object.assign(new Error("issue with the selected model"), { modelRejected: true }))));
    assert.equal((await catalogs("claude")).models.find((m) => m.id === "fable")?.failed?.reason, "issue with the selected model");
    assert.equal((await catalogs("opencode")).models.find((m) => m.failed), undefined);
    await withModelCheck("claude", job, async () => {});
    assert.equal((await catalogs("claude")).models.find((m) => m.id === "fable")?.failed, undefined);
  });

  test("the other providers' keys reach the OpenCode run only; your OpenCode dirs stay closed where XDG puts them; only passable levels are offered", () => {
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "r", GOOGLE_GENERATIVE_AI_API_KEY: "g", GOOGLE_CLOUD_PROJECT: "p", OLLAMA_HOST: "h", OPENCODE_API_KEY: "o", AWS_SECRET_ACCESS_KEY: "s" };
    assert.deepEqual(Object.keys(builderEnv(env)).sort(), ["ANTHROPIC_API_KEY", "PATH"], "Claude Code's and Codex's runs see none of them");
    assert.deepEqual(Object.keys(builderEnv(env, OPENCODE_PROVIDER_ENV)).sort(), ["ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OLLAMA_HOST", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "PATH"], "never a cloud project or an AWS secret");
    // The sandbox: XDG-moved OpenCode directories are denied like the defaults (for your own home; another home isn't moved).
    const profile = builderProfile({ workspace: "/tmp/ws", platformRoot: "/tmp/home", ownState: [], denyKeychain: true, env: { XDG_DATA_HOME: "/x/data", XDG_CONFIG_HOME: "/x/cfg" } });
    assert.match(profile, /\/x\/data\/opencode/);
    assert.match(profile, /\/x\/cfg\/opencode/);
    assert.doesNotMatch(builderProfile({ workspace: "/tmp/ws", platformRoot: "/tmp/home", ownState: [], denyKeychain: true, home: "/tmp/other", env: { XDG_DATA_HOME: "/x/data" } }), /\/x\/data/);
    // A variant Hewn can't pass as an effort (EFFORT: letters only) isn't offered, so what's listed is what's sent.
    const cat = opencodeCatalogFrom('opencode/x\n{\n  "id": "x",\n  "name": "X",\n  "variants": {\n    "low": {},\n    "high": {},\n    "thinking-32k": {}\n  }\n}\n');
    assert.deepEqual(cat.models.find((m) => m.id === "opencode/x")?.efforts, ["low", "high"]);
  });

});

describe("settings for models", () => {
  const base = { builder: "claude", intake: "claude", maxBuildAttempts: 3, sandbox: true, logRetentionDays: 14 };
  test("remote is a choice only where the host offers it; a saved one doesn't block other changes", () => {
    assert.deepEqual(settingsProblems({ ...base, builder: "remote" }), ["builder must be claude, codex, opencode"]);
    assert.deepEqual(settingsProblems({ ...base, builder: "remote" }, { changed: ["timeZone"] }), []);
    assert.deepEqual(settingsProblems({ ...base, builder: "remote", intake: "remote" }, { remote: true }), []);
  });
  test("jobModels and agentModels are checked", () => {
    assert.deepEqual(settingsProblems({ ...base, jobModels: { builder: { claude: { model: "fable", effort: "high" } }, intake: { codex: {} } }, agentModels: { claude: ["default", "fable"] } }), []);
    assert.equal(settingsProblems({ ...base, jobModels: { cook: {} } }).length, 1);
    assert.equal(settingsProblems({ ...base, jobModels: { builder: { claude: { model: "--x" } } } }).length, 1);
    assert.equal(settingsProblems({ ...base, agentModels: { claude: "fable" } }).length, 1);
  });
  test("the intake runs on the builder's agent, on its intake model, else its model for building", () => {
    const jobModels = { builder: { claude: { model: "fable", effort: "high" } }, intake: { codex: { model: "gpt-5.5" } } };
    assert.deepEqual(intakeJob({ builder: "claude", jobModels }), { agent: "claude", run: { model: "fable", effort: "high" } }, "an older split setting (intake on codex) doesn't count");
    assert.deepEqual(intakeJob({ builder: "claude", jobModels: { ...jobModels, intake: { claude: {} } } }), { agent: "claude", run: {} });
    assert.deepEqual(intakeJob({ builder: "codex" }), { agent: "codex", run: {} });
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
  /** Set: the builder's host pauses the next builds, with this note. */
  let pause: string | undefined;
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
    pause = undefined;
    // Named like Claude Code, so Settings' builder ("claude") is this one.
    const builder = recorder("claude", (job) => {
      if (pause !== undefined) throw Object.assign(new Error(pause), { paused: true });
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

  test("a schedule that paused itself after failing is in the Inbox; one the owner paused isn't", async () => {
    const b = (await api("/capabilities", { method: "POST", body: { name: "Run Log", purpose: "p", requirements: "r" } })).json;
    assert.equal((await platform.settle(b.buildId)).status, "promoted");
    const sch = platform.createSchedule(USER, { capabilityId: b.capabilityId, operation: "list_runs", cadence: "daily 12:30" } as any);
    platform.schedules.update(sch.id, { status: "paused", failures: 3, pausedReason: "paused after 3 failures in a row" });
    const need = (await api("/inbox")).json.needs.find((n: { id: string }) => n.id === sch.id);
    assert.ok(need, "the Inbox names it");
    assert.equal(need.severity, "danger");
    assert.match(need.detail, /stopped running daily 12:30: it failed 3 times in a row/);
    platform.schedules.update(sch.id, { failures: 0, pausedReason: null });
    assert.ok(!(await api("/inbox")).json.needs.some((n: { id: string }) => n.id === sch.id), "paused by the owner: not news");
  });

  test("a paused build: the Inbox asks to continue it (not a failure), Home and Info know; once continued, it's dealt with", async () => {
    const b = (await api("/capabilities", { method: "POST", body: { name: "Run Log", purpose: "p", requirements: "r" } })).json;
    assert.equal((await platform.settle(b.buildId)).status, "promoted");
    pause = "This build has used 300 points and isn't finished.";
    const change = (await api(`/capabilities/${b.capabilityId}/modify`, { method: "POST", body: { request: "group by week" } })).json;
    assert.equal((await platform.settle(change.buildId)).status, "failed");
    const need = (await api("/inbox")).json.needs.find((n: { buildId?: string }) => n.buildId === change.buildId);
    assert.deepEqual([need.detail, need.severity, need.action], ["Paused · This build has used 300 points and isn't finished.", "warn", "Continue…"]);
    const tool = async () => (await api("/capabilities")).json.find((c: { id: string }) => c.id === b.capabilityId);
    assert.deepEqual((await tool()).lastBuild, { buildId: change.buildId, status: "failed", builder: "claude", paused: true });
    // Continued: the build that carries it on is the last one, and the Inbox has nothing more to ask.
    pause = undefined;
    const next = (await api(`/builds/${change.buildId}/retry`, { method: "POST" })).json;
    await platform.settle(next.buildId);
    assert.equal((await api(`/builds/${change.buildId}`)).json.continuedAs, next.buildId);
    assert.ok(!(await api("/inbox")).json.needs.some((n: { buildId?: string }) => n.buildId === change.buildId));
    assert.equal((await tool()).lastBuild.buildId, next.buildId);
    assert.equal((await tool()).lastBuild.paused, undefined);
  });

  test("each agent's model list; the owner's model per job and agent, checked", async () => {
    const claude = (await api("/tools/claude/models")).json;
    assert.deepEqual(claude.models.map((m: { id: string }) => m.id), ["default", "fable", "opus", "sonnet", "haiku"]);
    // What agents may ask for, as the platform checks it: the same default the server uses.
    assert.deepEqual(claude.agentModels, ["default", "fable", "opus", "sonnet", "haiku"]);
    assert.deepEqual((await api("/tools/codex/models")).json.agentModels, ["default"]);
    assert.deepEqual((await api("/tools/remote/models")).json.agentModels, ["default"]);
    assert.equal((await api("/settings", { method: "PUT", body: { jobModels: { builder: { claude: { model: "--x" } } } } })).status, 400);
    assert.equal((await api("/settings", { method: "PUT", body: { builder: "remote" } })).status, 400, "no host builder here");
    const s = (await api("/settings", { method: "PUT", body: { jobModels: { builder: { claude: { model: "fable", effort: "high" } } }, agentModels: { claude: ["default", "fable"] } } })).json;
    assert.deepEqual(s.jobModels.builder.claude, { model: "fable", effort: "high" });
    assert.deepEqual(s.agentModels.claude, ["default", "fable"]);
    assert.deepEqual((await api("/tools/claude/models")).json.agentModels, ["default", "fable"]);
    assert.deepEqual(platform.agentModelChoices("claude"), ["default", "fable"]);
  });

  test("a client may pass a model for one build; the build page and Activity say what it ran on", async () => {
    const b = (await api("/capabilities", { method: "POST", body: { name: "Model Pick", purpose: "p", requirements: "r", model: "opus", effort: "low" } })).json;
    assert.deepEqual(b.model, { model: "opus", effort: "low" });
    await platform.settle(b.buildId);
    const items = (await api("/activity?kinds=build")).json.items;
    assert.deepEqual(items.find((i: { buildId: string }) => i.buildId === b.buildId).buildModel, { model: "opus", effort: "low" });
  });


});
