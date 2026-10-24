# The Hewn capability spec

What a Hewn tool (a [capability](capability-model.md#capability)) is, and the contract between a tool, the agents that use it and the host that runs it. Published as `@hewntools/spec`. Licensed [Apache-2.0](LICENSE), unlike the rest of Hewn (AGPL-3.0-or-later; see [`../LICENSING.md`](../LICENSING.md)): anyone may build tools on it or implement another host, without the AGPL applying to them.

## Contents

- [`tools.md`](tools.md): **Writing a tool.** The layout, the manifest, operations and their versions, the module and `ctx`, the runtime, migrations, tests and promotion, grants, connections, config, models, widgets and tool UIs, with a complete example.
- [`agents.md`](agents.md): **Connecting an agent.** The MCP endpoint, OAuth sign-in and the owner's approval, scopes and the MCP tools each unlocks, discovery, invoking operations, builds, schedules and widgets in the chat.
- [`capability-model.md`](capability-model.md): the concepts and invariants (capabilities, operations, versions, grants, ownership), and a summary of the manifest and the ABI.
- [`builder-brief.md`](builder-brief.md): the build contract, exactly as Hewn hands it to every builder (Claude Code, Codex). Written to the builder, and the most compact statement of a tool's layout and rules.
- [`src/`](src): the contract as TypeScript. `ctx.ts` (`Ctx`, `Db`, `Operations`), `manifest.ts` (`CapabilityManifest` and its parts), `widgets.ts` (widget view models), `model.ts` (`ctx.model.generate`), `cases.ts` (`tests/cases.json`), `abi.ts` (the version and its history), `schemas.ts`, and `agents.ts`: the agent contract (scopes, server instructions, and the MCP tools a host offers agents).
- [`schemas/`](schemas): JSON Schemas for `capability.json` and `tests/cases.json`, generated from `src/schemas.ts`.

The UI kit tool UIs load from `/_platform/` (`ui.css`, `session.js`, `widgets.js`, `chart.js`) is Apache-2.0 too: [`../packages/ui`](../packages/ui).

A tool uses the types with a type-only import, which disappears when the tool is bundled:

```ts
import type { Ctx } from "@hewntools/spec/ctx.ts";

export const operations = {
  "record_run@1"(input: { km: number }, { db }: Ctx) {
    db.prepare("INSERT INTO runs (km) VALUES (?)").run(input.km);
    return { ok: true };
  },
};
```

## Versions

The spec is versioned by the **ABI**, never by Hewn's releases. One version covers the whole contract: the manifest format, `ctx` and [grant](capability-model.md#grant) kinds.

- A tool declares the lowest ABI it needs in `capability.json` (`"abi": "2.2"`; none means 2.0). A host implements one major and runs every minor up to its own; it refuses a manifest that uses something newer than it declares.
- **Minor versions only add.** So this document, at 2.3, describes all of 2.x: every addition is marked with the minor that introduced it ("since 2.2"), here, in the types, and in `src/abi.ts` (`ABI_HISTORY`, `CTX_MEMBERS`).
- **A new major** is a breaking change. When ABI 3 arrives, the 2.x spec is frozen in `v2/` and stays published as `@hewntools/spec@2.x`; the current major lives here.
- `@hewntools/spec`'s version is the ABI: `2.4.x` describes ABI 2.4; the patch number is for fixes to the text, types or schemas that change nothing in the contract.

| ABI | Added |
| --- | --- |
| 2.0 | The module (`operations`), `ctx.db`, `ctx.secrets`, `ctx.updateSecret`, `ctx.call`, `ctx.caller`; operations, `requires` (hosts, capabilities), `ui`; `tests/cases.json` |
| 2.1 | Manifest `kind` ("connection") and `requires.secrets` (connections only); deprecated operations; manifest `config`, `ctx.config`, `config:NAME` hosts |
| 2.2 | Manifest `requires.model`; `ctx.model.generate` |
| 2.3 | Manifest `widgets`, and the widget view models their operations return |
| 2.4 | Manifest `saturation` |

2.0 replaced the pre-release 1.x, which no Hewn runs.

**Who reads what:** [`tools.md`](tools.md), [`agents.md`](agents.md) and [`capability-model.md`](capability-model.md) are written for people writing tools by hand, people building agents and MCP clients, and anyone implementing another host. [`builder-brief.md`](builder-brief.md) stays the literal prompt Hewn's builders get, addressed to them. The types and schemas are checked against Hewn by its tests (`test/spec.test.ts`).
