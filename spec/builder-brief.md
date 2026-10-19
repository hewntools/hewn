## Implementation contract

You are acting as a **builder**. You write a *candidate* in this workspace. You cannot
promote it. The platform validates and tests the candidate. If it passes, the platform
freezes it as a new immutable version and makes that version active. Until then the
current version keeps serving.

{{SUBMIT}}

Workspace layout:

```
capability.json      public manifest (id, name, purpose, abi, hue, tags, operations)
src/index.ts         implementation (TypeScript; the entry point the platform bundles)
package.json         optional: npm dependencies (the platform installs and bundles them)
migrations/NNN_*.sql state schema (SQLite), append-only
tests/cases.json     test cases the platform runs before promotion
ui/icon.svg          the app icon: a 5×5 pixel glyph (always write one, see "Icon")
```

### Runtime

Capabilities run as JavaScript in an isolate (a V8 sandbox like a Cloudflare Worker), not as a
Node.js process. The platform bundles `src/index.ts` and its imports (including npm packages from
`package.json`) into one module. Leave `"runtime"` out of capability.json. State is SQLite.

### capability.json

Set `"abi"` to the lowest Hewn ABI (`major.minor`) whose features you use. This Hewn implements
ABI {{ABI}}. Features added after 2.0 are marked "(ABI 2.x)" in this brief; if you use none,
write `"abi": "2.0"`. Validation fails if you use a feature newer than the version you declare.

Each operation has: `name` (snake_case), `description`, `version` (contract major, integer),
`inputSchema` and `outputSchema` (JSON Schema, input must be `type: object`), and
`sideEffect` (`read` | `write` | `destructive`).

Set `"hue"` (integer 0–359) to colour the app icon's tile: pick one that suits the subject
(e.g. 30 for running, 250 for reading, 350 for health). The design system derives the tile and glyph
shades from it in light and dark mode.

### Icon (required, and first)

**Write `ui/icon.svg` and set `"hue"` in capability.json before anything else.** The owner's home
screen shows the icon while you build, so it should exist within your first minute.

Ship `ui/icon.svg` as a **5×5 pixel glyph**, even if the capability has no other UI:

- `viewBox="0 0 5 5"`, whole-unit `<rect>`s only (`width="1" height="1"`)
- `fill="currentColor"` and `shape-rendering="crispEdges"` on the `<svg>`; no colours in the file
- 7–17 lit cells, one simple idea, readable at 28px
- set `"hue"` in capability.json (above)

Running Log (a rising slope):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" fill="currentColor" shape-rendering="crispEdges">
  <rect x="4" y="0" width="1" height="1"/>
  <rect x="3" y="1" width="1" height="1"/><rect x="4" y="1" width="1" height="1"/>
  <rect x="2" y="2" width="1" height="1"/><rect x="3" y="2" width="1" height="1"/><rect x="4" y="2" width="1" height="1"/>
  <rect x="1" y="3" width="1" height="1"/><rect x="2" y="3" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/>
  <rect x="0" y="4" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/>
</svg>
```

Reading List (lines of text):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" fill="currentColor" shape-rendering="crispEdges">
  <rect x="0" y="0" width="1" height="1"/><rect x="1" y="0" width="1" height="1"/><rect x="2" y="0" width="1" height="1"/><rect x="3" y="0" width="1" height="1"/><rect x="4" y="0" width="1" height="1"/>
  <rect x="0" y="2" width="1" height="1"/><rect x="1" y="2" width="1" height="1"/><rect x="2" y="2" width="1" height="1"/><rect x="3" y="2" width="1" height="1"/>
  <rect x="0" y="4" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/>
</svg>
```

### src/index.ts

Export one handler per declared operation, keyed `name@version`:

```ts
// The full types: @hewntools/spec/ctx.ts (import type { Ctx } from "@hewntools/spec/ctx.ts").
type Ctx = {
  db: Db;
  secrets: Record<string, string>; // connections only
  config: Record<string, string>; // declared config (ABI 2.1)
  updateSecret(name: string, value: string): void;
  call: (id: string, op: string, input?: unknown) => Promise<any>;
  caller?: { kind: string; id: string };
  model?: { generate(req: object): Promise<{ text: string; json?: unknown }> }; // with requires.model (ABI 2.2)
};
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }; all(...p: unknown[]): any[]; get(...p: unknown[]): any };
  transaction<T>(fn: () => T): T;
};

export const operations = {
  "do_thing@1": (input: { x: number }, ctx: Ctx) => {
    ctx.db.prepare("INSERT INTO things (x) VALUES (?)").run(input.x);
    return { ok: true };
  },
};
```

