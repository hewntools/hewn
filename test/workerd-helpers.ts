// SPDX-License-Identifier: AGPL-3.0-or-later
// Starting the real workerd host (supervisor + workerd) for integration tests.
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RemoteJobs } from "@hewntools/cli/builders/remote.ts";
import type { Intake } from "@hewntools/cli/intake.ts";
import type { Hosted } from "@hewntools/cli/supervisor/index.ts";
import type { Pass } from "@hewntools/core/passes.ts";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { pkceChallenge } from "@hewntools/core/agents.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor, type Supervisor, type SupervisorOptions } from "@hewntools/cli/supervisor/index.ts";
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
 * `builds_wait` for up to `seconds`, the MCP client waiting a little longer than the wait: its own
 * default gives up at 60 s, and a build with a check (bundle, npm, the renders) can take about
 * that long on a busy CI runner.
 */
export const waitBuild = async (client: Client, buildId: string, seconds: number) =>
  parse(await client.callTool({ name: "builds_wait", arguments: { buildId, timeoutSeconds: seconds } }, CallToolResultSchema, { timeout: (seconds + 15) * 1000 }));

/** waitBuild, with an agent's build held for the owner (approval mode wait) approved as the owner: for tests about something else. */
export const waitApproved = async (client: Client, sv: Supervisor, buildId: string, seconds: number) => {
  const b = await waitBuild(client, buildId, seconds);
  return b.status === "review" ? (await sv.admin("call", { method: "approveBuild", args: [buildId] })).result : b;
};

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

export async function startTestHost(opts: { attempts?: number; publicListen?: string; proxySecret?: string; proxyClientIp?: boolean; remote?: RemoteJobs; hosted?: Hosted; intake?: Intake; passes?: Pass[]; resume?: SupervisorOptions["resume"]; watchdog?: SupervisorOptions["watchdog"]; disk?: SupervisorOptions["disk"]; idleGc?: SupervisorOptions["idleGc"]; sandbox?: boolean; prepare?: (root: string) => void; schedulesOff?: boolean; network?: SupervisorOptions["network"]; toolsInspector?: string } = {}): Promise<TestHost> {
  const root = mkdtempSync(join(tmpdir(), "hewn-workerd-"));
  // A home as an earlier Hewn left it, say.
  opts.prepare?.(root);
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
  const { sv, port } = await onFreePorts((ports, log) => startSupervisor({ home: openHome(root), ...ports, publicListen: opts.publicListen, proxySecret: opts.proxySecret ?? "", proxyClientIp: !!opts.proxyClientIp, builders: { claude: scripted }, remote: opts.remote, hosted: opts.hosted, ...(opts.intake ? { intake: () => opts.intake! } : {}), log, watchdog: opts.watchdog ?? { intervalMs: 200, stallMs: 1500 }, ...(opts.resume !== undefined ? { resume: opts.resume } : {}), ...(opts.disk ? { disk: opts.disk } : {}), ...(opts.idleGc !== undefined ? { idleGc: opts.idleGc } : {}), ...(opts.sandbox ? { sandbox: true } : {}), ...(opts.schedulesOff ? { schedulesOff: true } : {}), ...(opts.network ? { network: opts.network } : {}), ...(opts.toolsInspector ? { toolsInspector: opts.toolsInspector } : {}), keySource: "file" })).catch((e) => {
    rmSync(root, { recursive: true, force: true });
    throw e;
  });
  // A new tool's passes only when a test asks for them (each is a builder run of its own to script).
  await sv.admin("settings", { maxBuildAttempts: opts.attempts ?? 1, buildPasses: opts.passes ?? [] }).catch(async (e) => {
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

/** The web API as the signed-in owner (on Hewn's own host name, which fetch can't send). */
export async function signedIn(h: TestHost): Promise<(path: string) => Promise<any>> {
  const get = (path: string, cookie = "") =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port: h.port, path, headers: { host: `hewn.localhost:${h.port}`, ...(cookie ? { cookie } : {}), "x-hewn-ui": "1" } }, (m) => {
        let body = "";
        m.on("data", (d) => (body += d));
        m.on("end", () => ok({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on("error", fail);
      r.end();
    });
  const { ticket } = await h.sv.admin("web-ticket");
  const cookie = String((await get(`/auth?ticket=${ticket}`)).headers["set-cookie"]).split(";")[0];
  return async (path) => {
    const r = await get(path, cookie);
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status} ${r.body}`);
    return JSON.parse(r.body);
  };
}
