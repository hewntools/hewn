# Handoff v2: Hewn design pass 2

For: Claude Code in `hewntools/hewn` (main, v0.3.3). Paths are repo paths unless they start with `design_handoff_hewn_v2/`. Do it all in one change.

Pass 1 (`design/hewn/HANDOFF.md`) is built. This is a **delta** against the code as it stands: the flows added since pass 1 (widgets, building several tools, connections, models, schedules, remote access) go through the same UX treatment, plus two dogfood fixes and a clearer model of agents, jobs and models.

## How to read the design files
- `reference/ui_kits/web/Hewn Screens v2.dc.html`: **hi-fi frames**. Open it in a browser; it uses the real `ui.css`, and Tweaks switch the theme and wallpaper. Frame ids (F1…P5) are used below.
- `reference/UX Flows.dc.html`, top section "turn 2": low-fi flows with the reasoning behind each frame. Some flows are only there: L2 agent sheet, L4 Connect, N1 General, N3 Set icon, M1 Remote access, K3 schedule proposal, G3 revised proposal, H2–H5 build variants.
- `reference/Current State Map.dc.html`: every current screen with an id (S1, H3, M5, T2…) and the issues found. "Replaces" below points to those ids.
- The `.dc.html` files are design references, not code. Rebuild them in `packages/host-workerd/web/app.js` with the `h()` helper. No framework and no `innerHTML`; the existing rules still apply.
- `drop-in/ui-additions.css`: new classes. Append it to `packages/ui/src/ui.css`.

Fidelity: high for everything in Hewn Screens v2, using `ui.css` classes and tokens. Add nothing to `app.css` beyond layout.

---

## 1. System changes (do these first, everything else builds on them)

### 1.1 Navigation
- **Nav: Home · Agents · Accounts · Settings.** Activity leaves the nav.
- **Inbox button** to the right of the nav (S1, F2):
  - Markup: `button.inbox-btn` with a 5×5 bell glyph `..#../.###./.###./#####/..#..` drawn as `svg.glyph`, plus `.inbox-count` (amber, or `.danger` if anything in it is red).
  - It opens `.inbox-panel` (F3), which has:
    - a header: `.segmented` "Needs you · N" / "Activity", and `button.link` "All activity ›" leading to `#/activity`
    - **Needs you rows** (`.inbox-row`): status `.dot`, a 36px tool icon, title and sub-line, and one action button.
    - **Building** rows: a building tile icon and its milestone label.
    - **Recent**: the last few Activity rows.
  - Esc and clicking outside close it. "i" toggles it. "a" still opens `#/activity`.
- **What goes into Needs you:**
  - pending grants
  - unresolved failed builds
  - agents waiting for approval
  - agents' destructive calls
  - schedule proposals
  - retired pinned models
  - spend at 80%, and calls refused for being over a cap
  - connections whose health is not ok
- **Remove:**
  - the builds chip (`showBuildsChip`, `buildsChip`)
  - the `has-pending` dot on the Agents tab
  - the failed-builds notice and confirmation cards above the Home grid (`failedBuilds`, `home-waiting`)
  - the 15 s schedule-proposal toast (it becomes a Needs you row)
- **One exception:** an agent's destructive call blocks that agent, so while one is pending a `.toast.blocking-banner` ("Codex is waiting for you · Review") shows on every page and opens L3.
- **API:** add `GET /api/inbox` returning `{ needs: [{ kind, id, capabilityId?, agentId?, title, detail, severity: "warn"|"danger", action }], building: […], recent: […] }`. Today's sources are `/confirmations`, `/agents/pending`, schedule proposals, `unresolvedFailures(builds)`, `/models` warnings and `/accounts` health. Poll it like the current pending checks (2.5 s while something is building, otherwise 15 s), or push it over the existing stream if there is one.

### 1.2 Four dialog patterns
Consolidate the ~20 one-off modals into four builders in `app.js`. Keep the same `<dialog class="dialog">` and widths of 440 or 520:
- **Request:** something wants something.
  - Header: 44–48px icon + "X wants to…" + `.small.faint` "Requested by …".
  - Optional `.quote`, then a `.list` of rows with a kind pill, then `.actions` (secondary, primary).
  - Used for grants (pending), approving an agent, an agent's destructive call (`danger solid` primary), a schedule proposal, and a model grant.
- **Picker:** choose one, as a list of radio rows. Used for builder, intake, a tool's model, a tier, and the icon.
- **Form:** edit values, with an optional `.sheet-steps` row of pills for multi-step forms. Used for a cap, schedules, connection settings, sign-in, adding a key, and adding a connection.
- **Confirm:** title, one line, Cancel + action. Delete forever keeps type-the-name (decided).

