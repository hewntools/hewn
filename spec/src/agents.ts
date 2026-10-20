// SPDX-License-Identifier: Apache-2.0
// The agent contract: what an agent (an MCP client) finds when it connects to a Hewn host. One MCP
// server at <host>/mcp (Streamable HTTP), OAuth 2.1 for sign-in, these tools, and one MCP Apps
// resource for widgets. A host offers an agent only the tools its granted scopes allow. See agents.md.
import type { JSONSchema } from "./manifest.ts";

/** What an agent may do, granted by the owner when it connects (and narrowable later). */
export const SCOPES = ["discover", "invoke", "create", "modify"] as const;
export type Scope = (typeof SCOPES)[number];

/** The server's instructions; the host appends the agent's visible tools (as in `catalog` below). */
export const SERVER_INSTRUCTIONS = `Hewn is the user's personal capability platform. It holds durable, user-owned
capabilities. Each has private persistent state and typed operations.
Anything you record here persists and is visible to the user's other agents.
When the user asks about their own data, activities or tools, check capabilities_list first.
Use capabilities_get to read operation schemas, then capabilities_invoke. Raw storage is not
accessible. Everything goes through operations.`;

/** The MCP Apps resource that draws a widget in the chat (`widgets_show`). */
export const WIDGET_APP_URI = "ui://hewn/widget";
export const WIDGET_APP_MIME = "text/html;profile=mcp-app";

export interface AgentTool {
  name: string;
  /** The tool is offered if the agent holds any of these scopes. */
  scopes: Scope[];
  description: string;
  inputSchema: JSONSchema;
  /** The host appends the agent's visible capabilities to the description ("Running Log (running-log): … Operations: …"). */
  catalog?: boolean;
  /** The result is drawn by the widget resource (MCP Apps); clients without it get the same content as text. */
  widgetApp?: boolean;
}

