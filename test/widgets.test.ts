// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { isReadOnlySql } from "@hewntools/core/abi.ts";
import { validateManifest } from "@hewntools/core/manifest.ts";
import { viewErrors, viewText } from "@hewntools/core/widgets.ts";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serverUrl } from "@hewntools/test-host/server.ts";
import { editJson, editText, FIXTURES, installFrom, serve, setup, TOKENS } from "./helpers.ts";

const op = (name: string, sideEffect = "read") => ({ name, description: "d", version: 1, inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect });
const manifest = (extra: Record<string, unknown> = {}, widget: Record<string, unknown> = {}) => ({
  id: "x",
  name: "X",
  purpose: "p",
  abi: "2.3",
  operations: [op("widget_today"), op("add", "write")],
  widgets: [{ name: "today", version: 1, title: "Today", operation: "widget_today@1", sizes: ["small"], ...widget }],
  ...extra,
});

function fixtureCopy(edit: (m: Record<string, any>, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hewn-widget-"));
  cpSync(join(FIXTURES, "widget-counter"), dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
  edit(m, dir);
  writeFileSync(join(dir, "capability.json"), JSON.stringify(m));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("widgets: pure parts", () => {
  test("a widget names a declared read operation, needs ABI 2.3, and isn't on a connection", () => {
    assert.deepEqual(validateManifest(manifest(), "x"), []);
    assert.match(validateManifest(manifest({ abi: "2.2" }), "x").join(), /"widgets" needs ABI 2.3/);
    assert.match(validateManifest(manifest({}, { operation: "add@1" }), "x").join(), /add@1 must be a read operation/);
    assert.match(validateManifest(manifest({}, { operation: "nope@1" }), "x").join(), /nope@1 is not declared/);
    assert.match(validateManifest(manifest({}, { sizes: ["huge"] }), "x").join(), /sizes/);
    assert.match(validateManifest(manifest({}, { refresh: { every: "1m" } }), "x").join(), /between 5m and 24h/);
    assert.match(validateManifest(manifest({}, { open: "ui#today" }), "x").join(), /needs a UI/);
    assert.deepEqual(validateManifest(manifest({ ui: { available: true } }, { open: "ui#today" }), "x"), []);
    assert.match(validateManifest(manifest({}, { refresh: { every: "30m", on: ["x/y@1"] } }), "x").join(), /unexpected property "on"/);
    const conn = manifest({ kind: "connection", operations: [op("widget_today"), { ...op("health"), outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["connected", "expired", "broken"] } } } }] });
    assert.match(validateManifest(conn, "x").join(), /a connection has no widgets/);
  });

  test("view models: one of five templates, bounded", () => {
    assert.deepEqual(viewErrors({ template: "stat", value: 7, caption: "due" }), []);
    assert.deepEqual(viewErrors({ template: "list", items: [{ title: "a", value: 2 }] }), []);
    assert.deepEqual(viewErrors({ template: "chart", labels: ["Mon", "Tue"], series: [{ name: "Sleep", values: [7, 8] }] }), []);
    assert.deepEqual(viewErrors({ template: "progress", value: 3, max: 10 }), []);
    assert.deepEqual(viewErrors({ template: "text", text: "hi", reveal: "answer", buttons: [{ label: "Go", operation: "go@1" }, { label: "No", operation: "no@1" }] }), []);
    assert.match(viewErrors({ template: "text", text: "hi", buttons: Array(4).fill({ label: "Go", operation: "go@1" }) }).join(), /buttons/);
    assert.match(viewErrors({ template: "text", text: "hi", button: { label: "Go", operation: "go@1" } }).join(), /unexpected property "button"/);
    assert.deepEqual(viewErrors({ medium: { template: "text", text: "short" }, large: { template: "list", items: [{ title: "a" }] } }), []);
    assert.match(viewErrors({ medium: { template: "text" }, huge: {} }).join(), /views per size/);
    assert.match(viewErrors({ large: { template: "list" } }).join(), /large: list:/);
    assert.match(viewErrors({ template: "html", html: "<b>" }).join(), /must be one of/);
    assert.match(viewErrors([1]).join(), /object/);
    assert.match(viewErrors({ template: "stat" }).join(), /value/);
    assert.match(viewErrors({ template: "list", items: Array(6).fill({ title: "a" }) }).join(), /list:/);
    assert.match(viewErrors({ template: "chart", labels: ["a"], series: [{ name: "s", values: [1, 2] }] }).join(), /one value per label/);
    assert.match(viewErrors({ template: "stat", value: 1, script: "x" }).join(), /unexpected property "script"/);
    assert.equal(viewText("Due", { template: "stat", value: 7, caption: "words" }), "Due: 7\nwords");
    assert.equal(viewText("Top", { template: "list", items: [{ title: "a", value: 1 }], empty: "none" }), "Top\n- a: 1");
  });

  test("bar charts: the y axis ends on a round step just above the tallest bar", async () => {
    // A browser module (no types): imported by URL.
    const { barAxis } = (await import(new URL("../packages/ui/src/chart.js", import.meta.url).href)) as { barAxis: (v: number) => { max: number; step: number } };
    assert.deepEqual(barAxis(10.1), { max: 12.5, step: 2.5 }, "not 20");
    assert.deepEqual(barAxis(12.4), { max: 12.5, step: 2.5 });
    assert.deepEqual(barAxis(10), { max: 10, step: 2 });
    assert.deepEqual(barAxis(3), { max: 3, step: 1 });
    assert.deepEqual(barAxis(0.3), { max: 0.3, step: 0.1 });
    assert.deepEqual(barAxis(0), { max: 1, step: 0.25 });
    for (let v = 0.07; v < 5000; v *= 1.37) {
      const { max, step } = barAxis(v);
      assert.ok(max >= v && max - v < step + 1e-9 && max / step <= 5 + 1e-9, `${v} → ${max} by ${step}`);
    }
  });

  test("read-only SQL: reads pass, anything that writes is refused", () => {
    for (const ok of ["SELECT * FROM t", " select count(*) from t where name = 'delete me'", "WITH x AS (SELECT 1) SELECT * FROM x", 'SELECT "update" FROM t', "SELECT replace(a, 'x', 'y') FROM t", "PRAGMA table_info(t)", "select updated_at from t -- insert"]) {
      assert.equal(isReadOnlySql(ok), true, ok);
    }
    for (const bad of ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "REPLACE INTO t VALUES (1)", "SELECT 1; DROP TABLE t", "PRAGMA user_version = 3", "PRAGMA journal_mode", "CREATE TABLE y (a)", "ATTACH 'x.db' AS x", "BEGIN"]) {
      assert.equal(isReadOnlySql(bad), false, bad);
    }
  });
});

