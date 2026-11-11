---
name: build-a-hewn-tool
description: Build or change a tool (a capability) in the user's Hewn yourself, in a workspace of your own, then hand it to Hewn, which checks it and goes live or holds it for the owner. Use when the user asks you to write a Hewn tool instead of asking Hewn's builder. Needs Hewn's MCP tools capabilities_pack, capabilities_check and capabilities_submit.
---

# Build a Hewn tool

Hewn holds the user's tools: durable capabilities with their own state, typed operations and an optional screen. You can write one yourself and hand it to Hewn, which validates it exactly as it validates its own builder's work (the contracts, the tests, the migrations on a copy of the owner's data, the screen) and decides what goes live. You never promote anything.

1. **Fetch the pack:** `capabilities_pack` with `kind: "create"`, or `kind: "modify"` and the tool's `capabilityId`. The pack is what Hewn's builder finds in its workspace besides the request: the owner's other tools' contracts (`CONTRACTS.md`, and `.hewn-contracts/<id>.md` with each one in full), their looks (`OTHER_TOOLS.md`) and the design system (`PLATFORM_UI.css`); for a change, the tool's current files too. With a shell, download the pack (`download.url`) and unzip it into your workspace, the folder you write the tool in: `curl -fsSL -o pack.zip '<download.url>'`, then unzip it there. The link works once, for 10 minutes: fetch it once, yourself; if it answers 404, call `capabilities_pack` again for a new one. Without a shell, page the pack: `files` is a page, `more` lists the rest, and `capabilities_pack` with `paths` fetches them a page at a time. Read its reference files there and write only the tool's own files into your workspace. A paged pack leaves out `.hewn-contracts/`: `capabilities_get` has a tool's contract. A change's pack also has `schedules`, the owner's schedules on the tool, each `{ operation, cadence, status }` with `operation` as `name@version`: a schedule runs exactly that operation version, so keep each one in `capability.json`, whatever its `status` (Hewn's checks fail a version without one). For a contract the pack didn't carry, `capabilities_get`.
2. **Write the tool** by the contract below. What to build comes from the person you're talking to.
3. **Check it** with `capabilities_check` while you work, until it passes (the end of this file says how).
4. **Submit it** with `capabilities_submit`: the tool's own files only, a `request` saying what it is or what the change does, and for a change `capabilityId` and the pack's `baseVersion`. Not the pack's files, `screenshots/`, dotfiles or a builder's instructions (`CLAUDE.md` and the like): Hewn refuses them, naming the rule. Follow the build with `builds_wait`. Once it passes, a new tool waits for the owner's approval, and so does a change (status `review`): tell them. What a new tool needs from the owner, a host or a key, they approve in Hewn too.

## Implementation contract

Write a **candidate** in your workspace; Hewn owns validation and promotion. Passing candidates become immutable versions; an agent's new tool or change waits for the owner's review. The current version serves until promotion.

When the tool is complete, check it with `capabilities_check` until it passes, then submit it with `capabilities_submit` (above). Hewn validates it again; if that fails, the build says why: fix it and submit again.

Workspace layout:

```
capability.json      public manifest (id, name, purpose, abi, hue, tags, operations)
src/index.ts         implementation (TypeScript; the entry point the platform bundles)
package.json         optional: npm dependencies (the platform installs and bundles them)
migrations/NNN_*.sql state schema (SQLite), append-only
tests/cases.json     test cases the platform runs before promotion
sample/calls.json    sample data: calls that fill an empty tool with made-up entries (see below)
ui/index.html        optional human UI: static HTML, CSS and JS
ui/icon.svg          app icon: a 5×5 pixel glyph (see "Icon")
ui/look.json         with a UI: its look (palette, type, layout; see "Design it before you write it")
```

### Runtime

Capabilities run as JavaScript in a V8 isolate, like a Cloudflare Worker. The platform bundles `src/index.ts` and its imports into one module. Leave `"runtime"` out of capability.json.

Call chains have 30 seconds, with up to 120 seconds of model waiting excluded; widgets have 15 seconds. `ctx.call` chains reach at most three capabilities, with no cycles or self-calls. Batch long work and report progress for later calls.

### capability.json

