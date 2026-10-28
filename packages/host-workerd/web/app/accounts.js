// SPDX-License-Identifier: AGPL-3.0-or-later
// Accounts: the connections, and adding one.
import { api, appIcon, capRef, caps, enc, formSheet, h, setWallpaper, sheetActions, skeleton } from "../kit.js";
import { go, hues, onLeave, page, stillHere } from "./frame.js";
import { grantsSheet, signInDialog } from "./grants.js";
import { buildingLabel } from "./home.js";
import { route } from "./router.js";

export { accountsPage, addConnectionSheet, HEALTH };

// ---------- I: Accounts and connections ----------

const HEALTH = {
  connected: ["ok", "Connected"],
  expired: ["warn", "Expired"],
  broken: ["danger", "Not working"],
  needs_setup: ["warn", "Needs setup"],
};

/** I1 Accounts: one row per connection; a button only when it needs you. */
async function accountsPage() {
  const here = stillHere();
  page("accounts", 720, h("h1", { class: "flush" }, "Accounts"), skeleton("60%", "90%", "70%"));
  const [{ connections }, all] = await Promise.all([api("/accounts"), caps(true)]);
  if (!here()) return;
  setWallpaper(await hues([260, 200]));
  if (!here()) return;
  const building = [...all.values()].filter((c) => c.kind === "connection" && c.building);
  const row = (x) => {
    const c = all.get(x.id) ?? { id: x.id, name: x.name };
    const b = c.building;
    const [dot, word] = b ? ["live", `building · ${buildingLabel(b).toLowerCase()}`] : (HEALTH[x.health?.status] ?? ["warn", x.health?.status ?? "needs setup"]);
    const needsGrants = !b && (x.status?.pendingGrants.length > 0 || x.status?.missingConfig.length > 0);
    const action = b
      ? null
      : needsGrants
        ? h("button", { class: "primary sm", onclick: (e) => (e.stopPropagation(), grantsSheet(x.id).then(() => route())) }, "Set up")
        : x.signIn && x.health?.status !== "connected"
          ? h("button", { class: "primary sm", onclick: (e) => (e.stopPropagation(), signInDialog(x.id).then((ok) => ok && route())) }, "Sign in")
          : x.health?.status === "needs_setup"
            ? h("button", { class: "primary sm", onclick: (e) => (e.stopPropagation(), grantsSheet(x.id).then(() => route())) }, "Set up")
            : null;
    const lit = b?.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : b ? 0 : undefined;
    const href = b && !c.version ? `#/b/${enc(b.buildId)}` : `#/c/${enc(x.id)}`;
    return h(
      "li",
      { class: "link account-row", tabindex: 0, onclick: () => go(href), onkeydown: (e) => e.key === "Enter" && go(href) },
      appIcon(c, { size: 40, progress: lit, waiting: b && !lit }),
      h(
        "div",
        { class: "grow" },
        h("span", { class: "strong" }, x.name),
        h(
          "span",
          { class: "sub row tight wrap" },
          h("span", { class: `dot ${dot}` }),
          word.toLowerCase(),
          // What health@1 says about it ("The session ended on 12 October"), when it says more than the word.
          !b && x.health?.detail && [h("span", { class: "faint" }, "·"), h("span", { class: "clip-1 health-detail" }, x.health.detail)],
          !b && [h("span", { class: "faint" }, "·"), "used by", x.usedBy?.length ? x.usedBy.map((u) => capRef(all.get(u.id), u.id, { size: 18 })) : h("span", {}, "nothing yet")],
        ),
      ),
      action,
    );
  };
  const newOnes = building.filter((c) => !c.version).map((c) => ({ id: c.id, name: c.name, usedBy: [] }));
  page(
    "accounts",
    720,
    h("div", { class: "row between" }, h("h1", { class: "flush" }, "Accounts"), h("button", { onclick: () => addConnectionSheet() }, "Add a connection")),
    h("div", { class: "card list-card" }, h("ul", { class: "list" }, [...connections, ...newOnes].length ? [...connections, ...newOnes].map(row) : h("li", {}, h("span", { class: "grow muted" }, "No connections yet")))),
  );
  // While a connection builds, check every few seconds; redraw when a build starts or ends.
  const conns = () => [...all.values()].filter((c) => c.kind === "connection");
  const signature = (cs) => cs.map((c) => `${c.id}:${c.building?.buildId ?? ""}:${c.building?.step ?? ""}:${c.building?.tests?.passed ?? ""}:${c.version}`).join("|");
  const last = signature(conns());
  if (!conns().some((c) => c.building)) return;
  const poll = async () => {
    if (!location.hash.startsWith("#/accounts")) return;
    const now = [...(await caps(true).catch(() => new Map())).values()].filter((c) => c.kind === "connection");
    if (signature(now) !== last) return accountsPage();
    timer = setTimeout(poll, 2500);
  };
  let timer = setTimeout(poll, 2500);
  onLeave(() => clearTimeout(timer));
}

const SERVICES = ["Todoist", "Notion", "Ghost", "Strava", "Garmin"];

/** I3 Add a connection: name the service; the intake takes it from there, in connection mode. */
function addConnectionSheet() {
  return formSheet({
    title: "Add a connection",
    build: (close) => {
      const input = h("input", { type: "text", placeholder: "Which service?", "aria-label": "Which service?", autocomplete: "off" });
      const next = h("button", { class: "primary", type: "submit", disabled: true }, "Next");
      input.addEventListener("input", () => (next.disabled = !input.value.trim()));
      const submit = (e) => (e?.preventDefault(), input.value.trim() && (close(), go(`#/new?connection=${enc(input.value.trim())}`)));
      setTimeout(() => input.focus());
      return h(
        "form",
        { class: "stack-md", onsubmit: submit },
        h("label", { class: "field" }, h("span", { class: "label" }, "Service"), input),
        h("div", { class: "row tight wrap" }, SERVICES.map((s) => h("button", { type: "button", class: "chip plain", onclick: () => ((input.value = s), (next.disabled = false), input.focus()) }, s))),
        h("div", { class: "small faint" }, "It's built like a tool. You approve what it needs."),
        sheetActions(h("button", { type: "button", onclick: () => close() }, "Cancel"), next),
      );
    },
  });
}
