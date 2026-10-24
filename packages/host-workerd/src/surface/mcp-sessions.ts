// SPDX-License-Identifier: AGPL-3.0-or-later
// Stateful MCP sessions, kept in memory by whoever serves /mcp (the owner's DO on workerd, the
// process on Node). Sessions let Hewn push notifications: when the agent's tool list changes
// (a capability was created, deleted, became ready, or the agent's scopes changed), the session
// gets tools/list_changed and the client re-lists without reconnecting. After a restart the
// sessions are gone; clients get 404 for their session id and initialize again (per the spec).
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Agent } from "@hewntools/core/auth.ts";
import { DOC_PAGES, type DocPage, readDocs } from "@hewntools/core/docs.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { randomToken } from "@hewntools/core/sha256.ts";
import { createMcpServer, toolSignature } from "../mcp.ts";
import { json } from "./http.ts";
import { widgetAppHtml } from "./widget-app.ts";

interface Session {
  id: string;
  agent: Agent;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  signature: string;
  lastSeen: number;
}

const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_PER_AGENT = 20;

export class McpSessions {
  private sessions = new Map<string, Session>();
  private platform: Platform;
  private log: (line: string) => void;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: () => void;

  /** The ui://hewn/widget HTML (MCP Apps), built once from the platform assets. */
  private widgetHtml?: () => Promise<string>;
  /** Hewn's docs (hewn_docs), read once from the platform assets (again next time if some were missing). */
  private docs?: () => Promise<DocPage[]>;

  constructor(platform: Platform, log: (line: string) => void, asset?: (path: string) => Promise<Uint8Array | undefined>) {
    this.platform = platform;
    this.log = log;
    if (asset) {
      let html: Promise<string> | undefined;
      this.widgetHtml = () => (html ??= widgetAppHtml(asset).catch((e) => ((html = undefined), Promise.reject(e))));
      let docs: Promise<DocPage[]> | undefined;
      this.docs = () => (docs ??= readDocs(asset).then((pages) => (pages.length < DOC_PAGES.length && (docs = undefined), pages)));
    }
    this.unsubscribe = platform.onChange(() => {
      // Debounced: a build promotion logs several lines in a row.
      if (this.pending) return;
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.refresh();
      }, 200);
    });
  }

  get size() {
    return this.sessions.size;
  }

  /** Tell each session whose tool list changed; end the sessions of agents that were revoked. */
  refresh() {
    for (const s of [...this.sessions.values()]) {
      const agent = this.platform.agentStore.get(s.agent.id);
      if (!agent) {
        this.close(s.id);
        continue;
      }
      s.agent = agent;
      let signature: string;
      try {
        signature = toolSignature(this.platform, agent);
      } catch {
        continue;
      }
      if (signature === s.signature) continue;
      s.signature = signature;
      s.server.sendToolListChanged().catch(() => {});
    }
  }

  async handle(req: Request, agent: Agent): Promise<Response> {
    const id = req.headers.get("mcp-session-id");
    if (id) {
      const s = this.sessions.get(id);
      // Unknown, expired, or someone else's: the client starts a new session.
      if (!s || s.agent.id !== agent.id) return json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      s.agent = agent;
      s.lastSeen = Date.now();
      const res = await s.transport.handleRequest(req);
      if (req.method === "DELETE") this.close(id);
      return res;
    }
    if (req.method !== "POST") return json(400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }, id: null });
    this.evict(agent.id);
    const session = { agent } as Session;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomToken(24),
      onsessioninitialized: (sid) => {
        session.id = sid;
        session.lastSeen = Date.now();
        session.signature = toolSignature(this.platform, session.agent);
        this.sessions.set(sid, session);
      },
    });
    const server = createMcpServer(this.platform, () => session.agent, this.log, { widgetHtml: this.widgetHtml, docs: this.docs });
    session.server = server;
    session.transport = transport;
    transport.onclose = () => session.id && this.sessions.delete(session.id);
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // Not an initialize request (or it failed): nothing to keep.
    if (!session.id) await server.close().catch(() => {});
    return res;
  }

  private close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    void s.server.close().catch(() => {});
  }

  /** Drop idle sessions, and the oldest ones beyond the caps. */
  private evict(agentId: string) {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) if (now - s.lastSeen > IDLE_MS) this.close(s.id);
    const mine = [...this.sessions.values()].filter((s) => s.agent.id === agentId).sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= MAX_PER_AGENT) this.close(mine.shift()!.id);
    const all = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    while (all.length >= MAX_SESSIONS) this.close(all.shift()!.id);
  }

  dispose() {
    this.unsubscribe();
    if (this.pending) clearTimeout(this.pending);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
