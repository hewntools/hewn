# Building tools

You don't write tools yourself. You describe what you want, Hewn might ask a few clarifying questions, then proposes a spec, and your coding agent builds it.

## Asking for a tool

In the web client: the **New** tile on Home, or press `n`. Describe it in plain words:

> A habit tracker. Ask me each evening which habits I did, and show the streak.

Paste a screenshot (Ctrl+V / ⌘V), drop files on the box, or **Attach**: a screenshot of the screen to change or the look you mean, a sketch, a script to port, data to import. Images (up to 5 per message, resized before they go up) and text files (up to 256 KB each) go with your message to the intake and, when you build, to the builder, in its workspace. They stay with the build, like the conversation.

The agent that [builds your tools](concepts.md#hewns-two-jobs) (Settings › AI) first talks it through: it asks until the request is clear (when you'd use it, what it keeps, the main action), each question with the default it would assume, so "ok" answers them all; **Draft now** skips the rest and takes its assumptions, listed with the proposal. Then it makes a **spec proposal**: the tool, what it will do, what it needs (a site to reach, a key, another tool, a model: its [grants](concepts.md#grants)), and any widgets or [schedules](concepts.md#schedules). A big request can become a few small tools that work together; untick the ones you don't want. Reply to change it, or press **Build** (it says how many tools: "Build 1 tool").

![A spec proposal for one tool, Bike Care: what it's for, that it needs api.open-meteo.com, its five operations, a weekly schedule to approve and a widget, with Keep talking and Build 1 tool; the box below has Attach](images/spec-proposal.png)

You can also ask an agent ("make me a reading list in Hewn"), if you allowed it to make tools ([scopes](agents.md#what-agents-can-do)). It shows up the same way.

## The build

The agent [builds it](concepts.md#hewns-two-jobs) (Claude Code, Codex or OpenCode on your machine, in a sandbox, on however it's signed in: a subscription, an API key, a cloud provider such as Amazon Bedrock or Google Vertex AI, or with OpenCode a local model server) writes the tool. Then Hewn:

1. checks the manifest and the contracts
2. runs the tool's tests, and its database migrations on a copy of your data
3. renders its screen and checks it loads without errors
4. makes it live if all of that passes

What you ask for goes live right after the checks. A change an agent asks for that adds operations or touches a [connection](connections.md) waits for your approval first: see [Changes made by agents](#changing-a-tool).

Builds show in Activity and the Inbox while they run, with their milestones. A build usually takes a few minutes.

When you next open the tool, a note at the bottom asks once per version, within a week of the build: **Got what you asked for?** Yes, Not quite (which opens the change panel, so what's off becomes the next change), or skip. Your answer stays in your Hewn; nothing is sent anywhere. `hewn feedback` lists recent builds with your answers and what the record shows (a failed build whose retry went live; another change within a day of going live, which is what **Ask builder to fix this** makes; a restore within a week; the tool deleted within a day), so you can see which builds work out and which don't.

The build page keeps what led to the build: **Spec agreed** opens the spec the builder works from, and **Conversation** what you and the intake said. Both stay with the version it made, along with the builder's log, for the tool's life.

![Activity › Builds: a change to Reading List in progress (spec done, code being written, tests and you still to come), a failed change to Plant Care with Retry, and earlier builds with their versions](images/build-in-progress.png)

When it's live, the tool may still need you: **Allowed to** on its Info lists the [grants](concepts.md#grants) it asked for (a host such as `api.met.no`, a key, another tool's operations, a model). It isn't ready until you authorize them, and the Inbox says so. You can revoke any of it later.

## Changing a tool

**Change…** (in the tool's bar, its menu, or Info's **Change it** box) opens a panel next to the tool, so you can describe the change while you look at it. The tool keeps running its current version while the change builds. When the new version is live, **Reload** shows it, and **Undo** goes back to the one before.

A tool without a screen of its own shows its operations as forms. **Give it a proper screen** asks for one.

Some changes need no builder: picking another model tier, for example, is a new version right away.

**Changes made by agents:** an agent's change that adds operations, or changes a connection, waits for you to approve it (the Inbox, or `hewn review`). You see what it adds before it goes live. Other changes go live after their checks, and any new grants still wait for you.

## Instructions

Standing rules for how your tools are built, which the builder reads on every build: for every tool ("Swedish copy in every screen", "never a delete button without Undo") or for one tool ("keep it to a single screen"). Tell the intake a rule while you talk a request through and it remembers it: the chat shows **Saved to global builder instructions** (or to the tool's) with the rule as it was written down, and **Undo** if that's not what you meant. Withdraw a rule the same way.

They're yours to read and edit, one rule per line: Settings › AI › **Instructions for building** for every tool, and a tool's Info › **Instructions** for that tool. Each build records the instructions it ran with, next to its conversation and spec.

## When a build fails

The build says why: a failing test, an invalid manifest, an error on its screen. Its log is open below. **Ask builder to fix** starts a new attempt that gets the failure as context. Your tool, if it already existed, keeps running the version it had.

A build gets up to three attempts on its own (Settings › AI › Build attempts). A later attempt picks up where the builder left off, with the failure, instead of starting over, so it takes a fraction of the first.

![A failed build: 1 of 3 tests didn't pass, the test that failed, the Conversation and Spec agreed expanders, Ask builder to fix and Retry, and the log open below with what the test expected and what it got](images/build-failed.png)

If the builder itself can't work (signed out, out of usage), Hewn stops instead of retrying. Sign it in again (`claude`, `codex login` or `opencode auth login`), then try again.

## Versions

Every change is a new version. Your data stays and moves forward with each one. **Versions** (Info, or the tool's menu) lists them; **Restore** makes an earlier one active again, with the data kept. Restoring is refused if a newer version changed the data in a way the older code can't read.

Under each version is what led to it: the conversation with the intake, the spec and the builder's log. **Continue from here** opens a change with that conversation on top, so you pick up where you left off instead of explaining the tool again; opening **Change…** on a tool offers the same ("Continue from the last conversation?").

Operations are versioned too (`list_runs@1`). A breaking change adds `list_runs@2` next to the old one, so agents and other tools that use `@1` keep working.

## Deleting a tool

**Delete…** in the tool's menu removes it from Hewn and from agents, but keeps its data. Settings › Data › Deleted tools lists what you deleted: **Restore** brings it back with its data, and **Delete forever** removes the code, versions, data, logs and secrets (you type its name to confirm). After that, only a backup can bring it back.

## From the terminal

```
hewn status                    tools and recent builds
hewn watch [buildId]           follow a build live
hewn feedback [--days N]       how recent builds worked out (--json for the data)
hewn review                    agents' changes waiting for you
hewn rollback <id> [version]   an earlier version, active again
hewn restore <id>              bring back a deleted tool
hewn purge <id>                delete a deleted tool forever
hewn install <dir>             install a tool from a folder
```

To read or write a tool's code yourself, see [Writing tools](capabilities.md).
