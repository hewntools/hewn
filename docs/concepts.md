# Concepts

**Hewn holds your own small tools, with their own data, for every agent you use.** Instead of each chat or coding agent keeping its own notes, the things you track live in Hewn, and any agent you connect can use them.

## Tools

A **tool** is one small piece of software of your own: a Running Log, a Reading List, a weather app. Hewn's contracts and agents call it a *capability*.
- It has **operations** with typed inputs and outputs (`record_run`, `list_runs`), each marked `read`, `write` or `destructive`.
- It has its own **private database**. Nothing else can read it: other tools, agents and Hewn itself have to go through the tool's operations.
- It can have its own **screen** (UI), which the web client opens, and **widgets** for Home and for agents' chats.

Tools are **versioned**. Each change is a new version, tested before it becomes active. Your data stays and is migrated forward, and you can go back to an earlier version. Operation contracts are versioned too (`list_runs@1`): a breaking change adds `list_runs@2` next to it, so whatever relied on `@1` keeps working.

## Agents

**Agents** are the AI assistants you use: Claude Code, Codex, OpenCode, claude.ai and Claude Desktop, ChatGPT, or any MCP client. They connect to Hewn over MCP.
- **Approval:** they sign in with OAuth, and you approve each one in Hewn.
- **Scopes:** they get only what you approve: *see* your tools, *use* them, *make* new ones, *change* existing ones. Optionally, only some tools.
- **Owner-only actions:** agents can't approve anything for themselves: grants, secrets, schedules, other agents.
- **Destructive operations** wait for your confirmation in Hewn.

See [Connecting agents](agents.md).

## Hewn's two jobs

Hewn uses AI itself, for two jobs (Settings › AI):

- **Builds tools:** an agent talks your request through with you, proposes a **spec** of what to build, and once you say Build, writes the tool in a sandbox. It runs Claude Code, Codex or OpenCode on your machine, on however it's signed in: a subscription, an API key, a cloud provider such as Amazon Bedrock or Google Vertex AI, or (OpenCode) a local model server. Hewn adds no fees of its own. You choose its model and effort; [Choosing the model](models.md#building-tools) says how.
- **Thinks inside tools:** tools that need a model call one through Hewn, with your API key and a monthly budget. See [Models](models.md).

Building is two parts underneath: the **intake** talks it through (quick, writes nothing) and the **builder** builds (in a sandbox, takes minutes). One agent does both, on the model you pick.

One agent can build your tools and also use them as an MCP client.

## Builds

When you (or an agent) ask for a new tool or a change, the builder writes it. Hewn then:
1. checks the manifest and the contracts
2. runs the tool's tests, and its database migrations on a copy of your data
3. renders its screen
4. makes it live if all of that passes

What you ask for goes live right after the checks. A change an **agent** asks for that adds operations, or touches a [connection](#connections), waits for you to approve it first (the Inbox, or `hewn review`). Either way, a tool can't reach anything new until you approve its [grants](#grants).

If it fails, you see why, and you can ask the builder to fix it. See [Building tools](building-tools.md).

## Grants

Tools are isolated by default: no network, no keys, no model. A tool reaches outside only through what it declares and you **grant**:
- **hosts:** e.g. `api.met.no`, for the weather
- **keys:** an API token, held only by a connection (below)
- **other tools' operations:** e.g. a Weekly Review reading `running-log/list_runs@1`
- **a model:** at a tier you choose

A tool is **not ready** until you've granted what it needs. You can revoke any grant at any time. **Deny** says no to one: the tool stays not ready, and nothing asks for it again (Home, the Inbox, agents' requests) until its next version. Then it runs only if you **Authorize** it after all, or a change makes it work without it (**Ask builder to work without it**). From the terminal: `hewn grants deny <id> <grant>`.

## Connections

A **connection** is a tool that wraps one service you have an account with (Todoist, GitHub, your bank). It's the only kind of tool that holds credentials. Other tools use the service through its operations. See [Connections](connections.md).

## Schedules

You can run an operation on a timetable, e.g. "daily 07:00", in your time zone. Agents can only **propose** a schedule; nothing runs until you enable it. Read and write operations only. A schedule pauses itself after three failures in a row.

## The Inbox and Activity

The **Inbox** holds what needs you: grants, agents waiting, schedule proposals, failed builds, connections to sign in again, model spend. **Activity** holds everything that happened: calls, builds, and access changes (agents connected or disconnected, scopes, secrets, destructive calls allowed or stopped), with who did it and when. See [The web client](using-hewn.md).

## Where it runs

On your machine. The tools run in **workerd**, Cloudflare's open-source Workers runtime: each one in its own isolate, behind an egress filter. Hewn's supervisor runs workerd inside the OS sandbox (Seatbelt on macOS, bubblewrap on Linux), and runs the builder, the intake and backups. See the [threat model](threat-model.md) for what that protects.