const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });
const str = (description?: string): JSONSchema => ({ type: "string", ...(description ? { description } : {}) });
/** What a build runs on. The host appends the names this agent may ask for to the tool's description. */
const buildModel = {
  model: str("The model to build it with, by name (e.g. 'fable', or 'default' for the builder's own). Leave it out to use the owner's choice; only names the owner allows are accepted."),
  effort: str("How hard the model thinks: low, medium, high (and more on some models). Leave it out for the model's default."),
};

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "capabilities_list",
    scopes: ["discover"],
    description:
      "The user's personal data and tools live here: durable capabilities with their own state. Use this whenever the user asks about their own activities, records, or tools. Returns { capabilities, connections }: the user's capabilities (what they think of as their tools), and apart from them the connections, which wrap external services (Todoist, Garmin…) for capabilities to use. Each with purpose and operation contracts (name@version).",
    inputSchema: obj({ name: str("Substring of capability id or name"), operation: str("Only capabilities exposing this operation name"), tag: str() }),
    catalog: true,
  },
  {
    name: "capabilities_get",
    scopes: ["discover"],
    description: "Get a capability's public manifest: purpose and every operation's input/output JSON Schema and side effect.",
    inputSchema: obj({ capabilityId: str() }, ["capabilityId"]),
  },
  {
    name: "capabilities_invoke",
    scopes: ["invoke"],
    description:
      "Invoke an operation on one of the user's capabilities to read or record their data. Input is validated against the operation's inputSchema (see capabilities_get). operationVersion defaults to the latest contract version. Destructive operations wait for the owner to confirm in Hewn; if that takes over a minute you get awaiting_confirmation: tell the owner, and call again with the same input once they have.",
    inputSchema: obj(
      {
        capabilityId: str(),
        operation: str("Operation name, e.g. record_run"),
        operationVersion: { type: "integer", description: "Contract version; omit for latest" },
        input: { type: "object", description: "Operation input object" },
      },
      ["capabilityId", "operation"],
    ),
    catalog: true,
  },
  {
    name: "widgets_show",
    scopes: ["invoke"],
    description:
      "Show one of a capability's widgets in the chat: a small card (a number, a short list, a chart, progress or a line of text) drawn from the capability's current data. Use it when the user wants to see something at a glance, or asks to show, open or load a widget or app from a capability (call this, not capabilities_invoke on the widget_* operation, so the card is drawn). Clients without MCP Apps get the same content as text. capabilities_get lists a capability's widgets (\"widgets\": name, title, sizes) and the input each takes. Read-only.",
    inputSchema: obj(
      {
        capabilityId: str(),
        widget: str("Widget name, from capabilities_get"),
        input: { type: "object", description: "The widget's input, if it takes any (its operation's inputSchema)" },
        size: { type: "string", enum: ["small", "medium", "large"], description: "Default: medium if the widget offers it" },
      },
      ["capabilityId", "widget"],
    ),
    widgetApp: true,
  },
  {
    name: "capabilities_create",
    scopes: ["create"],
    description:
      "Request a new capability for the user. The platform's builder implements it (returns status 'building'); follow it with builds_wait. " +
      "Only connections hold credentials: if it needs a service with a key, token or login (GitHub, Spotify, a self-hosted server…), it must call a connection (kind 'connection') that wraps the service. " +
      "If none exists, create the connection first (kind: 'connection', generic API operations only), then this capability with after: <the connection's buildId>; it starts once the connection promotes. " +
      "If the connection lacks an operation you need, capabilities_modify the connection first and pass its buildId as after.",
    inputSchema: obj(
      {
        name: str("Human name, e.g. 'Reading List'. The stable id is derived from it."),
        purpose: str("Why this capability exists, in one or two sentences"),
        requirements: str("What it must do"),
        kind: { type: "string", enum: ["capability", "connection"], description: "'connection' wraps one external service and holds its credentials. Default 'capability'." },
        after: str("A buildId to wait for (e.g. the connection this capability calls)"),
        widgets: { type: "boolean", description: "Also build widgets for Home and chats, as a follow-up build once this one promotes (returned as widgetsBuildId)" },
        ...buildModel,
      },
      ["name", "purpose", "requirements"],
    ),
  },
  {
    name: "capabilities_modify",
    scopes: ["modify"],
    description:
      "Request a change to an existing capability. The platform's builder implements it; follow it with builds_wait. A change to a connection, or one that adds operations, waits for the owner's review once it passes validation (status review): tell the owner. Pass after: <buildId> to start only once that build promotes (e.g. a change to the connection this one calls).",
    inputSchema: obj({ capabilityId: str(), request: str("Desired change"), after: str("A buildId to wait for"), ...buildModel }, ["capabilityId", "request"]),
  },
  {
    name: "capabilities_add_widgets",
    scopes: ["modify"],
    description:
      "Add widgets to an existing capability: glanceable cards (a number, a short list, a chart…) the owner can place on Hewn's Home and agents can show with widgets_show. A focused follow-up build that changes nothing but widgets, so it can't break the capability. Its new operations wait for the owner's review (status review), unless it follows the capability's own creation. Say what to show in request, or leave it out to let the builder propose 1–3. Follow it with builds_wait.",
    inputSchema: obj({ capabilityId: str(), request: str("What the widgets should show (optional)"), after: str("A buildId to wait for"), ...buildModel }, ["capabilityId"]),
  },
  {
    name: "capabilities_request_access",
    scopes: ["invoke", "create", "modify"],
    description:
      "Ask the owner to grant a capability what it needs (other capabilities' operations, hosts, secrets). Use when a capability is not ready because of pending grants. Only the owner can approve (in the Hewn web client or CLI); this records a visible request with your note.",
    inputSchema: obj({ capabilityId: str(), note: str("Why it's needed, in one sentence") }, ["capabilityId", "note"]),
  },
  {
    name: "schedules_list",
    scopes: ["discover"],
    description: "List schedules (operations the owner runs on a timetable) for the user's capabilities, with status, next and last run.",
    inputSchema: obj({ capabilityId: str("Only this capability") }),
  },
  {
    name: "schedules_propose",
    scopes: ["invoke"],
    description:
      'Propose running an operation on a timetable (e.g. a nightly sync). It stays "proposed" until the owner enables it in Hewn; it never runs before that. Cadence: "hourly", "daily HH:MM", "weekly mon HH:MM", or a 5-field cron expression, in the owner\'s timezone. Read and write operations only.',
    inputSchema: obj(
      {
        capabilityId: str(),
        operation: str("Operation name"),
        operationVersion: { type: "integer", description: "Contract version; omit for latest" },
        input: { type: "object", description: "Operation input" },
        cadence: str('"hourly", "daily 07:00", "weekly mon 07:00" or cron'),
        note: str("Why, in one sentence (shown to the owner)"),
      },
      ["capabilityId", "operation", "cadence"],
    ),
  },
  {
    name: "builds_get",
    scopes: ["create", "modify"],
    description: "Get build status (waiting, building, validating, review, failed, promoted, cancelled), builder and validation log. review: it passed and waits for the owner's approval in Hewn.",
    inputSchema: obj({ buildId: str() }, ["buildId"]),
  },
  {
    name: "builds_wait",
    scopes: ["create", "modify"],
    description:
      "Follow a platform-built build live until it is promoted, failed or waiting for the owner's review. Streams each builder action and validation step as MCP progress notifications, then returns the final build. If timeoutSeconds passes first, it returns the current status with waitTimedOut: true; call it again to keep following.",
    inputSchema: obj({ buildId: str(), timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800, description: "Default 600" } }, ["buildId"]),
  },
  {
    name: "builds_retry",
    scopes: ["create", "modify"],
    description: "Re-run a failed build with the same request (e.g. after a transient builder failure). Returns the new build; follow it with builds_wait.",
    inputSchema: obj({ buildId: str() }, ["buildId"]),
  },
  {
    name: "builds_cancel",
    scopes: ["create", "modify"],
    description: "Cancel a build you requested (the owner can cancel any). The builder stops and nothing is promoted. A candidate already being validated finishes first.",
    inputSchema: obj({ buildId: str() }, ["buildId"]),
  },
];
