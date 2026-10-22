# Changelog

Hewn follows semver for the CLI and your data: `hewn upgrade` stays within a 0.x line, and a new line (0.4 → 0.5) is a deliberate move. The tool contract (the ABI, [`spec/`](spec/README.md#versions)) is versioned separately as `major.minor`: minor versions only add, and a tool declares the lowest one it needs.

## 0.4.7 (unreleased)

- **OpenCode builds tools, talks them through, and uses them.** Pick it under Settings › AI › Builds tools (or on the first run), on any provider it's signed in to (`opencode auth login`), on its free tier, or on a local model server from your `~/.config/opencode/opencode.json` (Ollama, LM Studio): Hewn lets the build reach that server's port and nothing else on your machine. Its models are listed as `provider/model`, with the model's own reasoning levels as efforts. It builds like the others: in a sandbox, in a home of its own (your provider logins for the run, never your config, plugins, sessions or MCP tokens), with file tools only, and a failed validation resumes its session. Connect it as an agent from Agents › Add… or `hewn setup --agents opencode`: Hewn registers itself in OpenCode's global config and `AGENTS.md`, then `opencode mcp auth hewn` signs it in. `hewn doctor` checks it. If it had no `~/.config/opencode/AGENTS.md`, it now reads that instead of `~/.claude/CLAUDE.md`.
- A build on a model OpenCode doesn't list stops at once ("… isn't available"), and a run that never says anything is stopped after three minutes instead of the full fifteen: OpenCode 1.18.18 hangs rather than fails on a model it can't resolve.

## 0.4.6 (2026-10-22)

- **A build keeps what led to it,** for the tool's life: your conversation with the intake, the spec, and the builder's log (which used to go after 30 days). The build page has **Conversation** next to **Spec agreed**; in **Versions**, each version's **Details** opens its conversation, spec and log, and **Continue from here** starts a change with that conversation as context. Builds also record which brief they ran on.
- **Instructions for building:** standing rules the builder follows on every build, for every tool (Settings › AI › Instructions for building) or for one tool (Info › Instructions). Tell the intake a rule ("always Swedish copy", "keep this one to a single screen") and it remembers it: the chat shows what was saved, with Undo. One rule per line, yours to edit. Each build records the instructions it ran with.
- **The intake asks until it's clear.** A one-line idea gets questions before a proposal, each with the default it would assume ("I'd assume one entry per day; right?"), so "go ahead" answers them all; a specific change ("show pace per km in the table") still gets a proposal at once, a vague one ("improve the UX") gets asked what bothers you. No more cap of three rounds: **Draft now** in the box skips the rest and takes its assumptions, listed with the proposal.
- **Paste a screenshot, drop a file, or Attach.** Images (resized before they go up; up to 5 per message) and text files (up to 256 KB) go with your message to the intake, and with the build to the builder, in its workspace under `attachments/`, listed in the request. They stay with the build like the conversation, and show in it. A tool's own top-level `attachments/` folder is reserved for them from now on (workspace only, never part of a version). For hosts: `attachments` on `/v1/intake`.
- **A failed validation no longer starts the builder over.** The next attempt resumes the first one's session with the failure (Claude Code and Codex), so it fixes the candidate instead of re-reading the brief and rewriting it: a second attempt takes a fraction of the first. The host's builder gets a `session` per build to do the same. Claude Code builds and the Claude Code intake also run `--restricted` (no code-running tools), each build's builder session lives in a home of its own (no other build can read it), and every workspace gets an `AGENTS.md` pointing at the brief, for builders that read it on their own. The brief asks for icons centred in their 5×5 grid. The builder brief is `@hewntools/spec` 2.3.3.
- **Got what you asked for?** When you next open a tool after a build went live, a note at the bottom asks once per version (within a week of the build): Yes, Not quite (which opens the change panel), or skip. The answer stays in your Hewn; nothing is sent anywhere. `hewn feedback` lists recent builds with what they ran on, attempts, your answers and what the record shows (a failed build whose retry went live, another change within a day, a restore within a week, the tool deleted within a day).
- **Fixed: `hewn models <subcommand>` from the terminal.** It skipped the word after `models`, so `hewn models key anthropic` (and `use`, `tier`, `cap`, `price`, `set`, `list`, `check`) failed with "unknown: hewn models anthropic". Settings › AI › Models was unaffected.
- **The intake gets 15 minutes, not 5,** so a long brief on a slow, careful model (Opus at high effort) finishes. Past that it's stopped with "intake took longer than 15 minutes, so Hewn stopped it" instead of the last raw line of its output.
- **Fixed: a tool's hidden message showed as an empty red box.** The UI kit's `.notice` (and any other class that sets `display`) no longer overrides `hidden`.
- **The chat box's example goes after your first message** (no "Track my coffee beans…" under a conversation about something else).

## 0.4.5 (2026-10-21)

- **For hosts: tools that think run on the host's models** (hosted mode, `HEWN_HOSTED`). A tool's `ctx.model` goes to the host's `/v1/generate` (through the supervisor, which holds the token), so the owner needs no API key. Settings › AI › Models shows what each tier runs on and what the host charged this month (builds, talking requests through, tools that think), with no providers, keys or USD caps. A refusal (over the month) reaches the tool's caller in the host's words. See the [remote builder protocol](docs/internal/remote-builder.md#tools-model-calls-post-v1generate-hosted).
- **A tool's own monthly cap, when hosted:** in Credits, in the tool's model settings; over it, its calls are refused and the Inbox says so.
- **A tool's model settings save with one button:** the cap and the model together (Save), no separate Save for the cap.
- **After Reload, the change drawer says the new version is on screen** (with Change more and Undo) instead of offering Reload again, and the tool's bar shows the new version.
- **Fixed:** the change drawer's conversation couldn't be scrolled up once it was longer than the drawer; text put in the message box for you shows whole.
- **A model reply cut off at the tool's limit fails clearly** (Anthropic, OpenAI, OpenRouter and the host's models): "The model's reply was cut off at this tool's limit of N tokens (maxTokens). The tool needs a fix: ask the builder to raise its limit." instead of half a reply. It's still paid for.
- **Builders size `maxTokens` to the reply and pass `schema`** whenever the code reads data from it (the builder brief; @hewntools/spec 2.3.2).
- **Ask builder to fix this:** when an operation fails in a tool's own screen, a run from Info fails, a widget can't refresh or a schedule's run fails, Hewn offers to have the tool fixed. It opens a change with the operation, the error, its input and the last log lines written in, for you to read and send. Hewn keeps each tool's last ten failed calls for this, no longer than the call log (never a stored secret or a credential-like value, never the sign-in step).

## 0.4.4 (2026-10-20)

- **For hosts: hosted mode** (`HEWN_HOSTED=1`, with `HEWN_BUILD_URL`; optional `HEWN_HOST_SIGNIN_URL`). For an owner who has no terminal: signed-out pages and agent approval send them to the host's sign-in instead of a command, the first run goes straight to making something (no "who builds" step), and Settings hides what the host manages. See [remote access](docs/remote-access.md#running-hewn-for-someone-else-hewn_hosted).
- **Signing in to approve an agent lands on Agents,** where its request waits, also when the sign-in comes back from a link (the host's, or `hewn open --print`).
- **The first run uses the intake's box:** describe the tool, see the model it builds with, Send.
- **Remote access** no longer offers to add a passkey on a browser that already has one (made there, or signed in with), and no longer says "tool apps open from Home".
- **Agents are sent to the web client only:** a tool waiting for the owner's sign-in or approval tells the agent to open it in Hewn (Accounts), not `hewn connect`; a deleted tool's id says it can be restored under Settings › Data.

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
