# Contributing to Hewn

Thanks for looking. Hewn is maintained in spare time, so the most useful contributions are small, focused and come with tests. For anything bigger than a fix, open an issue first and say what you want to change and why: it saves us both a pull request that can't be merged.

## What helps most

- **Bug reports** with what you did, what happened, what you expected, `hewn version` and `hewn doctor` output. Security problems go to [`SECURITY.md`](SECURITY.md), never to a public issue.
- **Fixes**, with a test that fails without them.
- **Docs**: wrong, missing or confusing things in `docs/` or `spec/`.
- **Tools**: if you built a tool others could use, share it as an issue or a discussion first; `seeds/` holds only a few examples.

Hewn says no to a lot on purpose: we can't maintain everything. Open a discussion before you build a feature: one that fits where Hewn is going has a much better chance than one that doesn't.

## Set up

Node 24 or newer, git, and on Linux `bubblewrap` (the builders' sandbox).

```sh
git clone https://github.com/hewntools/hewn.git && cd hewn
npm ci
npm run typecheck
npm test
```

Run a development Hewn on its own data and port, so it never touches an installed one:

```sh
HEWN_HOME=/tmp/hewn-dev HEWN_PORT=7817 node packages/cli/src/cli.ts serve
```

To use a checkout as your own Hewn (`hewn` on your PATH, data in `data/`, `hewn upgrade` following release tags): `./install.sh`. Users install the npm package instead ([`docs/quickstart.md`](docs/quickstart.md)); `npm run build:npm` builds it ([`docs/internal/releasing.md`](docs/internal/releasing.md)).

## Where things are

- `spec/`: the capability contract (`@hewntools/spec`): types, JSON Schemas, the docs for tool and agent authors. Read [`spec/README.md`](spec/README.md) before changing anything there.
- `packages/core`: the platform logic, pure (no Node, no workerd).
- `packages/host-workerd`: what runs inside workerd: the Worker, the capability runtime, the HTTP and MCP surface, the web client.
- `packages/cli`: `hewn`: the CLI, the supervisor, setup and builders.
- `packages/ui`: the UI kit tool UIs load from `/_platform/`.
- `packages/test-host`: an in-process host for fast tests.
- `test/`: the tests. `docs/`: how Hewn works and why ([`docs/internal/architecture.md`](docs/internal/architecture.md) is the map).

Who may depend on whom is in [`docs/internal/repo-layout.md`](docs/internal/repo-layout.md), checked by `test/package-rules.test.ts`.

## Changing the contract

The spec is versioned by the ABI, not by Hewn releases ([`spec/README.md`](spec/README.md#versions)). Minor versions only add: a new optional manifest field, a new `ctx` member, a new grant kind. Anything else is a new major and needs an issue first. An addition must say which version introduced it (in the types, `spec/src/abi.ts` and the docs), and `test/spec.test.ts` must pass. If you change `spec/src/schemas.ts`, run `npm run spec:schemas`.

## Licences

Your contribution is under the licence of the folder you change ([`LICENSING.md`](LICENSING.md)): Apache-2.0 for `spec/`, `packages/ui` and `seeds/`, AGPL-3.0-or-later for the rest. Every source file starts with its `SPDX-License-Identifier` line; new files need one too (`test/licenses.test.ts` checks).

## Sign your commits (DCO)

Hewn uses the [Developer Certificate of Origin](https://developercertificate.org) instead of a contributor licence agreement. By adding a `Signed-off-by` line to a commit you certify that you wrote it, or otherwise have the right to submit it under the folder's open-source licence:

```sh
git commit -s -m "Fix the thing"
```

The name and email must match the commit's author. A check on every pull request refuses unsigned commits; to sign ones you already made, `git rebase --signoff main` and force-push. There's no CLA, so Hewn can't be relicensed without the people who wrote it.

## Style

Write code like the code around it: its naming, comment density and idioms. Keep changes small and say why in the commit message. Docs are plain and direct: short sentences, what something is before why, no marketing.
