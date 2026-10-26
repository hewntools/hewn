# Hewn design handoff v3: sharing (0.4.9 → 0.5) and Info

For: Claude Code in `hewntools/hewn`. From: the Hewn design project, pass 3. Builds on `design/hewn/handoff-v2/` (pass 2, shipped).

**Specs:** the owner's release plans for 0.4.9, 0.4.10 and 0.5 (not in this repo; each PR states its part). Where this handoff and a spec disagree on **UI**, this handoff wins (the owner settled these in review). Where they disagree on **behaviour**, ask. Changes to the specs are listed under *Spec deltas*; the owner's answers after the handoff are under *Settled after the handoff*, and they win over the frames.

**Reference:** `reference/ui_kits/web/Hewn Screens v3.dc.html` (hi-fi; frame ids below) and `reference/UX Flows.dc.html` (turn 3, low-fi, with notes per frame). Open them in a browser from this folder: they load the repo's `packages/ui/src/ui.css` and `support.js` (which fetches React from unpkg, so you need to be online). Tool icons render as blank tiles, and the `AppIcon` and `CapRef` previews stay empty: both need the design tool's component bundle, which isn't here (the real ones are in the web client). Read them for layout and copy, not as code to port. The stylesheet is `packages/ui/src/ui.css`; it already has everything used here (the 0.4.x port is done). New CSS goes there, with a comment.

## Rules for the whole pass
- **No new navigation except the Hub tab.** Top bar: brand · `Search ⌘K` · Home, **Hub**, Agents, Accounts, Settings · Inbox (`frame.js` `NAV`).
- **One install sheet** for a file, a link and the Hub. Only the "From …" line changes.
- **One Share… sheet that grows:** what's in it on top, ways to share as rows below. 0.4.10 and 0.5 add rows, not screens.
- **One code browser** (`CodeBrowser`) everywhere code is shown: Versions › Files, a Hub page's Source code, the install sheet, updates.
- **Sample data is required to share** (all three ways). Hub cards and listing screenshots use it, never the owner's data.
- Copy: "Hub" capitalised as a name ("Publish to Hub", "on Hub"); review is passive ("listed after review", "held", "removed"). Hewn's own tools are **Official**.
- Sheets only for adding and confirming. Everything else is inline on the page.

---

## 0.4.9

