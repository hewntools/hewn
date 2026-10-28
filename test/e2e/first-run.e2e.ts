// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser E2E on a fresh workerd host (not part of npm test): the first run, an agent's
// approval (from the Inbox), choosing who builds, a starter build, the Hub, schedules, Info's own
// actions (Run, a rule, Deny then Authorize, Restore… cancelled), a version's Files, a destructive
// call confirmed from the banner, Share… on a tool installed from a file, and the authority trail on
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

// The builder: the Running Log seed, renamed to whatever was asked for; a change adds a line to it.
const builder: CapabilityBuilder = {
  name: "claude",
  build: async (job) => {
    cpSync(SEED, job.workspace, { recursive: true });
    editJson(join(job.workspace, "capability.json"), (m) => {
      m.id = job.capabilityId;
      m.name = job.capabilityId.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    });
    if (job.kind === "modify") appendFileSync(join(job.workspace, "src", "index.ts"), "// Changed by request.\n");
  },
};
const real = process.env.E2E_REAL_BUILDER === "1";
const sv = await startSupervisor({
  home: openHome(root),
  port,
  publicPort: await freePort(),
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
const agentToken = async () => {
  const poll = await (await fetch(`${base}/authorize/poll`, { method: "POST", body: new URLSearchParams({ id: agentReq!.id, secret: agentReq!.secret }) })).json();
  const code = new URL(poll.redirect).searchParams.get("code")!;
  const t = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: agentReq!.clientId, redirect_uri: redirect }) })).json();
  return t.access_token as string;
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
    await row.click();
    const sheet = page.locator("dialog[open]", { hasText: "Claude Code (hewn) wants to connect" });
    await sheet.waitFor();
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

  await step("the Hub: the Official tools, a tool's page, its Source code, Install opens the install sheet (cancelled); ⌘K has the Hub last", async () => {
    await page.locator("nav.main-nav").getByRole("link", { name: "Hub" }).click();
    await page.waitForURL(/#\/hub$/);
    await page.locator(".hub-card", { hasText: "Plant Log" }).waitFor();
    const cards = await page.locator(".hub-card").count();
    if (cards < 7) throw new Error(`${cards} tools on the Hub`);
    // The starter is a Reading List: the Hub's counts as yours (same id), so it offers Open and Install a copy.
    await page.locator(".hub-card", { hasText: "Reading List" }).getByText("Installed").waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-hub.png" });
    await page.locator(".hub-card", { hasText: "Plant Log" }).click();
    await page.waitForURL(/#\/hub\/plant-log$/);
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
    await sheet.getByText(/From Hub · Official/).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-hub-install.png" });
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await sheet.waitFor({ state: "detached" });
    await page.goto(`${web}/#/hub/reading-list`);
    await page.locator(".info-head").getByRole("button", { name: "Install a copy" }).waitFor();
    await page.locator(".info-head").getByRole("button", { name: "Open", exact: true }).waitFor();
    // ⌘K: "log" names Hub tools (Plant Log, Running Log) and finds Activity by its words; yours first, the Hub last.
    await page.getByRole("button", { name: "Search and commands" }).click();
    await page.getByPlaceholder("Search tools, pages and actions").fill("log");
    await page.locator(".palette-item", { hasText: "Plant Log" }).waitFor();
    const groups = await page.locator(".palette-group").allTextContents();
    if (groups.at(-1) !== "Hub" || groups.indexOf("Hub") !== groups.length - 1 || groups.length < 2) throw new Error(`groups: ${groups.join(", ")}`);
    await page.keyboard.press("Escape");
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
    await sheet.getByRole("button", { name: "Done" }).click();
  });

  await step("Activity shows who changed authority, and when, and an install from a file", async () => {
    await page.goto(`${web}/#/activity`);
    await page.getByText("Connected Claude Code").waitFor();
    await page.getByText(/Let Claude Code run/).waitFor();
    await page.getByText("Installed from a file · v1").waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-activity.png", fullPage: true });
  });
} finally {
  await browser.close();
  await sv.stop();
  rmSync(root, { recursive: true, force: true });
  console.log(failed ? "E2E failed (screenshot: /tmp/e2e-fr-fail.png)" : "E2E passed");
  process.exit(failed ? 1 : 0);
}
