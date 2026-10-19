# Repo layout

```
spec/                     Apache-2.0   @hewntools/spec          the capability contract: docs, types, JSON Schemas
packages/
  core/                   AGPL         @hewntools/core          the platform logic, pure
  host-workerd/           AGPL         @hewntools/host-workerd  what runs inside workerd, and the web client
  ui/                     Apache-2.0   @hewntools/ui            the UI kit tool UIs load from /_platform/
  cli/                    AGPL         @hewntools/cli           `hewn`: CLI, supervisor, setup, builders, intake
  test-host/              AGPL         @hewntools/test-host     the core on Node, for fast tests
seeds/                    Apache-2.0                            example tools
test/                                                           integration tests across packages
scripts/                                                        the npm build, and the one-line install served by hewn.tools
docs/                                                           user docs; docs/internal/ for contributors
design/                                                         design references for the web client
```

The licence line runs along the packages: the spec and the UI kit, which tools build on, are Apache-2.0; everything that runs Hewn is AGPL-3.0-or-later ([`LICENSING.md`](../../LICENSING.md)). What each package does is in [architecture.md](architecture.md#packages).

## Who may depend on whom

| Package | May import | Other imports |
| --- | --- | --- |
| `spec` | nothing | none |
| `core` | `spec` | `@cfworker/json-schema` only |
| `host-workerd` | `spec`, `core` | `cloudflare:*`, `node:async_hooks`, the MCP SDK, `zod` |
| `ui` | nothing | none |
| `cli` | `spec`, `core`, `host-workerd`, `ui` | anything |
| `test-host` | `spec`, `core`, `host-workerd`, `ui`, `cli` | anything |

`core` and `host-workerd` run on workerd, so they may not reach for Node or for the CLI's code. `cli` bundles the Worker and serves the web client and the UI kit. `test-host` reuses the CLI's home, config, backup, workbench and intake code in-process; the CLI never uses the test host.

`test/package-rules.test.ts` checks this table. Packages import each other by name (`@hewntools/core/platform.ts`), through npm workspaces, with each package's `exports` pointing at its `.ts` sources; a relative import may not leave its package.

## Publishing

Only `@hewntools/cli` (binary `hewn`) and `@hewntools/spec` are published to npm. The CLI is bundled to JavaScript at publish time with the other packages inside, since Node won't run TypeScript from `node_modules`. The other packages are `private` workspace packages. See [releasing.md](releasing.md).