### 1.3 Capability references (rule from pass 1, now enforced)
**Everywhere a tool's name appears, it has its icon**: in text, chips, rows, dialog titles and Activity. Use `capRef()` (inline) or `chip()`, and grep for bare `c.name` in `app.js` output. Places that still show bare names today: Accounts "Used by" (now cap-refs), the Builds and Activity rows, the Models spend rows, the schedules card, toasts (text only is OK in toasts), and the ideas card's "Builds on …".

### 1.4 App icons
- The glyph is centred in the tile and about 56% of it at every size. On small icons (20–28px) the pixels must not touch the edge.
- **Pixels are square:** no `rx` on glyph rects below 56px (at those sizes rounding turns them into dots).
- **Widget corner icon:** 20px, 10px from the top and right edges, with `line-height: 0` on its wrapper (`.jw-mark` in additions.css; `widgets.js` places it).
- **Emoji icons are removed:** drop the emoji option from Set icon and the `icon-emoji` path. The owner has none to migrate.

### 1.5 Settings sections
`#/settings/<section>`, laid out with `.settings-layout` (a left `.side-list`) (N1, O1, J1, N2, N5):
- **General:** Appearance, **Time zone** (new: taken from the browser, editable; the default for new schedules), Sandbox.
- **AI:** the three jobs (1.6), with Models as a sub-page `#/settings/ai/models`.
- **Remote access:** public address (status + "Set up…", which opens a Form with the DNS records and the Caddy block), Passkeys, Signed-in browsers.
- **Data:**
  - Backups and the backup folder.
  - **A `.notice` when the backup folder is on the same disk as the data**. The server compares the device ids of the two paths and returns `sameDisk` in `/backups`.
  - Keep call logs, and Deleted tools.
- **About:** version, data format and ABI; "up to date" or "0.3.4 is out" with a `.command-block` `hewn upgrade` + Copy; shortcuts; docs; licence. This needs `GET /api/status` to include `latest` (cached from the releases feed `hewn upgrade` already uses; null when offline).
- `#/models` and `#/builds` redirect to their new homes.

### 1.6 Agents, jobs and models (new mental model, O1–O8)
There are two directions:
- **Agents use your tools** (inbound MCP): the Agents page.
- **Hewn uses AI for three jobs:** Settings › AI.

| Job (owner-facing) | Internal | Runs on | Paid by |
|---|---|---|---|
| Writes the spec | intake | an agent CLI on this Mac | your subscription |
| Builds tools | builder | an agent CLI on this Mac | your subscription |
| Thinks inside tools | model port | provider API | your API key, metered |

- **O1 Settings › AI:** three `.setting` rows. Each shows its job, a 20px tile + what runs it + "your subscription" or "your key · $x of $y this month", and Change / Models ›. Build attempts moves here, onto the builder row. Footer: "Agents that use your tools are on Agents."
- **O2 Picker for a job:** signed-in agents on this Mac; the subtitle shows the other jobs it already does; "One agent can do every job."
- **O3 / L1 Agents rows:** one identity per program, with `.role-chips`: "uses your tools" (accent), "builds tools", "writes the spec". The job chips link to Settings › AI. The Builder · Intake card (`whoBuildsSheet`, `buildJobsPanel` on this page) **moves to Settings › AI**.
- **O5 "Add…"** (the primary button on Agents and on Settings › AI) is a sheet with three rows:
  1. An agent that uses your tools: the existing `connectDialog`.
  2. An agent that works for Hewn (O7): `GET /setup/agents` shows installed, signed-in and coming-soon agents, with "How" (the sign-in command) or "Use" (opens the O2 picker), and "Look again".
  3. A model provider (O8): the providers list.
- **O6:** after an agent on this Mac connects, `connectDialog` ends with "It can also work for Hewn". Build tools / Write the spec are switches, unticked, showing who does each job today. Cloud agents skip this step.
- **O4 / J2 Model as a grant:** `grantsSheet` gets a `model` row (accent pill) with a **tier select** (it defaults to the tier the tool asked for; the sub-line reads "Asked for Standard · about $0.002 a call"). With no provider set up, the sheet shows an inline block: the line "Tools call a model directly with an API key, not through an agent, so your Claude subscription can't pay for this.", a provider select and a key field. Authorize stays disabled until the key checks out. **This replaces `modelSetupDialog`.** The chosen tier is saved the way `modelChoice` saves today (a manifest-only version).
- **J1 Models page:**
  - **This month** at the top: the big figure, a 40-cell `.blocks` meter, Change cap.
  - Providers as rows: in use (pill) / key saved (Use) / no key (Add key → Form).
  - Tiers as rows (tier · model · price · used by N · Change).
  - Pinned models appear only when there are any.
  - Caps per tool move to J3.
