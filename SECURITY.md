# Security

Hewn holds people's data, their secrets and authority delegated to AI agents, so security reports get priority.

## Reporting a problem

**Report privately, never in a public issue:**

- **GitHub:** this repository's Security tab → *Report a vulnerability* (a private advisory). Preferred.
- **Email:** security@hewn.tools.

Include what you did, what happened, what you expected, and the version (`hewn version`). A proof of concept helps; please don't access data that isn't yours or disrupt anyone else's Hewn to make one.

## What happens next

- **Within a week:** an answer that we got it, and a first assessment.
- **A fix** ships as a new release, with an advisory saying what was wrong, who's affected and what to do (usually `hewn upgrade`).
- **Disclosure is coordinated:** please give us 90 days, or until a fix is out if that's sooner, before publishing. You'll be credited in the advisory unless you'd rather not be.

Hewn is maintained by one person; we'll tell you honestly if something takes longer.

## In scope

The newest release line, and `main`:

- tool code, a builder, an agent, a tool UI or a website getting more than it should: escaping the isolate or sandbox, reaching hosts, data, operations or secrets it wasn't granted, or acting as the owner
- reading secrets, data or another tool's state you shouldn't
- getting around sign-in, OAuth, scopes, grants or the owner's approval and confirmation steps
- tool UIs breaking out of their sandbox (cookies, storage, the web client's origin)
- the spec (`spec/`) allowing something its invariants say a host must prevent

## Out of scope

- Known limits described in [`docs/threat-model.md`](docs/threat-model.md): for example, other programs running as the same operating-system user can act as you on Hewn.
- Problems that need an already compromised machine or account.
- A self-hosted Hewn exposed in ways the docs advise against (no TLS, the admin port on a network).
- Denial of service against your own Hewn, and reports from automated scanners without a demonstrated problem.

Hewn Cloud (the hosted service at cloud.hewn.tools) takes reports the same way.