Set `"abi"` to the lowest Hewn ABI (`major.minor`) whose features you use; this Hewn implements 2.6. Features after 2.0 are marked "(ABI 2.x)"; if you use none, write `"abi": "2.0"`. Using a feature newer than you declare fails validation.

Keep `id` equal to the tool's id: for a change, the `capabilityId` you packed; for a new tool, its name in lowercase letters, digits and dashes ("Plant Care" → `plant-care`). Each operation has `name` (snake_case), `description`, `version` (contract major, integer ≥1), `inputSchema` and `outputSchema` (JSON Schema 2020-12; input must be `type: object`), and `sideEffect`:

- `read`: changes nothing.
- `write`: records or changes data.
- `destructive`: removes or irreversibly overwrites data. Agent calls require owner confirmation, including through other capabilities; these operations cannot be scheduled. An operation that deletes rows and adds none to that table (also as a side effect, like clearing a list) must be `destructive`: validation counts each table's rows around every test case and sample call. Replacing rows with new ones is a write. Don't prune caches in a write: filter old rows when you read them.

Set `"hue"` (integer 0–359, OKLCH) to the colour the subject is known for (e.g. 145 plants or money, 295 sleep, 240 water, 25 workouts, 75 for books). A subject without one (people, plans, words, time) takes a hue at least 40° from every hue in `OTHER_TOOLS.md` (hues wrap: 350 and 10 are 20° apart), or, when none is that far, the middle of the widest gap, which `OTHER_TOOLS.md` names. The hue colours the icon tile and leads the UI palette; the design system derives light and dark shades from it.

`"saturation"` (ABI 2.4; integer 0–150, default 100) is how colourful the tile is. Set it only for a brand, with the brand's hue: `0` for a black-and-white service (Ghost, Notion, the BBC: black or white on grey), 30–60 for a muted brand, up to 150 for a loud one (Todoist red).

Never write `"source"` (ABI 2.5), or `hub` and `minVersion` in `requires.capabilities`: the platform writes them.

### Icon

**New tools:** after reading this brief and the pack's `OTHER_TOOLS.md`, make `ui/icon.svg` and `"hue"` part of the tool from the start: the owner's review card and Home show them. On retries and changes, preserve the existing icon and hue unless the request asks for a new identity; add a missing icon when the build scope allows it.

Ship `ui/icon.svg` as a **5×5 pixel glyph**, even with no other UI:

- `viewBox="0 0 5 5"`, whole-unit `<rect>`s only (`width="1" height="1"`)
- `fill="currentColor"` and `shape-rendering="crispEdges"` on `<svg>`; no colours in the file
- 7–17 lit cells, one simple idea from the subject, readable at 28px
- centred: the lit cells' bounding box sits mid-grid (an empty column left needs one right, an empty row top one bottom; a 4-wide shape uses columns 0–3 or 1–4 only when it reads better)

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

- `ctx.db` is this capability's private SQLite database, **synchronous** (no `await`). `db.transaction(() => { … })` groups writes atomically and nests. `BEGIN`/`COMMIT`/`ROLLBACK`, `SAVEPOINT`/`RELEASE` and `ATTACH` are not allowed.
- Handlers may be `async` (for `fetch` or `ctx.call`) and return plain JSON. Input is validated against `inputSchema` before they run, output against `outputSchema` after.
- Available: standard web APIs (`fetch`, `crypto`, `URL`, `TextEncoder`, `Date`, …) and host-free Node built-ins (`node:crypto`, `node:buffer`, `node:util`, …). **Not available:** a filesystem (`node:fs` sees an empty throwaway disk), child processes, raw sockets, environment variables. Keep everything in the database.
- npm packages: list them in `package.json` `dependencies` and import normally. Pick browser/Worker-safe packages (no native addons or `fs`-heavy tooling); don't commit `node_modules`. Registry versions only (`"^1.2.0"`): a git, `file:`, `link:` or URL dependency, or an `.npmrc`, fails the build.
- `console.log`/`console.error` are the capability's logs, which the owner sees.

### Network and credentials (`requires`)

A capability that needs the network declares its hosts:

```json
"requires": { "hosts": ["api.example.com"] }
```

**Only connections hold credentials (ABI 2.1).** A service needing a key, token or login is wrapped by a *connection* (`"kind": "connection"`, see "Connections"); ordinary capabilities can't declare `secrets` and call its operations instead. A public keyless API (e.g. weather) is a plain host.

