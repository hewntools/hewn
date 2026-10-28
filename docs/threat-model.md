# Self-host threat model

What Hewn protects when it runs on your own machine, and what it doesn't. Short version: **Hewn protects you from the code it runs and the agents it talks to over the network. It doesn't protect you from programs running as your own OS user.** For that, run Hewn as a separate user (recipe below).

## What's protected

| From | How |
| --- | --- |
| **Tool code** (written by a builder, i.e. an AI, or installed from a file someone shared) | Its code can import only its own files and its npm dependencies when it's bundled, never other files on your disk. npm installs those dependencies on your machine, outside the builder's sandbox, so they come from the npm registry only (no paths, links, git or URLs), a tool can't carry npm settings (`.npmrc`), and npm never runs their install scripts. Each tool runs in its own workerd isolate. It has no filesystem, no processes and no environment. Its only state is its own SQLite database. Network access is limited to the hosts you granted, redirects included (everything else gets a 403). It gets secrets only if declared and granted, per call, and a result that contains one is withheld. It reaches other tools only through operations you granted. A stuck tool is cut off by a watchdog. |
| **workerd itself** | It runs inside the OS sandbox (Seatbelt on macOS, bubblewrap on Linux): no reading your home directory, and writing only its own data directory. |
| **The builder** (Claude Code / Codex / OpenCode, headless) | It runs in the OS sandbox too: it can write its workspace, temp and its own state only (nowhere else on the disk), and can't read the rest of Hewn's data, your repositories, credential files (SSH, cloud, registry, `.npmrc`/`.netrc`), browser data, shell history or the other builders' logins. It gets a minimal environment, and on macOS can't reach this machine's ports, with one exception: a local model server you configured in OpenCode (Ollama, LM Studio) stays reachable on its own port. It also runs without your settings, hooks, skills, plugins or memory files, in a config folder of its own that holds only its model login (never your MCP tokens, Hewn's included), and a version never keeps builder configuration for the next build. Hewn validates, tests and renders what it wrote before anything is promoted. |
| **Agents over MCP** | OAuth with your approval for each one. Tokens are stored hashed and expire (1 hour, refreshed for up to 30 days of use). Agents get only the scopes you approve, and can't grant themselves anything. Destructive operations wait for your confirmation, also when the agent reaches them through another tool. Reconnecting an agent keeps what you narrowed it to. Disconnecting an agent takes effect on its next call. |
| **The internet (with a tunnel or a public URL)** | The tunnel and the reverse proxy reach a separate listener. On any host there, only MCP and the agent sign-in endpoints answer. On the public URL's hosts (`hewn url`), the web client and tool UIs answer too, behind a passkey or a sign-in link printed on the server ([remote access](remote-access.md)). Admin never answers there. Requests are rate limited per address (as your proxy reports it) and logged. Anyone can *ask* to connect an agent, but nothing is granted without your approval. Pending requests are capped, separately from your local ones, and expire after 15 minutes. |
| **Other websites in your browser** | Hewn's local port answers only its own names (`127.0.0.1`, `localhost`, `hewn.localhost`), so a page can't reach it by pointing its own name at your machine (DNS rebinding), and MCP refuses other sites' requests. The web client has its own origin (`hewn.localhost`, or the public URL); each tool UI runs sandboxed on an opaque origin (under `/tools/<id>/`), with a strict CSP and SameSite cookies (`__Host-` and `Secure` on the public URL). Sign-in links work once, for two minutes. Passkeys work only on the address they were made for. |
| **Lost data** | Versions are immutable, and migrations can't destroy data and are tested on a copy first. There's rollback, export, and nightly backups. Backups never contain secrets in plain text or usable tokens. |

## What isn't protected

**Anything that runs as your OS user can act as you on Hewn.** That includes Claude Code or Codex when they run shell commands for you. Such a process can:
- read `supervisor.json` in the Hewn home and use the admin channel, which is how the `hewn` CLI acts as you
- read Hewn's data files directly (they're yours)
- read the secrets master key:
  - macOS: Keychain, readable by your user without a prompt (`security find-generic-password`)
  - Linux with a desktop session: libsecret
  - Linux without one: a 0600 `master.key` file in the Hewn home
- with that key, decrypt your stored secrets

So an agent you run in a terminal with shell access isn't confined by its scopes: it can run `hewn` itself. Scopes and approvals confine agents that reach Hewn *only* over MCP, such as claude.ai and ChatGPT, or local agents without shell access.

Also:
- **Your builder's account** (a subscription, an API key or a cloud provider) is what the builder runs on. An agent asking for a new tool spends it.
- **Tool UIs** run in your browser in a sandbox, on an opaque origin of their own. They can call their own tool's operations, and nothing else: no access to the web client, its cookies or another UI. A UI can still open links and popups, so a UI built to misbehave could leave with what it shows you. Their files are served under a secret address per tool (only the signed-in web client and `hewn open` lead there), so nobody can list your tools or read their code by guessing.
- **Agents that can change tools** (`modify` scope): a change to a connection, or one that adds operations, waits for you to approve it (the Inbox, or `hewn review`). Other changes go live after their checks: the operations keep their contracts and new grants still wait, but the code behind them may change. Give `modify` to agents you trust with your tools' data.
- **Approval cards:** an agent's name is whatever it says. Approve only a request you just started, and check the code matches the one in its browser window.
- **workerd** has no CPU limits standalone. A runaway tool is stopped by the supervisor's watchdog, which restarts workerd (a few seconds of downtime for all tools).
- **Supply chain:** Hewn depends on npm packages (workerd, esbuild, the MCP SDK, zod). The npm package bundles its JavaScript dependencies when a release is built; only workerd and esbuild (native binaries) are installed from npm at install time, within a semver range. `hewn upgrade` checks that a new version starts before switching to it.

## Running Hewn as a separate user

This separates Hewn's data, its key and its admin channel from your own processes. Agents then reach Hewn only over HTTP (OAuth), so their scopes really bind them. **This recipe isn't tested yet.**

**Linux** (systemd):
```sh
sudo useradd --create-home --shell /bin/bash hewn
sudo -iu hewn     # then, as hewn: install Node 24 (nvm) and follow the quickstart
loginctl enable-linger hewn   # as root: so its user service runs without a login
```
The builder CLIs need their own sign-in as the `hewn` user (`claude`, `codex login`). To open the web client from your own account, run `sudo -iu hewn hewn open --print` and open the link.

**macOS:** create a Standard user "hewn" (System Settings → Users & Groups). Install Hewn as that user. The background service is a launchd *agent*, so it runs while that user is logged in (fast user switching keeps it running). A LaunchDaemon variant is future work.

Your own agents connect as usual (`http://127.0.0.1:<port>/mcp`), and you approve them in the web client.
