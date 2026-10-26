// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import type { Home } from "@hewntools/cli/home.ts";
import { chromiumCheck, findBrowser, type VisualCheck } from "@hewntools/cli/visual.ts";
import { platformWith, setup } from "./helpers.ts";

const FIX = resolve(import.meta.dirname, "fixtures");

/** Sample data: `n` taps (sample/calls.json). */
const taps = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({ operation: "increment" })));

/** A builder that writes the UI Counter fixture, optionally breaking its UI with a script, or with sample data. */
const counter = (breakUi?: string, sample?: string): CapabilityBuilder => ({
  name: "counter",
  build: async (job) => {
    cpSync(join(FIX, "ui-counter"), job.workspace, { recursive: true });
    if (sample) mkdirSync(join(job.workspace, "sample"), { recursive: true }), writeFileSync(join(job.workspace, "sample", "calls.json"), sample);
    if (breakUi) {
      const page = join(job.workspace, "ui", "index.html");
      writeFileSync(page, readFileSync(page, "utf8").replace("</body>", `<script>${breakUi}</script></body>`));
    }
  },
});

describe("visual validation", () => {
  let t: ReturnType<typeof setup>;
  let builder: CapabilityBuilder;
  const platformFor = (home: Home, visualCheck: VisualCheck) => platformWith(home, () => builder, { visualCheck, attempts: 1 });
  const buildCounter = async (platform: Platform, breakUi?: string, sample?: string) => {
    builder = counter(breakUi, sample);
    return platform.settle((await platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" })).buildId);
  };
  const screenshot = (buildId: string) => readFileSync(join(t.home.root, "blobs", "screenshots", `${buildId}.png`));
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("errors from the check fail the build in plain language; the screenshot is kept", async () => {
    const seen: string[] = [];
    const fake: VisualCheck = async (req) => {
      seen.push(JSON.stringify(await req.invoke({ operation: "get", input: {} })));
      return { errors: ["uncaught: TypeError: x is undefined"], screenshot: Buffer.from("png") };
    };
    const platform = platformFor(t.home, fake);
    const done = await buildCounter(platform);
    assert.equal(done.status, "failed");
    assert.deepEqual(seen, ['{"result":{"count":0}}'], "the UI's API runs the candidate on fresh state");
    assert.equal(done.failure?.title, "Its screen shows errors");
    assert.equal(screenshot(done.buildId).toString(), "png");
    platform.close();
  });

  test("with sample data, the screen is checked empty and then filled with it, and the screenshot shows it in use", async () => {
    const seen: string[] = [];
    const fake: VisualCheck = async (req) => {
      seen.push(JSON.stringify(await req.invoke({ operation: "get", input: {} })));
      return { errors: [], screenshot: Buffer.from(`png ${seen.length}`) };
    };
    const platform = platformFor(t.home, fake);
    const done = await buildCounter(platform, undefined, taps(3));
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(seen, ['{"result":{"count":0}}', '{"result":{"count":3}}']);
    assert.equal(screenshot(done.buildId).toString(), "png 2", "the filled one");
    assert.ok(done.log.some((l) => /empty and with its sample data/.test(l)));
    assert.deepEqual((await platform.invoke(USER, { capabilityId: "ui-counter", operation: "get", input: {} })).result, { count: 0 }, "the check's state isn't the tool's");
    // A screen that breaks only with data fails the build too.
    let n = 0;
    const onlyFilled = platformFor(t.home, async () => ({ errors: ++n % 2 === 0 ? ["uncaught: TypeError: rows[0] is undefined"] : [], screenshot: Buffer.from("png") }));
    builder = counter(undefined, taps(1));
    const broken = await onlyFilled.settle((await onlyFilled.modify(USER, { capabilityId: "ui-counter", request: "x" })).buildId);
    assert.equal(broken.status, "failed");
    assert.match(broken.log.join("\n"), /with its sample data/);
    assert.equal(broken.failure?.title, "Its screen shows errors");
    onlyFilled.close();
    platform.close();
  });

  test("no browser: the step is skipped, not failed", async () => {
    const platform = platformFor(t.home, async () => ({ skipped: "no Chromium-based browser found", errors: [] }));
    const done = await buildCounter(platform);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(done.log.some((l) => /visual check skipped/.test(l)));
    platform.close();
  });

  // The visual check on Linux is P2 (#4).
  const browser = process.platform === "darwin" ? findBrowser() : undefined;
  test("a real headless browser: a broken UI fails, the fixed one passes with a screenshot", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const platform = platformFor(t.home, chromiumCheck(browser));
    const broken = await buildCounter(platform, "document.querySelector('#nope').textContent = 1;");
    assert.equal(broken.status, "failed");
    assert.match(broken.log.join("\n"), /uncaught: TypeError/);
    // The builder fixes it on a retry.
    builder = counter();
    const fixed = await platform.settle((await platform.retryBuild(USER, broken.buildId)).buildId);
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    assert.ok(fixed.log.some((l) => /UI renders without errors/.test(l)));
    assert.equal(fixed.screenshot, true);
    assert.equal(screenshot(fixed.buildId).subarray(1, 4).toString(), "PNG");
    const dark = readFileSync(join(t.home.root, "blobs", "screenshots", `${fixed.buildId}-dark.png`));
    assert.equal(dark.subarray(1, 4).toString(), "PNG", "a dark-mode render too");
    assert.notDeepEqual(dark, screenshot(fixed.buildId), "light and dark differ (ui.css follows the scheme)");
    platform.close();
  });

  test("a real headless browser: an operation that fails (shown by the UI) is not a render error", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const platform = platformFor(t.home, chromiumCheck(browser));
    const done = await buildCounter(platform, "fetch('/api/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'nope' }) }).then((r) => r.json()).then((j) => (document.title = j.error));");
    assert.equal(done.status, "promoted", done.log.join("\n"));
    platform.close();
  });

  test("a real headless browser: the UI runs sandboxed as in Hewn (no storage, its API reached cross-origin)", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const platform = platformFor(t.home, chromiumCheck(browser));
    const storage = await buildCounter(platform, "localStorage.setItem('x', '1');");
    assert.equal(storage.status, "failed");
    assert.match(storage.log.join("\n"), /uncaught: .*(SecurityError|localStorage)/i);
    builder = counter("fetch('/api/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'get' }) }).then((r) => r.json()).then((j) => { if (j.result?.count === undefined) throw new Error('no result: ' + JSON.stringify(j)); }); if (origin !== 'null') throw new Error('origin ' + origin);");
    const api = await platform.settle((await platform.retryBuild(USER, storage.buildId)).buildId);
    assert.equal(api.status, "promoted", api.log.join("\n"));
    platform.close();
  });
});

