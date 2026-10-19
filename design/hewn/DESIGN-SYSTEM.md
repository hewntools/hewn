# Hewn design system — "Signal"

Hewn is a personal capability platform that runs on the owner's own machine. A *capability* is a small, durable piece of software (Running Log, Reading List, Garmin Training, Weekly Review). It has typed operations, private data and an optional UI. AI agents (Claude Code, Codex) call capabilities over MCP, and the owner uses them through the web client. New capabilities come from plain-language requests: intake chat → spec → builder → validation → owner authorization.

Source: GitHub `hewntools/hewn` (main). See `packages/ui/src/ui.css` (v1), `packages/host-workerd/web/app.css`.

**Direction:** dark smoked glass, a lime signal accent, pixel glyphs, and a mono typeface for machine output. It should feel like a phone home screen for your own software: calm by default, alive only when something is being made.

## Hard constraints (from the brief)
- One stylesheet, `ui/ui.css`, is served at `/_platform/ui.css` to the web client and to every capability UI. Plain CSS, no build step, no external fonts or CDNs.
- **Class names are an API.** All v1 classes still work (see mapping below).
- Light and dark via `prefers-color-scheme`. `data-theme="dark|light"` forces either on any subtree.
- WCAG AA, visible focus, keyboard-usable. Layouts must survive long AI-generated names and empty data.

## Content fundamentals
- **Say less.** One line beats a paragraph. No onboarding prose, no "Welcome to…". The owner hates bloated AI interfaces.
- Sentence case everywhere. Buttons are verbs: *Authorize*, *Build it*, *Try again*, *Not now*.
- Address the owner as "you". The platform doesn't speak as "I" or "we". Intake is the only conversational surface.
- Machine names stay literal and in mono: `record_run@1`, `running-log`. Human names in sans: Running Log.
- Status is a word, not a sentence: *needs you*, *failed*, *live*, *v3*.
- No emoji. No exclamation marks.

## Visual foundations
- **Colour.** Ink background (`--bg` oklch 0.17, cool). Surfaces are translucent white over it (glass), with three text levels. A single accent, lime `--accent`, used as a **fill** (primary button, live dot, progress). Accent-coloured text uses `--accent-ink`, which darkens in light mode. Status: ok/warn/danger/info, each with a `-soft` fill. Charts: `--c1…--c8`, ordered for stacking, with lime first.
- **Type.** System sans (SF Pro on Mac), weights 450/550/650, tight tracking (−0.02em) at 24px and above. Mono (`ui-monospace`/SF Mono) for op names, IDs, logs, table headers, stat labels and eyebrows: 11px caps at +0.06em. Scale: 11/12/13/15/18/24/32/44.
- **Space.** 4px base, s1–s8 (4…64). Pages max out at 960px. The drawer grid uses 72px tiles.
- **Shape.** Pixels (dots, glyph cells, progress blocks) get 1–2px corners and are always square, never round. UI corners are soft: inputs and buttons 8, cards 18, dialogs 24, app icons 28% of their size.
- **Glass.** `.card`, `.glass` and app icons use `backdrop-filter: blur(24px) saturate(1.4)` over translucent surfaces with a 1px light edge. Overlays (menu, dialog, toast) use stronger glass (`--surface-overlay`, `--blur-strong`) with `--shadow-lg`. Every glass surface has a 1px top highlight (`--hl`). Glass needs something behind it, so full screens sit on a `.wallpaper`: 3–5 huge, heavily blurred squares tinted with the owner's capability hues. Not a gradient: soft pixels.
- **Glow.** Dark mode only, and only on *live* things: the live dot, the live progress block, the active step.
- **Backgrounds.** Ink plus `.wallpaper` (soft pixels). No linear or radial gradients. The **ASCII field** (`.ascii-field`, a rotating voxel "H" rendered as shaded ASCII, `ui/ascii-j.js` in `--accent-ink` at 22% opacity) appears only on moment screens: first run/login, intake (new capability) and the live build. Never behind tables, forms or logs, and it's hidden with reduced motion.
- **Motion.** 160ms `cubic-bezier(.2,.7,.2,1)` for hover and focus; buttons scale to 0.98 when pressed. Live things pulse in opacity. No bounces, no slide-ins.
- **Hover/press.** Hover raises a surface one step (`surface-2` → `surface-3`). Primary buttons brighten 6%. Links go from accent-ink to text.
- **Focus.** A 2px `--accent-ink` outline at a 2px offset. Inputs get an accent border plus a 3px soft ring.

