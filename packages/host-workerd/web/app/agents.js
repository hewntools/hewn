// SPDX-License-Identifier: AGPL-3.0-or-later
// Agents: the ones that use your tools, and the ones that work for Hewn (who builds tools, on
// which model).
import {
  actorLabel,
  ago,
  api,
  appIcon,
  capRef,
  caps,
  chip,
  commandBlock,
  confirmDialog,
  enc,
  fail,
  formSheet,
  h,
  kindTag,
  modal,
  pickerSheet,
  rememberAgents,
  requestRows,
  requestSheet,
  setWallpaper,
  sheetActions,
  sheetHead,
  skeleton,
  toast,
} from "../kit.js";
import { mmss } from "./build.js";
import { connectDialog } from "./connect.js";
import { brandTile, go, hewnMachine, hues, page, put, setSettings, settings } from "./frame.js";
import { buildsChosen, jobModelOf, modelWords, saveBuildModel } from "./home.js";
import { pollInbox } from "./inbox.js";
import { PROVIDERS } from "./models.js";
import { glyphTile, PALETTE_GLYPHS } from "./palette.js";
import { route } from "./router.js";

export {
  addSheet,
  AGENT_CATALOG,
  agentModelsSheet,
  agentRequestSheet,
  agentsPage,
  agentTile,
  agentTileOf,
  ALL_JOBS,
  buildJobs,
  catalogOf,
  confirmationSheet,
  jobPicker,
  modelSheet,
  providerTile,
  setJobs,
};

// ---------- L: Agents (agents that use your tools), O: who works for Hewn ----------

const SCOPES = [
  ["discover", "See your tools", "see your tools"],
  ["invoke", "Use them", "use tools"],
  ["create", "Make new ones", "make tools"],
  ["modify", "Change existing ones", "change tools"],
];
/** Scopes in words: "see, use, make". */
const scopeWords = (scopes) => {
  const s = new Set(scopes);
  const parts = [s.has("discover") && "see", s.has("invoke") && "use", s.has("create") && "make", s.has("modify") && "change"].filter(Boolean);
  return parts.length ? parts.join(", ") : "no access";
};

/**
 * Agents Hewn knows about. `where`: local (a CLI or app on this computer), cloud, or any (another MCP
 * client). `connect`: how to connect it (a harness id, "cloud", "other"), absent = coming soon.
 * `tool`: the CLI Hewn runs for its jobs (local agents only); `buildSoon`: could, later.
 * `apps`: it draws widgets in the chat (MCP Apps).
 */
const AGENT_CATALOG = [
  { id: "claude-code", label: "Claude Code", where: "local", connect: "claude-code", tool: "claude" },
  { id: "codex", label: "Codex", where: "local", connect: "codex", tool: "codex" },
  { id: "codex-desktop", label: "Codex Desktop", where: "local", connect: "codex-desktop", shares: "codex", apps: true },
  { id: "opencode", label: "OpenCode", where: "local", connect: "opencode", tool: "opencode" },
  { id: "claude-desktop", label: "Claude Desktop", where: "local", connect: "cloud-desktop", shares: "claude", match: /^claude(-ai)?$/, apps: true },
  { id: "gemini-cli", label: "Gemini CLI", where: "local", buildSoon: true },
  { id: "cursor", label: "Cursor", where: "local", apps: true },
  { id: "vscode", label: "VS Code (Copilot)", where: "local", apps: true },
  { id: "claude", label: "claude.ai", where: "cloud", connect: "cloud", match: /^claude(-ai)?$/, apps: true },
  { id: "chatgpt", label: "ChatGPT", where: "cloud", connect: "cloud", apps: true },
  { id: "gemini", label: "Gemini", where: "cloud" },
];
/**
 * Agents' tiles: [hue, logo, saturation %] (web/logos/, Simple Icons and LobeHub; see SOURCES.md).
 * Saturation 0 for the black-and-white brands: their logo black or white on grey.
 */
