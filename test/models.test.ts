// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { Deadline } from "@hewntools/core/deadline.ts";
import { validateManifest } from "@hewntools/core/manifest.ts";
import { CATALOG_URL, type HostModels, imageSize, imageTokens, inspectRequest, parseCatalog, providerSchema, suggestTiers } from "@hewntools/core/models.ts";
import { MODEL_KEYS } from "@hewntools/core/platform.ts";
import { FIXTURES, installFrom, setup } from "./helpers.ts";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const HAIKU = "anthropic/claude-haiku-5-5";

/** A fake network: the model catalog, providers' model lists, and an Anthropic Messages endpoint. */
function fakeNet(o: { delayMs?: number; status?: number; keyStatus?: number; reply?: (body: any) => unknown } = {}) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith("https://api.anthropic.com/v1/models") || url === "https://api.openai.com/v1/models") {
      if (o.keyStatus) return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: o.keyStatus });
      if (url.includes("openai")) return Response.json({ data: [{ id: "text-only", created: 1 }, { id: "text-embedding-3", created: 2 }] });
      const m = (id: string, at: string, images = true) => ({ id, display_name: id, created_at: at, capabilities: { image_input: { supported: images } } });
      return Response.json({ data: [m("claude-haiku-5-5", "2026-09-01"), m("claude-haiku-4-5", "2025-10-01"), m("claude-sonnet-5-5", "2026-09-01"), m("claude-opus-5-5", "2026-09-01"), m("claude-fable-5-1", "2026-09-15")], has_more: false });
    }
    if (url === CATALOG_URL) {
      return Response.json({
        data: [
          { id: "anthropic/claude-haiku-5.5", context_length: 1000000, pricing: { prompt: "0.0000001", completion: "0.0000005" }, architecture: { input_modalities: ["text", "image"] } },
          { id: "openai/text-only", pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { input_modalities: ["text"] } },
        ],
      });
    }
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    if (o.delayMs) await new Promise((ok) => setTimeout(ok, o.delayMs));
    if (o.status) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: o.status });
    return Response.json(o.reply?.(body) ?? { content: [{ type: "text", text: JSON.stringify({ explanation: "Pleased." }) }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } });
  };
  return { fetch, calls };
}