describe("widget proposals (intake)", () => {
  test("a change may propose widgets: one prompt, all operations, existing widgets; replies are cleaned up", async () => {
    const { intakePrompt, parseIntake } = await import("@hewntools/cli/intake.ts");
    const current = manifest() as any;
    // A long manifest is summarised, not cut off: the last operation is still there.
    current.operations.push(...Array.from({ length: 40 }, (_, i) => ({ name: `op_${i}`, version: 1, description: "x".repeat(200), sideEffect: "write", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { big: { type: "string", description: "y".repeat(400) } } } })));
    const prompt = intakePrompt({ mode: "modify", capabilityId: "x", current, messages: [{ role: "user", content: "the streak" }] });
    assert.match(prompt, /reply kind "widgets"/);
    assert.match(prompt, /Never refuse a widget/);
    assert.match(prompt, /propose exactly that one widget/);
    assert.match(prompt, /writes included/);
    assert.match(prompt, /USER: the streak/);
    assert.match(prompt, /already has widgets: today \("Today", small\)/);
    assert.match(prompt, /"widget_today@1"/);
    assert.match(prompt, /"op_39@1"/);
    assert.doesNotMatch(prompt, /yyyy/);
    // Creating knows about widgets too, but never answers with proposals.
    assert.doesNotMatch(intakePrompt({ mode: "create", messages: [{ role: "user", content: "x" }] }), /reply kind "widgets"/);
    const raw = (o: object) => JSON.stringify({ kind: "widgets", message: "m", ...o });
    const reply = parseIntake(
      raw({
        proposals: [
          { title: "Streak", shows: "Days in a row.", template: "stat", sizes: ["small", "small", "huge"] },
          { title: "Bad", shows: "x", template: "html", sizes: [] },
          { title: "Week", shows: "This week.", template: "chart", sizes: [] },
        ],
      }),
      "modify",
    );
    assert.deepEqual(reply, {
      kind: "widgets",
      message: "m",
      proposals: [
        { title: "Streak", shows: "Days in a row.", template: "stat", sizes: ["small"] },
        { title: "Week", shows: "This week.", template: "chart", sizes: ["medium"] },
      ],
    });
    // Opened from a widget's Change…: about that widget; a proposal may replace it (only an existing one).
    const focused = intakePrompt({ mode: "modify", capabilityId: "x", widget: "today", current, messages: [{ role: "user", content: "large only" }] });
    assert.match(focused, /opened this from its widget "Today" \(name today, operation widget_today@1, sizes small\)/);
    assert.match(focused, /"replaces": "today"/);
    const replaced = parseIntake(raw({ proposals: [{ title: "Today", shows: "Bigger.", template: "text", sizes: ["large"], replaces: "today" }, { title: "New", shows: "x", template: "stat", sizes: ["small"], replaces: "nope" }] }), "modify", current) as any;
    assert.equal(replaced.proposals[0].replaces, "today");
    assert.equal(replaced.proposals[1].replaces, undefined);
    // A widget the capability can't make yet comes as a change that includes it.
    const draft = parseIntake(raw({ kind: "draft", request: "Add fetch_awad (host wordsmith.org) and a widget showing today's word.", operations: [{ name: "fetch_awad", sideEffect: "write" }], widgets: ["Today's AWAD word"], hosts: ["wordsmith.org"] }), "modify") as any;
    assert.equal(draft.kind, "draft");
    assert.deepEqual(draft.draft.spec.widgets, ["Today's AWAD word"]);
    // Capabilities can have Hewn run a model (ABI 2.2): the intake knows, and the spec card shows the tier.
    assert.match(intakePrompt({ mode: "create", messages: [{ role: "user", content: "a naming brainstorm" }] }), /Hewn runs a language model for any capability/);
    assert.equal((parseIntake(JSON.stringify({ kind: "draft", message: "", name: "Namer", purpose: "p", requirements: "r", operations: [{ name: "suggest", sideEffect: "write" }], model: "strong" }), "create") as any).draft.spec.model, "strong");
  });
});

