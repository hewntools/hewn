// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleProblem, newestInLine } from "@hewntools/cli/upgrade.ts";

test("upgrade target: the newest release in the same 0.x line; stable beats its pre-releases", () => {
  const tags = ["v0.2.0", "v0.1.10", "v0.1.2", "v0.1.2-rc.1", "v0.1.1", "v0.1.0-rc.2", "v0.1.0-rc.10"];
  assert.equal(newestInLine("0.1.0", tags), "v0.1.10");
  assert.equal(newestInLine("0.1.0-rc.1", ["v0.1.0-rc.2", "v0.1.0-rc.10"]), "v0.1.0-rc.10");
  assert.equal(newestInLine("0.1.0", ["v0.1.0-rc.3", "v0.1.0"]), "v0.1.0");
  assert.equal(newestInLine("0.3.0", tags), undefined);
});

test("this install builds the workerd host", async () => {
  assert.equal(await bundleProblem(), undefined);
});
