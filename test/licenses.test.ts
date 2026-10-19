// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// LICENSING.md: Apache-2.0 for spec/, packages/ui and seeds/; AGPL-3.0-or-later for the rest.
const ROOT = join(import.meta.dirname, "..");
const APACHE = ["spec/", "packages/ui/", "seeds/"];
const expected = (path: string) => (APACHE.some((p) => path.startsWith(p)) ? "Apache-2.0" : "AGPL-3.0-or-later");

test("every source file names its licence in an SPDX header, matching its folder", () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "packages", "spec", "seeds", "test", "install.sh"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|js|mjs|css|sh)$/.test(f) && existsSync(join(ROOT, f)));
  assert.ok(files.length > 100);
  const wrong = files.flatMap((f) => {
    const head = readFileSync(join(ROOT, f), "utf8").split("\n").slice(0, 2).join("\n");
    const found = /SPDX-License-Identifier: ([\w.-]+)/.exec(head)?.[1];
    return found === expected(f) ? [] : [`${f}: ${found ?? "no header"} (expected ${expected(f)})`];
  });
  assert.deepEqual(wrong, []);
});

test("every package carries its licence text and declares it", () => {
  const AGPL = readFileSync(join(ROOT, "LICENSE"), "utf8");
  const apache = readFileSync(join(ROOT, "spec", "LICENSE"), "utf8");
  assert.match(AGPL, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.match(apache, /Apache License\s+Version 2\.0/);
  for (const dir of ["spec", "packages/core", "packages/host-workerd", "packages/ui", "packages/cli", "packages/test-host", "seeds"]) {
    const want = expected(dir + "/");
    assert.equal(readFileSync(join(ROOT, dir, "LICENSE"), "utf8"), want === "Apache-2.0" ? apache : AGPL, `${dir}/LICENSE`);
    if (existsSync(join(ROOT, dir, "package.json"))) assert.equal(JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).license, want, `${dir}/package.json`);
  }
  assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license, "AGPL-3.0-or-later");
});
