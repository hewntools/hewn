// SPDX-License-Identifier: AGPL-3.0-or-later
// #111: the model chip in the box is Settings › AI's builder model. With Hewn in two tabs, a pick in one changed what
// the other tab's next build ran on, while its chip still showed the old model. Now a build goes with the model its
// box shows, and a tab's chip reads the setting again when the tab is looked at again. What the owner would try: two
// tabs, a model picked in one, a change built from the other. (The copy's intake is a stub: its draft is given here.)
import type { Scenario } from "../scenario.ts";

export default {
  name: "A build goes with the model its box shows (#111)",
  async run(s) {
    const tool = s.tool;
    if (!tool) throw new Error("the copy has no tool to change");
    const settings = await s.copy.api("GET", "/api/settings");
    const builder: string = settings.builder;
    const original = settings.jobModels;
    const mine = settings.jobModels?.builder?.[builder] ?? {};
    const shownModel: string = mine.model ?? "default";
    const other = shownModel === "opus" ? "sonnet" : "opus";
    const setModel = (m: Record<string, string>) =>
      s.copy.api("PUT", "/api/settings", { jobModels: { ...(original ?? {}), builder: { ...(original?.builder ?? {}), [builder]: m }, intake: { ...(original?.intake ?? {}), [builder]: m } } });
    const c = await s.copy.call("get", tool);
    const hash = `#/${c.ui?.available ? "app" : "run"}/${encodeURIComponent(tool)}`;
    const before = (await s.copy.admin("status")).capabilities.find((x: { id: string }) => x.id === tool).version as number;
    let page: any;
    try {
      await s.step("a tab's chip shows the setting again when the tab is looked at again", async () => {
        page = await s.page("#/new");
        const chip = page.locator(".model-chip");
        await chip.waitFor();
        await setModel({ model: other });
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await chip.getByText(new RegExp(other, "i")).waitFor({ timeout: 5000 });
        await setModel(mine);
      });

      await s.step(`a change built from the drawer goes with its chip's model, though another tab picked ${other} meanwhile`, async () => {
        const draft = { kind: "draft", message: "A small change.", draft: { request: "Smoke scenario: a change built from the drawer." } };
        await page.route("**/api/intake", (r: any) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: reply\ndata: ${JSON.stringify(draft)}\n\n` }));
        page = await s.page(`${hash}?change=1`);
        const chip = page.locator(".drawer .model-chip");
        await chip.waitFor();
        await page.waitForTimeout(500);
        await s.shot("drawer-chip-light");
        await page.emulateMedia({ colorScheme: "dark" });
        await s.shot("drawer-chip-dark");
        await page.emulateMedia({ colorScheme: "light" });
        // Another tab picks another model.
        await setModel({ model: other });
        const box = page.locator(".drawer").getByRole("textbox", { name: "Message" });
        await box.fill("A small change");
        await box.press("Enter");
        await page.locator(".drawer").getByRole("button", { name: /^Build/ }).click();
        let b: any;
        for (let i = 0; i < 40 && !b; i++, await page.waitForTimeout(250)) b = (await s.copy.admin("status")).builds.find((x: any) => x.capabilityId === tool && x.request?.request === draft.draft.request);
        if (!b) throw new Error("no build started");
        const asked = b.model?.model ?? "default";
        if (asked !== shownModel || (b.model?.effort ?? null) !== (mine.effort ?? null)) throw new Error(`the build asked for ${JSON.stringify(b.model)}; the chip showed ${shownModel}${mine.effort ? ` · ${mine.effort}` : ""}`);
        const done = await s.waitBuild(b.buildId);
        if (done.status !== "promoted") throw new Error(`the build ${done.status}`);
      });
    } finally {
      await page?.unroute("**/api/intake").catch(() => {});
      await setModel(mine).catch(() => {});
      const now = (await s.copy.admin("status")).capabilities.find((x: { id: string }) => x.id === tool).version;
      if (now !== before) await s.copy.admin("rollback", { capabilityId: tool, version: before });
    }
  },
} satisfies Scenario;
