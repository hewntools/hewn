// SPDX-License-Identifier: AGPL-3.0-or-later
// The grants sheet (what a tool may do, to authorize or revoke), and signing in to a connection.
import { actorLabel, api, appIcon, capRef, caps, enc, fail, h, invalidateCaps, kindTag, modal, requestRows, sheetActions, sheetHead, sheetSteps, toast } from "../kit.js";
import { HEALTH } from "./accounts.js";
import { put } from "./frame.js";
import { PROVIDERS, titleCase, usd } from "./models.js";
import { changeHref } from "./tool-actions.js";
import { quickModelChange } from "./tool-model.js";

export { grantsSheet, grantText, kindPill, perCall, signInDialog, tierModel, TIERS };

// ---------- D1 / D2 / O4: the grants sheet (a Request; approved, the same rows with Revoke) ----------

/** Capability-ref text for an authorization item: "Write to <Running Log>", "Reach host", "SECRET". */
function grantText(i, all) {
  if (i.kind === "capability") {
    const verb = i.sideEffect === "read" ? "Read" : i.sideEffect === "destructive" ? "Change" : i.sideEffect === "missing" ? "Use" : "Write to";
    return h("span", { class: "row tight wrap" }, `${verb} `, capRef(all.get(i.target), i.target));
  }
  if (i.kind === "host") return h("span", {}, `Reach ${i.grant.slice(5)}`);
  if (i.kind === "model") return h("span", {}, "Use a model");
  return h("span", { class: "mono" }, i.grant.slice(7));
}
const kindPill = (i) =>
  i.kind === "capability"
    ? kindTag(i.sideEffect === "read" ? "read" : i.sideEffect === "missing" ? "missing" : "write", i.sideEffect === "read" ? "" : i.sideEffect === "missing" ? "danger" : "accent")
    : kindTag(i.kind, i.kind === "model" ? "accent" : "");

const TIERS = ["light", "standard", "strong", "max"];
/** About what one call costs on a model: a typical 1,500 tokens in and 500 out. */
const perCall = (price) => price && price.input * 1500 + price.output * 500;
const tierModel = (m, tier) => {
  const prov = m?.providers.find((p) => p.id === m.provider);
  const id = prov?.tiers[tier];
  const x = id && prov.models.find((y) => y.id === id);
  return id ? { prov, id, name: x?.name ?? id, price: x?.price ?? m.prices[`${prov.id}/${id}`] } : null;
};

/**
 * The model a tool needs, set up inline (O4): no provider yet means a key, right here. Tools call a
 * model with an API key, not through an agent, so an agent's login doesn't cover it. `onReady(ok)`
 * after each check.
 */
function providerKeyBlock(m, onReady) {
  let chosen = m.providers.find((p) => !p.keySet)?.id ?? "anthropic";
  const select = h("select", { class: "provider-select", "aria-label": "Provider" }, m.providers.map((p) => h("option", { value: p.id, selected: p.id === chosen }, PROVIDERS[p.id].label)));
  const key = h("input", { type: "password", autocomplete: "off", placeholder: "Paste API key", "aria-label": "API key" });
  const status = h("div", { class: "small faint" });
  let timer;
  const check = async () => {
    if (!key.value.trim()) return onReady(false);
    status.textContent = "Checking the key…";
    try {
      let next = await api(`/models/keys/${chosen}`, { method: "PUT", body: { key: key.value.trim() } });
      if (next.provider !== chosen) next = await api("/models", { method: "PUT", body: { provider: chosen } });
      put(status, h("span", { class: "dot ok" }), ` ${PROVIDERS[chosen].label} key works`);
      onReady(true, next);
    } catch (e) {
      status.textContent = e.message;
      onReady(false);
    }
  };
  select.addEventListener("change", () => ((chosen = select.value), key.value && check()));
  key.addEventListener("input", () => (clearTimeout(timer), onReady(false), (timer = setTimeout(check, 700))));
  // The first provider: also the monthly budget every tool's model calls are checked against.
  const budget = h("input", { type: "number", min: 0, step: 1, value: m.monthlyCapUsd, class: "model-cap", "aria-label": "Monthly budget in USD" });
  const el = h(
    "div",
    { class: "inset-block stack-sm" },
    h("div", { class: "small" }, "Tools call a model directly with an API key, not through an agent, so your Claude Code or Codex login doesn't cover it."),
    h("div", { class: "row tight nowrap" }, select, key),
    status,
    !m.provider && h("div", { class: "row tight nowrap budget-row" }, h("div", { class: "grow col" }, h("span", { class: "small" }, "Monthly budget"), h("span", { class: "small faint" }, "For all tools; calls stop once it's spent")), h("span", { class: "small faint" }, "$"), budget),
  );
  el.saveBudget = async () => {
    if (m.provider || Number(budget.value) === m.monthlyCapUsd || budget.value === "") return;
    await api("/models", { method: "PUT", body: { monthlyCapUsd: Number(budget.value) } });
  };
  return el;
}

