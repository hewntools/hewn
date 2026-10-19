// SPDX-License-Identifier: AGPL-3.0-or-later
// Starting the real workerd host (supervisor + workerd) for integration tests.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

export async function startTestHost(opts: { attempts?: number; publicListen?: string; proxySecret?: string } = {}): Promise<TestHost> {
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
  const port = await freePort();
  const sv = await startSupervisor({ home: openHome(root), port, publicPort: await freePort(), publicListen: opts.publicListen, proxySecret: opts.proxySecret ?? "", builders: { claude: scripted }, log: () => {}, watchdog: { intervalMs: 200, stallMs: 1500 }, keySource: "file" });
  await sv.admin("settings", { maxBuildAttempts: opts.attempts ?? 1 });
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
