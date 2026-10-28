// SPDX-License-Identifier: AGPL-3.0-or-later
// The docs screenshots that the UI changes touch, from a test host with a stub builder and intake:
// PLAYWRIGHT_NODE_MODULES=<playwright-core dir> node test/e2e/docs-shots.ts → /tmp/shots/*.png, then copy into docs/images/.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor } from "@hewntools/cli/supervisor/index.ts";
import { findBrowser } from "@hewntools/cli/visual.ts";
import { editJson, SEED } from "../helpers.ts";
import { freePort } from "../workerd-helpers.ts";

const OUT = "/tmp/shots";
mkdirSync(OUT, { recursive: true });
const pw = createRequire(process.env.PLAYWRIGHT_NODE_MODULES ?? import.meta.url)("playwright-core");
const root = mkdtempSync(join(tmpdir(), "hewn-shots-"));
const port = await freePort();

const TOOLS: Record<string, { name: string; purpose: string }> = {
  "running-log": { name: "Running Log", purpose: "Keep a running history that any approved agent can record into and summarize." },
  "plant-care": { name: "Plant Care", purpose: "Which plants need water today, and what each one got." },
};
const builds: Record<string, number> = {};
const builder: CapabilityBuilder = {
  name: "claude",
  build: async (job) => {
    builds[job.capabilityId] = (builds[job.capabilityId] ?? 0) + 1;
    cpSync(SEED, job.workspace, { recursive: true });
    editJson(join(job.workspace, "capability.json"), (m) => {
      m.id = job.capabilityId;
      m.name = TOOLS[job.capabilityId]?.name ?? job.capabilityId;
      m.purpose = TOOLS[job.capabilityId]?.purpose ?? m.purpose;
    });
    // Plant Care's change: three test cases, one of which the code doesn't satisfy.
    if (job.capabilityId === "plant-care" && builds[job.capabilityId] > 1) {
      writeFileSync(
        join(job.workspace, "tests/cases.json"),
        JSON.stringify([
          { name: "empty summary", operation: "get_summary", input: {}, expect: { runCount: 0, totalDistanceKm: 0, averageDistanceKm: null, averagePaceSecondsPerKm: null } },
          { name: "lists nothing at first", operation: "list_runs", input: {}, expect: { runs: [] } },
          { name: "widget lists plants never watered", operation: "list_runs", input: {}, expect: { template: "list", items: [{ title: "Fern" }] } },
        ]),
      );
    }
  },
};
const BIKE = {
  kind: "draft" as const,
  message: "One tool: rides with the weather they were ridden in, and the chain's service interval, with a reminder on Sunday evenings when it's due.",
  draft: {
    name: "Bike Care",
    purpose: "Log bike rides and remember when the chain needs oiling.",
    requirements:
      "Operations: log_ride (date, km, minutes; fetches that hour's weather from api.open-meteo.com for the ride's location), list_rides (newest first, with weather), mark_oiled (today, or a date), service_due (km since the last oiling against the interval), delete_ride.\nState: rides, oilings, the service interval (default 300 km).\nWidget: Since last oiling (km and days; turns amber past the interval).\nTests: the interval maths, a ride without weather, the widget's empty state.",
    spec: {
      operations: [
        { name: "log_ride", sideEffect: "write" as const },
        { name: "list_rides", sideEffect: "read" as const },
        { name: "mark_oiled", sideEffect: "write" as const },
        { name: "service_due", sideEffect: "read" as const },
        { name: "delete_ride", sideEffect: "destructive" as const },
      ],
      uses: [],
      hosts: ["api.open-meteo.com"],
      secrets: [],
      widgets: ["Since last oiling"],
    },
    schedules: [{ operation: "service_due", cadence: "weekly sun 18:00", why: "Sunday evening, before the week's rides" }],
  },
};
// Both agents found on this Mac, neither connected yet (what the first run shows).
const harness = (agentId: string, label: string) => ({ agentId, label, pointerRequired: false, pointerNote: "", detect: () => true, registered: () => false, steps: () => [], login: () => [], loginFix: () => "" });
const sv = await startSupervisor({
  home: openHome(root),
  setup: { harnesses: () => [harness("claude-code", "Claude Code"), harness("codex", "Codex")] as any, userHome: root, appInstalled: () => false },
  port,
  publicPort: await freePort(),
  builders: { claude: builder },
  intake: () => async () => BIKE as any,
  log: () => {},
  keySource: "file",
  browser: "",
  tools: () => [
    { name: "claude" as const, label: "Claude Code", found: true, loggedIn: true },
    { name: "codex" as const, label: "Codex", found: true, loggedIn: true },
  ],
});
const web = `http://hewn.localhost:${port}`;
const browser = await pw.chromium.launch({ executablePath: findBrowser() });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const post = (path: string, body: unknown) =>
  page.evaluate(
    async ([path, body]: readonly [string, unknown]) => {
      const res = await fetch(`/api${path}`, { method: "POST", headers: { "x-hewn-ui": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
      return res.json();
    },
    [path, body] as const,
  );
const settle = async (buildId: string) => {
  for (let i = 0; i < 120; i++) {
    const b = (await sv.admin("call", { method: "getBuild", args: [buildId] })).result;
    if (["promoted", "failed", "cancelled", "review"].includes(b.status)) return b;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`build ${buildId} didn't settle`);
};
const shot = async (name: string, opts: { width: number; height: number; clip?: { x: number; y: number; width: number; height: number } }) => {
  await page.setViewportSize({ width: opts.width, height: opts.height });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), ...(opts.clip ? { clip: opts.clip } : {}) });
  console.log("✔", name, opts.clip ? `${Math.round(opts.clip.width)}×${Math.round(opts.clip.height)}` : `${opts.width}×${opts.height}`);
};

