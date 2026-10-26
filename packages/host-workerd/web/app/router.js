// SPDX-License-Identifier: AGPL-3.0-or-later
// The router: the address (#/…) to a page. It imports the pages, and starts the client.
import { empty, errorBox, h, setWallpaper } from "../kit.js";
// No module reads another's binding as it loads, so the order below is free; the client starts at the end of this module.
import "./appearance.js";
import { holdFirstDraw, hues, leaving, loadSettings, page, releaseHeld } from "./frame.js";
import { accountsPage } from "./accounts.js";
import { activityPage } from "./activity.js";
import { passkeyPage } from "./add-passkey.js";
import { agentsPage } from "./agents.js";
import { buildPage } from "./build.js";
import { home } from "./home.js";
import { pollInbox } from "./inbox.js";
import { infoPage } from "./info.js";
import { intakePage } from "./intake.js";
import { settingsPage } from "./settings.js";
import { appPage, runPage } from "./tool.js";
import { versionPage, versionsPage } from "./versions.js";

export { route };

// ---------- router ----------

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] ?? "", id: parts[1], sub: parts[2], arg: parts[3], q: new URLSearchParams(qs ?? "") };
}

let routing = 0;
/** The address on screen: drawing it again is a refresh, which keeps the page until it's ready. */
let shown = null;
async function route() {
  for (const fn of leaving.splice(0)) fn();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  const n = ++routing;
  const { page: p, id, sub, arg, q } = parseHash();
  const refresh = location.hash === shown;
  document.body.classList.remove("app-mode");
  if (p !== "" && !refresh) setWallpaper(await hues(), { dim: true });
  if (n !== routing) return;
  holdFirstDraw(refresh);
  try {
    if (p === "") return await home();
    if (p === "app") return await appPage(id, q);
    if (p === "run") return await runPage(id, q);
    if (p === "c" && sub === "versions") return await versionsPage(id);
    if (p === "c" && sub === "v") return await versionPage(id, Number(arg), q);
    if (p === "c") return await infoPage(id);
    if (p === "new") return await intakePage(q);
    if (p === "b") return await buildPage(id);
    if (p === "activity") return await activityPage(q);
    if (p === "agents") return await agentsPage();
    if (p === "accounts") return await accountsPage();
    if (p === "settings") return await settingsPage(id, sub);
    if (p === "passkey") return await passkeyPage();
    page("", 680, empty("Not found", "That page doesn't exist."), h("a", { class: "btn self-center", href: "#/" }, "Home"));
  } catch (e) {
    if (n === routing) page("", 680, errorBox(e), h("a", { class: "btn self-start", href: "#/" }, "‹ Home"));
  } finally {
    if (n === routing) (releaseHeld(), (shown = location.hash));
  }
}

window.addEventListener("hashchange", () => (route(), pollInbox()));
loadSettings().then(() => (route(), pollInbox()));