test("a browser that won't start skips the check (with the reason) instead of failing the build", async () => {
  const uiDir = mkdtempSync(join(tmpdir(), "hewn-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<p>x</p>");
  for (const [bin, why] of [["/usr/bin/false", /the browser \(false\) didn't start/], ["/nope/chrome", /the browser \(chrome\) didn't start: error: spawn \/nope\/chrome ENOENT/]] as const) {
    const r = await chromiumCheck(bin)({ uiDir, manifest: {}, invoke: async () => ({}) });
    assert.match(r.skipped ?? "", why);
    assert.deepEqual(r.errors, []);
  }
});

describe("visual validation: widgets", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());
  const widgetCounter: CapabilityBuilder = { name: "wc", build: async (job) => cpSync(join(FIX, "widget-counter"), job.workspace, { recursive: true }) };
  const build = (platform: Platform) => platform.create(USER, { name: "Widget Counter", purpose: "x", requirements: "x" }).then((b) => platform.settle(b.buildId));

  test("changed widgets are drawn from their test case's view, in every size", async () => {
    let seen: unknown;
    const platform = platformWith(t.home, () => widgetCounter, { attempts: 1, visualCheck: async (req) => ((seen = req.widgets), { errors: [], screenshot: Buffer.from("png") }) });
    const done = await build(platform);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(seen, [{ name: "count", title: "Count", sizes: ["small", "medium"], view: { template: "stat", value: 1, caption: "taps", buttons: [{ label: "Add one", operation: "increment@1" }] } }]);
    assert.ok(done.log.some((l) => /widgets render in every size/.test(l)));
    assert.equal(done.screenshot, true);
    platform.close();
  });

  test("with sample data, changed widgets are drawn as they look filled with it", async () => {
    let seen: any;
    const withSample: CapabilityBuilder = {
      name: "wc",
      build: async (job) => {
        cpSync(join(FIX, "widget-counter"), job.workspace, { recursive: true });
        mkdirSync(join(job.workspace, "sample"), { recursive: true });
        writeFileSync(join(job.workspace, "sample", "calls.json"), taps(4));
      },
    };
    const platform = platformWith(t.home, () => withSample, { attempts: 1, visualCheck: async (req) => ((seen = req.widgets), { errors: [], screenshot: Buffer.from("png") }) });
    const done = await build(platform);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(seen[0].view.value, 4, "the sample's four taps, not the test case's one");
    assert.ok(done.log.some((l) => /widgets render in every size \(screenshot with the sample data\)/.test(l)));
    platform.close();
  });

  const browser = process.platform === "darwin" ? findBrowser() : undefined;
  test("a real headless browser draws the widget sheet", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const platform = platformWith(t.home, () => widgetCounter, { attempts: 1, visualCheck: chromiumCheck(browser) });
    const done = await build(platform);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(done.log.some((l) => /widgets render in every size/.test(l)), done.log.join("\n"));
    assert.equal(readFileSync(join(t.home.root, "blobs", "screenshots", `${done.buildId}.png`)).subarray(1, 4).toString(), "PNG");
    platform.close();
  });

  test("a size whose content is cut off fails; one size that fits is fine", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const long = { template: "text", text: "perspicacious: having a ready insight into and understanding of things. ".repeat(3).trim(), reveal: "x ".repeat(130).trim(), buttons: [{ label: "Got it", operation: "mark@1" }] };
    const check = chromiumCheck(browser);
    const sheet = (sizes: string[]) => check({ uiDir: t.home.root, manifest: {}, invoke: async () => null, widgets: [{ name: "word", title: "Word", sizes: sizes as any, view: long }] });
    const bad = await sheet(["small", "large"]);
    assert.ok(bad.errors.some((e) => /word · small: the content doesn't fit/.test(e)), bad.errors.join("\n"));
    assert.ok(!bad.errors.some((e) => /· large/.test(e)), bad.errors.join("\n"));
    assert.deepEqual((await sheet(["large"])).errors, []);
  });
});
