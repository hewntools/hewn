// SPDX-License-Identifier: AGPL-3.0-or-later
// #114: a link in a tool's own screen to one of Hewn's pages opened a new tab that asked to sign in (the browser held
// the session cookie back: the tool's frame counts as another site) and then landed on Home. Now the web client opens
// it, in its tab or a new one as the link asks, signed in, and never sends a message for the owner. What the owner
// would try: a tool with such links, each one clicked. (A small tool with the links is installed on the copy.)
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "../scenario.ts";

const ID = "smoke-links";

export default {
  name: "A tool's link to a page of Hewn opens it, signed in (#114)",
  async run(s) {
    let page: any;
    await s.step("install a tool whose screen links to Hewn's pages", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hewn-smoke-links-"));
      try {
        cpSync(fileURLToPath(new URL("../../../test/fixtures/ui-counter", import.meta.url)), dir, { recursive: true });
        const manifest = join(dir, "capability.json");
        writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), id: ID, name: "Smoke Links" }, null, 2));
        writeFileSync(
          join(dir, "ui", "index.html"),
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Links</title><link rel="stylesheet" href="/_platform/ui.css"></head>
<body><main class="page stack"><h1>Links to Hewn</h1>
<p><a id="here" href="/#/activity">Activity, here</a></p>
<p><a id="tab" href="/#/c/${ID}" target="_blank">This tool's Info, in a new tab</a></p>
<p><a id="send" href="/#/new?m=Hello%20from%20a%20tool&amp;send=1">Ask for a change (fills the box, sends nothing)</a></p></main></body></html>`,
        );
        const b = await s.copy.admin("install", { name: "Smoke Links", purpose: "Links to Hewn's pages", dir, wait: true }, 180_000);
        if (b.status !== "promoted") throw new Error(`install ${b.status}: ${(b.log ?? []).slice(-3).join(" | ")}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await s.step("a link to Activity opens Activity in this tab, signed in", async () => {
      page = await s.page(`#/app/${ID}`);
      const frame = page.frameLocator("iframe.app-frame");
      await frame.locator("#here").waitFor({ timeout: 15_000 });
      await s.shot("tool");
      await frame.locator("#here").click();
      await page.waitForURL(/#\/activity$/, { timeout: 10_000 });
      await page.locator("main").getByText("Activity").first().waitFor();
      if (await page.getByText(/Signed out|Sign in to Hewn/).count()) throw new Error("a sign-in page");
      await s.shot("activity");
    });

    await s.step("a link with target=_blank opens a new tab, signed in", async () => {
      page = await s.page(`#/app/${ID}`);
      const frame = page.frameLocator("iframe.app-frame");
      await frame.locator("#tab").waitFor({ timeout: 15_000 });
      const [tab] = await Promise.all([page.context().waitForEvent("page"), frame.locator("#tab").click()]);
      await tab.waitForLoadState();
      if (!tab.url().endsWith(`#/c/${ID}`)) throw new Error(`the new tab is at ${tab.url()}`);
      await tab.getByText("Smoke Links").first().waitFor({ timeout: 10_000 });
      if (await tab.getByText(/Signed out|Sign in to Hewn/).count()) throw new Error("the new tab has a sign-in page");
      await tab.close();
    });

    await s.step("a link that would send a message fills the box, and sends nothing", async () => {
      page = await s.page(`#/app/${ID}`);
      const frame = page.frameLocator("iframe.app-frame");
      await frame.locator("#send").waitFor({ timeout: 15_000 });
      await frame.locator("#send").click();
      await page.waitForURL(/#\/new\?m=/, { timeout: 10_000 });
      if (page.url().includes("send=1")) throw new Error(`send stayed: ${page.url()}`);
      const box = page.getByRole("textbox", { name: "Message" });
      await box.waitFor();
      await page.waitForTimeout(800);
      if ((await box.inputValue()) !== "Hello from a tool") throw new Error(`the box says ${await box.inputValue()}`);
      if (await page.locator(".bubble.me").count()) throw new Error("a message was sent for the owner");
      await s.shot("box");
    });

    await s.step("the tool goes again (deleted, as the owner would)", async () => {
      await s.copy.admin("archive", { capabilityId: ID });
    });
  },
} satisfies Scenario;
