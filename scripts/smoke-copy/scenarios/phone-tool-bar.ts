// SPDX-License-Identifier: AGPL-3.0-or-later
// #116: on a phone an open tool's top bar showed Change…, Share… and •••, and the tool's name shrank to a letter. Now at
// 640 px and under it keeps ••• alone, which holds Change… (the drawer, as the bar's did) and Share…; nothing else
// moves. What the owner would try: open a tool on a phone, light and dark, and use Change… and Share… under •••.
import type { Scenario } from "../scenario.ts";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

export default {
  name: "On a phone, an open tool's bar is ••• alone (#116)",
  async run(s) {
    const tool = s.tool;
    if (!tool) throw new Error("the copy has no tool to open");
    const c = await s.copy.call("get", tool);
    const open = c.ui?.available ? `#/app/${encodeURIComponent(tool)}` : `#/run/${encodeURIComponent(tool)}`;
    const info = `#/c/${encodeURIComponent(tool)}`;
    /** What the first tool bar on the page shows (its items not hidden on a phone). */
    const shown = async (page: any): Promise<string> => {
      await page.locator(".tool-actions").first().getByRole("button", { name: "More" }).waitFor({ timeout: 15_000 });
      return (await page.locator(".tool-actions").first().locator(":scope > *").evaluateAll((els: Element[]) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => (e.textContent ?? "").trim()))).join(" | ");
    };

    await s.step("on a desktop, the bar is as it was: Change…, Share…, •••", async () => {
      const page = await s.page(open);
      await page.setViewportSize(DESKTOP);
      const bar = await shown(page);
      if (bar !== "Change… | Share… | •••") throw new Error(`the bar shows ${bar}`);
      await s.shot("desktop-light");
    });

    await s.step("on a phone, the tool's bar is ••• alone, with Change… (the drawer, the tool kept) and Share… in it", async () => {
      const page = await s.page(open);
      await page.setViewportSize(PHONE);
      const bar = await shown(page);
      if (bar !== "•••") throw new Error(`the bar shows ${bar}`);
      // The tool's name gets the room the pill gave up.
      const title = await page.locator(".topbar-center").first().evaluate((e: Element) => e.getBoundingClientRect().width);
      if (title < 150) throw new Error(`the name has ${Math.round(title)} px`);
      await page.emulateMedia({ colorScheme: "light" });
      await s.shot("phone-tool-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await s.shot("phone-tool-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await page.locator(".tool-actions").first().getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Share…" }).waitFor({ timeout: 5000 });
      await s.shot("phone-menu");
      await page.locator(".with-drawer").evaluate((e: Element) => e.setAttribute("data-smoke", "same"));
      await page.getByRole("menuitem", { name: "Change…" }).click();
      await page.locator(".drawer").waitFor({ timeout: 10_000 });
      if (!(await page.locator(".with-drawer[data-smoke='same']").count())) throw new Error("•••'s Change… opened a new page (the tool reloaded)");
      await page.setViewportSize(DESKTOP);
    });

    await s.step("its Info's bar is as it was (it has no name to make room for)", async () => {
      const page = await s.page(info);
      await page.setViewportSize(PHONE);
      await page.getByRole("link", { name: "Change…" }).waitFor({ timeout: 10_000 });
      await s.shot("phone-info-light");
      await page.setViewportSize(DESKTOP);
    });
  },
} satisfies Scenario;
