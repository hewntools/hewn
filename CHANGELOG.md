# Changelog

Hewn follows semver for the CLI and your data: `hewn upgrade` stays within a 0.x line, and a new line (0.4 → 0.5) is a deliberate move. The tool contract (the ABI, [`spec/`](spec/README.md#versions)) is versioned separately as `major.minor`: minor versions only add, and a tool declares the lowest one it needs.

## 0.4.4 (unreleased)

- **For hosts: hosted mode** (`HEWN_HOSTED=1`, with `HEWN_BUILD_URL`; optional `HEWN_HOST_SIGNIN_URL`). For an owner who has no terminal: signed-out pages and agent approval send them to the host's sign-in instead of a command, the first run goes straight to making something (no "who builds" step), and Settings hides what the host manages. See [remote access](docs/remote-access.md#running-hewn-for-someone-else-hewn_hosted).

## 0.4.3 (2026-10-20)

- **Fixed:** with `HEWN_BUILD_URL` set, the host's builder and intake are the default again, also after you save another setting (saving a setting no longer stores the defaults of the others, and a builder stored that way that you didn't choose is dropped when Hewn starts).
- **The host's builder shows Hewn's icon** wherever a builder is shown, under the name the host gives it, and the "on the host's keys" notes are gone.
- **A widget's options can be changed** after it's on Home: **Options…** in its menu opens the form it was added with, filled in, with a preview.
- **Fixed:** Edit Home couldn't save (Done, + Add widget) when a widget's options no longer matched its tool after a change. A widget placed earlier now saves as it is and shows its error until you set new options.
- **The icon shows while the host's builder works:** the build service can send a file mid-build (`{ "file": … }`, see the remote builder protocol), so the tool's icon appears on Home and the build page as soon as it's written, not when the build ends.
- **The build page has the standard top bar** (Hewn, the tabs, Search and the Inbox), like other pages.
- **The intake says "Thinking…"** while the model thinks before it answers (Claude Code, and the host's intake when the service sends it).
- **Visual check as root:** when Chromium won't start because Hewn runs as root (a container), the skipped check says so and points to `HEWN_BROWSER` ([troubleshooting](docs/troubleshooting.md)).

## 0.4.2 (2026-10-20)

- **One choice for building.** Talking a request through and building it are one job now, "Builds tools", with one agent to pick (in the first run, Settings › AI and the command palette). The docs call them Hewn's two jobs: building tools, and thinking inside them.
- **Choose the model and effort for building.** Settings › AI lists what the agent offers: Default, a family that follows the newest (Claude Code's Fable, Opus, Sonnet, Haiku), or a pinned model (any Codex model, or a full Claude name), with an effort. Switching agent means choosing its model; Hewn remembers the last one for each. A model that's gone or misspelled stops the build (or the chat) at once with "… isn't available. Pick another model"; nothing is built on a model you didn't choose.
- **Change the model where you type:** the box where you describe a tool shows the model it builds with; its menu has the current model, an effort slider and the other models, and changes your setting.
- **Agents can ask for a model too**, on `capabilities_create`, `capabilities_modify` and `capabilities_add_widgets` (`model`, `effort`), but only one you tick under "Agents may ask for". Any other is an error naming the allowed ones, as is an effort the model doesn't take (naming its levels); nothing is built.
- **Each build says what it ran on**, on its page and in Activity ("Built with Claude Code · claude-fable-5-5 · high effort").
- **At most 5 builds run at once**; the rest wait their turn (and can be cancelled while they wait).
- **The build page** shows who asked, the builder, the model and the effort in one strip, and "Spec agreed" opens to the spec. Cancel build is in the card; a building tile or Inbox row opens its build.
- **The Inbox:** every row opens what it's about with one tap, and a schedule that stopped itself after failing (say a fetch whose service was down) shows there, so a widget doesn't go stale quietly.
- **Schedules say why a run failed,** with when, in the tool's own words ("Last run 3 h ago failed: NOAA is unreachable").
- **Reviewing an agent's change:** each new operation leads with its first sentence; the agent-facing rest is under "Full description".
- **Fixed:** authorizing a tool that uses a model failed ("keyBlock?.saveBudget is not a function") when a model key was already set.
- **About shows what's new** in a newer release, from the changelog, above the upgrade command.
- **For hosts:** with `HEWN_BUILD_URL`, Hewn's builder and intake run on the host's own service and model keys (a refusal, such as over a quota, says why and isn't retried; what the host charges for a build shows on its page and in Activity). The protocol is in [`docs/internal/remote-builder.md`](docs/internal/remote-builder.md).

## 0.4.1 (2026-10-19)

- **Linux and WSL: the secrets key stays where it is.** Hewn keeps its key in a keyring only when one actually answers `secret-tool`; WSL and servers have a session bus but no keyring, and installing `libsecret-tools` there made Hewn restart over and over ("Could not connect"). A home that already has `master.key` keeps using it, even if a keyring appears later. `hewn doctor` no longer suggests `libsecret-tools` on machines without a keyring.
- **`hewn doctor` checks Claude Code and Codex point at this Hewn.** An agent registered with another Hewn (another home on another port) is now a warning with the fix, instead of "Hewn registered".
- **A failed build says why everywhere.** The Inbox and Activity show the build's own reason ("1 of 3 tests didn't pass", or what stopped the builder), not just "The builder stopped".
- **Accounts shows a connection's health detail** ("expired · The session ended on 12 October").
- **Web client polish:** tool names on Home and widget titles wrap between words (with an ellipsis when they don't fit) and tiles line up; Home starts just under the top bar; bar charts scale to their data; a single call in Activity opens like a group does; the command palette lists name matches first; the passkey page fits a phone.
- **Hewn says what uses your account.** The proposal card says which agent builds it, on its own account (a subscription, an API key or a cloud provider); a build an agent asked for says so on its page and in Activity ("Codex asked · building with Claude Code, on your account"); Settings › AI says what each job runs on.
- **`hewn url --listen 0.0.0.0`** puts the public listener on every interface (a container, or a proxy anywhere on the network) instead of failing to bind next to the loopback one.

## 0.4.0 (2026-10-19)

The first public release. What's in it:

- **Tools of your own.** Each has typed, versioned operations, its own SQLite database, tests, and optionally its own screen and widgets. Every change is a new version, tested on a copy of your data before it goes live; restore an earlier one any time.
- **Built by your coding agent.** Describe a tool; the intake (Claude Code or Codex on your machine) asks what it needs to know and proposes it, and the builder writes it in a sandbox. A failed build says why and can be fixed with one click.
- **Every agent.** Claude Code, Codex, claude.ai, ChatGPT and any MCP client connect over OAuth. You approve each one and choose what it may do (see, use, make, change; all tools or some). Destructive calls wait for you. Widgets show right in the chat in clients that support MCP Apps.
- **Connections** to the services you use, holding their keys encrypted where no tool or agent can see them, with health checks and sign-in flows.
- **Models for tools that think,** with your own Anthropic, OpenAI or OpenRouter key, four tiers, and a monthly budget.
- **Schedules** in your time zone; agents can only propose them.
- **The web client:** Home with widgets, the Inbox for what needs you, Activity, a command palette, Settings, and a phone layout. Use it from anywhere with a public URL and passkeys.
- **Behind a proxy:** with `HEWN_PROXY_SECRET`, the public listener answers only requests that carry it ([remote access](docs/remote-access.md)).
- **Your data stays yours:** local first, nightly backups, export, and a threat model that says what's protected and what isn't.
- **Install** with `curl -fsSL https://hewn.tools/install.sh | sh` or `npm install -g @hewntools/cli`, on macOS, Linux and Windows (WSL). ABI 2.3.
