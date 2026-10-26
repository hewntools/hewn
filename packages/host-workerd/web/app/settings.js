// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings: General · AI · Remote access · Data · About.
import { ago, api, appIcon, BRAND, capRef, CLI, commandBlock, confirmDialog, enc, fail, formSheet, h, invalidateCaps, modal, setWallpaper, sheetActions, skeleton, toast } from "../kit.js";
import { installFromFile } from "./install.js";
import { addPasskey, knownPasskeys, passkeyError, passkeysSupported } from "../passkey.js";
import { deviceName } from "./add-passkey.js";
import { addSheet, agentModelsSheet, agentTileOf, buildJobs, jobPicker, modelSheet, providerTile } from "./agents.js";
import { applyTheme, THEME_KEY } from "./appearance.js";
import { brandTile, browserZone, hewnMachine, hues, sandboxNotice, setSettings, settings, shortcutsDialog, topBar, view } from "./frame.js";
import { buildsChosen, jobModelOf, modelWords } from "./home.js";
import { plural } from "./intake.js";
import { creditWords, modelsPage, PROVIDERS, usd } from "./models.js";
import { route } from "./router.js";
import { instructionsSheet } from "./tool-actions.js";
import { segmented } from "./widgets.js";

export { SECTIONS, settingsFrame, settingsPage };

// ---------- Settings: General · AI · Remote access · Data · About ----------

const SECTIONS = [
  ["general", "General"],
  ["ai", "AI"],
  ["remote", "Remote access"],
  ["data", "Data"],
  ["about", "About"],
];

/** A settings page: the left list of sections, then this one. */
function settingsFrame(section, ...content) {
  view(
    topBar("settings"),
    sandboxNotice(),
    h(
      "main",
      { class: "settings-layout" },
      h("nav", { class: "side-list", "aria-label": "Settings" }, h("div", { class: "eyebrow" }, "Settings"), SECTIONS.map(([k, label]) => h("a", { class: "side-item", href: `#/settings/${k}`, "aria-current": k === section ? "page" : undefined }, label))),
      h("div", { class: "settings-main" }, content),
    ),
  );
}
const setting = (title, sub, ...control) => h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, title), sub && h("span", { class: "sub" }, sub)), control);
const settingsCard = (...rows) => h("div", { class: "card settings-card" }, rows);

async function settingsPage(section = "general", sub) {
  settingsFrame(section, skeleton());
  setWallpaper(await hues([200, 125]));
  if (section === "ai" && sub === "models") return modelsPage();
  if (section === "ai") return aiSection();
  if (section === "remote") return remoteSection();
  if (section === "data") return dataSection();
  if (section === "about") return aboutSection();
  return generalSection();
}

const saveSettings = async (change, message) => {
  try {
    setSettings(await api("/settings", { method: "PUT", body: change }));
    toast(message);
  } catch (e) {
    fail(e);
  }
  route();
};

/** N1 General: appearance, the owner's time zone, the sandbox. */
async function generalSection() {
  const s = setSettings(await api("/settings"));
  const sandbox = h("input", { type: "checkbox", class: "switch danger", checked: s.sandbox, "aria-label": "Sandbox" });
  sandbox.addEventListener("change", async () => {
    if (sandbox.checked) return saveSettings({ sandbox: true }, "Sandbox is on");
    const ok = await confirmDialog({ title: "Turn off the sandbox?", body: "Tool code and builders then run with your full access, network included, until you turn it back on.", confirm: "Turn off", danger: true });
    if (ok) saveSettings({ sandbox: false }, "Sandbox is off");
    else sandbox.checked = true;
  });
  const theme = localStorage.getItem(THEME_KEY) ?? "system";
  const appearance = segmented([["system", "System"], ["dark", "Dark"], ["light", "Light"]], theme, (v) => (v === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, v), applyTheme(v)), { label: "Appearance" });
  const zone = s.timeZone ?? browserZone();
  settingsFrame(
    "general",
    h("h1", { class: "flush" }, "General"),
    settingsCard(
      setting("Appearance", null, appearance),
      setting("Time zone", `${zone}${zone === browserZone() ? " · from this browser" : ""} · new schedules use it`, h("button", { class: "sm", onclick: () => timeZoneSheet(zone) }, "Change")),
      // Hosted: the host runs the sandbox.
      !s.hosted && setting("Sandbox", "Confines tool code and its network access", sandbox),
    ),
  );
}

