// SPDX-License-Identifier: AGPL-3.0-or-later
// Schedules: a tool's, and the one an agent proposes.
import { actorLabel, ago, api, appIcon, capRef, caps, enc, fail, h, kindTag, modal, requestSheet, sheetActions, sheetHead, toast } from "../kit.js";
import { browserZone, put, settings } from "./frame.js";
import { pollInbox } from "./inbox.js";
import { titleCase } from "./models.js";
import { askFixLatest } from "./tool-actions.js";
import { sidePill } from "./tool.js";
import { segmented } from "./widgets.js";

export { addScheduleSheet, cadenceText, proposalSheet, runFailure, scheduleRow, schedulesSheet };

// ---------- K: schedules ----------

/** "daily 07:00" → "Daily 07:00", "weekly mon 07:00" → "Weekly Mon 07:00"; cron stays as it is. */
const cadenceText = (c = "") => c.replace(/^(hourly|daily|weekly)\b/, (w) => titleCase(w)).replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/, (d) => titleCase(d));
/** "in 3 h", "in 12 min", "tomorrow": how far off a run is. */
const inFuture = (iso) => {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "tomorrow" : `in ${d} days`;
};

/** Text kept to two lines, with a caret that shows all of it (long text only). */
function expandable(text, cls = "") {
  const body = h("span", { class: "clamp-2" }, text);
  if (text.length <= 90) return h("span", { class: cls }, text);
  const caret = h("button", { type: "button", class: "caret-btn", "aria-expanded": "false", "aria-label": "Show the whole message" });
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = caret.getAttribute("aria-expanded") !== "true";
    caret.setAttribute("aria-expanded", String(open));
    caret.setAttribute("aria-label", open ? "Show less" : "Show the whole message");
    body.classList.toggle("clamp-2", !open);
  });
  return h("span", { class: `${cls} expandable` }, body, caret);
}

/** "operation_failed: fetch_tonight@1 failed: NOAA is unreachable" → "NOAA is unreachable". */
const runFailure = (outcome, operation) => String(outcome).replace(/^\w+: /, "").replace(new RegExp(`^${operation.split("@")[0]}(@\\d+)? failed: `), "");

/**
 * One schedule as a row: a switch with its next run (a proposed one offers Enable; one paused after
 * failures says why and offers Resume), why the last run failed with Ask builder to fix this, and ×.
 * `after` redraws once something changed; `leave` runs before the fix opens the drawer.
 */
function scheduleRow(c, x, after, leave = () => {}) {
  const act = (body, message) => async () => {
    try {
      await api(`/schedules/${enc(x.id)}`, body ? { method: "PUT", body } : { method: "DELETE" });
      toast(message);
      after();
    } catch (e) {
      fail(e);
    }
  };
  const sw = h("input", { type: "checkbox", class: "switch", checked: x.status === "active", "aria-label": "On" });
  sw.addEventListener("change", () => act({ status: sw.checked ? "active" : "paused" }, sw.checked ? "Schedule on" : "Schedule paused")());
  const failed = x.lastRunAt && x.lastOutcome && x.lastOutcome !== "ok";
  const sub =
    x.status === "proposed"
      ? h("span", { class: "sub" }, `${cadenceText(x.cadence)} · proposed by ${actorLabel(x.createdBy)}`)
      : x.status === "paused"
        ? h("span", { class: `sub ${x.pausedReason ? "danger-text" : ""}` }, x.pausedReason ? `${cadenceText(x.cadence)} · paused after ${x.failures} failures in a row` : `${cadenceText(x.cadence)} · paused`)
        : h("span", { class: "sub" }, `${cadenceText(x.cadence)}${x.nextRunAt ? ` · next ${inFuture(x.nextRunAt)}` : ""}`);
  // Why the last run failed, and when: the tool's own words, without the call's prefixes.
  const why = failed && expandable(`Last run ${ago(x.lastRunAt)} failed: ${runFailure(x.lastOutcome, x.operation)}`, "sub danger-text");
  const fix = failed && h("button", { class: "link sm", type: "button", onclick: () => (leave(), askFixLatest(c, (f) => f.caller === `schedule:${x.id}`, { caller: `schedule:${x.id}`, operation: x.operation, error: runFailure(x.lastOutcome, x.operation), input: JSON.stringify(x.input ?? {}) }).catch(fail)) }, "Ask builder to fix this");
  // Try again: one run now, as the schedule runs, to see if it was a passing problem or a fix worked.
  const retry =
    failed &&
    h("button", {
      class: "link sm",
      type: "button",
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = "Running…";
        try {
          const r = await api(`/schedules/${enc(x.id)}/run`, { method: "POST" });
          toast(r.ok ? `${x.operation.split("@")[0]} ran without an error` : `Failed again: ${runFailure(r.outcome, x.operation)}`, r.ok ? {} : { dot: "danger" });
          after();
        } catch (err) {
          b.disabled = false;
          b.textContent = "Try again";
          fail(err);
        }
      },
    }, "Try again");
  return h(
    "li",
    {},
    h("div", { class: "grow" }, h("span", { class: "mono" }, x.operation.split("@")[0]), sub, why, failed && h("div", { class: "row tight schedule-fixes" }, retry, fix)),
    x.status === "proposed" ? h("button", { class: "sm primary", onclick: act({ status: "active" }, "Schedule enabled") }, "Enable") : x.status === "paused" && x.pausedReason ? h("button", { class: "sm", onclick: act({ status: "active" }, "Resumed") }, "Resume") : sw,
    h("button", { class: "ghost sm icon-only", "aria-label": "Delete schedule", onclick: act(null, "Schedule deleted") }, "×"),
  );
}

