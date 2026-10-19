// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser E2E for the web client (not part of npm test). Needs a running hewnd with
// running-log, ui-counter and secret-echo installed, and playwright-core with browsers:
//   PLAYWRIGHT_NODE_MODULES=/path/to/node_modules/ node test/e2e/web.e2e.mjs chromium|webkit

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const which = process.argv[2];
const req = createRequire(process.env.PLAYWRIGHT_NODE_MODULES ?? import.meta.url);
const pw = req("playwright-core");
const ticketUrl = () => execFileSync("hewn", ["open", "--print"], { encoding: "utf8" }).trim().split("\n").at(-1);
const browser = await pw[which].launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on("dialog", (d) => d.accept());
const step = async (name, fn) => { try { await fn(); console.log("✔", name); } catch (e) { console.log("✖", name, e.message.split("\n")[0]); await page.screenshot({ path: `/tmp/e2e-${which}-fail.png` }); throw e; } };
await step("sign in → drawer", async () => {
  await page.goto(ticketUrl());
  await page.waitForSelector(".tile-name");
  const names = await page.$$eval(".tile-name", (els) => els.map((e) => e.textContent));
  if (!names.includes("Running Log") || !names.includes("UI Counter")) throw new Error(names.join(","));
  await page.screenshot({ path: `/tmp/e2e-${which}-drawer.png` });
});
if (which === "chromium") {
  await step("Running Log (no UI) → generated capability page", async () => {
    await page.click("text=Running Log");
    await page.waitForSelector("form.op");
  });
  await step("record_run via generated form", async () => {
    const form = page.locator("form.op", { hasText: "record_run" });
    await form.locator("label", { hasText: "distanceKm" }).locator("input").fill("7.5");
    await form.locator("label", { hasText: "durationSeconds" }).locator("input").fill("2400");
    await form.locator("label", { hasText: "notes" }).locator("input").fill("<b>evening</b> run");
    await form.locator("button[type=submit]").click();
    await form.locator(".result dd, .result td, .result pre").first().waitFor();
  });
  await step("list_runs renders a table, HTML in data shown as text", async () => {
    const form = page.locator("form.op", { hasText: "list_runs" });
    await form.locator("button[type=submit]").click();
    await form.locator("table td", { hasText: "<b>evening</b> run" }).first().waitFor();
    if (await page.locator("b", { hasText: "evening" }).count()) throw new Error("HTML was rendered");
    await page.locator("pre.logs", { hasText: /web list_runs@1 ok/ }).waitFor();
    if ((await page.locator("form.op", { hasText: "list_runs" }).locator(".result").textContent()).startsWith("0")) throw new Error("stray 0");
    await page.screenshot({ path: `/tmp/e2e-${which}-capability.png`, fullPage: true });
  });
  await step("secret + grant approval from setup", async () => {
    await page.goto(page.url().replace(/#.*$/, "#/c/secret-echo"));
    await page.locator(".card.auth input[type=password]").fill("web-secret");
    await page.locator(".card.auth button", { hasText: "Authorize" }).click();
    await page.locator(".pill.ok", { hasText: "authorized" }).waitFor();
    const form = page.locator("form.op", { hasText: "whoami" });
    await form.locator("button[type=submit]").click();
    await form.locator(".result", { hasText: "10" }).waitFor();
  });
}
if (which === "chromium") {
  await step("capability → capability: authorization screen, then a composed call", async () => {
    await page.goto(page.url().replace(/#.*$/, "#/c/run-feeder"));
    await page.locator(".card.auth h2", { hasText: "wants to:" }).waitFor();
    await page.locator(".auth-list li", { hasText: "write Running Log: record_run@1" }).waitFor();
    await page.screenshot({ path: `/tmp/e2e-${which}-authorize.png`, fullPage: true });
    await page.locator(".card.auth button", { hasText: "Authorize" }).click();
    await page.locator(".pill.ok", { hasText: "authorized" }).first().waitFor();
    const form = page.locator("form.op", { hasText: "feed" });
    await form.locator("textarea").fill('[{"date":"2026-10-04","distanceKm":6,"durationSeconds":1900}]');
    await form.locator("button[type=submit]").click();
    await form.locator(".result", { hasText: "1" }).waitFor();
    await page.locator("text=Used by").count();
  });
}
await step("right-click an app → context menu → Info", async () => {
  await page.goto(page.url().replace(/#.*$/, "#/"));
  await page.click("text=UI Counter", { button: "right" });
  await page.locator(".menu-item", { hasText: "Info" }).click();
  await page.locator("h1", { hasText: "UI Counter" }).waitFor();
});
await step("tap UI Counter → opens embedded in Hewn, own origin, signed in", async () => {
  await page.goto(page.url().replace(/#.*$/, "#/"));
  await page.click("text=UI Counter");
  await page.waitForURL(/#\/app\/ui-counter/);
  const frame = page.frameLocator("iframe.app-frame");
  await frame.locator("#n").filter({ hasText: /\d/ }).waitFor();
  const before = Number(await frame.locator("#n").textContent());
  await frame.locator("#inc").click();
  await frame.locator("#n", { hasText: String(before + 1) }).waitFor();
  const src = await page.locator("iframe.app-frame").getAttribute("src");
  if (!/^http:\/\/hewn\.localhost:\d+\/tools\/ui-counter\//.test(src)) throw new Error(`frame src ${src}`);
  if (!page.url().includes("hewn.localhost")) throw new Error("left Hewn");
  await page.screenshot({ path: `/tmp/e2e-${which}-ui.png` });
});
if (which === "chromium") {
  await step("activity shows web + ui calls", async () => {
    await page.goto(ticketUrl());
    await page.waitForSelector(".tile-name");
    await page.goto(page.url().replace(/#.*$/, "") + "#/activity");
    await page.screenshot({ path: `/tmp/e2e-${which}-activity.png`, fullPage: true });
    await page.locator("td", { hasText: "ui:ui-counter" }).first().waitFor();
    await page.locator("td", { hasText: "web" }).first().waitFor();
  });
}
await browser.close();