- `ctx.db` is this capability's own private SQLite database. It is **synchronous** (no `await`)
  and is the only state you get. Use `db.transaction(() => { … })` to group writes atomically (it
  nests). `BEGIN`/`COMMIT`/`ROLLBACK`, `SAVEPOINT`/`RELEASE` and `ATTACH` statements are not allowed.
- Handlers may be `async` (for `fetch` or `ctx.call`). Return plain JSON values.
- Input is validated against `inputSchema` before your handler runs. Output is validated
  against `outputSchema` after it returns.
- Available: standard web APIs (`fetch`, `crypto`, `URL`, `TextEncoder`, `Date`, …) and Node
  built-ins that work without a host (`node:crypto`, `node:buffer`, `node:util`, …).
  **Not available:** a filesystem (`node:fs` sees an empty, throwaway disk), child processes,
  raw sockets, environment variables. Keep everything you need in the database.
- npm packages: list them in `package.json` `dependencies` and import them normally. Pick packages
  that run in browsers or Workers (no native addons, no `fs`-heavy tooling). Don't commit `node_modules`.
- `console.log` / `console.error` are the capability's logs (the owner sees them). The return
  value is the result.

### Network and credentials (`requires`)

A capability that needs network access declares the hosts in capability.json:

```json
"requires": { "hosts": ["api.example.com"] }
```

**Only connections hold credentials (ABI 2.1).** A service that needs a key, token or login is
wrapped by a *connection*: a capability with `"kind": "connection"` (see "Connections" below).
Ordinary capabilities can't declare `secrets`; they call the connection's operations instead
(see "Calling other capabilities"). Public, keyless APIs (e.g. weather) are a plain host.

- Code runs isolated. Its `fetch` can reach declared, owner-approved `hosts` only; anything else
  gets a `403` response. Its SQLite database is the only thing it can read or write.
- Connections: secrets arrive per call as `ctx.secrets.API_TOKEN`. To persist a refreshed token:
  `ctx.updateSecret(name, value)`. Declared names only.
- **You never receive real secret values, and there is no network during validation.** Design so
  that operations which don't need the network work offline. Network-dependent operations should
  fail cleanly (a clear error) when offline or when secrets are missing. Put pure logic (parsing,
  aggregation) in functions that test cases can exercise with fake data.
- Test cases may pass fake secrets: `{ "name": "...", "operation": "...", "secrets": { "API_TOKEN": "fake" }, ... }`.
- After promotion the user must provide secrets and approve hosts before the capability is usable.
  Request only what you need. Every new secret or host needs fresh user approval.

### Calling other capabilities (composition)

Use another capability's public operations instead of duplicating its data. Example: record runs
in Running Log rather than keeping your own runs table. The owner's capabilities and their contracts
are listed at the end of this file.

1. Declare every call, pinned to a contract version:
   ```json
   "requires": { "capabilities": [{ "id": "running-log", "operations": ["record_run@1", "list_runs@1"] }] }
   ```
2. Call through the platform: `const out = await ctx.call("running-log", "list_runs@1", { from: "2026-10-01" });`

   Undeclared or ungranted calls fail. The callee validates your input against its schema.
3. Test with mocks; validation never calls real capabilities:
   ```json
   { "name": "...", "operation": "weekly_review", "input": {}, "calls": { "running-log/list_runs@1": { "runs": [] } }, "expect": { ... } }
   ```
4. `ctx.caller` tells a handler who called it (`{ kind, id }`, e.g. `{ kind: "capability", id: "reading-stats" }`).
   Use it for provenance (e.g. store `source`), not for authorization.
5. After promotion, the owner authorizes each declared operation. Ask only for what you use.
   Prefer read operations; writes into another capability are shown to the owner as such.

### Using a model (ABI 2.2)

