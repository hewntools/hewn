# Handoff: Hewn redesign ("Signal" design system + UX pass)

For: Claude Code, working in `hewntools/hewn` (main). Every path below is relative to the repo root unless it starts with `design_handoff_hewn/`.

## Overview
Hewn had no design work before this pass. This bundle covers three things:

1. **A new shared design system ("Signal").** This is the one stylesheet served at `/_platform/ui.css` to the web client *and* to every capability UI. It's ready to drop in.
2. **A redesign of the web client** (`packages/host-workerd/web/public/`), plus a **UX pass** that changes how several flows behave, not just how they look.
3. **A working rename to "Hewn".** Change it in the UI only. Leave the CLI binary, package name, MCP server id, env vars and origins (`hewn.localhost`) alone in this pass, and keep every user-visible string easy to change, because the name isn't final.

## About the design files
- `design_handoff_hewn/drop-in/` contains production files. Copy them into the repo as described in Phase 1.
- `design_handoff_hewn/reference/` contains **design references made in HTML**: hi-fi mockups showing the intended look and behaviour. They are *not* code to ship. Open `reference/ui_kits/web/Hewn Screens.dc.html` in a browser; it uses the real `ui.css`. Recreate these screens in the existing web client: plain DOM via the `h()` helper, no framework, no `innerHTML` (keep that rule).
- `reference/UX Flows.dc.html` is the low-fi flow board. Frame ids (A1…E3) match the hi-fi frames and this README.
- `DESIGN-SYSTEM.md` holds the rules: content tone, colour, type, glass, iconography, patterns. Read it before writing any UI.

## Fidelity
**High fidelity** for everything in `Hewn Screens.dc.html`. Use the `ui.css` classes and tokens exactly. Don't add colours, fonts or one-off CSS values that aren't tokens. If something truly isn't covered, add a class to `ui.css`, not to `app.css`, and record it in DESIGN-SYSTEM.md.

---

## Phase 1: Drop in the design system (small, do first)
1. Replace `packages/ui/src/ui.css` with `drop-in/ui.css`.
2. Replace `packages/ui/src/chart.js` with `drop-in/chart.js`. It keeps the `barChart` API unchanged, adds `lineChart(el, { labels, series, unit, height })`, and slims the bars.
3. Add `drop-in/ascii.js` as `packages/ui/src/ascii.js` and register it in `PLATFORM_ASSETS` in `packages/cli/src/ui.ts` (`"ascii.js": "text/javascript; charset=utf-8"`). It exposes `window.hewnAscii(preEl, { cols, rows, speed }) → stop()`.
4. Add `drop-in/logo/hewn-mark.svg` and `hewn-glyph.svg` to `packages/host-workerd/web/public/` and use `hewn-mark.svg` as the favicon.
5. Check for regressions:
   - Every v1 class still exists. The full v1 → v2 mapping is in DESIGN-SYSTEM.md.
   - **Breaking-ish:** `--accent` is now lime and only meant for *fills*. Anywhere text is coloured with `var(--accent)` must switch to `var(--accent-ink)`. Grep `src/` and the example capabilities for `color: var(--accent)`.
   - `.pill.write` and `.pill.destructive` in app.css: replace them with `.pill.accent` and `.pill.danger`.

## Phase 2: Restyle the web client (`packages/host-workerd/web/public/`)
**app.css** shrinks to page layout only. Delete the rules that `ui.css` now owns: `.menu*`, `.dialog`, `.thread`, `.msg*` (use `.bubble.me` / `.bubble.them`), `pre.logs` (use `.log`), `.icon*` and `.badge` (use `.app-icon`), `.auth-*` (use `.list`), `.card` overrides, `.hint`, `.history` (gone, see Phase 3).