function timeZoneSheet(current) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [current];
  return formSheet({
    title: "Time zone",
    sub: "New schedules run in it. Schedules you already have keep theirs.",
    build: (close) => {
      const select = h("select", { "aria-label": "Time zone" }, zones.map((z) => h("option", { value: z, selected: z === current }, z)));
      return [
        h("label", { class: "field" }, h("span", { class: "label" }, "Time zone"), select),
        h("button", { class: "link self-start", onclick: () => (select.value = browserZone()) }, `Use this browser's (${browserZone()})`),
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => (close(), saveSettings({ timeZone: select.value }, `Time zone: ${select.value}`)) }, "Save")),
      ];
    },
  });
}

/**
 * O1 Settings › AI: what Hewn runs AI for. Building tools (talking a request through, then building
 * it) runs one agent, on this machine and its own account, or the host's builder. Thinking inside
 * tools is a metered API call with your key.
 */
async function aiSection() {
  const [{ tools, settings: s, ready }, m, machine] = await Promise.all([buildJobs(), api("/models").catch(() => null), hewnMachine()]);
  const tile = (t) => agentTileOf(t, 20);
  const builder = tools.find((x) => x.name === s.builder);
  const catalogs = new Map([[s.builder, await api(`/tools/${enc(s.builder)}/models`).catch(() => null)]]);
  const agentWords = (t) => (t.remote && ready(t) ? t.label : `${t.label}${t.remote ? "" : ` on ${machine.word}`} · ${ready(t) ? "signed in" : t.fix ?? "not ready"}`);
  /** Who builds tools, on which model; Change picks the agent, Model… the model and effort. */
  const buildsRow = () => {
    const chosen = buildsChosen(s);
    return h(
      "div",
      { class: "setting" },
      h("div", { class: "grow" }, h("span", { class: "strong" }, "Builds tools"), h("span", { class: "sub row tight" }, chosen && builder ? [tile(builder), `${agentWords(builder)} · ${modelWords(jobModelOf(s, "builder"), catalogs.get(builder.name))}`] : "Not chosen")),
      chosen && builder && h("button", { class: "sm", onclick: () => modelSheet(builder).then((saved) => saved && route()) }, "Model…"),
      // Hosted: the host builds; only the model and effort are the owner's.
      !s.hosted && h("button", { class: "sm", onclick: () => jobPicker({ thenModel: true }).then(() => route()) }, chosen ? "Change" : "Choose…"),
    );
  };
  const n = s.maxBuildAttempts;
  const attempts = h(
    "span",
    { class: "stepper" },
    h("button", { "aria-label": "Fewer attempts", disabled: n <= 1, onclick: () => saveSettings({ maxBuildAttempts: n - 1 }, `Build attempts: ${n - 1}`) }, "−"),
    h("output", { title: "Build attempts" }, String(n)),
    h("button", { "aria-label": "More attempts", disabled: n >= 5, onclick: () => saveSettings({ maxBuildAttempts: n + 1 }, `Build attempts: ${n + 1}`) }, "+"),
  );
  const builds = buildsRow();
  // As the server has it (the owner's ticks, else its default for this agent).
  const allowed = catalogs.get(s.builder)?.agentModels ?? ["default"];
  const asks =
    builder &&
    h(
      "div",
      { class: "setting" },
      h("div", { class: "grow" }, h("span", { class: "strong" }, "Agents may ask for"), h("span", { class: "sub" }, allowed.map((id) => catalogs.get(s.builder)?.models.find((x) => x.id === id)?.label ?? id).join(", "))),
      h("button", { class: "sm", onclick: () => agentModelsSheet(builder).then((saved) => saved && route()) }, "Change…"),
    );
  const prov = m?.provider && m.providers.find((p) => p.id === m.provider);
  // The owner's standing rules for building: the intake remembers them, the builder reads them on every build.
  const rules = await api("/instructions").then((r) => r.lines).catch(() => []);
  const instructions = h(
    "div",
    { class: "setting" },
    h("div", { class: "grow" }, h("span", { class: "strong" }, "Instructions for building"), h("span", { class: "sub clip-1" }, rules.length ? `${plural(rules.length, "rule")} · ${rules.join(" · ")}` : "None yet · tell the intake a rule, or write one here")),
    h("button", { class: "sm", onclick: () => instructionsSheet().then((saved) => saved && route()) }, "Edit…"),
  );
  settingsFrame(
    "ai",
    h("div", { class: "row between" }, h("h1", { class: "flush" }, "AI"), h("button", { onclick: () => addSheet().then(() => !location.hash.startsWith("#/settings/ai/models") && route()) }, "Add…")),
    settingsCard(
      h("div", { class: "setting-with-extra" }, builds, h("div", { class: "row tight attempts" }, h("span", { class: "small faint" }, "Build attempts"), attempts)),
      asks,
      instructions,
      h(
        "div",
        { class: "setting" },
        h(
          "div",
          { class: "grow" },
          h("span", { class: "strong" }, "Thinks inside tools"),
          h(
            "span",
            { class: "sub row tight" },
            // Hosted: included; what was used this month (it's implied who runs them).
            m?.host
              ? m.host.charges.totals.length ? `${m.host.charges.totals.map(creditWords).join(", ")} used this month` : "Included"
              : prov
                ? [providerTile(prov.id, 20), `${PROVIDERS[prov.id].label} API · your key · ${usd(m.spend.totalUsd)} of ${usd(m.spend.capUsd)} this month`]
                : "No provider yet · your key, metered",
          ),
        ),
        h("a", { class: "btn sm", href: "#/settings/ai/models" }, "Models ›"),
      ),
    ),
    !builder?.remote && h("div", { class: "small faint" }, "Building runs on the agent's own account (a subscription, an API key or a cloud provider), including builds an agent asks for. Thinking inside tools uses your model key, metered."),
    h("div", { class: "small faint" }, "Agents that use your tools are on ", h("a", { href: "#/agents" }, "Agents"), "."),
  );
}

