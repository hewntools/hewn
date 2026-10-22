# Troubleshooting

Start with `hewn doctor`. It checks Hewn, the service, the install, the sandbox, the secrets key, the agent that builds your tools, the browser for visual checks, your agents, approvals waiting, the tunnel and backups. Each problem comes with the fix.

For example, with Claude Code missing from `PATH` (trimmed):

```text
✔ Hewn          running on port 7717
✔ Service       starts at login, restarts on crash
✔ Install       Hewn 0.4.0
…
✖ Builds tools  claude isn't on PATH
                → install claude, or pick another in Settings › AI
…
1 problem.
```

The log is `~/.hewn/logs/hewn.log` (`<home>/logs/hewn.log` if you set `HEWN_HOME`). `hewn logs <tool>` shows one tool's calls.

## Install and start

**`hewn doctor`: "Install: Hewn's own code doesn't build"** (for example `Could not resolve "zod/v3"`)
The install is incomplete or damaged. Install again (`curl -fsSL https://hewn.tools/install.sh | sh`, or `npm install -g @hewntools/cli`), then `hewn service restart`. In a checkout of the source, `npm ci`.

**`` version `GLIBC_2.28' not found ``** (from `node`, `npm` or `claude`)
The Linux is too old: Ubuntu 18.04 or similar. Node 24 and Claude Code need glibc 2.28 or newer (Ubuntu 22.04 or newer).

**Claude Code's installer hangs, or a tool dies with "Illegal instruction"** (in a VM)
The VM's CPU type hides features the binary needs. On Proxmox: Hardware → Processors → Type `host` (or `x86-64-v3`), then stop and start the VM (a reboot from inside isn't enough). Also check memory (`free -h`; 2 GB or more).

**`hewn: command not found`**
The installer put `hewn` in npm's global bin or in `~/.local/bin`, and printed which. Add that folder to your `PATH` (it printed the line to add), or run the install again.

**The service is installed but not running**
- macOS: `launchctl print gui/$(id -u)/tools.hewn.hewn | head -30`
- Linux: `systemctl --user status hewn` and `journalctl --user -u hewn -n 50`

The cause is usually in `<home>/logs/hewn.log.crash`.

**`hewn service stop` or `uninstall` fails**
It now says so, and leaves the service in place, instead of reporting ✔ while Hewn keeps running. On WSL the usual cause is the bus below. Fix that, then run the command again.

**`hewn open` doesn't open a browser** (WSL, a server, an SSH session)
It prints the link when it can't open one. On WSL it uses `wslview` if installed, else Windows' URL handler (`rundll32.exe url.dll,FileProtocolHandler`). `hewn open --print` only prints the link: on the public URL when one is set (with a QR code for a phone), else this machine's (`--local` forces that).

**Can't sign in from the phone / "Sign in with a passkey" fails**
The passkey must have been added on the current public URL (`hewn url`): passkeys made for an old address stop working. Sign in with `hewn open --print` on the server and add one again. "Passkeys need the public URL over HTTPS" means the page isn't on `https://` (check the reverse proxy). If the page loads but every request is refused, check that the proxy keeps the `Host` header and points at the public listener (port + 1), not the local port; see [remote access](remote-access.md).

**WSL: "Failed to connect to bus"**
- systemd isn't enabled: add `[boot]` and `systemd=true` to `/etc/wsl.conf`, run `wsl --shutdown` from Windows, and reopen your distribution.
- systemd is enabled, but WSLg mounted its own `/run/user/<uid>` over systemd's, hiding the bus (`ls /run/user/$(id -u)/bus` finds nothing). Hewn keeps running, but nothing can control it. `sudo systemctl restart user@$(id -u).service` fixes it until the next start.

**Port 7717 is in use**
Another Hewn is probably running. Choose another port: `HEWN_PORT=7727 hewn service install`. The tunnel listener uses the next port (7728).

**Hewn keeps restarting: "can't store the secrets key with secret-tool: … Could not connect"** (WSL, a server)
`secret-tool` (from `libsecret-tools`) is installed, but there's no keyring for it to talk to. Hewn 0.4.0 tried to use it anyway; later versions don't. Remove it, or tell Hewn to use its key file, then restart:

