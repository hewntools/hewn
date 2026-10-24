// SPDX-License-Identifier: AGPL-3.0-or-later
// The Inbox (Needs you, Building, Recent), behind the bell in the top bar, and the banner for an
// agent blocked on a destructive call.
import { api, appIcon, caps, enc, fail, h, pixelGlyph, rowCells, skeleton } from "../kit.js";
import { activityRow, groupItems } from "./activity.js";
import { agentRequestSheet, agentTile, confirmationSheet } from "./agents.js";
import { go, put } from "./frame.js";
import { BELL } from "./glyphs.js";
import { grantsSheet, signInDialog } from "./grants.js";
import { buildingLabel } from "./home.js";
import { route } from "./router.js";
import { proposalSheet, schedulesSheet } from "./schedules.js";
import { toolModelSheet } from "./tool-model.js";
import { runnableOps } from "./tool.js";

export { closeInbox, inboxBtn, inboxPanel, pollInbox, toggleInbox };

// ---------- the Inbox: Needs you + Activity (replaces the builds chip, the Agents dot and Home's notices) ----------

const inboxCount = h("span", { class: "inbox-count", hidden: true });
const inboxBuilding = h("span", { class: "inbox-building", hidden: true, title: "Building" });
const inboxBtn = h("button", { class: "inbox-btn", "aria-label": "Inbox", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Inbox (i)" }, pixelGlyph(rowCells(BELL)), inboxCount, inboxBuilding);
inboxBtn.addEventListener("click", (e) => (e.stopPropagation(), toggleInbox()));
const inboxPanel = h("div", { class: "menu inbox-panel", role: "dialog", "aria-label": "Inbox" });
let inboxData = { needs: [], building: [] };
let inboxTab = "needs";
/** Blocking calls already shown as a banner, so a dismissed one doesn't come back until it changes. */
const banner = h("div", { class: "toast blocking-banner", role: "alert", hidden: true });
document.body.append(banner);

const closeInbox = (focus = false) => {
  inboxPanel.remove();
  inboxBtn.setAttribute("aria-expanded", "false");
  if (focus) inboxBtn.focus();
};
function toggleInbox() {
  if (inboxPanel.isConnected) return closeInbox();
  inboxTab = "needs";
  document.body.append(inboxPanel);
  inboxBtn.setAttribute("aria-expanded", "true");
  renderInbox();
  pollInbox(true);
}
document.addEventListener("click", (e) => inboxPanel.isConnected && !inboxPanel.contains(e.target) && !inboxBtn.contains(e.target) && !e.target.closest?.("dialog, .menu.context") && closeInbox());
window.addEventListener("hashchange", () => closeInbox());

/** The icon for an Inbox row: the tool's, an agent's tile, or Hewn's own for Models. */
function needIcon(n, all, size = 36) {
  if (n.capabilityId) return appIcon(all.get(n.capabilityId) ?? { id: n.capabilityId, name: n.title }, { size });
  if (n.kind === "agent") return agentTile(n.title, n.title, size);
  return h("span", { class: "app-icon", style: { "--size": `${size}px`, "--s": 0 } }, n.kind === "spend" ? "$" : "·");
}

/** What a Needs-you row opens: its own sheet (or page). */
async function openNeed(n) {
  closeInbox();
  try {
    if (n.kind === "grant") await grantsSheet(n.capabilityId);
    else if (n.kind === "connection") await (n.action === "Sign in" ? signInDialog(n.capabilityId) : grantsSheet(n.capabilityId));
    else if (n.kind === "build" || n.kind === "review") go(`#/b/${enc(n.buildId)}`);
    else if (n.kind === "agent") {
      const p = (await api("/agents/pending")).find((x) => x.id === n.id);
      if (p) await agentRequestSheet(p);
    } else if (n.kind === "confirmation") {
      const c = (await api("/confirmations")).find((x) => x.id === n.id);
      if (c) await confirmationSheet(c);
    } else if (n.kind === "schedule") {
      const x = (await api("/schedules")).find((s) => s.id === n.id);
      if (x?.status === "paused") {
        const cap = await api(`/capabilities/${enc(x.capabilityId)}`);
        await schedulesSheet({ ...((await caps()).get(x.capabilityId) ?? {}), ...cap }, runnableOps(cap));
      } else if (x) await proposalSheet(x);
    } else if (n.kind === "model") {
      const c = (await caps(true)).get(n.capabilityId);
      if (n.action === "Replace…" && c) await toolModelSheet(c, { replace: true });
      else await grantsSheet(n.capabilityId);
    } else if (n.kind === "builder-model") go("#/settings/ai");
    else if (n.kind === "spend") {
      const c = n.capabilityId && (await caps()).get(n.capabilityId);
      if (c) await toolModelSheet(c);
      else go("#/settings/ai/models");
    }
  } catch (e) {
    fail(e);
  }
  pollInbox();
  if (location.hash === "" || location.hash === "#/") route();
}

/** One Activity row, compact (the Inbox's Recent). */
function recentRow(i, all) {
  const g = groupItems([i])[0];
  const li = activityRow(g, all, true);
  li.classList.add("small");
  return li;
}

async function renderInbox() {
  if (!inboxPanel.isConnected) return;
  const all = await caps().catch(() => new Map());
  const { needs, building, recent } = inboxData;
  const tab = (key, label) => h("button", { "aria-pressed": String(inboxTab === key), onclick: (e) => (e.stopPropagation(), (inboxTab = key), renderInbox(), key === "activity" && pollInbox(true)) }, label);
  const head = h("div", { class: "inbox-head" }, h("div", { class: "segmented" }, tab("needs", `Needs you · ${needs.length}`), tab("activity", "Activity")), h("a", { class: "link sm", href: "#/activity" }, "All activity ›"));
  // The whole row opens it; what it opens to stays in the row's label.
  const needRow = (n) =>
    h(
      "div",
      { class: "inbox-row link", role: "button", tabindex: 0, "aria-label": `${n.title}: ${n.detail}. ${n.action}`, onclick: () => openNeed(n), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openNeed(n)) },
      h("span", { class: `dot ${n.severity}` }),
      needIcon(n, all),
      h("div", { class: "grow" }, h("span", { class: "title" }, n.title), h("span", { class: "small muted clip-1" }, n.detail)),
      h("span", { class: "faint", "aria-hidden": "true" }, "›"),
    );
  const buildRow = (b) => {
    const c = all.get(b.capabilityId) ?? { id: b.capabilityId, name: b.name };
    const lit = b.step?.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : 0;
    // The whole row opens the build.
    return h(
      "a",
      { class: "inbox-row link", href: `#/b/${enc(b.buildId)}` },
      h("span", { class: "dot live" }),
      appIcon(c, { size: 36, progress: lit, waiting: !lit }),
      h("div", { class: "grow" }, h("span", { class: "title" }, b.name), h("span", { class: "small muted" }, b.status === "waiting" ? "Waiting" : buildingLabel({ ...(b.step ?? {}), tests: b.tests }))),
      h("span", { class: "faint", "aria-hidden": "true" }, "›"),
    );
  };
  const recentList = (n) => (recent ? h("ul", { class: "list inbox-recent" }, recent.slice(0, n).map((i) => recentRow(i, all))) : skeleton("70%", "50%"));
  put(
    inboxPanel,
    head,
    inboxTab === "needs"
      ? [
          needs.length ? needs.map(needRow) : h("div", { class: "inbox-row muted small" }, "Nothing needs you."),
          building.length > 0 && [h("hr"), h("div", { class: "eyebrow inbox-eyebrow" }, "Building"), building.map(buildRow)],
          h("hr"),
          h("div", { class: "eyebrow inbox-eyebrow" }, "Recent"),
          recentList(3),
        ]
      : recentList(6),
  );
}

let inboxTimer = null;
async function pollInbox(withRecent = false) {
  clearTimeout(inboxTimer);
  if (!document.hidden) {
    const next = await api(`/inbox${inboxPanel.isConnected || withRecent ? "?recent=1" : ""}`).catch(() => null);
    if (next) {
      inboxData = { ...next, recent: next.recent ?? inboxData.recent };
      const n = next.needs.length;
      inboxCount.hidden = !n;
      inboxCount.textContent = String(n);
      inboxCount.classList.toggle("danger", next.needs.some((x) => x.severity === "danger"));
      inboxBuilding.hidden = !next.building.length;
      inboxBtn.setAttribute("aria-label", n ? `Inbox, ${n} need${n === 1 ? "s" : ""} you` : "Inbox");
      showBanner(next.needs.filter((x) => x.kind === "confirmation"));
      renderInbox();
    }
  }
  inboxTimer = setTimeout(pollInbox, inboxData.building?.length ? 4000 : 15000);
}

/** The one exception to "everything goes to the Inbox": an agent blocked on a destructive call. */
function showBanner(blocking) {
  if (!blocking.length) return (banner.hidden = true);
  const first = blocking[0];
  const who = first.detail.replace(/ wants to run .*$/, "");
  put(banner, h("span", { class: "dot danger" }), h("span", {}, `${who} is waiting for you`), h("button", { class: "sm", onclick: () => openNeed(first) }, "Review"));
  banner.hidden = false;
}