/** M1 Remote access: the public address (DNS and Caddy behind Set up…), passkeys, signed-in browsers. */
async function remoteSection() {
  const [remote, sessions] = await Promise.all([api("/remote").catch(() => null), api("/sessions").catch(() => [])]);
  const removePasskey = (p) => async () => {
    if (!(await confirmDialog({ title: `Remove “${p.name}”?`, body: settings?.hosted ? "That device then signs in from your account again." : "That device then needs a sign-in link from the server again.", confirm: "Remove", danger: true }))) return;
    try {
      await api(`/passkeys/${enc(p.id)}`, { method: "DELETE" });
      toast("Passkey removed");
      route();
    } catch (e) {
      fail(e);
    }
  };
  const addHere = async () => {
    try {
      await addPasskey(deviceName(navigator.userAgent));
      toast("Passkey added");
      route();
    } catch (e) {
      fail(new Error(passkeyError(e)));
    }
  };
  const revoke = (x) => async () => {
    try {
      await api(`/sessions/${enc(x.id)}`, { method: "DELETE" });
      toast("Signed out that browser");
      route();
    } catch (e) {
      fail(e);
    }
  };
  const signOut = async () => {
    await api("/sessions/signout", { method: "POST" }).catch(() => {});
    location.reload();
  };
  const setUp = () =>
    formSheet({
      title: "Public address",
      sub: remote?.url ?? "Not set",
      width: 520,
      build: (close) => [
        remote?.url
          ? [
              h("div", { class: "small" }, "1. DNS: an A record at your DNS provider."),
              remote.records.map((r) => commandBlock(`${r.name}  ${r.type}  ${r.value}`, "Record")),
              h("div", { class: "small" }, `2. HTTPS: a reverse proxy for ${new URL(remote.url).host}, forwarding to Hewn's public listener (keep the Host header; ${CLI} url prints its exact address). Caddy:`),
              commandBlock(`${new URL(remote.url).host} {\n  reverse_proxy ${remote.proxyTo}\n}`, "Caddy block"),
              h("div", { class: "small" }, "3. Sign in on your phone or laptop with a link from the server, then add a passkey there:"),
              commandBlock(`${CLI} open --print`),
            ]
          : [h("div", { class: "small" }, "Give Hewn an address you own, on the machine it runs on (only a terminal can):"), commandBlock(`${CLI} url https://hewn.example.com`), h("div", { class: "small faint" }, "It then prints the DNS record and the reverse proxy setup.")],
        sheetActions(h("button", { class: "primary", onclick: () => close() }, "Done")),
      ],
    });
  settingsFrame(
    "remote",
    h("h1", { class: "flush" }, "Remote access"),
    // Hosted: the address is the host's; nothing to set up.
    settingsCard(setting("Public address", remote?.url ? remote.url : settings?.hosted ? "Not set up yet" : "Not set: Hewn is only on this machine", !settings?.hosted && h("button", { class: "sm", onclick: setUp }, "Set up…"))),
    remote &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Passkeys"),
        remote.passkeys.map((p) => setting(p.name, `${p.works ? "Passkey" : `For ${p.host}, not the current address`} · added ${ago(p.createdAt)} · last used ${p.lastUsedAt ? ago(p.lastUsedAt) : "never"}`, h("button", { class: "sm ghost danger", onclick: removePasskey(p) }, "Remove"))),
        !remote.passkeys.length && setting("None yet", settings?.hosted ? "Added on the device that uses them: sign in there from your account, then add one." : remote.url ? `Added on the device that uses them: sign in there with ${CLI} open --print, then add one.` : "Passkeys work on the public address."),
        // Not once this browser has one for this address (made here, or signed in with).
        remote.here === "public" && passkeysSupported() && !remote.passkeys.some((p) => p.works && knownPasskeys().includes(p.id)) && setting("Add a passkey", "On this device: it signs in with Face ID, a fingerprint or the screen lock", h("button", { class: "sm", onclick: addHere }, "Add passkey")),
      ),
    h(
      "div",
      { class: "card settings-card" },
      h("div", { class: "eyebrow card-eyebrow" }, "Signed-in browsers"),
      sessions.map((x) => setting(deviceName(x.userAgent), `${x.current ? "This browser · " : ""}last used ${x.lastSeenAt ? ago(x.lastSeenAt) : "never"} · signed in ${x.createdAt ? ago(x.createdAt) : "earlier"}`, x.current ? h("button", { class: "sm", onclick: signOut }, "Sign out") : h("button", { class: "sm ghost danger", onclick: revoke(x) }, "Sign out"))),
    ),
  );
}