```sh
sudo apt remove libsecret-tools    # or: set HEWN_KEY_SOURCE=file for the service
hewn service restart
```

Your key stays in `~/.hewn/master.key` and your secrets keep working.

## Sandbox (Linux)

**"bubblewrap isn't installed"**: `sudo apt install bubblewrap`.

**bubblewrap is installed but fails** (`setting up uid map: Permission denied`)
Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, and its bubblewrap package doesn't allow them. Give bwrap (only) its own profile:

```sh
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Then `hewn service restart` and `hewn doctor`. The blunt alternative allows user namespaces for every program: `echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-userns.conf && sudo sysctl --system`.

## Building

**"Builder isn't logged in"**: run `claude` once and sign in, or `codex login`. Then check Settings › AI, or run `hewn doctor`.

**"intake took longer than 15 minutes, so Hewn stopped it"**
The talk before a build had no answer after 15 minutes, which usually means it hung (a dropped connection, a stuck sign-in). Send your message again. If it keeps happening with a long brief, pick a faster model or a lower effort in the chat box's model menu.

**A build fails**
The build says why (the failing test, the invalid manifest, the error on its screen), with its log, and offers **Ask builder to fix**. When the builder itself is unavailable (signed out, out of usage), Hewn stops instead of retrying.

**"Model not available: … isn't available. Pick another model"**
The model you pinned for building is gone (retired, misspelled, or not on your account), so nothing was built. Pick another in the chat box's model menu or Settings › AI (**Builds tools › Model…**), or a family such as Fable, which follows the newest. Then retry the build.

**An agent's build fails with "the owner doesn't let agents ask for …"**
The agent asked for a model you haven't allowed. Tick it under **Agents may ask for** in Settings › AI, or let the agent leave the model out (your choice is used then).

**"Visual check: no Chromium-based browser"**
Built UIs aren't rendered before promotion. Install one: `npx playwright install chromium-headless-shell` (on Linux and WSL, `npx playwright install --with-deps chromium-headless-shell`).

**"Visual check: the browser didn't start … Hewn runs as root"**
Chromium won't start as root with its sandbox on, which is usual in a container. Hewn doesn't turn the sandbox off by itself. If the container is the boundary you rely on, point `HEWN_BROWSER` at a small wrapper that adds the flag, and restart Hewn:

```sh
#!/bin/sh
exec /path/to/chrome-headless-shell --no-sandbox "$@"
```

Better still, run Hewn as a user other than root.

## Agents

**An agent can't connect, or keeps asking to sign in**
Check the **Inbox** in the web client (or `hewn agents pending`) for a request waiting for you. Requests expire after 15 minutes. Run `hewn setup` again for Claude Code or Codex.

**Connect an agent (web) waits forever at "signs in"**
The agent couldn't open a browser (WSL, or Hewn running as a service with no desktop session). Use **Open the sign-in page** in the dialog when it appears. Otherwise run the sign-in in a terminal yourself: `claude mcp login hewn`, and approve it in Hewn. It gives up after 15 minutes.

**claude.ai or ChatGPT doesn't think of Hewn**
Add the Hewn pointer to its instructions (see [Connecting agents](agents.md)).

**claude.ai stopped working after a restart**
A quick tunnel gets a new address when it starts. Check `hewn tunnel status`, and update the connector. Use a named tunnel for a stable address.

**Codex asks you to log in again after a Codex build**
Hewn keeps the builder's own copy of your Codex login and syncs it back after a build. If you used Codex yourself during a build and both refreshed it, one copy loses. `codex login` fixes it.

## Data

**Restore a backup, move to a new machine, or bring back secrets after a restore:** see [Your data](data.md).

**Deleted a tool by mistake:** Settings › Data › Deleted tools → Restore (data included), or `hewn restore <id>`.

**A new version broke something:** **Versions** in the tool's menu → Restore on the one before, or `hewn rollback <id>`.

## Reporting

See [SECURITY.md](../SECURITY.md) for security problems. For anything else, open an issue on [GitHub](https://github.com/hewntools/hewn/issues) with `hewn doctor`'s output, and the relevant lines from `hewn.log`.
