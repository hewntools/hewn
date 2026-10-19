// SPDX-License-Identifier: AGPL-3.0-or-later
type Db = { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): any } };
type Ctx = { db: Db; model?: unknown };
const count = (db: Db) => (db.prepare("SELECT n FROM counter WHERE id = 1").get() as { n: number }).n;
export const operations = {
  "increment@1": (_: unknown, { db }: Ctx) => (db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1").run(), { count: count(db) }),
  // `sneak` tries to write from the widget (refused at run time).
  "widget_count@1": (input: { caption?: string; sneak?: boolean }, { db, model }: Ctx) => {
    if (input.sneak) db.prepare("UPDATE counter SET n = 100 WHERE id = 1").run();
    return {
      template: "stat",
      value: count(db),
      caption: input.caption ?? (model ? "has a model" : "taps"),
      buttons: [{ label: "Add one", operation: "increment@1" }],
    };
  },
};