## Iconography
- **App icons:** a 5×5 pixel glyph (`viewBox="0 0 5 5"`, whole-unit `<rect>`s, `fill="currentColor"`, `shape-rendering="crispEdges"`) on `.app-icon` with `style="--hue:N"`. The tile and glyph colours derive from `--hue` plus mode tokens, so builders choose only a hue. Fallback: a 2-letter mono monogram on the same tile. Examples are in `assets/glyphs/`.
- **Builder rules:** 7–17 lit cells, one idea per glyph, readable at 28px, no anti-aliasing, no colour inside the SVG.
- UI icons: none in v1. Words and pixel dots instead. Unicode is allowed sparingly (‹ ↗).
- **Brand mark (the flagged H):** a dark 5×5 pixel H with a flag on its left stem (`##..#/.#..#/.####/.#..#/.#..#`) on a lime tile with a 28% radius: `assets/logo/hewn-mark.svg`, plus `hewn-glyph.svg` (currentColor). Lock-up: mark + "Hewn" in sans 650, tight tracking. In dark mode the tile carries `--glow`.
- The ASCII field is the same H, softened and extruded.

## v1 → v2 class mapping
All v1 names are kept. Changes:
- `a`, `.pill.accent` and `button.link` now use `--accent-ink`. Capability UIs that used `color: var(--accent)` for text should switch to `--accent-ink`.
- From `app.css` into `ui.css`: `.menu`/`.menu-item`, `.dialog` (now also bare `<dialog>`), `.thread`. `.msg.user`/`.msg.intake` → `.bubble.me`/`.bubble.them`. `pre.logs` → `.log`. `.icon.mono` → `.app-icon`. `.badge` → `.app-icon .badge`.
- New: `.display`, `.eyebrow`, `.faint`, `.glass`, `.card.flat`, `.notice.info`, `.pill.info`, `.pill.with-dot`, `.dot(.live|.ok|.warn|.danger)`, `button.ghost|.sm|.lg|.icon-only|.danger.solid`, `.field .hint`, `label.check`, `.actions`, `.toast(-region)`, `.empty`, `.skeleton`, `.app-icon(.sm|.md|.lg|.add)`, `.steps > .step(.done|.live|.fail|.todo)`, `.blocks > i(.on|.live)`, `.ascii-field`, `.chart .line`, `.wallpaper`, `.glass-bar`, `.list`, `.chip`, `input.switch`, `.stepper`, `.setting`, `.app-icon.building` (+ glyph fill progress), `.app-icon.brand`, `.cap-ref`, `.app-icon .more`.
- Tokens added: `--surface-solid`, `--surface-3`, `--border-strong`, `--text-3`, `--accent-ink`, `--info(-soft)`, `--bg-2`, `--fs-2xs`, `--fs-3xl`, `--s8`, `--radius-xs/xl/pill`, `--blur`, `--ease`, `--dur`, `--shadow-lg`, `--glow`, `--scrim`, `--log-bg/text`.

## Index
- `styles.css`: entry point (imports `ui/ui.css`)
- `ui/ui.css`: the shippable stylesheet (tokens + components)
- `ui/chart.js`: `barChart` (v1 API) + new `lineChart`
- `assets/glyphs/`: example pixel glyphs
- `guidelines/*.card.html`: foundation specimens
- `components/*/`: component specimens (CSS-class components; no React, by product constraint)
- `Direction Boards.dc.html`: the exploration where 1c was chosen
- Next: key screens (drawer, intake, build) in `ui_kits/web/`

## Patterns
- **Capability references** always render as icon + name (`.cap-ref`), never bare text.
- **Building** capabilities are not openable: the tile desaturates and the glyph lights up pixel by pixel with progress; the label reads "Building… 62%"; a tap opens the build screen.
- **Change is a core action**: Info leads with a "Change it" composer; opened capabilities show a Change… button in their bar; no-UI capabilities show a quiet "Just forms for now · Get a custom screen for it ›" at the foot of the Run view.

