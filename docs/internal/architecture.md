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
| `packages/core` | The platform logic: `Platform`, the registry, manifest and contract checks, migrations rules, auth, OAuth, schedules, widgets, the model port. Pure: no Node, no workerd. | AGPL |
| `packages/host-workerd` | What runs inside workerd: the Worker and its Durable Objects, the capability runtime wrapper, the HTTP and MCP surface, the web client (`web/`). | AGPL |
| `packages/ui` | The UI kit tool UIs load from `/_platform/`: `ui.css`, `session.js`, `widgets.js`, `chart.js`, `ascii.js`. | Apache-2.0 |
| `packages/cli` | `hewn`: the CLI, the supervisor, setup, builders, the intake, backups, the visual check. The only package published to npm. | AGPL |
| `packages/test-host` | The core on Node for fast tests: `node:sqlite`, a blob directory, capability code run in-process with no isolation. Never shipped. | AGPL |

Integration tests are in `test/`. Example tools are in `seeds/`.

## The core

`packages/core/src/platform.ts` holds `Platform`, the one object every surface calls. It never touches a filesystem, process or socket; a host gives it ports (`ports.ts`):

| Port | What | workerd host | test host |
| --- | --- | --- | --- |
| `Sql` | the owner's database, synchronous | DO `storage.sql` | `node:sqlite` |
| `Blobs` | versions, owner icons, screenshots | the `disk` service | a directory |
| `CapabilityRuntime` | invoke, describe, migrate, copy and drop state | CapabilityHost + facets | in-process |
| `Workbench` | build workspaces: open, run a builder, bundle, read back, visual check | the supervisor | local (`packages/cli/src/workbench.ts`) |
| `SecretStore` | capability secrets and model keys | AES-256-GCM rows in the owner's database | memory |

Every authority check happens in the core, not in the MCP or HTTP layer, so every way in gets the same answer.

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

Every change to a capability is a build, run by a platform builder: Claude Code or Codex, chosen by the owner. An agent asks (`capabilities_create`, `capabilities_modify`, `capabilities_add_widgets`) or the owner does from the web client; nobody hands in code directly. `hewn install <dir>` is a build with a copy builder.

```text
request → build row ("waiting" while its `after` build hasn't promoted)
  → workspace: a skeleton or the active version, plus BUILDER.md (the brief) and PLATFORM_UI.css
  → up to maxBuildAttempts (default 3): run the builder, then validate;
    a failed validation goes back to the builder as feedback
  → promoted, review, failed or cancelled
```

The brief is [`spec/builder-brief.md`](../../spec/builder-brief.md), with the request and the owner's other capabilities appended.

`validateAndPromote` (`platform.ts`), in order:

1. the manifest: schema, id, ABI, kind, connection and widget rules, `ui/index.html` when `ui.available`
2. bundle `src/index.ts` with its npm dependencies; the bundle exports every declared `name@version`
3. contract compatibility with the active version; a widgets build changes only widgets; declared callees offer the pinned operations
4. migrations are append-only and non-destructive
5. `tests/cases.json` on fresh state through the real runtime; every widget has a case; the UI renders headlessly without errors, in light and dark, and changed widgets render in every size
6. migrations dry-run on a copy of live state
7. freeze the version; an agent's change to a connection, or one that adds operations, stops here as `review` until the owner approves it
8. back up live state, migrate it, promote, and drop grants the new version no longer asks for