function fixtureCopy(name: string, edit: (m: Record<string, any>, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), `hewn-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
  edit(m, dir);
  writeFileSync(join(dir, "capability.json"), JSON.stringify(m));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("model port: pure parts", () => {
  test("requires.model needs ABI 2.2, and a tier or a model, not both", () => {
    const m = (abi: string, model: unknown) => ({ id: "x", name: "X", purpose: "p", abi, requires: { model }, operations: [{ name: "a", description: "d", version: 1, inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read" }] });
    assert.deepEqual(validateManifest(m("2.2", { tier: "light" }), "x"), []);
    assert.match(validateManifest(m("2.1", { tier: "light" }), "x").join(), /"requires.model" needs ABI 2.2/);
    assert.match(validateManifest(m("2.2", { tier: "light", model: "openai/x" }), "x").join(), /either "tier"/);
    assert.match(validateManifest(m("2.2", { model: "acme/x" }), "x").join(), /model/);
  });

  test("requests are checked before any spend: shape, images, sizes", () => {
    assert.throws(() => inspectRequest({} as never, false), /either "prompt" or "messages"/);
    assert.throws(() => inspectRequest({ prompt: "x", maxTokens: 999_999 }, false), /maxTokens/);
    const img = { type: "image" as const, data: PNG_1x1, mediaType: "image/png" };
    assert.throws(() => inspectRequest({ prompt: [img] }, false), /requires.model/);
    assert.throws(() => inspectRequest({ prompt: [{ ...img, mediaType: "image/bmp" }] }, true), /mediaType/);
    assert.throws(() => inspectRequest({ prompt: [{ ...img, data: "aGVsbG8=" }] }, true), /readable image\/png/);
    assert.throws(() => inspectRequest({ prompt: Array(21).fill(img) }, true), /at most 20/);
    assert.throws(() => inspectRequest({ prompt: "x", schema: { type: "array" } }, false), /"type": "object"/);
    const r = inspectRequest({ system: "s", prompt: [img, { type: "text", text: "what?" }] }, true);
    assert.deepEqual(r.images, [{ width: 1, height: 1 }]);
    assert.equal(r.maxTokens, 1024);
  });

  test("image sizes from headers; image tokens are bounded", () => {
    assert.deepEqual(imageSize(Uint8Array.from(atob(PNG_1x1), (c) => c.charCodeAt(0)), "image/png"), { width: 1, height: 1 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]);
    assert.deepEqual(imageSize(gif, "image/gif"), { width: 16, height: 32 });
    assert.ok(imageTokens({ width: 8000, height: 8000 }) <= 4784 + 85);
  });

  test("the catalog lists OpenRouter models under their own provider too", () => {
    const entries = parseCatalog({ data: [{ id: "anthropic/claude-sonnet-5.5", pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { input_modalities: ["text", "image"] } }] });
    assert.deepEqual(entries.map((e) => e.id), ["openrouter/anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5-5"]);
    assert.deepEqual(entries[1].price, { input: 0.000002, output: 0.00001 });
  });

  test("schemas sent to providers drop what structured output rejects", () => {
    assert.deepEqual(providerSchema({ type: "object", properties: { n: { type: "integer", minimum: 1 }, s: { type: "string", maxLength: 3 } } }), {
      type: "object",
      properties: { n: { type: "integer" }, s: { type: "string" } },
      additionalProperties: false,
    });
  });

  test("suggested tiers: Anthropic by family (newest, no dated snapshots); OpenAI by price", () => {
    const a = suggestTiers(
      "anthropic",
      [
        { id: "claude-haiku-4-5-20251001", created: 3 },
        { id: "claude-haiku-5-5", created: 2 },
        { id: "claude-sonnet-5-5", created: 2 },
        { id: "claude-opus-5-5", created: 2 },
      ],
      () => ({}),
    );
    assert.deepEqual(a, { tiers: { light: "claude-haiku-5-5", standard: "claude-sonnet-5-5", strong: "claude-opus-5-5", max: "claude-opus-5-5" }, by: "family" });
    const price = { a: 1, b: 2, c: 3, d: 4, e: 5 } as Record<string, number>;
    const o = suggestTiers("openai", Object.keys(price).map((id) => ({ id })), (id) => ({ price: { input: 0, output: price[id] }, images: id !== "a" }));
    assert.deepEqual(o, { tiers: { light: "b", standard: "b", strong: "d", max: "e" }, by: "price" });
  });

  test("model waiting pauses the deadline, up to the allowance", () => {
    const d = new Deadline(1000, 500);
    d.beginWait(900);
    assert.equal(d.remaining(1200), 100, "paused while waiting");
    d.endWait(1300);
    assert.equal(d.at, 1400);
    assert.equal(d.modelLeftMs, 100);
    d.beginWait(1350);
    d.endWait(2000);
    assert.equal(d.at, 1500, "capped by what's left");
    assert.equal(d.modelLeftMs, 0);
  });
});

describe("model port: the platform", () => {
  let t: ReturnType<typeof setup>;
  let net: ReturnType<typeof fakeNet>;
  const ready = () => t.platform.readiness("word-explainer");

  const setUp = async (o: Parameters<typeof fakeNet>[0] = {}) => {
    net = fakeNet(o);
    t = setup({ modelFetch: (url, init) => net.fetch(url, init) });
    await installFrom(t.platform, join(FIXTURES, "word-explainer"));
  };
  const configure = async () => {
    await t.platform.refreshModelCatalog();
    await t.platform.setModelKey(USER, "anthropic", "sk-ant-test-key");
    t.platform.approveGrants(USER, "word-explainer");
  };
  afterEach(() => t?.cleanup());

  test("validation used the case's fake replies, never the network", async () => {
    await setUp();
    assert.equal(net.calls.length, 0);
  });

  test("not ready until the owner grants the model and sets it up", async () => {
    await setUp();
    assert.deepEqual(ready().pendingGrants, ["model:light"]);
    assert.match(ready().missingModel!, /no model provider is set up/);
    await t.platform.refreshModelCatalog();
    // The first key makes its provider active, with the suggested tiers (the newest of each family).
    const m = await t.platform.setModelKey(USER, "anthropic", "sk-ant-test-key");
    assert.equal(m.provider, "anthropic");
    assert.deepEqual(m.providers.find((p) => p.id === "anthropic")!.tiers, { light: "claude-haiku-5-5", standard: "claude-sonnet-5-5", strong: "claude-opus-5-5", max: "claude-fable-5-1" });
    assert.equal(ready().missingModel, undefined);
    t.platform.approveGrants(USER, "word-explainer");
    assert.equal(ready().ready, true);
    // Another provider: its own key and tiers; switching moves the tiers over.
    await t.platform.setModelKey(USER, "openai", "sk-openai-test");
    assert.equal(t.platform.models(USER).provider, "anthropic", "a second key doesn't switch");
    assert.deepEqual(t.platform.models(USER).providers.find((p) => p.id === "openai")!.models.map((x) => x.id), ["text-only"], "only chat models");
    t.platform.setModelSettings(USER, { provider: "openai", tiers: { openai: { light: "text-only" } } });
    assert.match(ready().missingModel!, /doesn't take images/);
    t.platform.setModelSettings(USER, { provider: "anthropic" });
    assert.equal(ready().missingModel, undefined, "switching back is instant");
    const auth = t.platform.authorization("word-explainer").items.find((i) => i.kind === "model")!;
    assert.match(auth.label, /use a light model, with images \(anthropic\/claude-haiku-5-5\)/);
  });

  test("a call runs host-side with the owner's key, costs from the catalog, and is recorded", async () => {
    await setUp();
    await configure();
    const r = await t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "gruntled" } });
    assert.deepEqual(r.result, { explanation: "Pleased.", cost: 1000 * 0.0000001 + 100 * 0.0000005, model: HAIKU });
    assert.equal(net.calls.length, 1);
    const [call] = net.calls;
    assert.equal(call.url, "https://api.anthropic.com/v1/messages");
    assert.equal(call.headers["x-api-key"], "sk-ant-test-key");
    assert.equal(call.body.model, "claude-haiku-5-5");
    assert.equal(call.body.output_config.format.type, "json_schema");
    const spend = t.platform.modelSpend(USER);
    assert.equal(spend.rows[0].capabilityId, "word-explainer");
    assert.equal(spend.rows[0].inputTokens, 1000);
    assert.ok(Math.abs(spend.totalUsd - 0.00015) < 1e-12);
    assert.ok(!JSON.stringify(t.platform.models(USER)).includes("sk-ant-test-key"), "keys are never shown");
    assert.ok(!JSON.stringify(t.platform.logLines("word-explainer", 50)).includes("sk-ant"), "nor logged");
  });

  test("images go to the provider as base64 blocks", async () => {
    await setUp({ reply: () => ({ content: [{ type: "text", text: "A dot." }], usage: { input_tokens: 90, output_tokens: 3 } }) });
    await configure();
    const r = await t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "describe", input: { data: PNG_1x1, mediaType: "image/png" } });
    assert.deepEqual(r.result, { text: "A dot." });
    assert.deepEqual(net.calls[0].body.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1 } });
  });

  test("the budget refuses a call that could go over the cap, before it is made", async () => {
    await setUp();
    await configure();
    t.platform.setModelSettings(USER, { monthlyCapUsd: 0 });
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "x" } }), /model budget: .*all tools together have spent \$0\.00 of the \$0\.00 monthly budget/);
    assert.equal(net.calls.length, 0);
    t.platform.setModelSettings(USER, { monthlyCapUsd: 5, capabilityCapsUsd: { "word-explainer": 0 } });
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "x" } }), /word-explainer has spent/);
  });

  test("a provider error fails the call and spends nothing", async () => {
    await setUp({ status: 401 });
    await configure();
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "x" } }), /the API key was refused/);
    assert.equal(t.platform.modelSpend(USER).totalUsd, 0);
  });

  test("a slow model doesn't use up the code's deadline", async () => {
    await setUp({ delayMs: 400 });
    await configure();
    // 200 ms of code time; the 400 ms model wait is added back.
    const r = await t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "x" } }, [t.claude.id], new Deadline(Date.now() + 200, 1000));
    assert.equal((r.result as { explanation: string }).explanation, "Pleased.");
    await assert.rejects(
      t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "x" } }, [t.claude.id], new Deadline(Date.now() + 200, 100)),
      /timed out|no reply in time|no time left/,
      "but only up to the allowance",
    );
  });

  test("the model grant can be revoked like any other", async () => {
    await setUp();
    await configure();
    assert.equal(ready().ready, true);
    t.platform.revokeGrant(USER, "word-explainer", "model:light");
    assert.deepEqual(ready().pendingGrants, ["model:light"]);
  });

  test("the owner changes a capability's model: tier ↔ pinned, a new version without the builder", async () => {
    await setUp();
    await configure();
    const pin = await t.platform.setCapabilityModel(USER, "word-explainer", { model: "anthropic/claude-sonnet-5-5" });
    assert.equal((await t.platform.settle(pin.buildId)).status, "promoted");
    assert.deepEqual(t.platform.activeManifest("word-explainer").requires!.model, { model: "anthropic/claude-sonnet-5-5", input: ["text", "image"] });
    assert.equal(t.platform.registry.getBuild(pin.buildId)!.builder, "keep");
    const back = await t.platform.setCapabilityModel(USER, "word-explainer", { tier: "standard" });
    assert.equal((await t.platform.settle(back.buildId)).status, "promoted");
    assert.deepEqual(t.platform.activeManifest("word-explainer").requires!.model, { tier: "standard", input: ["text", "image"] });
    assert.deepEqual(ready().pendingGrants, [], "each new model grant came with the change");
    await assert.rejects(t.platform.setCapabilityModel(USER, "word-explainer", { tier: "standard" }), /already uses/);
    await assert.rejects(t.platform.setCapabilityModel(USER, "word-explainer", { tier: "huge" }), /unknown tier/);
    await assert.rejects(t.platform.setCapabilityModel(t.claude, "word-explainer", { tier: "light" }), /owner/);
  });

  test("Activity: each model call is recorded with who started the chain", async () => {
    await setUp();
    await configure();
    await t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "x" } });
    const [m] = t.platform.registry.recentModelCalls(10);
    assert.equal(m.caller, t.claude.id);
    assert.equal(m.model, HAIKU);
    assert.equal(m.status, "settled");
  });

  test("a retired pinned model: not ready with a suggested successor; replacing it makes a new version, no builder", async () => {
    net = fakeNet();
    t = setup({ modelFetch: (url, init) => net.fetch(url, init) });
    const f = fixtureCopy("word-explainer", (m) => (m.requires.model = { model: "anthropic/claude-haiku-4-0", input: ["text", "image"] }));
    try {
      await installFrom(t.platform, f.dir);
      await t.platform.refreshModelCatalog();
      await t.platform.setModelKey(USER, "anthropic", "sk-ant-test-key");
      t.platform.approveGrants(USER, "word-explainer");
      assert.deepEqual(ready().retiredModel, { model: "anthropic/claude-haiku-4-0", successor: HAIKU });
      assert.match(ready().missingModel!, /no longer available; replace it with anthropic\/claude-haiku-5-5/);
      assert.ok(t.platform.registry.authorityEvents().some((e) => e.action === "model_retired" && e.capabilityId === "word-explainer"));
      const before = (await t.platform.exportData(USER, "word-explainer")).data;
      await assert.rejects(t.platform.replacePinnedModel(USER, "word-explainer", "anthropic/claude-nope"), /doesn't list/);
      const b = await t.platform.replacePinnedModel(USER, "word-explainer", HAIKU);
      const done = await t.platform.settle(b.buildId);
      assert.equal(done.status, "promoted", done.log.join("\n"));
      assert.equal(t.platform.activeManifest("word-explainer").requires!.model!.model, HAIKU);
      assert.equal(ready().ready, true, "the new model grant came with it");
      assert.equal(t.platform.registry.getBuild(b.buildId)!.builder, "keep", "no builder ran");
      await assert.rejects(t.platform.retryBuild(USER, b.buildId), /only failed or cancelled|model replacement/);
      assert.deepEqual((await t.platform.exportData(USER, "word-explainer")).data, before, "state untouched");
      await assert.rejects(t.platform.replacePinnedModel(USER, "word-explainer", HAIKU), /already uses/);
    } finally {
      f.remove();
    }
  });

  test("the ABI gate: code without requires.model has no ctx.model", async () => {
    net = fakeNet();
    t = setup({ modelFetch: (url, init) => net.fetch(url, init) });
    const f = fixtureCopy("word-explainer", (m, dir) => {
      m.id = "no-model";
      m.name = "No Model";
      delete m.requires;
      writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([{ name: "no model", operation: "probe", input: {}, expect: { hasModel: false } }]));
    });
    try {
      await installFrom(t.platform, f.dir);
      assert.deepEqual((await t.platform.invoke(t.claude, { capabilityId: "no-model", operation: "probe", input: {} })).result, { hasModel: false });
    } finally {
      f.remove();
    }
  });

  test("a refused key isn't stored", async () => {
    await setUp({ keyStatus: 401 });
    await assert.rejects(t.platform.setModelKey(USER, "anthropic", "sk-ant-wrong-key"), /Anthropic refused that key/);
    assert.equal(t.platform.secrets.get(MODEL_KEYS, "anthropic"), undefined);
    assert.equal(t.platform.models(USER).provider, null);
  });

  test("settings are validated; keys are stored apart from capability secrets", async () => {
    await setUp();
    assert.throws(() => t.platform.setModelSettings(USER, { tiers: { acme: { light: "x" } } }), /unknown provider/);
    assert.throws(() => t.platform.setModelSettings(USER, { tiers: { anthropic: { light: "anthropic/claude-haiku-5-5" } } }), /without "anthropic\/"/);
    assert.throws(() => t.platform.setModelSettings(USER, { provider: "openai" }), /set the OpenAI API key first/);
    assert.throws(() => t.platform.setModelSettings(USER, { monthlyCapUsd: -1 }), /USD/);
    await assert.rejects(t.platform.setModelKey(USER, "acme", "sk-123456789"), /unknown provider/);
    assert.throws(() => t.platform.setModelSettings(t.claude, { monthlyCapUsd: 1 }), /owner/);
    await t.platform.setModelKey(USER, "openrouter", "sk-or-123456789");
    assert.equal(t.platform.secrets.get(MODEL_KEYS, "openrouter"), "sk-or-123456789");
    assert.ok(t.platform.registry.authorityEvents().some((e) => e.action === "model_key_set" && e.subject === "openrouter"));
  });
});

describe("model port: hosted (tools' model calls on the host)", () => {
  let t: ReturnType<typeof setup>;
  type Asked = Parameters<HostModels>[0];
  const asked: Asked[] = [];
  let answer: (req: Asked) => Promise<Awaited<ReturnType<HostModels>>> = async () => ({ text: JSON.stringify({ explanation: "Pleased." }), usage: { inputTokens: 900, outputTokens: 80 }, model: "claude-haiku-5-5", charge: { amount: 0.37, unit: "Credits" } });
  beforeEach(async () => {
    asked.length = 0;
    t = setup({ hostModels: async (req) => (asked.push(req), answer(req)) });
    await installFrom(t.platform, join(FIXTURES, "word-explainer"));
  });
  afterEach(() => t.cleanup());

  test("no provider or key: ready once the owner approves; the host gets the tier and the request", async () => {
    assert.equal(t.platform.readiness("word-explainer").missingModel, undefined);
    t.platform.approveGrants(USER, "word-explainer");
    const r = await t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "gruntled" } });
    assert.equal((r.result as { explanation: string }).explanation, "Pleased.");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].capabilityId, "word-explainer");
    assert.equal(asked[0].tier, "light");
    assert.equal(asked[0].messages[0].role, "user");
    assert.equal(asked[0].schema?.type, "object");
    // Logged for Activity at $0; the charge counts as given, summed as a decimal.
    assert.equal(t.platform.modelSpend(USER).totalUsd, 0);
    await t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "ruth" } });
    assert.deepEqual(t.platform.hostCharges(USER).totals, [{ unit: "Credits", amount: 0.74 }]);
    assert.deepEqual(t.platform.models(USER).host?.charges.totals, [{ unit: "Credits", amount: 0.74 }]);
  });

  test("a refusal reaches the caller as the host words it; a failed call that was answered still counts", async () => {
    t.platform.approveGrants(USER, "word-explainer");
    answer = async () => {
      throw Object.assign(new Error("This Hewn has used this month's 800 Credits. They renew on the 1st."), { refused: true });
    };
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "gruntled" } }), /used this month's 800 Credits/);
    answer = async () => {
      throw Object.assign(new Error("the model refused"), { charge: { amount: 0.12, unit: "Credits" } });
    };
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "word-explainer", operation: "explain", input: { word: "gruntled" } }), /the host's model: the model refused/);
    assert.deepEqual(t.platform.hostCharges(USER).totals, [{ unit: "Credits", amount: 0.12 }]);
    // Nonsense from the host isn't counted.
    t.platform.recordHostCharge(USER, "intake", { amount: -1, unit: "Credits" });
    t.platform.recordHostCharge(USER, "intake", { amount: 4, unit: "Credits" });
    assert.deepEqual(t.platform.hostCharges(USER).totals, [{ unit: "Credits", amount: 4.12 }]);
  });
});
