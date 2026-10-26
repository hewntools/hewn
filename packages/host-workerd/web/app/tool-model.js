// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's model: a tier or a pinned model, and its own cap.
import { api, appIcon, enc, fail, h, modal, sheetActions, sheetHead, toast } from "../kit.js";
import { go } from "./frame.js";
import { perCall, tierModel, TIERS } from "./grants.js";
import { pollInbox } from "./inbox.js";
import { modelPicker, TIER_TEXT, titleCase, usd } from "./models.js";

export { modelSpend, toolModelSheet };

// ---------- J3: a tool's model (tier or a pinned model, and its own cap) ----------

/** This month's spend on a tool's model calls: dollars, or (hosted) the host's unit. */
function modelSpend(m, id) {
  const rows = m.spend.rows.filter((r) => r.capabilityId === id);
  const hostUsed = m.host?.charges.byCapability.filter((x) => x.capabilityId === id) ?? [];
  const unit = hostUsed[0]?.unit ?? m.host?.charges.totals[0]?.unit ?? "Credits";
  return {
    spent: rows.reduce((n, r) => n + r.costUsd, 0),
    calls: rows.reduce((n, r) => n + r.calls, 0),
    unit,
    used: Math.round(hostUsed.reduce((n, x) => n + x.amount, 0) * 100) / 100,
    text: (x) => (m.host ? `${x.used} ${x.unit}` : usd(x.spent)),
  };
}

/**
 * J3 One Picker for a tool's model: a tier (it follows Models) or one specific model, and this
 * month's spend with its own cap. A change is a quick change (a new version, no builder).
 */
async function toolModelSheet(c, { replace = false } = {}) {
  const [cap, m] = await Promise.all([api(`/capabilities/${enc(c.id)}`), api("/models")]);
  // Hosted: the tiers are the host's (labels from its model list), and the cap is in its unit.
  const hostTiers = m.host ? (await api("/tools/remote/models").catch(() => null))?.tiers ?? {} : null;
  const req = cap.requires?.model;
  if (!req) return fail(new Error(`${c.name} doesn't use a model`));
  const prov = m.providers.find((p) => p.id === m.provider);
  let pinned = req.model ?? null;
  let tier = req.tier ?? null;
  const retired = cap.status.retiredModel;
  const { spent, calls, unit, used } = modelSpend(m, c.id);
  return modal(
    (close) => {
      const ok = h("button", { class: "primary" }, "Save");
      const pickLine = h("span", { class: "sub" });
      const modelChanged = () => (pinned ? pinned !== req.model : tier !== req.tier);
      const capChanged = () => capInput.value.trim() !== String(own ?? "");
      // One Save for both: the cap (a setting) and the model (a quick change: a new version, no builder).
      const sync = () => {
        ok.disabled = !modelChanged() && !capChanged();
        pickLine.textContent = pinned ? `${pinned}${retired && pinned === req.model ? " · no longer available" : ""}` : "Pin one model";
      };
      const radio = (checked, onChange) => {
        const r = h("input", { type: "radio", name: "cap-model", checked });
        r.addEventListener("change", onChange);
        return r;
      };
      const tierRadios = {};
      const tierRows = (m.tierNames ?? TIERS).map((t) => {
        const x = tierModel(m, t);
        tierRadios[t] = radio(!pinned && tier === t, () => ((tier = t), (pinned = null), sync()));
        if (hostTiers) return h("label", { class: "job-option" }, tierRadios[t], h("span", { class: "grow col" }, h("span", {}, `${titleCase(t)} tier`), h("span", { class: "sub" }, hostTiers[t] ?? TIER_TEXT[t])));
        return h("label", { class: "job-option" }, tierRadios[t], h("span", { class: "grow col" }, h("span", {}, `${titleCase(t)} tier`), h("span", { class: "sub" }, x ? `${x.name}${x.price ? ` · about ${usd(perCall(x.price))} a call` : ""}` : "Not set up")));
      });
      const pickModel = async () => {
        const p = pinned ? m.providers.find((x) => pinned.startsWith(`${x.id}/`)) ?? prov : prov;
        const successor = retired?.successor?.slice((p?.id.length ?? 0) + 1);
        const id = p ? await modelPicker({ title: replace ? `Replace ${req.model}` : "Pin a model", sub: `${c.name} always uses this model, whatever the tiers say.`, prov: p, current: pinned?.slice(p.id.length + 1), suggested: successor ?? null }) : null;
        if (id) pinned = `${p.id}/${id}`;
        else if (!pinned && tier) tierRadios[tier].checked = true;
        sync();
      };
      const specific = h("label", { class: "job-option" }, radio(!!pinned, pickModel), h("span", { class: "grow col" }, h("span", {}, "A specific model"), pickLine));
      // This month: what it spent, and its own cap (inline).
      // Hosted: in the host's unit, from what it charged this tool's model calls.
      const capsKey = m.host ? "capabilityCapsHost" : "capabilityCapsUsd";
      const own = m[capsKey][c.id];
      const capInput = h("input", { type: "number", min: 0, step: 1, value: own ?? "", placeholder: "No cap", class: "model-cap", "aria-label": m.host ? `Cap in ${unit} a month` : "Cap in USD a month" });
      capInput.addEventListener("input", () => sync());
      const saveCap = async () => {
        const caps = { ...m[capsKey] };
        if (capInput.value.trim() === "") delete caps[c.id];
        else caps[c.id] = Number(capInput.value);
        await api("/models", { method: "PUT", body: { [capsKey]: caps } });
        toast(capInput.value.trim() === "" ? `${c.name}: no cap of its own` : m.host ? `${c.name}: at most ${Number(capInput.value)} ${unit} a month` : `${c.name}: at most $${Number(capInput.value)} a month`);
        pollInbox();
      };
      ok.addEventListener("click", async () => {
        try {
          ok.disabled = true;
          if (capChanged()) await saveCap();
          if (!modelChanged()) return close(true);
          const b = await api(`/capabilities/${enc(c.id)}/model`, { method: "POST", body: pinned ? { model: pinned } : { tier } });
          close(true);
          go(`#/b/${enc(b.buildId)}`);
        } catch (e) {
          ok.disabled = false;
          fail(e);
        }
      });
      sync();
      if (replace && retired) setTimeout(pickModel);
      return [
        sheetHead(appIcon(c, { size: 44 }), `${c.name} · model`, retired ? `${retired.model} is no longer available` : null),
        // Hosted: tiers only (the host runs what each tier names).
        h("fieldset", { class: "job" }, tierRows, !m.host && specific),
        h(
          "div",
          { class: "inset-block row between" },
          h("div", { class: "col" }, h("span", { class: "eyebrow" }, "This month"), h("span", {}, m.host ? `${used} ${unit} · ${calls ? `${calls} call${calls === 1 ? "" : "s"}` : "no calls yet"}` : `${usd(spent)} · ${calls ? `${calls} call${calls === 1 ? "" : "s"}` : "no calls yet"}`)),
          h("span", { class: "row tight nowrap" }, h("span", { class: "small faint" }, m.host ? "Cap" : "Cap $"), capInput, m.host && h("span", { class: "small faint" }, unit)),
        ),
        sheetActions(h("button", { onclick: () => close(false) }, "Cancel"), ok),
      ];
    },
    { width: 480 },
  );
}
