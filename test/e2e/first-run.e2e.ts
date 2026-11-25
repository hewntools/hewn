// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser E2E on a fresh workerd host (not part of npm test): the first run, an agent's
// approval (from the Inbox), choosing who builds, a starter build, Hewn's tools under + New, schedules, Info's own
// actions (Run, a rule, Deny then Authorize, Restore… cancelled), a version's Files, a destructive
// call confirmed from the banner, Share… on a tool installed from a file (a file, a link served on the
// public listener, Revoke), and the authority trail on
// Activity. The builder is scripted (copies the Running Log seed; a change adds a line);
// builder/intake checks are stubbed as installed and signed in, so it runs anywhere.
//
//   PLAYWRIGHT_NODE_MODULES=/path/to/node_modules/ node test/e2e/first-run.e2e.ts
// With E2E_REAL_BUILDER=1 the starter is built by the real builder (Claude Code, signed in on this
// machine) and the builder check is the real one: the first run as a new user has it.
// A Chromium-based browser must be installed (see `hewn doctor`, Visual check). Screenshots go to /tmp/e2e-fr-*.png.
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { pkceChallenge } from "@hewntools/core/agents.ts";
import { packBundle } from "@hewntools/core/bundle.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor } from "@hewntools/cli/supervisor/index.ts";
import { BUILDERS } from "@hewntools/cli/builders/cli-agents.ts";
import { findBrowser } from "@hewntools/cli/visual.ts";
import { readTree } from "@hewntools/cli/workbench.ts";
import { editJson, SEED } from "../helpers.ts";
import { freePort } from "../workerd-helpers.ts";

const FIX = resolve(import.meta.dirname, "../fixtures");
const pw = createRequire(process.env.PLAYWRIGHT_NODE_MODULES ?? import.meta.url)("playwright-core");
const root = mkdtempSync(join(tmpdir(), "hewn-e2e-"));
const port = await freePort();

// The builder: the Running Log seed, renamed to whatever was asked for; a change adds a line to it. It waits for `hold`.
let hold = Promise.resolve();
const builder: CapabilityBuilder = {
  name: "claude",
  build: async (job) => {
    await hold;
    cpSync(SEED, job.workspace, { recursive: true });
    editJson(join(job.workspace, "capability.json"), (m) => {
      m.id = job.capabilityId;
      m.name = job.capabilityId.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    });
    if (job.kind === "modify") appendFileSync(join(job.workspace, "src", "index.ts"), "// Changed by request.\n");
  },
};
const real = process.env.E2E_REAL_BUILDER === "1";
const publicPort = await freePort();
const sv = await startSupervisor({
  home: openHome(root),
  port,
  publicPort,
  builders: real ? BUILDERS : { claude: builder },
  log: real ? (l) => /build|attempt|promot|FAIL/i.test(l) && console.log(`  [hewn] ${l.slice(0, 160)}`) : () => {},
  keySource: "file",
  browser: "",
  ...(real
    ? {}
    : {
        tools: () => [
          { name: "claude" as const, label: "Claude Code", found: true, loggedIn: true },
          { name: "codex" as const, label: "Codex", found: false, fix: "Install it: npm install -g @openai/codex" },
        ],
      }),
});
await sv.admin("settings", { builder: "claude", intake: "claude", maxBuildAttempts: real ? 3 : 1 });
const base = `http://127.0.0.1:${port}`;
const web = `http://hewn.localhost:${port}`;

const browser = await pw.chromium.launch({ executablePath: findBrowser() });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
let failed = false;
const step = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log("✔", name);
  } catch (e) {
    failed = true;
    console.log("✖", name, (e as Error).message.split("\n")[0]);
    await page.screenshot({ path: "/tmp/e2e-fr-fail.png" });
    throw e;
  }
};

// An agent that asks to connect (as Claude Code would), and its token once approved.
const redirect = "http://127.0.0.1:59997/callback";
const verifier = "e2e-verifier-".padEnd(60, "x");
let agentReq: { id: string; secret: string; clientId: string } | undefined;
const askToConnect = async () => {
  const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude Code (hewn)", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json();
  const q = new URLSearchParams({ client_id: reg.client_id, response_type: "code", redirect_uri: redirect, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", scope: "discover invoke create modify", state: "s" });
  const html = await (await fetch(`${base}/authorize?${q}`)).text();
  agentReq = { id: /id:"([^"]+)"/.exec(html)![1], secret: /secret:"([^"]+)"/.exec(html)![1], clientId: reg.client_id };
};
/** What the Inbox says about a tool, if anything (as the owner's page reads it). */
const inboxNeed = (id: string) =>
  page.evaluate(async (id: string) => ((await (await fetch("/api/inbox", { headers: { "x-hewn-ui": "1" } })).json()).needs as { capabilityId?: string; detail: string; action: string }[]).find((n) => n.capabilityId === id), id);
let token: string | undefined;
const agentToken = async () => {
  if (token) return token;
  const poll = await (await fetch(`${base}/authorize/poll`, { method: "POST", body: new URLSearchParams({ id: agentReq!.id, secret: agentReq!.secret }) })).json();
  const code = new URL(poll.redirect).searchParams.get("code")!;
  const t = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: agentReq!.clientId, redirect_uri: redirect }) })).json();
  return (token = t.access_token as string);
};

