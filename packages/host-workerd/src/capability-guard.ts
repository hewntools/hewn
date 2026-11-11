// SPDX-License-Identifier: AGPL-3.0-or-later
// The first module evaluated in every capability's Dynamic Worker, before the capability's own
// bundle: it sets the size limit of each state's SQLite and keeps the capability's code from
// changing it.
//
// The limit is SQLite's max_page_count, which SQLite checks on every write that needs a new page,
// whatever the code that writes. Capability code can't run that pragma (workerd's SQL authorizer
// refuses it); workerd offers it only as `sql.setMaxPageCountForTest`, to code run with the
// "experimental" flag, which these isolates have for this. `lockStorage` takes that method off
// SqlStorage's prototype the first time a facet starts here, before any capability code holds a
// storage object, and keeps it to itself; with it go the other members the flag adds to storage,
// and `facets` (each facet would be a database of its own). Capability code can import this module
// and patch any global: everything used here once that code has run was captured when this module
// was evaluated, a state that workerd didn't make is refused (DurableObject's constructor checks),
// and calling `lockStorage` again only applies the same limit.
import { DurableObject } from "cloudflare:workers";
// @ts-expect-error provided at load time: this isolate's limit in bytes (`export default <n>`)
import LIMIT from "./hewn-limit.js";

/** SQLite's page size in workerd. */
const PAGE = 4096;

const apply = Reflect.apply;
const construct = Reflect.construct;
const State = DurableObject;
const protoOf = Object.getPrototypeOf;
const own = Object.getOwnPropertyDescriptor;
const floor = Math.floor;
const has = WeakSet.prototype.has;
const add = WeakSet.prototype.add;
const Failure = Error;
const pages = Math.max(1, floor(Number(LIMIT) / PAGE));
const limited = new WeakSet<object>();

/** Members taken off each new state's objects: the experimental flag's, and nested facets. */
const INSTANCE: [string, string[]][] = [
  ["ctx", ["facets", "primaryStub"]],
  ["storage", ["primary"]],
];
/** Methods taken off the prototypes, once per isolate. */
const PROTOTYPE: [string, string[]][] = [
  ["sql", ["setMaxPageCountForTest", "ingest", "prepare"]],
  ["storage", ["snapshot", "waitForBookmark", "onNextSessionRestore", "deleteAll"]],
];

let setMax: ((pages: number) => void) | undefined;

/** Delete `names` from `on` and check they're gone (a member that stays means no limit can hold). */
function strip(on: Record<string, unknown>, names: string[]) {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (own(on, name)) delete on[name];
    if (own(on, name)) throw new Failure(`can't limit this tool's data: ${name} stays`);
  }
}

/** Limit the database of the facet being constructed (call before `super`). */
export function lockStorage(ctx: DurableObjectState): void {
  // Throws unless workerd made `ctx` (a look-alike would hand over a look-alike setMaxPageCountForTest).
  construct(State, [ctx, {}]);
  // Own data properties of objects made for this facet: nothing else has seen them yet.
  const storage = ctx.storage as unknown as Record<string, unknown>;
  const sql = storage.sql as Record<string, unknown>;
  const objects: Record<string, Record<string, unknown>> = { ctx: ctx as unknown as Record<string, unknown>, storage, sql };
  for (let i = 0; i < INSTANCE.length; i++) strip(objects[INSTANCE[i][0]], INSTANCE[i][1]);
  if (!setMax) {
    // The first facet in this isolate: the prototypes are as workerd made them.
    const found = own(protoOf(sql), "setMaxPageCountForTest")?.value;
    if (typeof found !== "function") throw new Failure("can't limit this tool's data: this workerd has no setMaxPageCountForTest");
    for (let i = 0; i < PROTOTYPE.length; i++) strip(protoOf(objects[PROTOTYPE[i][0]]), PROTOTYPE[i][1]);
    setMax = found as (pages: number) => void;
  }
  if (apply(has, limited, [sql])) return;
  apply(setMax, sql, [pages]);
  apply(add, limited, [sql]);
}
