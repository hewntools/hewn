# Smoke runs on a copy

`npm run smoke:copy` starts a tree's Hewn on a throwaway copy of a real home, runs fixed checks and a PR's own scenario steps, and writes a report (markdown and screenshots). It's for checking a change against real data before anyone tries it by hand: run it on every PR.

```sh
npm run smoke:copy -- --from <backup.zip | home> --tree <checkout> [--scenarios <dir>] [--out <dir>] \
                      [--network] [--tool <id>] [--baseline <results.json>] [--keep]
```

| Option | |
| --- | --- |
| `--from` | A `hewn backup` zip, or a Hewn home. A home is read as the nightly backup reads it (consistent SQLite snapshots of `workerd/do`, and `workerd/blobs`), never written, so a running Hewn's home is fine. |
| `--tree` | The checkout to run, with `npm ci` done in it (install scripts on: without them `workerd` is a Node shim). The harness itself may come from another checkout. |
| `--scenarios` | A folder of scenario files, run after the fixed checks (below). |
| `--out` | Where the report goes: `report.md`, `results.json`, `shots/`, the copy's log `hewn.log` and the stub builder's notes `stub.jsonl`. Default: a new folder in the temp dir. It holds the copy's tool names and log lines: keep it local. |
| `--network` | Let tools' GET and HEAD out. Default: nothing goes out. |
| `--tool` | The tool changes are made on. Default: the first ready one that needs no network, model or other tool, with a screen if one has. |
| `--baseline` | `results.json` of a run of the base branch on the same copy: what failed there too is a warning here, said so. Without it, a bug of one of the copy's own tools fails every run. |
| `--keep` | Keep the copy's home (printed) instead of deleting it. |

Exit code: 0 pass (or warnings, skips), 1 a check failed, 2 the run stopped early (the report says why). The whole run takes about a minute on a home with 50 tools.

## What keeps the copy from acting for the owner

Each of these fails closed: when it can't be done or checked, the copy doesn't start (or is stopped at once).