**index.html.** Remove the old `.bar`. Every page gets this top bar instead:
- **Left:** the brand lock-up, `<span class="app-icon brand" style="--size:28px">` + Hewn glyph SVG, then "Hewn" at 17px / 650 / −0.02em.
- **Right:** `<nav class="glass-bar">` holding Home, Activity, Agents, Settings. The current page gets `aria-current="page"`.
- **Padding:** 20px 32px.

Moment screens (intake, build, first run) replace the nav with a single `.glass-bar` back button, "‹ Home".

**Wallpaper.** Every full page sits on `<div class="wallpaper">` with 2–4 `<i style="--h:<hue>;--x:..;--y:..;--w:..">` children.
- Hues come from the owner's capabilities: the first 4 hues on Home.
- Use `.wallpaper.dim` everywhere except Home.
- Respect a future "wallpaper off" setting via `[data-wallpaper="off"]` on `<html>`.

**App icons: replace `icon()`.** Markup is `<span class="app-icon" style="--hue:N">…</span>`. Sizes are set with `--size` (Home 80px, Info 72px, inline 20–28px). Pick what goes inside the tile in this order:
1. Owner-uploaded image: `<img>` filling the tile (`object-fit:cover; border-radius:inherit; width:100%; height:100%`).
2. `ui/icon.svg` from the capability: render as a **CSS mask**, not `<img>`, so it takes the tile's glyph colour: `<span style="width:52%;height:52%;background:currentColor;mask:url(/api/capabilities/:id/icon) center/contain no-repeat">`.
3. Emoji: centred in the tile, font-size `calc(var(--size)*.45)`.
4. Monogram: the 2-letter fallback that `.app-icon` already styles.

`--hue` comes from the manifest's new optional `hue` field (0–359, see Phase 4) and falls back to the current id hash. Badges are `<span class="badge">` (amber, needs you) or `<span class="badge danger">` (failed build).

## Phase 3: UX pass (frontend; mostly uses existing APIs)
Routes stay hash-based. New routes are marked **new**.

### A. Home and opening things
- **A1 First run** (`#/`, when there are 0 capabilities).
  - Copy: "Nothing here yet." in `.display` at 56px, then "Describe something, or connect an agent." in `.muted` at 18px.
  - Buttons: `primary lg` "Make something" → `#/new`, and `lg` "Connect an agent" → E1. Under them, `mono faint` "or run  hewn setup".
  - ASCII H on the right: `<div class="ascii-field"><pre>` with `hewnAscii(pre, {cols:64, rows:40})`.
- **A2 Home** (`#/`).
  - A 6-column grid of 124px cells, 36px row gap, centred vertically. The last tile is the dashed `.app-icon.add` "New".
  - **Remove** the notice strip and the "Long-press or right-click" hint.
  - Badges: amber when `!ready` or `requests > 0`; red when the latest build failed.
  - **Building state:** see "Building tiles" below.
- **A3 Actions.** On hover, a `.more` "•••" chip (`.app-icon .more`) appears on the tile; right-click and long-press work as today.
  - Menu items: Open, Info, Change…, Activity, Rename, (Set icon…), ─, Delete…. "Modify…" is renamed "Change…".
  - **Rename** is inline: the label becomes an `<input>`. Enter saves, Esc cancels. **No `prompt()`.**
  - **Delete** is a `<dialog class="dialog">` (C4). **No typed confirmation.**
  - **Activity** goes to `#/activity?capability=<id>`.
- **Tapping a tile always opens the capability.**
  - It has a UI → A4 (`#/app/:id`).
  - It has no UI → **A5 Run view** (`#/run/:id`, **new**).
  - It's building → B3 (`#/b/:buildId`).
  - It needs access → open the D1 sheet over Home.