- `fetch` reaches declared, owner-approved `hosts` only; anything else gets `403`.
- Builders never see production credentials. At runtime a connection reads its secrets as `ctx.secrets.API_TOKEN` and saves a refreshed one with `ctx.updateSecret(name, value)`. Test cases pass fakes: `"secrets": { "API_TOKEN": "fake" }`.
- Operations that don't need the network work offline; network operations fail with a clear error when offline or missing secrets. Put pure logic (parsing, aggregation) in functions test cases can exercise.
- **Readiness:** until every declared grant (hosts, other operations, model), secret and config value is in place, ordinary calls fail with `not_ready`, even for operations that don't use them. The owner approves new authority after promotion, so request the minimum and prefer other capabilities' read operations.

### Calling other capabilities (composition)

Use another capability's public operations instead of duplicating its data (record runs in Running Log, not your own runs table). The owner's other capabilities are in the pack's `CONTRACTS.md`, which lists their operations, and `.hewn-contracts/<id>.md` has each one's full contract: read it before you call one.

1. Declare every call, pinned to a contract version:
   ```json
   "requires": { "capabilities": [{ "id": "running-log", "operations": ["record_run@1", "list_runs@1"] }] }
   ```
2. Call through the platform: `const out = await ctx.call("running-log", "list_runs@1", { from: "2026-10-01" });`

   Undeclared or ungranted calls fail; the callee validates your input.
3. Mock calls in test cases:
   ```json
   { "name": "...", "operation": "weekly_review", "input": {}, "calls": { "running-log/list_runs@1": { "runs": [] } }, "expect": { ... } }
   ```
4. `ctx.caller` (`{ kind, id }`, e.g. `{ kind: "capability", id: "reading-stats" }`) says who called:
   use it for provenance (e.g. store `source`), not authorization.

### Using a model (ABI 2.2)

For work only a language model can do (explain a word, summarise a note, read a receipt photo), ask the platform to run one. Never call a provider or ask for an API key: keys, model choice and budget are the owner's, in Hewn.

1. Declare the lowest tier that does the job (`light`, `standard`, `strong`, `max`), plus
   `"input": ["image"]` if prompts carry images:
   ```json
   "abi": "2.2",
   "requires": { "model": { "tier": "light" } }
   ```
   Pin an exact model (`{ "model": "anthropic/claude-sonnet-5-5" }`) only when the owner asks.
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
     (png, jpeg, webp, gif; each ≤ 5 MB and 8000 px a side, 20 per call). `messages`
     (`[{ role: "user" | "assistant", content }]`) replaces `prompt` for a conversation.
   - When code reads data from the reply, pass `schema` (type object); the reply is checked and returned parsed as `json`. Don't parse `r.text` yourself.
   - Size `maxTokens` to the longest possible reply, with headroom: a label or sentence 200, a paragraph 1000, a recipe or item list 4000–8000 (default 1024, max 16000). A reply hitting the limit throws ("cut off at this tool's limit") instead of returning half.
   - A call over the owner's budget throws; catch it.
3. **Never block a write on the model.** Store the record with the generated field empty, then fill gaps in a separate best-effort operation (e.g. `enrich_missing@1`) that does as many as fit and returns `{ "done": n, "remaining": m }`. If the model is down or over budget, the import still succeeds; the next run fills the rest.
4. Outside text (tasks, notes, web pages, images) can carry instructions. Model output is data: store or show it, never execute it or let it steer your code.
5. Fake replies in test cases: `"model"` lists them in call order (`{ "text": "..." }`, `{ "json": {...} }` or `{ "error": "..." }`):
   ```json
   { "name": "explains", "operation": "enrich_missing", "input": {}, "model": [{ "json": { "explanation": "Happy." } }], "expect": { "done": 1 } }
   ```

### Widgets (ABI 2.3)

A widget is a glanceable card on Hewn's Home and in agents' chats, drawn by the platform. You write no HTML: write a **read** operation returning a view for one of five templates, and declare it (up to eight per tool):

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

