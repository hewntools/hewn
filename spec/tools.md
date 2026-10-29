# Writing a tool

A tool is a small program its owner keeps: typed operations over its own private SQLite database, optionally a UI and widgets. Agents, the owner's UI and other tools use it only through its operations. In the manifest, the API and the types, a tool is called a **[capability](capability-model.md#capability)**; this document says "tool".

This page is for writing one by hand. On Hewn, a builder agent usually writes tools from a description; it gets the same contract as a prompt, [`builder-brief.md`](builder-brief.md). The concepts and invariants behind it are in [`capability-model.md`](capability-model.md). The exact types are in [`src/`](src) and the JSON Schemas in [`schemas/`](schemas).

Everything here is [ABI](README.md#versions) 2.5. Anything added after 2.0 is marked with the version that added it ("since 2.1"); a tool may use it only if its manifest declares at least that version.

## Layout

A tool is a directory:

```
capability.json        the manifest: what the tool is and what it offers
src/index.ts           the implementation (TypeScript or JavaScript; the entry point the host bundles)
package.json           optional: npm dependencies (registry versions only), bundled with the code
migrations/NNN_*.sql   the database schema, append-only
tests/cases.json       test cases the host runs before it promotes a version
sample/calls.json      sample data (since 2.5): calls replayed on an empty tool, on request
ui/index.html          optional: the tool's own UI (with any other files under ui/)
ui/icon.svg            optional: the app icon (Hewn's convention is a 5×5 pixel glyph)
```

Widgets have no files of their own: they are declared in the manifest and backed by read operations (see [Widgets](#widgets-since-23)).

## The manifest

`capability.json` is the tool's public, machine-readable description. The host validates it before it installs or promotes any version. Its full shape is [`schemas/capability.schema.json`](schemas/capability.schema.json) and the `CapabilityManifest` type in [`src/manifest.ts`](src/manifest.ts).

| Field | Required | Since | What |
| --- | --- | --- | --- |
| `id` | yes | 2.0 | Stable id, `^[a-z0-9][a-z0-9-]*$`. Must be the id the host installs it under. |
| `name` | yes | 2.0 | Human name. |
| `purpose` | yes | 2.0 | Why it exists, in a sentence or two. Agents use it to decide when the tool is relevant. |
| `description` | no | 2.0 | Longer description. |
| `abi` | no | 2.0 | Lowest ABI it needs, `major.minor`. Missing means `"2.0"`. |
| `kind` | no | 2.1 | `"capability"` (default) or `"connection"`. See [Connections](#connections-since-21). |
| `config` | no | 2.1 | Non-secret settings the owner fills in: `[{ name, description }]`. See [Config](#config-since-21). |
| `runtime` | no | 2.0 | Leave it out. The only profile is `"isolate"`. |
| `hue` | no | 2.0 | Tile colour for the icon: an OKLCH hue, integer 0–359. |
| `saturation` | no | 2.4 | How colourful the tile is: percent of the design system's chroma, integer 0–150, default 100. `0` draws the icon black or white on grey (for a black-and-white brand). |
| `source` | no | 2.5 | Where an installed tool came from: `{ id, name, version, hash, from }` (`from`: `"file"`, `"link"` with its `host`, or `"hub"`). The host writes it when it installs a tool from outside and keeps it on every later version. Leave it out: a value you write is replaced. |
| `tags` | no | 2.0 | Strings agents can filter on. |
| `requires` | no | 2.0 | Authority the code needs: `secrets`, `hosts`, `capabilities`, and `model` (since 2.2). See [Grants](#grants). |
| `operations` | yes | 2.0 | At least one. See [Operations](#operations). |
| `ui` | no | 2.0 | `{ "available": true }` if the tool ships `ui/index.html`. |
| `widgets` | no | 2.3 | At most 8. See [Widgets](#widgets-since-23). |

Some rules can't be expressed in the schema. The host also checks that:

- `abi` is a version it implements (same major, minor not higher than its own), and that no field is newer than the declared `abi`.
- each `name@version` appears once, and every `inputSchema` is `"type": "object"` and both schemas compile.
- only a connection declares `requires.secrets`, and every connection follows the [connection rules](#connections-since-21).
- `config` names are unique, and every `config:NAME` host names a declared config.
- `requires.model` has exactly one of `tier` and `model`.
- widgets follow the [widget rules](#widgets-since-23).
- `ui/index.html` exists when `ui.available` is true.

## Versions

The `abi` field says which version of the contract the tool is written against. A host implements one major version and runs every minor up to its own; it refuses a manifest that declares a version it doesn't implement, or that uses a field newer than the version it declares. Minor versions only add, so a tool written for 2.0 runs unchanged on a 2.4 host.

| ABI | Added |
| --- | --- |
| 2.0 | The module (`operations`), `ctx.db`, `ctx.secrets`, `ctx.updateSecret`, `ctx.call`, `ctx.caller`; operations, `requires` (hosts, capabilities), `ui`; `tests/cases.json` |
| 2.1 | `kind` (connections) and `requires.secrets` (connections only), deprecated operations, `config`, `ctx.config`, `config:NAME` hosts |
| 2.2 | `requires.model`, `ctx.model.generate` |
| 2.3 | `widgets`, and the view models widget operations return |
| 2.4 | `saturation` |
| 2.5 | `source`, `requires.capabilities[]` `hub` and `minVersion` (both the host's to write), `sample/calls.json` |

Declare the lowest version whose features you use. The history is also in [`src/abi.ts`](src/abi.ts) (`ABI_HISTORY`).

## Operations

An operation is one typed entry point. Each has:

| Field | What |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]*$` (snake_case). |
| `description` | What it does, for agents and the owner. |
| `version` | The contract's major version, an integer from 1. |
| `inputSchema` | JSON Schema (2020-12) for the input. Must be `"type": "object"`. |
| `outputSchema` | JSON Schema for the output. |
| `sideEffect` | `read`, `write` or `destructive`. |
| `deprecated` | Since 2.1, optional: `{ "replacement"?: "op@N" or "tool-id/op@N", "note"?: "…" }` (note at most 500 characters). |

An operation is addressed as `name@version` (`record_run@1`). Callers may leave the version out; they then get the highest version of that name.

The host validates every call's input against `inputSchema` before the code runs, and the output against `outputSchema` after it returns. A call with bad input fails with `invalid_input`; code that returns output its schema doesn't allow fails with `invalid_output`.

**Side effects** are a promise the host enforces in places:

- **`read`:** changes nothing. Only read operations can back a widget, and widget runs may call only read operations of other tools.
- **`write`:** records or changes data.
- **`destructive`:** removes or overwrites data in a way that can't be undone. When an agent calls one, the host holds the call until the owner confirms it (see [agents.md](agents.md#invoking-operations)). Destructive operations can't be scheduled.

### Changing a published operation

A published `name@version` is a contract. A new version of the tool must accept every input the old one accepted and keep every output guarantee. The host compares each operation with the active version's and refuses a new version that:

- removes a property, or changes a property's `type`,
- makes an input property required that wasn't, or starts rejecting additional input properties,
- narrows an input `enum`, or widens an output `enum`,
- stops guaranteeing a required output property,
- tightens an input constraint (a higher `minimum` or `minLength`, a lower `maximum` or `maxItems`, a new or changed `pattern`, `format`, `const` or `multipleOf`, `items` where there were none), or loosens an output one (the reverse),
- changes any composite keyword at all (`oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`, `$ref`, `patternProperties`, a schema for `additionalProperties`): these aren't compared, so any change counts as breaking,
- changes `sideEffect`.

Adding an optional input property, a new output property, or loosening an input constraint is compatible: keep the version. Descriptions don't matter. Anything else is a new contract: add `name@2` next to `name@1`. The exact rules are `breakingChanges` in the host; [`capability-model.md`](capability-model.md#operation-contract) states the invariant.

A connection stays a connection: a new version can't drop `"kind": "connection"`.

### Retiring an operation (since 2.1)

To retire `name@N`, first mark it `deprecated` with its replacement. It keeps working, and callers see the notice: an agent's result carries a `deprecated` message. A later version may remove it, and the host allows that only if the active version already marks it deprecated and nothing it knows of still uses it (another tool's `requires.capabilities`, or a schedule).

## The module

`src/index.ts` exports one object, `operations`, with a handler per declared operation, keyed `name@version`:

```ts
import type { Ctx } from "@hewntools/spec/ctx.ts";

export const operations = {
  "record_run@1"(input: { km: number }, { db }: Ctx) {
    db.prepare("INSERT INTO runs (km) VALUES (?)").run(input.km);
    return { ok: true };
  },
};
```

- The import is type-only: it disappears when the tool is bundled, so a tool has no runtime dependency on the spec. Add `@hewntools/spec` as a dev dependency for type checking.
- Every operation in the manifest must be exported; a version that doesn't is rejected. The module is loaded once to check this.
- A handler may be `async`. Its return value is the output and crosses to the host as JSON (`undefined` becomes `null`).
- A thrown error fails the call with `operation_failed` and the error's message.

## `ctx`

Each handler gets `(input, ctx)`. The types are [`src/ctx.ts`](src/ctx.ts); `CTX_MEMBERS` there lists each member with its version.

| Member | Since | What |
| --- | --- | --- |
| `db` | 2.0 | The tool's own SQLite database. |
| `secrets` | 2.0 | The granted values of `requires.secrets`, by name. Connections only. |
| `updateSecret(name, value)` | 2.0 | Stores a new value for a declared secret. `update_secret` is an older spelling of the same function. |
| `call(toolId, "op@N", input?)` | 2.0 | Calls another tool's operation. |
| `caller` | 2.0 | Who made this call. |
| `config` | 2.1 | The owner's values for the manifest's `config`, by name. |
| `model` | 2.2 | `model.generate(request)`: a language model the host runs for the tool. |

- **`db`:** synchronous (no `await`): `exec(sql)`, `prepare(sql)` with `run(...params)` (returns `{ changes, lastInsertRowid }`), `all(...params)` and `get(...params)`, and `transaction(fn)`, which runs `fn` atomically and nests. Use `transaction` to group writes: `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` and `ATTACH` statements are not allowed in tool code. The database is the tool's only state. The schema comes from [migrations](#migrations).
- **`secrets`:** only names the manifest declares, only once the owner has granted them and given values. A missing value is simply absent.
- **`updateSecret(name, value)`:** for a refreshed token or similar. Updates are kept only if the call succeeds, only for declared names, and are dropped in a widget's run.
- **`call(toolId, "op@N", input)`:** returns the callee's output. The operation must be listed in `requires.capabilities` and granted by the owner; otherwise the call fails with `forbidden`. The callee validates the input as for any caller. Calls nest at most 3 tools deep, and a cycle (a tool reached twice on one path) is refused.
- **`caller`:** `{ kind, id }`, for example `{ kind: "agent", id: "claude-code" }`, `{ kind: "capability", id: "weekly-review" }`, `{ kind: "ui", id: "ui:running-log" }`. Use it for provenance (a `source` column), not for authorization: the host has already authorized the call.
- **`config`:** always present; empty when the manifest declares no config.
- **`model`:** present only when the manifest declares ABI 2.2 or later and `requires.model`, the owner has granted it, and the call isn't a widget's. See [Using a model](#using-a-model-since-22).

## Runtime

- **An isolate, not a process.** Code runs as JavaScript in a V8 isolate (like a Cloudflare Worker). The host bundles `src/index.ts` and its imports, including npm packages from `package.json`, into one ES module. Pick packages that run in browsers or Workers, at versions from the npm registry: a git, `file:`, `link:` or URL dependency, or an `.npmrc` (npm settings), fails the build. Code imports only the tool's own files and its packages.
- **Available:** standard web APIs (`fetch`, `crypto`, `URL`, `TextEncoder`, `Date`, …) and Node built-ins that need no host (`node:crypto`, `node:buffer`, `node:util`, …).
- **Not available:** a filesystem (`node:fs` sees an empty, throwaway disk), child processes, raw sockets, environment variables.
- **Network:** `fetch` reaches only the hosts in `requires.hosts` that the owner approved; any other request gets a `403` response. `*.example.com` matches subdomains of `example.com`, not `example.com` itself.
- **Logs:** `console.log`, `warn` and `error` are the tool's log, which the owner sees: up to 200 lines per call, 500 characters each. Agents don't see them.
- **Time:** a call chain (an agent's call and every `ctx.call` it causes) has 30 seconds. Time spent waiting on `ctx.model` doesn't count, up to 120 seconds per chain. A widget's run has 15 seconds. When time runs out the call fails with `operation_failed`. Long work suits an operation that does what fits and reports what's left (`{ "done": 5, "remaining": 12 }`), called again or [scheduled](agents.md#schedules).

## Migrations

The database schema is `migrations/NNN_name.sql` (`001_init.sql`, `002_add_notes.sql`): three digits, then snake_case. The host applies them in order, each atomically, and records each in a `_hewn_migrations` table.

- **Append-only.** A new version adds files. It never edits or removes one that a previous version shipped.
- **Never destroy data.** `DROP TABLE`, `DROP COLUMN`, `DELETE FROM` and `TRUNCATE` are refused.
- **No transaction statements** (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`): each file already runs atomically.
- Before a version is promoted, its new migrations are dry-run on a copy of the live database, and the live database is backed up before they're applied.
- Rolling back to an older version runs the older code on the newer schema. The host refuses a rollback past a migration that would break that code: a `NOT NULL` column without a default, a rename, or a new unique index.

## Sample data (since 2.5)

`sample/calls.json` is what the tool looks like in use: a list of operation calls, replayed in order on an empty tool when the owner installs it **with sample data** (on by default), or starts it over with sample data. Hewn needs it to share a tool, because a tool that opens empty shows nothing of what it does. Schema: [`schemas/sample.schema.json`](schemas/sample.schema.json); type: `SampleCall` in [`src/cases.ts`](src/cases.ts).

```json
[
  { "operation": "add_plant", "input": { "name": "Monstera", "room": "Living room", "waterEveryDays": 7 } },
  { "operation": "log_watering", "input": { "plant": "Monstera", "date": "2026-10-20" } }
]
```

Each entry has `operation`, an optional `version` (default the highest) and `input` (default `{}`). Up to 200 calls. They run as the owner, through the contract like any call, before the owner has granted anything: no network, no other tools, no model. So use plain writes that store data, with made-up names and places, never the owner's own. A version whose sample data doesn't replay without errors isn't promoted.

## Tests and promotion

`tests/cases.json` is a list of cases, at least one. They run in order against one fresh database with all migrations applied, so earlier cases can set up data for later ones. Schema: [`schemas/cases.schema.json`](schemas/cases.schema.json); type: [`src/cases.ts`](src/cases.ts).

| Field | What |
| --- | --- |
| `name` | Shown when the case fails. |
| `operation` | The operation's name. |
| `version` | Its version. Default: the highest. |
| `input` | The input. Default `{}`. |
| `expect` | The output must match: see below. |
| `expectError` | `true`: the call must fail (bad input, a thrown error, a refused call). |
| `secrets` | Fake secret values for this case. |
| `config` | Since 2.1: fake config values. |
| `calls` | Fake outputs of other tools' operations, keyed `"tool-id/op@N"`. |
| `model` | Since 2.2: fake model replies, served in order: `{ "text": "…" }`, `{ "json": … }` or `{ "error": "…" }`. |

`expect` is a subset match: every key in an expected object must match in the output, and other output keys are ignored. Arrays must have the same length and match element by element. The string `"$any"` matches any value that is present.

Validation never touches anything real. There is no network (`fetch` gets `403`), secrets and config are whatever the case passes, `ctx.call` returns the case's `calls` entry (a call that isn't declared fails, and one without an entry fails the case), and `ctx.model` serves the case's `model` replies (running out fails the case). Put logic that needs the network or a model behind operations that can also run on fake data.

A host validates a new version, then promotes it. Hewn does this, in order:

1. The manifest is valid.
2. The code bundles, loads, and exports every declared operation.
3. Every operation contract is compatible with the active version (see [Changing a published operation](#changing-a-published-operation)).
4. Every operation in `requires.capabilities` exists.
5. Migrations are append-only and non-destructive.
6. All test cases pass. Every widget's operation needs a case, and its output must be a view a template can draw. Since 2.5: if there's `sample/calls.json`, it replays in order on a fresh database, every call without an error.
7. If there's a UI, it's rendered headlessly on an empty database, in light and dark mode, and (since 2.5, with sample data) again on a database filled with it; an uncaught error, a `console.error` or a failed request fails the version. The owner's screenshot is the filled one. Changed widgets are drawn in every size they offer, showing what they'd show with the sample data when there is some.
8. Migrations are dry-run on a copy of the live database.
9. The version is frozen (immutable). If an agent asked for a change to an existing tool, and the change is to a connection or adds operations, it waits for the owner's review (build status `review`); the owner approves or rejects exactly this version.
10. The live database is backed up, migrations are applied, and the version becomes active.

If anything fails, nothing changes: the active version keeps serving. A promoted version that asks for something new (a host, a secret, another tool's operation, a model) is not ready until the owner approves it.

## Grants

Nothing in `requires` is usable until the owner grants it. Until every grant is approved and every secret and config value is set, the tool is "not ready", and calls to it fail with `not_ready` and a `status` saying what's missing.

| In the manifest | The owner approves | Since |
| --- | --- | --- |
| `requires.hosts: ["api.example.com"]` | network access to that host (`config:NAME`: the host in that config value) | 2.0 (`config:` since 2.1) |
| `requires.secrets: [{ name, description }]` | the secret, and gives its value (or signs in, see `connect`) | 2.0 (only connections, which arrived in 2.1, may declare them) |
| `requires.capabilities: [{ id, operations: ["op@N"] }]` | each listed operation of the other tool, one by one | 2.0 |
| `requires.model: { tier }` or `{ model }` | spending from the model budget | 2.2 |

A new version that asks for more needs a fresh approval for the new items; what was approved before stays approved. Agents can't approve anything; they can only file a request (`capabilities_request_access`). Ask for as little as you can, and prefer other tools' read operations.

## Calling other tools

Use another tool's operations instead of keeping a copy of its data: a weekly review reads runs from the running log rather than keeping its own table.

```json
"requires": { "capabilities": [{ "id": "running-log", "operations": ["list_runs@1"] }] }
```

```ts
const { runs } = (await ctx.call("running-log", "list_runs@1", { from: "2026-10-01" })) as { runs: Run[] };
```

Calls are pinned to a contract version, so the callee can evolve without breaking the caller. The callee sees `ctx.caller` as `{ kind: "capability", id: "<your id>" }`. Test with `calls` mocks. A tool can't call itself.

## Connections (since 2.1)

A connection is a tool that wraps one external service that needs credentials (GitHub, a calendar, a self-hosted server). It is the only kind that may declare `requires.secrets`. Other tools reach the service by calling the connection's operations, under the usual per-operation grants, so what they can do is exactly the operations that exist: a connection without `delete_file` can't delete.

```json
{
  "abi": "2.1",
  "kind": "connection",
  "config": [{ "name": "SERVER_URL", "description": "Your server, e.g. https://cloud.example.com" }],
  "requires": {
    "secrets": [{ "name": "APP_PASSWORD", "description": "An app password from the server's security settings" }],
    "hosts": ["config:SERVER_URL"]
  }
}
```

A connection:

- **must have `health@1`:** `read`, no required input, output `{ "status": "connected" | "expired" | "broken", "detail"?: string }`. The host calls it to show the owner the connection's state. Keep it cheap: one authenticated request, or none when credentials are missing.
- **may have a sign-in step, `connect@N`:** a `write` operation for services that need a login rather than a pasted key. Only the owner runs it, in the host (agents never can, and it can't be scheduled). It runs before the secrets exist, signs in, stores tokens with `ctx.updateSecret`, and returns `{ "status": "connected" }`. For another step (a code sent by email), it returns `{ "status": "needs_input", "message": "…", "inputSchema": { … }, "state": "…" }`; the owner's next call carries `state` and the new fields. Mark password fields `"format": "password"`. The host doesn't keep the sign-in step's logs or error messages.
- keeps credentials only in the host's secret store: refreshed tokens go back through `ctx.updateSecret`, never into the database.
- has no UI and no widgets.

Keep connections generic (`list_issues`, `create_issue`); use-case logic belongs in the tools that call them.

## Config (since 2.1)

Config is non-secret settings the owner fills in, such as a server address. Declare it in `config` (names `^[A-Z][A-Z0-9_]*$`, unique) and read it as `ctx.config.NAME`. A tool isn't ready until every declared config has a value. In `requires.hosts`, `"config:NAME"` means "the host in that config value", and the owner's value must then be a URL or host name. Any tool may declare config; only connections hold secrets.

## Using a model (since 2.2)

A tool can ask the host to run a language model for it. It never calls a provider itself and never holds an API key: the owner's keys, model choices and budget live in the host.

```json
"abi": "2.2",
"requires": { "model": { "tier": "light", "input": ["text"] } }
```

- **`tier`:** `light`, `standard`, `strong` or `max`. The owner maps each tier to a model, so the tool keeps working as models change. Pick the lowest tier that does the job.
- **`model`:** instead of a tier, one pinned model, `"<provider>/<model-id>"` with provider `anthropic`, `openai` or `openrouter`. Pin only when a particular model is needed.
- **`input`:** what prompts carry, `text` and/or `image`. `image` needs a model that takes images.

```ts
const r = await ctx.model!.generate({
  system: "Explain English words in one short sentence.",
  prompt: `Explain "${word}".`,
  schema: { type: "object", required: ["explanation"], properties: { explanation: { type: "string" } } },
  maxTokens: 200,
});
// r.text, r.json (with schema), r.usage { inputTokens, outputTokens }, r.cost (USD), r.model
```

The request and result types are [`src/model.ts`](src/model.ts):

- `prompt` is one user turn: a string, or parts (`{ type: "text", text }`, `{ type: "image", data: <base64>, mediaType }` with PNG, JPEG, WebP or GIF). `messages` (`[{ role: "user" | "assistant", content }]`, user first) replaces `prompt` for a conversation.
- With `schema`, the reply is checked against it and returned parsed as `json`.
- `maxTokens` defaults to 1024, at most 16 000. A request carries at most 400 000 characters of text and 20 images (5 MB and 8000 px a side each).
- Each call is checked against the owner's budget first. A refused or failed call throws: catch it.

Don't make a write depend on the model: store the record first, and fill generated fields in a separate, best-effort operation. Treat model output as data. Text from outside (notes, web pages, images) can carry instructions, so never let the output decide what the code does next.

## Widgets (since 2.3)

A widget is a small card the host draws from a tool's data: on the owner's Home, and in agent chats. The tool writes no HTML for it. It declares the widget and a **read** operation that returns a view model for one of five templates; the host draws it.

```json
"abi": "2.3",
"widgets": [{
  "name": "week",
  "version": 1,
  "title": "This week",
  "operation": "widget_week@1",
  "sizes": ["small", "medium"],
  "refresh": { "every": "30m" },
  "open": "ui#week"
}]
```

| Field | What |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]*$`, unique in the tool. |
| `version` | Bump it when the widget's meaning changes. |
| `title` | At most 40 characters. |
| `description` | Optional, at most 200. |
| `operation` | `name@N` of a declared **read** operation. |
| `sizes` | One or more of `small` (1×1), `medium` (2×1), `large` (2×2). |
| `refresh.every` | How often Home refreshes it while open: `"15m"`, `"1h"`; between 5m and 24h, default 30m. |
| `open` | Optional: `"ui"` or `"ui#section"`, where a tap goes. Needs `ui.available`; the UI sees `#section` as its `location.hash`. Without it, a tap opens the tool's page in the host. |

A connection has no widgets.

### Views

The operation returns one view, or a view per size (`{ "medium": {…}, "large": {…} }`; a size without its own view uses the nearest one). The types are [`src/widgets.ts`](src/widgets.ts). Unknown properties are refused.

| Template | Fields |
| --- | --- |
| `stat` | `value` (string or number), `unit`? (≤ 12), `caption`? (≤ 80), `reveal`? |
| `list` | `items`: up to 5 `{ title (≤ 80), detail? (≤ 80), value? }`, `empty`? (≤ 80, shown when there are none), `reveal`? |
| `chart` | `kind`? (`bar` or `line`), `labels` (≤ 31, each ≤ 16), `series`: 1–3 `{ name (≤ 24), values }` with one value per label, `unit`?, `caption`? |
| `progress` | `value`, `max` (> 0), `label`? (≤ 40), `caption`? |
| `text` | `text` (≤ 280), `caption`? (≤ 80), `reveal`? |

- **`reveal`** (≤ 280): text hidden behind a "Show" button until tapped, such as the answer on a practice card. The host shows it; nothing is written.
- **`buttons`** (any template, up to 3): `[{ "label": "Done" (≤ 24), "operation": "op@N", "input"?: { … } }]`. A button runs one of the tool's own operations, writes included, as whoever pressed it: the owner on Home (the host asks first for a destructive one), or the agent in a chat (where a destructive one waits for the owner's confirmation). The widget then refreshes. Put the item's id in `input`.

Declare the widget operation's `outputSchema` loosely (`{ "type": "object", "required": ["template"] }`); the host checks the output against the template itself.

### Rules

- **Drawing is read-only.** The widget's operation runs with a database it can only read (a statement that would write is refused before it runs), may call only read operations of other tools, gets no `ctx.model`, and its secret updates are dropped. Compute from stored data; fetch and generate in other operations. Pressing a button is a normal call.
- **Input:** if the operation takes input (which list to show), the owner sets it when placing the widget, and it's checked against `inputSchema`. Give every property a default so `{}` works.
- **Tests:** every widget's operation needs a test case; it runs read-only and its output must be a view a template can draw. Seed data with earlier cases so the check sees real content. Hewn also draws every offered size during validation and fails a size whose content doesn't fit.

## Tool UIs

A tool can ship a UI for the owner: static files under `ui/`, with `ui/index.html` as the entry point and `"ui": { "available": true }` in the manifest. Plain HTML, CSS and JavaScript; no build step.

**Where it runs.** The host serves it at `<host>/tools/<id>/~<key>/`, where the key is random per tool, so the address can't be guessed; other paths under `/tools/<id>/` answer `404`. Every response there carries a CSP `sandbox` without `allow-same-origin`, so the page gets an opaque origin of its own, whether it's opened as a page or framed by Hewn's web client. It can't read the web client, its cookies, or another tool's UI. It also has no browser storage: `localStorage`, `sessionStorage`, IndexedDB and cookies throw. Keep data in the tool through its operations, and view state (a tab, a filter) in memory or the URL fragment.

**What it may load.** The CSP allows scripts and styles from the UI's own files, `/_platform/` and inline; images from its own files, `/_platform/`, `data:` and `blob:`; network requests to its own API only. No CDNs, external fonts or outside APIs (a tool that needs one fetches it in an operation). Link your own files with relative paths (`app.js`, not `/app.js`), since the UI lives under `/tools/<id>/~<key>/`.

**The UI kit** at `/_platform/` (Apache-2.0, [`../packages/ui`](../packages/ui)):

- `ui.css`: the design system (layout, controls, tokens, light and dark). Link it and build on it. It's all in the cascade layer `hewn`, so your page's own CSS (outside any layer) always wins over it, whatever the selectors: your own tokens, light and dark, and a plain rule for a control. The exception is ui.css's `!important` rules: `[hidden]` and reduced motion. A token you set in plain `:root` applies in dark mode too, so give it both values: `--bg: light-dark(<light>, <dark>)`. That follows Hewn's Light or Dark as well as the browser's; `@media (prefers-color-scheme: dark)` follows only the browser's (see **Light and dark** below).
- `chart.js`: `barChart(el, { labels, series, stacked?, unit? })` and `lineChart(el, { … })`.
- `session.js`: the session shim. The host injects it into the `<head>` of every HTML page it serves, before any of the page's scripts.

**Signing in.** The owner opens the UI from the host, which hands the page a one-time ticket; the page gets a session token (bound to this one tool, valid 12 hours) in its URL fragment. `session.js` takes it from there, keeps it for the tab, and removes it from the address bar.

**Light and dark.** In Hewn's web client, the page can follow the owner's appearance. On System, that's the browser's `prefers-color-scheme`. When they pick Light or Dark, `session.js` sets `data-theme="light"` or `"dark"` and `color-scheme` on the page's `<html>` before any style loads (a sandboxed frame can't see the choice otherwise), changes them when they switch, and takes them off on System. The page follows if it links `ui.css`, which reads `data-theme`, or reads `data-theme` or `color-scheme` itself. For colours of your own, use `light-dark(<light>, <dark>)`: it follows `color-scheme`, which `ui.css` also sets for System (without `ui.css`, declare `:root { color-scheme: light dark }`). A plain `@media (prefers-color-scheme: dark)` follows only the browser's, as does a page opened on its own, outside the web client. A `data-theme` the page puts on its `<html>` itself stays: `session.js` neither replaces nor removes it, so a deliberately dark tool stays dark.

**Calling operations.** The UI is just another client: it calls its own tool's operations, and nothing else. `session.js` patches `fetch`, so a request to `api/…` or `/api/…` goes to `<host>/tools/<id>/api/…` with the session token (`Authorization: Hewn <token>`) and the `x-hewn-ui: 1` header the API requires. Or use the helper it defines:

```js
const out = await hewn.call("record_run", { distanceKm: 5, durationSeconds: 1680 });
if (out.error) showError(out.message);   // { error, message, details }
else render(out.result);                 // { capabilityId, operation, result }
```

| Request | What |
| --- | --- |
| `POST api/invoke` `{ operation, input?, operationVersion? }` | Calls an operation. Without `operationVersion`, the highest version. `200` with `{ capabilityId, operation, result }` (plus `deprecated` when it is); `400` with `{ error, message, details }`; `409` when the tool isn't ready. |
| `GET api/manifest` | The manifest, with readiness as `status`. |

`hewn.manifest()` fetches the manifest, and `hewn.embedded` is `true` when the page is framed by the web client.

The UI acts for the owner, with authority limited to its own tool (`caller` is `{ kind: "ui", id: "ui:<id>" }`). The host doesn't hold a UI's destructive calls for confirmation, since the owner is the one acting: ask before you call one.

## Example: a running log

A complete tool, adapted from [`../seeds/running-log`](../seeds/running-log). It uses only ABI 2.0. Two more examples use ABI 2.3: [`reading-list`](../seeds/reading-list) (a widget, and a `destructive` operation) and [`habits`](../seeds/habits) (a widget with a button that runs a write operation).

`capability.json`:

```json
{
  "id": "running-log",
  "name": "Running Log",
  "purpose": "Maintain a durable personal running history that any authorized agent can record into and summarize.",
  "description": "Records runs (date, distance, duration) and summarizes training over a date range. Dates are local calendar dates, YYYY-MM-DD.",
  "abi": "2.0",
  "hue": 30,
  "tags": ["running", "training"],
  "operations": [
    {
      "name": "record_run",
      "description": "Record one run. date defaults to today.",
      "version": 1,
      "sideEffect": "write",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["distanceKm", "durationSeconds"],
        "properties": {
          "distanceKm": { "type": "number", "exclusiveMinimum": 0 },
          "durationSeconds": { "type": "integer", "exclusiveMinimum": 0 },
          "date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
        }
      },
      "outputSchema": {
        "type": "object",
        "required": ["runId"],
        "properties": { "runId": { "type": "string" } }
      }
    },
    {
      "name": "get_summary",
      "description": "Run count, total distance and average pace (seconds per km) over an optional inclusive date range.",
      "version": 1,
      "sideEffect": "read",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "from": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
          "to": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
        }
      },
      "outputSchema": {
        "type": "object",
        "required": ["runCount", "totalDistanceKm", "averagePaceSecondsPerKm"],
        "properties": {
          "runCount": { "type": "integer" },
          "totalDistanceKm": { "type": "number" },
          "averagePaceSecondsPerKm": { "type": ["number", "null"] }
        }
      }
    }
  ]
}
```

`migrations/001_init.sql`:

```sql
CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  distance_km      REAL NOT NULL,
  duration_seconds INTEGER NOT NULL,
  recorded_at      TEXT NOT NULL
);
CREATE INDEX runs_date ON runs (date);
```

`src/index.ts`:

```ts
import type { Ctx } from "@hewntools/spec/ctx.ts";

type Range = { from?: string; to?: string };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const operations = {
  "record_run@1"(input: { distanceKm: number; durationSeconds: number; date?: string }, { db }: Ctx) {
    const runId = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id, date, distance_km, duration_seconds, recorded_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, input.date ?? today(), input.distanceKm, input.durationSeconds, new Date().toISOString());
    return { runId };
  },

  "get_summary@1"({ from, to }: Range, { db }: Ctx) {
    const r = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(distance_km), 0) AS km, COALESCE(SUM(duration_seconds), 0) AS s FROM runs WHERE date >= ? AND date <= ?")
      .get(from ?? "0000-00-00", to ?? "9999-99-99")!;
    return {
      runCount: r.n,
      totalDistanceKm: Math.round(r.km * 100) / 100,
      averagePaceSecondsPerKm: r.km > 0 ? Math.round(r.s / r.km) : null,
    };
  },
};
```

`tests/cases.json`:

```json
[
  { "name": "empty summary", "operation": "get_summary",
    "expect": { "runCount": 0, "totalDistanceKm": 0, "averagePaceSecondsPerKm": null } },
  { "name": "record a run", "operation": "record_run",
    "input": { "distanceKm": 5, "durationSeconds": 1680, "date": "2026-10-01" },
    "expect": { "runId": "$any" } },
  { "name": "record another", "operation": "record_run", "version": 1,
    "input": { "distanceKm": 10, "durationSeconds": 3300, "date": "2026-10-03" },
    "expect": { "runId": "$any" } },
  { "name": "summary in range", "operation": "get_summary", "input": { "from": "2026-10-02" },
    "expect": { "runCount": 1, "totalDistanceKm": 10, "averagePaceSecondsPerKm": 330 } },
  { "name": "summary", "operation": "get_summary",
    "expect": { "runCount": 2, "totalDistanceKm": 15, "averagePaceSecondsPerKm": 332 } },
  { "name": "rejects negative distance", "operation": "record_run",
    "input": { "distanceKm": -1, "durationSeconds": 60 }, "expectError": true },
  { "name": "rejects unknown field", "operation": "record_run",
    "input": { "distanceKm": 1, "durationSeconds": 60, "mood": "great" }, "expectError": true }
]
```

On Hewn, `hewn install <dir>` installs a tool from a directory like this one. It goes through the same validation as a built one.
