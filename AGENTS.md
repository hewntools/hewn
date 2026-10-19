# Agent instructions

For coding agents working on Hewn itself. People read [CONTRIBUTING.md](CONTRIBUTING.md); everything there applies to you too (tests, SPDX headers, DCO sign-off, style).

## Read first

Before an architectural change, read:

1. [`VISION.md`](VISION.md): what Hewn is for
2. [`spec/capability-model.md`](spec/capability-model.md): the capability contract
3. [`docs/internal/security-and-authority.md`](docs/internal/security-and-authority.md): who may do what, and the invariants that enforce it
4. [`docs/internal/architecture.md`](docs/internal/architecture.md): what exists today
5. [`docs/internal/target-architecture.md`](docs/internal/target-architecture.md): where it's going

`architecture.md` describes what's built; keep it true when you change the code. `target-architecture.md` is the direction: don't rewrite it to match a shortcut. If you take a shortcut that departs from the target or the security model, say so in the pull request, with why and what it would take to remove it.

## Don't change silently

These are Hewn's foundations. If the code suggests one of them is wrong, say so and stop; don't work around it:

- what a capability is, and that its identity is stable
- each capability's state is its own: everything else goes through its operations
- a published operation contract (`name@version`) never changes
- the boundary between agents and the platform: agents propose, the owner approves
- no actor can widen its own authority
- builders propose and the platform promotes; the builder and the runtime are replaceable
- the ABI only adds within a major version ([`spec/README.md`](spec/README.md#versions))

Claude Code is a builder, not part of the domain model. MCP is how agents connect, not the product. SQLite and workerd are today's implementation, not the concept. A capability with a UI is still a capability, and one without a UI is equally valid.

## Working principles

- The simplest change that does the job. No speculative abstractions, no features ahead of need.
- When unsure, pick what's easiest to reverse. If a decision is hard to reverse and changes the product model, stop and ask.
- Tests come with the change: `npm test` and `npm run typecheck` pass before you're done.
- The web client is plain DOM with a strict CSP: no `innerHTML` or other HTML sinks, no inline script (`test/web.test.ts` checks).
- Owner-facing copy says "tool" (not "capability"), "connection", and "Accounts" for the page; sentence case, verbs on buttons, no emoji, no exclamation marks.
- Never touch a running Hewn's data: develop against your own `HEWN_HOME` and `HEWN_PORT`.