- **No secrets.** The copy's home is new: only `workerd/do` and `workerd/blobs` come from the source, never its `master.key`, `platform.json` or tunnel. Before start, `secrets_enc` (the owner's secrets, encrypted), `oauth_tokens` and `web_sessions` are emptied in every database, then checked empty. The copy gets a key of its own (`HEWN_KEY_SOURCE=file`, a `master.key` in the copy: no Keychain entry). So a connection's sign-in is gone: it can't refresh a token and sign the live Hewn out of a service, and the report skips it as "needs signing in again".
- **No schedules,** twice: every active schedule is paused in SQLite before start (every `*.sqlite` under `workerd/do`, and `platform.db`), then none may be left active; and the copy runs with `HEWN_SCHEDULES=off`. The report says how many were paused.
- **No network** unless `--network`, and then only GET and HEAD: `HEWN_NETWORK`. A read operation's `sideEffect` is only its author's word, and a tool's config (a webhook URL) can point anywhere. A GET can still carry data in its address, to a host the tool is allowed: use `--network` on copies whose tools are known to only read.
- **No real builder or model.** The copy runs the tree's own supervisor and workerd host (`startSupervisor`, as `hewn serve` does, from `scripts/smoke-copy/launch.ts`), with a stub builder under every builder's name and a stub intake: nothing runs Claude Code, Codex or OpenCode on the owner's accounts. The copy has no model keys (they're secrets).
- **Its own ports**, never 7717, 7718 or 9091 (nor `HEWN_PORT`'s and the next), and only its own environment: nothing of a live Hewn's (`HEWN_BUILD_URL`, `HEWN_PROXY_SECRET`, `HEWN_METRICS_PORT`) reaches it. Its backups go to its own folder, with today's already there so the nightly one doesn't run.
- **The sandbox on.** Stopped by its own pid (SIGTERM, SIGKILL after 20 s); a workerd of the copy's still running after that is reported and killed by its pid, checked to be the copy's. Never `pkill`.
- **A tree without `HEWN_SCHEDULES` and `HEWN_NETWORK`** (one from before 0.4.12) is refused: the copy would start with its schedules and network on.

Right after start, the **Safety** check reads the supervisor's status and the two workerd configs (`config.capnp`, `tools.capnp`) and stops the run unless every switch is on.

## The switches

For copies and drills, never an owner's own Hewn. Both are read by `hewn serve` (`copySwitchesFromEnv`) and are options of `startSupervisor`; any other value is refused, so a typo can't leave them on.

| Variable | |
| --- | --- |
| `HEWN_SCHEDULES=off` | No schedule runs, whatever its status: nothing is due (the DO alarm isn't armed, the resume check finds nothing), and Run now is refused (`PlatformOptions.schedulesOff`). |
| `HEWN_NETWORK=off` | Tools' Egress refuses every fetch (`egress denied: the network is off…`), and the tools' workerd has no network. |
| `HEWN_NETWORK=get` | Tools' Egress lets only GET and HEAD to approved hosts out; anything else is refused before it's sent. |

With either network mode, the platform's own fetches are off too (its `internet` service allows nothing): model providers, a connection's sign-in, an install from a link, the model catalog. `hewn status` and `/control/status` say when either switch is on.

## The fixed checks

| Check | |
| --- | --- |
| Safety | Above. |
| Both processes up | The supervisor and both workerds alive, `/health`, the sandbox on. |
| `hewn doctor` | The tree's own, on the copy. The warnings every copy gets (its key is a file, agents point at the live Hewn) don't count. |
| Every tool ready | Skipped with the reason when it's only what a copy lacks: a connection's sign-in, a secret, a model key, a grant the owner hasn't given (as on the source). A tool suspended in the source is a warning. |
| Every widget renders | Through `POST /api/home/preview`, as the owner. |
| Every read operation with no required input runs | As the owner. Skipped: a tool that isn't ready, needs a model, or calls a connection that needs signing in; one that fails reaching the network while it's off. Widgets' operations are left to the widget check. |
| Pages | Home, the Inbox, a tool's Info, Activity and Settings in the headless shell: no console errors, failed requests or 5xx; a screenshot each. |
| A change goes live | A change through the stub builder (a comment at the end of `src/index.ts`): workspace, bundle, tests, the visual check, promotion; then a rollback and a call. |
| Stop, then Retry | A slow stub build, stopped, then retried: the retry must carry on from the stopped one's workspace and go live. |
| A restart cycle | The tools' workerd killed (it alone comes back), the platform's (both come back), then a stop by pid (nothing orphaned) and a start on the same copy. |
| Memory | RSS of each process at rest, after 200 GETs of `/api/capabilities`, after 200 more (growth that the second round repeats isn't a cache filling), and after the checks. |
| The log | Lines with `jsg`, `ERROR` or `unhandled`. The ones every copy has (the platform's refused fetches) are listed apart. |
| Timings | Start-up, the first Home, a tool call as the owner and over MCP, a change build, a retry. |

The tool for changes is put back to its version afterwards.

## Scenarios

A PR's session writes the steps its owner would otherwise try by hand as a scenario: a `*.ts` or `*.mjs` file whose default export is a `Scenario` (`scripts/smoke-copy/scenario.ts`). Put the PR's in a folder and pass `--scenarios`. Each step is a pass or a fail in the report; a step that fails ends its scenario, and the next one runs.

```ts
import type { Scenario } from "<hewn>/scripts/smoke-copy/scenario.ts";
export default {
  name: "What the owner would try",
  async run(s) {
    await s.step("open the tool", async () => {
      const page = await s.page(`#/c/${s.tool}`);   // signed in as the owner; console errors fail the step
      await page.getByText("Versions").first().waitFor();
      await s.shot("info");                          // into the report
    });
    await s.step("an agent calls it", async () => {
      const a = await s.copy.agent("smoke", ["discover", "invoke"]);
      await a.tool("capabilities_list", {});
      await a.close();
    });
  },
} satisfies Scenario;
```

What a scenario gets: `s.copy` (`admin`, `call` for the CLI's allow-listed core methods, `api` for the web API, `agent` for MCP), `s.page(hash)` (Playwright), `s.shot`, `s.tool`, `s.waitBuild(id)`, and `s.stub` (the stub builder's notes). The request's text steers the stub builder: `[smoke:slow]` notes its progress in `src/index.ts`, then waits for a Stop (a retry that carries on finds the note and finishes at once); `[smoke:fail]` fails the attempt; anything else is a trivial edit. It builds changes only. The example, [`scenarios/stop-then-retry.ts`](../../scripts/smoke-copy/scenarios/stop-then-retry.ts), does Stop and Start again in the web client.

## The browser

The pages and scenarios use Playwright's headless shell (or another Chromium `findBrowser` finds) through `playwright-core`, which isn't one of Hewn's dependencies: `PLAYWRIGHT_NODE_MODULES` names a `node_modules` that has it, else npx's cache is searched. Without one, the Pages check is skipped and scenarios that open a page fail.

## What it doesn't cover

`hewn serve`'s own wiring (the real builders and intake, agent setup, the metrics port, the update check), real builds and the intake's drafts, connections and model calls (no secrets), and anything a tool does only with input. A PR that changes those says how it was tried.