try {
  await step("fresh Hewn: hewn open lands on the first run (one moment screen; nobody chosen yet)", async () => {
    const { ticket } = await sv.admin("web-ticket", {});
    await page.goto(`${web}/auth?ticket=${ticket}`);
    await page.getByText("Make your own tools.").waitFor();
    await page.getByText(/Agents on this/).waitFor();
    await page.getByText("Who builds your tools").waitFor();
    if ((await page.getByText("Not chosen").count()) !== 1) throw new Error("chosen before the owner chose");
    if (!(await page.getByLabel("Describe it").isDisabled())) throw new Error("Make something is open before a builder is chosen");
    await page.screenshot({ path: "/tmp/e2e-fr-welcome.png" });
  });

  await step("an agent asks to connect: the Inbox has it, a Request sheet shows its code", async () => {
    await askToConnect();
    await page.locator(".inbox-count:not([hidden])").waitFor({ timeout: 20_000 });
    await page.locator(".inbox-btn").click();
    const row = page.locator(".inbox-row", { hasText: "wants to connect" });
    // "Claude Code (hewn)" is Claude Code: its logo, not the letters "CL".
    await row.locator(".icon-mask.logo").waitFor();
    await row.click();
    const sheet = page.locator("dialog[open]", { hasText: "Claude Code (hewn) wants to connect" });
    await sheet.waitFor();
    await sheet.locator(".app-icon .icon-mask.logo").first().waitFor();
    const code = (await sheet.locator(".user-code").textContent())!.trim();
    if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)) throw new Error(`code ${code}`);
    await sheet.getByRole("checkbox", { name: "Make new ones" }).uncheck();
    await page.screenshot({ path: "/tmp/e2e-fr-approval.png" });
    await sheet.getByRole("button", { name: "Approve" }).click();
    await sheet.waitFor({ state: "detached" });
    const agents = await sv.admin("call", { method: "agents", args: [] });
    const a = agents.result.find((x: any) => x.id === "claude-code");
    if (!a || a.scopes.includes("create")) throw new Error(`approved as ${JSON.stringify(a?.scopes)}`);
    await page.goto(`${web}/#/agents`);
    await page.locator(".agent-row", { hasText: "Claude Code" }).locator(".role-chips", { hasText: "uses your tools" }).waitFor();
  });

  await step("first run: choose who builds; Codex can't be picked and says how to fix", async () => {
    await page.goto(`${web}/#/`);
    await page.locator(".first-card li", { hasText: "Builds tools" }).getByRole("button", { name: "Choose…" }).click();
    const picker = page.locator("dialog[open]", { hasText: "Who builds tools?" });
    await picker.waitFor();
    if (!real) {
      if (!(await picker.locator("label.job-option", { hasText: "Codex" }).locator("input").isDisabled())) throw new Error("Codex (not installed) can be picked");
      await picker.getByText(/Install it/).waitFor();
    }
    await picker.locator("label.job-option", { hasText: "Claude Code" }).locator("input").check();
    await picker.getByRole("button", { name: "Use Claude Code" }).click();
    await page.locator(".first-card li", { hasText: "Builds tools" }).getByText(/Claude Code/).waitFor();
    await page.getByLabel("Describe it").and(page.locator(":enabled")).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-agents.png" });
  });

  await step("Settings › AI: one Builds tools row; pick its model", async () => {
    await page.goto(`${web}/#/settings/ai`);
    const row = page.locator(".setting", { hasText: "Builds tools" }).first();
    await row.getByRole("button", { name: "Model…" }).click();
    const sheet = page.locator("dialog[open]", { hasText: "Model for building tools" });
    // The row labelled exactly "Fable" (the "Other…" row's example name, claude-fable-5-1, contains it too).
    await sheet.locator("label.job-option").filter({ has: page.getByText("Fable", { exact: true }) }).locator("input").check();
    await sheet.getByLabel("Effort").selectOption("high");
    await sheet.getByRole("button", { name: "Save" }).click();
    await row.getByText(/Fable · high effort/).waitFor();
    await page.locator(".setting", { hasText: "Agents may ask for" }).getByText(/Default, Fable, Opus/).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-ai.png" });
    await page.goto(`${web}/#/`);
  });

  await step("build a starter: the build runs on the chosen model and the tool lands on Home", async () => {
    await page.getByRole("button", { name: "Reading list" }).click();
    await page.waitForURL(/#\/b\//);
    await page.screenshot({ path: "/tmp/e2e-fr-building.png" });
    await page.getByText(/is ready|v1/).first().waitFor({ timeout: real ? 15 * 60_000 : 60_000 });
    await page.getByText(/Built with Claude Code · /).waitFor();
    await page.goto(`${web}/#/`);
    await page.locator(".tile-label", { hasText: "Reading List" }).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-home.png" });
  });

  await step("Hewn's tools under + New: the Official tools, a tool's page, its Source code, Install opens the install sheet (cancelled); no Hub tab; ⌘K has Hewn's tools last", async () => {
    const tabs = await page.locator("nav.main-nav a").allTextContents();
    if (tabs.includes("Hub")) throw new Error(`tabs: ${tabs.join(", ")}`);
    await page.goto(`${web}/#/hub`);
    await page.getByText("That page doesn't exist.").waitFor();
    await page.goto(`${web}/#/new`);
    await page.locator(".start-options").getByText("One of Hewn's tools").click();
    await page.waitForURL(/#\/new\/tools$/);
    await page.getByRole("heading", { name: "Hewn's tools" }).waitFor();
    await page.locator(".hub-card", { hasText: "Plant Log" }).waitFor();
    const cards = await page.locator(".hub-card").count();
    if (cards < 7) throw new Error(`${cards} of Hewn's tools`);
    // The starter is a Reading List: Hewn's counts as yours (same id), so it offers Open and Install a copy.
    await page.locator(".hub-card", { hasText: "Reading List" }).getByText("Installed").waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-hub.png" });
    await page.locator(".hub-card", { hasText: "Plant Log" }).click();
    await page.waitForURL(/#\/new\/tools\/plant-log$/);
    await page.getByRole("heading", { name: "Plant Log" }).waitFor();
    await page.locator(".hub-what").getByText(/^Keeps plants/).waitFor();
    await page.locator(".hub-what").getByRole("button", { name: "Source code ›" }).click();
    const code = page.locator("dialog[open]", { hasText: "Source code · v" });
    await code.getByText("Plant Log · Official · read-only").waitFor();
    await code.locator(".code-line").first().waitFor();
    await code.getByRole("button", { name: "Done" }).click();
    await code.waitFor({ state: "detached" });
    await page.locator(".info-head").getByRole("button", { name: "Install", exact: true }).click();
    const sheet = page.locator("dialog[open]", { hasText: "Install Plant Log" });
    // Hewn's own tools are Apache-2.0: the sheet says so.
    await sheet.getByText("License: Apache 2.0").waitFor();
    await sheet.getByText(/From Hewn's tools · Official/).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-hub-install.png" });
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await sheet.waitFor({ state: "detached" });
    await page.goto(`${web}/#/new/tools/reading-list`);
    await page.locator(".info-head").getByRole("button", { name: "Install a copy" }).waitFor();
    await page.locator(".info-head").getByRole("button", { name: "Open", exact: true }).waitFor();
    // ⌘K: "log" names Hewn's tools (Plant Log, Running Log) and finds Activity by its words; yours first, Hewn's tools last.
    await page.getByRole("button", { name: "Search and commands" }).click();
    await page.getByPlaceholder("Search tools, pages and actions").fill("log");
    await page.locator(".palette-item", { hasText: "Plant Log" }).waitFor();
    const groups = await page.locator(".palette-group").allTextContents();
    if (groups.at(-1) !== "Hewn's tools" || groups.indexOf("Hewn's tools") !== groups.length - 1 || groups.length < 2) throw new Error(`groups: ${groups.join(", ")}`);
    // The arrows wrap: Up on the first item goes to the last, Down on the last back to the first.
    const active = () => page.locator(".palette-item").evaluateAll((els: Element[]) => els.findIndex((e) => e.classList.contains("active")));
    const last = (await page.locator(".palette-item").count()) - 1;
    if ((await active()) !== 0) throw new Error(`starts at ${await active()}`);
    await page.keyboard.press("ArrowUp");
    if ((await active()) !== last) throw new Error(`Up from the first: ${await active()}, not ${last}`);
    await page.keyboard.press("ArrowDown");
    if ((await active()) !== 0) throw new Error(`Down from the last: ${await active()}`);
    // Nothing shown: the arrows do nothing, and Enter still runs nothing.
    await page.getByPlaceholder("Search tools, pages and actions").fill("zzqx");
    await page.getByText("Nothing matches.").waitFor();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByText("Nothing matches.").waitFor();
    await page.getByPlaceholder("Search tools, pages and actions").fill("log");
    await page.keyboard.press("ArrowDown");
    if ((await active()) !== 1) throw new Error(`after nothing shown, Down: ${await active()}`);
    await page.keyboard.press("Escape");
  });

  await step("one of Hewn's tools installs from + New with its sample data", async () => {
    await page.goto(`${web}/#/new`);
    await page.locator(".start-options").getByText("One of Hewn's tools").click();
    await page.locator(".hub-card", { hasText: "Kid Quotes" }).click();
    await page.locator(".info-head").getByRole("button", { name: "Install", exact: true }).click();
    const sheet = page.locator("dialog[open]", { hasText: "Install Kid Quotes" });
    if (!(await sheet.getByRole("checkbox").isChecked())) throw new Error("Start with sample data isn't ticked");
    await sheet.getByRole("button", { name: "Install", exact: true }).click();
    await page.waitForURL(/#\/b\//);
    const until = Date.now() + 120_000;
    let st: any;
    // Its sample data replays after it goes live: wait for the build to say so.
    const replayed = (s: any) => s.builds.find((b: any) => b.capabilityId === "kid-quotes")?.log?.some((l: string) => /sample data(:| stopped)/.test(l));
    while (Date.now() < until && !replayed((st = await sv.admin("status", {})))) await new Promise((r) => setTimeout(r, 500));
    if (!st.capabilities.find((c: any) => c.id === "kid-quotes")?.version || !replayed(st)) throw new Error(`Kid Quotes didn't go live with its sample data: ${JSON.stringify(st.builds[0]?.log?.slice(-5))}`);
    const quotes = await sv.admin("invoke", { capabilityId: "kid-quotes", operation: "list_quotes", input: {} });
    if (!(JSON.stringify(quotes.result ?? {}).length > 200)) throw new Error(`no sample data: ${JSON.stringify(quotes)}`);
    const src = (await sv.admin("call", { method: "get", args: ["kid-quotes"] })).result.source;
    if (src?.from !== "hub" || src?.id !== "kid-quotes") throw new Error(`source: ${JSON.stringify(src)}`);    // A file or a link: a link Hewn won't fetch says why under the field, and the sheet stays.
    await page.goto(`${web}/#/new`);
    await page.locator(".start-options").getByText("A file or a link someone shared").click();
    const r1 = page.locator("dialog[open]", { hasText: "Install from a file or link" });
    await r1.getByLabel("A link to a tool's file").fill("http://example.com/plant-log.hewn.zip");
    await r1.getByRole("button", { name: "Fetch" }).click();
    await r1.getByText("The link isn't https. Hewn fetches only https links.").waitFor();
    await r1.getByRole("button", { name: "Cancel" }).click();
    await r1.waitFor({ state: "detached" });
  });

  await step("schedules: Info › Schedules › + Add schedule, add one daily, see the next run, pause it", async () => {
    await page.goto(`${web}/#/c/reading-list`);
    await page.locator(".info-section", { hasText: "Schedules" }).getByRole("button", { name: "+ Add schedule" }).click();
    const sheet = page.locator("dialog[open]", { hasText: "New schedule · Reading List" });
    // A read operation (list…/get…) needs no input; others may require some.
    const ops = await sheet.getByLabel("Operation", { exact: true }).locator("option").evaluateAll((els: HTMLOptionElement[]) => els.map((e) => e.value));
    const op = ops.find((o: string) => /^(list|get)/.test(o)) ?? ops[0];
    await sheet.getByLabel("Operation", { exact: true }).selectOption(op!);
    await sheet.getByLabel("At", { exact: true }).fill("07:30");
    await sheet.getByRole("button", { name: "Add schedule" }).click();
    // Info shows it in its Schedules section, a switch per schedule.
    const row = page.locator(".info-section", { hasText: "Schedules" }).locator("li", { hasText: op });
    await row.getByText(/Daily 07:30 · next /).waitFor();
    await row.getByRole("checkbox", { name: "On" }).uncheck();
    await row.getByText(/paused/).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-schedules.png" });
  });

  await step("Info: Run on an operation opens the Run view on that operation", async () => {
    await page.goto(`${web}/#/c/reading-list`);
    const second = page.locator(".info-section", { hasText: "Operations" }).locator("li").nth(1);
    const op = (await second.locator(".mono").textContent())!.trim();
    await second.getByRole("button", { name: "Run" }).click();
    await page.waitForURL(new RegExp(`#/run/reading-list\\?op=${op}$`));
    await page.locator("nav.side-list button[aria-pressed='true']", { hasText: op }).waitFor();
  });

  await step("a slow page the owner has already left doesn't draw over the next one", async () => {
    const slow = "**/api/capabilities/reading-list";
    await page.route(slow, async (r: any) => (await new Promise((ok) => setTimeout(ok, 1500)), r.continue()));
    await page.goto(`${web}/#/`);
    await page.locator(".tile-label", { hasText: "Reading List" }).waitFor();
    await page.evaluate(() => (location.hash = "#/c/reading-list"));
    await page.waitForTimeout(150);
    await page.evaluate(() => (location.hash = "#/activity"));
    await page.getByRole("heading", { name: "Activity" }).waitFor();
    await page.waitForTimeout(2500);
    if (await page.locator(".info-page").count()) throw new Error("Info drew over Activity");
    await page.unroute(slow);
  });

  await step("Info: add a rule for the tool, then Remove it", async () => {
    await page.goto(`${web}/#/c/reading-list`);
    const section = page.locator(".info-section", { hasText: "Instructions" });
    await section.getByLabel("New rule").fill("Titles in sentence case");
    await section.getByRole("button", { name: "Add", exact: true }).click();
    const rule = section.locator("li", { hasText: "Titles in sentence case" });
    await rule.waitFor();
    await rule.getByRole("button", { name: "Remove" }).click();
    await rule.waitFor({ state: "detached" });
  });

  await step("Info: Deny a host a tool asks for, it says you said no, then Authorize it", async () => {
    // A counter that asks to reach a host, installed by the owner.
    const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-host-"));
    cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => Object.assign(m, { id: "host-counter", name: "Host Counter", requires: { hosts: ["api.example.com"] } }));
    const installed = await sv.admin("install", { name: "Host Counter", purpose: "Counts, and may reach a host", dir, wait: true });
    rmSync(dir, { recursive: true, force: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    await page.goto(`${web}/#/c/host-counter`);
    await page.locator(".info-notice", { hasText: "Wants to Reach api.example.com" }).getByRole("button", { name: "Deny" }).click();
    const saidNo = page.locator(".info-notice", { hasText: "You said no to letting it connect to api.example.com" });
    await saidNo.waitFor();
    await page.locator(".pill", { hasText: "you said no" }).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-said-no.png" });
    await saidNo.getByRole("button", { name: "Authorize" }).click();
    await saidNo.waitFor({ state: "detached" });
    await page.locator(".pill.ok", { hasText: /^ready$/ }).waitFor();
  });

  await step("a setting with a suggested value: the form opens with it in the field, and the tool is ready only after Save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-suggested-"));
    cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => Object.assign(m, { id: "repo-counter", name: "Repo Counter", abi: "2.6", config: [{ name: "REPO", description: "The repository, owner/name", suggested: "hewntools/hewn" }, { name: "REVIEWER", description: "Who reviews" }] }));
    const installed = await sv.admin("install", { name: "Repo Counter", purpose: "Counts, for a repository", dir, wait: true });
    rmSync(dir, { recursive: true, force: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    if ((await sv.admin("readiness", { capabilityId: "repo-counter" })).ready) throw new Error("ready before the owner saved");
    await page.goto(`${web}/#/c/repo-counter`);
    await page.getByRole("button", { name: "Set…" }).first().click();
    const [field, reviewer] = [page.locator("dialog input[type=text]").nth(0), page.locator("dialog input[type=text]").nth(1)];
    await field.waitFor();
    if ((await field.inputValue()) !== "hewntools/hewn") throw new Error(`the field opened with "${await field.inputValue()}"`);
    if ((await sv.admin("readiness", { capabilityId: "repo-counter" })).ready) throw new Error("ready while the form is open");
    // Only settings to give: Save takes what's filled (the suggested one counts), and the line under it names the rest.
    const save = page.getByRole("button", { name: "Save" });
    await page.locator("dialog").getByText("Set REVIEWER before it runs.").waitFor();
    await save.click();
    await page.getByText("Saved. Set REVIEWER before it runs.").waitFor();
    const half = await sv.admin("readiness", { capabilityId: "repo-counter" });
    if (half.ready || half.missingConfig.join() !== "REVIEWER") throw new Error(`after a Save with REVIEWER empty: ${JSON.stringify(half)}`);
    const need = await inboxNeed("repo-counter");
    if (need?.detail !== "Set REVIEWER before it runs" || need.action !== "Set…") throw new Error(`the Inbox says ${JSON.stringify(need)}`);
    await page.getByRole("button", { name: "Set…" }).first().click();
    await page.locator("dialog input[type=text]").first().fill("Ada");
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator(".pill.ok", { hasText: /^ready$/ }).waitFor();
    const r = await sv.admin("readiness", { capabilityId: "repo-counter" });
    if (!r.ready) throw new Error(`not ready after Save: ${JSON.stringify(r)}`);
  });

  await step("Authorize approves a tool's grants whatever its settings, and names the ones still unset; the Inbox does too; a Deny of everything doesn't ask for them", async () => {
    // A counter that asks to reach two hosts and has two settings, installed by the owner.
    const install = async (id: string, name: string) => {
      const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-grants-settings-"));
      cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
      editJson(join(dir, "capability.json"), (m) => Object.assign(m, { id, name, abi: "2.6", requires: { hosts: ["api.example.com", "status.example.com"] }, config: [{ name: "UPSTREAM_REPO", description: "The upstream repository" }, { name: "MAINTAINER", description: "Who maintains it" }] }));
      const installed = await sv.admin("install", { name, purpose: "Counts, for an upstream", dir, wait: true });
      rmSync(dir, { recursive: true, force: true });
      if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    };
    await install("upstream-counter", "Upstream Counter");
    await page.goto(`${web}/#/c/upstream-counter`);
    await page.getByRole("button", { name: "Give it what it needs" }).click();
    const authorize = page.locator("dialog").getByRole("button", { name: "Authorize" });
    await authorize.waitFor();
    if (!(await authorize.isEnabled())) throw new Error("Authorize disabled with the settings empty");
    await page.locator("dialog").getByText("Set UPSTREAM_REPO and MAINTAINER before it runs.").waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-authorize-unset.png" });
    await authorize.click();
    await page.getByText("Authorized. Set UPSTREAM_REPO and MAINTAINER before it runs.").waitFor();
    const r = await sv.admin("readiness", { capabilityId: "upstream-counter" });
    if (r.ready || r.pendingGrants.length || r.missingConfig.join() !== "UPSTREAM_REPO,MAINTAINER") throw new Error(`after Authorize: ${JSON.stringify(r)}`);
    const need = await inboxNeed("upstream-counter");
    if (need?.detail !== "Set UPSTREAM_REPO and MAINTAINER before it runs" || need.action !== "Set…") throw new Error(`the Inbox says ${JSON.stringify(need)}`);
    await page.goto(`${web}/#/`);
    await page.locator(".inbox-btn").click();
    await page.locator(".inbox-row", { hasText: "Set UPSTREAM_REPO and MAINTAINER before it runs" }).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-authorize-inbox.png" });
    await page.keyboard.press("Escape");

    // Every switch off: the button says Deny, nothing asks for the settings, and the Inbox doesn't say they'd be enough.
    await install("declined-counter", "Declined Counter");
    await page.goto(`${web}/#/c/declined-counter`);
    await page.getByRole("button", { name: "Give it what it needs" }).click();
    await page.locator("dialog input.switch").first().waitFor();
    for (const sw of await page.locator("dialog input.switch").all()) await sw.uncheck();
    const deny = page.locator("dialog").getByRole("button", { name: "Deny" });
    await deny.waitFor();
    if (await page.locator("dialog").getByText("before it runs").count()) throw new Error("a Deny of everything asks for the settings");
    await deny.click();
    const said = page.locator(".toast", { hasText: "Said no to 2 things." });
    await said.waitFor();
    if ((await said.innerText()).includes("before it runs")) throw new Error(`the toast asks for the settings: ${await said.innerText()}`);
    const declined = await inboxNeed("declined-counter");
    if (declined?.detail.startsWith("Set ")) throw new Error(`the Inbox says settings would do: ${JSON.stringify(declined)}`);
  });

  await step("a tool Hewn suspended: opening it from Home says why, with Ask builder to fix and Resume, as its Info page does; Resume opens it", async () => {
    const installed = await sv.admin("install", { name: "Runaway", purpose: "Runs on", dir: join(FIX, "runaway"), wait: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    // Three times code that never yields (the watchdog restarts the tools each time): suspended.
    for (let i = 0; i < 3; i++) await sv.admin("invoke", { capabilityId: "runaway", operation: "spin" }).catch(() => {});
    for (let i = 0; !(await sv.admin("readiness", { capabilityId: "runaway" })).suspended; i++) {
      if (i > 100) throw new Error("not suspended");
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.goto(`${web}/#/`);
    await page.locator(".tile", { hasText: "Runaway" }).click();
    const sheet = page.locator("dialog", { hasText: /Suspended: it worked for more than 10 seconds without a pause 3 times within an hour \(spin@1 at .*\)\. Its calls, schedules and widgets are refused until you resume it\./ });
    await sheet.waitFor();
    if (await page.locator("dialog", { hasText: "is allowed to" }).count()) throw new Error("the grants sheet came up instead");
    await sheet.getByRole("button", { name: "Ask builder to fix" }).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-suspended.png" });
    await sheet.getByRole("button", { name: "Resume" }).click();
    await page.waitForURL(/#\/(app|run)\/runaway/);
    if ((await sv.admin("readiness", { capabilityId: "runaway" })).suspended) throw new Error("still suspended");
  });

  await step("Versions › Details › Restore… asks first, and Cancel keeps the live version", async () => {
    const v2 = await sv.admin("modify", { capabilityId: "reading-list", request: "a second version", wait: true });
    if (v2.status !== "promoted") throw new Error(v2.log?.join("\n"));
    await page.goto(`${web}/#/c/reading-list`);
    await page.locator(".info-section", { hasText: "Versions" }).locator("li").filter({ hasNotText: "live" }).getByRole("button", { name: "Details" }).click();
    await page.waitForURL(/#\/c\/reading-list\/v\/1$/);
    await page.getByRole("button", { name: "Restore…" }).click();
    const confirm = page.locator("dialog[open]", { hasText: "Restore v1?" });
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await confirm.waitFor({ state: "detached" });
    const status = await sv.admin("status", {});
    if (status.capabilities.find((c: any) => c.id === "reading-list")?.version !== 2) throw new Error("Cancel restored it");
  });

  // v2 comes from the step before; only the scripted builder's change is known (it adds a line).
  if (!real)
    await step("a version's Files: what changed since the one before as a diff, every file in Source; v1 in Source", async () => {
      await page.goto(`${web}/#/c/reading-list/v/2?tab=files`);
      const files = page.locator(".code-browser");
      await files.getByText("Changed since v1").waitFor();
      await page.locator("main.version-layout.wide").waitFor();
      await files.locator(".code-files button", { hasText: "src/index.ts" }).locator(".add-n", { hasText: "+1" }).waitFor();
      await files.locator(".code-line.hunk", { hasText: /^@@ -\d+,\d+ \+\d+,\d+ @@$/ }).first().waitFor();
      await files.locator(".code-line.add", { hasText: "Changed by request." }).waitFor();
      await page.screenshot({ path: "/tmp/e2e-fr-files.png" });
      await files.getByRole("button", { name: "Source" }).click();
      const first = files.locator(".code-body.source .code-line").first();
      await first.waitFor();
      if ((await first.locator(".no").count()) !== 1) throw new Error("Source has more than one gutter");
      await page.goto(`${web}/#/c/reading-list/v/1?tab=files`);
      await files.locator(".code-body.source .code-line").first().waitFor();
      await files.getByText(/^v1 · \d+ files$/).waitFor();
      if (await files.getByRole("button", { name: "Changes" }).count()) throw new Error("v1 offers Changes");
    });

  await step("an agent's destructive call waits for the owner, who allows it once", async () => {
    // A counter with a destructive reset, installed by the owner.
    const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-reset-"));
    cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => m.operations.push({ name: "reset", description: "Back to 0", version: 1, sideEffect: "destructive", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } }));
    writeFileSync(join(dir, "src", "index.ts"), `const count = (db: any) => db.prepare("SELECT n FROM counter WHERE id = 1").get().n;
export const operations = {
  "increment@1": (_: unknown, { db }: any) => (db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1").run(), { count: count(db) }),
  "get@1": (_: unknown, { db }: any) => ({ count: count(db) }),
  "reset@1": (_: unknown, { db }: any) => (db.prepare("UPDATE counter SET n = 0 WHERE id = 1").run(), { count: count(db) }),
};
`);
    const installed = await sv.admin("install", { name: "UI Counter", purpose: "Counts", dir, wait: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    await sv.admin("invoke", { capabilityId: "ui-counter", operation: "increment", input: {} });

    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await agentToken()}` } } }));
    const call = client.callTool({ name: "capabilities_invoke", arguments: { capabilityId: "ui-counter", operation: "reset", input: {} } }, undefined, { timeout: 120_000 });
    // It blocks the agent: a banner on whatever page the owner is on, then a Request sheet.
    await page.goto(`${web}/#/accounts`);
    const banner = page.locator(".blocking-banner:not([hidden])", { hasText: "is waiting for you" });
    await banner.waitFor({ timeout: 20_000 });
    await banner.getByRole("button", { name: "Review" }).click();
    const sheet = page.locator("dialog[open]", { hasText: "wants to reset" });
    await sheet.waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-confirm.png" });
    await sheet.getByRole("button", { name: "Allow once" }).click();
    const r: any = await call;
    if (r.isError || JSON.parse(r.content[0].text).result.count !== 0) throw new Error(r.content[0].text);
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await step("an agent's calls of one operation, waiting together: the tab's title counts them, and Allow all 3 lets each run", async () => {
    // A counter whose destructive reset takes a value, so each call is its own.
    const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-reset-to-"));
    cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => {
      Object.assign(m, { id: "set-counter", name: "Set Counter" });
      m.operations.push({ name: "reset", description: "Set the count", version: 1, sideEffect: "destructive", inputSchema: { type: "object", additionalProperties: false, properties: { to: { type: "integer" } } }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } });
    });
    writeFileSync(join(dir, "src", "index.ts"), `const count = (db: any) => db.prepare("SELECT n FROM counter WHERE id = 1").get().n;
export const operations = {
  "increment@1": (_: unknown, { db }: any) => (db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1").run(), { count: count(db) }),
  "get@1": (_: unknown, { db }: any) => ({ count: count(db) }),
  "reset@1": (i: { to?: number }, { db }: any) => (db.prepare("UPDATE counter SET n = ? WHERE id = 1").run(i.to ?? 0), { count: count(db) }),
};
`);
    const installed = await sv.admin("install", { name: "Set Counter", purpose: "Counts", dir, wait: true });
    rmSync(dir, { recursive: true, force: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));

    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await agentToken()}` } } }));
    const calls = [7, 8, 9].map((to) => client.callTool({ name: "capabilities_invoke", arguments: { capabilityId: "set-counter", operation: "reset", input: { to } } }, undefined, { timeout: 120_000 }));
    for (let i = 0; i < 20 && (await sv.admin("call", { method: "confirmations", args: [] }).catch(() => ({ result: [] }))).result?.length < 3; i++) await new Promise((r) => setTimeout(r, 250));
    await page.goto(`${web}/#/activity`);
    await page.waitForFunction(() => document.title === "(3) Hewn", undefined, { timeout: 20_000 });
    const banner = page.locator(".blocking-banner:not([hidden])", { hasText: "is waiting for you" });
    await banner.getByRole("button", { name: "Review" }).click();
    const sheet = page.locator("dialog[open]", { hasText: "wants to reset" });
    await sheet.getByText("2 more calls like it waiting").waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-allow-all.png" });
    await sheet.getByRole("button", { name: "Allow all 3" }).click();
    const counts = (await Promise.all(calls)).map((r: any) => (r.isError ? r.content[0].text : JSON.parse(r.content[0].text).result.count));
    if (counts.join() !== "7,8,9") throw new Error(`the calls answered ${counts.join(" · ")}`);
    await page.waitForFunction(() => document.title === "Hewn", undefined, { timeout: 20_000 });
    await client.close();
    // Each is its own line in Activity (the page is on it already: drawn again).
    await page.reload();
    const allowed = page.locator("li", { hasText: "Let Claude Code run" }).filter({ hasText: "Set Counter" });
    await allowed.first().waitFor();
    if ((await allowed.count()) !== 3) throw new Error(`${await allowed.count()} lines in Activity, not 3`);
  });

  await step("an agent's change waits for the owner: the tool's tile says so and opens it, Later opens the tool as it is, Allow puts it live", async () => {
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await agentToken()}` } } }));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const pack = parse(await client.callTool({ name: "capabilities_pack", arguments: { kind: "modify", capabilityId: "ui-counter" } }));
    const files = pack.files
      .filter((f: { path: string }) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path))
      .map((f: { path: string; content: string }) => (f.path === "capability.json" ? { ...f, content: f.content.replace(/"purpose": "([^"]*)"/, '"purpose": "$1, and again"') } : f));
    const b = parse(await client.callTool({ name: "capabilities_submit", arguments: { files, capabilityId: "ui-counter", request: "Reword its purpose", baseVersion: pack.baseVersion } }));
    const held = parse(await client.callTool({ name: "builds_wait", arguments: { buildId: b.buildId, timeoutSeconds: 120 } }, undefined, { timeout: 150_000 }));
    if (held.status !== "review") throw new Error(held.log?.join("\n") ?? JSON.stringify(held));
    await client.close();
    await page.goto(`${web}/#/`);
    const tile = page.locator('.tile[aria-label="UI Counter, needs you"]');
    await tile.click();
    const card = page.locator(".card", { hasText: "It goes live only if you allow it." });
    await card.waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-held.png" });
    await card.getByRole("link", { name: "Later" }).click();
    await page.waitForURL(/#\/app\/ui-counter/);
    await page.goto(`${web}/#/`);
    await tile.click();
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await page.locator(".card", { hasText: "UI Counter is ready" }).getByRole("button", { name: "Open" }).click();
    await page.waitForURL(/#\/app\/ui-counter/);
    const now = (await sv.admin("call", { method: "list", args: [] })).result.find((c: any) => c.id === "ui-counter");
    if (!/, and again$/.test(now?.purpose)) throw new Error(`purpose ${now?.purpose}`);
  });

  await step("a held change with a warning: its file and line open the code at that line; Ask builder to fix opens the Change drawer with it in the box, says what it continues and sends nothing; closed unsent, the next Change is an ordinary one", async () => {
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await agentToken()}` } } }));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const pack = parse(await client.callTool({ name: "capabilities_pack", arguments: { kind: "modify", capabilityId: "ui-counter" } }));
    const files = pack.files
      .filter((f: { path: string }) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path))
      .map((f: { path: string; content: string }) => (f.path === "capability.json" ? { ...f, content: f.content.replace(/"purpose": "([^"]*)"/, '"purpose": "$1, once more"') } : f));
    const b = parse(await client.callTool({ name: "capabilities_submit", arguments: { files, capabilityId: "ui-counter", request: "Reword its purpose once more", baseVersion: pack.baseVersion } }));
    const held = parse(await client.callTool({ name: "builds_wait", arguments: { buildId: b.buildId, timeoutSeconds: 120 } }, undefined, { timeout: 150_000 }));
    if (held.status !== "review") throw new Error(held.log?.join("\n") ?? JSON.stringify(held));
    await client.close();
    // Nothing warns yet (0.4.13's checks bring the warnings): the card's build is given one, on a line of its code, and
    // its stream is cut so the page keeps that view.
    const warning = { check: "secret-scan", message: "A long random string: a key, or a hash that looks like one.", file: "src/index.ts", line: 3 };
    const own = new RegExp(`/api/builds/${held.buildId}(\\?.*)?$`);
    const events = new RegExp(`/api/builds/${held.buildId}/events`);
    await page.route(own, async (r: any) => {
      const res = await r.fetch();
      const j = await res.json();
      if (j.review) j.review.warnings = [warning];
      await r.fulfill({ response: res, json: j });
    });
    await page.route(events, (r: any) => r.abort());
    let sent = 0;
    const count = (r: any) => void (/\/api\/intake/.test(r.url()) && sent++);
    page.on("request", count);
    try {
      await page.goto(`${web}/#/b/${held.buildId}`);
      const card = page.locator(".card", { hasText: "It passed its checks with a warning." });
      await card.waitFor();
      await card.locator(".review-warning-at", { hasText: "src/index.ts:3" }).click();
      const line = card.locator(".review-files .code-line.hl");
      await line.waitFor();
      if ((await line.locator(".no").last().innerText()).trim() !== "3") throw new Error(`highlighted: ${await line.innerText()}`);
      await page.screenshot({ path: "/tmp/e2e-fr-held-warning.png" });
      await card.getByRole("button", { name: "Ask builder to fix" }).click();
      await page.waitForURL(new RegExp(`#/app/ui-counter\\?.*held=${held.buildId}`));
      await page.waitForFunction(() => /A long random string/.test((document.querySelector(".drawer textarea") as HTMLTextAreaElement | null)?.value ?? ""));
      const text = await page.locator(".drawer textarea").first().inputValue();
      if (!text.includes("(src/index.ts:3)")) throw new Error(text);
      await page.locator(".drawer .held-context", { hasText: "waiting for you" }).waitFor();
      await page.waitForTimeout(500);
      if (sent) throw new Error(`${sent} intake request(s) before Send`);
      // Closed unsent: the next Change is an ordinary one, not built on the held change.
      await page.locator(".drawer").getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: /^Change/ }).first().click();
      await page.locator(".drawer textarea").first().waitFor();
      if (await page.locator(".drawer .held-context").count()) throw new Error("the held row came back");
      if ((await page.locator(".drawer textarea").first().inputValue()).trim()) throw new Error("the box kept the fix");
      if (/held=/.test(page.url())) throw new Error(page.url());
    } finally {
      page.off("request", count);
      await page.unroute(own);
      await page.unroute(events);
    }
    // Put aside.
    const rejected = await page.evaluate(async (id: string) => (await fetch(`/api/builds/${id}/reject`, { method: "POST", headers: { "x-hewn-ui": "1" } })).status, held.buildId);
    if (rejected !== 200) throw new Error(`reject: ${rejected}`);
  });

  await step("Try it on a held change: its screen on a copy of your data; a write stays in the copy; gone once you decide", async () => {
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await agentToken()}` } } }));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const pack = parse(await client.callTool({ name: "capabilities_pack", arguments: { kind: "modify", capabilityId: "ui-counter" } }));
    const files = pack.files
      .filter((f: { path: string }) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path))
      .map((f: { path: string; content: string }) => (f.path === "capability.json" ? { ...f, content: f.content.replace(/"purpose": "([^"]*)"/, '"purpose": "$1, to try"') } : f));
    const b = parse(await client.callTool({ name: "capabilities_submit", arguments: { files, capabilityId: "ui-counter", request: "Reword its purpose, to try", baseVersion: pack.baseVersion } }));
    const held = parse(await client.callTool({ name: "builds_wait", arguments: { buildId: b.buildId, timeoutSeconds: 120 } }, undefined, { timeout: 150_000 }));
    if (held.status !== "review") throw new Error(held.log?.join("\n") ?? JSON.stringify(held));
    await client.close();
    const live = async () => (await sv.admin("invoke", { capabilityId: "ui-counter", operation: "get", input: {} })).result.count as number;
    const before = await live();
    await page.goto(`${web}/#/b/${held.buildId}`);
    await page.getByRole("button", { name: "Try it" }).click();
    await page.waitForURL(new RegExp(`#/b/${held.buildId}/try$`));
    await page.locator(".try-bar", { hasText: "on a copy of your data" }).waitFor();
    const app = page.frameLocator("iframe.app-frame");
    await app.locator("#inc").click();
    await app.locator("#inc").click();
    await app.locator("#n", { hasText: String(before + 2) }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: "/tmp/e2e-fr-try-it.png" });
    // No popups for code the owner hasn't allowed, in the frame's attribute and in its page's CSP.
    if (/allow-popups/.test((await page.locator("iframe.app-frame").getAttribute("sandbox")) ?? "")) throw new Error("Try it's frame allows popups");
    // A reload goes on with the same copy: it doesn't make a new one.
    await page.reload();
    await page.frameLocator("iframe.app-frame").locator("#n", { hasText: String(before + 2) }).waitFor({ timeout: 10_000 });
    if ((await live()) !== before) throw new Error("a write in Try it reached the owner's data");
    // Decided: the copy goes, and its address with it.
    await page.getByRole("link", { name: "Back to the review" }).click();
    await page.getByRole("button", { name: "Don't allow" }).click();
    await page.waitForTimeout(500);
    const after = await page.evaluate(async (id: string) => (await fetch(`/api/builds/${id}/try`, { method: "POST", headers: { "x-hewn-ui": "1" } })).status, held.buildId);
    if (after !== 409) throw new Error(`Try it after the decision: ${after}`);
    if ((await live()) !== before) throw new Error("the owner's data changed");
  });

  await step("a tool from a file: Share… shows its sample data, and opens on the version on screen", async () => {
    const files = { ...readTree(SEED), "sample/calls.json": Buffer.from(JSON.stringify([{ operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500 } }])) };
    const zip = packBundle(files, { format: 1, hewn: "e2e", abi: "2.0", exportedAt: new Date().toISOString(), tool: { id: "running-log", version: 1, hash: "d".repeat(64) } });
    const installed = await sv.admin("install", { bundle: Buffer.from(zip).toString("base64"), name: "Shared Log", wait: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    const changed = await sv.admin("modify", { capabilityId: "shared-log", request: "a second version", wait: true });
    if (changed.status !== "promoted") throw new Error(changed.log?.join("\n"));
    await page.goto(`${web}/#/c/shared-log`);
    await page.locator(".pill", { hasText: "from a file · Running Log v1" }).waitFor();
    await page.getByRole("button", { name: "Share…" }).click();
    let sheet = page.locator("dialog[open]", { hasText: "Share Shared Log" });
    // v2 is the scripted builder's copy of the Running Log seed, with the seed's own sample data.
    await sheet.getByText(/sample\/calls\.json · \d+ calls? · /).waitFor();
    if ((await sheet.getByLabel("Version").inputValue()) !== "2") throw new Error("Info's Share… isn't on the live version");
    if (await sheet.getByRole("button", { name: "Download" }).isDisabled()) throw new Error("Download is off");
    // From a file without a license: all rights reserved, and the row says why; picking MIT shows the copyright line, never the owner's name on it.
    await sheet.getByText("It arrived without a license.", { exact: false }).waitFor();
    if ((await sheet.getByLabel("License").inputValue()) !== "none") throw new Error("a tool from a file without a license isn't at all rights reserved");
    await sheet.getByLabel("License").selectOption("MIT");
    await sheet.getByText(/^Copyright \(c\) \d{4} the .+ authors$/).waitFor();
    await sheet.getByText("Someone else's work: the notice it came with goes with it.").waitFor();
    await sheet.getByLabel("License").selectOption("none");
    await sheet.getByText("It arrived without a license.", { exact: false }).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-share.png" });
    await sheet.getByRole("button", { name: "Done" }).click();
    await page.goto(`${web}/#/c/shared-log/v/1`);
    // The router holds Info (with its own Share…) until the version page is ready: wait for it.
    await page.locator("main.version-layout .version-what").waitFor();
    await page.getByRole("button", { name: "Share…" }).click();
    sheet = page.locator("dialog[open]", { hasText: "Share Shared Log" });
    await sheet.getByText(/sample\/calls\.json/).waitFor();
    if ((await sheet.getByLabel("Version").inputValue()) !== "1") throw new Error("a version page's Share… isn't on that version");
    // No public address yet: the Link row says so, and where to set one up.
    await sheet.getByText("Links need a public address").waitFor();
    await sheet.getByRole("button", { name: "Set up remote access ›" }).waitFor();
    await sheet.getByRole("button", { name: "Done" }).click();
  });

  await step("Share… › Link: a link to one version, Never in red, served on the public listener with the robots header, counted, then revoked", async () => {
    await sv.admin("call", { method: "setPublicUrl", args: ["https://hewn.example.com"] });
    await page.goto(`${web}/#/c/shared-log`);
    // The router holds the version page (with its own Share…) until Info is ready: wait for Info.
    await page.locator("main.version-layout").waitFor({ state: "detached" });
    await page.locator(".pill", { hasText: "from a file · Running Log v1" }).waitFor();
    await page.getByRole("button", { name: "Share…" }).click();
    const sheet = page.locator("dialog[open]", { hasText: "Share Shared Log" });
    await sheet.getByText(/sample\/calls\.json · \d+ calls? · /).waitFor();
    if ((await sheet.getByLabel("Version").inputValue()) !== "2") throw new Error("Share… isn't on the live version");
    await sheet.locator("li", { hasText: "Anyone with it can install this version" }).getByRole("button", { name: "Create…" }).click();
    const link = page.locator("dialog[open]", { hasText: "Link to Shared Log v2" });
    await link.getByRole("button", { name: "7 days" }).and(link.locator("[aria-pressed=true]")).waitFor();
    await link.getByRole("button", { name: "Never" }).click();
    await link.getByText("Anyone with this link can install this tool until you revoke it.").waitFor();
    await link.getByRole("button", { name: "Create link" }).click();
    const url = await link.getByLabel("The link").inputValue();
    const m = /^https:\/\/hewn\.example\.com\/share\/([A-Za-z0-9_-]{32,})$/.exec(url);
    if (!m) throw new Error(`the link: ${url}`);
    await page.screenshot({ path: "/tmp/e2e-fr-link.png" });
    await link.getByRole("button", { name: "Done" }).click();
    // The public listener answers it on any host (a tunnel's too), with the bundle and the robots header.
    const pub = `http://127.0.0.1:${publicPort}`;
    const res = await fetch(`${pub}/share/${m[1]}`, { headers: { host: "hewn.example.com" } });
    if (res.status !== 200 || res.headers.get("content-type") !== "application/zip" || res.headers.get("x-robots-tag") !== "noindex, nofollow") throw new Error(`share link: ${res.status} ${[...res.headers].join(" ")}`);
    if (!/attachment; filename="shared-log\.hewn\.zip"/.test(res.headers.get("content-disposition") ?? "")) throw new Error(`disposition: ${res.headers.get("content-disposition")}`);
    if ((await res.arrayBuffer()).byteLength < 100) throw new Error("an empty bundle");
    if ((await (await fetch(`${pub}/robots.txt`)).text()) !== "User-agent: *\nDisallow: /share/\n") throw new Error("robots.txt");
    // Share… lists it: its version, until revoked, one download; Revoke, and it 404s.
    await sheet.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Share…" }).click();
    const again = page.locator("dialog[open]", { hasText: "Share Shared Log" });
    const row = again.locator("li", { hasText: "until you revoke it · 1 download" });
    await row.waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-links.png" });
    await row.getByRole("button", { name: "Revoke" }).click();
    await page.locator("dialog[open]", { hasText: "Revoke this link?" }).getByRole("button", { name: "Revoke" }).click();
    await row.waitFor({ state: "detached" });
    const gone = await fetch(`${pub}/share/${m[1]}`);
    if (gone.status !== 404 || gone.headers.get("x-robots-tag") !== "noindex, nofollow") throw new Error(`after Revoke: ${gone.status}`);
    await again.getByRole("button", { name: "Done" }).click();
    await sv.admin("call", { method: "setPublicUrl", args: [null] });
  });

  await step("Activity shows who changed authority, and when, and an install from a file", async () => {
    await page.goto(`${web}/#/activity`);
    await page.getByText("Connected Claude Code").waitFor();
    await page.getByText(/Let Claude Code run/).first().waitFor();
    await page.getByText("Installed from a file · v1").waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-activity.png", fullPage: true });
  });

  await step("a hidden tab makes no requests: its refreshes wait, then go when it's shown, marked as refreshes", async () => {
    await page.goto(`${web}/#/`);
    await page.locator(".home-grid").waitFor();
    const seen: string[] = [];
    const watch = (r: { url(): string }) => r.url().includes("/api/") && seen.push(r.url());
    page.on("request", watch);
    await page.evaluate(() => {
      let hidden = true;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      (window as any).__show = () => ((hidden = false), document.dispatchEvent(new Event("visibilitychange")));
      document.dispatchEvent(new Event("visibilitychange"));
      // A page's own refresh, as Home's poll makes it.
      const kit = "/kit.js";
      void import(kit).then((k) => k.api("/capabilities", { refresh: true }));
    });
    await page.waitForTimeout(1500);
    if (seen.length) throw new Error(`a hidden tab asked for ${seen.join(", ")}`);
    const asked = page.waitForRequest((r: { url(): string }) => r.url().endsWith("/api/capabilities"));
    await page.evaluate(() => (window as any).__show());
    const r = await asked;
    if (r.headers()["x-hewn-refresh"] !== "1") throw new Error("a refresh without the x-hewn-refresh header");
    page.off("request", watch);
  });

  await step("a page from before an update stops its own refreshes: it says Hewn was updated, with Reload; the owner's own requests still go, and Reload brings the refreshes back", async () => {
    // A page of its own, signed in, for its fake clock.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    await ctx.addCookies(await page.context().cookies());
    const p = await ctx.newPage();
    try {
      // Hewn updated under the page: the same server, answering with another web build.
      let updated = false;
      await p.route("**/api/**", async (r: any) => {
        const res = await r.fetch();
        await r.fulfill({ response: res, headers: { ...res.headers(), ...(updated ? { "x-hewn-web": "0123456789abcdef" } : {}) } });
      });
      const refreshes: string[] = [];
      const owners: string[] = [];
      p.on("request", (r: { url(): string; headers(): Record<string, string> }) => r.url().includes("/api/") && (r.headers()["x-hewn-refresh"] === "1" ? refreshes : owners).push(r.url()));
      await p.clock.install();
      await p.goto(`${web}/#/`);
      await p.locator(".home-grid").waitFor();
      const run = async (ms: number) => {
        for (let t = 0; t < ms; t += 5000) await p.clock.runFor(5000), await p.waitForTimeout(100);
      };
      await run(60_000);
      if (!refreshes.length) throw new Error("no refreshes on Home before the update");
      // The update lands while the tab is hidden and a poll waits for it to be shown: that poll never goes, and
      // the owner's own look at the tools doesn't wait on it.
      await p.evaluate(async () => {
        let hidden = true;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
        (window as any).__show = () => ((hidden = false), document.dispatchEvent(new Event("visibilitychange")));
        document.dispatchEvent(new Event("visibilitychange"));
        const kit = "/kit.js";
        const k = await import(kit);
        k.invalidateCaps();
        void k.caps(true, { poll: true });
      });
      updated = true;
      await p.evaluate(async () => {
        const kit = "/kit.js";
        const k = await import(kit);
        await k.api("/settings");
        (window as any).__show();
      });
      refreshes.length = 0;
      // (The page's clock is fake: the wait is real, outside it.)
      await p.evaluate(async () => {
        const kit = "/kit.js";
        const k = await import(kit);
        void k.caps().then((m: Map<string, unknown>) => ((window as any).__looked = m.size));
      });
      await p.waitForTimeout(2000);
      if (typeof (await p.evaluate(() => (window as any).__looked)) !== "number") throw new Error("the owner's own look at the tools waited on a poll that never goes");
      await run(30_000);
      const toast = p.locator(".toast", { hasText: "Hewn was updated" });
      await toast.waitFor({ timeout: 5000 });
      if ((await toast.getByRole("button").allInnerTexts()).join() !== "Reload") throw new Error("the toast's only action isn't Reload");
      refreshes.length = 0;
      await run(180_000);
      if (refreshes.length) throw new Error(`an outdated page refreshed itself: ${refreshes.join(", ")}`);
      if ((await toast.count()) !== 1) throw new Error("the toast went away, or came again");
      // The owner's own requests still go: open Activity.
      owners.length = 0;
      await p.goto(`${web}/#/activity`);
      await p.getByText("Activity").first().waitFor();
      if (!owners.length) throw new Error("the owner's own request didn't go");
      await run(60_000);
      if (refreshes.length) throw new Error(`Activity, outdated, refreshed itself: ${refreshes.join(", ")}`);
      // Opening the Inbox is the owner's: it goes.
      owners.length = 0;
      await p.getByRole("button", { name: /^Inbox/ }).click();
      await p.waitForTimeout(500);
      if (!owners.some((u) => u.includes("/api/inbox"))) throw new Error("opening the Inbox didn't ask for it");
      await p.keyboard.press("Escape");
      await p.screenshot({ path: "/tmp/e2e-fr-stale-tab.png" });
      updated = false;
      await toast.getByRole("button", { name: "Reload" }).click();
      await p.waitForLoadState();
      for (let i = 0; i < 12 && !refreshes.length; i++) await run(5000);
      if (!refreshes.length) throw new Error("no refreshes after Reload");
      if (await p.locator(".toast", { hasText: "Hewn was updated" }).count()) throw new Error("the toast is still there after Reload");
    } finally {
      await ctx.close();
    }
  });

  await step("Home redrawn by its own poll (a tool added elsewhere) makes the page's own requests only: none counts as the owner's activity", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    await ctx.addCookies(await page.context().cookies());
    const p = await ctx.newPage();
    try {
      // The owner's requests: an API request without the refresh header, but for what the server leaves out itself
      // (surface/index.ts's PAGE_OWN_FETCHES: a build's events, a tool's or a build's icon).
      const PAGE_OWN_FETCHES = /^\/api\/(builds\/[^/]+\/events|(capabilities|builds)\/[^/]+\/icon)$/;
      const owners: string[] = [];
      p.on("request", (r: { url(): string; method(): string; headers(): Record<string, string> }) => {
        const path = new URL(r.url()).pathname;
        if (path.startsWith("/api/") && r.headers()["x-hewn-refresh"] !== "1" && !PAGE_OWN_FETCHES.test(path)) owners.push(`${r.method()} ${path}`);
      });
      await p.clock.install();
      await p.goto(`${web}/#/`);
      await p.locator(".home-grid").waitFor();
      await p.waitForTimeout(1000);
      owners.length = 0;
      // A tool added elsewhere (an agent's, the CLI's): Home's next poll sees it and redraws.
      const added = await sv.admin("install", { name: "Probe", purpose: "Probes", dir: join(FIX, "probe"), wait: true });
      if (added.status !== "promoted") throw new Error(added.log.join("\n"));
      for (let t = 0; t < 70_000; t += 5000) await p.clock.runFor(5000), await p.waitForTimeout(100);
      await p.locator(".home-grid .tile", { hasText: "Probe" }).first().waitFor({ timeout: 5000 });
      if (owners.length) throw new Error(`Home's own redraw asked as the owner: ${owners.join(", ")}`);
      // The other way round: a redraw the owner causes (Edit Home, Done) asks as the owner.
      await p.keyboard.press("e");
      await p.getByRole("button", { name: "Done" }).click();
      await p.waitForTimeout(1000);
      if (!owners.includes("GET /api/home")) throw new Error(`the owner's redraw didn't ask as the owner: ${owners.join(", ")}`);
    } finally {
      // Gone again: the steps after this one see the tools they did before it.
      await p.evaluate(() => fetch("/api/capabilities/probe", { method: "DELETE", headers: { "x-hewn-ui": "1" } })).catch(() => {});
      await ctx.close();
    }
  });

  if (!real)
    await step("a build's page whose stream ends without done doesn't reconnect it; the page's tick opens it again after a minute and carries it to the end", async () => {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      // A page of its own, signed in, for its fake clock.
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      await ctx.addCookies(await page.context().cookies());
      const p = await ctx.newPage();
      try {
        await p.goto(`${web}/#/`);
        const id = await p.evaluate(async () => ((await (await fetch("/api/capabilities", { headers: { "x-hewn-ui": "1" } })).json()) as { id: string; name: string }[]).find((c) => c.name === "Reading List")!.id);
        const b = await p.evaluate(async (id: string) => (await fetch(`/api/capabilities/${id}/modify`, { method: "POST", headers: { "x-hewn-ui": "1", "content-type": "application/json" }, body: JSON.stringify({ request: "Add a line" }) })).json(), id);
        // As a proxy or a restart cuts it: one line, then the end, and a browser would retry in 200 ms. The second time,
        // the stream's own wait runs out first: "done" with the build still running.
        let n = 0;
        // Read through a function: TypeScript doesn't see the route's handler change it.
        const opened = () => n;
        const cut = 'retry: 200\nevent: line\ndata: "12:00:00 cut off"\n\n';
        await p.route("**/api/builds/*/events", (r: any) => (n++, r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: n === 2 ? `${cut}event: done\ndata: ${JSON.stringify({ ...b, status: "building" })}\n\n` : cut })));
        // The page's own clock, so a minute passes at once (the requests are real).
        await p.clock.install();
        await p.goto(`${web}/#/b/${b.buildId}`);
        await p.getByText("cut off").waitFor({ state: "attached" });
        await p.waitForTimeout(1500);
        if (opened() !== 1) throw new Error(`the events stream was opened ${opened()} times`);
        const run = async (ms: number) => {
          for (let t = 0; t < ms; t += 4000) await p.clock.runFor(4000), await p.waitForTimeout(100);
        };
        await run(48_000);
        if (opened() !== 1) throw new Error(`opened again within the minute (${opened()})`);
        await run(16_000);
        if (opened() !== 2) throw new Error(`not opened again once after a minute (${opened()})`);
        // The second one replays the log in place of the first.
        if ((await p.locator("pre", { hasText: "cut off" }).first().innerText()).split("cut off").length !== 2) throw new Error("the replayed log doubled");
        await run(48_000);
        if (opened() !== 2) throw new Error(`opened again within the minute after a done that wasn't the end (${opened()})`);
        await run(16_000);
        if (opened() !== 3) throw new Error(`not opened again after a done that wasn't the end (${opened()})`);
        release();
        for (let i = 0; i < 15 && !(await p.getByText(/is ready|v2/).count()); i++) await run(4000);
        await p.getByText(/is ready|v2/).first().waitFor({ timeout: 5000 });
        if (opened() !== 3) throw new Error(`the events stream was opened ${opened()} times`);
      } finally {
        release();
        hold = Promise.resolve();
        await ctx.close();
      }
    });

  await step("a failed build: Discard takes it off the Inbox; Activity keeps it, marked discarded", async () => {
    // A tool whose own tests fail: installed from a directory, it fails on its own (no builder to ask).
    const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-broken-"));
    cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => Object.assign(m, { id: "broken-counter", name: "Broken Counter" }));
    writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([{ name: "never", operation: "get", input: {}, expect: { count: 99 } }]));
    const b = await sv.admin("install", { name: "Broken Counter", purpose: "Counts, wrongly", dir, wait: true });
    rmSync(dir, { recursive: true, force: true });
    if (b.status !== "failed") throw new Error(`expected a failed build, got ${b.status}`);
    const inInbox = () => page.evaluate(async (id: string) => ((await (await fetch("/api/inbox", { headers: { "x-hewn-ui": "1" } })).json()).needs as { buildId?: string }[]).some((n) => n.buildId === id), b.buildId);
    if (!(await inInbox())) throw new Error("the failed build isn't in the Inbox");
    await page.goto(`${web}/#/b/${b.buildId}`);
    await page.getByRole("button", { name: "Discard" }).click();
    await page.getByText("Discarded: it's out of the Inbox, and stays in Activity.").waitFor();
    if (await inInbox()) throw new Error("still in the Inbox after Discard");
    await page.goto(`${web}/#/activity`);
    // A create that never installed goes by its id.
    await page.locator("li", { hasText: "broken-counter" }).filter({ hasText: "discarded" }).first().waitFor();
  });

  await step("New: Stop puts the message back with Stopped., which goes once the next one is sent", async () => {
    // The intake never answers here (no CLI runs): each turn waits until it's stopped.
    await page.route("**/api/intake", () => {});
    await page.goto(`${web}/#/new`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("A tool to recall facts about me");
    await box.press("Enter");
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByText("Stopped.").waitFor();
    if ((await box.inputValue()) !== "A tool to recall facts about me") throw new Error(`box: ${await box.inputValue()}`);
    await box.press("Enter");
    await page.locator(".bubble.typing").waitFor();
    if (await page.getByText("Stopped.").count()) throw new Error("Stopped. still shown after sending again");
    // Stopped again: one note, not two.
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByText("Stopped.").waitFor();
    const notes = await page.getByText("Stopped.").count();
    if (notes !== 1) throw new Error(`${notes} Stopped. notes`);
    await page.unroute("**/api/intake");
  });
  await step("on a phone, an open tool's bar keeps ••• alone, which holds Change… (the drawer) and Share…, and the tool's name has the room (#116)", async () => {
    // What each tool bar shows (its items not hidden by the phone rule).
    const shown = () => page.locator(".tool-actions").first().locator(":scope > *").evaluateAll((els: Element[]) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => (e.textContent ?? "").trim()));
    await page.goto(`${web}/#/run/reading-list`);
    await page.locator(".tool-actions").waitFor();
    if ((await shown()).join("|") !== "Change…|Share…|•••") throw new Error(`desktop: ${await shown()}`);
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.goto(`${web}/#/run/reading-list`);
      await page.locator(".tool-actions").first().getByRole("button", { name: "More" }).waitFor();
      if ((await shown()).join("|") !== "•••") throw new Error(`the bar shows ${(await shown()).join(", ")}`);
      await page.locator(".tool-actions").first().getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Share…" }).waitFor({ timeout: 3000 });
      // •••'s Change… opens the drawer, as the bar's did: the tool stays where it is (no new page).
      await page.locator(".with-drawer").evaluate((e: Element) => e.setAttribute("data-e2e", "same"));
      await page.getByRole("menuitem", { name: "Change…" }).click();
      await page.locator(".drawer").waitFor();
      if (!(await page.locator(".with-drawer[data-e2e='same']").count())) throw new Error("•••'s Change… opened a new page");
      // Info's bar is as it was (no name in it to make room for).
      await page.goto(`${web}/#/c/reading-list`);
      await page.getByRole("link", { name: "Change…" }).waitFor();
      await page.goto(`${web}/#/run/reading-list`);
      const name = page.locator(".app-title > span").first();
      await name.waitFor();
      if (await name.evaluate((e: Element) => e.scrollWidth > e.clientWidth)) throw new Error(`the name is cut: ${await name.evaluate((e: Element) => e.clientWidth)} px for "${await name.textContent()}"`);
    } finally {
      await page.setViewportSize({ width: 1000, height: 900 });
    }
  });
  await step("a change goes live while the tool is open and its Change drawer closed: a toast says v… is ready, with Reload; the page waits for it (#110)", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const started = await sv.admin("modify", { capabilityId: "reading-list", request: "a version while the tool is open" });
    // The Inbox's poll (every 4 s while something builds) sees the build in flight: opening the Inbox polls at once.
    await page.goto(`${web}/#/`);
    await page.locator(".inbox-btn").click();
    await page.locator(".inbox-panel", { hasText: "Building" }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.goto(`${web}/#/run/reading-list`);
    const pill = page.locator(".app-title .pill");
    await pill.waitFor();
    const before = Number((await pill.textContent())!.slice(1));
    // Marked: a reload of the page would lose the mark.
    await page.locator(".with-drawer").evaluate((e: Element) => e.setAttribute("data-e2e", "same"));
    // A poll on this page while it builds, then the build ends: the next poll sees it gone.
    await page.waitForTimeout(4500);
    release();
    const toast = page.locator(".toast", { hasText: `v${before + 1} is ready` });
    await toast.waitFor({ timeout: 20_000 });
    if ((await pill.textContent()) !== `v${before + 1}`) throw new Error(`the bar says ${await pill.textContent()}`);
    if (!(await page.locator(".with-drawer[data-e2e='same']").count())) throw new Error("the page reloaded itself");
    // Said once: a look at the tab again doesn't say it twice.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(800);
    if ((await page.locator(".toast", { hasText: "is ready" }).count()) !== 1) throw new Error("the toast came twice");
    await toast.getByRole("button", { name: "Reload" }).click();
    await page.locator(".with-drawer:not([data-e2e])").waitFor();
    if (await page.locator(".toast", { hasText: "is ready" }).count()) throw new Error("the toast stayed after Reload");
    // A build that ends while the tab isn't looked at: the tab says so when it's looked at again.
    await sv.admin("modify", { capabilityId: "reading-list", request: "another one", wait: true });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator(".toast", { hasText: `v${before + 2} is ready` }).getByRole("button", { name: "Dismiss" }).click();
    // With the drawer open on its box (it follows no build, so it says nothing), the page says it.
    await page.goto(`${web}/#/run/reading-list?change=1`);
    await page.locator(".drawer").waitFor();
    await sv.admin("modify", { capabilityId: "reading-list", request: "a third one", wait: true });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator(".toast", { hasText: `v${before + 3} is ready` }).waitFor({ timeout: 10_000 });
    // Change… with the note up keeps it (the drawer's box says nothing of it).
    await page.locator(".drawer").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Change…" }).click();
    await page.locator(".drawer").waitFor();
    if (!(await page.locator(".toast", { hasText: `v${before + 3} is ready` }).count())) throw new Error("the note went when the drawer opened");
    await page.locator(".toast", { hasText: "is ready" }).getByRole("button", { name: "Dismiss" }).click();
    // A change built from the drawer: the drawer says it's ready, the page doesn't; closed without Reload, the page does.
    const draft = { kind: "draft", message: "A line more.", draft: { request: "One more line." } };
    await page.route("**/api/intake", (r: any) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: reply\ndata: ${JSON.stringify(draft)}\n\n` }));
    try {
      await page.goto(`${web}/#/run/reading-list?change=1`);
      const box = page.locator(".drawer").getByRole("textbox", { name: "Message" });
      await box.fill("One more line");
      await box.press("Enter");
      await page.locator(".drawer").getByRole("button", { name: /^Build/ }).click();
      await page.locator(".drawer .drawer-ready", { hasText: `v${before + 4} is ready` }).waitFor({ timeout: 20_000 });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForTimeout(800);
      if (await page.locator(".toast", { hasText: "is ready" }).count()) throw new Error("a note on the page while the drawer says it");
      await page.locator(".drawer").getByRole("button", { name: "Close" }).click();
      await page.locator(".toast", { hasText: `v${before + 4} is ready` }).waitFor({ timeout: 5000 });
    } finally {
      await page.unroute("**/api/intake");
    }
    if (!started.buildId) throw new Error("no build");
  });
  const waitBuildDone = async (id: string) => {
    for (let i = 0; i < 120; i++, await page.waitForTimeout(250)) if (!["waiting", "open", "building", "validating"].includes((await sv.admin("call", { method: "getBuild", args: [id] })).result.status)) return;
    throw new Error(`build ${id} still running`);
  };
  await step("a change goes with the model on its box's chip, even if another tab changed the setting; looked at again, the chip shows the setting (#111)", async () => {
    const models = (m: Record<string, string>) => ({ builder: { claude: m }, intake: { claude: m } });
    await sv.admin("settings", { jobModels: models({ model: "fable", effort: "high" }) });
    // The intake answers with a change to build (it's stubbed here).
    const draft = { kind: "draft", message: "A line more.", draft: { request: "Add a line to each run." } };
    await page.route("**/api/intake", (r: any) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: reply\ndata: ${JSON.stringify(draft)}\n\n` }));
    try {
      // Looked at again, a box's chip shows what's set now (another tab may have changed it).
      await page.goto(`${web}/#/new`);
      const newChip = page.locator(".model-chip");
      await newChip.getByText(/Fable/).waitFor();
      await sv.admin("settings", { jobModels: models({ model: "opus" }) });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await newChip.getByText(/Opus/).waitFor({ timeout: 5000 });
      if (await newChip.getByText(/high/).count()) throw new Error("the chip kept the old effort");
      await sv.admin("settings", { jobModels: models({ model: "fable", effort: "high" }) });
      await page.goto(`${web}/#/run/reading-list?change=1`);
      const chip = page.locator(".drawer .model-chip");
      await chip.getByText(/Fable/).waitFor();
      await chip.getByText(/high/).waitFor();
      // Another tab picks another model: the setting changes, this tab's chip doesn't know yet.
      await sv.admin("settings", { jobModels: models({ model: "opus" }) });
      const box = page.locator(".drawer").getByRole("textbox", { name: "Message" });
      await box.fill("Add a line to each run");
      await box.press("Enter");
      await page.locator(".drawer").getByRole("button", { name: /^Build/ }).click();
      const b = await (async () => {
        for (let i = 0; i < 40; i++, await page.waitForTimeout(250)) {
          const st = await sv.admin("status");
          const x = st.builds.find((y: any) => y.capabilityId === "reading-list" && y.request?.request === "Add a line to each run.");
          if (x) return x;
        }
        throw new Error("no build");
      })();
      if (b.model?.model !== "fable" || b.model?.effort !== "high") throw new Error(`the build asked for ${JSON.stringify(b.model)}, not the chip's fable · high`);
      await waitBuildDone(b.buildId);
    } finally {
      await page.unroute("**/api/intake");
      await sv.admin("settings", { jobModels: models({ model: "fable", effort: "high" }) });
    }
  });
  await step("a link in a tool's own screen to one of Hewn's pages opens it signed in, here or in a new tab as it asks, and never sends for the owner (#114)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-e2e-links-"));
    cpSync(join(FIX, "ui-counter"), dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => Object.assign(m, { id: "link-counter", name: "Link Counter" }));
    writeFileSync(
      join(dir, "ui", "index.html"),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Links</title><link rel="stylesheet" href="/_platform/ui.css"></head>
<body><main class="page stack"><h1>Links</h1>
<a id="here" href="/#/activity">Activity</a>
<a id="tab" href="/#/c/link-counter" target="_blank">Info</a>
<a id="send" href="/#/new?m=Hello%20from%20a%20tool&send=1">Ask</a>
<a id="api" href="/api/capabilities">API</a>
<a id="own" href="#more">More</a></main>
<script>if (location.hash === "#unasked") setTimeout(() => ((document.body.dataset.asked = "1"), parent.postMessage({ hewn: 1, type: "open", url: new URL("/#/settings", location.href).href }, "*")), 300)</script></body></html>`,
    );
    const installed = await sv.admin("install", { name: "Link Counter", purpose: "Links", dir, wait: true });
    if (installed.status !== "promoted") throw new Error(installed.log?.join("\n"));
    const frame = page.frameLocator("iframe.app-frame");
    // An open the tool posts by itself (no click in it) goes nowhere. Only at #unasked, so no later screen of the tool
    // posts one while a click of the step's makes it look asked for (a click there gives the frame focus and activation).
    await page.goto(`${web}/#/app/link-counter?at=unasked`);
    await frame.locator("body[data-asked]").waitFor();
    await page.waitForTimeout(500);
    if (!page.url().endsWith("#/app/link-counter?at=unasked")) throw new Error(`an open without a click went to ${page.url()}`);
    // A link to something of Hewn's that isn't a page of the web client: nothing opens.
    await frame.locator("#api").click();
    await page.waitForTimeout(500);
    if (!page.url().endsWith("#/app/link-counter?at=unasked") || page.context().pages().length !== 1) throw new Error(`the API link opened ${page.url()}`);
    // Its own link stays in its frame.
    await frame.locator("#own").click();
    await page.waitForTimeout(300);
    if (!page.url().endsWith("#/app/link-counter?at=unasked")) throw new Error(`its own link left the tool: ${page.url()}`);
    // Here: the web client goes to the page, signed in (no sign-in page).
    await frame.locator("#here").click();
    await page.waitForURL(/#\/activity$/);
    await page.locator("main").getByText("Activity").first().waitFor();
    if (await page.getByText(/Signed out|Sign in/).count()) throw new Error("a sign-in page");
    // A new tab, as the link asks: signed in there too.
    await page.goto(`${web}/#/app/link-counter`);
    const [tab] = await Promise.all([page.context().waitForEvent("page"), frame.locator("#tab").click()]);
    await tab.waitForLoadState();
    if (!tab.url().endsWith("#/c/link-counter")) throw new Error(`the new tab is at ${tab.url()}`);
    await tab.getByRole("heading", { name: "Link Counter" }).first().waitFor({ timeout: 10_000 });
    if (await tab.getByText(/Signed out|Sign in/).count()) throw new Error("the new tab has a sign-in page");
    await tab.close();
    // A link that would write in the owner's box and send it: the page opens, the box is the owner's.
    await page.goto(`${web}/#/app/link-counter`);
    await frame.locator("#send").click();
    await page.waitForURL(/#\/new$/);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor();
    await page.waitForTimeout(500);
    if ((await box.inputValue()).includes("Hello from a tool")) throw new Error(`the tool wrote in the box: ${await box.inputValue()}`);
    if (await page.locator(".bubble.me").count()) throw new Error("a message was sent for the owner");
  });

  await step("a passkey sign-in goes back to the page it was asked on; from an address that isn't a page, Home (#114)", async () => {
    // The signed-out page with passkey sign-in (the public URL's), its server and the device stubbed.
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const loads: string[] = [];
    const signedOut = `<!doctype html><html><body><button id="passkey">Sign in with a passkey</button><p id="passkey-error" hidden></p><script type="module" src="/passkey.js"></script></body></html>`;
    await p.route(/\/(nowhere)?$/, (r: any) => (loads.push(new URL(r.request().url()).pathname), r.fulfill({ status: 401, contentType: "text/html", body: signedOut })));
    await p.route("**/passkey/options", (r: any) => r.fulfill({ json: { challenge: "AAAA", rpId: "hewn.localhost", userVerification: "preferred", timeout: 1000 } }));
    await p.route("**/passkey/signin", (r: any) => r.fulfill({ json: { ok: true } }));
    await p.addInitScript(() => {
      const fake = { id: "x", response: { clientDataJSON: new ArrayBuffer(1), authenticatorData: new ArrayBuffer(1), signature: new ArrayBuffer(1) } };
      (window as any).PublicKeyCredential ??= function () {};
      Object.defineProperty(navigator, "credentials", { value: { get: async () => fake, create: async () => fake } });
    });
    try {
      await p.goto(`${web}/#/c/reading-list`);
      await p.locator("#passkey").click();
      for (let i = 0; i < 40 && loads.length < 2; i++) await p.waitForTimeout(100);
      if (loads.join(" ") !== "/ /" || !p.url().endsWith("/#/c/reading-list")) throw new Error(`loads ${loads.join(" ")}, at ${p.url()}`);
      loads.length = 0;
      await p.goto(`${web}/nowhere`);
      await p.locator("#passkey").click();
      for (let i = 0; i < 40 && loads.length < 2; i++) await p.waitForTimeout(100);
      if (loads.join(" ") !== "/nowhere /") throw new Error(`loads ${loads.join(" ")}, at ${p.url()}`);
    } finally {
      await ctx.close();
    }
  });
} finally {
  await browser.close();
  await sv.stop();
  rmSync(root, { recursive: true, force: true });
  console.log(failed ? "E2E failed (screenshot: /tmp/e2e-fr-fail.png)" : "E2E passed");
  process.exit(failed ? 1 : 0);
}
