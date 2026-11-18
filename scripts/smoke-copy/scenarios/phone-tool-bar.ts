// SPDX-License-Identifier: AGPL-3.0-or-later
// #116: on a phone the tool's top bar showed Change…, Share… and •••, and the tool's name shrank to a letter. Now at
// 640 px and under it keeps ••• alone, which holds Change… and Share…; nothing else moves. What the owner would try:
// open a tool and its Info on a phone, light and dark, and find Change… and Share… under •••.
import type { Scenario } from "../scenario.ts";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

export default {
  name: "On a phone, a tool's bar is ••• alone (#116)",
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

    for (const [hash, where] of [[open, "the tool"], [info, "its Info"]] as const) {
      await s.step(`on a phone, ${where}'s bar is ••• alone, with Change… and Share… in it`, async () => {
        const page = await s.page(hash);
        await page.setViewportSize(PHONE);
        const bar = await shown(page);
        if (bar !== "•••") throw new Error(`the bar shows ${bar}`);
        await page.locator(".tool-actions").first().getByRole("button", { name: "More" }).click();
        for (const item of ["Change…", "Share…"]) await page.getByRole("menuitem", { name: item }).waitFor({ timeout: 5000 });
        await page.keyboard.press("Escape");
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        // The opened tool's bar has its name in the middle (Info's has none): it gets the room the pill gave up.
        if (where === "the tool") {
          const title = await page.locator(".topbar-center").first().evaluate((e: Element) => e.getBoundingClientRect().width);
          if (title < 150) throw new Error(`the name has ${Math.round(title)} px`);
        }
        const name = where === "the tool" ? "phone-tool" : "phone-info";
        await page.emulateMedia({ colorScheme: "light" });
        await s.shot(`${name}-light`);
        await page.emulateMedia({ colorScheme: "dark" });
        await s.shot(`${name}-dark`);
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize(DESKTOP);
      });
    }
  },
} satisfies Scenario;
