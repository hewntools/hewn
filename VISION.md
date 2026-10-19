# Vision

Hewn is a personal capability platform: a durable, user-owned software layer that external AI agents can discover, use, extend, and evolve.

It is not an assistant.

It is not an app builder.

It is not an MCP toolbox tied to one model.

It is a **personal capability layer**: a shared set of durable software capabilities that remains available regardless of which agent the user happens to use.

The core question the platform answers is:

> What durable capabilities does this person own, and how can authorized agents discover, use, extend, or replace them?

## Why this exists

AI agents are becoming increasingly capable, but the durable things they create and operate are often trapped inside a particular conversation, product, coding environment, or vendor.

A user may prefer different agents for different jobs:

- Claude Code for implementation work
- Codex for another class of coding task
- ChatGPT for conversational work
- a voice assistant while mobile
- an IDE agent while editing code
- future specialized agents that do not exist yet

The user's durable software should not belong to any one of those agents.

The platform exists to make the user's capabilities independent of them.

An agent is a client of the platform.

A builder is a replaceable implementation mechanism.

A runtime is replaceable infrastructure.

The durable asset is the user's capability and its state.

## Capability, not app

The canonical domain object is a **Capability** (defined in the [capability model](spec/capability-model.md#capability); Hewn's interface calls it a tool).

A Capability may expose:

- machine-callable operations
- private persistent state
- artifacts or files
- an optional human-facing UI, and widgets
- background behavior, on a schedule
- eventually events, and a natural-language entry point

A Capability does not have to be a web app.

Examples:

- a running log with `record_run` and `get_summary`
- a personal finance capability that categorizes transactions
- a file conversion capability
- a travel planning capability
- a reading log with an optional UI
- a photo organization capability
- a capability wrapping an external API

UI is one possible surface of a Capability, not its definition.

## The durable layer

The platform should own the things that need to survive agents coming and going:

- Capability identity
- Capability purpose and intent
- Operation contracts
- Capability versions
- Persistent state
- Artifacts
- Grants and authorization
- Discovery
- Creation and modification lifecycle
- Runtime selection
- Build orchestration

Broad conversational memory may belong to the agent the user chooses.

Capability-specific durable context belongs here.

## Bring your own agent

The platform should be agent-agnostic.

External agents connect through standard interfaces such as:

- MCP
- HTTP APIs
- SDKs
- CLI

MCP is an important interface, but MCP is not the product.

The product is the durable personal capability substrate behind it.

## Bring your own builder

The same principle applies to build agents.

A capability may be built or modified by:

- Claude Code
- Codex
- OpenCode
- VibeSDK
- another coding agent
- a future specialized builder

The platform owns the build contract and lifecycle.

Builders propose candidate implementations.

The platform validates and promotes them.

A builder does not become the owner of the Capability and does not receive production authority merely because it can modify source code.

## Replaceable runtime

Capability execution should not depend permanently on one runtime.

Today each Capability runs in its own isolate in workerd, Cloudflare's open-source Workers runtime, inside the OS sandbox. Others may follow:

- a hosted serverless environment
- a sandboxed process runtime, for code that needs one
- future specialized execution environments

The runtime is an implementation detail hidden behind the Capability contract.

## Core invariants

1. **Capabilities outlive agents.**
   Closing or replacing an agent must not destroy or orphan a Capability.

2. **Capability identity is stable.**
   Implementation versions may change frequently without changing the durable Capability identity.

3. **State belongs to the Capability.**
   Persistent state must not belong to an agent session or implementation version.

4. **State is encapsulated.**
   Agents and other Capabilities interact through explicit interfaces, not raw storage.

5. **Operation contracts are stable public APIs.**
   Internal implementations may change independently.

6. **Builders are replaceable.**
   No particular coding agent should become part of the core domain model.

7. **Runtimes are replaceable.**
   A Capability should not conceptually be "a Cloudflare Worker" or "a local script."

8. **Authority is delegated.**
   Agents and Capabilities only receive the authority explicitly granted to them.

9. **No actor can expand its own authority.**

10. **The platform mediates consequential changes.**
    Builders propose; the platform validates and promotes.

## Long-term direction

The long-term product is a personal ecosystem in which a user accumulates durable capabilities, for their life and their work.

Different agents can:

- discover what already exists
- invoke a Capability
- create a new one
- modify an existing one
- compose Capabilities through explicit interfaces and grants
- replace implementations without losing identity or state

Over time, the platform may add:

- semantic discovery
- events and subscriptions
- natural-language invocation
- richer artifact interoperability
- cloud runtimes
- richer policy controls
- capability sharing and remixing
- community ecosystems

These extend the core model; they don't change it.

## What this is not

This platform is not primarily:

- another conversational assistant
- a chatbot UI
- a Lovable/Replit-style app generator
- an MCP server full of unrelated tools
- a workflow automation product
- a developer-only plugin marketplace
- a single-vendor agent environment

The user should be able to replace the agent, builder, or runtime without replacing their personal software environment.

That is the central architectural bet.
