// SPDX-License-Identifier: AGPL-3.0-or-later
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Agent, Scope } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import type { JSONSchema } from "@hewntools/core/manifest.ts";
import type { CapabilitySummary, Platform } from "@hewntools/core/platform.ts";
import { viewText } from "@hewntools/core/widgets.ts";
import { AGENT_TOOLS, SERVER_INSTRUCTIONS } from "@hewntools/spec/agents.ts";
import { WIDGET_APP_MIME, WIDGET_APP_URI } from "./surface/widget-app.ts";

/** Per-call context: lets long-running tools stream progress back over the open response. */
interface CallContext {
  progress?: (message: string) => void;
  signal: AbortSignal;
}

interface Tool {
  name: string;
  scopes: Scope[];
  description: string;
  inputSchema: JSONSchema;
  handler: (args: Record<string, any>, ctx: CallContext) => unknown;
  /** Tool `_meta` (MCP Apps: the UI resource that renders the result). */
  meta?: Record<string, unknown>;
  /** Shape the result (default: its JSON as text). */
  format?: (result: any) => { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };
}


/**
 * "Running Log (running-log): purpose …" lines the agent sees in tool descriptions: the user's
 * capabilities, then their connections (the external services those capabilities use) apart.
 */
function catalog(caps: CapabilitySummary[]): string {
  if (!caps.length) return "The user has no capabilities yet.";
  const line = (c: CapabilitySummary) => `- ${c.name} (${c.id})${c.kind === "connection" ? " [connection]" : ""}: ${c.purpose} Operations: ${c.operations.join(", ")}.${c.widgets ? ` Widgets: ${c.widgets.join(", ")}.` : ""}${c.ready ? "" : " NOT READY: needs user setup (see capabilities_get status)."}`;
  const { capabilities, connections } = grouped(caps);
  return [
    capabilities.length ? `The user's capabilities right now:\n${capabilities.map(line).join("\n")}` : "The user has no capabilities yet (only connections).",
    connections.length && `Connections (external services the capabilities use; call their operations for raw data from that service, or build on them):\n${connections.map(line).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The user's capabilities and their connections, apart: what Home shows, and the services behind it. */
const grouped = (caps: CapabilitySummary[]) => ({ capabilities: caps.filter((c) => c.kind !== "connection"), connections: caps.filter((c) => c.kind === "connection") });

/**
 * Discovery: tool descriptions and server instructions name the agent's visible capabilities
 * (the catalog), so agents that drop server instructions still see them.
 */
/** The capability's icon for a widget's corner, inlined (the chat's sandbox loads nothing); a big upload falls back to the monogram. */
async function widgetIcon(platform: Platform, id: string) {
  const file = await platform.icon(id).catch(() => undefined);
  const src = file && file.data.byteLength <= 32_768 ? { kind: file.glyph ? "glyph" : "image", src: `data:${file.type};base64,${btoa(Array.from(file.data, (b) => String.fromCharCode(b)).join(""))}` } : {};
  return { id, name: platform.activeManifest(id).name, hue: platform.hueOf(id), ...src };
}

function platformTools(platform: Platform, agent: Agent, caps: CapabilitySummary[]): Tool[] {
  const known = `\n\n${catalog(caps)}`;
  // The tools themselves (names, scopes, descriptions, input schemas) are the spec's; these run them.
  const run: Record<string, Pick<Tool, "handler" | "format">> = {
    capabilities_list: { handler: (a) => grouped(platform.list(agent, a)) },
    capabilities_get: { handler: (a) => platform.get(agent, a.capabilityId) },
    capabilities_invoke: { handler: (a) => platform.invoke(agent, a as any) },
    widgets_show: {
      handler: async (a) => {
        const r = await platform.widget(agent, a.capabilityId, a.widget, a.input ?? {});
        const sizes = platform.activeManifest(a.capabilityId).widgets?.find((w) => w.name === a.widget)?.sizes ?? ["medium"];
        return { ...r, icon: await widgetIcon(platform, a.capabilityId), input: a.input ?? {}, size: sizes.includes(a.size) ? a.size : sizes.includes("medium") ? "medium" : sizes[0] };
      },
      format: (r) => ({ content: [{ type: "text", text: viewText(r.title, r.view, r.size) }], structuredContent: r }),
    },
    capabilities_create: { handler: (a) => platform.create(agent, a as any) },
    capabilities_modify: { handler: (a) => platform.modify(agent, a as any) },
    capabilities_add_widgets: { handler: (a) => platform.addWidgets(agent, a as any) },
    capabilities_request_access: { handler: (a) => platform.requestAccess(agent, a.capabilityId, a.note) },
    schedules_list: { handler: (a) => platform.listSchedules(agent, a.capabilityId) },
    schedules_propose: { handler: (a) => platform.proposeSchedule(agent, a as any) },
    builds_get: { handler: (a) => platform.getBuild(agent, a.buildId) },
    builds_wait: {
      handler: (a, ctx) =>
        platform.waitForBuild(agent, a.buildId, {
          timeoutMs: (a.timeoutSeconds ?? 600) * 1000,
          onEvent: ctx.progress,
          signal: ctx.signal,
        }),
    },
    builds_retry: { handler: (a) => platform.retryBuild(agent, a.buildId) },
    builds_cancel: { handler: (a) => platform.cancelBuild(agent, a.buildId) },
  };
  // Build tools say which models this agent may ask for (the owner ticks them in Settings › AI).
  const models = `\n\nModels you may ask for (model): ${platform.agentModelChoices().join(", ")}.`;
  const builds = new Set(["capabilities_create", "capabilities_modify", "capabilities_add_widgets"]);
  return AGENT_TOOLS.map((t) => {
    const impl = run[t.name];
    if (!impl) throw new Error(`no handler for the spec's tool ${t.name}`);
    return {
      name: t.name,
      scopes: [...t.scopes],
      description: (t.catalog ? t.description + known : t.description) + (builds.has(t.name) ? models : ""),
      inputSchema: t.inputSchema,
      ...(t.widgetApp ? { meta: { ui: { resourceUri: WIDGET_APP_URI }, "ui/resourceUri": WIDGET_APP_URI } } : {}),
      ...impl,
    };
  });
}