### Hub tab (Q2) — `hub.js` (new), `frame.js`, `home.js`
- Route `#/hub`. Header row: `h1` Hub · search (fills the row; placeholder "Search N tools") · **Install from a file or link…**. Second row: chips **All · Official** (with the 16px Hewn mark) · divider · popular tags; on the right a segmented sort **Hot · Most installs · Newest** (from 0.5; Hot = installs in the last 30 days).
- **One mixed grid**, 3 columns, `grid-auto-rows: 1fr` (all cards the same height; set `margin: 0` on the cards, `.card + .card` adds a margin). In 0.4.9 it holds the Official shelf only; 0.5 adds listings from others to the same grid.
- **Card:** screenshot (132px, the shelf's PNG) · 28px icon + name (+ `Installed` pill if you have it) · one line · what it needs in mono: *nothing is shown when it needs nothing*; otherwise "reaches NOAA, met.no", or amber "uses a model · set up after install" when no model is set up (plain on hosted) · footer: **Official** (16px Hewn mark + accent-ink label) or avatar initial + `@handle`, then "N installs" on the right (from 0.5: nothing counts installs before the hub).
- Popular tags = the tags used by the most listed tools. Paging: "1–9 of 38" · Previous · Next.
- **New** (intake) shows one quiet link under the box: "Or start from one in Hub ›". No cards on New, except the **hosted first run**, which shows three Official cards.
- ⌘K: Hub results come **last** (after tools, actions, places); search covers Official locally and, in 0.5, listings as you type (absent offline).

### A tool's Hub page (Q3) — `hub.js`
- Back "‹ Hub". Screenshots row (screens + a widget) · icon 64 · name · pills (Official / @handle, version, installs from 0.5) · **Install** (primary) or, if installed, **Open** + **Install a copy**.
- Two columns, laid out like Info: left *What it does* (the shipped summary, then **Source code ›**, which opens the code browser in Source view) and *Operations*; right *What it needs* and *Versions*.
- No "Hewn's reading of the code" disclaimer.

### Install (R1–R4, R7) — `install.js` (new), `data` module
- **R1** Install from a file or link: one sheet with a drop zone and a link field (link works from 0.4.10; http links are refused).
- **R2** Files and links: your builder reads the code first ("Thinking…" typing dots; "Usually under a minute"; **Install anyway** skips). When it's done the same sheet fills in (**R2 result**): *What it does* with "Read by Claude Code · 0:38", then *What it found*: one row per finding, warn (says one thing, does another; asks for something it never uses; data leaving) with `file:line` and **Show** (code browser at that line), ok rows for what checks out. **Continue** goes to R3 with the findings carried over as notices. Hub and shelf tools skip this: their summary ships with them. No builder set up: "No summary: no builder set up", Source code, Install anyway.
- **R3** The sheet: icon + "Install X" + "From a file · name · v7" · What it does · flags as `notice warn` · Source code › · *It will ask for* (preview only; grants still happen after install) · **Name** (always shown, prefilled; a taken name gets " 2") · **Start with sample data** (ticked by default) · Cancel / Install.
- **R4** Installing: the build page with the bundle's milestones (no builder), then the tool opens and asks for what it needs.
- **R7** Refusals (newer ABI or format, over 5 MB, http): the Confirm pattern, one reason, one way forward ("hewn upgrade" with Copy).

### Share… (S1, S2) — `tool-actions.js` (`capabilityMenu`), `share.js` (new)
- Menu item **Share…** next to Export data. Sheet: icon + "Share X" + version select.
- *What's in it · N files*: scan findings by `file:line`, masked, with **Show**; a **Sample data** row ("sample/calls.json · N calls · always included"). "Never in it: your data, keys, settings, conversations, logs."
- *Share as* rows: **Download** (primary) · Link · Publish to [Hub](https://hub.hewn.tools) (opens in a new tab). Link and Publish rows appear in 0.4.10 / 0.5.
- **S2 Blocked:** an exact match of your own secret or config value → `notice danger` "src/config.ts:8 is your Todoist key. Remove it, then share again." + **Change…** (drawer, prefilled), and every row disabled. **No sample data** also disables every row and offers **Ask builder** (the main way: drawer, prefilled "Add sample data…") and **Write it yourself** (the override: opens the code browser on `sample/calls.json`, editable).

### Code browser (U4, Q5) — `files.js` (new), Info › Versions
- Left: file list (`side-list`). In Changes mode: "Changed since vN−1" and per-file `+n −n`. Right: a card with the file path and a segmented **Changes · Source**.
- **Changes:** git-style unified diff: `@@ -a,b +c,d @@` hunk headers (info-soft), two line-number gutters, `+` lines on ok-soft, `−` on danger-soft, context plain. **Source:** one gutter, no markers. Mono 12.5px, line height 1.75, wraps, on `--log-bg`.
- Version page: Conversation · Spec · Log · **Files** tabs, plus **Continue from here** and **Restore** in the bar.

### Start over (U2) — Info › Data
- Owner only. The Confirm pattern with type-the-id; "And replay the sample data" tick; a backup is kept. Danger button.

## 0.4.10
- **S3 Create a link:** always the version picked in Share… (no "always my latest"; a newer version needs a new link, so it's scanned again). Expires: 1 day · 7 days (default) · 30 days · **Never**, which turns the line under it red: "Anyone with this link can install this tool until you revoke it." Token: **at least 32 random base64url characters** (`/share/<token>`). No public address: "Links need a public address · Set up remote access ›".
- **S4:** Share… lists active links (version, time left, download count, Revoke).
- **R5/R6 With a connection:** "Installs 2 things" (connection first; it lands in Accounts and signs in after, via the I4 sheet). You already have it: segmented **Use mine** / **Install alongside** (becomes "Garmin 2"); missing operations → `notice info` "A build adds it first" (uses Credits on hosted).

## 0.5
- **Hub tab:** listings from others join the same grid (see the card footer). Fetched when the page opens; offline, Official only, silently.
- **Q3 from others:** the pills show `@handle`; a publisher block (avatar, name, @handle, GitHub check, joined, website, their other tools) sits under What it needs. **Report** is a quiet link.
- **Publish (S5–S7):** sign in once with a **free Hewn account** ("Publishing needs a free Hewn account."; no subscription; hosted skips this). Listing: Name · **One line (editable, prefilled from the tool's description)** · Tags · Screens (rendered with sample data only) · Submit for review. Then "Submitted"; the Inbox later says listed or held (with file:line).
- **S4 with a listing:** "@anna/plant-log · v7 · N installs", **Publish v8** when there's a newer version, **Unlist**.
- **Updates (T1–T3):** Inbox rows "v3 of X is on Hub" (Review) and "X was removed from Hub" (OK; copies keep working). T2 unchanged since install: What changed · "N files changed +a −b ›" (code browser, Changes) · *Newly asks for* (grant diff) · "Tested on a copy of your data first" · Update. T3 changed by you: **Bring in their changes** (a change build) or **Install vN as a copy**. Both have **Hub page ›** in the header.
- **T4 Origin:** a pill on Info only: "from Hub · Official", "from a file · Plant Log v7", "from a link · anna.hewn.tools".
- **R8 Builds on a published tool:** see `spec-notes/hub-tool-dependencies.md`. Listing shows "Builds on ▣ Sky Log" under What it needs; install says "Installs 2 tools, in this order".

## Info and fold-ins (0.4.9, first PR)
Not about sharing, but Share…, Start over, the origin pill and Versions › Files hang on this Info, so it lands first.

### Info, all on the page (W1–W3) — `info.js`
Replaces the row-per-sheet Info. Use `InfoSections` in the reference for structure.
- Header: icon 72 · name · purpose with cap-refs · **Open**; bar: ‹ Home · **Share…** · •••. Status pills (+ the origin pill). Anything that needs you sits **above** the composer as a `notice` with its one action (Authorize / Deny, Retry, set a model). Then the **Change it** composer.
- Sections as cards (`margin: 0`, flex `gap`), each the thing itself with inline actions:
  - **Operations:** rows with **Run** (opens the Run view on that op).
  - **Allowed to:** grants with **Authorize/Deny** (pending) or **Revoke**; the model as a tier `select` with this month's spend.
  - **Data:** rows and last write · **Export** · **Start over…** (danger).
  - **Schedules:** `input.switch` per schedule, Resume when paused, **+ Add schedule** (the only sheet).
  - **Widgets:** the widgets themselves, S/M with "on Home" or **Add to Home**.
  - **Instructions:** rules with Remove, plus an inline "Add a rule for this tool…".
  - **Versions:** the last two with **Details**, then **All N versions ›**.
- Empty sections collapse into one line at the foot: "Not set up: Schedules · Widgets", each a link.
- **≥ 1100px:** two columns. Left: Operations, Allowed to, Data. Right: Schedules, Widgets, Instructions, Versions. Narrower: one column in the order Operations, Allowed to, Schedules, Widgets, Instructions, Versions, Data.

### Fold-ins
- **V2 Intake box:** attachments as **64px thumbnails** with the file name and × (image previews, as the app already does); Attach · **Draft now** (link, once there are questions) · model menu as a ghost chip ("Claude Code · Fable · high ▾") · Send. Saved rules as `notice ok` with Undo. Replies render Markdown.
- **V3 Set icon:** title "Icon for X" with 64/28/20 previews · Draw / Image (centred) · the **5×5 editor centred**, with "N lit · 7–17 cells, one simple idea." · **Colour** and **Saturation** sliders at the same full width (Saturation with the 100% mark) · Use default / Cancel / Save.
- **V4 Ask builder to fix:** from a failed op, widget or schedule: the failure goes into the drawer as an attachment chip plus one prefilled line; nothing sends until Send.
- **V5 Got what you asked for?:** a quiet strip at the foot of the tool, once per version, within a week. Not quite → drawer.
- **V6 Waiting its turn:** "Waiting for the change before it" pill in the drawer, Inbox and Activity.

## Shared pieces (build once)
- **Hub card** (Hub tab, ⌘K Hub rows, hosted first run) and the **publisher line**.
- **Code browser** (Files, Source code, install, update).
- **Info sections** (tool Info; the connection page I2 uses the same two-column split).

## Spec deltas (from review)
- "From Hewn" → **Official**; one mixed shelf instead of two sections.
- Links: **no "always my latest"** (0.4.10, which version a link serves).
- **Sample data required to share**; screenshots sample-only (0.5, publishing).
- One line editable (0.5, publishing).
- Publishing needs a **free** account (0.5, who publishes; no subscription).
- Share tokens ≥ 32 random base64url characters.
- **New:** tools that build on published tools (`spec-notes/hub-tool-dependencies.md`), proposed for 0.5.

## Settled after the handoff (owner, 2026-10-26)
- **No install counts and no sort in 0.4.9.** Nothing counts installs before the hub, so the Official shelf has no "N installs" and no Hot · Most installs · Newest; both arrive with 0.5. **Hot** = installs in the last 30 days.
- **Sample data, the core case is generating it:** **Ask builder** is the primary action on S2; **Write it yourself** is the override. Saving it makes a new version through a build with no builder, with the sample replay on a copy of the data as its check. `hewn share` refuses without sample data too.
- **Start with sample data** is ticked by default for every install: a file, a link or the Hub.
- **Info (W1–W3) and the fold-ins (V2–V6)** land in 0.4.9, as its first PR.
- **Check it yourself** stays: a quiet link on the install sheet for a Hub or shelf tool (whose summary ships with it). It runs the same check as R2 (your builder reads the code; the dots), and the sheet fills in as **R2 result**.
- **Hosted first run:** three Official cards (Habits, Gift Ideas, Aurora Watch), then **Show all 9**, which shows the whole Official shelf in place.
- **Builds on (R8):** the manifest fields go in ABI 2.5, with 0.4.9; the feature itself is 0.5. A tool installed only for another isn't hidden from Home. **Unlist** of a tool others build on blocks new installs of those tools until their publishers publish a version without it (see the spec note).

## Done when
Each frame in `Hewn Screens v3` has a matching screen in light and dark, with long names and empty data. Hub works offline (Official only). No sheet opens from Info except to add or confirm.
