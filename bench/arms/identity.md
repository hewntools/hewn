#### The UI is the product

The owner judges the whole tool by this screen. A correct backend behind a bland form is a failed
build. Give the UI at least as much care and time as the operations: it is the part a person sees
every day. The request's "UI sketch" says what the screen must do; it is the floor, not the
ceiling. Your job is to make it something the owner is delighted to open.

#### Design it before you write it

Before writing `ui/`, think like a senior product designer and decide (say it in one short message
before you write the files):

1. **The moment:** who opens it, when, and what they want to know or do in the first five seconds.
2. **The answer first:** the one number, list or picture that answers that, at the top, big.
3. **Its own identity:** this tool lives on the owner's Home among their other tools (the request
   lists them, with their colours and looks, when there are any). It needs an identity of its own:
   someone glancing at two of the owner's tools should never mistake one for the other. Start from
   the icon you drew first: its hue is this tool's signature colour. Pick a hue at least 40° away
   from the other tools' hues, and build the palette around it, for light and for dark.
4. **Three directions, then the bold one:** sketch three visual directions that really differ: in
   palette, type pairing, layout structure and signature visual, not three shades of one idea. Each
   takes its character from the tool's own world (a running log could feel like a race-day bib; a
   recipe box like stained index cards; a bike log like a workshop manual). For each, estimate how
   typical it is: how likely another designer or another AI would make much the same thing for this
   tool, from 0 to 1. Pick the least typical one that still serves the owner's moment well (the
   unexpected but right one, not the safe one), and say in a line why.
5. **A plan before code:** for the chosen direction, write down its colours (4–6, named, with the
   values for light and for dark), its type roles (display, body, numbers, small labels, each with
   its font stack) and its layout structure. Check the plan against "Looks to avoid" below and
   against the owner's other tools, and change whatever matches.
6. **Record the look** in `ui/look.json`, so the owner's next tools can be told what this one looks
   like: `{"hue": …, "palette": {"name": "#hex", …}, "type": {"display": "…", "body": "…"},
   "layout": "…", "signature": "…", "mood": "a few words"}`. Keep it true if you change the design later.
7. **A signature visual:** at least one custom, data-driven visual that fits the data better than a
   table would (a timeline, a calendar heatmap, a gauge, a ring, a map of rooms, a small
   illustration that changes with the data). Draw it yourself with inline SVG or `<canvas>`.
8. **The main action:** the one thing they do most, reachable at once, with as little typing as
   possible (one tap where it can be).
9. **Day one:** an empty state that looks intentional and inviting, and leads to the main action.
10. **Something extra:** one or two touches nobody asked for that make it feel smart (a computed
   insight, a streak, a gentle nudge, a sensible default learned from the data).

#### The design system is your base, not your limit

**Read `PLATFORM_UI.css` in your workspace before writing any UI.** Link `/_platform/ui.css`: it
gives you a reset, form controls, buttons, tokens and light/dark handling, so everything works and
fits Hewn. Build on it, and add your own CSS (inline `<style>` or a `ui/*.css` file) for the
concept: your own palette (derived from the tool's `hue`, defined for light and dark, readable
contrast), a type scale with real hierarchy (clear steps in size and weight), gradients,
shadows, borders, radii, textures and illustration where they serve the concept. System font
stacks only (no web fonts are reachable): `ui-serif`, `ui-rounded`, `ui-monospace` and
`system-ui` already give you plenty of range.

- Useful classes from the base: layout (`.page`, `.stack`, `.row`, `.grid`), `.card`, `.stats`,
  `.pill`, `.chip`, `.segmented`, `.switch`, `.stepper`, `.field`, `.table-wrap`, `.empty`,
  `.skeleton`, `.toast-region`/`.toast`. Use them when they fit; don't let them dictate the layout.
- `/_platform/chart.js` has `barChart` and `lineChart` for plain series. Anything more specific
  (heatmaps, timelines, rings, sparklines, illustrations): draw it yourself.
- **Motion:** purposeful transitions and micro-interactions (an item settling into a list, a
  satisfying check, numbers counting up, a visual updating smoothly). Respect
  `prefers-reduced-motion`.
- **Light and dark:** both must look designed, not just inverted: define your colours for both.
- Vary scale and density; make the important thing big and the rest quiet. Forms that aren't the
  main action live behind a button, a sheet or a disclosure, not on the page at all times.

#### Looks to avoid

Every model reaches for the same few looks, so a tool that uses them looks generated, however well
it's made. Don't use these (if the concept truly needs one, say why in your plan):

- **Warm cream or parchment background with a high-contrast serif display and a terracotta, clay or
  peach accent.** The current default "tasteful" look.
- **Near-black background with an acid-green, lime or vermilion accent.**
- **Purple or blue gradients on white;** soft gradient washes in a corner of the page.
- **Tracked-out ALL-CAPS micro-labels** above headings and sections (`MONDAY, OCTOBER 26`,
  `THE WEEK AHEAD`): don't use the base's `.eyebrow` for this. Let size, weight and position carry
  the hierarchy instead.
- **Middle-dot meta strings** (`Kitchen · watered 3 days ago · due today`): put facts in their own
  places (columns, a second line with a clear role, a visual) instead of a chain of fragments.
- **The oversized serif number with a sentence beside it** as the hero of every screen.
- **Every section in an identical rounded card** (the SaaS card kit), and **pills or badges on
  everything.**
- **A centred narrow column** with wide empty margins on a desktop screen: use the width when the
  data is worth showing.
- **Emoji as icons.**


#### Checklist (do all of these)

- **Forms:** sensible defaults (today's date, the last value used, the most common choice); Enter
  submits; the button is disabled while saving; after success the new item shows up at once
  (animated in); after a failure the input stays and the error is shown next to the form.
- **Formatting:** dates and times readable and local (`Intl.DateTimeFormat`, "today", "3 days ago"),
  numbers with units, never raw ISO strings, ids, or JSON.
- **Order:** the most useful first (newest, most urgent, highest rated), not insertion order.
- **Destructive actions:** ask first (or offer Undo in the toast); say what will be lost.
- **Copy:** plain words from the owner's world, not the API's. Sentence case. Short, warm, specific.
  Emoji only if they truly belong to the concept; prefer drawn SVG icons.
- **Small screens:** works at 375 px wide: one column, nothing cut off, tap targets ≥ 36 px.
- **Accessible:** real `<button>`s and `<label>`s, visible focus, keyboard reachable, readable contrast.
- **Errors:** an operation's `{ error }` is shown in the page; nothing is thrown or logged as an error.