- **A4 Opened (UI).** The app bar stays 48px, with "‹ Home" (ghost sm), the centred 24px icon + name, then `sm` "Change…" and a ghost "•••" on the right. The ⓘ and ↗ buttons move into "•••" (Info, Open in new tab, Activity, Rename, Delete).
- **A5 Run view (new).** Same bar as A4.
  - Body: two columns, max-width 1040px, 32px padding.
  - **Left (240px):** operation list. Each row is `mono` name + side-effect pill; the selected row uses `--surface-3`. At the bottom sits a quiet `.small.faint` "Just forms for now." with `button.link` "Get a custom screen for it ›" under it. The link opens C2 with the message prefilled: "Give it a proper screen".
  - **Right:** a `.card` with the operation description, the fields generated by the existing `field()`, and a `primary` "Run" button. Under it, a result `.card` with "Result" eyebrow + `pill ok with-dot` "ok · 212ms" and the existing `renderResult()`.
  - Destructive operations show a `<dialog>`, not `confirm()`.
  - This moves `operationCard` out of the capability page.

### B. Making a capability
- **B1 Intake** (`#/new`).
  - Moment screen: wallpaper.dim + ASCII field. The content is a 640px column anchored to the bottom.
  - Eyebrow "New capability", `.display` "What should it do?", then a `.card` (24px radius) holding the `.thread` and a composer (input + `lg` Send).
  - Show `.bubble.them.typing` "•••" while waiting.
- **B2 Spec card.** This replaces the editable draft fields. When intake returns `draft`, render a `.card` (24px radius) with:
  - eyebrow "Will build"
  - 52px icon + name (22px / 650) + one-line purpose
  - operation names as pills (`.pill.accent` for write)
  - "Needs nothing outside itself", or a list of what it needs, each capability shown as a `.cap-ref`
  - buttons "Keep talking" and `primary lg` "Build it"

  To change the spec, the user keeps chatting. The draft object is still what gets POSTed.
- **B3 Building** (`#/b/:id`). Centred 580px `.card`:
  - 56px icon, name, "Building with <builder> · you can leave", and the % in mono
  - a `.blocks` progress bar (48 cells: `i.on` done, `i.live` current)
  - `.steps`, in order: Spec agreed → Writing code → Running tests (meta "4 / 6") → Your authorization
  - `button.link` "Show log", which expands a `.log` panel (collapsed by default)

  "Cancel build" sits top-right if the API supports it; otherwise omit it. See Phase 4 for the progress data.
- **B4a Ready.** All blocks on, 64px icon, "<Name> is ready", "Added to Home · 6 of 6 tests passed", `primary lg` "Open". If authorization is needed, open the D1 sheet first; Authorize then continues to Open.
- **B4b Failed.**
  - Blocks get `.blocks.fail`. The icon carries a danger badge.
  - Headline is a plain-language reason (e.g. "2 of 6 tests didn't pass"), with "<Name> · attempt 3 of 3" under it.
  - A `.notice.danger` holds a one-sentence cause.
  - Actions: `primary` "Ask builder to fix" (the existing retry endpoint with the failure as context; Phase 4), "Retry", `button.link` "Show log".

### C. Managing a capability
- **C1 Info** (`#/c/:id`). Width 880px.
  - **Header:** 72px icon, name (32px / 650), and the one-line purpose (capability names in it shown as `.cap-ref`), with an `lg` "Open" button (default style, *not* primary).
  - **Pills:** `ready` (`ok with-dot`), `vN`, `built by X`, relative age.
  - **"Change it" composer:** this is the most prominent element. It's a `.card` (20px radius, `border-color: var(--accent-soft)`, plus a 4px `--accent-soft` ring) containing eyebrow "Change it" in `--accent-ink`, a borderless 16px input (placeholder is a contextual example), and `primary lg` "Ask". Submitting goes to C2 with the message already sent.
  - **Grid** (1.4fr / 1fr):
    - Operations `.list`: rows are `li.link`; clicking one opens A5 with that operation selected.
    - "Allowed to" `.list`: rows are `li.link`, each capability shown as a `.cap-ref`; clicking opens D2.
    - "Connected": `.chip`s for uses and used-by.
  - **Remove** from this page: History, Logs, the description paragraph, "Change it" as a section, and the inline authorization card.
