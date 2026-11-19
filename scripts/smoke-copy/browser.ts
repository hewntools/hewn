// SPDX-License-Identifier: AGPL-3.0-or-later
// The headless browser for the copy's pages: Playwright's headless shell (or another Chromium) driven by
// playwright-core, which isn't one of Hewn's dependencies: PLAYWRIGHT_NODE_MODULES names a node_modules that has it,
// else npx's cache is searched (`npx playwright install chromium-headless-shell` puts one there).
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "../../packages/cli/src/visual.ts";
import type { CopyClient } from "./client.ts";
import { sleep } from "./scenario.ts";

/** Where playwright-core is: PLAYWRIGHT_NODE_MODULES, this checkout, or npx's cache. */
function playwrightCore(): any | undefined {
  const tries = [process.env.PLAYWRIGHT_NODE_MODULES, import.meta.url];
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) if (existsSync(join(npx, d, "node_modules", "playwright-core"))) tries.push(join(npx, d, "node_modules") + "/");
  for (const t of tries) {
    if (!t) continue;
    try {
      return createRequire(t)("playwright-core");
    } catch {}
  }
  return undefined;
}

/** A page's problems: console errors, uncaught errors, and requests to the copy that failed. */
export interface Watched {
  page: any;
  errors: string[];
}

export class Browser {
  private browser: any;
  private c: CopyClient;
  private constructor(browser: any, c: CopyClient) {
    this.browser = browser;
    this.c = c;
  }

  /** A browser, or why there's none. */
  static async open(c: CopyClient): Promise<Browser | string> {
    const pw = playwrightCore();
    if (!pw) return "no playwright-core found: set PLAYWRIGHT_NODE_MODULES to a node_modules that has it";
    const exe = findBrowser();
    if (!exe) return "no Chromium found: npx playwright install chromium-headless-shell";
    return new Browser(await pw.chromium.launch({ executablePath: exe }), c);
  }

  /** A new page signed in as the owner (its own context: its own cookie), watched for problems. */
  async signedIn(): Promise<Watched> {
    const ctx = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => m.type() === "error" && errors.push(`console: ${m.text()}`));
    page.on("pageerror", (e: Error) => errors.push(`page error: ${e.message}`));
    page.on("requestfailed", (r: any) => r.url().startsWith(this.c.origin) && !/ERR_ABORTED/.test(r.failure()?.errorText ?? "") && errors.push(`request failed: ${r.url().slice(this.c.origin.length)} ${r.failure()?.errorText ?? ""}`));
    page.on("response", (r: any) => r.url().startsWith(this.c.origin) && r.status() >= 500 && errors.push(`HTTP ${r.status()}: ${r.url().slice(this.c.origin.length)}`));
    await page.goto(`${this.c.origin}/auth?ticket=${await this.c.ticket()}`);
    // The sign-in redirect lands first, or a later goto is interrupted by it.
    await sleep(1000);
    return { page, errors };
  }

  close() {
    return this.browser.close().catch(() => {});
  }
}

/** Home is drawn: its grid without the loading state. */
export const HOME_READY = "#app > main.home:not([aria-busy]) .home-grid";