/** The agent's tools right now: filtered by scope, with its visible capabilities in the descriptions. */
export function toolsFor(platform: Platform, agent: Agent): Tool[] {
  const caps = agent.scopes.has("discover") ? platform.list(agent) : [];
  return platformTools(platform, agent, caps).filter((t) => t.scopes.some((s) => agent.scopes.has(s)));
}

/** What the agent's tool list looks like: when it changes, the session gets tools/list_changed. */
export const toolSignature = (platform: Platform, agent: Agent) => JSON.stringify(toolsFor(platform, agent).map((t) => [t.name, t.description]));

/**
 * One MCP server per session, for the authenticated agent. `agent()` is read per request, so
 * scope changes apply mid-session; tools are listed fresh each time.
 */
export function createMcpServer(platform: Platform, agent: () => Agent, log: (line: string) => void = (l) => console.error(l), opts: { widgetHtml?: () => Promise<string> } = {}): Server {
  const caps = agent().scopes.has("discover") ? platform.list(agent()) : [];
  const instructions = `${SERVER_INSTRUCTIONS}\n\n${catalog(caps)}`;
  // cfworker validation: no eval, so the same server runs on workerd.
  const server = new Server(
    { name: "hewn", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true }, ...(opts.widgetHtml ? { resources: {} } : {}) }, instructions, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(platform, agent()).map(({ name, description, inputSchema, meta }) => ({ name, description, inputSchema: inputSchema as any, ...(meta ? { _meta: meta } : {}) })),
  }));

  // MCP Apps: the one UI resource, platform code that draws widgets_show results in the chat.
  const widgetHtml = opts.widgetHtml;
  if (widgetHtml) {
    const resource = { uri: WIDGET_APP_URI, name: "Hewn widget", description: "Draws a Hewn widget (widgets_show) in the chat.", mimeType: WIDGET_APP_MIME };
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [resource] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      if (req.params.uri !== WIDGET_APP_URI) throw new McpError(ErrorCode.InvalidParams, `unknown resource ${req.params.uri}`);
      // No network: everything is inlined, so the host's CSP can stay closed.
      return { contents: [{ uri: WIDGET_APP_URI, mimeType: WIDGET_APP_MIME, text: await widgetHtml(), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;
    const who = agent();
    log(`[${new Date().toISOString()}] ${who.id} ${name} ${JSON.stringify(args)}`);
    const tool = toolsFor(platform, who).find((t) => t.name === name);
    try {
      if (!tool) throw new PlatformError("not_found", `unknown tool ${name}`);
      const token = req.params._meta?.progressToken;
      let n = 0;
      const progress =
        token === undefined
          ? undefined
          : (message: string) =>
              void extra
                .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } })
                .catch(() => {});
      const result = await tool.handler(args, { progress, signal: extra.signal });
      return tool.format ? tool.format(result) : { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      const err =
        e instanceof PlatformError
          ? { error: e.code, message: e.message, details: e.details }
          : { error: "internal", message: (e as Error).message };
      log(`  -> ${err.error}: ${err.message}`);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(err, null, 2) }] };
    }
  });

  return server;
}