- **C2 Change** (`#/change/:id`). Same as B1, plus a `.chip` at the top ("<icon> <Name> · vN") and the headline "What should change?". The back button reads "‹ <Name>".
- **C3 Activity** (`#/activity`). Width 760px.
  - Filter chips at the top: a capability chip with ×, and "All agents ▾". Filters live in the hash query.
  - One `.card` with day groups ("Today", "Yesterday", then dates), each an eyebrow + `.list`.
  - Row: status `.dot`, text, agent `.pill`, time in mono.
  - Group consecutive calls by the same agent to the same capability into one row ("Codex made 14 calls"); expanding it shows them.
  - The timeline merges builds, calls and grant changes. **This replaces History and Logs on Info.**
- **C4 Delete.**
  - `<dialog class="dialog">` (420px) titled "Delete <Name>?".
  - Body: "<cap-ref> uses it and will stop working. Its data is kept, so you can restore it later." If it has no dependents, use "Its data is kept, so you can restore it later."
  - Buttons: Cancel, `danger solid` "Delete".

### D. Trust
- **D1 Grants sheet, pending.** **One shared component**, `grantsSheet(capId)`, opened from the Home badge, B4a, and Info "Allowed to".
  - Layout: `<dialog class="dialog">` (480px). Header is the 48px icon + "<Name> wants to" + `.small.faint` "Requested by <agent>".
  - Optional request note: a `--surface-2` box containing the quoted note.
  - The rows are a `.list`. Each row has a kind pill (`accent` "write" / "read" / "host" / "secret"). Capability rows read "Add runs to <cap-ref>", with the operation name in `.sub.mono`. Secret rows contain a password input.
  - Footer: `.small.faint` "Secrets go to your Keychain only." and the buttons "Not now" and `primary` "Authorize".
  - **Authorize is disabled until every required secret is filled in.**
- **D2 Grants sheet, approved.** Title "<Name> is allowed to". Rows end with `button.link.sm` "Revoke" ("Replace" for secrets). Revoking applies immediately and shows a `.toast` with "Undo" for 6s; Undo re-approves. **No `confirm()`.** Button: "Done".
- **D3 Agents** (`#/agents`). Width 680px.
  - Header: `h1` "Agents" + `primary` "Connect an agent".
  - One `.card` per agent: status `.dot` (live if it called something in the last 5 minutes), name, "Last used …", and ghost `danger sm` "Disconnect".
  - Below that, 4 `.setting` rows, each with an `input.switch`:
    - discover → "See your capabilities"
    - invoke → "Use them"
    - create → "Make new ones"
    - modify → "Change existing ones"
  - **Each toggle saves immediately** (PUT the full scope list) and shows a toast, e.g. "Claude Code can no longer change capabilities · Undo".
  - Collapsed agents show a one-line summary.
  - Disconnect uses a dialog.

### Building tiles (Home)
A capability with a build in progress is **not openable**:
- **Tile:** add `.app-icon.building`, which desaturates and fades it.
- **Glyph:** lights up pixel by pixel. With N lit cells in the glyph, the first `round(N × progress)` cells (in reading order) use `currentColor` and the rest use `color-mix(in oklch, currentColor 22%, transparent)`. For mask or emoji icons, fade the whole glyph to `opacity:.35` and show nothing else.
- **Label:** reads "Building… 62%" in `--text-2`.
- **Tap:** opens B3.

The reference implementation is in `reference/ui_kits/web/AppIcon.dc.html` (`progress` prop).

### Global rules
- **No `alert()`, `confirm()` or `prompt()` anywhere.** Use dialogs, inline edits and toasts (`.toast` inside a fixed `.toast-region`).
- **Capability references always render as icon + name:** `<span class="cap-ref"><span class="app-icon">…</span>Name</span>`.
- **Copy is short.** Sentence case, verbs on buttons, no exclamation marks, no explanatory paragraphs.
- **Loading** uses `.skeleton` blocks, not "Loading…" text. **Empty states** use `.empty`.
- **Focus and keyboard:** dialogs trap focus and Esc closes; menus get arrow-key navigation.