try {
  // 1. The first run: both agents found, nobody chosen yet.
  const { ticket } = await sv.admin("web-ticket", {});
  await page.goto(`${web}/auth?ticket=${ticket}`);
  await page.getByText("Make your own tools.").waitFor();
  await page.getByText("Codex").first().waitFor();
  await page.getByText("Found").first().waitFor();
  await shot("first-run", { width: 1280, height: 800 });

  // 2. Settings › AI, with Claude Code chosen.
  await sv.admin("settings", { builder: "claude", intake: "claude", maxBuildAttempts: 3 });
  // The owner chose Claude Code for both jobs (what the picker saves).
  await page.evaluate(async () => {
    await fetch("/api/settings", { method: "PUT", headers: { "x-hewn-ui": "1", "content-type": "application/json" }, body: JSON.stringify({ builder: "claude", intake: "claude", jobsChosen: ["builder", "intake"] }) });
  });
  await page.goto(`${web}/#/settings/ai`);
  await page.getByText("Builds tools").first().waitFor();
  await page.getByText(/Instructions/).first().waitFor();
  await page.waitForTimeout(300);
  const aiH = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await shot("settings-ai", { width: 1280, height: 600 });

  // 3. A tool's Info page: Running Log at v2.
  const b1 = await post("/capabilities", { name: TOOLS["running-log"].name, purpose: TOOLS["running-log"].purpose, requirements: "record runs" });
  await settle(b1.buildId);
  const b2 = await post("/capabilities/running-log/modify", { request: "add delete_run" });
  await settle(b2.buildId);
  // Something in each section: a run, a weekly schedule, a rule.
  await post("/capabilities/running-log/invoke", { operation: "record_run", operationVersion: 1, input: { distanceKm: 8.2, durationSeconds: 2700 } });
  await post("/schedules", { capabilityId: "running-log", operation: "get_summary", cadence: "weekly sun 18:00" });
  await page.evaluate(() => fetch("/api/capabilities/running-log/instructions", { method: "PUT", headers: { "x-hewn-ui": "1", "content-type": "application/json" }, body: JSON.stringify({ text: "Distances in km, never miles" }) }));
  await page.goto(`${web}/#/c/running-log`);
  await page.locator(".info-section", { hasText: "Versions" }).waitFor();
  await page.waitForTimeout(300);
  const infoH = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await shot("tool-info", { width: 1280, height: Math.min(infoH, 1000) });

  // 4. The spec proposal: Bike Care, in the create chat.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${web}/#/new`);
  const box = page.locator(".composer textarea, .composer-input textarea, textarea").first();
  await box.waitFor();
  await box.fill("A tracker for my bike: rides, and remind me when the chain needs oiling.");
  await box.press("Enter");
  await page.locator(".proposal-row").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const boxes = await page.evaluate(() => {
    const r = (el: Element | null) => el?.getBoundingClientRect();
    const thread = r(document.querySelector(".thread"));
    const composer = r(document.querySelector(".composer"));
    const card = r(document.querySelector(".proposal-row")?.closest(".card") ?? document.querySelector(".proposal-row"));
    return { thread, composer, card, scrollY: window.scrollY };
  });
  console.log("   boxes", JSON.stringify(boxes));
  const left = Math.min(boxes.thread!.left, boxes.composer!.left) - 16;
  const right = Math.max(boxes.thread!.right, boxes.composer!.right) + 16;
  const top = Math.max(0, boxes.thread!.top - 40);
  const bottom = boxes.composer!.bottom + 20;
  await shot("spec-proposal", { width: 1280, height: 1000, clip: { x: left, y: top + boxes.scrollY, width: right - left, height: bottom - top } });

  // 5. A failed change to Plant Care: 1 of 3 tests didn't pass.
  const p1 = await post("/capabilities", { name: TOOLS["plant-care"].name, purpose: TOOLS["plant-care"].purpose, requirements: "plants and watering" });
  await settle(p1.buildId);
  await sv.admin("settings", { builder: "claude", intake: "claude", maxBuildAttempts: 1 });
  const p2 = await post("/capabilities/plant-care/modify", { request: "A widget that lists the plants never watered.", conversation: [{ role: "user", content: "A widget that lists the plants never watered." }] });
  const failed = await settle(p2.buildId);
  console.log("   plant-care change:", failed.status);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${web}/#/b/${p2.buildId}`);
  await page.getByText(/didn't pass/).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => {
    const el = document.querySelector(".build-head")?.closest(".card") ?? document.querySelector(".build-center > *");
    const r = el!.getBoundingClientRect();
    return { x: r.left, y: r.top + window.scrollY, width: r.width, height: r.height };
  });
  await shot("build-failed", { width: 1280, height: 1000, clip: { x: card.x - 20, y: card.y - 20, width: card.width + 40, height: card.height + 40 } });

  // 6. The Hub: Hewn's own tools, every card in the shot.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${web}/#/hub`);
  await page.locator(".hub-card").first().waitFor();
  await page.waitForTimeout(800);
  const hubH = await page.evaluate(() => Math.ceil(Math.max(...[...document.querySelectorAll(".hub-card")].map((el) => el.getBoundingClientRect().bottom + window.scrollY)) + 40));
  await shot("hub", { width: 1280, height: Math.max(hubH, 800) });

  // 7. Share…: Running Log with two more runs in its sample data, written by hand (a new version, v3).
  const seedSample = readFileSync(join(SEED, "sample/calls.json"), "utf8").trimEnd();
  const more = [
    { operation: "record_run", version: 1, input: { distanceKm: 4.6, durationSeconds: 1500, notes: "Recovery jog" } },
    { operation: "record_run", version: 1, input: { distanceKm: 10.2, durationSeconds: 3240, notes: "Tempo, last 3 km hard" } },
  ];
  // Written the way the seed's lines are: one call per line, a space after each colon and comma.
  const line = (c: unknown) => JSON.stringify(c).replace(/":/g, '": ').replace(/,"/g, ', "');
  const sample = `${seedSample.replace(/\s*\]$/, "")},\n${more.map((c) => `  ${line(c)}`).join(",\n")}\n]\n`;
  const sb = await post("/capabilities/running-log/sample", { text: sample });
  const sampled = await settle(sb.buildId);
  if (sampled.status !== "promoted") throw new Error(`the sample data didn't go live: ${sampled.status} ${sampled.failure?.title ?? ""} ${sampled.failure?.detail ?? ""}`);
  // The sheets are measured at the size they're shot at (a centred dialog moves when the window does).
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${web}/#/c/running-log`);
  await page.locator(".info-section").first().waitFor();
  await page.getByRole("button", { name: "Share…" }).click();
  await page.locator("dialog[open]").getByText("always included").waitFor();
  await page.waitForTimeout(400);
  const dialog = async () => {
    const r = await page.locator("dialog[open]").last().boundingBox();
    return { x: r!.x - 16, y: r!.y - 16, width: r!.width + 32, height: r!.height + 32 };
  };
  await shot("share", { width: 1280, height: 1000, clip: await dialog() });
  await page.keyboard.press("Escape");

  // 8. Installing from the Hub: Hewn's reading, what it will ask for, the name, sample data.
  await page.goto(`${web}/#/hub/plant-log`);
  await page.getByRole("button", { name: "Install" }).click();
  await page.locator("dialog[open]").getByText("It will ask for").waitFor();
  await page.waitForTimeout(400);
  await shot("install", { width: 1280, height: 1000, clip: await dialog() });
  await page.keyboard.press("Escape");

  // 9. A version's files: what v3 changed (its sample data).
  await page.goto(`${web}/#/c/running-log/v/3?tab=files`);
  await page.locator(".code-line").first().waitFor();
  await page.waitForTimeout(400);
  await shot("version-files", { width: 1280, height: 760 });
} finally {
  await browser.close();
  await sv.stop();
  rmSync(root, { recursive: true, force: true });
}
