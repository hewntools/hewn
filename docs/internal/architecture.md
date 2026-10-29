# Architecture

How Hewn is built today: the packages, what runs where, and where things are stored. [`target-architecture.md`](target-architecture.md) is the direction, [`security-and-authority.md`](security-and-authority.md) the trust model, and [`repo-layout.md`](repo-layout.md) who may depend on whom. The contract tools and agents see is the [spec](../../spec/README.md).

Keep this document true when you change the code.

## Overview

```text
agents (Claude, Codex, ChatGPT…)   MCP over Streamable HTTP, OAuth 2.1 bearer tokens
browser (web client, tool UIs)     cookies (web client) or a per-UI token (tool UIs)
          │                                   │
          ▼                                   ▼
┌─ workerd (under Seatbelt on macOS, bubblewrap on Linux) ──────────────────────┐
│  default fetch ─► HewnDO (one per owner)                                      │
│                     surface: web client, tool UIs, MCP, OAuth, admin channel  │
│                     core Platform on the DO's SQLite (the owner's database)   │
│  Public (second socket) ─► HewnDO, rate limited, MCP and OAuth (+ public URL) │
│  CapabilityHost (one per capability): versions run as DO facets,             │
│                     each with its own private SQLite                          │
│  Egress: the capabilities' globalOutbound, approved hosts only               │
└───────────────────────────────────────────────────────────────────────────────┘
          │ token-authenticated HTTP, both ways
supervisor (Node, `hewn serve`): starts workerd and its watchdog, runs builders,
bundles candidates, runs the intake, connects local agents, backups, tunnels
          ▲
hewn CLI ── the admin channel (as the owner) or the supervisor's control channel
```

