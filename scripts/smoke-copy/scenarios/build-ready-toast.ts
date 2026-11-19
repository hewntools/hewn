// SPDX-License-Identifier: AGPL-3.0-or-later
// #110: a change that goes live while its tool is open and the Change drawer closed said nothing (only the bar's
// version moved). Now a toast on the tool's page says "vN is ready", with Reload; the page never reloads itself.
// What the owner would try: open a tool, change it from elsewhere (another tab, an agent), come back to the tab.
import type { Scenario } from "../scenario.ts";

export default {
  name: "A change goes live while its tool is open: a toast with Reload (#110)",
  async run(s) {
    const tool = s.tool;
    if (!tool) throw new Error("the copy has no tool to change");
    const c = await s.copy.call("get", tool);
    const hash = c.ui?.available ? `#/app/${encodeURIComponent(tool)}` : `#/run/${encodeURIComponent(tool)}`;
    const live = async () => (await s.copy.admin("status")).capabilities.find((x: { id: string }) => x.id === tool).version as number;
    const before = await live();
    let page: any;
    let next = 0;

    await s.step(`open ${tool}, its drawer closed`, async () => {
      page = await s.page(hash);
      await page.locator(".app-title .pill").waitFor();
      await page.locator(".with-drawer").evaluate((e: Element) => e.setAttribute("data-smoke", "same"));
    });

    await s.step("a change goes live from elsewhere; back on the tab, a toast says it's ready, and the page waits", async () => {
      const b = await s.copy.admin("modify", { capabilityId: tool, request: "Smoke scenario: a change while the tool is open.", wait: true });
      if (b.status !== "promoted") throw new Error(`the change ${b.status}`);
      next = b.resultVersion;
      // As the tab being looked at again.
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator(".toast", { hasText: `v${next} is ready` }).waitFor({ timeout: 10_000 });
      if ((await page.locator(".app-title .pill").textContent()) !== `v${next}`) throw new Error("the bar's version didn't follow");
      if (!(await page.locator(".with-drawer[data-smoke='same']").count())) throw new Error("the page reloaded itself");
      await page.emulateMedia({ colorScheme: "light" });
      await s.shot("desktop-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await s.shot("desktop-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 390, height: 844 });
      await s.shot("phone-light");
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    await s.step("Reload shows it, and the toast goes", async () => {
      await page.locator(".toast", { hasText: "is ready" }).getByRole("button", { name: "Reload" }).click();
      await page.locator(".toast", { hasText: "is ready" }).waitFor({ state: "detached", timeout: 10_000 });
      if ((await page.locator(".app-title .pill").textContent()) !== `v${next}`) throw new Error("the bar's version");
    });

    await s.step(`back to v${before}`, async () => {
      await s.copy.admin("rollback", { capabilityId: tool, version: before });
    });
  },
} satisfies Scenario;