- `sizes`: `small` (1×1, ~110 px: one number), `medium` (2×1: a number with context, 3 list rows, a short chart), `large` (2×2: 5 rows or a taller chart). Offer only sizes the content fits; one is fine. An interactive card (reveal, grading, buttons) suits `["large"]`, plus medium only if its text is short. Validation draws every offered size and **fails one whose content (or revealed text) is cut off**.
- `refresh.every`: 5m–24h, while Home is open (default 30m).
- `open` (needs a UI): where a tap lands; `"ui#section"` opens the UI with `location.hash` set to `#section`. Default: the capability.
- Return one view (below), **or one per size** when bigger sizes show more: `{ "medium": { "template": "text", … }, "large": { "template": "list", … } }` (a size without its own view uses the nearest). Use the room: a large widget repeating the medium's two lines wastes it.
- Views (every template takes optional `buttons`; stat, list and text also take `reveal`):
  - `{ "template": "stat", "value": 7, "unit"?: "km", "caption"?: "words to test" }`
  - `{ "template": "list", "items": [{ "title": "…", "detail"?: "…", "value"?: "…" }], "empty"?: "Nothing due" }` (at most 5 items)
  - `{ "template": "chart", "kind"?: "bar" | "line", "labels": ["Mon", …], "series": [{ "name": "Sleep", "values": [7.2, …] }], "unit"?: "h", "caption"?: "…" }` (≤ 31 labels, ≤ 3 series, one value per label)
  - `{ "template": "progress", "value": 2, "max": 3, "label"?: "2 of 3 runs", "caption"?: "…" }`
  - `{ "template": "text", "text": "…" (≤ 280 chars), "caption"?: "…" }`
  - `"buttons": [{ "label": "Got it", "operation": "mark@1", "input"?: { "word": "…", "result": "ok" } }]`
    (up to 3): each runs one of this capability's own operations, **writes included**, as whoever pressed it (owner on Home, agent in chat; destructive ones confirmed first). The widget then refreshes, so a button can advance it: grade a word, the next shows. Put the item's id in `input`.
  - `"reveal": "…"` (≤ 280 chars): hidden behind "Show" until tapped, e.g. a practice card's answer. Nothing is written.
  - Buttons and "Show" share one row (medium fits ~4 labels of 1–2 words).
- Limits: widget title ≤ 40; list item title and detail, captions and empty text ≤ 80; unit ≤ 12; chart label ≤ 16, series name ≤ 24; progress label ≤ 40, `max` > 0; button label ≤ 24. Unknown view fields fail validation. Write for a glance: the number first.
- **Drawing is read-only; buttons are not.** The widget operation is `"sideEffect": "read"` and runs with read-only state (any INSERT/UPDATE/DELETE/CREATE throws), other capabilities' read operations only, no `ctx.model`, secret updates dropped. Compute from stored data; never fetch or generate on render. If it takes input (e.g. which list), the owner sets it when placing the widget; default every property so `{}` works.
- Name widget operations `widget_<name>` with `outputSchema` `{"type":"object"}`; the platform checks each view against its template (a required top-level `template` breaks per-size views).
- Every widget needs a test case; seed data with earlier cases so it shows something real.

### Connections (ABI 2.1)

A connection wraps **one** credentialed service (GitHub, Notion, a self-hosted server…) and exposes its API as operations.

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

- **Generic API operations only** (`list_files`, `upload_file`, `create_issue`…). Use-case logic (a weekly digest) belongs in the capability calling the connection. Leave operations out to restrict it (no `delete_file`: nothing can delete).
- **`health@1` is required:** a `read` operation with no required input, returning `{ "status": "connected" | "expired" | "broken", "detail"?: string }` for the owner's Accounts view. Keep it cheap: one authenticated request, or none without credentials.
- **Credentials live only in the secret store:** refreshed tokens go back via `ctx.updateSecret`, never the database.
- **Config (any tool, ABI 2.1):** settings the owner fills in that aren't secret, with unique names matching `^[A-Z][A-Z0-9_]*$`, read as `ctx.config.SERVER_URL`. `"config:SERVER_URL"` in `requires.hosts` means the host in that value. Test cases pass fakes: `"config": { "SERVER_URL": "https://cloud.example.com" }`. A setting with an obvious answer gets `"suggested": "<value>"` (ABI 2.6: set `"abi": "2.6"`): the setup form opens with it and the owner confirms. Never `"default"` (refused), never in the description, and never on a setting `requires.hosts` names as `config:NAME` (the owner types the host).
- **Sign-in step (optional):** for a login rather than a pasted key, add a `connect` operation (`write`). Only the owner runs it, in Hewn (never agents or schedules). It may run before secrets exist, but other grants, config and dependencies must be ready. Its input is the sign-in form (passwords `"format": "password"`); it signs in, stores tokens with `ctx.updateSecret` and returns `{ "status": "connected" }`. For a second step (a code from email or an app), return
  `{ "status": "needs_input", "message": "Enter the code we sent you", "inputSchema": { …the next fields… }, "state": "<opaque>" }`;
  the owner's next call carries your `state` plus the new fields. Ask only what's needed up front. Its secrets arrive only through it, so describe them as "stored by signing in".
  No OAuth: Hewn can't open a service's "Allow access" page or take its redirect, so OAuth-only services (Google Calendar, Spotify…) can't connect yet.
