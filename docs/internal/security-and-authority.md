# Security and Authority Model

This document defines the intended trust and authority boundaries. The terms (capability, agent, builder, [grant](../../spec/capability-model.md#grant)) are defined in the [capability model](../../spec/capability-model.md); [`architecture.md`](architecture.md) says how Hewn enforces them today.

It does not prescribe a particular IAM or authorization product.

## Root authority

The user is the root authority of the personal Capability environment.

All authority exercised by Agents, Capabilities, Builders, and other clients derives from explicit or previously established user delegation.

Conceptually:

```text
User
  |
  | delegates
  v
Agent
  |
  | requests
  v
Platform
  |
  | authorizes and mediates
  v
Capability
```

## Agent authority

Agents should receive explicit scopes.

Initial conceptual scopes:

```text
discover
invoke
create
modify
manage
delete
```

Examples:

```text
Claude Code
  discover
  invoke
  create
  modify

Codex
  discover
  invoke
```

In Hewn the owner sets an agent's scopes when approving it, and may narrow them later; Hewn implements `discover`, `invoke`, `create` and `modify` ([Connecting an agent](../../spec/agents.md#scopes-and-mcp-tools)).

The important invariant is:

> An Agent cannot grant itself additional authority.

## Source access

Source code access is separate from normal Capability discovery and invocation.

An Agent that can invoke a Capability should not automatically receive its source.

A Builder may receive source as part of a scoped build job.

Source access should eventually be independently authorizable.

## State access

Raw Capability state is not part of the public interface.

Agents do not query internal databases or files.

Another Capability does not access internal state directly.

All state access occurs through explicit public operations.

This boundary is strict by design.

## Capability authority

A Capability may need access to:

- another Capability
- an Artifact
- an external API
- an external account
- a user-owned resource

Such access should be represented as explicit grants.

Conceptually:

```text
Capability A
    |
    | explicit grant
    v
Platform
    |
    v
Capability B
```

A Capability should not inherit broad user authority merely because the user owns it.

## External account connections

Connections to external services belong to the user.

Example:

```text
User
  |
  +-- Google account connection
  +-- GitHub account connection
  +-- banking connection
```

A Capability receives only the scope it needs.

Example:

```text
Finance Capability
  -> may read transaction history

Photo Capability
  -> no banking access
```

Deleting or disabling a Capability should not necessarily delete the user's underlying external account connection.

## Grant expansion

A new Capability version may continue using existing grants.

If a new version requires broader authority, that authority must not be silently added.

Example:

```text
v4:
  read calendar

v5:
  read calendar
  send email
```

`send email` is a new authority request and requires separate approval.

## Builder authority

A Builder's job is to create a candidate implementation.

This does not imply authority to:

- promote the version
- access production secrets
- mutate live state
- expand grants
- access unrelated Capabilities

A Builder should receive only the information needed for its build job.

Conceptually:

```text
Builder
  |
  +-- current source
  +-- current manifest
  +-- desired change
  +-- test fixtures
  +-- SDK/runtime documentation
```

The Platform remains responsible for promotion.

## Runtime authority

Runtime execution should occur using Capability-specific grants.

A runtime should not simply execute code with all user privileges.

Eventually, runtime credentials should be derived from or mediated by the platform's grant model.

## Side effects and risk

Operation manifests should classify side effects.

Initial conceptual classes:

```text
read
write
destructive
```

Future policy may become richer.

Examples:

```text
get_summary -> read
record_run -> write
delete_account -> destructive
```

Side-effect metadata informs authorization and approval behavior.

## Intent guard

The target architecture may include an intent guard that checks whether an operation appears consistent with the user's current intent.

An intent guard is defense in depth.

It is not sufficient authorization by itself.

For destructive or critical operations, platform policy should require stronger explicit approval even when an intent model believes the action is appropriate.

## Policy precedence

The platform is authoritative for access decisions.

An Agent may provide:

- requested action
- rationale
- user-context claims
- suggested risk classification

But these do not override platform policy.

A third-party Capability may declare that an action is low risk.

The platform may tighten that classification.

It should never blindly weaken policy based on an external declaration.

## Capability-to-Capability calls

All cross-Capability calls should be mediated by the platform.

Example:

```text
Travel Planner
      |
      | get_forecast(...)
      v
Capability Platform
      |
      | authorize
      v
Weather Capability
```

The caller receives only the callee's declared output.

It does not gain access to internal state.

## Revocation

The long-term model should support at least two kinds of revocation.

### Revoke Capability grant

Example:

> Running Capability may no longer access calendar.

This affects one Capability.

### Disconnect underlying account

Example:

> Disconnect Google account.

This invalidates all grants depending on that connection.

If the user later reconnects an account, previous Capability grants should not automatically reactivate without an explicit restoration decision.

Default should be conservative.

## Audit

Meaningful authority changes should eventually produce durable audit records.

Examples:

- Agent granted modify scope
- Capability granted calendar read access
- Capability version requested broader authority
- external account disconnected
- destructive action approved

The audit log need not record every harmless operation.

The target is useful authority provenance, not exhaustive surveillance.

### Failed calls (for "Ask builder to fix this")

The call log never keeps an operation's input. One exception, kept to what's needed: each tool's last ten failed calls keep the caller, the operation, the error, the input and the last log lines, so the owner can ask the builder to fix the tool with the context in it. The input is reduced first: stored secrets are redacted as in the log, values under credential-like names (password, token, secret, key, auth …) are masked, and it's cut at 2 KB. The sign-in step's failures aren't kept at all. Only the owner can read them (`GET /api/capabilities/:id/failures`); they leave with the call log's retention and when the tool is purged.

## Future authorization engine

A relationship-based authorization engine such as OpenFGA or Auth0 FGA may eventually be appropriate for representing relationships such as:

```text
user owns capability
agent may modify capability
capability may read artifact
capability may invoke capability
```

This is an implementation option, not a current architectural dependency.

The platform still owns:

- when grants are created
- when they are revoked
- which actions require approval
- semantic risk policy
- builder lifecycle
- promotion policy

An authorization engine answers relationship questions; it does not replace product-level authority semantics.

## Code from outside (a shared tool)

A tool installed from a file or from the Hub runs through the same validation and sandbox as a builder's: its manifest, its code bundled and loaded, its tests, its migrations, its UI rendered. Nothing in a bundle can grant itself anything: what its manifest asks for (hosts, a model, other tools' operations, secrets for a connection) is asked of the owner after install, one grant at a time, as for any new tool. A bundle never holds state, secrets, config values, the build's conversation or logs, and says nothing about whose Hewn it came from.

- **The reading is advisory.** The intake's summary (Hewn's for an Official tool, the owner's own builder's for a file) says what the code does with the owner's data and where it differs from what it says. It isn't a gate: the code is what runs, and the owner can read all of it before installing.
- **`source` is the platform's.** Where a tool came from is the capability's record; validation writes it into every version's manifest, replacing whatever a builder wrote, so a later change can't claim another origin.
- **Sample data runs with nothing granted.** Replayed after install (on the owner's request) and before every promotion, each call goes through the contract with no hosts, no other tools and no model.
- **Sharing scans first.** Before a tool is shared, its files are scanned: personal data and key shapes warn; an exact match of one of the owner's own stored values (any tool's secrets and settings, the model providers' keys) blocks the share.

## Security invariants

1. The user is the root authority.
2. Agents act under delegated scope.
3. Agents cannot expand their own scope.
4. Capabilities do not inherit the user's full authority.
5. Raw Capability state is private.
6. Source access is separate from invocation access.
7. Builders do not automatically receive runtime authority.
8. Builders cannot self-promote.
9. New Capability versions cannot silently broaden grants.
10. Cross-Capability interaction occurs through explicit public interfaces.
11. External account connections belong to the user.
12. Platform policy is authoritative over Agent claims.
13. Destructive actions require stronger controls than ordinary reads and writes.
