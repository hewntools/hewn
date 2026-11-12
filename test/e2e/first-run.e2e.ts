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
    // Authorize waits for the setting with no suggestion; the suggested one counts as filled.
    const authorize = page.getByRole("button", { name: "Authorize" });
    if (await authorize.isEnabled()) throw new Error("Authorize enabled with REVIEWER empty");
    await reviewer.fill("Ada");
    await authorize.click();
    await page.locator(".pill.ok", { hasText: /^ready$/ }).waitFor();
    const r = await sv.admin("readiness", { capabilityId: "repo-counter" });
    if (!r.ready) throw new Error(`not ready after Save: ${JSON.stringify(r)}`);
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
    await page.getByText(/Let Claude Code run/).waitFor();
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
        // As a proxy or a restart cuts it: one line, then the end, and a browser would retry in 200 ms.
        let opened = 0;
        await p.route("**/api/builds/*/events", (r: any) => (opened++, r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: 'retry: 200\nevent: line\ndata: "12:00:00 cut off"\n\n' })));
        // The page's own clock, so a minute passes at once (the requests are real).
        await p.clock.install();
        await p.goto(`${web}/#/b/${b.buildId}`);
        await p.getByText("cut off").waitFor({ state: "attached" });
        await p.waitForTimeout(1500);
        if (opened !== 1) throw new Error(`the events stream was opened ${opened} times`);
        const run = async (ms: number) => {
          for (let t = 0; t < ms; t += 4000) await p.clock.runFor(4000), await p.waitForTimeout(100);
        };
        await run(48_000);
        if (opened !== 1) throw new Error(`opened again within the minute (${opened})`);
        await run(16_000);
        if (opened !== 2) throw new Error(`not opened again once after a minute (${opened})`);
        // The second one replays the log in place of the first.
        if ((await p.locator("pre", { hasText: "cut off" }).first().innerText()).split("cut off").length !== 2) throw new Error("the replayed log doubled");
        release();
        for (let i = 0; i < 15 && !(await p.getByText(/is ready|v2/).count()); i++) await run(4000);
        await p.getByText(/is ready|v2/).first().waitFor({ timeout: 5000 });
        if (opened !== 2) throw new Error(`the events stream was opened ${opened} times`);
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
} finally {
  await browser.close();
  await sv.stop();
  rmSync(root, { recursive: true, force: true });
  console.log(failed ? "E2E failed (screenshot: /tmp/e2e-fr-fail.png)" : "E2E passed");
  process.exit(failed ? 1 : 0);
}