const TILES = { "claude-code": [30, "claude"], claude: [30, "claude"], "claude-desktop": [30, "claude"], codex: [200, "openai", 0], "codex-desktop": [200, "openai", 0], opencode: [90, "opencode", 0], chatgpt: [160, "openai", 0], "gemini-cli": [250, "googlegemini"], gemini: [250, "googlegemini"], cursor: [0, "cursor", 0], vscode: [220, "githubcopilot", 0] };
/** A tile with a brand's logo as a mask (it takes the tile's glyph colour), or the monogram. */
const logoTile = (hue, logo, letters, size, saturation = 100) =>
  h("span", { class: "app-icon", style: { "--size": `${size}px`, "--hue": hue, "--s": saturation / 100 }, "aria-hidden": "true" }, logo ? h("span", { class: "icon-mask logo", style: { "mask-image": `url(/logos/${logo}.svg)`, "-webkit-mask-image": `url(/logos/${logo}.svg)` } }) : letters);
/** An agent's tile, by id (claude-code-2 → claude-code) or by its name. */
const agentTile = (id, label = id, size = 44) => {
  if (id === "remote") return brandTile(size);
  const entry = AGENT_CATALOG.find((c) => id === c.id || String(id).startsWith(`${c.id}-`) || c.label === label || c.label === id);
  const [hue, logo, saturation] = TILES[entry?.id ?? id] ?? [260, null];
  return logoTile(hue, logo, String(label).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "AG", size, saturation);
};
/** A model provider's tile. */
const providerTile = (id, size = 28) => logoTile({ anthropic: 30, openai: 160, openrouter: 250 }[id] ?? 200, id, PROVIDERS[id]?.label[0] ?? "?", size, { openai: 0, openrouter: 0 }[id]);
/** The catalog entry an MCP connection belongs to (for its tile), by id: claude-code, claude-code-2 … */
const catalogOf = (a) => AGENT_CATALOG.find((c) => a.id === c.id || a.id.startsWith(`${c.id}-`) || c.match?.test(a.id));
/** The local CLI an agent identity runs as, when Hewn can give it jobs (claude-code → claude). */
const toolOf = (a) => catalogOf(a)?.tool;

/** Hewn's jobs: who does them, and the CLIs that can (installed, signed in). */
async function buildJobs() {
  const [tools, s] = await Promise.all([api("/tools").catch(() => []), api("/settings")]);
  for (const t of tools) if (t.remote) rememberAgents([{ id: t.name, name: t.label }]);
  const ready = (t) => !!t?.found && t.loggedIn !== false;
  const label = (name) => tools.find((t) => t.name === name)?.label ?? name;
  return { tools, settings: s, ready, label };
}

/** Save who does these jobs (and that the owner chose them). */
async function setJobs(keys, tool) {
  const s = await api("/settings");
  setSettings(await api("/settings", { method: "PUT", body: { ...Object.fromEntries(keys.map((k) => [k, tool])), jobsChosen: [...new Set([...(s.jobsChosen ?? []), ...keys])] } }));
  return settings;
}

const ALL_JOBS = ["intake", "builder"];
const agentTileOf = (t, size) => agentTile(t.harnessId ?? t.name, t.label, size);

/**
 * O2 Who builds tools: the signed-in agents on this machine (and the host's builder, if it runs
 * one); the agent talks requests through and builds them. `thenModel`: open the model sheet next
 * (switching agent means choosing its model; it remembers the last one).
 */
async function jobPicker({ thenModel = false } = {}) {
  const [{ tools, settings: s, ready }, machine] = await Promise.all([buildJobs(), hewnMachine()]);
  const options = [
    ...tools.map((t) => ({
      value: t.name,
      label: t.label,
      tile: agentTileOf(t, 28),
      disabled: !ready(t),
      sub: !ready(t) ? t.fix ?? "Not installed" : t.remote ? "" : `On ${machine.word} · signed in`,
    })),
    ...AGENT_CATALOG.filter((c) => c.buildSoon).map((c) => ({ value: c.id, label: c.label, tile: agentTile(c.id, c.label, 28), disabled: true, sub: "Coming soon" })),
  ];
  const chosen = buildsChosen(s) ? s.builder : null;
  const pick = await pickerSheet({ title: "Who builds tools?", options, value: chosen, note: "It talks each request through with you, then builds it.", confirm: (v) => `Use ${tools.find((t) => t.name === v)?.label ?? "it"}`, unchanged: false });
  if (!pick) return null;
  await setJobs(ALL_JOBS, pick);
  const t = tools.find((x) => x.name === pick);
  toast(`${t?.label ?? pick} builds tools`);
  if (thenModel && pick !== chosen) await modelSheet(t ?? { name: pick, label: pick });
  return pick;
}