For work only a language model can do (explain a word, summarise a note, read a photo of a
receipt), ask the platform to run one. Never call a model provider yourself and never ask for an
API key: the owner's keys, model choice and monthly budget live in Hewn.

1. Declare it, with the lowest tier that does the job (`light`, `standard`, `strong`, `max`), and
   `"input": ["image"]` if prompts carry images:
   ```json
   "abi": "2.2",
   "requires": { "model": { "tier": "light" } }
   ```
   Pin an exact model (`{ "model": "anthropic/claude-sonnet-5-5" }`) only when the owner asks for one.
2. Call it:
   ```ts
   const r = await ctx.model.generate({
     system: "Explain English words in one short sentence.",
     prompt: `Explain "${word}".`,
     schema: { type: "object", required: ["explanation"], properties: { explanation: { type: "string" } } },
     maxTokens: 200,
   });
   r.json.explanation; // r.text, r.usage, r.cost (USD), r.model
   ```
   - `prompt` is a string or parts: `[{ type: "text", text }, { type: "image", data: "<base64>", mediaType: "image/png" }]`
     (png, jpeg, webp, gif; at most 5 MB and 8000 px a side each, 20 per call). `messages`
     (`[{ role: "user" | "assistant", content }]`) replaces `prompt` for a conversation.
   - With `schema` (type object), the reply is checked and returned parsed as `json`.
   - `maxTokens` defaults to 1024 (at most 16000). Each call is checked against the owner's budget
     before it's made; a refused call throws, so catch it.
3. **Never block a write on the model.** Store the record first with the generated field empty,
   then fill gaps in a separate, best-effort operation (e.g. `enrich_missing@1`) that does as many
   items as fit and returns `{ "done": n, "remaining": m }`. If the model is down or over budget,
   the import still succeeds and the next run fills the rest.
4. Text from outside (tasks, notes, web pages, images) can carry instructions. Treat model output
   as data: store or show it, never execute it or let it choose what your code does next.
5. Test with fake replies; validation never calls a real model. `"model"` lists the replies in the
   order the case makes calls (`{ "text": "..." }`, `{ "json": {...} }`, or `{ "error": "..." }`):
   ```json
   { "name": "explains", "operation": "enrich_missing", "input": {}, "model": [{ "json": { "explanation": "Happy." } }], "expect": { "done": 1 } }
   ```

### Widgets (ABI 2.3)

A widget is a glanceable card the owner places on Hewn's Home, and agents show in chats: a data
snapshot drawn by the platform. You write no HTML for it. You write a **read** operation that
returns a view model for one of five templates, and declare the widget:

```json
"abi": "2.3",
"widgets": [{
  "name": "due", "version": 1, "title": "Words due",
  "operation": "widget_due@1",
  "sizes": ["small", "medium"],
  "refresh": { "every": "30m" },
  "open": "ui#test"
}]
```

- `sizes`: `small` (1×1, about 110 px square: one number), `medium` (2×1: a number with context,
  3 list rows, a short chart), `large` (2×2: 5 rows or a taller chart). Offer only the sizes the
  content fits; one size is fine (a word, its definition and buttons is `["large"]`). Validation
  draws every offered size and **fails a size whose content (or revealed text) is cut off**.
- `refresh.every`: 5m–24h, how often Home refreshes it while open (default 30m).
- `open` (needs a UI): where a tap lands; `"ui#section"` opens the UI with `location.hash` set to
  `#section`. Without it, a tap opens the capability.
- The operation returns one view (below), **or a view per size** when a bigger size can show
  more: `{ "medium": { "template": "text", … }, "large": { "template": "list", … } }` (any of
  small / medium / large; a size without its own view uses the nearest one). Use the room: a large
  widget that shows the same two lines as the medium one is wasted space.