/**
 * What a tool may do: pending (a Request, "wants to", one Authorize) or approved ("is allowed to",
 * revoke with Undo). A model is a grant row with a tier select; with no provider yet, the key goes
 * in right here. Resolves true if the tool ended up ready.
 */
async function grantsSheet(capId) {
  const id = enc(capId);
  const [cap, all] = await Promise.all([api(`/capabilities/${id}`), caps()]);
  const c = all.get(capId) ?? { id: capId, name: cap.name };
  const items = cap.authorization?.items ?? [];
  // A connection with a sign-in step gets its secrets by signing in (after authorizing), not by pasting.
  const signIn = cap.kind === "connection" && cap.operations.some((o) => o.name === "connect");
  const missingSecrets = new Set(signIn ? [] : cap.status.missingSecrets);
  const missingConfig = (cap.authorization?.config ?? []).filter((x) => x.value === null);
  const modelReq = cap.requires?.model;
  const m = modelReq ? await api("/models").catch(() => null) : null;
  // No usable provider: the key block, even when the grant itself is approved.
  // Hosted: the host runs tools' model calls; no key to give.
  const needsKey = !!modelReq && !!m && !m.host && (!m.provider || !m.providers.find((p) => p.id === m.provider)?.keySet);
  const pending = items.filter((i) => !i.approved || (i.kind === "secret" && missingSecrets.has(i.grant.slice(7))) || (i.kind === "model" && needsKey));
  const thenSignIn = async (ready) => (signIn && !ready && (await api(`/capabilities/${id}`)).status.missingSecrets.length ? signInDialog(capId) : ready);

  if (!pending.length && !missingConfig.length && signIn && cap.status.missingSecrets.length) return signInDialog(capId);
  const requests = cap.authorization?.requests ?? [];
  const requestedBy = requests[0]?.requestedBy ?? cap.versions?.[0]?.requestedBy;

  if (!pending.length && !missingConfig.length) {
    await modal((close) => approvedSheet(capId, c, cap, items, all, close), { width: 480 });
    invalidateCaps();
    return (await api(`/capabilities/${id}`).catch(() => cap)).status.ready;
  }

  const secrets = new Map();
  const config = new Map();
  /** Grant → its switch, for pending host and capability grants (the owner may leave some out: that's saying no). */
  const picks = new Map();
  const declined = new Set(cap.status.declinedGrants ?? []);
  let tier = modelReq?.tier ?? null;
  let keyOk = !needsKey;
  let check = () => {};
  const keyBlock = needsKey ? providerKeyBlock(m, (ok) => ((keyOk = ok), check())) : null;
  return modal(
    (close) => {
      const authorize = h("button", { class: "primary", disabled: true }, "Authorize");
      check = () => (authorize.disabled = !keyOk || [...secrets.entries()].some(([name, input]) => missingSecrets.has(name) && !input.value) || [...config.values()].some((input) => !input.value.trim()));
      authorize.addEventListener("click", async () => {
        authorize.disabled = true;
        try {
          await keyBlock?.saveBudget();
          for (const [name, input] of config) await api(`/capabilities/${id}/config/${enc(name)}`, { method: "PUT", body: { value: input.value.trim() } });
          for (const [name, input] of secrets) if (input.value) await api(`/capabilities/${id}/secrets/${enc(name)}`, { method: "PUT", body: { value: input.value } });
          const left = [...picks].filter(([, sw]) => !sw.checked).map(([grant]) => grant);
          // A different tier than asked for: a quick change (manifest only) that carries its own grant.
          const otherTier = modelReq?.tier && tier && tier !== modelReq.tier;
          const modelGrant = items.find((i) => i.kind === "model")?.grant;
          if (!left.length && !otherTier) await api(`/capabilities/${id}/grants/approve`, { method: "POST" });
          else for (const i of pending) if (!i.approved && !left.includes(i.grant) && !(otherTier && i.grant === modelGrant)) await api(`/capabilities/${id}/grants/approve`, { method: "POST", body: { grant: i.grant } });
          for (const g of left) if (!declined.has(g)) await api(`/capabilities/${id}/grants/decline`, { method: "POST", body: { grant: g } });
          if (otherTier) {
            await quickModelChange(c, { tier });
            toast(`${c.name} will use the ${tier} tier`);
          }
          invalidateCaps();
          const now = await api(`/capabilities/${id}`);
          // What was said: a switch left off is a no, so "Authorized" only when something was.
          const yes = pending.filter((i) => !i.approved && !left.includes(i.grant)).length;
          if (!otherTier)
            toast(
              now.status.ready ? `${c.name} is ready` : !yes && left.length ? `Said no to ${left.length === 1 ? "it" : `${left.length} things`}. ${c.name} won't run until you allow ${left.length === 1 ? "it" : "them"}.` : left.length ? `Authorized. Said no to ${left.length === 1 ? "one thing" : `${left.length} things`}.` : "Authorized",
              { dot: yes ? "ok" : "" },
            );
          close(now.status.ready);
        } catch (e) {
          fail(e);
          check();
        }
      });
      const configRow = (x) => {
        const input = h("input", { type: "text", autocomplete: "off", placeholder: x.description, oninput: check });
        config.set(x.name, input);
        return { pill: kindTag("setting"), main: h("span", { class: "mono" }, x.name), sub: x.description, extra: input };
      };
      const row = (i) => {
        const secretName = i.kind === "secret" ? i.grant.slice(7) : null;
        let input = null;
        if (secretName && !signIn) {
          input = h("input", { type: "password", autocomplete: "off", placeholder: missingSecrets.has(secretName) ? "Paste value" : "Set · paste to replace", oninput: check });
          secrets.set(secretName, input);
        }
        if (i.kind === "model") {
          if (!modelReq?.tier) return { pill: kindPill(i), main: h("span", {}, `Use ${modelReq?.model ?? "a model"}`), sub: "A specific model" };
          const asked = tierModel(m, modelReq.tier);
          const cost = perCall(asked?.price);
          const select = h("select", { class: "tier-select", "aria-label": "Tier" }, TIERS.map((t) => h("option", { value: t, selected: t === tier }, `${titleCase(t)} tier`)));
          select.addEventListener("change", () => (tier = select.value));
          return { pill: kindPill(i), main: h("span", {}, "Use a model"), sub: `Asked for ${titleCase(modelReq.tier)}${cost ? ` · about ${usd(cost)} a call` : ""}`, control: select };
        }
        let sw = null;
        if (!secretName && !i.approved) {
          sw = h("input", { type: "checkbox", class: "switch", checked: !declined.has(i.grant), "aria-label": "Allow" });
          picks.set(i.grant, sw);
        }
        return {
          pill: kindPill(i),
          main: grantText(i, all),
          sub: i.kind === "capability" ? i.grant.split("/").at(-1).split("@")[0] : i.kind === "secret" ? i.description : null,
          mono: i.kind === "capability",
          extra: input,
          control: sw,
        };
      };
      check();
      return [
        sheetHead(appIcon(c, { size: 48 }), `${c.name} wants to`, requestedBy && `Requested by ${actorLabel(requestedBy, all)}`),
        requests[0]?.note && h("div", { class: "small quote" }, `“${requests[0].note}”`),
        cap.status.missingDependencies?.length > 0 && h("div", { class: "notice danger" }, h("span", {}, "Depends on operations that no longer exist. ", h("a", { href: changeHref(c) }, "Change it"))),
        cap.status.unsupportedAbi && h("div", { class: "notice danger" }, h("span", {}, `This version ${cap.status.unsupportedAbi}. Upgrade Hewn, or roll it back.`)),
        requestRows([...missingConfig.map(configRow), ...pending.map(row)]),
        keyBlock,
        h(
          "div",
          { class: "small faint" },
          signIn ? "Next, you sign in to the service here in Hewn. Agents never see your password or tokens." : pending.some((i) => i.kind === "secret") ? "Secrets go to your Keychain only." : null,
        ),
        sheetActions(h("button", { onclick: () => close(false) }, "Not now"), authorize),
      ];
    },
    { width: 480 },
  )
    .then(Boolean)
    .then(thenSignIn);
}

