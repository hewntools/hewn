// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
type Ctx = { db: DatabaseSync };
const count = (db: DatabaseSync) => (db.prepare("SELECT n FROM counter WHERE id = 1").get() as { n: number }).n;
export const operations = {
  "increment@1": (_: unknown, { db }: Ctx) => (db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1").run(), { count: count(db) }),
  "get@1": (_: unknown, { db }: Ctx) => ({ count: count(db) }),
};
