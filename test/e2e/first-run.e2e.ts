// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser E2E on a fresh workerd host (not part of npm test): the first run, an agent's
// approval (from the Inbox), choosing who builds, a starter build, schedules, a destructive call
// confirmed from the banner, and the authority trail on Activity. The builder is scripted (copies the Running Log seed);
// builder/intake checks are stubbed as installed and signed in, so it runs anywhere.
//
//   PLAYWRIGHT_NODE_MODULES=/path/to/node_modules/ node test/e2e/first-run.e2e.ts
// With E2E_REAL_BUILDER=1 the starter is built by the real builder (Claude Code, signed in on this
// machine) and the builder check is the real one: the first run as a new user has it.
// A Chromium-based browser must be installed (see `hewn doctor`, Visual check). Screenshots go to /tmp/e2e-fr-*.png.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { pkceChallenge } from "@hewntools/core/agents.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor } from "@hewntools/cli/supervisor/index.ts";
import { BUILDERS } from "@hewntools/cli/builders/cli-agents.ts";
import { findBrowser } from "@hewntools/cli/visual.ts";
import { editJson, SEED } from "../helpers.ts";
import { freePort } from "../workerd-helpers.ts";

const FIX = resolve(import.meta.dirname, "../fixtures");
const pw = createRequire(process.env.PLAYWRIGHT_NODE_MODULES ?? import.meta.url)("playwright-core");
const root = mkdtempSync(join(tmpdir(), "hewn-e2e-"));
const port = await freePort();

// The builder: the Running Log seed, renamed to whatever was asked for.
const builder: CapabilityBuilder = {
  name: "claude",
  build: async (job) => {
    cpSync(SEED, job.workspace, { recursive: true });
    editJson(join(job.workspace, "capability.json"), (m) => {
      m.id = job.capabilityId;
      m.name = job.capabilityId.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    });
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
    await sheet.locator("label.job-option", { hasText: "Fable" }).locator("input").check();
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

  await step("schedules: Info › Schedules, add one daily, see the next run, pause it", async () => {
    await page.goto(`${web}/#/c/reading-list`);
    await page.locator(".info-row", { hasText: "Schedules" }).click();
    const sheet = page.locator("dialog[open]", { hasText: "Schedules · Reading List" });
    await sheet.getByText("Nothing runs on a timetable.").waitFor();
    // A read operation (list…/get…) needs no input; others may require some.
    const ops = await sheet.getByLabel("Operation", { exact: true }).locator("option").evaluateAll((els: HTMLOptionElement[]) => els.map((e) => e.value));
    const op = ops.find((o: string) => /^(list|get)/.test(o)) ?? ops[0];
    await sheet.getByLabel("Operation", { exact: true }).selectOption(op!);
    await sheet.getByLabel("At", { exact: true }).fill("07:30");
    await sheet.getByRole("button", { name: "Add schedule" }).click();
    const row = sheet.locator("li", { hasText: op });
    await row.getByText(/Daily 07:30 · next /).waitFor();
    await row.getByRole("checkbox", { name: "On" }).uncheck();
    await row.getByText(/paused/).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-schedules.png" });
    await sheet.getByRole("button", { name: "Done" }).click();
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

  await step("Activity shows who changed authority, and when", async () => {
    await page.goto(`${web}/#/activity`);
    await page.getByText("Connected Claude Code").waitFor();
    await page.getByText(/Let Claude Code run/).waitFor();
    await page.screenshot({ path: "/tmp/e2e-fr-activity.png", fullPage: true });
  });
} finally {
  await browser.close();
  await sv.stop();
  rmSync(root, { recursive: true, force: true });
  console.log(failed ? "E2E failed (screenshot: /tmp/e2e-fr-fail.png)" : "E2E passed");
  process.exit(failed ? 1 : 0);
}