function approvedSheet(capId, c, cap, items, all, close) {
  const id = enc(capId);
  const list = h("ul", { class: "list" });
  const render = (current) => {
    put(
      list,
      ...current.map((i) => {
        const isSecret = i.kind === "secret";
        const action = i.kind === "model" ? null : h("button", { class: "link sm" }, isSecret ? "Replace" : "Revoke");
        const li = h("li", {}, kindPill(i), h("div", { class: "grow" }, grantText(i, all), isSecret && i.description && h("span", { class: "sub" }, i.description), i.kind === "model" && h("span", { class: "sub" }, i.label)), action);
        action?.addEventListener("click", async () => {
          if (isSecret) {
            const input = h("input", { type: "password", autocomplete: "off", placeholder: "Paste new value" });
            const save = h("button", { class: "sm primary" }, "Save");
            save.addEventListener("click", async () => {
              if (!input.value) return input.focus();
              try {
                await api(`/capabilities/${id}/secrets/${enc(i.grant.slice(7))}`, { method: "PUT", body: { value: input.value } });
                toast(`Replaced ${i.grant.slice(7)}`);
                render(current);
              } catch (e) {
                fail(e);
              }
            });
            li.querySelector(".grow").append(h("span", { class: "row tight" }, input, save));
            action.remove();
            return input.focus();
          }
          try {
            await api(`/capabilities/${id}/grants/revoke`, { method: "POST", body: { grant: i.grant } });
            const rest = current.filter((x) => x !== i);
            render(rest);
            toast(`Revoked ${i.kind === "host" ? "host access" : "access"}`, {
              dot: "",
              undo: async () => {
                await api(`/capabilities/${id}/grants/approve`, { method: "POST", body: { grant: i.grant } });
                render(current);
                toast("Restored");
              },
            });
          } catch (e) {
            fail(e);
          }
        });
        return li;
      }),
    );
    if (!current.length) put(list, h("li", {}, h("span", { class: "dot ok" }), h("span", { class: "grow muted" }, "Needs nothing outside itself")));
  };
  render(items.filter((i) => i.approved));
  return [sheetHead(appIcon(c, { size: 48 }), `${c.name} is allowed to`), list, sheetActions(h("button", { class: "primary", onclick: () => close(true) }, "Done"))];
}

