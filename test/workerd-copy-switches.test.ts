// SPDX-License-Identifier: AGPL-3.0-or-later
// The switches for a copy of someone's Hewn (a smoke run, a restore drill) on the workerd host: HEWN_SCHEDULES=off
// (no schedule runs, the alarm included) and HEWN_NETWORK (off: nothing goes out; get: tools' GET and HEAD only, so a
// call can read but never post).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { copySwitchesFromEnv } from "@hewntools/cli/supervisor/index.ts";
import { FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async (h: TestHost) => (await fetch(`${h.sv.control.url}/control/status`, { method: "POST", headers: { "x-hewn-control": h.sv.control.token } })).json();

describe("HEWN_SCHEDULES and HEWN_NETWORK are read strictly", () => {
  test("off, get, on or unset; a typo is refused rather than leaving a copy's schedules or network on", () => {
    assert.deepEqual(copySwitchesFromEnv({}), {});
    assert.deepEqual(copySwitchesFromEnv({ HEWN_SCHEDULES: "on", HEWN_NETWORK: "on" }), {});
    assert.deepEqual(copySwitchesFromEnv({ HEWN_SCHEDULES: "off", HEWN_NETWORK: "off" }), { schedulesOff: true, network: "off" });
    assert.deepEqual(copySwitchesFromEnv({ HEWN_NETWORK: "get" }), { network: "get" });
    assert.throws(() => copySwitchesFromEnv({ HEWN_SCHEDULES: "0" }), /HEWN_SCHEDULES must be off/);
    assert.throws(() => copySwitchesFromEnv({ HEWN_NETWORK: "GET" }), /HEWN_NETWORK must be off or get/);
  });
});

describe("a copy with schedules off and the network at GET only (workerd host)", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost({ schedulesOff: true, network: "get" });
    for (const [id, name] of [["probe", "Probe"], ["runaway", "Runaway"]]) {
      const r = await h.sv.admin("install", { name, purpose: "test", dir: join(FIXTURES, id), wait: true });
      assert.equal(r.status, "promoted", r.log.join("\n"));
    }
    await h.sv.admin("approve", { capabilityId: "probe" });
  });
  after(() => h?.stop());

  test("the supervisor says so, and the configs carry it", async () => {
    const st = await status(h);
    assert.equal(st.schedules, "off");
    assert.equal(st.network, "get");
    const data = join(h.root, "workerd");
    assert.match(readFileSync(join(data, "config.capnp"), "utf8"), /\(name = "SCHEDULES", text = "off"\)/);
    assert.match(readFileSync(join(data, "config.capnp"), "utf8"), /\(name = "internet", network = \(allow = \[\]/, "the platform's own fetches are off");
    assert.match(readFileSync(join(data, "tools.capnp"), "utf8"), /\(name = "NETWORK", text = "get"\)/);
  });

  test("no tunnel starts on a copy", async () => {
    const res = await fetch(`${h.sv.control.url}/control/tunnel`, { method: "POST", headers: { "x-hewn-control": h.sv.control.token, "content-type": "application/json" }, body: JSON.stringify({ action: "start", tunnel: { kind: "cloudflared" } }) });
    assert.notEqual(res.status, 200);
    assert.match(await res.text(), /no tunnel here: this Hewn's network is off/);
  });

  test("a POST from a tool is refused before it's sent, even to its approved host", async () => {
    const r = (await h.invoke("probe", "probe", { what: "post" })).result;
    assert.deepEqual(r, { ok: true, value: "denied" });
    // A GET to the approved host goes through the gate (what the remote answers, or being offline, is its business).
    const get = (await h.invoke("probe", "probe", { what: "declared" })).result;
    assert.ok(get.value !== "denied", JSON.stringify(get));
    assert.deepEqual((await h.invoke("probe", "probe", { what: "undeclared" })).result, { ok: true, value: "denied" });
  });

  // Run now is refused in the core (schedules.test.ts).
  test("an active schedule made due doesn't run: not by the alarm, not by a resume", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "copy" }, cadence: "hourly" });
    assert.equal(s.status, "active");
    await h.sv.admin("schedules/fire", { id: s.id });
    await h.sv.admin("resumed", {});
    await sleep(500);
    assert.equal((await h.invoke("runaway", "count")).result.rows.copy ?? 0, 0);
    const after = (await h.sv.admin("schedules", { capabilityId: "runaway" })).find((x: any) => x.id === s.id);
    assert.equal(after.lastRunAt, null);
  });
});

describe("a copy with the network off (workerd host)", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost({ network: "off" });
    const r = await h.sv.admin("install", { name: "Probe", purpose: "test", dir: join(FIXTURES, "probe"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
    await h.sv.admin("approve", { capabilityId: "probe" });
  });
  after(() => h?.stop());

  test("even a GET to an approved host is refused, and schedules stay on unless asked", async () => {
    assert.deepEqual((await h.invoke("probe", "probe", { what: "declared" })).result, { ok: true, value: "denied" });
    assert.deepEqual((await h.invoke("probe", "probe", { what: "post" })).result, { ok: true, value: "denied" });
    const st = await status(h);
    assert.equal(st.network, "off");
    assert.equal(st.schedules, "on");
    assert.match(readFileSync(join(h.root, "workerd", "tools.capnp"), "utf8"), /\(name = "internet", network = \(allow = \[\]/);
  });
});