## Additions after the handoff (implemented in `packages/ui/src/ui.css`)
Added while building the web client, for things the drop-in didn't cover. Tokens only.
- `.app-icon .icon-img` (owner image filling the tile), `.app-icon .icon-mask` (the builder's `ui/icon.svg` as a CSS mask, so it takes the glyph colour). (`.app-icon .icon-emoji` was removed in pass 2.)
- Building fill: `.app-icon svg rect.unlit` (22% glyph colour) and `.app-icon .faded` (opacity .35 for mask and monogram icons).
- `.side-list`: vertical list of selectable rows (`button[aria-pressed]`), with `.side-foot` at the bottom. Used for operations in the Run view.
- `.composer-card`: the prominent "Change it" composer (accent-soft border and 4px ring), with `.eyebrow.accent` and `input.bare`.
- `.quote`: a quoted note on `--surface-2` (agent requests in the grants sheet).
- `.chip.plain`: a chip without an icon (filters). `.chip` also resets button styles so it works on `<button>`.
- `.glyph-editor`: 5×5 grid of `button[aria-pressed]` toggles for drawing a glyph (Set icon). `input[type=range].hue-range` for the tile hue.
- `.app-icon svg.glyph`: a glyph drawn by the web client as separate pixels (cell 0.8, gap 0.2 of the pitch, `viewBox="0 0 4.8 4.8"`), 60% of the tile. Builder files stay whole-unit rects; the gap is added when drawing.
- `::selection` is stronger than the drop-in's (`--accent-ink` at 35%), and inverted on accent fills, so selected text is visible everywhere. `.cap-ref > .app-icon` stays a centred grid (the drop-in's `.cap-ref > *` made it flex, pulling glyphs left).

## Pass 2 (`design/hewn/handoff-v2/`, built 2026-10-18)
A delta over pass 1 for the flows added since (widgets, building several tools, connections, models, schedules, remote access), plus two dogfood fixes. The frames (F–P) are in the handoff's `Hewn Screens v2.dc.html` and `UX Flows.dc.html` (turn 2).

### Attention: the Inbox, and one banner
- **One place for "needs you":** `button.inbox-btn` (a 5×5 bell glyph, `..#../.###./.###./#####/..#..`) right of the nav, with `.inbox-count` (amber, `.danger` when anything is red). It opens `.inbox-panel`: a `.segmented` Needs you · N / Activity, "All activity ›", then `.inbox-row`s (status dot, 36px tool icon, title + sub-line, one button), Building rows, and Recent. Esc and outside clicks close it; `i` toggles it.
- Needs you holds: pending grants, unresolved failed builds, agents' changes waiting for review, agents waiting for approval, agents' destructive calls, schedule proposals, retired pinned models, model spend at 80% and caps that refuse calls, connections whose health isn't ok. Data: `GET /api/inbox` (`?recent=1` adds the last Activity rows).
- Gone: the builds chip, the dot on Agents, notices above Home's grid, the 15 s schedule toast. Tile badges stay.
- **The one exception:** an agent's destructive call blocks that agent, so `.toast.blocking-banner` ("Codex is waiting for you · Review") shows on every page while one is pending.

### Four dialog patterns (kit.js)
Same `<dialog class="dialog">`, widths 440 or 520, primary bottom-right.
- **Request** (`requestSheet`): 44–48px icon + "X wants to…" + `.small.faint` "Requested by …", an optional `.quote`, a `.list` of rows with a kind pill, then decline / accept. Grants, a new agent, an agent's destructive call (`danger solid` "Allow once"), a schedule proposal, a model grant.
- **Picker** (`pickerSheet`): one of a list of radio rows. Builder, intake, a tool's model, a tier, the icon.
- **Form** (`formSheet`, `sheetSteps` for `.sheet-steps` pills): cap, schedules, connection settings, sign-in, a key, a connection.
- **Confirm** (`confirmDialog`): title, one line, Cancel + action. Delete forever keeps type-the-name.