- **J3 A tool's model** (from Info › Model): one Picker that combines `modelChoice` and `capDialog`.

---

## 2. Screens

### F. Home and widgets (replaces H1–H6)
- **F1 First run:** one moment screen (ASCII H) that replaces both `firstRun()` and `emptyHome()`.
  - Headline "Make your own tools." (`.display` 44px), sub "Every agent you connect can use them."
  - Then three cards:
    1. Agents on this Mac (Connect / connected pill).
    2. **Who works for Hewn:** Builds tools / Writes the spec, each with Choose… opening the O2 picker. **Not chosen automatically** (decided).
    3. Make something: a composer plus three starter `.chip.plain` (no emoji), disabled until a builder is chosen.
  - No lead paragraph and no Skip. If you leave without building, the same screen shows next time until a tool exists.
- **F2 Home:**
  - Nothing above the grid.
  - The "New" tile goes straight to `#/new`; the intake handles widget and schedule requests too. Widgets get added through Edit Home.
  - Search stays as it is.
- **F4 Edit Home** (new):
  - Open it by right-clicking empty grid space ("Edit Home"), pressing "e", or from the tile menu.
  - Add `.home-grid.editing`: tiles wiggle (±0.6°, 0.34 s; a dashed outline instead with reduced motion), `.edit-x` removes a widget or hides a tool from Home (tools stay in the Inbox and search), and `.size-tag` on a widget cycles through the sizes it offers.
  - Top bar: `+ Add widget` (glass, left), hint text "Drag to move · tap S/M/L to resize" (centre), `Done` (primary, right).
  - Drag-to-reorder works as today; Esc or Done saves.
  - **Remove** the size items from the widget's context menu.
- **F5 Add a widget:** a Form sheet that only adds to Home.
  - CapRef chips filter by tool (with "All" first).
  - A live preview on a `--surface-2` stage, and the name + "Tool · description".
  - A size `.segmented`, then "Describe a new one ›" (opens the intake for that tool with `?widget=new`), Cancel, Add to Home.
  - **Deleting a widget from a tool moves** to Info › Widgets (N4).
  - `widgetsDialog` is split between this sheet and the Info row.
- **F6 Widget states:** stale shows `.jw-stale-note` ("2 h ago" with an amber dot) instead of the "!" badge. A button press disables that button until the widget redraws.
- **F7 Tile menu, grouped:**
  - Open · Change… · Info
  - ─ Widgets… · Activity · Versions…
  - ─ Rename · Set icon… · Export data
  - ─ Delete…

  "Builds" and "Failed build…" go: Activity filtered to the tool covers both, and the Inbox covers failures.

### P. Change while you use it (dogfood fix 3, replaces C2)
- **Every Change… opens the drawer:** the app bar, the tile menu, Info's composer (it opens the tool and sends the text), and a widget's Change….
  - Route: `#/app/:id?change=1` (tool UI) or `#/run/:id?change=1` (no UI, P5).
  - `#/change/:id` redirects there.
  - `#/widgets/:id` becomes `#/app/:id?change=1&widget=…`.
- **The drawer** (`.with-drawer > .drawer-main + .drawer`, 400px; a bottom sheet on narrow screens) holds `intakePage("modify")` as a component:
  - `.drawer-head`: eyebrow "Change" + a CapRef of the tool + ×.
  - `.drawer-body`: the thread, the proposal card (G1, compact) and the composer.
  - The opened tool's own iframe stays live on the left; its bar shows Change… as `aria-pressed`.
- **P3:** once Build change starts, the drawer shows the build: steps with real milestones + the log (H6). The tool keeps running the current version.
- **P4:** when the new version is live, a `.notice.ok` "vN is ready. Reload to see it." with Reload (reloads the iframe, keeping `?at=`) and Undo (roll back, like Versions).
- Closing the drawer while a build runs is fine: the tile and the Inbox take over.
- **P5 (no UI):** the Run view's operations, form and result on the left, the drawer on the right. The drawer footer has `button.link` "Give it a proper screen", which prefills the composer.
- Connections behave the same way (their Operations + the drawer).

