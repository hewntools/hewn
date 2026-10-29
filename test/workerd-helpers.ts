// SPDX-License-Identifier: AGPL-3.0-or-later
// Starting the real workerd host (supervisor + workerd) for integration tests.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RemoteJobs } from "@hewntools/cli/builders/remote.ts";
import type { Intake } from "@hewntools/cli/intake.ts";
import type { Hosted } from "@hewntools/cli/supervisor/index.ts";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { pkceChallenge } from "@hewntools/core/agents.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor, type Supervisor } from "@hewntools/cli/supervisor/index.ts";
import type { Script } from "./helpers.ts";

export const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

export const parse = (r: any) => JSON.parse(r.content[0].text);

/**
 * Start a supervisor on two ports that were free a moment ago. On a busy machine another process can
 * take one before workerd binds it: workerd then exits at once, again and again, and the start fails
 * (startSupervisor leaves nothing running). That start gets one more go, on new ports. A start that
 * fails otherwise says why: the supervisor's log comes with the error.
 */
export async function onFreePorts(start: (ports: { port: number; publicPort: number }, log: (line: string) => void) => Promise<Supervisor>): Promise<{ sv: Supervisor; port: number }> {
  for (let attempt = 1; ; attempt++) {
    let lines: string[] | undefined = [];
    const port = await freePort();
    try {
      const sv = await start({ port, publicPort: await freePort() }, (l) => void lines?.push(l));
      lines = undefined; // only the start's log is kept
      return { sv, port };
    } catch (e) {
      if (attempt === 1 && lines!.some((l) => l.includes("Address already in use"))) continue;
      throw new Error(`${(e as Error).message}; the supervisor's log:\n${lines!.slice(-20).join("\n")}`);
    }
  }
}

/**
 * An agent signs in the way real ones do: dynamic registration, the authorize page, the owner's
 * approval (here over the admin channel), the page's poll, the PKCE code exchange.
 */
export async function oauthToken(base: string, admin: Supervisor["admin"], name: string, scopes: string[]): Promise<string> {
  const redirect = "http://127.0.0.1:59998/callback";
  const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json();
  const verifier = "test-verifier-".padEnd(60, "x");
  const q = new URLSearchParams({ client_id: reg.client_id, response_type: "code", redirect_uri: redirect, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", scope: scopes.join(" "), state: "s" });
  const page = await (await fetch(`${base}/authorize?${q}`)).text();
  const id = /id:"([^"]+)"/.exec(page)![1];
  const secret = /secret:"([^"]+)"/.exec(page)![1];
  await admin("call", { method: "decideAgent", args: [id, { approve: true, name, scopes }] });
  const poll = await (await fetch(`${base}/authorize/poll`, { method: "POST", body: new URLSearchParams({ id, secret }) })).json();
  const code = new URL(poll.redirect).searchParams.get("code")!;
  const tokens = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }) })).json();
  if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  return tokens.access_token;
}

export interface TestHost {
  sv: Supervisor;
  root: string;
  port: number;
  /** Queue builder scripts (the platform builder, played by the test). */
  queue: (...s: Script[]) => void;
  invoke: (capabilityId: string, operation: string, input?: unknown, operationVersion?: number) => Promise<any>;
  /** An MCP client for an agent with these scopes. */
  agent: (id: string, scopes: string[]) => Promise<Client>;
  stop: () => Promise<void>;
}

export async function startTestHost(opts: { attempts?: number; publicListen?: string; proxySecret?: string; remote?: RemoteJobs; hosted?: Hosted; intake?: Intake } = {}): Promise<TestHost> {
  const root = mkdtempSync(join(tmpdir(), "hewn-workerd-"));
  const scripts: Script[] = [];
  const scripted: CapabilityBuilder = {
    name: "claude",
    build: async (job) => {
      const s = scripts.shift();
      if (!s) throw new Error("no script queued");
      await s(job.workspace, job as any);
    },
  };
  // A host that doesn't start leaves nothing behind: the suite's after() has no host to stop.
  const { sv, port } = await onFreePorts((ports, log) => startSupervisor({ home: openHome(root), ...ports, publicListen: opts.publicListen, proxySecret: opts.proxySecret ?? "", builders: { claude: scripted }, remote: opts.remote, hosted: opts.hosted, ...(opts.intake ? { intake: () => opts.intake! } : {}), log, watchdog: { intervalMs: 200, stallMs: 1500 }, keySource: "file" })).catch((e) => {
    rmSync(root, { recursive: true, force: true });
    throw e;
  });
  await sv.admin("settings", { maxBuildAttempts: opts.attempts ?? 1 }).catch(async (e) => {
    await sv.stop();
    rmSync(root, { recursive: true, force: true });
    throw e;
  });
  const clients: Client[] = [];
  return {
    sv,
    root,
    port,
    queue: (...s) => void scripts.push(...s),
    invoke: (capabilityId, operation, input = {}, operationVersion) => sv.admin("invoke", { capabilityId, operation, input, operationVersion }),
    async agent(id, scopes) {
      const token = await oauthToken(sv.url, sv.admin, id, scopes);
      const client = new Client({ name: id, version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${sv.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      clients.push(client);
      return client;
    },
    async stop() {
      for (const c of clients) await c.close().catch(() => {});
      await sv.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