### Tools by name, and their icons
- Every tool name in the UI has its icon (`capRef` inline, `chip` for filters and "used by"), toasts excepted.
- Icon proportions: the glyph centred at about 56% of the tile at every size; pixels are square under 56px (no `rx`); on 20–28px icons the pixels don't touch the edge. The widget corner icon (`.jw-mark`) is 20px, 10px from the top and right, `line-height: 0`.
- **No emoji icons.** Set icon is Draw (5×5 `.glyph-editor`) or Image, a hue, Use default. The manifest's `icon` field is still accepted but not shown.

### Home
- **First run** is one moment screen (F1): "Make your own tools.", agents on this machine, who works for Hewn (chosen by the owner, never automatically), then Make something (disabled until a builder is chosen). It shows until a tool exists.
- **Edit Home** (F4): right-click empty space, `e`, or the tile menu. `.home-grid.editing` wiggles (±0.6°, 0.34 s; a dashed outline with reduced motion), `.edit-x` hides a tool from Home (it stays in search) or removes a widget, `.size-tag` cycles a widget's sizes. "+ Add widget" opens a Form that only adds (F5). Widget menus have no size items.
- Stale widgets show `.jw-stale-note` ("2 h ago", amber dot) instead of a "!".

### Change while you use it: the drawer
Every Change… opens the tool with `.with-drawer > .drawer-main + .drawer` (400px; a bottom sheet under 860px): `.drawer-head` (eyebrow "Change" + the tool), `.drawer-body` with the intake, then the build (steps and log), then `.notice.ok` "vN is ready" with Reload and Undo. A tool without a UI gets the Run view on the left. Routes: `#/app/:id?change=1`, `#/run/:id?change=1`; `#/change/:id` and `#/widgets/:id` redirect there.

### Proposals and builds
- One `proposalCard` for every reply that proposes something (a tool, a change, ideas, widgets, a schedule, a connection): eyebrow "Proposal · N tools", a row per item (tick box when several, 40px icon, name, purpose, summary pills), ▸ for details on `--surface-2`. A revised proposal collapses the earlier one to one line.
- **No progress bars, milestones only:** `.milestones` pills `spec ✓` `code ✓` `tests 4/6` `you`, or `waiting`. Builds live in Activity (`#/activity?view=builds`).
- **The log stays:** collapsed under "Show log" when a build succeeds, open when it fails.

### Settings sections
`.settings-layout` with a left `.side-list`: General (appearance, time zone, sandbox) · AI (the three jobs, Models) · Remote access · Data (warns when backups share a disk with the data) · About (version, data format, ABI, upgrade).

### Agents, jobs and models
| Job (owner-facing) | Internal | Runs on | Paid by |
|---|---|---|---|
| Writes the spec | intake | an agent CLI on this machine | your subscription |
| Builds tools | builder | an agent CLI on this machine | your subscription |
| Thinks inside tools | model port | provider API | your API key, metered |

Agents (inbound MCP) show one row per identity with `.role-chips` ("uses your tools" accent; "builds tools", "writes the spec" link to Settings › AI). "Add…" offers the three ways in. A model is a grant row with a tier select; with no provider, the key goes in the same sheet.

### New classes (`packages/ui/src/ui.css`, from `ui-additions.css`)
`.inbox-btn`, `.inbox-count(.danger)`, `.inbox-panel`, `.inbox-row`, `.blocking-banner`, `.with-drawer`, `.drawer(-main|-head|-body)`, `.home-grid.editing`, `.edit-x`, `.size-tag`, `.jw-mark` (20px corner), `.jw-stale-note`, `.settings-layout`, `.role-chips`, `.milestones`, `.sheet-steps`, `.command-block` (a command or address to copy, on the log surface).

### After the first review (2026-10-18)
- **Command palette:** `.palette-btn` in the top bar (⌘K, "/"), a `dialog.palette` with one search over tools (Open; Change… and Info when you type), connections, actions and places. It replaces Home's search, and finds tools hidden from Home.
- **Logos for agents and providers:** brand marks as `.icon-mask.logo` on the tile (from `packages/host-workerd/web/logos/`, Simple Icons and LobeHub; see its `SOURCES.md`); the monogram when there's none.
- **Motion means work:** only something in progress pulses (a build, the Inbox's `.inbox-building` pixel). "Thinking" in a chat is three bouncing dots (`.bubble.typing > i`).
- Dialogs open with no field focused (and ringed) unless one asks for it.