### G. Asking for tools (replaces M1–M4)
- **G1 One proposal card** for every intake reply that proposes something: `draft`, `ideas`, `widgets`, and schedule-only.
  - Header: eyebrow "Proposal · N tools" (or "· change", "· widgets", "· schedule").
  - Then a `.list`, one row per item: a tick box (hidden when there's a single item), a 40px icon, name, purpose, and summary pills (operations count, `builds on …` warn, `1 schedule` accent, model tier, `needs a new connection` warn).
  - Footer: Keep talking + primary "Build N tools" or "Build change".
- **G2:** a row expands (▸/▾) to show details on a `--surface-2` block:
  - builds on, as a CapRef
  - needs: hosts, secrets, connection
  - schedule ticks and widget ticks
  - the model tier
  - "Show spec"

  The dependency ticking rules from `ideasCard` stay as they are.
- **G3:** when a proposal is revised, the earlier one collapses to one line ("Earlier proposal · 3 tools · replaced ▸") instead of staying full-size and faded.
- Merge `specCard`, `ideasCard`, `widgetProposalsCard` and `scheduleSuggestionsCard` into one `proposalCard(kind, items)`.

### H. Builds (replaces M5–M6)
- **H1 Builds live in Activity:** `#/activity?view=builds`, with `.segmented` All · Builds · Calls · Access. In progress, Failed and Earlier sections; rows have a 36px icon, "Name · kind", a sub-line and a pill.
- **No progress bars anywhere** (decided: they were fake). Remove the `.spend-bar` from build rows and the `blocks` progress from the build page. Show `.milestones` pills only: `spec ✓` `code ✓` `tests 4/6` (accent, with a dot) `you`. "Waiting" builds show `waiting` (warn) + "Waiting for <CapRef>".
- **Build page:**
  - **H6 (dogfood fix 4): the log stays after the build finishes.** It is collapsed under "Show log" when the build succeeds, and **expanded by default when it fails**, under the reason and its actions. Activity's "Show" on a finished build opens the page with the log available.
  - H2: waiting.
  - H3: widgets only, each widget shown at every size + Add to Home.
  - H4: quick change (manifest-only, no builder): "Model changed to the strong tier. No builder needed.", no steps.
  - H5: a new connection ends with "Sign in to finish setting it up" + Sign in (I4), not Open.

### I. Connections (replaces C1–C3)
- **I1 Accounts:** h1 + "Add a connection" button. One `.list` card with a row per connection:
  - 40px icon (a building connection fills in pixel by pixel), name, health dot + word, "used by" CapRefs (or "nothing yet").
  - A primary button only when it needs you (Sign in / Set up). The row opens the connection's page.
  - **Remove** the intro sentence, the inline settings fields and the per-card Operations and Change… buttons.
- **I2 Connection page** (`#/c/:id` for kind `connection`):
  - Header: 64px icon, name, health line.
  - Two columns: **Operations** on the left (rows → Run view, plus a `health` row showing its last result), and on the right **Used by** (CapRef chips) and **Settings**.
  - The Settings card holds: sign-in (Sign in again), config fields as one form, and one Save.
  - Bar: ‹ Accounts · Change… · •••.
- **I3 Add a connection:** a Form sheet that names the service (suggestion chips) and goes to the intake in connection mode: `#/new?connection=<service>`.
- **I4 Sign-in:** `signInDialog` becomes a stepped Form sheet: `.sheet-steps` pills ("1 · Account ✓", "2 · Code"), one step per screen, then Back / primary. It ends with a check mark and the health line.

### K. Schedules (replaces T3)
- Info › Schedules opens a **schedules sheet** (K1 + K2): rows with a switch + "Daily 07:00 · next in 3 h". Paused rows say "Paused after 3 failures" in danger and have a Resume button. Below the rows is a "New schedule" block: operation select, a cadence `.segmented` (Hourly / Daily / Weekly / Custom), a time, and "Europe/Stockholm · your time zone".
- **K3:** an agent's proposal becomes a Needs you row that opens a Request sheet ("Claude Code wants to run sync_runs daily at 07:00", the note as a quote, the tool row, Decline / Enable).

### L. Agents (replaces T4–T5)
- **L1:** compact rows: tile, status dot, name, "where from · scopes in words · last used", and role chips. The row opens the **L2 agent sheet**: scope switches that save instantly with Undo, a tool picker (CapRefs) for "only some tools", and Disconnect (Confirm). It replaces the inline Edit.
- "Waiting for you" (`pendingCard`) moves to the Inbox and opens as a Request sheet. The Builder · Intake card moves to Settings › AI.
- **L3:** a destructive call is a Request sheet: "Codex wants to delete 3 runs", a "waiting · 0:42" timer, a `destructive` pill with the operation on a CapRef and its ids in `.sub.mono`, the quote, then Stop / `danger solid` "Allow once".
- **L4 Connect:** keep the list. Each "How" branch becomes one screen with a copyable address, at most 3 short steps and a `.command-block` (Copy) for anything to paste. Use terminal commands only where nothing else works.

### M. Remote access and phone (replaces Se2–Se4)
- **M2 Public sign-in page** (the public listener's sign-in, outside `app.js`). A moment screen at phone width: ASCII H, the Hewn lock-up, `primary lg` "Sign in with a passkey" (full width), and `.small.faint` "New device? On the server run `hewn open --print` and scan the code."
- **M3** (`#/passkey`): "Add this iPhone" (default name from `deviceName`), "Next time it signs in with Face ID.", a Name field, Add passkey, Not now. Afterwards it goes to Home.
- **M4 Home under 640px:**
  - a 4-column grid of 60px icons; widgets span all 4 columns
  - the nav collapses into a ☰ glass button, while the Inbox stays visible
  - tool UIs open full screen; the drawer becomes a bottom sheet

  Other pages only need to work on a phone; they aren't designed for it (decided).

### N. Info and owner chores
- **N4 Info:**
  - Header (Open is a regular `lg` button), the pills, and the Change it composer (it opens P1).
  - Then **one `.list` card of rows**, each opening its sheet or page:
    - Operations → Run view
    - Allowed to (amber dot if pending) → grants sheet
    - Model → J3
    - Schedules → K sheet
    - **Widgets** → widgets for this tool, including delete
    - **Versions** → versions sheet
  - This replaces the 4-card right-hand column. Connected tools move to the end of the purpose line, or a row.
- **N3 Set icon:** a Picker with Draw (5×5 `.glyph-editor`) / Image, a hue slider, and Use default. There is no emoji option.

---

## 3. Data and API (summary)
- `GET /api/inbox` (1.1).
- `GET /api/status` → `latest` (1.5).
- `/backups` → `sameDisk` (1.5).
- Owner `timeZone` in settings, used as the default for new schedules.
- Grants: a model item with `tier` and an optional inline key (1.6).
- `PUT /settings` takes `builder` / `intake` as before; the UI moves.
- Builds: no `progress` fraction is needed in the UI any more; keep `step` and `tests`.
- Redirects: `#/models`, `#/builds`, `#/change/:id`, `#/widgets/:id`.

## 4. Copy rules (unchanged, now enforced)
- No intro sentences on pages (Accounts, Models, Widgets, Connect, Welcome).
- Owner-facing words:
  - "tool" (never "capability")
  - "connection", and "Accounts" for the page
  - "Writes the spec" / "Builds tools" / "Thinks inside tools"
- Sentence case, verbs on buttons, no emoji, no exclamation marks.

## 5. Update `design/hewn/DESIGN-SYSTEM.md`
Add a "Pass 2" section covering:
- the Inbox (and the one banner exception)
- the four dialog patterns
- cap-refs everywhere, and icon proportions (glyph about 56%, square pixels under 56px, the widget corner icon)
- Edit Home
- the drawer
- Settings sections
- the agents / jobs / models table
- "no progress bars, milestones only"
- emoji icons removed
- the new classes from `ui-additions.css`

## Done when
- [ ] Nav is four tabs plus the Inbox; no builds chip, no Agents dot, nothing above the Home grid; only a destructive call shows a banner.
- [ ] Every proposal is one `proposalCard`; earlier proposals collapse.
- [ ] Every Change… opens the drawer next to the live tool (or the Run view); building, Reload and Undo happen in the drawer; `#/change` redirects.
- [ ] Build logs stay after a build finishes, and open by default on failure; no progress bars anywhere.
- [ ] Edit Home works (wiggle, ×, S/M/L, Add widget); the widget menu has no size items.
- [ ] Accounts rows and the connection page match I1 and I2; a connection can be added from Accounts.
- [ ] Settings has five sections; About shows the version and upgrade; Data warns when backups share a disk; General has the time zone.
- [ ] Settings › AI shows the three jobs; agents show role chips; Add… has three choices; a model grant has a tier select and an inline key.
- [ ] Every tool name in the UI has its icon; small icons have square pixels and padding.
- [ ] No emoji anywhere (starters, icons).
- [ ] Phone: public sign-in, add passkey and Home work at 390px.
