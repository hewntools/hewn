// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { text } from "@hewntools/core/files.ts";
import { sourceAsset } from "@hewntools/cli/assets.ts";
import { widgetAppHtml } from "@hewntools/host-workerd/surface/widget-app.ts";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import type { Home } from "@hewntools/cli/home.ts";
import { chromiumCheck, findBrowser, type VisualCheck } from "@hewntools/cli/visual.ts";
import type { Validation } from "@hewntools/core/platform/validation.ts";
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
    assert.equal(done.screenshot, true, "the build page shows what broke");
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
    assert.equal(done.screenshot, true, "the build page shows it");
    assert.deepEqual((await platform.invoke(USER, { capabilityId: "ui-counter", operation: "get", input: {} })).result, { count: 0 }, "the check's state isn't the tool's");
    platform.close();
  });

  test("a screen that breaks only with sample data fails the build, and the build page shows it filled", async () => {
    const fake: VisualCheck = async (req) => {
      const { result } = (await req.invoke({ operation: "get", input: {} })) as { result: { count: number } };
      return { errors: result.count ? ["uncaught: TypeError: rows[0] is undefined"] : [], screenshot: Buffer.from(`png ${result.count}`) };
    };
    const platform = platformFor(t.home, fake);
    const broken = await buildCounter(platform, undefined, taps(2));
    assert.equal(broken.status, "failed");
    assert.match(broken.log.join("\n"), /didn't render cleanly with its sample data/);
    assert.equal(broken.failure?.title, "Its screen shows errors");
    assert.equal(screenshot(broken.buildId).toString(), "png 2", "the filled screen, where it broke");
    assert.equal(broken.screenshot, true, "the build page shows it");
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

  test("a real headless browser: a tool's own CSS wins over ui.css, its dark tokens and a plain rule for a control too", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const render = async (style: string, button: string) => {
      const uiDir = mkdtempSync(join(tmpdir(), "hewn-ui-"));
      writeFileSync(join(uiDir, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="/_platform/ui.css"><style>${style}</style></head><body><main class="page"><button ${button}>Save</button></main></body></html>`);
      const r = await chromiumCheck(browser)({ uiDir, manifest: {}, invoke: async () => ({}) });
      assert.deepEqual(r.errors, []);
      return [r.screenshot, r.screenshotDark];
    };
    // The tool's own tokens, light and dark, and a rule for every button (ui.css's `button.primary` is more specific).
    const own = await render(":root { --bg: rgb(0 0 255); } @media (prefers-color-scheme: dark) { :root { --bg: rgb(255 0 0); } } button { background: rgb(0 160 0); }", `class="primary"`);
    // The same colours, set where nothing in ui.css can outrank them.
    const fixed = await render("body { background: rgb(0 0 255); } @media (prefers-color-scheme: dark) { body { background: rgb(255 0 0); } }", `class="primary" style="background: rgb(0 160 0)"`);
    assert.deepEqual(own[0], fixed[0], "light: the tool's background and button");
    assert.deepEqual(own[1], fixed[1], "dark: the tool's dark background wins over ui.css's dark tokens");
  });
});

/** A stylesheet's top-level blocks, by what comes before their `{`, comments dropped (and anything after the last block). */
const topLevel = (css: string) => {
  const src = css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => (m.startsWith("/*") ? "" : `""`));
  const blocks: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{" && depth++ === 0) blocks.push(src.slice(from, i).trim());
    else if (src[i] === "}" && --depth === 0) from = i + 1;
  }
  const rest = src.slice(from).trim();
  return rest ? [...blocks, rest] : blocks;
};

test("Hewn's own CSS is all in the layer hewn, so a tool's own CSS wins over it (the browser test above, without a browser)", async () => {
  for (const path of ["platform-ui/ui.css", "web/app.css"]) assert.deepEqual(topLevel(text((await sourceAsset(path))!)), ["@layer hewn"], path);
  const style = /<style>([\s\S]*)<\/style>/.exec(await widgetAppHtml(sourceAsset))![1];
  assert.deepEqual(topLevel(style), ["@layer hewn", "@layer hewn"], "the widget app: ui.css, then its own CSS");
  assert.deepEqual(topLevel("@layer hewn { a { b: c } } d { e: f }"), ["@layer hewn", "d"], "a rule after the layer shows");
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

describe("the eyes: a candidate checked without promoting it, rendered whole on two screens, its defects measured", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  const screenshot = (buildId: string) => readFileSync(join(t.home.root, "blobs", "screenshots", `${buildId}.png`));

  /** The UI Counter, as a change to version 1 (its name changed, with sample data), in a workspace of its own. */
  const candidateOf = async (platform: Platform, createdBy: string) => {
    const files: Record<string, Uint8Array> = {};
    const dir = join(FIX, "ui-counter");
    for (const f of readdirSync(dir, { recursive: true }) as string[]) if (statSync(join(dir, f)).isFile()) files[f] = readFileSync(join(dir, f));
    files["capability.json"] = Buffer.from(JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "capability.json"), "utf8")), name: "Tap Counter" }));
    files["sample/calls.json"] = Buffer.from(taps(2));
    const build = { ...platform.registry.getBuild(createdBy)!, id: "eyes-check", kind: "modify" as const, baseVersion: 1, dependsOn: null };
    await platform.workbench.open(build.id, files);
    return build;
  };

  test("validating a candidate without promoting it leaves the tool's version as it was; promoting it later makes it live", async () => {
    const seen: { measure?: boolean; count: unknown }[] = [];
    // Each render's images say which state they were drawn on.
    const fake: VisualCheck = async (req) => {
      const { result } = (await req.invoke({ operation: "get", input: {} })) as { result: { count: number } };
      seen.push({ measure: req.measure, count: result.count });
      const shots = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"].map((name) => ({ name, png: Buffer.from(`${name} ${result.count}`) }));
      return { errors: [], screenshot: Buffer.from(`png ${result.count}`), shots, ...(req.measure ? { defects: [`Sticks out on the phone (390 px): count ${result.count}`] } : {}) };
    };
    const platform = platformWith(t.home, () => counter(), { visualCheck: fake, attempts: 1 });
    const created = await platform.settle((await platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" })).buildId);
    assert.equal(created.status, "promoted", created.log.join("\n"));
    await platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment", input: {} });
    seen.length = 0;

    const validation = (platform as any).d.validation as Validation;
    const build = await candidateOf(platform, created.buildId);
    const log: string[] = [];
    const candidate = await validation.validate(build, (l) => log.push(l), { measure: true });
    assert.ok(log.some((l) => /empty and with its sample data/.test(l)), log.join("\n"));
    assert.equal(candidate.manifest.name, "Tap Counter");
    assert.deepEqual(candidate.shots?.map((s) => Buffer.from(s.png).toString()), ["desktop-light 2", "desktop-dark 2", "mobile-light 2", "mobile-dark 2"], "the four images, filled with the sample data");
    assert.deepEqual(seen, [{ measure: undefined, count: 0 }, { measure: true, count: 2 }], "measured filled with the sample data, not empty");
    assert.deepEqual(candidate.defects, ["Sticks out on the phone (390 px): count 2"]);
    // Nothing about the tool changed: its version, its name, its data.
    assert.equal(platform.registry.getCapability("ui-counter")?.activeVersion, 1);
    assert.equal(platform.registry.latestVersionNumber("ui-counter"), 1);
    assert.equal(platform.registry.getCapability("ui-counter")?.name, "UI Counter");
    assert.deepEqual((await platform.invoke(USER, { capabilityId: "ui-counter", operation: "get", input: {} })).result, { count: 1 });
    assert.ok(await platform.workbench.file(build.id, "capability.json"), "the workspace is still there");
    assert.equal(screenshot(build.id).toString(), "png 2", "the build page shows it");

    // Another check of the build (a later pass) draws over the build page's screenshot; promoting this candidate puts its own back.
    writeFileSync(join(t.home.root, "blobs", "screenshots", `${build.id}.png`), "a later pass");
    assert.deepEqual(await validation.promote(build, candidate, (l) => log.push(l)), { version: 2 });
    assert.equal(screenshot(build.id).toString(), "png 2");
    assert.equal(platform.registry.getCapability("ui-counter")?.activeVersion, 2);
    assert.equal(platform.registry.getCapability("ui-counter")?.name, "Tap Counter");
    assert.deepEqual((await platform.invoke(USER, { capabilityId: "ui-counter", operation: "get", input: {} })).result, { count: 1 }, "its data came along");
    platform.close();
  });

  test("a candidate that fails validation says why, and the tool keeps its version", async () => {
    let broken = false;
    const platform = platformWith(t.home, () => counter(), { visualCheck: async () => ({ errors: broken ? ["uncaught: TypeError: x is undefined"] : [], screenshot: Buffer.from("png") }), attempts: 1 });
    const created = await platform.settle((await platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" })).buildId);
    assert.equal(created.status, "promoted", created.log.join("\n"));
    broken = true;
    const validation = (platform as any).d.validation as Validation;
    await assert.rejects(validation.validate(await candidateOf(platform, created.buildId), () => {}), /UI didn't render cleanly/);
    assert.equal(platform.registry.latestVersionNumber("ui-counter"), 1);
    platform.close();
  });

  // The visual check on Linux is P2 (#4).
  const browser = process.platform === "darwin" ? findBrowser() : undefined;
  /** The UI Counter's page with `extra` at the end of its <main>, in a folder of its own; its API counts. */
  const counterPage = (extra = "") => {
    const uiDir = mkdtempSync(join(tmpdir(), "hewn-ui-"));
    writeFileSync(join(uiDir, "index.html"), readFileSync(join(FIX, "ui-counter", "ui", "index.html"), "utf8").replace("</main>", `${extra}</main>`));
    let count = 3;
    return { uiDir, manifest: {}, invoke: async (b: { operation: string }) => ({ result: { count: b.operation === "increment" ? ++count : count } }) };
  };
  /** A PNG's size in pixels (its IHDR). */
  const size = (png: Uint8Array) => ({ width: Buffer.from(png).readUInt32BE(16), height: Buffer.from(png).readUInt32BE(20) });

  test("a real headless browser: the render is four images, the whole page at 1280 and 390 px wide, light and dark", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const r = await chromiumCheck(browser)(counterPage(`<div style="height: 2400px">tall</div>`));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.shots?.map((s) => s.name), ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]);
    for (const s of r.shots!) assert.equal(Buffer.from(s.png).subarray(1, 4).toString(), "PNG", s.name);
    const [dl, dd, ml, md] = r.shots!.map((s) => size(s.png));
    assert.equal(dl.width, 1280);
    assert.ok(dl.height > 2400, `the whole page, not the first screen: ${dl.height}`);
    assert.deepEqual(ml.width, 390 * 2, "the phone, at 2x");
    assert.ok(ml.height > 2400 * 2, `${ml.height}`);
    assert.deepEqual([dd, md], [dl, ml]);
    assert.notDeepEqual(r.shots![0].png, r.shots![1].png, "light and dark differ");
    // The build page's screenshot is still the first screen.
    assert.deepEqual(size(r.screenshot!), { width: 1280, height: 800 });
    assert.equal(r.defects, undefined, "measured only when asked");
  });

  test("a real headless browser: an error only the phone shows fails the check, and says so", { skip: !browser && "no Chromium-based browser on this machine" }, async () => {
    const r = await chromiumCheck(browser)(counterPage(`<script>if (innerWidth < 500) throw new Error("too narrow")</script>`));
    assert.deepEqual(r.errors, ["on the phone (390 px): uncaught: Error: too narrow"]);
  });

  test("a real headless browser: defects measured on a fixture page (cut off by overflow-x: hidden, an SVG control, confirm(), a button that throws)", { skip: !browser && "no Chromium-based browser on this machine", timeout: 120_000 }, async () => {
    const page = counterPage(
      [
        `<div style="width: 600px; height: 20px">wide</div><style>body { overflow-x: hidden }</style>`,
        `<svg width="40" height="40"><rect id="dot" role="button" aria-label="Dot" width="40" height="40" onclick="document.title = 'dot'"/></svg>`,
        `<button id="stop" onclick="if (confirm('Stop counting?')) document.title = 'stopped'">Stop</button>`,
        `<button id="oops" onclick="null.x">Oops</button>`,
      ].join(""),
    );
    const r = await chromiumCheck(browser)({ ...page, measure: true });
    assert.deepEqual(r.errors, [], "a page that renders cleanly");
    const defects = r.defects ?? [];
    // What sticks out: the outermost element, how far, on the phone only (1280 px holds 600).
    const out = defects.filter((d) => d.startsWith("Sticks out"));
    assert.equal(out.length, 1, defects.join("\n"));
    assert.match(out[0], /^Sticks out on the phone \(390 px\): div \("wide"\): 2\d\dpx past the edge, 600px wide$/);
    // The button that throws is a failed click; the SVG control and the confirm() (dismissed) aren't.
    assert.ok(defects.some((d) => /^Clicking "Oops" broke the page: uncaught: TypeError/.test(d)), defects.join("\n"));
    assert.ok(!defects.some((d) => /"(Dot|Stop|\+1)"/.test(d)), defects.join("\n"));
    assert.equal(r.shots?.length, 4, "the images too");
  });
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

  test("widgets that don't render fail the build, and the build page shows them", async () => {
    const platform = platformWith(t.home, () => widgetCounter, { attempts: 1, visualCheck: async () => ({ errors: ["count (small): the content is cut off"], screenshot: Buffer.from("png") }) });
    const done = await build(platform);
    assert.equal(done.status, "failed");
    assert.match(done.log.join("\n"), /widgets didn't render cleanly/);
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
    assert.ok(done.log.some((l) => /widgets render in every size \(screenshot attached, with the sample data\)/.test(l)));
    assert.equal(done.screenshot, true, "the build page shows it");
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
