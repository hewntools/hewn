// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings › AI › Models: providers and keys, tiers, prices, this month's spend and its cap.
import { ago, api, appIcon, capRef, caps, fail, formSheet, h, kindTag, modal, sheetActions, sheetHead, toast } from "../kit.js";
import { providerTile } from "./agents.js";
import { put, stillHere } from "./frame.js";
import { pollInbox } from "./inbox.js";
import { route } from "./router.js";
import { settingsFrame } from "./settings.js";
import { toolModelSheet } from "./tool-model.js";

export { creditWords, modelPicker, modelsPage, PROVIDERS, TIER_TEXT, titleCase, usd };

// ---------- J1 Settings › AI › Models ----------

const PROVIDERS = {
  anthropic: { label: "Anthropic", sub: "Claude models", keys: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI", sub: "GPT models", keys: "https://platform.openai.com/api-keys" },
  openrouter: { label: "OpenRouter", sub: "Many vendors with one key", keys: "https://openrouter.ai/keys" },
};
const TIER_TEXT = { light: "Quick, cheap work: tags, short explanations", standard: "Most work", strong: "Harder reasoning", max: "The most capable" };
const usd = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0");
const perM = (p) => `${usd(p.input * 1e6)} / ${usd(p.output * 1e6)}`;
const titleCase = (t) => t[0].toUpperCase() + t.slice(1);
const modelLabel = (prov, id) => prov.models.find((x) => x.id === id)?.name ?? id;

/** O8 A provider's key: a Form that checks it (no tokens spent). Resolves the new /models, or null. */
function keySheet(m, providerId, { use = false } = {}) {
  return formSheet({
    title: `${PROVIDERS[providerId].label} API key`,
    sub: "Tools call models with it, metered; they never see it.",
    build: (close) => {
      const key = h("input", { type: "password", autocomplete: "off", placeholder: "Paste API key", "aria-label": "API key" });
      const save = h("button", { class: "primary" }, "Check and save");
      const submit = async () => {
        if (!key.value.trim()) return key.focus();
        save.disabled = true;
        try {
          let next = await api(`/models/keys/${providerId}`, { method: "PUT", body: { key: key.value.trim() } });
          if (use && next.provider !== providerId) next = await api("/models", { method: "PUT", body: { provider: providerId } });
          toast(`${PROVIDERS[providerId].label} key works`);
          close(next);
        } catch (e) {
          save.disabled = false;
          fail(e);
        }
      };
      save.addEventListener("click", submit);
      key.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      setTimeout(() => key.focus());
      return [
        h("label", { class: "field" }, h("span", { class: "label" }, "Key"), key, h("span", { class: "hint" }, "Get one at ", h("a", { href: PROVIDERS[providerId].keys, target: "_blank", rel: "noopener noreferrer" }, PROVIDERS[providerId].keys.replace(/^https:\/\//, "")))),
        sheetActions(h("button", { onclick: () => close(null) }, "Cancel"), save),
      ];
    },
  });
}

/** Pick one of a provider's models (search, price, images, the suggested one marked). Resolves the id or null. */
function modelPicker({ title, sub, prov, current, suggested }) {
  const search = h("input", { type: "search", placeholder: "Search models", "aria-label": "Search models" });
  const list = h("div", { class: "model-list" });
  return modal(
    (close) => {
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const rows = prov.models.filter((x) => !q || x.id.toLowerCase().includes(q) || (x.name ?? "").toLowerCase().includes(q));
        put(
          list,
          rows.slice(0, 200).map((x) =>
            h(
              "button",
              { class: `model-row ${x.id === current ? "current" : ""}`, onclick: () => close(x.id) },
              h("span", { class: "grow col" }, h("span", {}, x.name ?? x.id, x.id === suggested && h("span", { class: "pill accent model-badge" }, "suggested")), h("span", { class: "sub mono" }, x.id)),
              h("span", { class: "col model-meta" }, h("span", { class: "small" }, x.price ? perM(x.price) : "no price"), h("span", { class: "sub" }, x.images ? "text · images" : x.images === false ? "text only" : "")),
            ),
          ),
          !rows.length && h("div", { class: "muted small" }, "No models match."),
        );
      };
      search.addEventListener("input", render);
      render();
      setTimeout(() => search.focus());
      return [sheetHead(null, title, sub), search, list, sheetActions(h("button", { onclick: () => close(null) }, "Cancel"))];
    },
    { width: 520 },
  );
}

/** Choose the model for one tier from what the active provider's key can use. */
async function tierPicker(m, tier) {
  const prov = m.providers.find((p) => p.id === m.provider);
  const id = await modelPicker({ title: `${titleCase(tier)} tier`, sub: `${TIER_TEXT[tier]}. Price per million tokens in / out.`, prov, current: prov.tiers[tier], suggested: prov.suggested.tiers[tier] });
  if (!id) return null;
  try {
    const next = await api("/models", { method: "PUT", body: { tiers: { [prov.id]: { [tier]: id } } } });
    toast(`${titleCase(tier)}: ${modelLabel(prov, id)}`);
    return next;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** An owner-set price for a model the catalog doesn't price. */
function priceDialog(m, model) {
  const cur = m.prices[model];
  const input = h("input", { type: "number", min: 0, step: "0.01", value: cur ? cur.input * 1e6 : "", "aria-label": "Input price" });
  const output = h("input", { type: "number", min: 0, step: "0.01", value: cur ? cur.output * 1e6 : "", "aria-label": "Output price" });
  return formSheet({
    title: "Set a price",
    sub: model,
    build: (close) => [
      h("label", { class: "field" }, h("span", { class: "label" }, "Input, USD per million tokens"), input),
      h("label", { class: "field" }, h("span", { class: "label" }, "Output, USD per million tokens"), output),
      sheetActions(
        h("button", { onclick: () => close(null) }, "Cancel"),
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              try {
                const prices = Object.fromEntries(Object.entries(m.prices).map(([k, v]) => [k, { input: v.input * 1e6, output: v.output * 1e6 }]));
                prices[model] = { input: Number(input.value), output: Number(output.value) };
                close(await api("/models", { method: "PUT", body: { prices } }));
                toast("Price saved");
              } catch (e) {
                fail(e);
              }
            },
          },
          "Save",
        ),
      ),
    ],
  });
}

/** The monthly cap for all tools that use a model. */
function capSheet(m) {
  return formSheet({
    title: "Monthly cap",
    sub: "Calls that could go over it are refused before they're made.",
    build: (close) => {
      const input = h("input", { type: "number", min: 0, step: 1, value: m.monthlyCapUsd, "aria-label": "Monthly cap in USD" });
      setTimeout(() => input.focus());
      return [
        h("label", { class: "field" }, h("span", { class: "label" }, "USD a month"), input),
        sheetActions(
          h("button", { onclick: () => close(null) }, "Cancel"),
          h("button", { class: "primary", onclick: () => api("/models", { method: "PUT", body: { monthlyCapUsd: Number(input.value) } }).then((next) => (toast(`Monthly cap: $${Number(input.value)}`), pollInbox(), close(next)), fail) }, "Save"),
        ),
      ];
    },
  });
}

/** A meter of blocks: `on` of `n` lit (warn once it passes 80%). */
const meter = (n, on, warn) => h("div", { class: `blocks ${warn ? "warn" : ""}`, style: { "--cols": n }, role: "meter", "aria-valuemin": 0, "aria-valuemax": n, "aria-valuenow": on }, Array.from({ length: n }, (_, i) => h("i", { class: i < on ? "on" : "" })));

/**
 * J1 Models: this month's spend first (you check it monthly), then the providers (in use, key
 * saved, no key), then the tiers. Pinned models only when a tool has one; caps per tool are on each
 * tool's model sheet (J3).
 */
/** "12.37 Credits": a host's charge as given (2 decimals at most). */
const creditWords = (t) => `${Math.round(t.amount * 100) / 100} ${t.unit}`;
const CHARGE_KINDS = { build: "builds", intake: "talking requests through", model: "tools that think" };

/**
 * Hosted: tools' model calls run on the host's models and count in its unit (Credits). No
 * providers, keys or USD caps: what each tier runs on, and what was used this month.
 */
async function hostedModelsPage(m, all) {
  const here = stillHere();
  const catalog = await api(`/tools/remote/models`).catch(() => null);
  const back = h("a", { class: "link back-inline", href: "#/settings/ai" }, "‹ AI");
  const { totals, rows } = m.host.charges;
  const tierRow = (tier) => {
    const users = m.usage[tier] ?? [];
    return h(
      "div",
      { class: "setting tier-row" },
      h("div", { class: "tier-name strong" }, titleCase(tier)),
      h("div", { class: "grow" }, h("span", {}, catalog?.tiers?.[tier] ?? "Picked for you"), h("span", { class: "sub" }, [TIER_TEXT[tier], users.length ? `used by ${users.map((u) => u.name).join(", ")}` : null].filter(Boolean).join(" · "))),
    );
  };
  if (!here()) return;
  settingsFrame(
    "ai",
    h("div", { class: "row tight baseline" }, back, h("h1", { class: "flush" }, "Models")),
    h(
      "div",
      { class: "card stack-sm month-card" },
      h("span", { class: "eyebrow" }, "This month"),
      totals.length ? totals.map((t) => h("div", { class: "row tight baseline" }, h("span", { class: "big-figure" }, creditWords(t)), h("span", { class: "muted" }, "used"))) : h("div", { class: "muted" }, "Nothing used yet"),
      rows.length > 0 && h("div", { class: "small muted" }, rows.map((r) => `${creditWords(r)} on ${CHARGE_KINDS[r.kind] ?? r.kind}`).join(" · ")),
    ),
    h("div", { class: "card settings-card" }, h("div", { class: "eyebrow card-eyebrow" }, "Tiers"), m.tierNames.map(tierRow)),
    m.pinned.length > 0 &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Pinned models"),
        m.pinned.map((c) => h("div", { class: "setting" }, appIcon(all.get(c.id) ?? c, { size: 28 }), h("div", { class: "grow" }, h("span", {}, c.name), h("span", { class: "sub mono" }, c.model)))),
      ),
  );
}

async function modelsPage() {
  const here = stillHere();
  const [m, all] = await Promise.all([api("/models"), caps().catch(() => new Map())]);
  if (!here()) return;
  if (m.host) return hostedModelsPage(m, all);
  const reload = (next) => next && route();
  const back = h("a", { class: "link back-inline", href: "#/settings/ai" }, "‹ AI");
  const spend = m.spend;
  const pct = spend.capUsd > 0 ? Math.min(1, spend.totalUsd / spend.capUsd) : 1;
  const prov = m.providers.find((p) => p.id === m.provider);
  const providerRow = (p) => {
    const inUse = p.id === m.provider;
    const status = !p.keySet ? "No key" : p.check?.ok ? `${inUse ? "In use · " : ""}key works` : p.check?.error ?? "Key saved";
    const checkBtn = p.keySet && p.check && !p.check.ok && h("button", { class: "sm ghost", onclick: () => api(`/models/check/${p.id}`, { method: "POST" }).then(() => route(), fail) }, "Check again");
    return h(
      "div",
      { class: "setting" },
      providerTile(p.id, 32),
      h("div", { class: "grow" }, h("span", { class: inUse ? "strong" : "" }, PROVIDERS[p.id].label), h("span", { class: `sub ${p.keySet && p.check && !p.check.ok ? "danger-text" : ""}` }, inUse && p.check?.ok && h("span", { class: "dot ok" }), ` ${status}`)),
      checkBtn,
      inUse
        ? kindTag("in use", "ok")
        : p.keySet
          ? h("button", { class: "sm", onclick: () => api("/models", { method: "PUT", body: { provider: p.id } }).then(() => (toast(`Now using ${PROVIDERS[p.id].label}`), route()), fail) }, "Use")
          : h("button", { class: "sm", onclick: () => keySheet(m, p.id, { use: !m.provider }).then(reload) }, "Add key"),
    );
  };
  const tierRow = (tier) => {
    const id = prov?.tiers[tier];
    const x = id && prov.models.find((y) => y.id === id);
    const price = x?.price ?? (id && m.prices[`${prov.id}/${id}`]);
    const users = m.usage[tier] ?? [];
    return h(
      "div",
      { class: "setting tier-row" },
      h("div", { class: "tier-name strong" }, titleCase(tier)),
      h(
        "div",
        { class: "grow" },
        h("span", {}, id ? modelLabel(prov, id) : "Not set"),
        h("span", { class: "sub row tight wrap" }, [price ? `${perM(price)} per M` : id ? "no price known" : TIER_TEXT[tier], users.length ? `used by ${users.length}` : null].filter(Boolean).join(" · "), users.length > 0 && users.slice(0, 3).map((u) => capRef(all.get(u.id), u.id, { size: 16 }))),
        id && !price && h("button", { class: "link sm self-start", onclick: () => priceDialog(m, `${prov.id}/${id}`).then(reload) }, "Set price…"),
      ),
      prov && h("button", { class: "ghost sm", onclick: () => tierPicker(m, tier).then(reload) }, "Change"),
    );
  };
  const differs = prov && Object.keys(prov.suggested.tiers).length && m.tierNames.some((t) => (prov.tiers[t] ?? null) !== (prov.suggested.tiers[t] ?? null));
  const reset = () =>
    api("/models", { method: "PUT", body: { tiers: { [prov.id]: Object.fromEntries(m.tierNames.map((t) => [t, prov.suggested.tiers[t] ?? null])) } } }).then(() => (toast("Tiers reset to the suggestion"), route()), fail);
  const refreshBtn = h("button", { class: "link sm" }, "Refresh");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    const r = await api("/models/catalog", { method: "POST" }).catch((e) => ({ error: e.message }));
    if (r.error) fail(new Error(r.error));
    route();
  });
  settingsFrame(
    "ai",
    h("div", { class: "row tight baseline" }, back, h("h1", { class: "flush" }, "Models")),
    h(
      "div",
      { class: "card stack-sm month-card" },
      h("div", { class: "row between" }, h("span", { class: "eyebrow" }, "This month"), h("button", { class: "link sm", onclick: () => capSheet(m).then(reload) }, "Change cap")),
      h("div", { class: "row tight baseline" }, h("span", { class: "big-figure" }, usd(spend.totalUsd)), h("span", { class: "muted" }, `of ${usd(spend.capUsd)}`)),
      meter(40, Math.round(pct * 40), pct >= 0.8),
    ),
    h("div", { class: "card settings-card" }, m.providers.map(providerRow)),
    prov &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "row between card-eyebrow" }, h("span", { class: "eyebrow" }, "Tiers"), differs ? h("button", { class: "link sm", onclick: reset }, "Use suggested") : null),
        m.tierNames.map(tierRow),
      ),
    m.pinned.length > 0 &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Pinned models"),
        m.pinned.map((c) => h("div", { class: "setting" }, appIcon(all.get(c.id) ?? c, { size: 28 }), h("div", { class: "grow" }, h("span", {}, c.name), h("span", { class: `sub ${c.retired ? "danger-text" : ""}` }, c.retired ? `${c.model} is no longer available` : `${c.model}${c.problem ? ` · ${c.problem}` : ""}`)), h("button", { class: c.retired ? "sm primary" : "sm", onclick: () => toolModelSheet(all.get(c.id) ?? c, { replace: !!c.retired }) }, c.retired ? "Replace…" : "Change"))),
      ),
    h("div", { class: "small faint row tight" }, h("span", {}, m.catalog.error ?? (m.catalog.fetchedAt ? `Prices from OpenRouter's model list · updated ${ago(m.catalog.fetchedAt)}` : "Prices not loaded yet")), refreshBtn),
  );
}