/**
 * O3 The model and effort for building tools on one agent, from the agent's own list: Default
 * lets the CLI decide, a family (Fable) follows the newest, a pinned model stays put (once it's
 * gone, builds fail saying so until another is picked). Other… takes a full name.
 */
async function modelSheet(t) {
  // Read afresh: a provider signed in to since the last look shows at once.
  const [catalog, s] = await Promise.all([api(`/tools/${enc(t.name)}/models?fresh=1`), api("/settings")]);
  const cur = jobModelOf(s, "builder", t.name);
  const kindWords = { default: "lets it decide", family: "follows the newest", pinned: "stays on this one" };
  return formSheet({
    icon: agentTileOf(t, 44),
    title: "Model for building tools",
    sub: t.label,
    width: 520,
    build: (close) => {
      let chosen = cur.model ?? "default";
      const listed = catalog.models.some((m) => m.id === chosen);
      const name = `model-${Math.random().toString(36).slice(2)}`;
      const other = h("input", { type: "text", placeholder: catalog.otherHint ?? "model name", "aria-label": "Model name", value: listed ? "" : chosen, class: "mono" });
      const effort = h("select", { "aria-label": "Effort" });
      const efforts = () => (chosen === "" ? catalog.models[0]?.efforts ?? [] : catalog.models.find((m) => m.id === chosen)?.efforts ?? catalog.models[0]?.efforts ?? []);
      const effortField = h("label", { class: "field" }, h("span", { class: "label" }, "Effort"), effort);
      // The effort field shows for a model with levels; a model without has nothing to pick.
      const fillEffort = (keep) => {
        const list = efforts();
        const def = catalog.models.find((m) => m.id === chosen)?.defaultEffort;
        put(effort, h("option", { value: "" }, def ? `Default (${def})` : "Default"), list.map((e) => h("option", { value: e, selected: e === keep }, e[0].toUpperCase() + e.slice(1))));
        effortField.hidden = !list.length;
      };
      const rows = catalog.models.map((m) => {
        const radio = h("input", { type: "radio", name, checked: m.id === chosen });
        radio.addEventListener("change", () => ((chosen = m.id), fillEffort(effort.value)));
        // The model's own description (a family's or the default's says what it does), its successor, and whether it failed lately.
        const sub = [m.description ?? kindWords[m.kind], m.upgrade && `${m.upgrade} replaces it`, m.failed && `didn't run ${ago(m.failed.at)}: ${m.failed.reason}`].filter(Boolean).join(" · ");
        return h("label", { class: "job-option" }, radio, h("span", { class: "grow col" }, h("span", {}, m.label), sub && h("span", { class: "sub" }, sub)));
      });
      if (catalog.other) {
        const radio = h("input", { type: "radio", name, checked: !listed });
        const pickOther = () => ((radio.checked = true), (chosen = other.value.trim()), fillEffort(effort.value));
        radio.addEventListener("change", pickOther);
        other.addEventListener("input", pickOther);
        rows.push(h("label", { class: "job-option" }, radio, h("span", { class: "grow col" }, h("span", {}, "Other…"), h("span", { class: "sub" }, catalog.otherHint ? `By its full name (${catalog.otherHint})` : "By its full name"), other)));
      }
      fillEffort(cur.effort);
      const save = h("button", { class: "primary" }, "Save");
      save.addEventListener("click", async () => {
        const model = chosen && chosen !== "default" ? chosen : undefined;
        try {
          await saveBuildModel(s, t.name, { model, effort: effort.value || undefined });
          toast(`Builds tools: ${modelWords({ model, effort: effort.value || undefined }, catalog)}`);
          close(true);
        } catch (e) {
          fail(e);
        }
      });
      return [
        h("fieldset", { class: "job" }, rows),
        h("label", { class: "field" }, h("span", { class: "label" }, "Effort"), effort),
        h("div", { class: "small faint" }, "Agents that ask for a build can pick a model too, from the ones you allow (Settings › AI)."),
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), save),
      ];
    },
  });
}