/** N2 Data: backups (with a warning when they share a disk with the data), call logs, deleted tools. */
async function dataSection() {
  const [s, backups, deleted] = await Promise.all([api("/settings"), api("/backups").catch(() => null), api("/capabilities?archived=1").catch(() => [])]);
  setSettings(s);
  const restore = (d) => async () => {
    try {
      await api(`/capabilities/${enc(d.id)}/restore`, { method: "POST" });
      invalidateCaps();
      toast(`Restored ${d.name}`);
      route();
    } catch (e) {
      fail(e);
    }
  };
  // Delete forever keeps type-the-name (decided): it can't be undone.
  const purge = (d) => async () => {
    const typed = h("input", { type: "text", placeholder: d.name, autocomplete: "off", "aria-label": "Type the name to confirm" });
    const ok = await modal(
      (close) => {
        const yes = h("button", { class: "danger solid", disabled: true, onclick: () => close(true) }, "Delete forever");
        typed.addEventListener("input", () => (yes.disabled = typed.value.trim() !== d.name));
        return [
          h("h2", { class: "title-ref" }, "Delete ", capRef(d, d.id, { size: 24 }), " forever?"),
          h("div", { class: "muted dialog-body" }, "Its code, versions, data, logs and secrets are removed. This can't be undone; backups are the only way back."),
          h("label", { class: "field" }, h("span", { class: "label" }, "Type ", h("b", {}, d.name), " to confirm"), typed),
          sheetActions(h("button", { onclick: () => close(false) }, "Cancel"), yes),
        ];
      },
      { width: 440 },
    );
    if (!ok) return;
    try {
      await api(`/capabilities/${enc(d.id)}/purge`, { method: "POST", body: { confirm: d.id } });
      toast(`${d.name} permanently deleted`, { dot: "" });
      route();
    } catch (e) {
      fail(e);
    }
  };
  const backupBtn = h("button", { class: "sm" }, "Back up now");
  backupBtn.addEventListener("click", async () => {
    backupBtn.disabled = true;
    try {
      const b = await api("/backups", { method: "POST" });
      toast(`Backed up · ${Math.round(b.bytes / 1024)} KB`);
      route();
    } catch (e) {
      backupBtn.disabled = false;
      fail(e);
    }
  });
  const folderSheet = () =>
    formSheet({
      title: "Backup folder",
      build: (close) => {
        const input = h("input", { type: "text", class: "code", value: s.backupDir ?? "", placeholder: backups?.dir ?? "", "aria-label": "Backup folder" });
        return [
          h("label", { class: "field" }, h("span", { class: "label" }, "Folder"), input, h("span", { class: "hint" }, "An absolute path. Another disk is safer.")),
          h(
            "div",
            { class: "actions flush between" },
            s.backupDir ? h("button", { class: "ghost", onclick: () => (close(), saveSettings({ backupDir: null }, "Backup folder reset to the default")) }, "Use default") : h("span", {}),
            h("span", { class: "row tight" }, h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => (close(), saveSettings({ backupDir: input.value.trim() || null }, "Backup folder saved")) }, "Save")),
          ),
        ];
      },
    });
  const options = [[7, "1 week"], [14, "2 weeks"], [30, "1 month"], [90, "3 months"], [365, "1 year"], [0, "Forever"]];
  if (!options.some(([v]) => v === s.logRetentionDays)) options.push([s.logRetentionDays, `${s.logRetentionDays} days`]);
  const keep = h("select", { class: "setting-select", "aria-label": "Keep call logs" }, options.map(([v, l]) => h("option", { value: v, selected: v === s.logRetentionDays }, l)));
  keep.addEventListener("change", () => saveSettings({ logRetentionDays: Number(keep.value) }, `Call logs: ${options.find(([v]) => v === Number(keep.value))[1].toLowerCase()}`));
  const last = backups?.backups?.[0];
  settingsFrame(
    "data",
    h("h1", { class: "flush" }, "Data"),
    // Hosted: the host keeps backups off the machine; the folder is its business.
    !s.hosted && backups?.sameDisk && h("div", { class: "notice" }, h("span", {}, "Backups are on the same disk as your data. If the disk fails, both are lost.")),
    settingsCard(
      backups && setting("Backups", last ? `Last ${ago(last.at)} · ${Math.round(last.bytes / 1024)} KB · nightly, 7 daily and 4 weekly kept` : "Nightly; 7 daily and 4 weekly kept. Never includes secrets.", backupBtn),
      !s.hosted && backups && h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, "Folder"), h("span", { class: "sub mono" }, backups.dir)), h("button", { class: "sm", onclick: folderSheet }, "Change")),
      setting("Keep call logs", "Builds, grants and access changes are always kept", keep),
      setting("Install from a file", "A tool someone shared with you (.hewn.zip): you read it before it's installed", h("button", { class: "sm", onclick: () => installFromFile().catch(fail) }, "Install…")),
    ),
    deleted.length > 0 &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Deleted tools"),
        deleted.map((d) => h("div", { class: "setting" }, appIcon(d, { size: 32 }), h("div", { class: "grow" }, h("span", {}, d.name), h("span", { class: "sub" }, `Deleted ${ago(d.archivedAt)} · data kept`)), h("button", { class: "ghost sm danger", onclick: purge(d) }, "Delete forever…"), h("button", { class: "sm", onclick: restore(d) }, "Restore"))),
      ),
  );
}

