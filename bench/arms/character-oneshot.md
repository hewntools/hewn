#### The UI is the product

The owner judges the whole tool by this screen. A correct backend behind a bland form is a failed
build. Give the UI at least as much care and time as the operations: it is the part a person sees
every day. The request's "UI sketch" says what the screen must do; it is the floor, not the
ceiling. Your job is to make it something the owner is delighted to open.

#### Design it before you write it

Before writing `ui/`, think like a senior product designer and decide (say it in one short message
before you write the files):

1. **The moment:** who opens it, when, and what they want to know or do in the first five seconds.
2. **The answer first, as a picture:** what answers that question, at the top and big, drawn
   where it can be (the plants that are thirsty, the week's sleep, the budget left) rather than
   written out. A big number only when the number really is the answer.
3. **Its own identity:** this tool lives on the owner's Home among their other tools (the request
   lists them, with their colours and looks, when there are any). It needs an identity of its own:
   someone glancing at two of the owner's tools should never mistake one for the other. Tell it
   apart by its concept, layout, type and signature visual. **Colour comes from the subject:** use
   the colours the subject is known for when it has them (green for money and plants, purple or
   deep blue for sleep, blue for water, red for workouts, warm paper and cloth for books), even if
   another tool is in similar shades. The icon's hue is the tool's lead colour; pick it the same way.
4. **Three directions, then the best one:** sketch three visual directions that really differ: in
   palette, type pairing, layout structure and signature visual, not three shades of one idea. Each
   takes its character from the tool's own world (a running log could feel like a race-day bib; a
   recipe box like stained index cards; a bike log like a workshop manual). Drop any that would look
   like one of the owner's other tools or like "Looks to avoid" below, then pick the strongest of
   the rest: the one that best serves the owner's moment and has the most character. Unusual is good
   when it serves the tool, never for its own sake. Say in a line why it won.
5. **A plan before code:** for the chosen direction, write down its colours (a palette, not one
   hue in several shades: a lead colour, a second colour from a different colour family, an accent,
   and neutrals; named, with the values for light and for dark), its type roles (display, body, numbers, small labels, each with
   its font stack) and its layout structure. Check the plan against "Looks to avoid" below and
   against the owner's other tools, and change whatever matches.
6. **Record the look** in `ui/look.json`, so the owner's next tools can be told what this one looks
   like: `{"hue": …, "palette": {"name": "#hex", …}, "type": {"display": "…", "body": "…"},
   "layout": "…", "signature": "…", "mood": "a few words"}`. Keep it true if you change the design later.
7. **Big visuals, not forms:** the data drawn is the main content of the screen, not a garnish.
   At least one large, custom, data-driven visual that fits the data better than a table would (a timeline, a calendar heatmap, a gauge, a ring, a map of rooms, a small
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
concept: your own palette (several colours led by the tool's `hue`, defined for light and dark,
readable contrast), a type scale with real hierarchy (clear steps in size and weight), gradients,
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
- **Show, don't list:** never lay a record out as `Label: value` lines or a key-value table. A
  record's facts become part of a visual (a bar's length, a position on a timeline, a colour, a
  fill level), a short sentence, or the layout itself.

#### Looks to avoid

Every model reaches for the same few looks, so a tool that uses them looks generated, however well
it's made. Don't use these (if the concept truly needs one, say why in your plan):

- **Warm cream or parchment background with a high-contrast serif display and a terracotta, clay or
  peach accent** as the default "tasteful" look. Paper tones are fine where the subject is paper
  (books, letters, recipes); not as a style for everything.
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
- **One hue in several shades** as the whole palette (a single-colour ramp on a tinted background).
- **A screen of labelled fields** (`Name: …`, `Due: …`, `Status: …`) where a picture of the data would
  say more.


#### Get it right the first time

You can't see the page while you build it, so check your markup and CSS against the mistakes first
versions make most often (a design review of many of them found the same ones again and again):

- **Dark mode designed, not inverted.** Give every colour you set a dark value of its own, chosen
  for the dark palette, under `@media (prefers-color-scheme: dark) { :root { … } }`. The base is in
  a cascade layer, so your own CSS wins over it whatever the selectors; a colour you set only in
  plain `:root` stays the same in dark mode.
- **One answer first.** The top of the screen answers the owner's question; nothing above or beside
  it competes for the eye.
- **Each piece of data in one place.** Don't show the same items in a hero and again in a list, or
  the same bar three times.
- **Lists don't take over.** Show the few that matter now (5–8) and a way to see all; a long history
  becomes a visual, not a wall of identical rows.
- **The signature visual earns its space.** Sized to its data, labelled, readable at a glance: not a
  big, mostly empty illustration, and not a tiny garnish under everything else.
- **The main action is quick and close.** One or two taps, next to what it acts on; on a phone it's
  reachable without covering content.
- **The phone layout is designed, not just stacked.** At 375 px the order is the answer, the main
  action, the visual, then the rest. Nothing is wider than the screen: `min-width: 0` on grid and
  flex children, `max-width: 100%` on images and SVG, `flex-wrap` where a row can't fit,
  `overflow-wrap: anywhere` on long text, and chart labels that don't collide at that width.
- **No dead space.** No half-empty panels or large blank areas on a wide screen.
- **Cut text keeps its meaning.** Truncate only where the full text is still available (a `title`,
  the item's own page), never a label whose cut hides what it says.
- **States are unmistakable.** Done and not done, due and late, selected and not: tell them apart
  at a glance, not by a subtle shade.

Before you stop, read your UI files once more against this list and fix what you find.

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

