# Build-quality bench

Hewn's builder gets judged on one screenshot and a feeling. This bench gives it numbers and side-by-side
comparisons instead. It builds the same requests under different setups ("arms"), fills each tool with
the same data, takes screenshots, and puts the results next to each other, for a model and for you to
judge.

It runs the real thing: the platform from this checkout (builds, validation with its render check,
promotion), with Claude Code building exactly as Hewn runs it, sandbox included. It doesn't touch your
Hewn: every result gets a throwaway home of its own.

## Running it

```sh
npm run bench -- list                                   # arms and cases
npm run bench -- run --name first                       # every arm × every case, once
npm run bench -- run --name first --arms current,character+critique+craft --cases plant-log,spending --reps 2
npm run bench -- judge first                            # a model scores the screenshots
npm run bench -- judge first --arms current --again     # judge some arms (again)
npm run bench -- serve first                            # http://127.0.0.1:7790/
npm run bench -- report first                           # first/summary.md
npm run bench -- recheck first                          # redo the phone check and the click-through, no builds
npm run bench -- hide first current,design-forward      # out of the gallery, vote, score page, summary, judge
npm run bench -- show first current
```

- **Where results go:** `~/hewn-bench/<name>/`, or `--out` / `$HEWN_BENCH_DIR`. It can't be inside a
  `.claude` directory: Claude Code won't write there, so every build would fail.
- **Restarting:** a run started again with the same name keeps the results that are done and redoes the
  rest. Adding arms or cases to an existing run adds them.
- **Stopping without losing work:** create a `STOP` file in the run's directory. Results already
  building finish; the ones that haven't started don't start, and a later `run` picks them up (delete
  the file first).
- **Calling environment:** started from a Claude Code session, the session's own variables (its effort
  among them) are dropped before each build, so the builder runs as it would under Hewn.
- **Cost:** a build is about $2–3 on Opus, a critique pass about as much again, a craft pass $0.50–1.
  A retry after failed tests can double a build. Six cases of one arm with critique and craft are
  roughly $30.

## What a run produces

`<run>/results/<arm>/<case>/r<n>/`:

- `shots/`: `desktop-{light,dark}.png` (1280 px) and `mobile-{light,dark}.png` (390 px, 2×), full
  page, with the data. `empty-{light,dark}.png` is the platform's own render check. An arm with passes
  also keeps the version before them in `shots-first/` (and `shots-before-<pass>/` for later passes).
- `result.json`:
  - each build's outcome, attempts and tests;
  - builder usage: model, minutes, turns, $, output and thinking tokens;
  - UI metrics: KB, the tool's own CSS, SVG drawing sites, canvas, platform charts, motion,
    `prefers-reduced-motion`, colours, font stacks;
  - errors on the page and failed API calls, per viewport;
  - phone overflow: how far anything sticks out past a 390 px screen, also when the page hides it;
  - a click-through: every visible control that doesn't delete or reset anything, clicked once from a
    fresh load on a copy of the state. Browser dialogs are dismissed and listed;
  - for a craft pass, the defects it was told about.
- `judge.json` (and `judge-first.json` for the version before the passes): scores from 1 to 10 for
  design quality, originality, craft and usefulness. The total out of 60 counts the first two double.
  It also names the AI tells it sees, the three biggest problems and the best thing.
- `owner.json`: your own score, from the score page.
- For spec arms: `spec.md` (what the builder got), `intake.json` and `conversation.json`.
- `version/`: the promoted tool's files. `home/`: its seeded Hewn. `transcripts/`: the builder's logs.

`<run>/results/<arm>/sameness-r<n>.json` is the judge's view of an arm's tools as a set: 1 means each
has a look of its own; 10 means one template with different data.

## Judging

`serve` opens a local page with:

- **Gallery:** every case × arm, with its screenshots, numbers and flags. **open live** runs the tool on
  a copy of its seeded state, so you can click around; **reset** throws your changes away.
- **Blind vote:** two arms' builds of the same case, in random order, without names. Pick the better
  one (keys `a`, `s`, `b`). Votes go to `<run>/votes.jsonl`.
- **Score:** one build at a time, without its arm, scored on the judge's criteria and scale. Your
  scores sit beside the judge's.
- **Summary:** per arm: what got built and what it cost, the judge's means (before and after any
  passes), sameness, your win rate and scores, the UI metrics, and the counts of page errors, broken
  clicks and phone overflow.

Your votes are the ground truth. The judge is there to scale beyond what you have time to look at.

## Arms

`lib/arms.ts`. An arm is a name and how it differs from today's setup:

- `brief`: a transform of `spec/builder-brief.md`, usually `replaceSection` or `insertBefore` with a
  file from `arms/`.
- `model`, `effort`: the builder's model and effort.
- `passes`: `critique` and/or `craft` after the build, in the same result.
  - **critique:** screenshots of its own UI with the data, "five biggest problems, then fix".
  - **craft:** fresh screenshots plus measured defects, fix without a redesign.
  - What each asks is Hewn's own (`packages/core/src/passes.ts`), as Hewn's passes ask it.
- `from` with `critique` or `craft`: start from another arm's result instead (the older arms do this).
- `sequential`: build the cases in order, each told how the earlier tools look (their hue and
  `ui/look.json`), as a Home fills up.
- `spec`: where the spec comes from instead of the frozen requirements:
  - `intake`: today's intake (the lean brief since 0.4.10), from the case's `ask`, its questions
    answered with the defaults;
  - `intent`: 0.4.9's intake spec (operations, state, tests) with UI intent instead of its UI sketch;
  - `lean`: today's intake too, from a scripted conversation (the case's `ask`, then `talk`); the
    builder also gets the owner's own words;
  - `thin`: an agent's one-liner.
- `sample`: the builder writes `sample/calls.json`, which the bench replays instead of the case's seed.
- `pipeline`: Hewn's own passes, in the build itself (its `buildPasses` setting), not the bench's: they
  run on the builder's sample data and fall back as Hewn does. The `pipeline`, `pipeline-craft` and
  `pipeline-none` arms are Hewn as it builds today (the lean intake with a conversation, today's brief,
  its own sample data) with both passes, the craft pass only, or none: the release's cost question.
  Without it, a bench build runs none (the arms' own `passes` are the bench's).

The test suite checks that every arm still applies to the current brief and intake, so an edit there
can't quietly turn an arm into the baseline. `npm run bench -- list` shows them all.

## Cases

`cases/<id>/`:

- `requirements.md`: a frozen request in 0.4.9's intake format (operations, state, tests, LATER, UI
  sketch).
- `case.ts`:
  - the name and purpose;
  - `ask`: how the owner would put it;
  - `talk`: what they'd say next, with details and taste;
  - a seed: dated from the day of the run, with a fixed pseudo-random sequence, so every arm gets the
    same data.

A build that doesn't take the spec's operations as written still gets shown, with the seed error in
its result.

| Case | Kind of screen |
| --- | --- |
| `plant-log` | a tracker with due dates |
| `sleep-log` | a time-series dashboard |
| `reading-shelf` | a collection with a goal |
| `habit-check-ins` | a daily check-in, phone-first |
| `family-quotes` | a memory keeper |
| `spending` | a numbers dashboard with budgets |