- No UI or widgets; the owner sees it under Accounts.

### Deprecating and removing operations (ABI 2.1)

Published operations can't simply disappear. To retire one, mark it:

```json
{ "name": "search", "version": 1, "deprecated": { "replacement": "find@1", "note": "find pages through results" }, … }
```

It keeps working and callers see the notice. A later version may remove it only if it was deprecated in the active version and no capability or schedule still uses it.

### UI

Ship a UI when the owner looks at or enters data: a tracker, list, log, dashboard, review. Skip it for plumbing only agents or capabilities call (connections never have one). Set `"ui": { "available": true }` and put static files in `ui/`, with `ui/index.html` as the entry point. It is served at `/tools/<id>/~<key>/` in a sandbox with its own opaque origin, and calls only its capability's public operations.

The platform injects `session.js` before your scripts. It authenticates and routes API requests and provides:

```js
const out = await hewn.call("record_run", { distanceKm: 5 });
if (out.error) showError(out.message);
else render(out.result);
```

#### The UI is the product

The owner judges the tool by this screen: a correct backend behind a bland form is a failed build. The request is the floor, not the ceiling; make a screen the owner is delighted to open. Aim high in design, not scope: no operations, grants or workflows the request didn't ask for.

#### Design it before you write it

For a **new UI or requested redesign**, read `OTHER_TOOLS.md` when present. Before UI code (after a new tool's icon), write a short design plan as a message:

1. **Moment:** who opens it, when, and what they need within five seconds. Put that answer first and largest; keep the main action beside what it acts on, with minimal typing.
2. **Three directions:** explore different concepts, layouts, type and signature visuals from the subject's world (race bib, recipe cards, workshop manual). Pick the strongest for the owner's task and say why; distinguish it from their other tools by more than colour.
3. **Palette and type:** lead with the manifest hue, then a second colour family, an accent and neutrals, each with light and dark values; backgrounds stay neutral (see "Backgrounds" in the checklist). Specify display, body, number and small-label font stacks, the layout and the signature visual. Check "Looks to avoid" below.
4. **Data:** the drawn data is the main content: at least one large custom SVG/canvas visual that fits it better than a table or form (timeline, calendar heatmap, gauge, ring, room map), labelled and sized to its data, and an intentional empty state that leads to the main action.
5. **Something extra:** one or two touches nobody asked for (a computed insight, a streak, a learned default), built on the requested operations.

Record the result in `ui/look.json`: `{"hue": …, "palette": {"name": "#hex", …}, "type": {"display": "…", "body": "…"}, "layout": "…", "signature": "…", "mood": "…"}`. Other tools' builders see this record.

**Changes:** keep the concept, icon, hue, palette, type and layout unless the request asks for a new look, but make a tinted page background neutral. Design additions to fit, and skip the three directions for routine changes. Keep `ui/look.json` accurate, or record the existing look if it's missing.

#### The design system is your base, not your limit

**Read `PLATFORM_UI.css` before UI code.** Link `/_platform/ui.css` (don't copy it) for reset, controls, tokens and themes, then build the concept on it: your palette, a type scale with real hierarchy, and gradients, shadows, textures or illustration where they serve. Your CSS outside its `hewn` cascade layer overrides base selectors. System font stacks only (`system-ui`, `ui-serif`, `ui-rounded`, `ui-monospace`); external fonts can't load.

- Base classes: `.page` (centred, max 960 px), `.stack`, `.row`, `.grid`, `.card`, `.stats`, `.pill`, `.chip`, `.segmented`, `.switch`, `.stepper`, `.field`, `.table-wrap`, `.empty`, `.skeleton`, `.toast-region`/`.toast`. Use those that fit the plan, and widen the layout when the data needs room.
- The base accent is Hewn's own acid green: set `--accent` (primary fill), `--accent-text`, `--accent-ink` (links and focus) and `--accent-soft` from your palette.
- `/_platform/chart.js` has `barChart(el, { labels, series: [{ name, values }], stacked?, unit? })` and `lineChart(el, { … })` for plain series; draw anything more specific yourself.
- Use purposeful transitions and feedback; respect `prefers-reduced-motion`.

#### Looks to avoid

Every model reaches for these, so they look generated. Lead with the subject; justify any exception in the plan:

- A high-contrast serif display with terracotta, clay or peach: the default "tasteful" look.
- Near-black with acid green, lime or vermilion (Hewn's own look); purple or blue gradients on white; corner gradient washes.
- Tracked-out ALL-CAPS micro-labels or `.eyebrow`; use size, weight and position for hierarchy.
- Repeated `Label: value` rows or middle-dot metadata strings. Give facts meaningful columns, lines or visual encodings.
- Oversized serif number plus sentence as every hero; identical rounded cards for every section; badges on everything.
- A single hue ramp as the whole palette; emoji icons (use SVG unless emoji belong to the concept).

#### Checklist (do all of these)

- **Hierarchy:** one primary answer, and each piece of data in one place. Use the desktop width without half-empty panels. Show the 5–8 list items that matter and a way to see all; a long history reads better as a visual. Forms other than the main action live behind a button, sheet or disclosure.
- **Backgrounds:** the page and its surfaces are always white or pale grey in light, black or near-black grey in dark (the base's `--bg` and `--surface` already are). The tool's colour goes into its data, visuals and accents, never the page.
- **Dark mode:** give every colour both values, `--leaf: light-dark(#2f7a4a, #8fd4a6)`, and use colour tokens inside shadows and gradients. This follows Hewn's Light, Dark and System settings; a plain `prefers-color-scheme` follows System only.
- **Phone:** design from 375 px (validation uses 390) in this order: answer, action, visual, rest. Use `min-width: 0` on grid and flex children, `max-width: 100%` on images and SVG, wrapping rows and `overflow-wrap: anywhere`, and keep chart labels from colliding. Tap targets are at least 36 px.
- **Forms:** sensible defaults; Enter submits; the first field is focused when the form opens; the button is disabled while saving. Success clears or closes the form and shows the change at once; failure keeps the input and shows the error beside the form (`.notice.danger`).
- **Formatting and order:** readable local dates (`Intl.DateTimeFormat`, "today", "3 days ago") and numbers with units; the most useful first (newest, most urgent, highest rated). No raw ids, ISO timestamps or JSON on screen.
- **States and actions:** done, due, late and selected tell apart at a glance. A destructive action asks first and says what will be lost, or offers a working Undo.
- **Copy and accessibility:** short, specific words from the owner's world ("Add a word", not "Invoke add_word"), sentence case, no welcome block or API jargon. Real buttons and labels, visible focus, keyboard access, readable contrast. Truncate only where the full text is available elsewhere, and keep action labels meaningful.
- **Errors:** show an operation's `{ error, message }` in the page and catch rejected requests, keeping the input and the page usable. No uncaught errors or `console.error`.

Before you stop, reread your UI against this checklist and "Looks to avoid"; fix what you find.

**The platform renders your UI before promotion** on empty and sample-filled databases, and the owner sees the screenshot. An uncaught error, `console.error` or failed request fails the build. These renders are offline: no network, other tools or model, and test cases' `calls` and `model` fakes don't apply. Operations the page calls on load must return a schema-valid empty or unavailable result when a source is out of reach, so no request fails. Show that state honestly; never hardcode fake results.

- `POST /api/invoke` takes `{ operation, input, operationVersion? }`; without `operationVersion` it calls the **latest** version. Pass it when the UI depends on one.
- `hewn.manifest()` or `GET /api/manifest` returns the manifest and readiness `status`. `session.js` adds the API headers to your requests.
- The CSP allows only your own files, your API and `/_platform/`: **no CDNs, external scripts, fonts or APIs**. Inline `<script>`/`<style>` and files under `ui/` are fine. Plain HTML/JS/CSS, no build step.
- **Link your own files with relative paths** (`app.js`, `img/logo.svg`), never `/app.js`; `/api/…` and `/_platform/…` work as written.
- **No browser storage:** `localStorage`, `sessionStorage`, IndexedDB and cookies throw. Keep data in the capability's state; keep view state (an open tab, a filter) in memory or the URL fragment.

### Contract rules (enforced)

- Keep each published `name@version` compatible: no removed fields or changed types, no new required inputs, narrowed input enums or tighter input constraints, no weaker output guarantees, no `sideEffect` change. Changing composite schema keywords (`oneOf`, `$ref`, …) counts as breaking.
- Compatible additions (an optional input field, a new output field) and implementation fixes keep the version.
- Breaking changes add `name@2` beside the working `name@1`. Removal follows "Deprecating and removing operations" above.

### State rules (enforced)

- Existing migration files are immutable; add new ones (`002_add_x.sql`, ...).
- No `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, `TRUNCATE` or `BEGIN`/`COMMIT` in migrations (each file already runs atomically).
- Before promotion, migrations dry-run on a copy of live state, and live state is backed up before they apply.

### tests/cases.json

An ordered list. All cases share one fresh state DB with all migrations applied:

```json
[
  { "name": "records", "operation": "do_thing", "version": 1, "input": { "x": 1 }, "expect": { "ok": true } },
  { "name": "rejects bad input", "operation": "do_thing", "input": { "x": "no" }, "expectError": true }
]
```

At least one case; cover every operation. `expect` matches object subsets; arrays must have equal length and match in order. `"$any"` matches any present value. `version` defaults to the highest, `input` to `{}`.

**Validation is offline:** no network, no real secrets, no other capabilities, no model. Cases supply fakes via `secrets`, `config`, `calls`, `model` keys (examples in each section).

### sample/calls.json (ABI 2.5)

Sample data shows the tool in use: on install, on Start over, when shared and in screenshots. A new tool with a UI and a Polish build require it; keep it valid when operations change.

```json
[
  { "operation": "add_plant", "input": { "name": "Monstera", "room": "Living room" } },
  { "operation": "log_watering", "input": { "plant": "Monstera", "date": "2026-10-20" } }
]
```

Between 1 and 200 calls, in order; aim for 5–20 writes that fill the UI and widgets. `version` defaults to the highest, `input` to `{}`. They replay on a fresh database before promotion and when the owner installs or starts over, with no secrets, config values, network, other tools or model; a call that fails fails validation. Use made-up data that looks real, never the owner's data or conversation. A tool with no data of its own (it reads other tools or the network) can use a local read that returns an honest empty or unavailable result; don't add storage or fake behaviour just for screenshots. This file needs no `"abi"` change.

### Check your work: `capabilities_check`

Before you submit, call `capabilities_check` with the tool's files (and `capabilityId` for a change). It runs Hewn's pre-promotion checks (manifest, bundling, contracts, migrations on empty tables, `tests/cases.json`, `sample/calls.json`, widgets) and renders your UI headless, empty and with sample data, at 1280 and 390 px, light and dark. It answers PASS or FAIL with every failure, UI measurements (overflow past the phone edge, cut text, page errors, buttons that break the page) and four screenshots as images, the top of a long page. The text names a long page's further parts; `screenshots: "all"` sends them too, after the four, so ask for them when the page goes on below the screen. `structuredContent.screenshots` names the images sent, in order. With `screenshots: false` no images come back; the UI is still rendered and measured.

Fix failures and measured defects, then look at every screenshot and fix what looks broken, cramped, cut off or unreadable; check again until it passes. PASS can still come with visual defects. You have 30 checks an hour. Checks never promote: `capabilities_submit` validates exactly the files you send, and runs your migrations on a copy of the owner's data too. Don't save the screenshots into the tool: `screenshots/` is never part of one.