/**
 * I4 Sign in to a connection's service: a stepped Form (the connection's own steps: account, then
 * a code…), one step per screen, ending on a check mark and its health. Nothing typed here is
 * stored by the browser.
 */
async function signInDialog(capId) {
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(capId)}`), caps()]);
  const c = all.get(capId) ?? { id: capId, name: cap.name };
  const op = cap.operations.filter((o) => o.name === "connect").sort((a, b) => b.version - a.version)[0];
  if (!op) return false;
  return modal(
    (close) => {
      const sub = h("div", { class: "small faint" });
      const body = h("div", { class: "stack-md" });
      const labels = ["Account"];
      const step = (schema, state, message, at) => {
        sub.textContent = at > 0 ? `Step ${at + 1} of ${labels.length}` : "";
        const props = Object.entries(schema.properties ?? {}).filter(([name]) => name !== "state");
        const fields = props.map(([name, sch]) => {
          const secret = sch.format === "password" || sch.writeOnly || /pass|token|secret|key/i.test(name);
          const code = /code|otp|mfa/i.test(name);
          const input = h("input", { type: secret ? "password" : "text", class: code ? "code-input" : "", autocomplete: secret ? "current-password" : code ? "one-time-code" : "off", spellcheck: "false" });
          return { name, sch, input, el: h("label", { class: "field" }, h("span", { class: "label" }, sch.title ?? name), input, sch.description && h("span", { class: "hint" }, sch.description)) };
        });
        const submit = h("button", { class: "primary", type: "submit" }, "Sign in");
        const form = h(
          "form",
          {
            class: "stack-md",
            onsubmit: async (e) => {
              e.preventDefault();
              submit.disabled = true;
              const input = state ? { state } : {};
              for (const f of fields) if (f.input.value !== "") input[f.name] = f.sch.type === "integer" || f.sch.type === "number" ? Number(f.input.value) : f.input.value;
              try {
                const r = await api(`/capabilities/${enc(capId)}/connect`, { method: "POST", body: { input } });
                if (r.status === "needs_input") {
                  if (labels.length < at + 2) labels.push(/code/i.test(JSON.stringify(r.inputSchema ?? {})) ? "Code" : "Next");
                  return step(r.inputSchema ?? { properties: {} }, r.state, r.message, at + 1);
                }
                invalidateCaps();
                const health = await api(`/capabilities/${enc(capId)}/health`).catch(() => null);
                const [dot, word] = HEALTH[health?.status] ?? ["ok", "Connected"];
                sub.textContent = "";
                put(
                  body,
                  sheetSteps(labels, labels.length),
                  h("div", { class: "signed-in" }, h("span", { class: "check-mark", "aria-hidden": "true" }, "✓"), h("div", { class: "col" }, h("span", { class: "strong" }, `Signed in to ${c.name}`), h("span", { class: "small muted row tight" }, h("span", { class: `dot ${dot}` }), word, health?.detail ? ` · ${health.detail}` : ""))),
                  sheetActions(h("button", { class: "primary", onclick: () => close(true) }, "Done")),
                );
              } catch (err) {
                submit.disabled = false;
                fail(err);
              }
            },
          },
          sheetSteps(labels, at),
          message && h("div", { class: "notice" }, h("span", {}, message)),
          fields.map((f) => f.el),
          h("div", { class: "small faint" }, `Your password goes only to ${c.name}; Hewn keeps the token.`),
          sheetActions(at > 0 ? h("button", { type: "button", onclick: () => ((labels.length = 1), step(op.inputSchema, undefined, undefined, 0)) }, "Back") : h("button", { type: "button", onclick: () => close(false) }, "Cancel"), submit),
        );
        put(body, form);
        fields[0]?.input.focus();
      };
      step(op.inputSchema, undefined, undefined, 0);
      return [h("div", { class: "row sheet-head" }, appIcon(c, { size: 44 }), h("div", { class: "grow col" }, h("div", { class: "sheet-title" }, `Sign in to ${c.name}`), sub)), body];
    },
    { width: 440 },
  ).then(Boolean);
}