- Views (every template takes optional `buttons`; stat, list and text also take `reveal`):
  - `{ "template": "stat", "value": 7, "unit"?: "km", "caption"?: "words to test" }`
  - `{ "template": "list", "items": [{ "title": "…", "detail"?: "…", "value"?: "…" }], "empty"?: "Nothing due" }` (at most 5 items)
  - `{ "template": "chart", "kind"?: "bar" | "line", "labels": ["Mon", …], "series": [{ "name": "Sleep", "values": [7.2, …] }], "unit"?: "h", "caption"?: "…" }` (≤ 31 labels, ≤ 3 series, one value per label)
  - `{ "template": "progress", "value": 2, "max": 3, "label"?: "2 of 3 runs", "caption"?: "…" }`
  - `{ "template": "text", "text": "…" (≤ 280 chars), "caption"?: "…" }`
  - `"buttons": [{ "label": "Got it", "operation": "mark@1", "input"?: { "word": "…", "result": "ok" } }]`
    (up to 3): each runs one of this capability's own operations, **writes included**, when
    pressed, by whoever pressed it (the owner on Home, the agent in a chat; destructive ones are
    confirmed first). The widget then refreshes, so a button can move it on: grade a word and the
    next one shows. Put the item's id in `input`.
  - `"reveal": "…"` (≤ 280 chars): hidden behind a "Show" button until tapped, e.g. the answer on
    a practice card. The platform shows it; nothing is written.
  - Buttons and "Show" share one row (a medium widget fits about 4 short labels, 1–2 words each).
    A card you interact with (reveal + grading) reads best large: offer large, and medium only
    if the text is short.
- Keep strings short (titles ≤ 80, captions ≤ 80). Write for a glance: the number first.
- **Drawing a widget is read-only; pressing its buttons is not.** The widget operation must be
  `"sideEffect": "read"`; it runs with state it can only read (any INSERT/UPDATE/DELETE/CREATE
  throws), may call other capabilities' read operations only, and has no `ctx.model`. Compute
  from stored data; never fetch or generate on render. Changes happen in the operations its
  buttons call. If it takes input (e.g. which list), the owner sets it when placing the widget;
  give every property a default so `{}` works.
- Name widget operations `widget_<name>` and declare `outputSchema` loosely (`{"type":"object","required":["template"]}`):
  the platform checks the output against the template itself.
- Every widget needs a test case for its operation; validation checks its output against the
  template, read-only. Seed data with earlier cases so the widget shows something real.

### Connections (ABI 2.1)

A connection wraps **one** external service that needs credentials (GitHub, Spotify, a self-hosted server…) and
exposes its API as operations. It is the only kind of capability that may declare `secrets`.

```json
{
  "abi": "2.1",
  "kind": "connection",
  "config": [{ "name": "SERVER_URL", "description": "Your Nextcloud server, e.g. https://cloud.example.com" }],
  "requires": {
    "secrets": [{ "name": "APP_PASSWORD", "description": "An app password from Nextcloud's security settings" }],
    "hosts": ["config:SERVER_URL"]
  }
}
```

- **Generic API operations only:** `list_files`, `upload_file`, `list_issues`, `create_issue`…
  Use-case logic (a weekly digest, a summary for one purpose) belongs in the capability that calls the
  connection. Restrict what can be done by leaving operations out (no `delete_file` means nothing can delete).
- **`health@1` is required:** a `read` operation with no required input returning
  `{ "status": "connected" | "expired" | "broken", "detail"?: string }`. The platform calls it for the
  owner's Accounts view. Make it cheap: one authenticated request, or none if the credentials are missing.
- **Credentials only in the secret store.** Refreshed tokens go back with `ctx.updateSecret(name, value)`,
  never into the database.
- **Config is not secret:** settings the owner fills in, like a server URL, are `config` (read them as
  `ctx.config.SERVER_URL`). A host can come from config: `"config:SERVER_URL"` in `requires.hosts` means the
  host in that value. Test cases may pass fake config: `"config": { "SERVER_URL": "https://cloud.example.com" }`.
- **A sign-in step for login flows (optional):** when the service needs a login rather than a pasted key,
  add a `connect` operation (`write`). Only the owner runs it, in Hewn (agents never can); it runs before the
  secrets exist, so it is how they get filled. Its input is the sign-in form (mark passwords
  `"format": "password"`); it signs in and stores the tokens with `ctx.updateSecret`, then returns
  `{ "status": "connected" }`. For a second step (a code from an email or app), return
  `{ "status": "needs_input", "message": "Enter the code we sent you", "inputSchema": { …the next fields… }, "state": "<opaque>" }`;
  the owner's next call carries your `state` plus the new fields. Keep the first step's schema to what's
  needed up front. A connection with a sign-in step gets its secrets only through it, so describe them as
  "stored by signing in".
