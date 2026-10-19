# Capability Model

This document defines Hewn's domain concepts and the invariants between them. It is meant to be more stable than any database schema, repository layout or host implementation.

A **Capability** is what the rest of the spec, and Hewn's interface, call a **tool**. This document keeps the formal name. For the practical side, see [Writing a tool](tools.md) and [Connecting an agent](agents.md).

[ABI](README.md#versions) 2.3 is current. Anything added after 2.0 is marked with the minor version that introduced it ("since 2.1"); see [Capability ABI](#capability-abi).

## Capability

A **Capability** is a stable, durable, user-owned unit of software capability.

A Capability answers:

> What durable ability does this user own?

Examples:

- running log
- reading tracker
- invoice analyzer
- photo organizer
- file converter
- travel planner

A Capability may have an optional UI, but UI is not required.

A Capability may be implemented using many different technologies over its lifetime without losing its identity.

### Stable properties

A Capability should have at least:

- stable ID
- name
- purpose
- description
- active implementation version
- public operation contracts

In ABI 2 the manifest also carries tags, an optional UI, widgets (since 2.3) and the authority the implementation needs (`requires`). See [Capability Manifest](#capability-manifest).

Not yet part of the model:

- artifact types
- event types
- a natural-language entry point

## Capability purpose

Purpose describes why the Capability exists.

It helps agents understand when the Capability is relevant.

Example:

> Maintain a durable personal running history that authorized agents can record into and summarize.

Purpose should survive implementation rewrites.

## Capability Version

A **Capability Version** is an immutable implementation version of a Capability.

Example:

```text
Capability: running-log
Implementation version: 12
```

A Capability Version may contain:

- source
- manifest snapshot
- build metadata
- tests
- runtime artifact
- migration logic
- provenance
- change summary

Only one version is normally active.

Previous versions may remain available for history or rollback.

## Operation Contract

An **Operation Contract** is a stable public API exposed by a Capability.

Example:

```text
record_run@1
```

An Operation Contract should include:

- name
- description
- contract version
- input schema
- output schema
- side-effect classification

In ABI 2 an operation may also be marked deprecated (since 2.1).

Not yet part of the contract (coming later):

- idempotency characteristics
- per-operation grants
- timeout expectations
- artifact inputs or outputs
- rate constraints

### Implementation version is not operation version

These are intentionally separate.

For example:

```text
Capability implementation v5 -> record_run@1
Capability implementation v6 -> record_run@1
Capability implementation v7 -> record_run@1
Capability implementation v8 -> record_run@2
```

Internal refactoring should not force callers to understand implementation versions.

### Retiring an operation

A contract is retired explicitly (since 2.1): first marked deprecated, with its replacement, so callers see it and move; removed only in a later version, and only once nothing the platform knows of (other Capabilities, schedules) still uses it.

## State

**State** is private durable data owned by the stable Capability identity.

Examples:

- runs stored by a running Capability
- books stored by a reading Capability
- categorized transactions stored by a finance Capability

State does not belong to:

- an agent
- a conversation
- an implementation version
- a UI session

### State invariant

> External callers interact with state through Capability interfaces, never raw storage.

An Agent should not query a Capability's internal database.

Another Capability should not read its files directly.

This strict encapsulation allows internal schema changes without breaking external callers.

## Artifact

An **Artifact** is a durable user-owned data object that may be produced or consumed by Capabilities.

Examples:

- PDF
- image
- spreadsheet
- Markdown file
- report
- exported dataset

Artifacts differ from private Capability state because they are intended to have an identity outside one Capability's implementation.

Artifacts are not yet part of the spec. ABI 2 has no artifact type, and a Capability that handles files keeps them in its own state.

## Agent

An **Agent** is an external client acting under delegated user authority.

Examples:

- Claude Code
- Codex
- ChatGPT
- voice assistant
- IDE agent

The owner authorizes an Agent with scopes:

- `discover`: list Capabilities and read their contracts
- `invoke`: call operations
- `create`: request new Capabilities
- `modify`: request changes to existing ones

The owner may narrow what an Agent asks for, and limit it to some Capabilities. Approving grants, setting secrets and configuration, enabling schedules and deleting Capabilities belong to the owner alone, whatever an Agent's scopes.

Agents do not receive source access or raw state access. These are separate privileged concerns.

The agent contract (endpoint, sign-in, the tools each scope unlocks) is [Connecting an agent](agents.md).

## Builder

A **Builder** is a replaceable mechanism that turns a requested Capability change into a candidate implementation.

A Builder may receive:

- Capability purpose
- current manifest
- current source
- current version
- requested change
- runtime contract
- platform SDK documentation
- tests or fixtures

A Builder should not receive:

- production secrets unless explicitly required and mediated
- unrestricted access to unrelated Capabilities
- authority to promote its own result

### Builder invariant

> Builder proposes; platform promotes.

Hewn hands its builders [`builder-brief.md`](builder-brief.md) as the build contract.

## Runtime

A **Runtime** executes a promoted Capability implementation.

ABI 2 defines one runtime profile, `isolate`: JavaScript in a V8 isolate, like a serverless worker. Other profiles (processes, containers) may be added later without changing what a Capability is.

A Runtime is not part of Capability identity.

## Grant

A **Grant** is explicit authority allowing an actor to access a resource or perform an action.

Possible actors:

- Agent
- Capability
- Builder
- user-facing client

Possible resources:

- Capability
- operation
- Artifact
- external account
- external API scope

In ABI 2, a Capability's grants come from its manifest's `requires`: a host it may reach, a secret it may hold, another Capability's operation it may call, and a model it may use (since 2.2). Each is approved by the owner, one by one, before the Capability is ready. An Agent's authority is its scopes.

The authorization representation may later use a relationship-based engine, but the conceptual model should not depend on one product.

## Capability Manifest

The Capability Manifest (`capability.json`) is the public machine-readable description of a Capability. A host validates it before any version is installed or promoted. The types are [`src/manifest.ts`](src/manifest.ts) and the JSON Schema is [`schemas/capability.schema.json`](schemas/capability.schema.json); this section summarises them for ABI 2.3, and [Writing a tool](tools.md#the-manifest) explains each field.

```ts
interface CapabilityManifest {
  id: string;                 // ^[a-z0-9][a-z0-9-]*$, must match the capability's id
  name: string;
  purpose: string;
  description?: string;

  /** Lowest ABI (major.minor) the capability needs. Missing means "2.0". See Capability ABI. */
  abi?: string;
  /** Since 2.1. Default "capability". */
  kind?: "capability" | "connection";
  /** Runtime profile. Default and only value "isolate". */
  runtime?: "isolate";

  /** Tile colour: OKLCH hue, integer 0–359. */
  hue?: number;
  tags?: string[];

  /** Since 2.1. Non-secret settings the owner fills in; code reads ctx.config.NAME. */
  config?: { name: string; description: string }[];   // name: ^[A-Z][A-Z0-9_]*$, unique

  /** Authority the implementation needs. Usable only once the owner grants it. */
  requires?: {
    secrets?: { name: string; description: string }[];  // connections only
    hosts?: string[];
    capabilities?: { id: string; operations: string[] }[];
    model?: ModelRequirement;                            // since 2.2
  };

  operations: OperationManifest[];   // at least one
  ui?: { available: boolean };
  widgets?: WidgetManifest[];        // since 2.3, at most 8
}
```

Required: `id`, `name`, `purpose`, `operations`.

### Operations

```ts
interface OperationManifest {
  name: string;          // ^[a-z][a-z0-9_]*$
  description: string;
  version: number;       // contract major version, >= 1
  inputSchema: JSONSchema;   // must be { "type": "object", ... }
  outputSchema: JSONSchema;
  sideEffect: "read" | "write" | "destructive";
  /** Since 2.1. Still works; callers should move to `replacement`. */
  deprecated?: { replacement?: string; note?: string };   // replacement: "op@N" or "capability-id/op@N"; note max 500
}
```

- An operation is addressed as `name@version`. Each `name@version` appears once.
- Schemas are JSON Schema 2020-12. Inputs and outputs are validated on every call.
- A published `name@version` doesn't break: a new version of the capability must accept every input the old one accepted and keep every output guarantee, and keep its `sideEffect`. A breaking change is a new `name@N+1` next to the old one. The checks a host applies are listed in [Writing a tool](tools.md#changing-a-published-operation).
- A deprecated operation (since 2.1) may be removed later, once nothing the platform knows of (active capabilities, schedules) uses it.

### `requires`

- **`hosts`**: hostnames reachable over HTTP or HTTPS. `*.example.com` matches its subdomains. `config:NAME` (since 2.1) means the host in that config value (the config must be declared).
- **`secrets`**: credentials, `name` matching `^[A-Z][A-Z0-9_]*$`. Only a connection may declare them.
- **`capabilities`**: other capabilities' operations this one calls through `ctx.call`, pinned as `name@N` (at least one per entry).
- **`model`** (since 2.2): a model the platform runs for it through `ctx.model.generate`. Exactly one of `tier` (`light` | `standard` | `strong` | `max`, mapped to a model by the owner) or `model` (pinned `<provider>/<model-id>`, provider `anthropic` | `openai` | `openrouter`). `input` lists what prompts carry (`text`, `image`).

```ts
interface ModelRequirement {
  tier?: "light" | "standard" | "strong" | "max";
  model?: string;
  input?: ("text" | "image")[];
}
```

Nothing under `requires` is usable until the owner grants it; until then the capability is not ready.

### Connections (`kind: "connection"`, since 2.1)

A connection wraps one external service and is the only kind that holds credentials. Other capabilities reach the service through its operations. A connection:

- must have `health@1`: `read`, no required input, output `{ status: "connected" | "expired" | "broken" }`. The platform calls it to show the owner the connection's state.
- may have `connect@N`, the owner's sign-in step: `write`, output `{ status: "connected" | "needs_input" }`. `needs_input` asks for another step (`message`, `inputSchema` for the next fields, `state` sent back). Only the owner runs it; it can't be scheduled.
- has no UI and no widgets: it serves other capabilities, and the owner sees it among their accounts rather than their tools.
- stays a connection: a later version can't drop `"kind": "connection"`.

### Widgets (since 2.3)

```ts
interface WidgetManifest {
  name: string;          // ^[a-z][a-z0-9_]*$, unique
  version: number;       // bumped when the widget's meaning changes
  title: string;         // max 40
  description?: string;  // max 200
  operation: string;     // "name@N" of a declared read operation
  sizes: ("small" | "medium" | "large")[];   // at least one
  refresh?: { every?: string };   // "15m", "1h": 5m–24h, default 30m
  open?: string;         // "ui" or "ui#section"; needs ui.available
}
```

The widget's operation must be a `read` operation. It returns a view model for one of the platform's templates (`stat`, `list`, `chart`, `progress`, `text`; see [`src/widgets.ts`](src/widgets.ts) and [Writing a tool](tools.md#widgets-since-23)). The platform draws it on the owner's Home and in agent chats; capability code never ships widget HTML. Widget runs are read-only: writes throw, secret updates are dropped, and there is no model. A view may carry buttons, each running one of the capability's own operations as an ordinary call by whoever pressed it.

## Capability ABI

The Capability ABI is what a capability's code and the platform agree on: the module the code exports, the `ctx` each handler receives, the environment it runs in, and the manifest format above. It is the same on every runtime and every host. The types are [`src/ctx.ts`](src/ctx.ts) (module and `ctx`), [`src/model.ts`](src/model.ts) (`ctx.model`) and [`src/abi.ts`](src/abi.ts) (the version and its history); this section summarises them for ABI 2.3. [Writing a tool](tools.md) has the same contract with examples, and [`builder-brief.md`](builder-brief.md) is the version handed to builders.

### Versions

A manifest's `abi` declares the lowest version the capability needs. Minor versions only add (new `ctx` members, optional manifest fields, grant kinds); anything else is a new major. A host refuses a manifest that declares a version it doesn't implement (another major, or a higher minor) or that uses a feature newer than the version it declares. `ctx.model` is given only to code whose manifest declares at least 2.2; `ctx.config` is always present, and empty unless the manifest declares `config` (which needs 2.1).

| ABI | Adds |
| --- | --- |
| 2.0 | the base: the module, `ctx.db`, `ctx.secrets`, `ctx.updateSecret`, `ctx.call`, `ctx.caller`; the manifest without the fields below |
| 2.1 | `kind` (connections), `config`, `config:NAME` hosts and `ctx.config`, `deprecated` operations |
| 2.2 | `requires.model` and `ctx.model.generate` |
| 2.3 | `widgets` (and read-only runs) |

A manifest without `abi` is 2.0.

### Module

The implementation is one JavaScript module (the platform bundles `src/index.ts` and its npm dependencies). It exports one handler per declared operation, keyed `name@version`:

```ts
export const operations: Record<string, (input: unknown, ctx: Ctx) => unknown | Promise<unknown>> = {
  "record_run@1": (input, ctx) => {
    ctx.db.prepare("INSERT INTO runs (distance_km) VALUES (?)").run(input.distanceKm);
    return { ok: true };
  },
};
```

- Every operation in the manifest must be exported; a version that doesn't is rejected.
- A handler may be `async`. Its return value is the output, passed as JSON (`undefined` becomes `null`).
- A thrown error fails the call (`operation_failed`) with the error's message.

### `ctx`

```ts
interface Ctx {
  db: Db;
  secrets: Record<string, string>;
  updateSecret(name: string, value: string): void;   // also update_secret
  config: Record<string, string>;                     // since 2.1
  call(capabilityId: string, operation: string, input?: unknown): Promise<unknown>;
  caller?: { kind: string; id: string };
  model?: { generate(req: GenerateRequest): Promise<GenerateResult> };   // since 2.2
}

interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): Record<string, any>[];
    get(...params: unknown[]): Record<string, any> | undefined;
  };
  transaction<T>(fn: () => T): T;
}
```

- **`db`**: the capability's own private SQLite database, synchronous, and its only state. `transaction(fn)` groups writes atomically and nests. `BEGIN`/`COMMIT`/`ROLLBACK`, `SAVEPOINT`/`RELEASE` and `ATTACH` are not allowed.
- **`secrets`**: the granted values of `requires.secrets`, per call (connections only).
- **`updateSecret(name, value)`**: stores a new value for a declared secret, e.g. a refreshed token. Updates are kept only when the operation succeeds.
- **`config`**: the owner's values for the manifest's `config`.
- **`call(id, "op@N", input)`**: calls another capability's operation, which must be declared in `requires.capabilities` and granted. The callee validates the input as usual. Calls nest at most three capabilities deep, and cycles are refused.
- **`caller`**: who made this call (e.g. `{ kind: "capability", id: "reading-stats" }`). For provenance, not authorization.
- **`model.generate(req)`** (since 2.2): present only when the manifest declares ABI 2.2 or later and `requires.model`, the grant is given, and the call isn't a widget's.

```ts
interface GenerateRequest {
  system?: string;
  prompt?: string | ContentPart[];   // one user turn
  messages?: { role: "user" | "assistant"; content: string | ContentPart[] }[];   // instead of prompt, user first
  schema?: JSONSchema;               // structured output: the reply is checked and returned as `json`
  maxTokens?: number;                // default 1024, at most 16000
}
type ContentPart = { type: "text"; text: string } | { type: "image"; data: string /* base64 */; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };

interface GenerateResult {
  text: string;
  json?: unknown;
  usage: { inputTokens: number; outputTokens: number };
  cost: number;     // USD
  model: string;    // "<provider>/<model-id>" that ran
}
```

Images: at most 20 per request, 5 MB and 8000 px a side each. Text: at most 400 000 characters per request. Each call is checked against the owner's budget first; a refused or failed call throws.

### Environment

- Code runs as JavaScript in an isolate (V8, like a Cloudflare Worker), not as a Node.js process. Standard web APIs (`fetch`, `crypto`, `URL`, `TextEncoder`, …) and Node built-ins that need no host (`node:crypto`, `node:buffer`, `node:util`, …) are available.
- `fetch` reaches only the hosts in `requires.hosts` that the owner approved; anything else gets a `403` response.
- No filesystem (`node:fs` sees an empty, throwaway disk), child processes, raw sockets or environment variables.
- `console.log` (and `warn`/`error`) are the capability's logs, which the owner sees: up to 200 lines per call, 500 characters each.

### Calls

- The input is validated against the operation's `inputSchema` before the handler runs, and the output against `outputSchema` after it returns.
- A call chain (a call and every `ctx.call` it makes) has 30 seconds. Time spent waiting on `ctx.model` is added back, up to 120 seconds per chain. A widget's run has 15 seconds.
- An agent's call to a `destructive` operation runs only once the owner confirms it.
- **Read-only runs** (since 2.3): a widget's operation runs read-only. `ctx.db` refuses any statement that would write before it runs, secret updates are dropped, `ctx.call` reaches read operations only, and there is no `ctx.model`.

### State

The database schema is `migrations/NNN_name.sql`, applied in order, each atomically, and recorded in the `_hewn_migrations` table. Migrations are append-only (a new version never edits or removes a shipped one) and never destroy data: no `DROP TABLE`, `DROP COLUMN`, `DELETE FROM` or `TRUNCATE`, and no transaction statements (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`). Before a version is promoted they are dry-run on a copy of live state, and live state is backed up before they are applied.

## Discovery

Capability discovery operates on deterministic manifest metadata. Agents see a catalog of the Capabilities visible to them (name, id, purpose, operations, widgets, readiness), and may filter by:

- ID or name
- operation
- tag

Semantic discovery may later rank Capabilities using purpose and descriptive metadata.

Semantic discovery should be additive.

## Capability-to-Capability composition

A Capability may invoke another Capability only through the platform and through the callee's public interface.

Example:

```text
Capability A
   |
   | invoke operation
   v
Platform
   |
   | authorization check
   v
Capability B
```

Capability A must not receive direct database or filesystem access to Capability B.

## Connection

A **Connection** (since 2.1) is a Capability that wraps one external service (GitHub, Spotify, a self-hosted server)
and exposes that service's API as generic operations. It is not a new entity: it has operations,
grants, versions and rollback like any Capability.

- **Only connections hold credentials.** Other Capabilities reach a credentialed service only
  through a connection's operations, under the usual per-operation grants. What may be done is
  expressed by which operations exist: a blog connection without `publish` can't publish.
- Credentials live in the platform's secret store, never in state; refreshed tokens go back there.
- Non-secret settings (a site URL) are config, not secrets.
- Each connection reports its health, and may have an owner-only sign-in step for login flows.
- Use-case logic (a weekly review) belongs in the Capabilities that use the connection.

## Natural-language invocation

Natural-language invocation is not part of ABI 2. A future version may let a Capability expose an optional natural-language interface.

Example conceptual envelope:

```ts
interface NaturalLanguageInvocation {
  message: string;

  context?: {
    locale?: string;
    timezone?: string;
  };

  attachments?: ArtifactRef[];

  expectedOutput?: {
    format?: "text" | "json" | "artifact";
    schema?: unknown;
  };
}
```

The key principle is:

> Structure the envelope, not the meaning.

The Agent is intelligent enough to formulate the request.

The platform should standardize interoperability, authority, logging, and return shape.

## Events

Events are part of the long-term conceptual model but are not part of ABI 2.

Examples:

```text
run_recorded
invoice_overdue
artifact_created
```

Events may eventually support subscriptions and reactive Capabilities.

## Invariants

The following should be treated as architectural invariants unless explicitly reconsidered:

### Capability identity != implementation version

A Capability survives implementation replacement.

### Capability state != implementation

State remains attached to the durable identity.

### Capability != UI

UI is optional.

### Capability != runtime

A Capability may move between runtimes.

### Capability != builder

A different Builder can modify the same Capability.

### Agent != platform

Agents are clients.

### Agent != Capability owner

The user owns the Capability.

### Internal state is private

External callers use public contracts.

### Public operations are stable contracts

Breaking changes are explicit.

### Builders cannot self-promote

Candidate implementations pass through platform validation and promotion.

### No actor can expand its own authority

Authority is delegated, never self-created.

### Capability composition uses public interfaces

No hidden shared database coupling.

These invariants matter more than any initial implementation detail.
