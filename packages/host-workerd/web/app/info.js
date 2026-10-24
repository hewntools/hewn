// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's Info page, and a connection's page.
import { actorLabel, ago, api, appIcon, builderLabel, capRef, caps, chip, enc, fail, h, menuFrom, setWallpaper, skeleton, tintOf, toast } from "../kit.js";
import { HEALTH } from "./accounts.js";
import { backBar, go, hues, put, sandboxNotice, view } from "./frame.js";
import { grantsSheet, signInDialog } from "./grants.js";
import { buildingLabel } from "./home.js";
import { plural } from "./intake.js";
import { titleCase, usd } from "./models.js";
import { route } from "./router.js";
import { cadenceText, schedulesSheet } from "./schedules.js";
import { capabilityMenu, changeHref, inlineRename, instructionsSheet, openCapability, openChange, versionsDialog } from "./tool-actions.js";
import { toolModelSheet } from "./tool-model.js";
import { runnableOps, sidePill } from "./tool.js";
import { toolWidgetsSheet } from "./widgets.js";

export { infoPage };

// ---------- N4 Info / I2 connection page ----------

/** Text with the owner's tool names rendered as cap-refs. */
function richText(text, all, self) {
  const others = [...all.values()].filter((c) => c.id !== self && c.name.length > 2).sort((a, b) => b.name.length - a.name.length);
  if (!others.length || !text) return [text];
  const re = new RegExp(`(${others.map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(re).map((part) => {
    const c = others.find((x) => x.name === part);
    return c ? capRef(c) : part;
  });
}

/** A tool's status as pills: needs you, building or a failed build, the version, who built it, when. */
function statusPills(c, cap, all) {
  const latest = cap.versions[0];
  return h(
    "div",
    { class: "row tight wrap" },
    c.building
      ? h("a", { class: "pill accent with-dot", href: `#/b/${enc(c.building.buildId)}` }, buildingLabel(c.building).toLowerCase())
      : c.lastBuild?.status === "failed"
        ? h("a", { class: "pill danger with-dot", href: `#/b/${enc(c.lastBuild.buildId)}` }, "build failed")
        : cap.status.ready
          ? h("span", { class: "pill ok with-dot" }, "ready")
          : h("span", { class: "pill warn with-dot" }, "needs you"),
    latest && h("span", { class: "pill" }, `v${c.version ?? latest.version}`),
    latest && h("span", { class: "pill" }, `built by ${latest.builder === "agent" ? actorLabel(latest.requestedBy, all).replace(/^You$/, "you") : builderLabel(latest.builder)}`),
    latest && h("span", { class: "pill" }, ago(latest.createdAt)),
  );
}