/** O4 The models agents may ask a build to use, for the agent that builds (Default always). */
async function agentModelsSheet(t) {
  const [catalog, s] = await Promise.all([api(`/tools/${enc(t.name)}/models`), api("/settings")]);
  const allowed = new Set(catalog.agentModels ?? ["default"]);
  const extra = [...allowed].filter((id) => !catalog.models.some((m) => m.id === id)).map((id) => ({ id, label: id, kind: "pinned" }));
  return formSheet({
    icon: agentTileOf(t, 44),
    title: "Models agents may ask for",
    sub: `When an agent asks ${t.label} for a build`,
    width: 520,
    build: (close) => {
      const boxes = [...catalog.models, ...extra].map((m) => ({ m, box: h("input", { type: "checkbox", checked: m.id === "default" || allowed.has(m.id), disabled: m.id === "default" }) }));
      const save = h("button", { class: "primary" }, "Save");
      save.addEventListener("click", async () => {
        const list = boxes.filter((b) => b.box.checked).map((b) => b.m.id);
        try {
          setSettings(await api("/settings", { method: "PUT", body: { agentModels: { ...(s.agentModels ?? {}), [t.name]: list } } }));
          toast(`Agents may ask for ${list.length === 1 ? "the default only" : `${list.length} models`}`);
          close(true);
        } catch (e) {
          fail(e);
        }
      });
      return [
        h("div", { class: "stack-xs" }, boxes.map(({ m, box }) => h("label", { class: "check" }, box, h("span", {}, m.label, m.description && h("span", { class: "faint" }, ` · ${m.description}`))))),
        h("div", { class: "small faint" }, "An agent asking for one you haven't ticked gets told which it may use; nothing is built. Your own choices aren't limited."),
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), save),
      ];
    },
  });
}

/** L1 Agents: one row per agent identity, with the parts it plays (role chips). */
async function agentsPage() {
  page("agents", 720, skeleton());
  const [agents, all, jobs, machine] = await Promise.all([api("/agents"), caps().catch(() => new Map()), buildJobs(), hewnMachine()]);
  rememberAgents(agents);
  setWallpaper(await hues([300, 125]));
  const { settings: s } = jobs;
  const from = (a) => (a.via === "local" ? `On ${machine.word}` : a.via === "tunnel" ? `Through ${a.address ?? "the public address"}` : "Connected");
  const roleChips = (a) => {
    const tool = toolOf(a);
    const jobChip = a.via === "local" && tool && s.builder === tool && buildsChosen(s) && h("a", { class: "pill", href: "#/settings/ai", onclick: (e) => e.stopPropagation() }, "builds tools");
    return h("div", { class: "role-chips" }, h("span", { class: "pill accent" }, "uses your tools"), jobChip);
  };
  const recent = (a) => a.lastUsedAt && Date.now() - Date.parse(a.lastUsedAt) < 5 * 60000;
  const row = (a) =>
    h(
      "li",
      { class: "link agent-row", tabindex: 0, onclick: () => agentSheet(a, all).then(() => route()), onkeydown: (e) => e.key === "Enter" && agentSheet(a, all).then(() => route()) },
      agentTile(catalogOf(a)?.id ?? a.id, a.name),
      h(
        "div",
        { class: "grow stack-xs" },
        h("span", { class: "row tight strong" }, h("span", { class: `dot ${recent(a) ? "ok" : ""}` }), a.name),
        h("span", { class: "sub" }, `${from(a)} · ${scopeWords(a.scopes)}${a.capabilities !== "*" ? " · some tools" : ""} · ${a.lastUsedAt ? ago(a.lastUsedAt) : "not used yet"}`),
        roleChips(a),
      ),
    );
  page(
    "agents",
    720,
    h("div", { class: "row between" }, h("h1", { class: "flush" }, "Agents"), h("button", { class: "primary", onclick: () => addSheet().then(() => !location.hash.startsWith("#/settings/ai/models") && route()) }, "Add…")),
    h("div", { class: "card list-card" }, h("ul", { class: "list" }, agents.length ? agents.map(row) : h("li", {}, h("span", { class: "grow muted" }, "No agents connected yet."), h("button", { class: "sm", onclick: () => connectDialog().then(() => route()) }, "Connect an agent")))),
    h("div", { class: "small faint" }, "What Hewn itself runs AI for is under ", h("a", { href: "#/settings/ai" }, "Settings › AI"), "."),
  );
}

/**
 * L2 An agent: its scopes as switches (each saves at once, with Undo), "only some tools" as a tool
 * picker, and Disconnect. Replaces the inline Edit.
 */