A [capability](../../spec/capability-model.md#capability) is called a tool in everything the owner sees; the code, the API and these notes say capability.

## Packages

| Package | What | Licence |
| --- | --- | --- |
| `spec/` (`@hewntools/spec`) | The contract as types, JSON Schemas and docs: the manifest, `ctx`, the [ABI](../../spec/README.md#versions) version and its history, the MCP tools agents get. No runtime code. | Apache-2.0 |
| `packages/core` | The platform logic: `Platform` and its domains (`src/platform/`), the registry, manifest and contract checks, migrations rules, auth, OAuth, schedules, widgets, the model port. Pure: no Node, no workerd. | AGPL |
| `packages/host-workerd` | What runs inside workerd: the Worker and its Durable Objects, the capability runtime wrapper, the HTTP and MCP surface, the web client (`web/`: `app.js`, one module per section in `web/app/`, the shared `kit.js`). | AGPL |
| `packages/ui` | The UI kit tool UIs load from `/_platform/`: `ui.css`, `session.js`, `widgets.js`, `chart.js`, `ascii.js`. | Apache-2.0 |
| `packages/cli` | `hewn`: the CLI, the supervisor, setup, builders, the intake, backups, the visual check and its measures (`defects.ts`, which the bench uses too). The only package published to npm. | AGPL |
| `packages/test-host` | The core on Node for fast tests: `node:sqlite`, a blob directory, capability code run in-process with no isolation. Never shipped. | AGPL |

Integration tests are in `test/`. Example tools are in `seeds/`.

## The core

`packages/core/src/platform.ts` holds `Platform`, the one object every surface calls. It never touches a filesystem, process or socket; a host gives it ports (`ports.ts`):

| Port | What | workerd host | test host |
| --- | --- | --- | --- |
| `Sql` | the owner's database, synchronous | DO `storage.sql` | `node:sqlite` |
| `Blobs` | versions, owner icons, screenshots | the `disk` service | a directory |
| `CapabilityRuntime` | invoke, describe, migrate, copy and drop state, dump and count it | CapabilityHost + facets | in-process |
| `Workbench` | build workspaces: open, run a builder, bundle, read back, visual check | the supervisor | local (`packages/cli/src/workbench.ts`) |
| `SecretStore` | capability secrets and model keys | AES-256-GCM rows in the owner's database | memory |

Every authority check happens in the core, not in the MCP or HTTP layer, so every way in gets the same answer.

`Platform` is a facade: each public method hands its call to a domain in `packages/core/src/platform/`, one module each.

| Module | What |
| --- | --- |
| `discovery.ts` | `list` and `get`: the capabilities a principal can see |
| `presentation.ts` | a tool's name, icon, hue and saturation as the owner sets them |
| `data.ts` | a tool's lifecycle and data, owner only: delete (archive) and restore, rollback, purge, export and import, its rows per table, Start over (the data emptied, a copy kept aside first, the sample data replayed when asked); the code browser's view of a version: each file against the version its build started from (after a Restore, the restored one, not the one before) |
| `grants.ts` | readiness, grants, secrets and config, delegated agents, the owner's confirmation of agents' destructive calls |
| `connections.ts` | Accounts: a connection's sign-in step and health |
| `sessions.ts` | tool UI tickets and sessions, web sessions, the public URL, passkeys |
| `models.ts` | the owner's providers, tiers, budget and prices, and the model port |
| `invocation.ts` | `invoke` through the contract, and the call log |
| `widgets.ts` | running widgets, and Home's layout |
| `schedules.ts` | schedules, and the ones the owner approves with a build |
| `builds.ts` | builds: requests, the order they run in, the builder's attempts, retries, cancels, the owner's review, what a build keeps |
| `validation.ts` | `validate` (a build's candidate checked, nothing promoted) and `promote` ([Builds](#builds)); `validateAndPromote` is the two in a row |
| `sharing.ts` | a tool as a file, owner only: Share… (a version's files, the scan, the bundle), Install from a file (staged and checked, read by the owner's builder (the intake's `summarize`), then a create build with no builder, `bundle`, through the normal validation), and sample data (replayed after an install or Start over, or written by the owner as a new version); the Hub's Official shelf, which the host hands over (`SurfaceHost.shelf`, read from the release's `seeds/`): its cards, a tool's page, code and images, and staging one to install |
| `attachments.ts` | what the owner attaches in the intake's box |
| `instructions.ts` | the owner's instructions for building |
| `housekeeping.ts` | the cleanup at start and daily, and the metrics aggregates |

Each extends `Domain` (`context.ts`): the ports, the event bus, the cache of loaded versions, and the lookups every domain makes (`activeManifest`, `loadVersion` …). A domain calls another domain's public methods through the facade (`this.platform.readiness()`), so a wrapper on a `Platform` method sees every call from another domain (a domain's calls to its own methods stay inside it), and reaches what `Platform` doesn't offer through `this.d` (`this.d.grants.offers()`). Settings a host or a test may change after start (`confirmWaitMs`, `logRetentionDays` …) stay on `Platform` and are read from it each time.

The lower-level modules sit next to `platform.ts`: `registry.ts` (the owner's database), `models.ts` (provider adapters, the catalog), `widgets.ts` (templates), `schedules.ts` (cadences, the store), `docs.ts` (Hewn's docs for `hewn_docs` and the intake: sections and search), `bundle.ts` (a tool as a file: a store-only zip with CRC32, the `hewn-bundle.json` sidecar, `sample/calls.json`, and the scan before sharing), `diff.ts` (a line diff and git-style hunks), `code.ts` (the code browser's files against a base: status, lines +n −n, one file's hunks) and the rest. `platform.ts` re-exports the domains' types and helpers, so hosts and tests import from `@hewntools/core/platform.ts` only.

**The Official shelf** is `seeds/` (`shelf.json`, and each tool's `.hub/` folder with its listing and card images, which never becomes part of a version). The supervisor reads it (`cli/src/shelf.ts`) and serves it to workerd (`/shelf/tools`, `/shelf/image`); the npm package carries it in `dist/seeds/`. `test/e2e/hub-shots.ts` makes the card images.

Principals (`auth.ts`): `user` (the owner, from the web client or the CLI), `agent` (an MCP client), `ui` (a tool's own UI, limited to that tool), `capability` (a `ctx.call`), `schedule` and `widget`.

## The workerd host

`hewn serve` runs one workerd process. The supervisor writes its config (`packages/cli/src/supervisor/index.ts`) and bundles the Worker from `packages/host-workerd/src/worker.ts`:

- **Default fetch** routes every request on the local socket (`127.0.0.1:<port>`, default 7717) to the owner's `HewnDO`.
- **`Public`** serves a second socket (port + 1) for a tunnel or reverse proxy. It rate limits per client and in total, marks requests public and passes them on. Public requests reach only `/mcp` and the OAuth endpoints, plus the web client and tool UIs on the owner's public URL if one is set (`hewn url`). With `HEWN_PROXY_SECRET` set, it takes only requests that carry the secret.
- **`HewnDO`** (one per owner) holds the core on the DO's SQLite, the HTTP surface (`src/surface/`), MCP sessions in memory, and the admin channel. It arms one DO alarm for the next due schedule.
- **`CapabilityHost`** (one per capability) loads a version's bundle with the Worker Loader and runs it as a DO facet with its own SQLite. `capability-main.ts` is the wrapper around every bundle: it builds `ctx` and talks back to the host. Tests and dry runs use scratch facets (`test:<build>`, `dryrun:<build>`); backups before a promotion are copies.
- **`Egress`** is every capability's `globalOutbound`. Its props carry the capability's approved hosts; anything else gets `403`.

Secrets are encrypted with a per-home master key held outside the data directory (Keychain on macOS, libsecret or a 0600 file on Linux, `master-key.ts`). The supervisor passes it to workerd through the environment.

The local socket answers only to loopback host names (`127.0.0.1`, `localhost`, `hewn.localhost`), against DNS rebinding.

## The supervisor

The supervisor (`packages/cli/src/supervisor/`) is the Node process behind `hewn serve`. It does what an isolate can't:

- builds the host bundle (or uses the prebuilt one in the npm package), writes the workerd config, and starts workerd inside the OS sandbox;
- watches `/health` and restarts workerd when it stalls (a capability in a CPU loop blocks the single-threaded workerd), and kills a workerd left behind by a dead supervisor;
- serves the workerd side of the `Workbench` port: workspaces, builders, bundling (esbuild and npm), the visual check;
- runs the intake, connects local agents (`setup/`), deletes blobs, takes and restores backups, and runs tunnels (`tunnel.ts`: cloudflared or `tailscale funnel`).

Both directions are token-authenticated (`HEWN_ADMIN_TOKEN` into workerd, `HEWN_SUPERVISOR_TOKEN` back out). The CLI talks to the running Hewn as the owner through the admin channel (`/_admin/call`, an allow-list of core methods), and to the supervisor through its own control channel for machine-level work (backup, restore, status). Both tokens are in `supervisor.json` in the home. When Hewn isn't running, the CLI says so.

`hewn service` installs the supervisor as a launchd agent (macOS) or a systemd user unit (Linux).

## Builds

Every change to a capability is a build, run by a platform builder: Claude Code or Codex, chosen by the owner, or the host's own builder (`remote`, below). An agent asks (`capabilities_create`, `capabilities_modify`, `capabilities_add_widgets`) or the owner does from the web client; nobody hands in code directly. `hewn install <dir>` is a build with a copy builder.

```text
request → build row ("waiting" while its `after` build hasn't promoted, or, for a change or widgets build,
                     while an earlier change to the same capability is open or building: it starts when that
                     one ends, however it ends, or goes to review; `queued` in the build view)
  → workspace: a skeleton or the active version, plus BUILDER.md (the brief) and PLATFORM_UI.css
  → up to maxBuildAttempts (default 3): run the builder, then validate;
    a failed validation goes back to the builder as feedback
  → promoted, review, failed or cancelled
```

**Instructions** are the owner's standing rules for building: lines in `platform_kv` (`instructions:global`, `instructions:<capabilityId>`), owner-only (`instructions`, `setInstructions`; the web client edits them under Settings › AI and a tool's Info). The intake gets them in its prompt and may add to or drop them (`remember`, `forget` in its reply, applied by `applyIntakeMemory` as the surface hands the reply back; the client shows what was saved, with Undo). A build snapshots them when it's opened (`build_context.instructions`, as the "Owner's instructions" section of `BUILDER.md`, after the request and before the contract, so the contract has the last word), so the host's builder gets them too. Purging a tool drops its rules with it.

What led to a build stays with it for the capability's life: `build_context` holds the owner's conversation with the intake (the web client sends it as `conversation` with the request; an agent's build carries only its request), the owner's instructions it ran with, and a short hash of the brief it ran on. When the build ends, the builder's transcript is copied from the workbench into blobs (`transcripts/<buildId>.log`). Both are the owner's (`buildContext`, `buildTranscript`): agents never see them, since they show source. A version knows its build (`capability_versions.build_id`), so the web client shows them per version, and "Continue from here" gives the intake that conversation as `earlier` context.
What led to a build stays with it for the capability's life: `build_context` holds the owner's conversation with the intake (the web client sends it as `conversation` with the request; an agent's build carries only its request), the owner's instructions it ran with, and which brief it ran on (the spec's version and a short hash of its text, e.g. `2.3.2+a1b2c3d4e5f6`). When the build ends, the builder's transcript is copied from the workbench into blobs (`transcripts/<buildId>.log`). Both are the owner's (`buildContext`, `buildTranscript`): agents never see them, since they show source. A version knows its build (`capability_versions.build_id`), so the web client shows them per version, and "Continue from here" gives the intake that conversation as `earlier` context.

**Attachments.** Images and text files the owner puts in the intake's box (paste, drop, Attach) are uploaded as they're added (`POST /api/attachments`: checked for type, size and an image's pixels; the bytes a blob under `attachments/<ref>`, the row in `attachments` with its conversation's session). A message carries refs; the platform resolves them (what they are comes from the store, never the client) when it hands the conversation to the intake (with the bytes: `messages[].attachments[].data`) and when it keeps it with a build (`checkConversation`). A build claims its conversation's attachments (`build_id`), copies them into the workspace under `attachments/` and lists them in `BUILDER.md`'s request; `versionFiles` never takes that directory. Unclaimed attachments go after a day (`cleanup`); a purge removes a build's. Agents never see them.

**Build feedback.** Once a build is live, the web client asks "Got what you asked for?" when the tool is next opened, once per version in that browser and within a week of the build (`build_feedback`: yes, no with a note, or skip; `setBuildFeedback`, owner session only, shown with `buildContext`). `buildReport` (`hewn feedback`, an admin call; the host's only way in, and read-only) lists recent builds with what they ran on (builder, model, brief hash), attempts, how they ended, the answer, and the signs in the record: a failed build whose retry went live, another change to the tool within a day of going live, a restore within a week, the tool deleted within a day. All of it stays in the owner's database (the service log notes the score, never the note); Hewn never sends it anywhere. A host that wants it reads it as it reads anything else in the machine.

**A tool as a file** (`bundle.ts`, `platform/sharing.ts`). `<id>.hewn.zip` is a version's files as they are (what `versionFiles` keeps) plus a sidecar (`hewn-bundle.json`: the format, the Hewn and ABI that made it, the tool, version and hash it came from and, from Hewn's own shelf, Hewn's reading, trusted only when Hewn staged it from the shelf; a file's own is ignored), in Hewn's own store-only zip (the core runs where `node:zlib` doesn't). Reading one refuses compressed entries, entries out of order or overlapping, more than 1,000 files or 5 MB, a name twice (exactly, case-folded or NFC-normalised), and names with `..`, a leading `/`, a backslash or control characters. Share… scans the files first (`scanFiles`): personal data, key shapes and the owner's own settings warn; the owner's own keys block, and are never sent back whole. An upload is staged (`bundles/<token>.zip` in the blobs, kept a day) only once its manifest, sidecar and npm dependencies (registry versions only, no `.npmrc`: `dependencyProblems`) check out, so the install sheet can show it and the owner's builder can read it (the intake's `summarize`) before anything is installed. Installing it is a create build whose builder is `bundle` (no builder runs), through the validation below. The manifest's `source` (ABI 2.5) comes from the capability's record (`capabilities.source`, or, for its first version, the request of an install build, the only build whose `source` is trusted); validation stamps it on every version, so a builder can't change or drop it. Sample data replays after an install with sample data, or a Start over, through `Validation.replayCall`: the contract, with no hosts, no other tools and no model.

The brief is [`spec/builder-brief.md`](../../spec/builder-brief.md), with the request and the owner's other capabilities appended.

`validateAndPromote` (`platform/validation.ts`), in order. Steps 1 to 6 are `validate`, which changes nothing about the tool and returns the `Candidate` (its files and bundle, its UI rendered, with the measured defects when asked); 7 and 8 are `promote`, which may come later or not at all:

1. the manifest: the platform's own fields stamped first (`stampSource`: `source` from the capability's record, or on an install from a file the install's; a builder's `hub` and `minVersion` removed), then schema, id, ABI, kind, connection and widget rules, `ui/index.html` when `ui.available`
2. bundle `src/index.ts` with its npm dependencies (imports resolve inside the workspace only, links followed, and take no import attribute but `type: "json"`; npm runs on the machine, outside the builder sandbox, so every build asks it for registry versions only and carries no `.npmrc`: `dependencyProblems`, checked on the whole workspace and again by the workbench before npm starts); the bundle exports every declared `name@version`
3. contract compatibility with the active version; a widgets build changes only widgets; declared callees offer the pinned operations
4. migrations are append-only and non-destructive
5. `tests/cases.json` on fresh state through the real runtime; the sample data (`sample/calls.json`) replays on another fresh state with nothing granted (no network, other tools or model); every widget has a case; the UI renders headlessly without errors, in light and dark, at 1280 and 390 px wide, on an empty state and, with sample data, again on the sample's (that screenshot is the one the build page shows, and the candidate keeps the four whole-page images); changed widgets render in every size, from what each shows on the sample's state when there is one, else from its test case. A render that fails keeps its screenshot and logs "(screenshot attached", the line `buildView` reads, so the owner sees what broke
6. migrations dry-run on a copy of live state
7. freeze the version; an agent's change to a connection, or one that adds operations, stops here as `review` until the owner approves it
8. back up live state, migrate it, promote (an install from a file records where it came from, `setSource`, the record later versions are stamped from), and drop grants the new version no longer asks for; a quick change (manifest only, builder `keep`) keeps the owner's declines for what it still asks for; then an install's sample data replays on the live state when the owner asked (`afterInstall`; a failed call is noted, the tool stays)

A failed build leaves the active version serving. A build whose base is no longer the active version fails with `conflict`. Builds interrupted by a restart are retried once at start. A build with no builder (an install from a file, the owner's own edit) is never retried: the owner installs or saves again. A build's request keeps only the fields its kind takes (an agent's arguments arrive as it sent them); a retry's marks (`retryOf`, `autoRetryOf`) are Hewn's, and so are `source` and `sample`, trusted only on an install from a file (builder `bundle`). The compatibility rules are in [Writing a tool](../../spec/tools.md#changing-a-published-operation).

**The CLI agents** (`packages/cli/src/builders/cli-agents.ts`). One descriptor per coding-agent CLI Hewn runs (Claude Code, Codex, OpenCode): its names (builder name, harness id, label, binary), how to install and sign in, whether it's signed in, its model list, where a build's home lives, its builder and its intake. The builder wiring (`BUILDERS`), the intake (`cliIntake`), setup's tool status, the harness list, the workbench's cleanup and the model catalogs read it; another agent is one more entry, with its run functions in `cli.ts` and `intake.ts`. (The sandbox profile and the activity formatters still name agents themselves.)

**The builder sandbox** (`packages/cli/src/builders/`). Builders run headless in the OS sandbox: Seatbelt on macOS, bubblewrap on Linux. They can't read the Hewn home except their workspace, can't read the owner's repos or credential stores, and can write only the workspace, temp and their own state. Their environment is cut down to the basics and their own model settings. Each runs on however its CLI is signed in (a subscription, an API key or a cloud provider):

- Claude Code gets a config directory of its own per build holding only the model login, with settings, hooks, slash commands and the owner's `~/.claude` left out, and runs `--restricted` (no code-running tools) on top of its file-tool allow-list.
- Codex gets its own `HOME` and `CODEX_HOME` per build holding only `auth.json` for the run (and the build's thread between attempts).
- OpenCode gets its own `HOME` per build with its XDG config, data, cache and state directories under it (`opencodeHome`): its provider logins (`auth.json`, never `mcp-auth.json`) for the run, a config Hewn writes (updates and session sharing off, the owner's `provider` section carried over from `opencode debug config` so a custom or local provider is there), its plugin SDK install copied from the owner's `~/.config/opencode` (it would otherwise install it from npm on every fresh home), and the rules as `OPENCODE_CONFIG_CONTENT`: file tools only (`permission` and `tools`: no shell, web, subagents, skills or questions; the intake gets `webfetch` instead of `edit`, and reading a shared tool gets nothing at all). The inline config outranks a project `opencode.json` the builder could write, and `OPENCODE_DISABLE_PROJECT_CONFIG` / `OPENCODE_DISABLE_CLAUDE_CODE` keep project and `~/.claude` files out. `opencode run` talks to its server in-process (no loopback). Before a run with a chosen model, `opencode models` in that home must list it: a model OpenCode can't resolve hangs `opencode run` rather than failing it (1.18.18), and a run that says nothing for three minutes is stopped as "never started".

A refreshed login is copied back. Versions never keep builder configuration (dotfiles, `CLAUDE.md`, `AGENTS.md`, `opencode.json`), so a build can't plant it for the next one; the platform itself writes `AGENTS.md` into every workspace (where the brief is, and the owner's instructions) for builders that read it on their own. On Linux, bubblewrap shares loopback with the host, so a builder can reach local ports; on macOS it can't, except the port of a local model server named in the owner's OpenCode provider config (`allowLoopback`: that port only).

**Attempts resume.** A failed validation doesn't start the builder over: the next attempt resumes the first one's session with the failure (`resumePrompt`), so the brief isn't re-read and the candidate not rewritten. Claude Code: `--session-id` on the first attempt, `--resume` after. Codex: its thread id from `thread.started`, `codex exec … resume <id>`. OpenCode: the `sessionID` on every event, `opencode run -s <id>`. Each builder keeps its session in the build's own home (`builder-home/<builder>/<buildId>`): only the login file goes after each run, the directory goes with the workspace, and no other build's sandbox can read it. The sessions are known to the running process only; after a restart, or when a resume fails before the builder used any tool, the attempt starts fresh (a resume that fails after is a failed attempt: the workspace may be half-changed). The host's builder gets `session` (the build id) with every attempt and may do the same.

**The visual check** (`packages/cli/src/visual.ts`) renders a candidate UI, or a sheet of its changed widgets, in a local Chromium over the DevTools protocol (`launchBrowser`, which the bench drives too), with the UI's API running the candidate on scratch state. The UI renders on a desktop screen (1280 × 800: the build page's screenshot, light and dark) and on a phone (390 × 844, touch, 2×), each also as the whole page in light and dark (`shots`, four images). Uncaught errors, console errors and failed requests on either screen fail the build (a phone-only one says so); alert, confirm and prompt are dismissed, and a call the page blocks fails after 60 s. With `measure`, it also returns what to fix (`defects.ts`: what sticks out past each screen's edge, text cut short, page errors, controls that break the page when clicked). It is skipped when no browser is found.

## Intake

The intake (`packages/cli/src/intake.ts`) is the first half of the job the web client calls "Builds tools" (settings: `intake`; one agent does both halves in the web client). It turns the owner's rough request into a draft: questions back (until the request is clear: the prompt names what it must know before drafting, per mode, and each question carries a default; there is no cap on rounds, the owner's "Draft now" in the web client is the stop), a create or modify draft with a presentation-only spec, widget proposals, suggested schedules, or up to 5 ideas to pick from. A question about Hewn itself gets an `answer` instead, nothing to build: when the owner's latest message reads like a question (a `?`, or a question word first), the prompt carries the best sections of Hewn's docs for it (`docExcerpts`, about 9 KB), and the web client keeps the answer in the conversation like a question round. It is Claude Code, Codex or OpenCode, run headless by the supervisor in the builder sandbox with a throwaway workspace and no MCP (Claude Code with `--restricted` and the web tools only; OpenCode with `webfetch` only), returning strict JSON (Codex through `--output-schema`; the others as the reply's text, which `parseIntake` reads leniently). The prompt goes in on stdin (one argument is capped at 128 KiB on Linux): to Claude Code as a stream-json user message, with attached images as image blocks; to Codex as `-` (images as `-i` files); to OpenCode as its message (images as `-f` files); the host's intake gets it in the request, with `attachments`. Attached text files are in the prompt itself, under the message they came with. Agents don't use it: they structure their own requests. A draft may start with a connection, which the web client builds first and then builds the draft `after` it.

A third mode, `summarize`, reads a tool someone shared before it's installed (`POST /api/bundles/<token>/summary`, streamed like the chat): no conversation, no docs, and no tools at all (Claude Code with `--tools ""` and two turns; OpenCode with every permission denied; Codex without its shell or web search), since the code is in the prompt and the code may try to steer it. The prompt carries the manifest's asks as quoted values and the files (`summaryInput`: text files with numbered lines, manifest, migrations and code first, at most 40 KB of each and 200 KB in all as sent; what was left out or cut short is named) between marks made new per reading, and says plainly that text in them is part of the tool, a finding to report, never an instruction. The reply (`SUMMARY_SCHEMA`: `message`, `keeps`, `reaches`, `findings` with a file and line) is checked and cut to size by `readSummary` and kept with the staged file, then with the install's build. The client stops a reading it no longer wants (`DELETE …/summary`, or dropping the file), and one that ends after that isn't kept. A bundle's `hewn-bundle.json` may carry Hewn's own reading, but only one from the Hub is read (and checked the same way): a file's or a link's could say anything.

## Models for building, and the cap

A build runs on a model and effort: what the requester asked for, else the owner's setting for that builder (`jobModels` in the settings, per job and per agent). The owner may ask for anything; an agent only for names the owner ticked (`agentModels`), checked in the core (`modelFor`, `platform/builds.ts`). The builder passes them to its CLI (`--model`/`--effort`, `-m`/`model_reasoning_effort`, `-m provider/model`/`--variant`), reports the model it ran on when its CLI says (Claude Code's `init` event; OpenCode's events don't name it, so a build on Default records no model there), and when the CLI won't run the model, fails the build at once (`modelUnavailable`: "Model not available", no retries) instead of building on another. The lists in Settings › AI come from the CLIs (`packages/cli/src/builders/models.ts`: `codex debug models`, `opencode models --verbose` in the owner's own OpenCode, Claude Code's families). At most 5 builds run at once (`MAX_RUNNING_BUILDS`); the rest wait in order.

## The host's builder (`remote`)

With `HEWN_BUILD_URL` (and `HEWN_BUILD_TOKEN`, `HEWN_BUILD_NAME`), the supervisor adds a builder and an intake that run on the host's service and model keys, and makes them the default: the host can run builds on separate short-lived machines, so its Hewn holds no model key. They sit behind the same `CapabilityBuilder` and `Intake` contracts: validation, tests and promotion stay in Hewn. A refusal (over quota) fails the build at once with the service's reason. The protocol: [remote-builder.md](remote-builder.md).

## Hosted mode (`HEWN_HOSTED`)

With `HEWN_HOSTED=1` (which needs `HEWN_BUILD_URL`; `hostedFromEnv` in the supervisor), a host runs Hewn for an owner who has no terminal. The workerd host gets `HOSTED` and `HOST_SIGNIN_URL` and gives the surface `host.hosted` instead of `setup` (local agents) and `tunnel`. Signed-out pages, `/approve` and the OAuth approval page send the owner to the host's sign-in link instead of a command; `/api/settings` adds `hosted: true` and always reports the host's builder and intake (another can't be stored), and the web client hides the builder choice, the first run's builder step, Remote access set-up, the sandbox and backup folder settings, and the upgrade command. The admin channel stays: it's how the host runs `hewn open --print`, `hewn backup now` and `hewn status` in the machine. Agents' OAuth, scopes and grants are unchanged.

Tools' model calls, hosted: the platform gets `hostModels` (`PlatformOptions`), so `modelProblem` needs no provider or key and `ctx.model.generate` goes to `hostModelHandler`: the request is checked as for a provider, sent through the supervisor (`/models/generate`, which holds the host's token) to the host's `/v1/generate`, and the reply's JSON is checked against the schema. Calls are logged in `model_calls` at $0, outside the USD caps; what the host charges (builds, intake turns, model calls) goes to `host_charges`, summed per unit for Settings › AI › Models.

## Failed calls ("Ask builder to fix this")

A failed call (inside `execute`, or a result withheld for carrying a stored secret) is also noted under `failures:<id>` in `platform_kv`: the last ten, with caller, operation, error, the reduced input and last log lines (see [security-and-authority.md](security-and-authority.md#failed-calls-for-ask-builder-to-fix-this)). The web client offers a Change from them: on the tool's page when `session.js` posts `failed` (only that; the client reads the record), in Info's Run view, in a widget's menu and on a schedule's failed run. Calls refused before they run (not ready, a confirmation pending) aren't the tool's bug and aren't noted.

## Web client and tool UIs

The web client (`packages/host-workerd/web/`) is plain ES modules and DOM APIs with a strict CSP: no inline script, no HTML sinks (`test/web.test.ts` checks). It lives at `http://hewn.localhost:<port>` and, when the owner sets a public URL, on that host through the public socket.

- **Sign-in:** `hewn open` hands the browser a single-use ticket that becomes an HttpOnly, `SameSite=Strict` session cookie (`web_sessions`, hashed, sliding 30 days). On the public URL the cookie is `__Host-` and `Secure`, and the owner can add passkeys (WebAuthn, verified in the core: `webauthn.ts`).
- **API:** JSON under `/api/*` (`surface/web.ts`). It refuses cross-site requests and requires `X-Hewn-UI` on writes. Build progress streams as SSE. The Inbox (`/api/inbox`) gathers what needs the owner.
- **Code:** native ES modules, no bundler or build step. `index.html` loads `app.js`, which loads the router (`app/router.js`); the router imports the pages. Each section of the client is one module in `app/` (the page frame, the Inbox, the command palette, Home, a tool's page, the intake, a build, Activity, Agents, Settings…); `kit.js` is the toolkit they share. Modules import each other's functions freely: the cycles are safe because no module's top level reads another app module's binding (a top level defines things; the theme, the page frame and the Inbox also set up their own elements and listeners). Hewn's own pixel glyphs (`glyphs.js`: the Inbox's bell, the palette's actions and places) import only the kit, so the modules sharing them can use them anywhere. The router starts the client at its end, once every module has loaded. State shared between modules has one owner that exports it: the page frame owns the platform `settings` (the others assign it through `setSettings`: an import is read-only), the current screen's cleanups (`leaving`) and its shortcuts (`keyHandlers`); `inbox.js` owns the Inbox's button and panel. `WEB_CODE` (`surface/web.ts`) names every file, for the fingerprint an open page uses to notice an upgrade.

A tool UI is served at `/tools/<id>/~<key>/` on the same host, where the key is random per capability; any other path under `/tools/<id>/` answers 404 (`surface/ui.ts`). Every response carries a CSP `sandbox` without `allow-same-origin`, so the page runs on an opaque origin with no cookies or storage. The owner opens it with a ticket; the page gets a token bound to that one capability in its URL fragment, which `session.js` keeps for the tab and attaches to the UI's own API calls. The UI calls `POST api/invoke` as `ui:<id>`, limited to its own capability.

## Agents and MCP

The MCP server (`packages/host-workerd/src/mcp.ts`) offers exactly the tools in [`spec/src/agents.ts`](../../spec/src/agents.ts), filtered by the agent's scopes; [Connecting an agent](../../spec/agents.md) is the full contract.

- **Sign-in:** Hewn is its own OAuth 2.1 server (`core/agents.ts`, `surface/oauth.ts`): dynamic client registration, PKCE S256 only, rotating refresh tokens, revocation. Every token is stored as a SHA-256 hash. The owner approves each agent in the web client or with `hewn agents approve <code>`, and may narrow its scopes and limit it to some capabilities.
- **Sessions** (`surface/mcp-sessions.ts`) are stateful and held in memory by `HewnDO`. When an agent's tool list changes (capabilities, readiness, its scopes), its sessions get `tools/list_changed`. A restart drops them, and clients initialize again.
- **Discovery:** the server instructions and the descriptions of `capabilities_list` and `capabilities_invoke` carry a catalog of the capabilities the agent can see. Agents never see source, state, schemas of the state, version numbers or build workspaces.
- **Hewn's docs:** `hewn_docs` (any scope) lists, searches and reads the user docs and the spec (`docs/*.md`, `spec/*.md`; the list is `DOC_PAGES` in `core/docs.ts`, which also cuts pages into sections and scores them by term). The host serves the pages like the web client's files, as assets (`docs/<page>.md`, `spec/<page>.md`: the `assets-docs` and `assets-spec` disk services on workerd, `sourceAsset` on Node; only top-level pages, never `docs/internal/`); a checkout reads them from the repo, the npm package from `dist/docs/`. Each host reads them once (`docsReader`), and again next time if some were missing.
- **Local agents** are connected by `packages/cli/src/setup/`: it registers the MCP address with the agent's CLI, runs the CLI's own OAuth sign-in, and adds a one-line pointer to the agent's instruction file, since some agents don't look at MCP servers unprompted.

Destructive operations called by an agent wait for the owner's confirmation (`confirmations`), up to 60 seconds, then return `awaiting_confirmation`.

## The capability runtime

Each promoted version is one ESM bundle run in a V8 isolate against the ABI ([Capability ABI](../../spec/capability-model.md#capability-abi)). `runtime` has one profile, `isolate`.

- **State:** `ctx.db` is the CapabilityHost's private SQLite, synchronous. Migrations are tracked in `_hewn_migrations` in that database.
- **Network:** `fetch` goes through `Egress`.
- **Calls:** `ctx.call` goes back to `HewnDO`, which checks the [grant](../../spec/capability-model.md#grant), then runs the callee in its own isolate. A chain nests at most three deep, refuses cycles, and shares one deadline (30 s; time waiting on a model is added back, up to 120 s per chain; `core/deadline.ts`).
- **Isolation:** no filesystem, processes or environment; workerd itself runs in the OS sandbox.
- **Versions** are content-addressed blobs (`versions/<sha256>.json`: files and bundle), verified by hash when loaded.

A capability is ready when every grant its manifest asks for is approved and every secret and config value is set. Until then calls fail with `not_ready`. The owner may say no to a host, capability or model grant (Deny, `grant_declines`, per version): it stays unapproved and nothing asks for it again until a new version. When that's all a capability lacks, `Readiness.onlySaidNo` is set: Home and the Inbox leave it alone, and agents' access requests are refused. Only a [connection](../../spec/capability-model.md#connection) may hold secrets; other capabilities reach a service through its operations.

## Schedules

`core/schedules.ts`. The owner adds schedules, or an agent proposes one (`schedules_propose`) for the owner to enable. They run as `schedule:<id>`, read and write operations only, on cadences like `daily 07:00` or cron in the owner's time zone, and pause after 3 failures in a row. The owner can run one now (Try again, `POST /api/schedules/:id/run`): it doesn't count toward pausing, and a success clears the failures and why a paused one paused (it stays paused). On workerd one DO alarm fires for the next due schedule.

## Widgets

A widget is a read operation whose output is a view model for one of five templates (`core/widgets.ts`: `stat`, `list`, `chart`, `progress`, `text`), declared in the manifest ([Widgets](../../spec/tools.md#widgets-since-23)). `Platform.widget` runs it read-only: `ctx.db` refuses writing statements before they run, secret updates are dropped, every call down the chain is limited to read operations, and there is no model. Views are checked against their template and cached per widget and input (`widget_cache`).

- **Home** stores its layout in `platform_kv` (`home:layout`) and draws widgets with `/_platform/widgets.js`.
- **Agent chats** get them through `widgets_show`, whose result is drawn by the MCP Apps resource `ui://hewn/widget` (`surface/widget-app.ts`: a self-contained page with the UI kit inlined).

## Models

The model port (`core/models.ts`, and `core/platform/models.ts`) runs language models for capabilities that declare `requires.model`. Capability code never holds a key or a provider host: it calls `ctx.model.generate`, and the core checks the request, reserves budget, calls the provider from the host, and settles the cost.

- Providers: Anthropic, OpenAI, OpenRouter. The owner's API keys are secrets (`hewn:models`); the owner maps tiers (`light`, `standard`, `strong`, `max`) to models and sets a monthly budget, overall and per capability.
- Prices and image support come from the provider's model list and the OpenRouter catalog. Every call is logged in `model_calls`.
- A pinned model the provider retires makes the capability not ready, with a suggested successor.

## Storage

The home is `~/.hewn` for an npm install and `data/` in a checkout run with `./install.sh` (`HEWN_HOME` overrides; `packages/cli/src/app-dir.ts`).

- `workerd/do/hewn-owner/`: the owner's database.
- `workerd/do/hewn-capability/`: each capability's state, plus scratch states (tests, dry runs, the 3 newest backups taken before a promotion).
- `workerd/blobs/`: version blobs, owner icons, build screenshots, build transcripts, the owner's attachments.
- `builds/`: workspaces (deleted a day after the build ends) and transcripts (copied into blobs when the build ends; the copy here goes after 30 days).
- `builder-home/`: the builders' and intake's own config directories.
- `platform.json`: machine settings (backup folder, `publicListen`, sandbox). `supervisor.json`: the running supervisor's address and tokens. `format.json`: the data format version. `logs/hewn.log`: the service log.
- Backups: nightly zip files of consistent SQLite snapshots plus blobs, never the secrets key (`backup.ts`, `zip.ts`), in `<home>-backups/` or the owner's backup folder; 7 daily and 4 weekly are kept.

The owner's database:

- **Capabilities:** `capabilities`, `capability_versions`, `config_values`, `capability_logs`, `widget_cache`, `platform_kv` (the Home layout, model settings, the public URL), `settings` (the owner's settings from the web client).
- **Builds:** `builds` (kind `create`, `modify` or `widgets`; status `waiting`, `open`, `building`, `validating`, `review`, `failed`, `promoted` or `cancelled`), `build_models`, `build_charges`, `build_context` (the conversation, instructions and brief hash a build ran with), `build_feedback` (the owner's answer to "Got what you asked for?").
- **Builds:** `builds` (kind `create`, `modify` or `widgets`; status `waiting`, `open`, `building`, `validating`, `review`, `failed`, `promoted` or `cancelled`), `build_models`, `build_charges`, `build_context` (the conversation, instructions and brief id a build ran with).
- **Capabilities:** `capabilities`, `capability_versions`, `config_values`, `capability_logs`, `widget_cache`, `platform_kv` (the Home layout, model settings, the public URL, the owner's instructions under `instructions:global` and `instructions:<id>`, failed calls under `failures:<id>`), `settings` (the owner's settings from the web client).
- **Builds:** `builds` (kind `create`, `modify` or `widgets`; status `waiting`, `open`, `building`, `validating`, `review`, `failed`, `promoted` or `cancelled`), `build_models`, `build_charges`, `build_context` (the conversation, instructions and brief hash a build ran with).
- **Agents and sessions:** `agents`, `oauth_clients`, `oauth_requests`, `oauth_tokens`, `web_sessions`, `ui_sessions`, `passkeys`.
- **Authority:** `grants` (kinds `secret`, `host`, `capability`, `model`), `grant_declines` (what the owner said no to, and for which version), `access_requests`, `confirmations`, `secrets_enc`.
- **Trail:** `grant_events`, `lifecycle_events`, `authority_events`, `model_calls`. Activity merges them with builds and calls.
- **Schedules:** `schedules`.

Each capability's data lives only in its own database. `DATA_FORMAT` (`supervisor/format.ts`) gates changes to stored data: an older format is backed up and upgraded at start, a newer one is refused ([releasing.md](releasing.md#data-format-changes)).

## Installs and upgrades

There are two ways to run Hewn (`app-dir.ts`): the npm package `@hewntools/cli`, with the CLI bundled to `dist/cli.js` and the host prebuilt (`scripts/build-npm.ts`), or a git checkout run from TypeScript with `./install.sh`, which builds the host from the sources at start. `hewn upgrade` moves to the newest release in the same 0.x line (npm, or the newest tag for a checkout), then backs up and restarts. [releasing.md](releasing.md) covers cutting a release.
