# Changelog

Hewn follows semver for the CLI and your data: `hewn upgrade` stays within a 0.x line, and a new line (0.4 → 0.5) is a deliberate move. The tool contract (the ABI, [`spec/`](spec/README.md#versions)) is versioned separately as `major.minor`: minor versions only add, and a tool declares the lowest one it needs.

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