function agentSheet(a, all) {
  const max = new Set(a.maxScopes ?? SCOPES.map(([s]) => s));
  return modal(
    (close) => {
      const switches = h("div", { class: "settings-list" });
      const save = async (body, message, undo) => {
        const next = await api(`/agents/${enc(a.id)}`, { method: "PUT", body });
        Object.assign(a, body.scopes ? { scopes: body.scopes } : {}, body.capabilities ? { capabilities: body.capabilities } : {}, next?.scopes ? { scopes: next.scopes } : {});
        render();
        toast(message, { undo });
      };
      const render = () => {
        put(
          switches,
          SCOPES.filter(([scope]) => max.has(scope)).map(([scope, text, verb]) => {
            const sw = h("input", { type: "checkbox", class: "switch", checked: a.scopes.includes(scope), "aria-label": text });
            sw.addEventListener("change", () => {
              const before = [...a.scopes];
              const scopes = sw.checked ? [...new Set([...before, scope])] : before.filter((x) => x !== scope);
              save({ scopes }, sw.checked ? `${a.name} can now ${verb}` : `${a.name} can no longer ${verb}`, () => save({ scopes: before }, `Undone: ${a.name} settings restored`)).catch((e) => ((sw.checked = !sw.checked), fail(e)));
            });
            return h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, text)), sw);
          }),
          (() => {
            const some = a.capabilities !== "*";
            const sw = h("input", { type: "checkbox", class: "switch", checked: some, "aria-label": "Only some tools" });
            sw.addEventListener("change", () => save({ capabilities: sw.checked ? [] : "*" }, sw.checked ? `${a.name} sees no tools until you pick some` : `${a.name} sees all your tools`).catch(fail));
            return [
              h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, "Only some tools")), sw),
              some &&
                h(
                  "div",
                  { class: "row tight wrap cap-pick" },
                  [...all.values()]
                    .filter((c) => c.version)
                    .map((c) => {
                      const on = a.capabilities.includes(c.id);
                      return chip(c, undefined, {
                        class: `chip ${on ? "selected" : ""}`,
                        "aria-pressed": String(on),
                        onclick: () => {
                          const next = on ? a.capabilities.filter((x) => x !== c.id) : [...a.capabilities, c.id];
                          save({ capabilities: next }, on ? `${a.name} no longer sees ${c.name}` : `${a.name} sees ${c.name}`).catch(fail);
                        },
                      });
                    }),
                ),
            ];
          })(),
        );
      };
      render();
      const disconnect = h("button", { class: "ghost danger" }, "Disconnect");
      disconnect.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: `Disconnect ${a.name}?`, body: "It loses all access on its next call. It can ask to connect again, and you approve it again.", confirm: "Disconnect", danger: true }))) return;
        try {
          await api(`/agents/${enc(a.id)}`, { method: "DELETE" });
          toast(`Disconnected ${a.name}`);
          close();
        } catch (e) {
          fail(e);
        }
      });
      return [
        sheetHead(agentTile(catalogOf(a)?.id ?? a.id, a.name, 44), a.name, `${a.via === "local" ? "On Hewn's machine" : a.via === "tunnel" ? `Through ${a.address ?? "the public address"}` : "Connected"}${a.createdAt ? ` · connected ${ago(a.createdAt)}` : ""}`),
        switches,
        h("div", { class: "actions flush between" }, disconnect, h("button", { class: "primary", onclick: () => close() }, "Done")),
      ];
    },
    { width: 480 },
  );
}

/**
 * An agent asking to connect, as a Request: who it is (its name is self-asserted, so where it
 * returns to is shown too), the code its browser shows, and what it may do. Unticking narrows;
 * nothing can be added beyond what it asked for.
 */