describe("widgets: running", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "widget-counter"));
  });
  afterEach(() => t.cleanup());

  test("the owner's widget runs as its own identity, read-only, and is cached", async () => {
    await t.platform.invoke(USER, { capabilityId: "widget-counter", operation: "increment" });
    const r = await t.platform.widget(USER, "widget-counter", "count");
    assert.deepEqual(r.view, { template: "stat", value: 1, caption: "taps", buttons: [{ label: "Add one", operation: "increment@1" }] });
    assert.equal(r.title, "Count");
    assert.match(t.platform.logLines("widget-counter", 5).join("\n"), /widget:widget-counter\/count widget_count@1 ok/);
    assert.deepEqual(t.platform.cachedWidget(USER, "widget-counter", "count")?.view, r.view);
    // Per input: another caption is another cache entry.
    assert.equal(t.platform.cachedWidget(USER, "widget-counter", "count", { caption: "x" }), undefined);
  });

  test("a widget that tries to write is refused, and its last view survives", async () => {
    await t.platform.widget(USER, "widget-counter", "count", { sneak: false });
    await assert.rejects(t.platform.widget(USER, "widget-counter", "count", { sneak: true }), /widgets are read-only/);
    const { result } = await t.platform.invoke(USER, { capabilityId: "widget-counter", operation: "widget_count" });
    assert.equal((result as { value: number }).value, 0, "nothing was written");
    const c = t.platform.cachedWidget(USER, "widget-counter", "count", { sneak: true });
    assert.match(c?.error ?? "", /read-only/);
  });

  test("agents run widgets under their own grants; others can't see them", async () => {
    const r = await t.platform.widget(t.codex, "widget-counter", "count");
    assert.equal((r.view as any).template, "stat");
    assert.match(t.platform.logLines("widget-counter", 5).join("\n"), /codex.* widget_count@1 ok/);
    await assert.rejects(t.platform.widget(t.outsider, "widget-counter", "count"), /not_found|not found|no capability/i);
    await assert.rejects(t.platform.widget(USER, "widget-counter", "nope"), /no widget nope/);
    assert.deepEqual(
      t.platform.widgetGallery(t.codex).map((c) => [c.capabilityId, c.widgets.map((w) => w.name)]),
      [["widget-counter", ["count"]]],
    );
  });

  test("Home layout: icons and widgets in order, validated, with the cached view", async () => {
    assert.deepEqual(t.platform.homeLayout(USER), []);
    await assert.rejects(async () => t.platform.setHomeLayout(USER, [{ type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "large" }]), /comes in small, medium/);
    await assert.rejects(async () => t.platform.setHomeLayout(USER, [{ type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "small", input: { nope: 1 } }]), /input doesn't match/);
    await assert.rejects(async () => t.platform.setHomeLayout(USER, [{ type: "widget", key: "k1", id: "widget-counter", widget: "gone", size: "small" }]), /has no widget gone/);
    await assert.rejects(async () => t.platform.setHomeLayout(t.claude, []), /owner/);
    const layout = t.platform.setHomeLayout(USER, [
      { type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "medium" },
      { type: "icon", id: "widget-counter" },
      { type: "icon", id: "not-installed" },
    ]);
    assert.deepEqual(
      layout.map((e) => e.type),
      ["widget", "icon"],
    );
    assert.deepEqual(layout[0], { type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "medium", title: "Count", sizes: ["small", "medium"], refreshMs: 15 * 60_000, view: null, at: null, error: null });
    const r = await t.platform.refreshHomeWidget(USER, "k1");
    assert.equal((r.view as { value: number }).value, 0);
    assert.equal(r.error, null);
    assert.equal((t.platform.homeLayout(USER)[0] as { view: { value: number } }).view.value, 0);
    await assert.rejects(t.platform.refreshHomeWidget(USER, "nope"), /no such widget/);
  });

  test("a placed size the widget no longer offers shows at its biggest", () => {
    (t.platform as any).registry.setKv("home:layout", [{ type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "large" }]);
    assert.equal((t.platform.homeLayout(USER)[0] as { size: string }).size, "medium");
  });

  test("placing a widget puts it at the end of Home, after the icons already there", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    const first = t.platform.placeWidget(USER, { id: "widget-counter", widget: "count", size: "small" });
    assert.deepEqual(first.map((e) => (e.type === "icon" ? e.id : `widget:${e.widget}`)), ["widget-counter", "ui-counter", "widget:count"]);
    const second = t.platform.placeWidget(USER, { id: "widget-counter", widget: "count", size: "medium", input: { caption: "x" } });
    assert.equal(second.length, 4);
    assert.notEqual((second[2] as any).key, (second[3] as any).key);
    assert.throws(() => t.platform.placeWidget(USER, { id: "widget-counter", widget: "count", size: "large" }), /comes in small, medium/);
    assert.throws(() => t.platform.placeWidget(t.claude, { id: "widget-counter", widget: "count", size: "small" }), /owner/);
  });

  test("deleting a widget: a manifest-only version without it, and it leaves Home", async () => {
    t.platform.placeWidget(USER, { id: "widget-counter", widget: "count", size: "small" });
    await assert.rejects(t.platform.removeWidget(USER, "widget-counter", "nope"), /no widget nope/);
    await assert.rejects(t.platform.removeWidget(t.claude, "widget-counter", "count"), /owner/);
    const b = await t.platform.settle((await t.platform.removeWidget(USER, "widget-counter", "count")).buildId);
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.equal(b.builder, "keep");
    assert.equal(t.platform.activeManifest("widget-counter").widgets, undefined);
    assert.ok(t.platform.activeManifest("widget-counter").operations.some((o) => o.name === "widget_count"), "its operation stays");
    assert.ok(!t.platform.homeLayout(USER).some((e) => e.type === "widget"));
  });

  test("a refresh that fails comes back as a value with the last view", async () => {
    t.platform.setHomeLayout(USER, [{ type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "small", input: { sneak: true } }]);
    const r = await t.platform.refreshHomeWidget(USER, "k1");
    assert.match(r.error ?? "", /read-only/);
    assert.equal(r.view, null);
  });

  test("a widget removed by a later version stays on Home as missing", async () => {
    t.platform.setHomeLayout(USER, [{ type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "small" }]);
    const b = await t.build(
      () => t.platform.modify(USER, { capabilityId: "widget-counter", request: "drop the widget" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => delete m.widgets),
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.equal(t.platform.activeManifest("widget-counter").widgets, undefined);
    const [entry] = t.platform.homeLayout(USER);
    assert.equal((entry as { missing?: true }).missing, true);
    // It may stay where it is, but can't be placed anew.
    t.platform.setHomeLayout(USER, [{ type: "widget", key: "k1", id: "widget-counter", widget: "count", size: "small" }]);
    await assert.rejects(async () => t.platform.setHomeLayout(USER, [{ type: "widget", key: "k2", id: "widget-counter", widget: "count", size: "small" }]), /has no widget/);
  });
});