A failed build leaves the active version serving. A build whose base is no longer the active version fails with `conflict`. Builds interrupted by a restart are retried once at start. The compatibility rules are in [Writing a tool](../../spec/tools.md#changing-a-published-operation).

**The builder sandbox** (`packages/cli/src/builders/`). Builders run headless in the OS sandbox: Seatbelt on macOS, bubblewrap on Linux. They can't read the Hewn home except their workspace, can't read the owner's repos or credential stores, and can write only the workspace, temp and their own state. Their environment is cut down to the basics and their own model settings. Each runs on however its CLI is signed in (a subscription, an API key or a cloud provider):

- Claude Code gets a config directory of its own per build holding only the model login, with settings, hooks, slash commands and the owner's `~/.claude` left out.
- Codex gets its own `HOME` and `CODEX_HOME` holding only `auth.json`.

A refreshed login is copied back. Versions never keep builder configuration (dotfiles, `CLAUDE.md`, `AGENTS.md`), so a build can't plant it for the next one. On Linux, bubblewrap shares loopback with the host, so a builder can reach local ports; on macOS it can't.

**The visual check** (`packages/cli/src/visual.ts`) renders a candidate UI, or a sheet of its changed widgets, in a local Chromium over the DevTools protocol, with the UI's API running the candidate on scratch state. Uncaught errors, console errors and failed requests fail the build; the screenshots are kept. It is skipped when no browser is found.

## Intake

The intake (`packages/cli/src/intake.ts`) is the job the web client calls "Writes the spec". It turns the owner's rough request into a draft: questions back, a create or modify draft with a presentation-only spec, widget proposals, suggested schedules, or up to 5 ideas to pick from. It is Claude Code or Codex, run headless by the supervisor in the builder sandbox with a throwaway workspace and no MCP, returning strict JSON. Agents don't use it: they structure their own requests. A draft may start with a connection, which the web client builds first and then builds the draft `after` it.

## Web client and tool UIs

The web client (`packages/host-workerd/web/`) is plain ES modules and DOM APIs with a strict CSP: no inline script, no HTML sinks (`test/web.test.ts` checks). It lives at `http://hewn.localhost:<port>` and, when the owner sets a public URL, on that host through the public socket.

- **Sign-in:** `hewn open` hands the browser a single-use ticket that becomes an HttpOnly, `SameSite=Strict` session cookie (`web_sessions`, hashed, sliding 30 days). On the public URL the cookie is `__Host-` and `Secure`, and the owner can add passkeys (WebAuthn, verified in the core: `webauthn.ts`).
- **API:** JSON under `/api/*` (`surface/web.ts`). It refuses cross-site requests and requires `X-Hewn-UI` on writes. Build progress streams as SSE. The Inbox (`/api/inbox`) gathers what needs the owner.

A tool UI is served at `/tools/<id>/~<key>/` on the same host, where the key is random per capability; any other path under `/tools/<id>/` answers 404 (`surface/ui.ts`). Every response carries a CSP `sandbox` without `allow-same-origin`, so the page runs on an opaque origin with no cookies or storage. The owner opens it with a ticket; the page gets a token bound to that one capability in its URL fragment, which `session.js` keeps for the tab and attaches to the UI's own API calls. The UI calls `POST api/invoke` as `ui:<id>`, limited to its own capability.

## Agents and MCP

The MCP server (`packages/host-workerd/src/mcp.ts`) offers exactly the tools in [`spec/src/agents.ts`](../../spec/src/agents.ts), filtered by the agent's scopes; [Connecting an agent](../../spec/agents.md) is the full contract.

- **Sign-in:** Hewn is its own OAuth 2.1 server (`core/agents.ts`, `surface/oauth.ts`): dynamic client registration, PKCE S256 only, rotating refresh tokens, revocation. Every token is stored as a SHA-256 hash. The owner approves each agent in the web client or with `hewn agents approve <code>`, and may narrow its scopes and limit it to some capabilities.
- **Sessions** (`surface/mcp-sessions.ts`) are stateful and held in memory by `HewnDO`. When an agent's tool list changes (capabilities, readiness, its scopes), its sessions get `tools/list_changed`. A restart drops them, and clients initialize again.
- **Discovery:** the server instructions and the descriptions of `capabilities_list` and `capabilities_invoke` carry a catalog of the capabilities the agent can see. Agents never see source, state, schemas of the state, version numbers or build workspaces.
- **Local agents** are connected by `packages/cli/src/setup/`: it registers the MCP address with the agent's CLI, runs the CLI's own OAuth sign-in, and adds a one-line pointer to the agent's instruction file, since some agents don't look at MCP servers unprompted.

Destructive operations called by an agent wait for the owner's confirmation (`confirmations`), up to 60 seconds, then return `awaiting_confirmation`.

## The capability runtime

Each promoted version is one ESM bundle run in a V8 isolate against the ABI ([Capability ABI](../../spec/capability-model.md#capability-abi)). `runtime` has one profile, `isolate`.

- **State:** `ctx.db` is the CapabilityHost's private SQLite, synchronous. Migrations are tracked in `_hewn_migrations` in that database.
- **Network:** `fetch` goes through `Egress`.
- **Calls:** `ctx.call` goes back to `HewnDO`, which checks the [grant](../../spec/capability-model.md#grant), then runs the callee in its own isolate. A chain nests at most three deep, refuses cycles, and shares one deadline (30 s; time waiting on a model is added back, up to 120 s per chain; `core/deadline.ts`).
- **Isolation:** no filesystem, processes or environment; workerd itself runs in the OS sandbox.
- **Versions** are content-addressed blobs (`versions/<sha256>.json`: files and bundle), verified by hash when loaded.

A capability is ready when every grant its manifest asks for is approved and every secret and config value is set. Until then calls fail with `not_ready`. Only a [connection](../../spec/capability-model.md#connection) may hold secrets; other capabilities reach a service through its operations.

## Schedules

`core/schedules.ts`. The owner adds schedules, or an agent proposes one (`schedules_propose`) for the owner to enable. They run as `schedule:<id>`, read and write operations only, on cadences like `daily 07:00` or cron in the owner's time zone, and pause after 3 failures in a row. On workerd one DO alarm fires for the next due schedule.

## Widgets

A widget is a read operation whose output is a view model for one of five templates (`core/widgets.ts`: `stat`, `list`, `chart`, `progress`, `text`), declared in the manifest ([Widgets](../../spec/tools.md#widgets-since-23)). `Platform.widget` runs it read-only: `ctx.db` refuses writing statements before they run, secret updates are dropped, every call down the chain is limited to read operations, and there is no model. Views are checked against their template and cached per widget and input (`widget_cache`).

- **Home** stores its layout in `platform_kv` (`home:layout`) and draws widgets with `/_platform/widgets.js`.
- **Agent chats** get them through `widgets_show`, whose result is drawn by the MCP Apps resource `ui://hewn/widget` (`surface/widget-app.ts`: a self-contained page with the UI kit inlined).

## Models

The model port (`core/models.ts`, and the models section of `platform.ts`) runs language models for capabilities that declare `requires.model`. Capability code never holds a key or a provider host: it calls `ctx.model.generate`, and the core checks the request, reserves budget, calls the provider from the host, and settles the cost.

- Providers: Anthropic, OpenAI, OpenRouter. The owner's API keys are secrets (`hewn:models`); the owner maps tiers (`light`, `standard`, `strong`, `max`) to models and sets a monthly budget, overall and per capability.
- Prices and image support come from the provider's model list and the OpenRouter catalog. Every call is logged in `model_calls`.
- A pinned model the provider retires makes the capability not ready, with a suggested successor.

## Storage

The home is `~/.hewn` for an npm install and `data/` in a checkout run with `./install.sh` (`HEWN_HOME` overrides; `packages/cli/src/app-dir.ts`).

- `workerd/do/hewn-owner/`: the owner's database.
- `workerd/do/hewn-capability/`: each capability's state, plus scratch states (tests, dry runs, the 3 newest backups taken before a promotion).
- `workerd/blobs/`: version blobs, owner icons, build screenshots.
- `builds/`: workspaces (deleted a day after the build ends) and transcripts (kept 30 days).
- `builder-home/`: the builders' and intake's own config directories.
- `platform.json`: machine settings (backup folder, `publicListen`, sandbox). `supervisor.json`: the running supervisor's address and tokens. `format.json`: the data format version. `logs/hewn.log`: the service log.
- Backups: nightly zip files of consistent SQLite snapshots plus blobs, never the secrets key (`backup.ts`, `zip.ts`), in `<home>-backups/` or the owner's backup folder; 7 daily and 4 weekly are kept.

The owner's database:

- **Capabilities:** `capabilities`, `capability_versions`, `config_values`, `capability_logs`, `widget_cache`, `platform_kv` (the Home layout, model settings, the public URL), `settings` (the owner's settings from the web client).
- **Builds:** `builds` (kind `create`, `modify` or `widgets`; status `waiting`, `open`, `building`, `validating`, `review`, `failed`, `promoted` or `cancelled`).
- **Agents and sessions:** `agents`, `oauth_clients`, `oauth_requests`, `oauth_tokens`, `web_sessions`, `ui_sessions`, `passkeys`.
- **Authority:** `grants` (kinds `secret`, `host`, `capability`, `model`), `access_requests`, `confirmations`, `secrets_enc`.
- **Trail:** `grant_events`, `lifecycle_events`, `authority_events`, `model_calls`. Activity merges them with builds and calls.
- **Schedules:** `schedules`.

Each capability's data lives only in its own database. `DATA_FORMAT` (`supervisor/format.ts`) gates changes to stored data: an older format is backed up and upgraded at start, a newer one is refused ([releasing.md](releasing.md#data-format-changes)).

## Installs and upgrades

There are two ways to run Hewn (`app-dir.ts`): the npm package `@hewntools/cli`, with the CLI bundled to `dist/cli.js` and the host prebuilt (`scripts/build-npm.ts`), or a git checkout run from TypeScript with `./install.sh`, which builds the host from the sources at start. `hewn upgrade` moves to the newest release in the same 0.x line (npm, or the newest tag for a checkout), then backs up and restarts. [releasing.md](releasing.md) covers cutting a release.