/** N5 About: version, data format and ABI; up to date or the upgrade command; shortcuts, docs, licence. */
/** The public docs and changelog, on GitHub. */
const DOCS_URL = "https://github.com/hewntools/hewn/tree/main/docs#readme";
const CHANGELOG_URL = "https://github.com/hewntools/hewn/blob/main/CHANGELOG.md";

async function aboutSection() {
  const [status, machine] = await Promise.all([api("/status").catch(() => ({})), hewnMachine()]);
  const newer = status.latest && status.version && cmpVersion(status.latest, status.version) > 0;
  settingsFrame(
    "about",
    h("h1", { class: "flush" }, "About"),
    h(
      "div",
      { class: "card about-card" },
      brandTile(56),
      h("div", { class: "grow col" }, h("span", { class: "about-name" }, `${BRAND} ${status.version ?? ""}`), h("span", { class: "small muted" }, [status.dataFormat && `Data format ${status.dataFormat}`, status.abi && `ABI ${status.abi}`, !settings?.hosted && `on ${machine.word}`].filter(Boolean).join(" · "))),
      newer ? h("span", { class: "pill warn with-dot" }, "update") : status.latest ? h("span", { class: "pill ok with-dot" }, "up to date") : h("span", { class: "pill" }, "can't check now"),
    ),
    newer &&
      h(
        "div",
        { class: "card stack-sm upgrade-card" },
        h("span", { class: "strong" }, `${status.latest} is out`),
        (status.notes ?? []).map((r) => releaseNotes(r, status.notes.length > 1)),
        // Hosted: the host moves this Hewn to new releases.
        settings?.hosted
          ? h("div", { class: "small muted" }, "Upgrades happen for you. Your tools and data stay.")
          : [h("div", { class: "small muted" }, "Upgrade from a terminal. Backups run first; your tools and data stay."), commandBlock(`${CLI} upgrade`)],
        h("a", { class: "small", href: CHANGELOG_URL, target: "_blank", rel: "noopener" }, "What's new ›"),
      ),
    settingsCard(
      setting("Docs", "Getting started, building tools, agents, your data", h("a", { class: "btn sm", href: DOCS_URL, target: "_blank", rel: "noopener" }, "Open")),
      setting("Keyboard shortcuts", null, h("button", { class: "sm", onclick: shortcutsDialog }, "Show")),
      setting("Licence", "AGPL-3.0-or-later · spec and UI kit Apache-2.0"),
    ),
  );
}

/** One release's notes, as the changelog has them: "**Title.** The rest" bullets, the title in bold. */
function releaseNotes(r, labelled) {
  const item = (text) => {
    const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
    const plain = (t) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    return h("li", {}, m ? [h("span", { class: "strong" }, plain(m[1])), " ", plain(m[2])] : plain(text));
  };
  return h("div", { class: "stack-xs release-notes" }, labelled && h("span", { class: "eyebrow" }, r.version), h("ul", { class: "small" }, r.items.map(item)));
}

/** "0.3.4" vs "0.3.3": >0 when a is newer. Pre-releases sort before their release. */
function cmpVersion(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, "").split("-");
    return [...core.split(".").map(Number), pre ? 0 : 1];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
