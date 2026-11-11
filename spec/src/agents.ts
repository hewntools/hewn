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
accessible. Everything goes through operations.
For how Hewn itself works (concepts, building tools, connections, grants, the manifest and the ABI),
read hewn_docs instead of guessing.`;

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
/** Files as they travel to and from the host: UTF-8 text, or base64 for anything that isn't (images, fonts). */
const files: JSONSchema = {
  type: "array",
  maxItems: 1000,
  description: "The tool's files, each { path, content, encoding? }: path relative to the tool's folder (capability.json, src/index.ts, tests/cases.json, ui/index.html …); content as UTF-8 text, or base64 with encoding \"base64\". 5 MB in all. Only the tool's own files: not the pack's CONTRACTS.md, .hewn-contracts/, OTHER_TOOLS.md or PLATFORM_UI.css, no screenshots/, no dotfiles, CLAUDE.md or AGENTS.md (refused, naming the rule).",
  items: obj({ path: str(), content: str(), encoding: { type: "string", enum: ["utf-8", "base64"] } }, ["path", "content"]),
};
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
    description:
      "Get a capability's public manifest: purpose and every operation's input/output JSON Schema and side effect. For an agent that can change it, also changesComing: its changes queued or building (oldest first), which a new change lands after.",
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
      "Only connections hold credentials: if it needs a service with a key, token or login (GitHub, Notion, a self-hosted server…), it must call a connection (kind 'connection') that wraps the service. " +
      "A connection signs in with a key or token the user pastes, or with a username-and-password sign-in step; services that only allow OAuth (Google Calendar, Gmail, Spotify…) can't be connected yet. " +
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
      "Request a change to an existing capability. The platform's builder implements it; follow it with builds_wait. Once it passes validation it waits for the owner's review (status review) while your approval mode is wait, which the owner sets in Hewn (always, for now), and a change to a connection or one that adds operations always does: tell the owner. Changes to one capability take turns: one asked for while another is queued or building waits for it (status waiting) and is built on the version it makes. Pass after: <buildId> to start only once that build promotes (e.g. a change to the connection this one calls).",
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
    name: "capabilities_pack",
    scopes: ["create", "modify"],
    description:
      "To write a capability yourself instead of asking the platform's builder: first fetch what its builder finds in its workspace, and write these files into your folder. kind create: the user's other capabilities' contracts (CONTRACTS.md, .hewn-contracts/<id>.md), their looks to stay clear of (OTHER_TOOLS.md) and the design system (PLATFORM_UI.css). kind modify with capabilityId: also the capability's current files (its version, sample data included), its baseVersion and its schedules. How to build one: hewn_docs (building tools, the manifest, the ABI). Then capabilities_check while you work, and capabilities_submit when the check passes.",
    inputSchema: obj({ kind: { type: "string", enum: ["create", "modify"] }, capabilityId: str("The capability to change (kind modify)") }, ["kind"]),
  },
  {
    name: "capabilities_check",
    scopes: ["create", "modify"],
    description:
      "Check a capability you wrote as validation will, without submitting it: the manifest, bundling, contract compatibility (with capabilityId), migrations (on empty tables: on a copy of the capability's own data they run when you submit), tests/cases.json, sample/calls.json, and the UI rendered at 1280 and 390 px wide in light and dark with what to fix measured on it. Returns PASS or FAIL with every failure, and the four screenshots as images, a long page's top part (screenshots: \"all\" adds its further parts after them; structuredContent.screenshots names the images sent). Fix what it shows and check again; 30 checks an hour. Promotes nothing.",
    inputSchema: obj(
      {
        files,
        capabilityId: str("The capability these files change; leave it out for a new one"),
        screenshots: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["all"] }], description: 'true (the default): the four screenshots, a long page\'s top part. "all": a long page\'s further parts too. false: no images (the UI is still rendered and measured)' },
      },
      ["files"],
    ),
  },
  {
    name: "capabilities_submit",
    scopes: ["create", "modify"],
    description:
      "Hand over a capability you wrote (create scope for a new one, modify with capabilityId for a change). The platform validates it as any build (the contracts, the tests and migrations on a copy of the user's data, the UI) and returns a build: follow it with builds_wait. A new capability goes live once it passes (its grants wait for the owner); a change waits for the owner's review (status review) while your approval mode is wait (always, for now): tell the owner. A change is refused while another change to it is on its way, or if baseVersion (from capabilities_pack) is no longer its version. No builder runs, so builds_retry doesn't apply: submit again.",
    inputSchema: obj(
      {
        files,
        capabilityId: str("The capability these files change; leave it out for a new one"),
        request: str("What the capability is, or what the change does, in a sentence or two (kept with the build, shown to the owner)"),
        baseVersion: { type: "integer", minimum: 1, description: "The version your files are a change of (capabilities_pack's baseVersion)" },
      },
      ["files", "request"],
    ),
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
    description:
      "Get build status (waiting, building, validating, review, failed, promoted, cancelled), builder and validation log. review: it passed and waits for the owner's approval in Hewn. queued: true while it waits its turn behind an earlier change to the same capability. failed with failure.paused: the builder's host paused it part-way, its work kept; tell the owner, who continues or stops it in Hewn (continuedAs: the build that carries it on).",
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
    description:
      "Re-run a failed build with the same request (e.g. after a transient builder failure). Returns the new build; follow it with builds_wait. Not a paused one (failure.paused): only the owner continues it, in Hewn.",
    inputSchema: obj({ buildId: str() }, ["buildId"]),
  },
  {
    name: "builds_cancel",
    scopes: ["create", "modify"],
    description: "Cancel a build you requested (the owner can cancel any). The builder stops and nothing is promoted. A candidate already being validated finishes first.",
    inputSchema: obj({ buildId: str() }, ["buildId"]),
  },
  {
    name: "hewn_docs",
    scopes: ["discover", "invoke", "create", "modify"],
    description:
      "Hewn's own documentation: what Hewn is and how it works (tools, connections, grants, building and changing tools, agents and scopes, models, schedules, widgets, data and backups, remote access, troubleshooting), and the spec for tools and agents (the manifest, operations, ctx, the ABI, these MCP tools). Read it when the user asks how Hewn works or what it can do, instead of guessing. No input: the pages and their sections. query: the sections that best match. page: one page's markdown, or one section of it (\"docs/concepts.md#grants\"). Read-only.",
    inputSchema: obj({
      query: str("Words to look for, e.g. 'connection sign-in' or 'widget sizes'"),
      page: str("A page from the list, e.g. 'docs/connections.md', or 'page#section' for one section. With query: search only that page."),
    }),
  },
];