async function agentRequestSheet(p, { inline } = {}) {
  const all = await caps().catch(() => new Map());
  const picked = new Set(p.suggested);
  const name = h("input", { type: "text", value: p.suggestedName, "aria-label": "Agent name", maxlength: 40 });
  const currentCaps = Array.isArray(p.current?.capabilities) ? p.current.capabilities : null;
  const onlySome = h("input", { type: "checkbox", class: "switch", checked: !!currentCaps, "aria-label": "Only some tools" });
  const capList = h("div", { class: "cap-pick row tight wrap", hidden: !currentCaps }, [...all.values()].filter((c) => c.version).map((c) => h("label", { class: "chip plain" }, h("input", { type: "checkbox", value: c.id, checked: !!currentCaps?.includes(c.id) }), appIcon(c, { size: 20 }), c.name)));
  onlySome.addEventListener("change", () => (capList.hidden = !onlySome.checked));
  const decide = async (approve) => {
    const body = approve ? { approve: true, name: name.value.trim() || p.suggestedName, scopes: [...picked], capabilities: onlySome.checked ? [...capList.querySelectorAll("input:checked")].map((x) => x.value) : "*" } : { approve: false };
    const r = await api(`/agents/pending/${enc(p.id)}`, { method: "POST", body });
    toast(approve ? `${name.value.trim() || p.suggestedName} is connected` : `Declined ${p.clientName}`);
    pollInbox();
    return approve ? r.agentId ?? true : null;
  };
  const rows = SCOPES.filter(([scope]) => p.requested.includes(scope)).map(([scope, text]) => {
    const sw = h("input", { type: "checkbox", class: "switch", checked: picked.has(scope), "aria-label": text });
    sw.addEventListener("change", () => (sw.checked ? picked.add(scope) : picked.delete(scope)));
    const added = p.current && !p.current.scopes.includes(scope);
    // "Change existing ones" stays amber on purpose: an agent that can change tools can change what
    // the code behind your data does (owner, 2026-10-19).
    return { pill: kindTag(scope === "discover" || scope === "invoke" ? "use" : "make", scope === "modify" ? "warn" : ""), main: h("span", {}, text), sub: added ? "New: it doesn't have this now" : null, control: sw };
  });
  const extra = h(
    "div",
    { class: "stack-sm" },
    h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, "Only some tools")), onlySome),
    capList,
    h("label", { class: "field" }, h("span", { class: "label" }, p.reconnects ? `Name · replaces “${p.reconnects}” if kept` : "Name"), name),
    h("div", { class: "small faint row tight" }, "Check the code matches the one in its browser window:", h("code", { class: "user-code" }, p.userCode)),
  );
  const opts = {
    icon: agentTile(p.clientName, p.clientName, 48),
    title: `${p.clientName} wants to connect`,
    sub: `${p.via === "local" ? "On Hewn's machine" : `Through ${p.address ?? "the public address"}`} · returns to ${p.redirectHost} · ${ago(p.createdAt)}`,
    rows,
    extra,
    decline: "Decline",
    accept: "Approve",
    onAccept: async (close) => close(await decide(true)),
    onDecline: async (close) => close(await decide(false)),
  };
  if (!inline) return requestSheet(opts);
  // Inside the Connect sheet: the same Request, in place.
  const el = h("div", { class: "card pending-card stack-md" }, sheetHead(opts.icon, opts.title, opts.sub), requestRows(rows), extra, sheetActions(h("button", { onclick: () => decide(false).then(inline, fail) }, "Decline"), h("button", { class: "primary", onclick: () => decide(true).then(inline, fail) }, "Approve")));
  return el;
}

/**
 * L3 An agent's destructive call, as a Request: what it wants to delete, on which tool and with
 * what input, its note, and a timer; Stop or Allow once. The agent is blocked until you decide.
 */
async function confirmationSheet(c) {
  const all = await caps().catch(() => new Map());
  const cap = all.get(c.capabilityId) ?? { id: c.capabilityId, name: c.capabilityId };
  const who = actorLabel(c.agentId, all);
  const [op] = c.operation.split("@");
  const ids = c.input && typeof c.input === "object" ? Object.entries(c.input).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ") : "";
  const words = op.replace(/_/g, " ");
  const timer = h("span", {});
  const tick = () => (timer.textContent = `It's waiting · ${mmss(Date.now() - Date.parse(c.createdAt))}`);
  tick();
  const t = setInterval(tick, 1000);
  const decide = (approve) => async (close) => {
    await api(`/confirmations/${enc(c.id)}`, { method: "POST", body: { approve } });
    toast(approve ? `${who} may run it now` : "Stopped it");
    pollInbox();
    close(approve);
  };
  return requestSheet({
    icon: agentTile(c.agentId, who, 48),
    title: `${who} wants to ${words}`,
    sub: timer,
    rows: [{ pill: kindTag("destructive", "danger"), main: h("span", { class: "row tight wrap" }, h("span", { class: "mono" }, op), "on", capRef(cap, c.capabilityId)), sub: ids || "no input", mono: true }],
    quote: c.note,
    decline: "Stop",
    accept: "Allow once",
    danger: true,
    onAccept: decide(true),
    onDecline: decide(false),
  }).finally(() => clearInterval(t));
}

