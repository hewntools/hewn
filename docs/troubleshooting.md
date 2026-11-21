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
Another Hewn is probably running. Choose another port: `HEWN_PORT=7727 hewn service install`. The tunnel listener uses the next port (7728). If something else holds the tunnel port, `hewn serve` stops with "workerd did not start" instead of staying up without it: free the port or choose another.

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

**"Builder isn't logged in"**: run `claude` once and sign in, or `codex login`, or `opencode auth login`. Then check Settings › AI, or run `hewn doctor`.

**"opencode said nothing for 3 minutes, so Hewn stopped it (it never started)"**
OpenCode sometimes never gets going (seen with 1.18.18, mostly when a model it can't resolve is involved). Hewn stops it after three silent minutes instead of waiting the whole build out. Retry the build; if it keeps happening, check that the model in Settings › AI is one `opencode models` lists.

**"no activity for 15 minutes"** in a build's log
The builder did nothing (no output, no file written) for 15 minutes. If it had been working, Hewn resumed it where it was (the log says "; resuming") and the attempt goes on. If it never did anything, it hung from the start, and the attempt failed: retry it, and if it keeps happening, check the builder's sign-in and the model in Settings › AI. To give a slow builder longer, set `builderIdleMinutes` in `platform.json`.

**"intake took longer than 15 minutes, so Hewn stopped it"**
The talk before a build had no answer after 15 minutes, which usually means it hung (a dropped connection, a stuck sign-in). Send your message again. If it keeps happening with a long brief, pick a faster model or a lower effort in the chat box's model menu.

**A build fails**
The build says why (the failing test, the invalid manifest, the error on its screen), with its log, and offers **Ask builder to fix**. When the builder itself is unavailable (signed out, out of usage), Hewn stops instead of retrying.

**"Model not available: … isn't available (…). Pick another model"**
The model you pinned for building won't run, and the brackets carry the agent's reason: it's gone (retired, misspelled, or not on your account), or, on OpenCode's free tier, "Model is unavailable": that tier changes which models it serves, and its list can lag behind. Nothing was built. Pick another in the chat box's model menu or Settings › AI (**Builds tools › Model…**), where a model that failed in the last hour says so, or a family such as Fable, which follows the newest. Then retry the build.

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

## Tools

**A call fails with "timed out (call chain deadline)", or "stopped: … ran past its deadline"**
A call chain has 30 seconds (a widget 15), and past that the call is stopped, code and all. Other calls running on the same tool then stop with it and say which call ran out of time. A tool with long work should do part of it per call ([Writing a tool](../spec/tools.md#runtime)): **Ask builder to fix this** on the failed call.

**"Suspended: it worked for more than 10 seconds without a pause 3 times within an hour"**
A tool whose code never lets go (an endless loop) holds up all your tools, not only itself: Hewn restarts its tools after 10 seconds (a call may not work longer than that without a pause), and tool calls and builds running then fail. Hewn itself (the web client, your agents' connections) keeps answering. Afterwards, the tool that was running has a line in its log (`hewn logs <id>`: `ERROR stalled: Hewn's tools stopped responding while this ran and were restarted`) and in Activity. Tools that were only waiting at that moment (on another tool, a model or the network) aren't blamed: their call fails saying another tool held Hewn's tools up, and Activity lists them as held up, with what they were doing. When Hewn can't tell (a tool was loading, migrating or having its data read at the time), every tool that was running has the line. A tool named 3 times within an hour is suspended (the suspension says which three stalls): its calls, schedules and widgets are refused, saying why, until you resume it. Its page has **Ask builder to fix** and **Resume**; `hewn resume <id>` does the same. A schedule refused while the tool is suspended doesn't count as a failure, and runs again once it's resumed.

**`hewn doctor`: "the tools restarted 2× (a tool stuck in a loop, or a crash)"**
Hewn's tools run in a process of their own, and since Hewn started it was restarted that many times: a tool's code held it (`hewn.log` says "Hewn's tools stopped responding … restarting them", and Activity names the tool, as above), or it exited ("tools: workerd exited"). Hewn itself kept answering. "workerd restarted N× (watchdog/crash)" on the same line is Hewn's own process; the tools restart with it, so they count that one too. `hewn status` shows both: `restarts: Hewn 0, tools 2`. If the tools keep restarting with no tool named in Activity, open an issue with those lines from `hewn.log`. A restart leaves nothing of the old process behind: on Linux, Hewn before 0.4.13 could leave one `workerd` running under init for each restart of its tools (`ps -o pid,ppid,rss,args -C workerd` shows them with parent 1), until a reboot or until you stop them.

**A build fails with "It worked too long without a pause"**
An operation worked for more than 10 seconds without a pause in its tests, its sample data or its screen, so Hewn restarted its tools. The failure names the operation and what it ran on ("`import_feed@1` worked for more than 10 seconds without a pause, on test 'big feed'"). Builds that failed before 0.4.13 say "Its code kept Hewn's tools from responding". The build isn't tried again by itself: it would do the same. **Ask builder to fix** starts a new attempt with that as the reason.

## Agents

**An agent can't connect, or keeps asking to sign in**
Check the **Inbox** in the web client (or `hewn agents pending`) for a request waiting for you. Requests expire after 15 minutes. Run `hewn setup` again for Claude Code, Codex or OpenCode.

**Connect an agent (web) waits forever at "signs in"**
The agent couldn't open a browser (WSL, or Hewn running as a service with no desktop session). Use **Open the sign-in page** in the dialog when it appears. Otherwise run the sign-in in a terminal yourself: `claude mcp login hewn`, and approve it in Hewn. It gives up after 15 minutes.

**claude.ai or ChatGPT doesn't think of Hewn**
Add the Hewn pointer to its instructions (see [Connecting agents](agents.md)).

**claude.ai stopped working after a restart**
A quick tunnel gets a new address when it starts. Check `hewn tunnel status`, and update the connector. Use a named tunnel for a stable address.

**Codex asks you to log in again after a Codex build**
Hewn keeps the builder's own copy of your Codex login and syncs it back after a build. If you used Codex yourself during a build and both refreshed it, one copy loses. `codex login` fixes it. The same goes for OpenCode's provider logins (`opencode auth login`).

**OpenCode doesn't offer the model you expect**
Hewn lists what `opencode models` lists: the providers you're signed in to (`opencode auth list`), those in `~/.config/opencode/opencode.json`, and its free tier. A model from your own `opencode.json` under a project folder isn't there: Hewn runs OpenCode with your global config only.

## Data

**Restore a backup, move to a new machine, or bring back secrets after a restore:** see [Your data](data.md).

**Deleted a tool by mistake:** Settings › Data › Deleted tools → Restore (data included), or `hewn restore <id>`.

**A new version broke something:** **Versions** in the tool's menu → **Details** on the one before → **Restore**, or `hewn rollback <id>`.

## Reporting

See [SECURITY.md](../SECURITY.md) for security problems. For anything else, open an issue on [GitHub](https://github.com/hewntools/hewn/issues) with `hewn doctor`'s output, and the relevant lines from `hewn.log`.