## Phase 4: Backend work
1. **Build progress for Home and B3.**
   - Home needs `GET /api/capabilities` to include `building: { buildId, progress (0–1), step }` when a build is in flight.
   - B3 needs the SSE stream to emit `step` events: `spec | code | tests {passed,total} | auth | done`.
   - Progress can be derived from steps (spec 0.1, code 0.5, tests 0.5→0.9 scaled by passed/total, auth 0.95).
2. **Failed-build reason.** Have the builder or validator produce `failure: { title, detail }` in plain language (e.g. title "2 of 6 tests didn't pass"; detail is a one-sentence cause). Add `POST /api/builds/:id/fix`, a retry that includes the failure log and detail as context for the builder.
3. **Activity timeline.** `GET /api/activity?capability=&agent=&before=` returns one merged, time-sorted list of `{ kind: build|call|grant, at, capabilityId, actor, outcome, … }`, paginated.
4. **Connect an agent (E1–E2).**
   - `GET /api/setup/agents` returns the detected harnesses: `[{ agentId, label, found, connected }]`, via `harnesses().detect()`.
   - `POST /api/setup/agents/:id` runs that harness's `steps()` with SSE progress per step (each step's `describe`, already redacted), then runs `verifyAgent`.
   - `GET /api/setup/manual` returns the MCP URL plus a masked token, with a reveal-and-copy action.
   - All of these are owner-only.
   - Today the code says connecting stays CLI-only; this is a deliberate change.
5. **Settings (E3).**
   - `GET` and `PUT /api/settings` wrapping `readConfig` and a new `writeConfig`.
   - Owner-only; agents still get no API.
   - **Remove the `discovery` option** from `PlatformConfig` and the UI. Hard-code the generic behaviour (product decision).
   - Fields exposed: `builder` (codex | claude | agent), `intake` (claude | codex), `maxBuildAttempts` (1–5 stepper), `sandbox` (switch; turning it off needs a confirmation dialog and shows a persistent `.notice.danger` on every page while off).
   - Appearance (System / Dark / Light) is client-only: set `data-theme` on `<html>`, stored in localStorage.
6. **Manifest `hue`.** Add an optional `hue: integer 0–359` to the manifest schema (`packages/cli/src/manifest.ts`) and pass it through `GET /api/capabilities`.

## Phase 5: Builder brief (`spec/builder-brief.md`)
Update the "UI (optional)" section so generated capabilities match:
- **Icon (new, required):** ship `ui/icon.svg` as a 5×5 pixel glyph. Rules:
  - `viewBox="0 0 5 5"`, whole-unit `<rect>`s only
  - `fill="currentColor"`, `shape-rendering="crispEdges"`
  - 7–17 lit cells, one simple idea, no colours in the file
  - set `"hue"` (0–359) in capability.json

  Show 2 examples from `reference/assets/glyphs/`.
- Components to add to the class list: `.eyebrow`, `.notice.info`, `.pill.with-dot`, `.empty`, `.skeleton`, `.list`, `.chip`, `input.switch`, `.stepper`, `.toast`, `lineChart`.
- Replace "Use the CSS variables (`var(--accent)` …)" with: "`--accent` is a fill colour (buttons, highlights). For accent-coloured text use `--accent-ink`."
- Add: "Keep copy minimal: labels, not sentences. No emoji."
- Add the light-mode check: "Every UI must work under `prefers-color-scheme: light` and dark; never hard-code colours."

## Phase 6: Settings and Connect screens (after Phase 4)
- **E1 Connect.** `<dialog>` (480px) with a `.list` of harnesses:
  - 44px monogram tile, name, "Found on this Mac"
  - action: `pill ok` "connected", `primary sm` "Connect", or for "Another MCP client" `sm` "Manual setup"
