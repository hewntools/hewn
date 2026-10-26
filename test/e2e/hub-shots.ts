// SPDX-License-Identifier: AGPL-3.0-or-later
// The Hub's card images: each tool on the shelf (seeds/shelf.json) installed from the Hub with its
// sample data on a test host, then its screen (its own UI, or its widget, or the Run view) and a
// widget shot into seeds/<id>/.hub/. Run per release, before it's cut:
// PLAYWRIGHT_NODE_MODULES=<playwright-core dir> node test/e2e/hub-shots.ts [id…]
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { USER } from "@hewntools/core/auth.ts";
import { findBrowser } from "@hewntools/cli/visual.ts";
import { serve, setup } from "../helpers.ts";

const SEEDS = resolve(import.meta.dirname, "../../seeds");
const pw = createRequire(process.env.PLAYWRIGHT_NODE_MODULES ?? import.meta.url)("playwright-core");
// A test host whose model provider answers key checks offline: tools that use a model are ready to draw (nothing here calls the model).
const t = setup({ modelFetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }) });
const server = await serve(t.platform, t.home);
const web = `http://hewn.localhost:${(server.address() as AddressInfo).port}`;
const browser = await pw.chromium.launch({ executablePath: findBrowser() });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1.5 });
const api = (path: string, method = "GET", body?: unknown) =>
  page.evaluate(
    async ([path, method, body]: readonly [string, string, unknown]) => {
      const res = await fetch(`/api${path}`, { method, headers: { "x-hewn-ui": "1", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? res.status);
      return json;
    },
    [path, method, body] as const,
  );
const settle = (buildId: string) => t.platform.settle(buildId);
const only = process.argv.slice(2);
try {
  await page.goto(`${web}/auth?ticket=${t.platform.createWebTicket(USER)}`);
  await page.waitForTimeout(500);
  await api("/models/keys/anthropic", "PUT", { key: "sk-ant-placeholder-for-screenshots" });
  await api("/models", "PUT", { provider: "anthropic" });
  // Offline there's no model catalog: a price for each tier's model, so a tool that uses one counts as set up.
  const tiers = { light: "placeholder-light", standard: "placeholder-standard", strong: "placeholder-strong", max: "placeholder-max" };
  await api("/models", "PUT", { tiers: { anthropic: tiers }, prices: Object.fromEntries(Object.values(tiers).map((id) => [`anthropic/${id}`, { input: 1, output: 5 }])) });
  const { tools } = JSON.parse(readFileSync(join(SEEDS, "shelf.json"), "utf8")) as { tools: string[] };
  for (const id of tools.filter((x) => !only.length || only.includes(x))) {
    const preview = await api(`/hub/${id}/stage`, "POST");
    const b = await settle((await api(`/bundles/${preview.token}/install`, "POST", { name: preview.name, sample: true })).buildId);
    if (b.status !== "promoted") throw new Error(`${id}: ${b.log.join("\n")}`);
    await api(`/capabilities/${id}/grants/approve`, "POST");
    const status = (await api(`/capabilities/${id}`)).status;
    if (!status.ready) console.log(`  ${id} isn't ready:`, JSON.stringify(status));
    const manifest = JSON.parse(readFileSync(join(SEEDS, id, "capability.json"), "utf8"));
    const out = (name: string) => join(SEEDS, id, ".hub", `${name}.png`);
    // A widget, drawn as Info shows it (with the sample data).
    let widget = false;
    if (manifest.widgets?.length) {
      await page.goto(`${web}/#/c/${id}`);
      const w = page.locator(".info-widget .widget-preview").first();
      await w.waitFor();
      await page.waitForTimeout(800);
      await w.screenshot({ path: out("widget") });
      widget = true;
    }
    // Its screen: its own UI, else its widget, else the Run view on its first read operation.
    if (manifest.ui?.available) {
      // A phone-ish width: the card shows the top of it, legibly.
      await page.setViewportSize({ width: 720, height: 560 });
      await page.goto(`${web}/#/app/${id}`);
      const frame = page.locator(".app-frame");
      await frame.waitFor();
      await page.waitForTimeout(2500);
      await frame.screenshot({ path: out("screen") });
      await page.setViewportSize({ width: 1100, height: 760 });
    } else if (widget) {
      await page.locator(".info-widget .widget-preview").first().screenshot({ path: out("screen") });
    } else {
      const op = manifest.operations.find((o: any) => o.sideEffect === "read");
      await page.setViewportSize({ width: 820, height: 560 });
      await page.goto(`${web}/#/run/${id}?op=${op.name}`);
      await page.locator("main.run").waitFor();
      await page.locator("main.run button[type=submit]").first().click();
      await page.waitForTimeout(1200);
      await page.locator("main.run").screenshot({ path: out("screen") });
      await page.setViewportSize({ width: 1100, height: 760 });
    }
    console.log("✔", id, widget ? "screen, widget" : "screen");
  }
} finally {
  await browser.close();
  server.close();
  t.cleanup();
}
