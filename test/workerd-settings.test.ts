// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings on the real workerd host with the host's builder (HEWN_BUILD_URL): it is the default,
// saving another setting doesn't store the defaults, and a builder stored that way is repaired on start.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("settings with the host's builder", () => {
  let h: TestHost;
  const settings = (change?: Record<string, unknown>) => h.sv.admin("settings", change);
  before(async () => {
    h = await startTestHost({ remote: { url: "http://127.0.0.1:9/", token: "t", label: "Test Cloud" } });
  });
  after(() => h.stop());

  test("the host's builder and intake are the default, also after saving another setting", async () => {
    assert.equal((await settings()).builder, "remote");
    assert.equal((await settings({ timeZone: "Europe/Stockholm" })).builder, "remote");
    const s = await settings();
    assert.deepEqual([s.builder, s.intake, s.timeZone], ["remote", "remote", "Europe/Stockholm"]);
  });

  test("a builder the owner didn't choose (stored by 0.4.2) is dropped on start; a chosen one stays", async () => {
    await settings({ builder: "claude", intake: "claude" });
    await h.sv.restart();
    let s = await settings();
    assert.deepEqual([s.builder, s.intake], ["remote", "remote"]);
    await settings({ builder: "claude", intake: "claude", jobsChosen: ["builder", "intake"] });
    await h.sv.restart();
    s = await settings();
    assert.deepEqual([s.builder, s.intake], ["claude", "claude"]);
  });
});
