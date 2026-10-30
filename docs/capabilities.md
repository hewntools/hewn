# Writing and modifying tools

You normally don't write tools by hand. You describe what you want (**New** on Home, or ask an agent), and Hewn's builder writes it ([Building tools](building-tools.md)). This page describes what the builder produces, for when you want to read it, change it, or write one yourself. In the manifest and the ABI, a tool is a *capability*.

**The full contract is [`spec/builder-brief.md`](../spec/builder-brief.md).** It's exactly what the builder reads. In short:

## Layout

```
capability.json      the manifest: id, name, purpose, hue, operations, requires, ui
src/index.ts         the implementation (bundled with its npm dependencies)
package.json         optional: npm dependencies (registry versions only; must run in a Workers-like isolate)
migrations/NNN_*.sql the database schema (SQLite), append-only
tests/cases.json     test cases Hewn runs before promoting a version
ui/icon.svg          a 5×5 pixel glyph for Home
ui/index.html        optional: the tool's own UI
```

## Operations

```ts
export const operations = {
  "record_run@1": (input: { distanceKm: number }, ctx) => {
    ctx.db.prepare("INSERT INTO runs (distance_km) VALUES (?)").run(input.distanceKm);
    return { ok: true };
  },
};
```

- `ctx.db` is the tool's own SQLite database. It's synchronous; use `ctx.db.transaction(fn)` to group writes.
- `ctx.secrets`, `ctx.call(id, "op@1", input)` (another capability) and `fetch` are available, but only for what the manifest declares under `requires` and you've granted.
- Input and output are validated against each operation's JSON Schemas.

## Rules Hewn enforces

- **Contracts don't break.** A published `name@version` keeps its inputs, outputs and side effect. A breaking change is a new `name@2`, next to the old one.
- **Migrations are append-only**, and never destroy data: no `DROP`, `DELETE FROM` or `TRUNCATE`. Before a version is promoted, they're dry-run on a copy of your live data, and the data is backed up before they're applied.
- **Tests pass before promotion.** The UI is rendered headlessly, on a desktop screen and a phone's, in light and dark, and must load without errors on both.

## Changing one

Use **Change…** on the tool, or ask an agent ("add a weekly streak to the habit tracker"). The builder gets the current version and your request, and the same checks apply. If it breaks something you notice later, restore the version before it (**Versions**, or `hewn rollback <id>`).

## Installing one you wrote

```sh
hewn install path/to/my-capability
```

It goes through the same validation as a built one.

## Examples

Three small tools in the repo's [`seeds/`](../seeds) are meant to be read and copied (Apache-2.0):

- [Running Log](../seeds/running-log): operations, a migration and test cases, nothing more
- [Reading List](../seeds/reading-list): a widget, and an operation marked `destructive`
- [Habits](../seeds/habits): a widget with a button that runs a write operation

From a checkout of the repo: `hewn install seeds/habits`.

**Sample data** (`sample/calls.json`) is the tool in use: calls to its operations that fill an empty tool with made-up entries. Hewn replays it when someone installs the tool with sample data, and before every version goes live, and needs it to share the tool. See [the tool spec](../spec/tools.md#sample-data-since-25).

## Reference

The manifest and the ABI (the module, `ctx`, environment, versions) are described in full in [capability-model.md](../spec/capability-model.md#capability-manifest). Hewn implements ABI 2.4. A capability declares the lowest version it needs in `"abi"`; minor versions only add, so a capability built for 2.0 keeps running.