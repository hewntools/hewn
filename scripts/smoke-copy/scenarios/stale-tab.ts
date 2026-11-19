// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would try by hand after "a page from before an upgrade stops refreshing itself" (0.4.12): Home open,
// Hewn updated under it (here: the copy's answers carry another web build), the toast says so with Reload only, and
// the page's own refreshes stop while the owner's own requests still go. Real time: the Inbox polls every 15 s.
import type { Scenario } from "../scenario.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "A page from before an update stops refreshing itself",
  async run(s) {
    let page: any;
    let updated = false;
    const refreshes: string[] = [];
    const owners: string[] = [];

    await s.step("Home open: it refreshes itself (the Inbox's poll)", async () => {
      page = await s.page("#/");
      await page.route("**/api/**", async (r: any) => {
        // The copy may be gone by then (a later check restarts it): the request fails, as it would without the route.
        const res = await r.fetch().catch(() => null);
        if (!res) return r.abort().catch(() => {});
        await r.fulfill({ response: res, headers: { ...res.headers(), ...(updated ? { "x-hewn-web": "0123456789abcdef" } : {}) } });
      });
      page.on("request", (r: any) => r.url().includes("/api/") && (r.headers()["x-hewn-refresh"] === "1" ? refreshes : owners).push(r.url()));
      await page.locator(".home-grid").first().waitFor({ timeout: 15_000 });
      for (let i = 0; i < 20 && !refreshes.length; i++) await sleep(1000);
      if (!refreshes.length) throw new Error("no refresh within 20 s");
    });

    await s.step("Hewn updated under it: the toast says so, with Reload only", async () => {
      updated = true;
      // The next answer (the owner's own, here) carries the new build.
      await page.evaluate(async () => {
        const kit = "/kit.js";
        await (await import(kit)).api("/settings");
      });
      const toast = page.locator(".toast", { hasText: "Hewn was updated" });
      await toast.waitFor({ timeout: 5000 });
      const actions = await toast.getByRole("button").allInnerTexts();
      if (actions.join() !== "Reload") throw new Error(`the toast's actions: ${actions.join(", ")}`);
      await s.shot("updated");
    });

    await s.step("no refresh goes out for 20 s; opening the Inbox still does", async () => {
      refreshes.length = 0;
      await sleep(20_000);
      if (refreshes.length) throw new Error(`the outdated page refreshed itself: ${refreshes.map((u) => new URL(u).pathname).join(", ")}`);
      owners.length = 0;
      await page.getByRole("button", { name: /^Inbox/ }).click();
      await sleep(1000);
      if (!owners.some((u) => u.includes("/api/inbox"))) throw new Error("opening the Inbox didn't ask for it");
      await page.keyboard.press("Escape");
    });

    await s.step("Reload: the toast is gone and the page refreshes again", async () => {
      updated = false;
      await page.locator(".toast", { hasText: "Hewn was updated" }).getByRole("button", { name: "Reload" }).click();
      await page.locator(".home-grid").first().waitFor({ timeout: 15_000 });
      refreshes.length = 0;
      for (let i = 0; i < 20 && !refreshes.length; i++) await sleep(1000);
      if (!refreshes.length) throw new Error("no refresh within 20 s of Reload");
      if (await page.locator(".toast", { hasText: "Hewn was updated" }).count()) throw new Error("the toast is still there");
      // Done with it: an open page goes on asking while later checks restart the copy.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.context().close();
    });
  },
} satisfies Scenario;