- **E2 Connecting.** The same dialog with a 24-cell `.blocks` bar and `.steps` built from the SSE step descriptions in plain words: "Saved token to ~/.zshrc", "Added Hewn to Codex", "Telling Codex where to look", "Test call". On success it shows the D3 toggles for that agent.
- **E3 Settings** (`#/settings`, **new**). Width 680px.
  - `h1` "Settings", then a `.card` of `.setting` rows:
    - "Who builds": select
    - "Who writes the spec": select
    - "Build attempts": `.stepper`
    - "Sandbox": `input.switch`
  - A second `.card` with "Appearance": `.segmented` System / Dark / Light.

## Design tokens (all in `ui.css`; summary)
- **Dark (default):**
  - `--bg` oklch(0.17 0.012 260); surface white at 7% (glass); `--surface-solid` oklch(0.22 0.014 260)
  - text oklch(0.95 / 0.74 / 0.62)
  - `--accent` oklch(0.86 0.17 125) (lime) on `--accent-text` oklch(0.2 0.03 125)
  - ok / warn / danger / info at L≈0.8 / 0.84 / 0.72 / 0.8
- **Light:**
  - `--bg` oklch(0.975 0.004 260); surface white at 50%
  - `--accent-ink` oklch(0.5 0.13 132)
- **Type:** system sans (450 / 550 / 650) + `ui-monospace`. Scale 11 / 12 / 13 / 15 / 18 / 24 / 32 / 44. Tracking −0.02em at 24px and up; caps labels +0.06em in mono.
- **Space:** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.
- **Radii:**
  - xs 2 (pixels)
  - sm 8 (controls)
  - 12
  - lg 18 (cards)
  - xl 24 (dialogs)
  - app icons 28% of size
- **Glass:** `blur(24px) saturate(1.5)`, or `blur(40px) saturate(1.8)` for overlays, plus a 1px top highlight `--hl`.
- **Motion:** 160ms `cubic-bezier(.2,.7,.2,1)`. Live things pulse in opacity at 1.6s. Everything respects `prefers-reduced-motion`.

## Assets
- `drop-in/logo/hewn-mark.svg` (lime tile + dark H) and `hewn-glyph.svg` (currentColor).
- `reference/assets/glyphs/*.svg`: example capability glyphs (the 5×5 format).
- No external fonts, CDNs or images. All imagery is CSS, pixels or ASCII.

## Files
- `drop-in/ui.css`, `drop-in/chart.js`, `drop-in/ascii.js`, `drop-in/logo/*`: copy these into the repo.
- `DESIGN-SYSTEM.md`: the full rules and the v1 → v2 class mapping.
- `reference/ui_kits/web/Hewn Screens.dc.html`: all hi-fi frames (A1–E3), with theme and wallpaper tweaks.
- `reference/ui_kits/web/AppIcon.dc.html`, `TopBar.dc.html`, `HomeGrid.dc.html`: reference logic for icons, the building fill and the menu.
- `reference/UX Flows.dc.html`: the flow board with rationale notes.
- `reference/guidelines/*.card.html`, `reference/components/*/*.card.html`: specimens for each token and component.

## Done when
- [ ] No `alert`, `confirm` or `prompt` left in `packages/host-workerd/web/app.js`.
- [ ] Every screen matches its hi-fi frame in both themes; any capability UI using v1 classes still renders correctly.
- [ ] Home: tap opens; ••• menu; inline rename; delete dialog; badges; building tiles.
- [ ] The Run view exists; Info has no operation forms, history or logs; the Change composer is the most prominent element on Info.
- [ ] One grants sheet is used from all three entry points; revoking shows Undo.
- [ ] Activity is a single filterable timeline.
- [ ] Agents toggles save instantly with Undo.
- [ ] The builder brief is updated; a new capability built after the change ships a 5×5 `icon.svg` and a `hue`.
- [ ] The UI says "Hewn"; the CLI, ids and origins are unchanged.
