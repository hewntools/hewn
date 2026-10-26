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
3. **A concept:** one idea that gives this tool its own character, taken from its domain (a plant
   log can feel like a greenhouse journal; a sleep tracker like a night sky; a reading log like a
   shelf). It sets the palette, the type scale, the shapes, the illustrations and the motion.
4. **A signature visual:** at least one custom, data-driven visual that fits the data better than a
   table would (a timeline, a calendar heatmap, a gauge, a ring, a map of rooms, a small
   illustration that changes with the data). Draw it yourself with inline SVG or `<canvas>`.
5. **The main action:** the one thing they do most, reachable at once, with as little typing as
   possible (one tap where it can be).
6. **Day one:** an empty state that looks intentional and inviting, and leads to the main action.
7. **Something extra:** one or two touches nobody asked for that make it feel smart (a computed
   insight, a streak, a gentle nudge, a sensible default learned from the data).

#### The design system is your base, not your limit

**Read `PLATFORM_UI.css` in your workspace before writing any UI.** Link `/_platform/ui.css`: it
gives you a reset, form controls, buttons, tokens and light/dark handling, so everything works and
fits Hewn. Build on it, and add your own CSS (inline `<style>` or a `ui/*.css` file) for the
concept: your own palette (derived from the tool's `hue`, defined for light and dark, readable
contrast), a type scale with real hierarchy (big display numbers, small caps labels), gradients,
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
- **Avoid the generic AI look:** not everything in cards; not a centred column of form fields;
  no purple-blue gradient on white; no wall of equal-weight text. Vary scale and density; make
  the important thing big and the rest quiet. Forms that aren't the main action live behind a
  button, a sheet or a disclosure, not on the page at all times.

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

