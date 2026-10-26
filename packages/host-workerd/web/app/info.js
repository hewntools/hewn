// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's Info page (W1–W3: everything on the page), and a connection's page.
import { ago, api, appIcon, capRef, caps, chip, enc, fail, h, invalidateCaps, menuFrom, setWallpaper, skeleton, tintOf, toast } from "../kit.js";
import { HEALTH } from "./accounts.js";
import { backBar, go, hues, put, sandboxNotice, view } from "./frame.js";
import { grantsSheet, grantText, kindPill, signInDialog, TIERS } from "./grants.js";
import { buildingLabel } from "./home.js";
import { plural } from "./intake.js";
import { modelPicker, titleCase } from "./models.js";
import { route } from "./router.js";
import { addScheduleSheet, scheduleRow } from "./schedules.js";
import { capabilityMenu, changeHref, download, inlineRename, openCapability, openChange } from "./tool-actions.js";
import { modelSpend, quickModelChange, toolModelSheet } from "./tool-model.js";
import { runnableOps, sidePill } from "./tool.js";
import { madeBy, versionRow } from "./versions.js";
import { addWidgetSheet, segmented, SIZE_LETTER, widgetPreview } from "./widgets.js";

export { infoPage };

// ---------- W1–W3 Info / I2 connection page ----------

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

/** Operations shown before Show all. */
const OPS_SHOWN = 5;

/** A tool's status as pills: needs you, building or a failed build, the version, what built it, when. */
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
          : c.saidNo
            ? h("span", { class: "pill with-dot" }, "you said no")
            : h("span", { class: "pill warn with-dot" }, "needs you"),
    latest && h("span", { class: "pill" }, `v${c.version ?? latest.version}`),
    latest && h("span", { class: "pill" }, madeBy(latest, all).replace(/ You$/, " you")),
    latest && h("span", { class: "pill" }, ago(latest.createdAt)),
  );
}

/** One section of Info: a card with its title (and an action on the right), then the thing itself. */
const section = (title, body, { action, order } = {}) => h("section", { class: "card info-section", style: { order } }, h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, title), action), body);