- A connection has no UI; the owner sees it under Accounts.

### Deprecating and removing operations (ABI 2.1)

Published operations can't simply disappear. To retire one, mark it in capability.json:

```json
{ "name": "search", "version": 1, "deprecated": { "replacement": "find@1", "note": "find pages through results" }, … }
```

It keeps working; callers see the notice. A later version may remove it, and validation allows that
only if it was already deprecated in the active version and no capability or schedule still uses it.

### UI

Ship a human UI when the owner will look at or enter data themselves: a tracker, a list, a log, a
dashboard, a review. Skip it for plumbing that only agents or other capabilities call (and a
connection never has one). Set `"ui": { "available": true }` and put static files in `ui/`, with
`ui/index.html` as the entry point. The platform serves it at `/tools/<id>/` under Hewn's address, in a
browser sandbox: the page gets an origin of its own (an opaque one). The UI is just another client:
it calls the capability's own public operations, and nothing else:

```js
const call = (operation, input = {}) =>
  fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hewn-ui": "1" },
    body: JSON.stringify({ operation, input }),
  }).then((r) => r.json()); // { result } or { error, message, details }
```

#### Design it before you write it

A screen the owner opens every day has to feel finished. Before writing `ui/`, decide (and write
down in your notes, not in the page):

1. **The moment:** who opens it, when, and what they want to know or do in the first five seconds.
2. **The answer first:** the one number, list or chart that answers that, at the top.
3. **The main action:** the one thing they do most (log a run, add a word), reachable without
   scrolling, with a form that needs as little typing as possible.
4. **Day one:** what the screen looks like with no data, and how the empty state leads to the main action.
5. **What's left out:** a first version does a few things well. Everything else waits for a change request.

Then build it from the design system below, and check it like a user would (see the checklist).

#### The design system

Use it for everything, so every capability looks like part of the same product. **Read
`PLATFORM_UI.css` in your workspace before writing any UI:** it is the design system the page gets
from `/_platform/ui.css`, with every class and token. Link `/_platform/ui.css`; don't copy that file
into `ui/` or restyle its controls (inputs, selects, buttons and chips are already styled: don't set
their height, padding, border, background or font size).

```html
<link rel="stylesheet" href="/_platform/ui.css">
<script type="module">
  import { barChart, lineChart } from "/_platform/chart.js";
  barChart(el, { labels: ["W40", "W41"], series: [{ name: "Running", values: [12, 20] }], stacked: true, unit: "km" });
  lineChart(el2, { labels: ["Mon", "Tue", "Wed"], series: [{ name: "Pace", values: [5.4, 5.2, 5.3] }], unit: "min/km" });
</script>
```

- **Layout:** `<main class="page stack">`, `.row` / `.row.between`, `.grid`. Surfaces: `.card`.
  Key numbers: `.stats` holding `.stat` (each with a `.value` and a `.label`). Section labels: `.eyebrow`.
- **Buttons:** plain `<button>`; `.primary` for the one main action per view, `.ghost` for quiet ones,
  `.danger` for destructive ones, `.sm` / `.lg` sizes. Links that act like buttons: `<a class="btn">`.
- **Fields:** `<label class="field">` holding a `<span class="label">`, the control, and an optional
  `<span class="hint">`. Text inputs, `<select>` and `<textarea>` are styled already (`.sm` for compact
  rows, `.code` for monospace). Use the right input type (`date`, `number`, `email`, `url`); mark
  required ones `required`.
- **Choices:** `.segmented` (buttons with `aria-pressed`) for 2–4 options, `<select>` for more,
  `<input type="checkbox" class="switch">` for on/off, `.stepper` (− `<output>` +) for small counts.
- **Chips:** `.chip` for filters and links to things (`.plain` without an icon, `.selected` or
  `aria-pressed="true"` when active, `<span class="caret"></span>` when it opens a menu,
  `<span class="x">×</span>` to clear).
- **Data:** `<div class="table-wrap"><table>`, with `td.num` for numbers. `dl.kv` for key/value pairs.
  Rows of things: `ul.list` (each `li` with a `.grow` and an optional `.sub`).
  Status: `.pill` (`.ok`, `.warn`, `.bad`, `.accent`, `.with-dot`). Messages: `.notice` (`.ok`, `.danger`, `.info`), `.muted`.
