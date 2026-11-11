# Threat model: tools from outside

A tool's files that the owner's builder didn't write: a `.hewn.zip` installed from a file (0.4.9) or a link (0.4.11), and a file set an agent submits (`capabilities_submit`, 0.4.11). This page says what such a tool can reach before and after it's installed, what stops it, and what doesn't. The Hub's part (publishers, updates, takedowns) comes with the Hub. Builds the owner's own builder makes are in [`security-and-authority.md`](security-and-authority.md#builder-authority); the user-facing summary is [`docs/threat-model.md`](../threat-model.md).

## Who, and what they're after

**The attacker** wrote or changed the tool: whoever shared the file, whoever controls where a link points (or a site it redirects through), or an agent with `create` or `modify`, careless or steered by text it read.

**What they're after:**

- the owner's data in other tools, and the secrets connections hold;
- the owner's machine: files, SSH and git credentials, anything the Hewn process's user can read;
- the owner's network: the loopback, the LAN, cloud metadata addresses;
- the owner's model spend;
- the platform itself: its database, its disk, its CPU;
- the owner's judgement: what the install sheet and the reading say.

## What runs, and where

Everything a tool brings runs before the owner grants it anything. Each step is reachable without an install: `capabilities_check` gives an agent with `create` the full validation on demand.

| Step | Where it runs | What it can reach |
| --- | --- | --- |
| Reading the zip (`readZip`) | Hewn's process; parsing only | Nothing. Stored entries only, at most 1,000 files and 5 MB; paths with `..`, `.`, an empty segment, a leading `/`, a backslash or control characters refused; two names for one file (case, NFC) refused. |
| The reading (the intake's `summarize`) | The owner's builder, with no tools and no web | The files as text, fenced, at most 40 KB each and 200 KB in all. Advisory: the owner can skip it. |
| npm install | The owner's machine, outside the sandbox | The npm registry only: `--ignore-scripts --git=false --replace-registry-host=always`, and an install that took a package from the disk (a `file:` tarball, a link) fails with `node_modules` removed. `package.json` must name registry versions, and `.npmrc` is refused. |
| Bundling (esbuild) | Hewn's process | No tool code runs. An import outside the tool's folder fails. |
| Tests, migrations, sample replay | workerd isolates, on scratch state | No hosts, no secrets, no model, no other tools. Each state holds at most the tool's data limit, and a call is stopped at its deadline. |
| The upgrade dry run (a change) | An isolate, on a copy of live state | The copy. Its error reaches the owner's log; an agent's build sees only that a migration failed on the data. |
| The visual check | Headless Chromium on the machine | Only the page's own files and its tool's API. Other sites, the loopback, the LAN, popups and WebRTC are all blocked (`onlyOrigin` in `visual.ts`). |
| Promotion | The platform | An agent's change that adds operations, or touches a connection, waits for the owner. This includes widgets an agent adds after a create that someone else asked for. Grants are asked one at a time after install. |

## The ways in

- **A file.** The owner uploads it. It's staged for a day, and the sheet shows what it asks for, the owner's reading and the source code.
- **A link.**
  - Hewn fetches only https links with no user name or password, and never a private host by name or by IP literal.
  - Every redirect (at most 5) is checked the same way. The file may be at most 5 MB and must arrive within 30 s.
  - On the workerd host, workerd's own network rule (public addresses only) also covers a name that resolves to a private address.
  - The tool's record and the sheet show the host the file came from, plus "linked from …" when the pasted link's host differs.
  - `/share/` limits requests per client and per link.
- **A submission.**
  - An agent with `create` sends a new tool, and one with `modify` sends a change. Both go through the same gate as an install.
  - An agent in `wait` approval mode has every build held for the owner.

## What holds

- **Nothing grants itself.** A manifest only asks. Hosts, the model, other tools' operations and secrets are each the owner's yes, after install.
- **The install steps reach nothing of the owner's.** They get scratch state, no grants, and an origin-only browser.
- **`source` is the platform's.** Validation writes where a tool came from into every version, so a later change can't claim another origin.
- **A link can't point Hewn at itself.** Private names and addresses are refused at every hop, and the runtime's public-only rule backs this up.
- **The reading says what it didn't read.** The sheet names the files it left out or cut short. A finding's **Show** opens only a place that's in the tool.
- **A tool's data has a size.** Each of its states is limited (100 MB unless the owner changes it), by SQLite on every write, and the tool's code can't lift it. Nothing grows while the disk is nearly full. The limit needs workerd's `experimental` flag in tool isolates. The guard takes what the flag adds wherever the tool's code could reach it, and a test on the pinned workerd fails when a new version adds anything else. One method stays, `mapVirtualHost` on its own entrypoint's context: it can only route the tool's requests to the tool itself. The test compares what the tool's code can reach, not how it behaves: what the flag changes in APIs the tool already has was read from workerd's source at the pinned version (nothing that reaches past the tool's own sockets and isolate), and a new version needs that reading again.
- **A call ends when it ends.** A call past its deadline is stopped, and nothing a call starts outlives it. A tool whose code keeps Hewn from responding is named, and suspended after 3 times within an hour.
- **What a call leaves is cut outside the tool.** Its error and log are capped where Hewn keeps them, whatever the tool's code does.
- **Hosts say what they reach.**
  - A wildcard reads "any site ending in .example.com", and one over a single label (`*.com`) is refused.
  - A host taken from a setting is on the sheet, and its grant names the host.

## Residual risks

- **The reading is advice.** Text in the code can try to steer it. The prompt fences the files and treats steering as a finding, but no defence against a model is complete. It also doesn't read the code of npm packages; that code runs in the tool's isolate, under the tool's grants.
- **Wildcards over a public suffix with two labels** (`*.co.uk`, `*.workers.dev`) are accepted. They are worded as what they reach, so the owner sees the scope.
- **A setting's host can change.** Once its grant is approved, changing the setting re-targets it without a new grant. Only the owner can change a setting, and the change is logged.
- **Tool text reaches agents.** A tool's purpose, descriptions and results reach the agents that can see it as text, before anything is granted. Hewn quotes them, cuts them to size and tells agents they're information, not instructions, and the owner can switch agents off for a tool on its page; still, an agent that follows instructions in that text acts with its own scopes.
- **Model spend.** A call that times out counts at what was reserved for it. Still:
  - Spend is charged to the tool that was called, not to the tool that called it.
  - Per-tool caps are checked without reserving, and there's no cap per tool unless the owner sets one.
- **The platform's resources.** Code that never yields can't be stopped from inside workerd: it holds up every tool and Hewn itself until the watchdog restarts workerd (about 5 seconds), and calls running then fail. Hewn names every tool that was running, since it can't tell which one looped. The data limit is per state, so a build's copies can briefly hold several times it, and one statement's temporary space isn't counted.
- **Widgets' read-only rule lives inside the isolate.** It's enforced in the runtime module, which the tool's code can patch, so a tool can write its own data while its widget is drawn, as it can on any call. It reaches nothing else.
