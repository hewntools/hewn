// SPDX-License-Identifier: Apache-2.0
// The manifest (capability.json): a tool's public, machine-readable description. The host validates
// it before any version is installed or promoted. JSON Schema: ../schemas/capability.schema.json.

/**
 * Platform-owned runtime profiles. A manifest names one; never an arbitrary command.
 * "isolate" (ABI v2: a JS bundle in a V8 isolate) is the only one. Process and container profiles
 * may come later.
 */
export const RUNTIME_PROFILES = ["isolate"] as const;
export type RuntimeProfile = "isolate";

export type JSONSchema = Record<string, any>;
export type SideEffect = "read" | "write" | "destructive";

export interface OperationManifest {
  name: string;
  description: string;
  /** Operation contract major version. Breaking changes require a new number. */
  version: number;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  sideEffect: SideEffect;
  /**
   * Deprecated (ABI 2.1): still works, but callers should move to `replacement`
   * ("op@N" here, or "capability-id/op@N"). A later version may remove it once nothing that
   * the platform knows of (capabilities, schedules) uses it.
   */
  deprecated?: { replacement?: string; note?: string };
}

/** Where an installed tool came from (ABI 2.5). */
export interface ToolSource {
  /** The tool's id where it was exported. */
  id: string;
  /** Its version there. */
  version: number;
  /** That version's content hash. */
  hash: string;
  from: "file" | "link" | "hub";
  /** The host a link was on. */
  host?: string;
}

export interface CapabilityManifest {
  id: string;
  name: string;
  purpose: string;
  description?: string;
  /** Lowest Hewn ABI (`major.minor`) the capability needs. Missing means 2.0 (see ABI). */
  abi?: string;
  /**
   * "connection" (ABI 2.1): wraps one external service and is the only kind that may hold
   * credentials (`requires.secrets`). Other capabilities reach the service through its operations.
   * Default "capability".
   */
  kind?: "capability" | "connection";
  /** Platform-owned runtime profile. Defaults to "isolate", the only one. */
  runtime?: (typeof RUNTIME_PROFILES)[number];
  /** Tile colour for the app icon (OKLCH hue, 0–359). The design system derives tile and glyph shades from it. */
  hue?: number;
  /** How colourful the tile is, in percent of the design system's chroma (0–150, default 100); 0 is black or white on grey. Since ABI 2.4. */
  saturation?: number;
  /**
   * Where an installed tool came from (ABI 2.5): the tool and version it was exported from, and how
   * it arrived (a file, a link with its host, or the hub). The host writes it at install and keeps
   * it on every later version; a builder's value is replaced.
   */
  source?: ToolSource;
  /**
   * Non-secret settings the owner fills in (ABI 2.1), e.g. a site URL. Code reads them as
   * `ctx.config.NAME`; `requires.hosts` may name one as `config:NAME` (its host).
   */
  config?: { name: string; description: string }[];
  /** Authority the implementation needs. Usable only once the user grants it. */
  requires?: {
    secrets?: { name: string; description: string }[];
    /** Hostnames reachable over HTTPS (443) or HTTP; "*.example.com" allowed; "config:NAME" = the host in that config value. */
    hosts?: string[];
    /**
     * Other capabilities' operations this one calls, pinned "name@version". `hub` and `minVersion`
     * (ABI 2.5): the tool it builds on is "<publisher>/<slug>" on the hub, at least that version;
     * the host fills them in when the tool is published.
     */
    capabilities?: { id: string; operations: string[]; hub?: string; minVersion?: number }[];
    /**
     * A model the platform runs for it (ABI 2.2): `ctx.model.generate`. A portable tier (the
     * owner maps tiers to models) or one pinned "<provider>/<model-id>". `input` lists what the
     * prompts carry ("image" needs a model that takes images).
     */
    model?: ModelRequirement;
  };
  tags?: string[];
  operations: OperationManifest[];
  ui?: { available: boolean };
  /** Widgets (ABI 2.3): read operations whose output the platform draws on Home and in agent chats. */
  widgets?: WidgetManifest[];
}

export const WIDGET_SIZES = ["small", "medium", "large"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

export interface WidgetManifest {
  name: string;
  /** Bumped when the widget's meaning changes. */
  version: number;
  title: string;
  description?: string;
  /** The read operation that returns the view model, "name@N" (see widgets.ts). */
  operation: string;
  sizes: WidgetSize[];
  /** Interval refresh while Home is open ("15m", "1h"…). Event refresh arrives with events. */
  refresh?: { every?: string };
  /** Where a tap goes: "ui" or "ui#section" (the capability's UI). Default: its page in Hewn. */
  open?: string;
}

export const MODEL_TIERS = ["light", "standard", "strong", "max"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export interface ModelRequirement {
  tier?: ModelTier;
  model?: string;
  input?: ("text" | "image")[];
}
/** What a connection's required `health@1` reports. The platform calls it for Accounts. */
export const HEALTH_STATUSES = ["connected", "expired", "broken"] as const;
/**
 * A connection's optional `connect` operation: the owner's sign-in step (e.g. email + password,
 * then a code), run only by the owner in Hewn. It stores what it obtains with ctx.updateSecret.
 * "needs_input" asks for another step: `message`, `inputSchema` (the next fields), `state` (sent back).
 */
export const CONNECT_OUTPUT: JSONSchema = { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["connected", "needs_input"] } } };
export const HEALTH_OUTPUT: JSONSchema = { type: "object", required: ["status"], properties: { status: { type: "string", enum: [...HEALTH_STATUSES] } } };
