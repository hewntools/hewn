# Build-quality bench

Hewn's builder gets judged on one screenshot and a feeling. This bench gives it numbers and side-by-side
comparisons instead. It builds the same frozen requests under different setups ("arms"), fills each tool
with the same data, takes screenshots, and puts the results next to each other for a model and for you to
judge.

It runs the real thing: the platform from this checkout (builds, validation with its render check,
promotion), with Claude Code building exactly as Hewn runs it, sandbox included. It doesn't touch your
Hewn: every result gets a throwaway home of its own.

## Running it

```sh
npm run bench -- list                                   # arms and cases
npm run bench -- run --name first                       # every arm × every case, once
npm run bench -- run --name first --arms current,design-forward --cases plant-log,spending --reps 2
npm run bench -- judge first                            # a model scores the screenshots
npm run bench -- serve first                            # http://127.0.0.1:7790/
npm run bench -- report first                           # first/summary.md
```

- **Where results go:** `~/hewn-bench/<name>/`, or `--out` / `$HEWN_BENCH_DIR`. It can't be inside a
  `.claude` directory: Claude Code won't write there, so every build would fail.
- **Restarting:** a run started again with the same name keeps the results that are done and redoes the
  rest. Adding arms or cases to an existing run adds them.
- **Calling environment:** started from a Claude Code session, the session's own variables (its effort
  among them) are dropped before each build, so the builder runs as it would under Hewn.
- **Cost:** about $2–2.50 on Opus for each build, and a critique pass costs as much again. One
  repetition of three arms over six cases is roughly $40 and an hour at 3 at a time (`--concurrency`).

## What a run produces

`<run>/results/<arm>/<case>/r<n>/`:

- `shots/`: `desktop-{light,dark}.png` (1280 px) and `mobile-{light,dark}.png` (390 px, 2×), full
  page, with the case's seed data. Also `empty-{light,dark}.png`: the platform's own render check on
  the empty state, which is what you see on the build.
- `result.json`:
  - the build's outcome, attempts and tests
  - builder usage: model, minutes, turns, $, output and thinking tokens
  - UI metrics: KB, the tool's own CSS, SVG drawing sites, canvas, platform charts, motion,
    `prefers-reduced-motion`, colours, fonts
  - errors on the page and failed API calls, per viewport
  - how far the phone layout sticks out sideways
  - a **click-through**: every visible control that doesn't delete or reset anything is clicked once
    from a fresh load (on a copy of the state), and what threw is listed
- `judge.json` after `judge`. Scores from 1 to 10 on Anthropic's four design criteria: design
  quality, originality, craft, usefulness. The total out of 60 counts the first two double. It also
  lists the AI tells it saw, the three biggest problems and the best thing.
- `version/`: the promoted tool's files. `home/`: its seeded Hewn. `transcripts/`: the builder's logs.

`<run>/results/<arm>/sameness-r<n>.json`: the judge's view of an arm's tools as a set. 1 means each
has a look of its own; 10 means one template with different data.

## Judging

`serve` opens a local page with:

- **Gallery:** every case × arm with its screenshots, numbers and flags. **open live** runs the tool
  on a copy of its seeded state, so you can click around; **reset** throws your changes away.
- **Blind vote:** two arms' builds of the same case, in random order, without names. Pick the better
  one (keys `a`, `s`, `b`) and tick the ones you'd open daily. Votes go to `<run>/votes.jsonl`.
- **Summary:** per arm, with what got built and what it cost; the judge's mean scores and sameness;
  your win rate and "would open daily" rate; UI metrics; and how many results had page errors,
  broken clicks or phone overflow.

Your votes are the ground truth. The judge is there to scale beyond what you have time to look at, so
check that it agrees with your votes before trusting it on its own.

## Arms and cases

**Arms** (`lib/arms.ts`): a name, and how the arm differs from today's setup:
- `brief`: a transform of `spec/builder-brief.md`, usually `replaceSection` with a file from `arms/`.
- `model`, `effort`: the builder's model and effort.
- `from` + `critique`: start from another arm's built tool and run a design review pass on it with
  screenshots of its UI.

The test suite checks that every arm still applies to the current brief, so a brief edit can't quietly
turn an arm into the baseline.

**Cases** (`cases/<id>/`): `requirements.md` is a frozen request in the intake's format (operations,
state, tests, LATER, UI sketch), and `case.ts` holds the name, purpose and a seed. Seeds are dated
from the day of the run and use a fixed pseudo-random sequence, so every arm gets the same data. A
build that doesn't take the spec's operations as written still gets shown; the seed error is recorded
in its result.

The six cases cover different kinds of screen:

| Case | Kind of screen |
| --- | --- |
| `plant-log` | a tracker with due dates |
| `sleep-log` | a time-series dashboard |
| `reading-shelf` | a collection with a goal |
| `habit-check-ins` | a daily check-in, phone-first |
| `family-quotes` | a memory keeper |
| `spending` | a numbers dashboard with budgets |