describe("widgets in agent chats (MCP Apps)", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let url: string;
  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  beforeEach(async () => {
    t = setup();
    server = await serve(t.platform, t.home);
    url = serverUrl(server);
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("widgets_show is always listed (a client may never re-list), bound to ui://hewn/widget", async () => {
    const before = await connect(TOKENS.codex);
    assert.ok((await before.listTools()).tools.some((x) => x.name === "widgets_show"));
    await installFrom(t.platform, join(FIXTURES, "widget-counter"));
    const c = await connect(TOKENS.codex);
    const tool = (await c.listTools()).tools.find((x) => x.name === "widgets_show");
    assert.deepEqual((tool?._meta as any)?.ui, { resourceUri: "ui://hewn/widget" });
    assert.match(c.getInstructions() ?? "", /Widgets: count\./);
  });

  test("the result carries the view model and a text rendering; the resource draws it with no network", async () => {
    await installFrom(t.platform, join(FIXTURES, "widget-counter"));
    const c = await connect(TOKENS.codex);
    const r: any = await c.callTool({ name: "widgets_show", arguments: { capabilityId: "widget-counter", widget: "count", size: "large" } });
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0].text, "Count: 0\ntaps");
    assert.equal(r.structuredContent.view.template, "stat");
    assert.equal(r.structuredContent.size, "medium", "large isn't offered: falls back to medium");
    const sneaky: any = await c.callTool({ name: "widgets_show", arguments: { capabilityId: "widget-counter", widget: "count", input: { sneak: true } } });
    assert.equal(sneaky.isError, true);
    assert.match(sneaky.content[0].text, /read-only/);

    const { resources } = await c.listResources();
    assert.deepEqual(resources.map((x) => [x.uri, x.mimeType]), [["ui://hewn/widget", "text/html;profile=mcp-app"]]);
    const [html] = (await c.readResource({ uri: "ui://hewn/widget" })).contents as { text: string; _meta: any }[];
    assert.match(html.text, /function renderWidget/);
    assert.match(html.text, /ui\/notifications\/tool-result/);
    assert.match(html.text, /"tools\/call", { name: "capabilities_invoke"/, "buttons call the operation through the host");
    assert.equal(r.structuredContent.capabilityId, "widget-counter");
    assert.deepEqual(r.structuredContent.input, {});
    // The same corner icon as on Home: the capability's app icon, inlined.
    assert.deepEqual(r.structuredContent.icon, { id: "widget-counter", name: t.platform.activeManifest("widget-counter").name, hue: t.platform.hueOf("widget-counter") });
    assert.match(html.text, /icon: s\.icon/);
    assert.doesNotMatch(html.text, /<script[^>]+src=|<link[^>]+href=|@import|^\s*import .* from/m, "everything inlined");
    assert.deepEqual(html._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    await assert.rejects(c.readResource({ uri: "ui://hewn/other" }));
  });
});

/** What a builder does in a widgets build of ui-counter: one widget, its read operation, a test. */
const addCountWidget = (ws: string) => {
  editJson(join(ws, "capability.json"), (m) => {
    m.abi = "2.3";
    m.operations.push({ name: "widget_count", description: "Count widget", version: 1, sideEffect: "read", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", required: ["template"] } });
    m.widgets = [{ name: "count", version: 1, title: "Count", operation: "widget_count@1", sizes: ["small"], open: "ui" }];
  });
  editText(join(ws, "src/index.ts"), (s) => s.replace(/};\s*$/, `  "widget_count@1": (_: unknown, { db }: Ctx) => ({ template: "stat", value: count(db), caption: "taps" }),\n};\n`));
  editJson(join(ws, "tests/cases.json"), (c) => c.push({ name: "widget", operation: "widget_count", input: {}, expect: { template: "stat", value: 1 } }));
};

describe("widgets builds (kind widgets)", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
  });
  afterEach(() => t.cleanup());

  test("adds widgets without touching the capability, with a focused brief", async () => {
    let brief = "";
    const b = await t.build(
      () => t.platform.addWidgets(t.claude, { capabilityId: "ui-counter" }),
      (ws, job) => {
        assert.equal(job.kind, "widgets");
        brief = readFileSync(join(ws, "BUILDER.md"), "utf8");
        addCountWidget(ws);
      },
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.equal(b.kind, "widgets");
    assert.match(brief, /# Build: widgets `ui-counter`/);
    assert.match(brief, /Propose 1–3 widgets/);
    assert.match(brief, /### Widgets \(ABI 2\.3\)/);
    assert.match(b.log.join("\n"), /widgets only: count/);
    assert.equal(((await t.platform.widget(USER, "ui-counter", "count")).view as any).template, "stat");
  });

  test("anything beyond widgets fails the build and leaves the capability as it was", async () => {
    const cases: [string, (ws: string) => void, RegExp][] = [
      ["an existing operation", (ws) => editJson(join(ws, "capability.json"), (m) => (m.operations[0].description = "Add one more")), /increment@1 changed/],
      ["requires", (ws) => editJson(join(ws, "capability.json"), (m) => (m.requires = { hosts: ["example.com"] })), /"requires" changed/],
      ["a migration", (ws) => writeFileSync(join(ws, "migrations/002_more.sql"), "CREATE TABLE more (id INTEGER);"), /migrations\/002_more.sql added/],
      ["the UI", (ws) => editText(join(ws, "ui/index.html"), (s) => s + "<!-- -->"), /ui\/index.html changed/],
      [
        "a new write operation",
        (ws) => {
          editJson(join(ws, "capability.json"), (m) => m.operations.push({ name: "reset", description: "r", version: 1, sideEffect: "write", inputSchema: { type: "object" }, outputSchema: { type: "object" } }));
          editText(join(ws, "src/index.ts"), (s) => s.replace(/};\s*$/, `  "reset@1": () => ({}),\n};\n`));
        },
        /reset@1 is new and write/,
      ],
    ];
    for (const [what, extra, why] of cases) {
      const b = await t.build(() => t.platform.addWidgets(USER, { capabilityId: "ui-counter", request: "count" }), (ws) => (addCountWidget(ws), extra(ws)));
      assert.equal(b.status, "failed", what);
      assert.match(b.log.join("\n"), why, what);
    }
    const none = await t.build(() => t.platform.addWidgets(USER, { capabilityId: "ui-counter" }), () => {});
    assert.match(none.log.join("\n"), /declares no widgets/);
    assert.equal(t.platform.activeManifest("ui-counter").widgets, undefined);
  });

  test("needs modify; not for connections; a retry stays a widgets build", async () => {
    await assert.rejects(t.platform.addWidgets(t.codex, { capabilityId: "ui-counter" }), /lacks scope: modify/);
    await installFrom(t.platform, join(FIXTURES, "login-connection"));
    await assert.rejects(t.platform.addWidgets(USER, { capabilityId: "login-connection" }), /connections have no widgets/);
    const failed = await t.build(() => t.platform.addWidgets(USER, { capabilityId: "ui-counter", request: "the count" }), () => {});
    assert.equal(failed.status, "failed");
    t.queue(addCountWidget);
    const retry = await t.platform.retryBuild(USER, failed.buildId, { fix: true });
    const done = await t.platform.settle(retry.buildId);
    assert.equal(done.kind, "widgets");
    assert.equal(done.status, "promoted", done.log.join("\n"));
  });
});

describe("create with widgets", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("widgets: true chains a widgets build after the capability promotes", async () => {
    t.queue((ws) => cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true }), addCountWidget);
    const b = await t.platform.create(t.claude, { name: "UI Counter", purpose: "Count taps.", requirements: "A counter.", widgets: true });
    assert.ok(b.widgetsBuildId);
    assert.equal(t.platform.getBuild(t.claude, b.widgetsBuildId!).status, "waiting");
    assert.equal((await t.platform.settle(b.buildId)).status, "promoted");
    const w = await t.platform.settle(b.widgetsBuildId!);
    assert.equal(w.status, "promoted", w.log.join("\n"));
    assert.deepEqual(t.platform.activeManifest("ui-counter").widgets?.map((x) => x.name), ["count"]);
    await assert.rejects(t.platform.create(t.claude, { name: "Conn", purpose: "p", requirements: "r", kind: "connection", widgets: true }), /connection has no widgets/);
  });
});

describe("widgets: building", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  const buildWith = async (edit: (m: Record<string, any>, dir: string) => void) => {
    const f = fixtureCopy(edit);
    try {
      const b = await t.platform.install(USER, { name: "Widget Counter", purpose: "p", builder: `copy:${f.dir}` });
      return await t.platform.settle(b.buildId);
    } finally {
      f.remove();
    }
  };

  test("a widget's test case must return something a template can draw", async () => {
    const bad = await buildWith((m, dir) => {
      writeFileSync(join(dir, "src/index.ts"), `export const operations = { "increment@1": () => ({ count: 1 }), "widget_count@1": () => ({ template: "stat" }) };`);
    });
    assert.equal(bad.status, "failed");
    assert.match(bad.log.join("\n"), /widget count returned something no template can draw/);
  });

  test("every widget needs a test case", async () => {
    const b = await buildWith((_m, dir) => writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([{ name: "inc", operation: "increment", input: {}, expect: { count: 1 } }])));
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /count: no case calls widget_count@1/);
  });

  test("a widget's operation is tested read-only", async () => {
    const b = await buildWith((_m, dir) => writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([{ name: "w", operation: "widget_count", input: { sneak: true } }])));
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /widgets are read-only/);
  });
});
