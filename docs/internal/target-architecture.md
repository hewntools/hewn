# Target Architecture

> The intended architectural direction, not necessarily the current implementation. [`architecture.md`](architecture.md) describes what exists today. The concepts (capability, operation contract, version, grant) are defined in the [capability model](../../spec/capability-model.md).

## System shape

```text
Human
  |
  +-- Claude
  +-- Codex
  +-- ChatGPT
  +-- Voice assistant
  +-- IDE agent
  +-- Future agents
          |
          v
+-----------------------------+
| Agent Interface Layer       |
| MCP / HTTP / SDK / CLI      |
+-----------------------------+
          |
          v
+-----------------------------------------+
| Capability Control Plane                |
|                                         |
| - Registry and deterministic discovery  |
| - Authorization and delegation          |
| - Invocation routing                    |
| - Capability lifecycle                  |
| - Version management                    |
| - Grants                                |
| - Artifact mediation                    |
| - Build orchestration                   |
+-----------------------------------------+
          |
          +----------------------+
          |                      |
          v                      v
+-------------------+   +-------------------+
| Builders          |   | Runtimes          |
|                   |   |                   |
| Claude Code       |   | Local runtime     |
| Codex             |   | Dynamic Workers   |
| VibeSDK           |   | Other runtimes    |
| OpenCode          |   | ...               |
| ...               |   |                   |
+-------------------+   +-------------------+
```

## Primary architectural roles

### Human

The human owns the personal capability environment.

All authority ultimately originates with the user.

### Agent

An Agent is an external client acting under delegated user authority.

Examples include Claude Code, Codex, ChatGPT, a voice assistant, or another future agent.

Agents may receive scopes such as:

- discover
- invoke
- create
- modify
- manage
- delete

An Agent is not part of a Capability and does not own Capability state.

### Capability Platform

The platform is the durable substrate.

It owns:

- Capability identity
- manifests
- operation contracts
- version lifecycle
- state mediation
- grants
- authorization
- discovery
- invocation routing
- builder orchestration
- runtime selection

### Capability

A Capability is a durable, user-owned unit of software capability.

It may expose one or more operation contracts and may optionally expose UI, artifacts, or future event interfaces.

A Capability is not synonymous with an application, service, repository, process, or runtime.

### Capability Version

A Capability Version is an immutable implementation version of a stable Capability.

A new implementation version does not necessarily change the public operation contract.

### Operation Contract

An Operation Contract is the stable machine-facing API exposed by a Capability.

Example:

```text
record_run@1
```

Implementation versions 3 through 15 may all implement the same operation contract.

Breaking public changes require explicit contract versioning or compatibility behavior.

### Builder

A Builder converts a desired creation or modification request into a candidate implementation.

Conceptually:

```ts
interface CapabilityBuilder {
  build(request: BuildRequest): Promise<CapabilityCandidate>;
}
```

A Builder may be an AI coding agent, a code-generation platform, or a future specialized implementation service.

Builders do not receive automatic authority to promote or operate production Capabilities.

### Runtime

A Runtime executes a promoted Capability implementation.

Conceptually:

```ts
interface CapabilityRuntime {
  invoke(
    version: CapabilityVersion,
    operation: string,
    input: unknown
  ): Promise<unknown>;
}
```

The Runtime is replaceable infrastructure.

## Core lifecycle

### Creation

```text
User intent
   |
   v
Authorized agent
   |
   v
Capability creation request
   |
   v
Builder
   |
   v
Candidate implementation
   |
   v
Validation / tests / policy
   |
   v
Immutable Capability Version
   |
   v
Promotion
   |
   v
Active Capability
```

### Modification

```text
Existing Capability
   |
   +-- stable identity
   +-- existing state
   +-- current source/version
   |
   v
Desired change
   |
   v
Builder
   |
   v
Candidate implementation
   |
   v
Validation / migration / tests
   |
   v
New immutable version
   |
   v
Promotion
```

The previously active version remains available until the replacement succeeds.

## Agent-facing interfaces

### MCP

MCP is expected to be the primary initial protocol for agent interaction.

It should expose functions such as:

- list Capabilities
- retrieve a Capability manifest
- invoke an operation
- request Capability creation
- request Capability modification
- inspect build status

MCP is an interface to the platform, not the domain model itself.

### HTTP

A normal HTTP API will likely be needed for:

- non-MCP clients
- SDKs
- browser-based surfaces
- integrations
- debugging

### CLI

A CLI is useful for:

- local development
- Claude Code workflows
- debugging
- manual inspection
- scripting

## Discovery

Initial discovery should be deterministic.

Supported dimensions may include:

- Capability ID
- Capability name
- operation name
- tags
- declared metadata

Semantic discovery can be added later.

A future semantic layer should rank or retrieve from the same underlying registry rather than replacing it.

## State

State belongs to the stable Capability identity.

External agents do not directly query internal storage.

A Capability's internal persistence model is private.

All external access occurs through public operations or explicitly exposed artifacts.

This allows implementation and schema changes without coupling callers to storage internals.

## Artifacts

Artifacts are expected to become durable user-owned resources distinct from Capability-internal state.

Examples:

- documents
- spreadsheets
- images
- generated reports
- exported datasets

A Capability may produce artifacts.

Another Capability may access them only through explicit authorization.

The artifact model is deferred until there is a concrete need.

## Capability composition

Capabilities invoke other Capabilities (today through `ctx.call`).

Example:

```text
Travel planner
      |
      | invoke weather.get_forecast
      v
Weather capability
```

The calling Capability does not receive raw access to the callee's internal state.

All composition occurs through public operation contracts and platform-mediated grants.

## Optional natural-language interface

A Capability may eventually expose an optional natural-language entry point.

The platform should standardize the invocation envelope while leaving the semantic content free-form.

Principle:

> Structure the envelope, not the meaning.

Explicit operation contracts remain the deterministic foundation.

Natural-language invocation is an optional semantic convenience layer.

## Events

Events are part of the conceptual target model but not part of ABI 2.

Future model:

```text
Operations = do something
Events     = something happened
UI         = human-facing surface
```

Events may eventually allow:

- agent subscriptions
- Capability-to-Capability reactions
- reminders
- background automation
- external notifications

The event model should not be implemented until there is a concrete need.

## UI

UI is optional.

A Capability may expose:

- no UI
- a small inspection UI
- a full interactive application
- multiple human surfaces

Generated application platforms such as VibeSDK may eventually be useful for UI-heavy Capabilities.

They should be treated as implementation adapters, not as the definition of a Capability.

## Builder adapters

Likely future shape:

```text
Capability Platform
       |
       +-- ClaudeBuilder
       +-- CodexBuilder
       +-- VibeSDKBuilder
       +-- OpenCodeBuilder
       +-- OtherBuilder
```

The platform chooses a builder according to user preference, policy, or request context.

A calling Agent may suggest a Builder, but should not silently change the user's configured Builder authority.

## Runtime adapters

Likely future shape:

```text
Capability Platform
       |
       +-- LocalRuntime
       +-- DynamicWorkerRuntime
       +-- OtherRuntime
```

Capability contracts should remain stable as runtime implementations change.

## Target separation of concerns

The intended boundary is:

> The Agent understands the user's request.
>
> The Capability Platform understands durable capability identity, authority, lifecycle, and execution.
>
> The Builder understands how to create a candidate implementation.
>
> The Runtime understands how to execute a promoted implementation.

Do not collapse these roles without strong evidence that the separation is wrong.