- **States:** loading is `.skeleton` blocks, not "Loading…" text. No data yet: `.empty` (a `<strong>`
  line, one short sentence, and the main action as a button). Feedback after an action: a `.toast`
  inside a fixed `.toast-region`.
- **Charts:** `barChart` (grouped or `stacked`) and `lineChart` from `/_platform/chart.js`; series colours are automatic.
- **Tokens only:** no custom colours, gradients, shadows or fonts. `--accent` is a fill (buttons,
  highlights); accent-coloured text uses `--accent-ink`. Other tokens: `var(--text-2)`, `var(--surface)`, …
  Every UI must work in light and dark (`prefers-color-scheme`); never hard-code a colour.

#### Checklist (do all of these)

- **Forms:** sensible defaults (today's date, the last value used, the most common choice); Enter
  submits; the first field is focused; the button is disabled while saving; after success the form
  clears (or closes) and the new item shows up at once; after a failure the input stays and the
  error is shown next to the form (`.notice.danger` with the operation's `message`).
- **Formatting:** dates and times readable and local (`Intl.DateTimeFormat`, "today", "3 days ago"),
  numbers with units (`12.4 km`, `5:12 /km`), never raw ISO strings, ids, or JSON.
- **Order:** the most useful first (newest, most urgent, highest rated), not insertion order.
- **Destructive actions:** ask first (or offer Undo in the toast); say what will be lost.
- **Copy:** plain words from the owner's world, not the API's ("Add a word", not "Invoke add_word";
  no "payload", "record", "operation"). Sentence case. Labels, not paragraphs; no welcome text at the
  top. No emoji or decorative icons.
- **Small screens:** works at 375 px wide: one column, nothing cut off, tap targets ≥ 36 px.
- **Accessible:** real `<button>`s and `<label>`s, visible focus, keyboard reachable.
- **Errors:** an operation's `{ error }` is shown in the page; nothing is thrown or logged as an error.

**The platform renders your UI before promotion**, headlessly, against a fresh empty state, in
light and dark. Any uncaught error, `console.error` or failed request fails the build, and the owner
sees the screenshot. So the empty state must render cleanly.

- `POST /api/invoke` takes `{ operation, input, operationVersion? }`. Without `operationVersion` it calls the
  **latest** contract version of that operation. Pass it explicitly when the UI depends on a specific version.
- `GET /api/manifest` (same header) returns the manifest and readiness `status`.
- The CSP allows only your own files, your API and `/_platform/`: **no CDNs, external scripts, fonts
  or APIs**. Inline `<script>`/`<style>` and files under `ui/` are fine. Plain HTML/JS/CSS, no build step.
- **Link your own files with relative paths** (`app.js`, `img/logo.svg`), never `/app.js`: the UI
  lives under `/tools/<id>/`. `/api/…` and `/_platform/…` work as written.
- **No browser storage:** the sandbox has no `localStorage`, `sessionStorage`, IndexedDB or cookies
  (using them throws). Keep everything in the capability's state through operations; keep only
  view state (an open tab, a filter) in memory or in the URL fragment.

### Contract rules (enforced)

- Published operation contracts (`name@version`) must stay backward compatible: no removed
  fields, no newly required input fields, no type changes, no removed output guarantees,
  no `sideEffect` change.
- Adding an optional input field or a new output field is compatible. Keep the same version.
- A breaking change means adding a new operation version (`name@2`) next to the old one.
  Never delete or edit `name@1`.

### State rules (enforced)

- Existing migration files are immutable. Add new files only: `002_add_x.sql`, ...
- No `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, `TRUNCATE` in migrations, and no
  `BEGIN`/`COMMIT` (each migration file already runs atomically).
- Before promotion, migrations are dry-run on a copy of live state. Live state is backed up
  before they are applied.

### tests/cases.json

An ordered list. All cases share one fresh state DB with all migrations applied:

```json
[
  { "name": "records", "operation": "do_thing", "version": 1, "input": { "x": 1 }, "expect": { "ok": true } },
  { "name": "rejects bad input", "operation": "do_thing", "input": { "x": "no" }, "expectError": true }
]
```

`expect` is a subset match. `"$any"` matches any present value. Cover every operation.