/** K2 New schedule: an operation, a preset cadence (or cron), a time in the owner's zone. `add` posts it. */
function newScheduleForm(c, runnable, onAdded) {
  const zone = settings?.timeZone ?? browserZone();
  const op = h("select", { "aria-label": "Operation" }, runnable.map((o) => h("option", { value: o.name }, o.name)));
  let kind = "daily";
  const time = h("input", { type: "time", value: "07:00", class: "time-input", "aria-label": "At" });
  const day = h("select", { "aria-label": "Day", class: "day-select" }, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => h("option", { value: d }, titleCase(d))));
  const cron = h("input", { type: "text", class: "code", placeholder: "0 7 * * 1-5", "aria-label": "Cron" });
  const when = h("div", { class: "row tight" });
  const drawWhen = () => put(when, kind === "hourly" ? null : kind === "custom" ? cron : [kind === "weekly" && day, time], h("span", { class: "small faint" }, `${zone} · your time zone`));
  const cadence = () => (kind === "hourly" ? "hourly" : kind === "custom" ? cron.value.trim() : kind === "weekly" ? `weekly ${day.value} ${time.value}` : `daily ${time.value}`);
  drawWhen();
  const add = h("button", { class: "primary" }, "Add schedule");
  add.addEventListener("click", async () => {
    try {
      add.disabled = true;
      await api("/schedules", { method: "POST", body: { capabilityId: c.id, operation: op.value, cadence: cadence() } });
      toast(`Scheduled ${op.value}: ${cadenceText(cadence())}`);
      onAdded();
    } catch (e) {
      fail(e);
    } finally {
      add.disabled = false;
    }
  });
  const fields = [op, segmented([["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["custom", "Custom"]], kind, (k) => ((kind = k), drawWhen()), { label: "Cadence" }), when];
  return { fields, add };
}

/**
 * K1 + K2 Schedules for one tool (from the Inbox): each schedule a row, then a New schedule block
 * with preset cadences in the owner's time zone.
 */
async function schedulesSheet(c, ops) {
  const runnable = ops.filter((o) => o.sideEffect !== "destructive");
  return modal(
    (close) => {
      const list = h("ul", { class: "list" });
      const render = async () => {
        const all = (await api("/schedules").catch(() => [])).filter((x) => x.capabilityId === c.id);
        put(list, all.length ? all.map((x) => scheduleRow(c, x, render, () => close?.())) : h("li", {}, h("span", { class: "grow muted" }, "Nothing runs on a timetable.")));
      };
      render();
      if (!runnable.length) return [sheetHead(appIcon(c, { size: 44 }), `Schedules · ${c.name}`), list, sheetActions(h("button", { onclick: () => close() }, "Done"))];
      const form = newScheduleForm(c, runnable, render);
      return [sheetHead(appIcon(c, { size: 44 }), `Schedules · ${c.name}`), list, h("div", { class: "inset-block stack-sm" }, h("div", { class: "eyebrow" }, "New schedule"), form.fields), sheetActions(h("button", { onclick: () => close() }, "Done"), form.add)];
    },
    { width: 480 },
  );
}

/** Info › Schedules › + Add schedule: the one sheet Info opens to add. Resolves true once one is added. */
function addScheduleSheet(c, ops) {
  const runnable = ops.filter((o) => o.sideEffect !== "destructive");
  return modal(
    (close) => {
      const form = newScheduleForm(c, runnable, () => close(true));
      return [sheetHead(appIcon(c, { size: 44 }), `New schedule · ${c.name}`), h("div", { class: "stack-sm" }, form.fields), sheetActions(h("button", { onclick: () => close(false) }, "Cancel"), form.add)];
    },
    { width: 440 },
  );
}

/** K3 An agent's proposed schedule, as a Request: what would run and when; Decline or Enable. */
async function proposalSheet(x) {
  const all = await caps().catch(() => new Map());
  const c = all.get(x.capabilityId) ?? { id: x.capabilityId, name: x.capabilityId };
  const cap = await api(`/capabilities/${enc(x.capabilityId)}`).catch(() => null);
  const [opName] = x.operation.split("@");
  const op = cap?.operations.find((o) => o.name === opName);
  const who = actorLabel(x.createdBy, all);
  const when = /^(hourly|daily|weekly)/.test(x.cadence) ? cadenceText(x.cadence).replace(/^(Daily|Weekly)( \w{3})? (\d\d:\d\d)$/, (_, w, d, t) => `${w.toLowerCase()}${d ?? ""} at ${t}`).replace(/^Hourly$/, "every hour") : `on “${x.cadence}”`;
  return requestSheet({
    icon: appIcon(c, { size: 48 }),
    title: `${who} wants to run ${opName} ${when}`,
    sub: `It runs as you, with what ${c.name} is already allowed to do`,
    quote: x.note,
    rows: [{ pill: op ? sidePill(op.sideEffect) : kindTag("run"), main: capRef(c, x.capabilityId), sub: `${opName} · ${cadenceText(x.cadence)}${x.input && Object.keys(x.input).length ? ` · ${JSON.stringify(x.input)}` : ""}`, mono: false }],
    decline: "Decline",
    accept: "Enable",
    onAccept: async (close) => {
      await api(`/schedules/${enc(x.id)}`, { method: "PUT", body: { status: "active" } });
      toast(`Scheduled ${opName}: ${cadenceText(x.cadence)}`);
      close(true);
    },
    onDecline: async (close) => {
      await api(`/schedules/${enc(x.id)}`, { method: "DELETE" });
      toast("Declined the schedule");
      close(false);
    },
  }).then((r) => (pollInbox(), r));
}