async function infoPage(id) {
  view(backBar("Home", "#/"), h("main", { class: "column", style: { "--w": "760px" } }, skeleton("50%", "30%", "90%", "70%")));
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  const c = all.get(id) ?? { id, name: cap.name, ui: !!cap.ui?.available, ready: cap.status.ready, kind: cap.kind };
  setWallpaper(await hues([tintOf(c)]));
  if (cap.kind === "connection") return connectionPage(c, cap, all);
  const req = cap.requires?.model;
  const [scheds, home, m, instr, data] = await Promise.all([
    api("/schedules").catch(() => []),
    api("/home").catch(() => ({ layout: [], gallery: [] })),
    req ? api("/models").catch(() => null) : null,
    api(`/capabilities/${enc(id)}/instructions`).catch(() => ({ lines: [] })),
    api(`/capabilities/${enc(id)}/data`).catch(() => null),
  ]);
  const ops = runnableOps(cap);
  const items = cap.authorization?.items ?? [];
  const config = cap.authorization?.config ?? [];
  const uses = (cap.requires?.capabilities ?? []).map((u) => u.id);
  const usedBy = (cap.usedBy ?? []).map((u) => u.id);
  const version = c.version ?? cap.versions[0]?.version;
  const mine = scheds.filter((x) => x.capabilityId === id);
  const widgets = home.gallery.find((g) => g.capabilityId === id)?.widgets ?? [];
  let rules = instr.lines;

  // What still needs the owner. A model with no provider key, a secret without its value or a
  // setting without one goes through the grants sheet (it has the fields); a host or another tool is one tap.
  const needsKey = !!req && !!m && !m.host && (!m.provider || !m.providers.find((p) => p.id === m.provider)?.keySet);
  const missingSecrets = new Set(cap.status.missingSecrets ?? []);
  const pending = items.filter((i) => !i.approved || (i.kind === "secret" && missingSecrets.has(i.grant.slice(7))) || (i.kind === "model" && needsKey));
  const oneTap = (i) => !i.approved && (i.kind === "host" || i.kind === "capability" || (i.kind === "model" && !needsKey));
  // What the owner said no to (Deny) for this version: it stays unapproved, and nothing asks for it again.
  const declined = new Set(cap.status.declinedGrants ?? []);
  const denied = (i) => declined.has(i.grant);
  const missingConfig = config.filter((x) => x.value === null);

  const refresh = () => (invalidateCaps(), route());
  const authorize = async (i) => {
    try {
      await api(`/capabilities/${enc(id)}/grants/approve`, { method: "POST", body: { grant: i.grant } });
      invalidateCaps();
      const now = await api(`/capabilities/${enc(id)}`);
      toast(now.status.ready ? `${cap.name} is ready` : "Authorized");
      route();
    } catch (e) {
      fail(e);
    }
  };
  const deny = (i) =>
    api(`/capabilities/${enc(id)}/grants/decline`, { method: "POST", body: { grant: i.grant } }).then(() => (toast("Said no. It won't ask again for this version."), refresh()), fail);
  const withoutIt = (list) => openChange(c, { m: `Make it work without ${list.map((i) => `being allowed to ${i.label}`).join(", or ")}. I said no to ${list.length > 1 ? "those" : "that"}.` });
  const giveWhatItNeeds = () => grantsSheet(id).then(refresh);

  const name = h("span", {}, cap.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");

  // W2: whatever needs the owner, above the composer, each with its one action. It stays in its section too.
  const notices = [];
  const shownPending = pending.filter((i) => !denied(i));
  if (shownPending.length === 1 && oneTap(shownPending[0]) && !missingConfig.length) {
    const i = shownPending[0];
    notices.push(h("div", { class: "notice warn info-notice" }, h("span", { class: "grow row tight wrap" }, "Wants to ", grantText(i, all), i.kind === "capability" && h("span", { class: "mono faint" }, `(${i.grant.split("/").at(-1).split("@")[0]})`)), h("button", { class: "sm", onclick: () => deny(i) }, "Deny"), h("button", { class: "sm primary", onclick: () => authorize(i) }, "Authorize")));
  } else if (shownPending.length || missingConfig.length) {
    const n = shownPending.length + missingConfig.length;
    notices.push(h("div", { class: "notice warn info-notice" }, h("span", { class: "grow" }, `Needs ${plural(n, "thing")} from you before it can run`), h("button", { class: "sm primary", onclick: giveWhatItNeeds }, "Give it what it needs")));
  }
  // What the owner said no to: the tool can't run without it, so the way on is allowing it or a change that works without it.
  const saidNo = pending.filter(denied);
  if (saidNo.length === 1)
    notices.push(h("div", { class: "notice info-notice" }, h("span", { class: "grow" }, `You said no to letting it ${saidNo[0].label}. It won't run until you allow it or it changes.`), h("button", { class: "sm", onclick: () => withoutIt(saidNo) }, "Ask builder to work without it"), h("button", { class: "sm primary", onclick: () => authorize(saidNo[0]) }, "Authorize")));
  else if (saidNo.length > 1)
    notices.push(h("div", { class: "notice info-notice" }, h("span", { class: "grow" }, `You said no to ${plural(saidNo.length, "thing")} it asks for. It won't run until you allow them or it changes.`), h("button", { class: "sm", onclick: () => withoutIt(saidNo) }, "Ask builder to work without them")));
  if (c.lastBuild?.status === "failed" && !c.building)
    notices.push(h("div", { class: "notice danger info-notice" }, h("span", { class: "grow" }, "The last change didn't build. The live version is unchanged."), h("a", { class: "btn sm", href: `#/b/${enc(c.lastBuild.buildId)}` }, "Details"), h("button", { class: "sm primary", onclick: () => api(`/builds/${enc(c.lastBuild.buildId)}/retry`, { method: "POST" }).then((b) => go(`#/b/${enc(b.buildId ?? c.lastBuild.buildId)}`), fail) }, "Retry")));
  if (cap.status.retiredModel) notices.push(h("div", { class: "notice danger info-notice" }, h("span", { class: "grow" }, `${cap.status.retiredModel.model} is no longer available.`), h("button", { class: "sm primary", onclick: () => toolModelSheet(c, { replace: true }).then((ok) => ok || route()) }, "Replace…")));
  else if (cap.status.missingModel && !pending.length) notices.push(h("div", { class: "notice warn info-notice" }, h("span", { class: "grow" }, cap.status.missingModel), h("button", { class: "sm primary", onclick: giveWhatItNeeds }, "Set a model")));
  if (cap.status.missingDependencies?.length > 0) notices.push(h("div", { class: "notice danger info-notice" }, h("span", { class: "grow" }, "Depends on operations that no longer exist."), h("a", { class: "btn sm", href: changeHref(c) }, "Change it")));
  if (cap.status.unsupportedAbi) notices.push(h("div", { class: "notice danger info-notice" }, h("span", { class: "grow" }, `This version ${cap.status.unsupportedAbi}. Upgrade Hewn, or roll it back.`)));
  for (const x of mine.filter((s) => s.status === "paused" && s.pausedReason))
    notices.push(h("div", { class: "notice danger info-notice" }, h("span", { class: "grow" }, h("span", { class: "mono" }, x.operation.split("@")[0]), ` paused after ${x.failures} failures in a row`), h("button", { class: "sm primary", onclick: () => api(`/schedules/${enc(x.id)}`, { method: "PUT", body: { status: "active" } }).then(() => (toast("Resumed"), route()), fail) }, "Resume")));

  // "Change it" opens the tool with the drawer (P1) and sends the text.
  const ask = h("input", { type: "text", class: "bare", placeholder: `What should ${cap.name} also do?`, "aria-label": "Change it" });
  const composer = h(
    "form",
    { class: "card composer-card", onsubmit: (e) => (e.preventDefault(), ask.value.trim() && openChange(c, { m: ask.value.trim(), send: true })) },
    h("span", { class: "eyebrow accent" }, "Change it"),
    ask,
    h("button", { type: "submit", class: "primary lg" }, "Ask"),
  );

  // ---- the sections, each the thing itself with its actions inline ----

  // The first few operations; the rest behind Show all, so a big tool still fits on one page.
  const opRow = (op) => h("li", {}, h("div", { class: "grow" }, h("span", { class: "mono" }, op.name), op.description && h("span", { class: "sub clip-1" }, op.description)), h("button", { class: "sm", onclick: () => go(`#/run/${enc(id)}?op=${enc(op.name)}`) }, "Run"));
  let allOps = false;
  const opList = h("ul", { class: "list" });
  const drawOps = () =>
    put(
      opList,
      ops.length ? (allOps ? ops : ops.slice(0, OPS_SHOWN)).map(opRow) : h("li", {}, h("span", { class: "grow muted" }, "Nothing to run by hand.")),
      ops.length > OPS_SHOWN && h("li", { class: "list-more" }, h("button", { class: "link sm", onclick: () => ((allOps = !allOps), drawOps()) }, allOps ? "Show fewer" : `Show all ${ops.length}`)),
    );
  drawOps();
  const operations = section(`Operations · ${ops.length}`, opList, { order: 1 });

  const grantRow = (i) => {
    const isPending = pending.includes(i);
    if (i.kind === "model") return modelRow(i, isPending);
    let actions;
    if (isPending && oneTap(i)) actions = [!denied(i) && h("button", { class: "sm ghost", onclick: () => deny(i) }, "Deny"), h("button", { class: "sm primary", onclick: () => authorize(i) }, "Authorize")];
    else if (isPending) actions = h("button", { class: "sm primary", onclick: giveWhatItNeeds }, i.kind === "secret" ? "Set…" : "Authorize…");
    else if (i.kind === "secret") actions = h("button", { class: "sm ghost", onclick: (e) => replaceSecret(i, e.currentTarget) }, "Replace");
    else actions = h("button", { class: "sm ghost", onclick: () => revoke(i) }, "Revoke");
    const sub = isPending ? (denied(i) ? "You said no" : "Asked for, not allowed yet") : i.kind === "capability" ? i.grant.split("/").at(-1).split("@")[0] : i.kind === "secret" ? i.description : null;
    return h("li", {}, isPending && !denied(i) && h("span", { class: "dot warn" }), kindPill(i), h("div", { class: "grow" }, grantText(i, all), sub && h("span", { class: "sub" }, sub)), actions);
  };
  const revoke = async (i) => {
    try {
      await api(`/capabilities/${enc(id)}/grants/revoke`, { method: "POST", body: { grant: i.grant } });
      toast(`Revoked ${i.kind === "host" ? "host access" : "access"}`, { dot: "", undo: () => api(`/capabilities/${enc(id)}/grants/approve`, { method: "POST", body: { grant: i.grant } }).then(() => (toast("Restored"), refresh()), fail) });
      refresh();
    } catch (e) {
      fail(e);
    }
  };
  const replaceSecret = (i, btn) => {
    const input = h("input", { type: "password", autocomplete: "off", placeholder: "Paste new value" });
    const save = h("button", { class: "sm primary" }, "Save");
    save.addEventListener("click", async () => {
      if (!input.value) return input.focus();
      try {
        await api(`/capabilities/${enc(id)}/secrets/${enc(i.grant.slice(7))}`, { method: "PUT", body: { value: input.value } });
        toast(`Replaced ${i.grant.slice(7)}`);
        refresh();
      } catch (e) {
        fail(e);
      }
    });
    btn.closest("li").querySelector(".grow").append(h("span", { class: "row tight" }, input, save));
    btn.remove();
    input.focus();
  };
  // The model, right here: a tier or one specific model from the menu (a quick change, waited for
  // until it's live), this month's spend, and its own monthly cap. A missing key goes through the sheet.
  const modelRow = (i, isPending) => {
    const spend = m && modelSpend(m, id);
    const sub = [req.tier ? null : req.model, spend && `${spend.text(spend)} this month`].filter(Boolean).join(" · ");
    const subEl = h("span", { class: "sub" }, sub);
    let control;
    if (isPending && needsKey) control = h("button", { class: "sm primary", onclick: giveWhatItNeeds }, "Set up…");
    else if (isPending) control = [!denied(i) && h("button", { class: "sm ghost", onclick: () => deny(i) }, "Deny"), h("button", { class: "sm primary", onclick: () => authorize(i) }, "Authorize")];
    else {
      const PIN = "pin";
      const prov = m?.providers?.find((p) => p.id === m.provider);
      const current = req.tier ?? req.model;
      const select = h(
        "select",
        { class: "tier-select", "aria-label": "Model" },
        (m?.tierNames ?? TIERS).map((t) => h("option", { value: t, selected: t === req.tier }, `${titleCase(t)} tier`)),
        req.model && h("option", { value: req.model, selected: true }, req.model.split("/").at(-1)),
        // Hosted: tiers only (the host runs what each tier names).
        !m?.host && prov && h("option", { value: PIN }, "A specific model…"),
      );
      select.addEventListener("change", async () => {
        let body;
        if (select.value === PIN) {
          const picked = await modelPicker({ title: "Pin a model", sub: `${cap.name} always uses this model, whatever the tiers say.`, prov, current: req.model?.slice(prov.id.length + 1), suggested: null });
          if (!picked) return void (select.value = current);
          body = { model: `${prov.id}/${picked}` };
        } else body = { tier: select.value };
        const what = body.tier ? `the ${body.tier} tier` : body.model;
        select.disabled = true;
        subEl.textContent = `Changing to ${what}…`;
        try {
          await quickModelChange(c, body);
          toast(`${cap.name} uses ${what}`);
          refresh();
        } catch (e) {
          select.disabled = false;
          select.value = current;
          subEl.textContent = sub;
          fail(e);
        }
      });
      control = select;
    }
    const row = h("li", {}, isPending && !denied(i) && h("span", { class: "dot warn" }), kindPill(i), h("div", { class: "grow" }, h("span", {}, "Use a model"), subEl), control);
    return [row, !isPending && m && capRow()];
  };
  // Its own monthly cap, besides the one for all tools: blank is none.
  const capRow = () => {
    const capsKey = m.host ? "capabilityCapsHost" : "capabilityCapsUsd";
    const own = m[capsKey]?.[id];
    const unit = modelSpend(m, id).unit;
    const input = h("input", { type: "number", min: 0, step: 1, value: own ?? "", placeholder: "None", class: "model-cap", "aria-label": m.host ? `Monthly cap in ${unit}` : "Monthly cap in USD" });
    const save = h("button", { class: "sm", disabled: true }, "Save");
    input.addEventListener("input", () => (save.disabled = input.value.trim() === String(own ?? "")));
    save.addEventListener("click", async () => {
      const caps = { ...m[capsKey] };
      if (input.value.trim() === "") delete caps[id];
      else caps[id] = Number(input.value);
      try {
        save.disabled = true;
        await api("/models", { method: "PUT", body: { [capsKey]: caps } });
        toast(input.value.trim() === "" ? `${cap.name}: no cap of its own` : m.host ? `${cap.name}: at most ${Number(input.value)} ${unit} a month` : `${cap.name}: at most $${Number(input.value)} a month`);
        refresh();
      } catch (e) {
        save.disabled = false;
        fail(e);
      }
    });
    return h(
      "li",
      { class: "model-cap-row" },
      h("div", { class: "grow" }, h("span", {}, "Monthly cap"), h("span", { class: "sub" }, "Its own, besides the cap for all tools")),
      h("span", { class: "row tight nowrap" }, !m.host && h("span", { class: "small faint" }, "$"), input, m.host && h("span", { class: "small faint" }, unit), save),
    );
  };
  const allowed = section(
    "Allowed to",
    h(
      "ul",
      { class: "list" },
      missingConfig.map((x) => h("li", {}, h("span", { class: "dot warn" }), h("span", { class: "pill" }, "setting"), h("div", { class: "grow" }, h("span", { class: "mono" }, x.name), h("span", { class: "sub" }, x.description)), h("button", { class: "sm primary", onclick: giveWhatItNeeds }, "Set…"))),
      items.map(grantRow),
      !items.length && !missingConfig.length && h("li", {}, h("span", { class: "dot ok" }), h("span", { class: "grow muted" }, "Needs nothing outside itself")),
    ),
    { order: 2 },
  );

  const tableCount = data ? Object.keys(data.tables).length : 0;
  const dataSection = section(
    "Data",
    h(
      "ul",
      { class: "list" },
      h(
        "li",
        {},
        h("div", { class: "grow" }, h("span", {}, data ? `${plural(data.rows, "row")} · ${plural(tableCount, "table")}` : "Its data"), h("span", { class: "sub" }, !data ? "Couldn't count it right now" : data.lastWriteAt ? `Last write ${ago(data.lastWriteAt)}` : data.rows ? "No recent writes" : "Nothing written yet")),
        h("button", { class: "sm", onclick: () => download(`/api/capabilities/${enc(id)}/export`) }, "Export"),
      ),
    ),
    { order: 7 },
  );

  const runnable = ops.filter((o) => o.sideEffect !== "destructive");
  const addSchedule = () => addScheduleSheet(c, ops).then((added) => added && route());
  const schedules = section(
    "Schedules",
    h("ul", { class: "list" }, mine.length ? mine.map((x) => scheduleRow(c, x, route)) : h("li", {}, h("span", { class: "grow muted" }, runnable.length ? "Nothing runs on a timetable yet." : "Nothing it does can run on a timetable."))),
    { order: 3, action: runnable.length > 0 && h("button", { class: "link sm", onclick: addSchedule }, "+ Add schedule") },
  );

  // The widgets themselves, drawn by the platform at the size they're meant for: the one on Home,
  // else the largest it offers; S/M/L shows the others. Each on Home, or Add to Home.
  const SIZES = ["small", "medium", "large"];
  const widgetCard = (w) => {
    const onHome = home.layout.find((e) => e.type === "widget" && e.id === id && e.widget === w.name);
    let size = onHome?.size && w.sizes.includes(onHome.size) ? onHome.size : SIZES.filter((x) => w.sizes.includes(x)).at(-1);
    const preview = widgetPreview(c, id, w, { size });
    const sizes = w.sizes.length > 1 && segmented(SIZES.filter((x) => w.sizes.includes(x)).map((x) => [x, SIZE_LETTER[x]]), size, (x) => ((size = x), preview.draw(x)), { label: `${w.title} size` });
    return h(
      "div",
      { class: "info-widget" },
      preview.el,
      h("div", { class: "row tight info-widget-foot" }, onHome ? h("span", { class: "small faint grow" }, `${SIZE_LETTER[onHome.size] ?? ""} on Home`) : h("button", { class: "link sm grow", onclick: () => addWidgetSheet({ capabilityId: id, widget: w.name, onAdded: route }).then(() => route()) }, "Add to Home"), sizes),
    );
  };
  const widgetSection = section(
    widgets.length ? `Widgets · ${widgets.length}` : "Widgets",
    widgets.length ? h("div", { class: "info-widgets" }, widgets.map(widgetCard)) : h("ul", { class: "list" }, h("li", {}, h("span", { class: "grow muted" }, "None yet: a widget shows it on Home."))),
    { order: 4, action: h("button", { class: "link sm", onclick: () => openChange(c, { widget: "new" }) }, widgets.length ? "+ Another" : "+ Ask for one") },
  );

  // The owner's rules for building this tool: one per line, removed or added right here.
  const saveRules = async (next, message, undo) => {
    await api(`/capabilities/${enc(id)}/instructions`, { method: "PUT", body: { text: next.join("\n") } });
    const before = rules;
    rules = next;
    drawRules();
    toast(message, undo ? { undo: () => saveRules(before, "Restored").catch(fail) } : {});
  };
  const ruleInput = h("input", { type: "text", placeholder: "Add a rule for this tool…", "aria-label": "New rule" });
  const ruleForm = h(
    "form",
    { class: "row tight info-rule", onsubmit: (e) => (e.preventDefault(), ruleInput.value.trim() && saveRules([...rules, ruleInput.value.trim()], "Rule added").then(() => (ruleInput.value = ""), fail)) },
    ruleInput,
    h("button", { type: "submit", class: "sm" }, "Add"),
  );
  const ruleList = h("ul", { class: "list" });
  const drawRules = () => put(ruleList, rules.map((line, n) => h("li", {}, h("span", { class: "grow" }, line), h("button", { class: "sm ghost", onclick: () => saveRules(rules.filter((_, k) => k !== n), "Rule removed", true).catch(fail) }, "Remove"))));
  drawRules();
  const instructions = section("Instructions", [ruleList, ruleForm, h("div", { class: "small faint info-rule-hint" }, "The builder reads these on every change. Rules for every tool are under ", h("a", { href: "#/settings/ai" }, "Settings › AI"), ".")], { order: 5 });

  const versions = section("Versions", h("ul", { class: "list" }, cap.versions.slice(0, 2).map((v) => versionRow(c, v, version, all))), {
    order: 6,
    action: cap.versions.length > 2 && h("a", { class: "btn link sm", href: `#/c/${enc(id)}/versions` }, `All ${cap.versions.length} versions ›`),
  });

  // Every section, empty or not, each with its way to add one.
  const columns = h("div", { class: "info-sections" }, h("div", { class: "info-col" }, operations, allowed, dataSection), h("div", { class: "info-col" }, widgetSection, schedules, instructions, versions));

  const connected = [...new Set([...uses, ...usedBy])];
  view(
    backBar("Home", "#/", h("div", { class: "glass-bar" }, more)),
    sandboxNotice(),
    h(
      "main",
      { class: "column info info-page" },
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
      notices,
      composer,
      columns,
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
      { class: "column info info-page" },
      h(
        "div",
        { class: "info-head" },
        appIcon(c, { size: 64 }),
        h("div", { class: "grow col" }, h("h1", { class: "title-xl" }, name), healthLine),
        needsSetup && h("button", { class: "primary", onclick: () => grantsSheet(id).then(() => route()) }, "Set up"),
      ),
      h(
        "div",
        { class: "info-sections" },
        h(
          "div",
          { class: "info-col" },
          section(
            "Operations",
            h(
              "ul",
              { class: "list" },
              ops.filter((o) => o.name !== "health").map((op) => h("li", {}, h("div", { class: "grow" }, h("span", { class: "mono" }, op.name), h("span", { class: "sub" }, op.description)), sidePill(op.sideEffect), h("button", { class: "sm", onclick: () => go(`#/run/${enc(id)}?op=${enc(op.name)}`) }, "Run"))),
              healthRow,
            ),
            { order: 1 },
          ),
        ),
        h(
          "div",
          { class: "info-col" },
          section("Used by", cap.usedBy?.length ? h("div", { class: "row tight wrap info-used-by" }, cap.usedBy.map((u) => chip(all.get(u.id) ?? { id: u.id, name: u.name }, undefined, { href: `#/c/${enc(u.id)}` }))) : h("div", { class: "muted small info-used-by" }, "Nothing yet"), { order: 2 }),
          (signIn || inputs.length > 0) &&
            section(
              "Settings",
              [
                signIn && h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, "Sign-in"), h("span", { class: "sub" }, cap.status.missingSecrets.length ? "Not signed in" : "Signed in")), h("button", { class: cap.status.missingSecrets.length ? "sm primary" : "sm", onclick: () => signInDialog(id).then((ok) => ok && route()) }, cap.status.missingSecrets.length ? "Sign in" : "Sign in again")),
                inputs.map(({ x, input }) => h("div", { class: "setting stacked" }, h("div", { class: "grow" }, h("span", { class: "mono" }, x.name), h("span", { class: "sub" }, x.description)), input)),
                inputs.length > 0 && h("div", { class: "row end settings-save" }, save),
              ],
              { order: 3 },
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
