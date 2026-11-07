// SPDX-License-Identifier: AGPL-3.0-or-later
// The bench's headless Chromium: Hewn's own (@hewntools/cli/visual.ts), so a tool renders here as it
// does in Hewn's visual check, and is measured the same way (@hewntools/cli/defects.ts). Full-page
// screenshots at desktop and phone sizes in light and dark, errors on the page, the click-through.
import { type Browser, findBrowser, launchBrowser as launch, type Screen } from "@hewntools/cli/visual.ts";

export { type Browser, type Page, PHONE } from "@hewntools/cli/visual.ts";
/** The bench's desktop is taller than the visual check's (1280 × 800): a short page shows more of itself. */
export const DESKTOP: Screen = { name: "desktop", width: 1280, height: 900, mobile: false, scale: 1 };

export async function launchBrowser(binary = findBrowser()): Promise<Browser> {
  if (!binary) throw new Error("no Chromium-based browser found (set HEWN_BROWSER, or `npx playwright install chromium-headless-shell`)");
  return launch(binary, { flags: ["--hide-scrollbars", "--mute-audio"] });
}