async function infoPage(id) {
  view(backBar("Home", "#/"), h("main", { class: "column", style: { "--w": "760px" } }, skeleton("50%", "30%", "90%", "70%")));
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  const c = all.get(id) ?? { id, name: cap.name, ui: !!cap.ui?.available, ready: cap.status.ready, kind: cap.kind };
  setWallpaper(await hues([tintOf(c)]));
  if (cap.kind === "connection") return connectionPage(c, cap, all);
  const ops = runnableOps(cap);
  const items = cap.authorization?.items ?? [];
  const uses = (cap.requires?.capabilities ?? []).map((u) => u.id);
  const usedBy = (cap.usedBy ?? []).map((u) => u.id);
  const name = h("span", {}, cap.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");

  // "Change it" opens the tool with the drawer (P1) and sends the text.
  const ask = h("input", { type: "text", class: "bare", placeholder: `What should ${cap.name} also do?`, "aria-label": "Change it" });
  const composer = h(
    "form",
    { class: "card composer-card", onsubmit: (e) => (e.preventDefault(), ask.value.trim() && openChange(c, { m: ask.value.trim(), send: true })) },
    h("span", { class: "eyebrow accent" }, "Change it"),
    ask,
    h("button", { type: "submit", class: "primary lg" }, "Ask"),
  );

  // One list of rows, each opening its sheet or page.
  const infoRow = (label, value, onOpen, dot) =>
    h("li", { class: "link info-row", tabindex: 0, onclick: onOpen, onkeydown: (e) => e.key === "Enter" && onOpen() }, h("span", { class: "info-key" }, label), h("div", { class: "grow row tight" }, dot && h("span", { class: `dot ${dot}` }), h("span", { class: "muted clip-1" }, value)));
  const pendingN = items.filter((i) => !i.approved).length;
  const rows = h("ul", { class: "list" });
  const fill = async () => {
    const [scheds, home, m, instr] = await Promise.all([api("/schedules").catch(() => []), api("/home").catch(() => ({ layout: [], gallery: [] })), cap.requires?.model ? api("/models").catch(() => null) : null, api(`/capabilities/${enc(id)}/instructions`).catch(() => ({ lines: [] }))]);
    const mine = scheds.filter((x) => x.capabilityId === id);
    const paused = mine.filter((x) => x.status === "paused");
    const widgets = home.gallery.find((g) => g.capabilityId === id)?.widgets ?? [];
    const placed = home.layout.filter((e) => e.type === "widget" && e.id === id).length;
    const spent = m ? m.spend.rows.filter((r) => r.capabilityId === id).reduce((n, r) => n + r.costUsd, 0) : 0;
    const req = cap.requires?.model;
    const latest = cap.versions[0];
    put(
      rows,
      infoRow("Operations", ops.length ? `${ops.length} · ${ops.map((o) => o.name).join(", ")}` : "None", () => go(`#/run/${enc(id)}`)),
      infoRow("Allowed to", items.length ? `${items.length}${pendingN ? ` · ${pendingN} pending` : ""}` : "Nothing outside itself", () => grantsSheet(id).then(() => route()), pendingN ? "warn" : null),
      req && infoRow("Model", `${req.tier ? `${titleCase(req.tier)} tier` : req.model}${m ? ` · ${usd(spent)} this month` : ""}`, () => toolModelSheet(c).then((ok) => ok || route()), cap.status.retiredModel ? "danger" : cap.status.missingModel ? "warn" : null),
      infoRow("Schedules", mine.length ? [mine.filter((x) => x.status === "active").map((x) => cadenceText(x.cadence)).join(", "), paused.length ? `${paused.length} paused` : "", mine.some((x) => x.status === "proposed") ? "1 proposed" : ""].filter(Boolean).join(" · ") || "None" : "None", () => schedulesSheet(c, ops).then(() => route()), paused.some((x) => x.pausedReason) ? "danger" : mine.some((x) => x.status === "proposed") ? "warn" : null),
      infoRow("Widgets", widgets.length ? `${widgets.length} · ${placed} on Home` : "None", () => toolWidgetsSheet(c).then(() => route())),
      infoRow("Instructions", instr.lines.length ? `${plural(instr.lines.length, "rule")} for this tool` : "None · rules for every tool are under Settings › AI", () => instructionsSheet(c).then(() => route())),
      latest && infoRow("Versions", `v${c.version ?? latest.version} · ${ago(latest.createdAt)}`, () => versionsDialog(c)),
    );
  };
  fill();
  const connected = [...new Set([...uses, ...usedBy])];
  view(
    backBar("Home", "#/", h("div", { class: "glass-bar" }, more)),
    sandboxNotice(),
    h(
      "main",
      { class: "column info", style: { "--w": "760px" } },
      h(
        "div",
        { class: "info-head" },
        appIcon(c, { size: 72 }),
        h(
          "div",
          { class: "grow col" },
          h("h1", { class: "title-xl" }, name),
          h("div", { class: "muted row tight wrap" }, richText(cap.purpose, all, id), connected.length > 0 && [h("span", { class: "faint" }, "·"), uses.length ? "uses" : "used by", connected.map((x) => capRef(all.get(x), x))]),
        ),
        h("button", { class: "lg", onclick: () => openCapability(c).catch(fail) }, "Open"),
      ),
      statusPills(c, cap, all),
      composer,
      h("div", { class: "card list-card" }, rows),
    ),
  );
}

/**
 * I2 A connection's page: its health; Operations on the left (each opens the Run view, health shows
 * its last result); Used by and Settings (sign-in, its config as one form, one Save) on the right.
 */
async function connectionPage(c, cap, all) {
  const id = c.id;
  const name = h("span", {}, cap.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");
  const ops = runnableOps(cap);
  const signIn = cap.operations.some((o) => o.name === "connect");
  const healthLine = h("div", { class: "muted row tight" }, skeleton("40%"));
  const healthRow = h("li", {}, h("div", { class: "grow" }, h("span", { class: "mono" }, "health"), h("span", { class: "sub" }, "Checking…")));
  const config = cap.authorization?.config ?? [];
  const inputs = config.map((x) => ({ x, input: h("input", { type: "text", value: x.value ?? "", placeholder: x.description, autocomplete: "off" }) }));
  const save = h("button", { class: "primary sm" }, "Save");
  save.addEventListener("click", async () => {
    try {
      save.disabled = true;
      for (const { x, input } of inputs) if (input.value !== (x.value ?? "")) await api(`/capabilities/${enc(id)}/config/${enc(x.name)}`, { method: "PUT", body: { value: input.value } });
      toast("Settings saved");
      route();
    } catch (e) {
      save.disabled = false;
      fail(e);
    }
  });
  const needsSetup = !cap.status.ready && (cap.status.pendingGrants.length || cap.status.missingConfig.length);
  view(
    backBar("Accounts", "#/accounts", h("div", { class: "glass-bar" }, h("a", { href: changeHref(c) }, "Change…"), more)),
    sandboxNotice(),
    h(
      "main",
      { class: "column info", style: { "--w": "900px" } },
      h(
        "div",
        { class: "info-head" },
        appIcon(c, { size: 64 }),
        h("div", { class: "grow col" }, h("h1", { class: "title-xl" }, name), healthLine),
        needsSetup && h("button", { class: "primary", onclick: () => grantsSheet(id).then(() => route()) }, "Set up"),
      ),
      h(
        "div",
        { class: "info-grid" },
        h(
          "div",
          { class: "card list-card" },
          h("div", { class: "eyebrow" }, "Operations"),
          h(
            "ul",
            { class: "list" },
            ops.filter((o) => o.name !== "health").map((op) => h("li", { class: "link", tabindex: 0, onclick: () => go(`#/run/${enc(id)}?op=${enc(op.name)}`), onkeydown: (e) => e.key === "Enter" && go(`#/run/${enc(id)}?op=${enc(op.name)}`) }, h("div", { class: "grow" }, h("span", { class: "mono" }, op.name), h("span", { class: "sub" }, op.description)), sidePill(op.sideEffect))),
            healthRow,
          ),
        ),
        h(
          "div",
          { class: "stack-md" },
          h("div", { class: "card connected" }, h("div", { class: "eyebrow" }, "Used by"), cap.usedBy?.length ? h("div", { class: "row tight wrap" }, cap.usedBy.map((u) => chip(all.get(u.id) ?? { id: u.id, name: u.name }, undefined, { href: `#/c/${enc(u.id)}` }))) : h("span", { class: "muted small" }, "Nothing yet")),
          (signIn || inputs.length > 0) &&
            h(
              "div",
              { class: "card settings-card" },
              signIn && h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, "Sign-in"), h("span", { class: "sub" }, cap.status.missingSecrets.length ? "Not signed in" : "Signed in")), h("button", { class: cap.status.missingSecrets.length ? "sm primary" : "sm", onclick: () => signInDialog(id).then((ok) => ok && route()) }, cap.status.missingSecrets.length ? "Sign in" : "Sign in again")),
              inputs.map(({ x, input }) => h("div", { class: "setting stacked" }, h("div", { class: "grow" }, h("span", { class: "mono" }, x.name), h("span", { class: "sub" }, x.description)), input)),
              inputs.length > 0 && h("div", { class: "row end settings-save" }, save),
            ),
        ),
      ),
    ),
  );
  api(`/capabilities/${enc(id)}/health`)
    .then((hl) => {
      const [dot, word] = HEALTH[hl.status] ?? ["warn", hl.status];
      put(healthLine, h("span", { class: `dot ${dot}` }), `${word} · checked ${ago(hl.checkedAt)}`, hl.detail && h("span", { class: "faint clip-1" }, ` · ${hl.detail}`));
      put(healthRow, h("div", { class: "grow" }, h("span", { class: "mono" }, "health"), h("span", { class: "sub" }, `Checked ${ago(hl.checkedAt)}${hl.detail ? ` · ${hl.detail}` : ""}`)), h("span", { class: `pill ${dot}` }, hl.status === "connected" ? "ok" : word.toLowerCase()));
    })
    .catch((e) => put(healthLine, h("span", { class: "dot danger" }), e.message));
}