/**
 * O5 Add…: the three ways AI touches Hewn, so adding something also teaches the model: an agent
 * that uses your tools, an agent that works for Hewn, a model provider.
 */
/** Resolves once the chosen flow (if any) is done. */
async function addSheet() {
  const next = await modal(
    (close) => {
      // Hewn's own choices: the palette's glyphs for the same places, ink on grey (colour is for tools and brands).
      const choice = (glyph, title, sub, fn) =>
        h("li", { class: "link add-choice", tabindex: 0, onclick: () => close(fn), onkeydown: (e) => e.key === "Enter" && close(fn) }, glyphTile(PALETTE_GLYPHS[glyph], 44), h("div", { class: "grow" }, h("span", { class: "strong" }, title), h("span", { class: "sub" }, sub)));
      return [
        h("h2", { class: "flush" }, "Add"),
        h(
          "ul",
          { class: "list" },
          choice("agent", "An agent that uses your tools", "Claude Code, Codex, OpenCode, claude.ai, ChatGPT, any MCP client", () => connectDialog()),
          // Hosted: the host builds; there are no agents on the machine to work for Hewn.
          !settings?.hosted && choice("hammer", "An agent that works for Hewn", "Builds tools · runs on this machine", () => hewnAgentsSheet()),
          // Hosted: tools that think run on the host's models.
          !settings?.hosted && choice("chip", "A model provider", "Anthropic, OpenAI, OpenRouter · for tools that think", () => go("#/settings/ai/models")),
        ),
        sheetActions(h("button", { onclick: () => close() }, "Close")),
      ];
    },
    { width: 520 },
  );
  // After the sheet has closed: a route() in between would close the next sheet as it opens.
  if (typeof next === "function") await next();
}

/**
 * O7 Agents for Hewn's jobs: the CLIs on this machine (installed, signed in, or coming soon). "How"
 * shows the one sign-in command; "Use" opens the job picker. Look again after installing.
 */
function hewnAgentsSheet() {
  return modal(
    (close) => {
      const list = h("ul", { class: "list" }, h("li", {}, skeleton("60%")));
      const detail = h("div", {});
      const render = async () => {
        const [{ tools, ready, settings: s }, machine] = await Promise.all([buildJobs(), hewnMachine()]);
        const does = (t) => (s.builder === t.name && buildsChosen(s) ? ["builds tools"] : []);
        put(
          list,
          tools.map((t) =>
            h(
              "li",
              {},
              agentTile(t.harnessId ?? t.name, t.label),
              h("div", { class: "grow" }, h("span", {}, t.label), h("span", { class: "sub" }, !t.found ? "Not installed" : ready(t) ? ["Installed · signed in", ...does(t)].join(" · ") : "Installed · not signed in")),
              ready(t)
                ? h("button", { class: "primary sm", onclick: () => pickJob(t) }, "Use")
                : h("button", { class: "sm", onclick: () => put(detail, h("div", { class: "stack-sm" }, h("div", { class: "small" }, `${t.label}, in a terminal on ${machine.word}:`), commandBlock(t.fix?.replace(/^(Install it|Sign in): (run )?/, "") ?? t.name)) ) }, "How"),
            ),
          ),
          AGENT_CATALOG.filter((c) => c.buildSoon).map((c) => h("li", { class: "soon" }, agentTile(c.id, c.label), h("div", { class: "grow" }, h("span", {}, c.label), h("span", { class: "sub" }, "Coming soon")))),
        );
      };
      const pickJob = async (t) => {
        await setJobs(ALL_JOBS, t.name);
        toast(`${t.label} builds tools`);
        render();
      };
      render();
      return [h("h2", { class: "flush" }, `Agents on this machine`), list, detail, h("div", { class: "actions flush between" }, h("button", { class: "ghost", onclick: render }, "Look again"), h("button", { class: "primary", onclick: () => close() }, "Done"))];
    },
    { width: 520 },
  );
}
