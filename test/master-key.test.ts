// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the secrets key lives on Linux: in a keyring only when one answers (WSL and servers have a
// session bus but no Secret Service), and a home with a master.key file keeps it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultKeySource, keyringAnswers } from "@hewntools/cli/supervisor/master-key.ts";

const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const ran = (status: number | null, stderr = "", error?: Error) => () => ({ status, stderr, error }) as any;

test("a keyring counts only when it answers secret-tool", () => {
  withEnv({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, () => {
    assert.equal(keyringAnswers(ran(1)), true, "nothing found, no complaint: it answered");
    assert.equal(keyringAnswers(ran(0)), true);
    assert.equal(keyringAnswers(ran(1, "secret-tool: Could not connect: No such file or directory")), false, "WSL: a bus, no Secret Service");
    assert.equal(keyringAnswers(ran(null, "", new Error("ENOENT"))), false, "secret-tool not installed");
  });
  withEnv({ DBUS_SESSION_BUS_ADDRESS: undefined }, () => assert.equal(keyringAnswers(ran(1)), false, "no session bus"));
});

test("a home with a master.key file keeps using it; HEWN_KEY_SOURCE wins", { skip: process.platform === "darwin" && "macOS always uses the Keychain" }, () => {
  const root = mkdtempSync(join(tmpdir(), "hewn-key-"));
  try {
    writeFileSync(join(root, "master.key"), "x\n");
    withEnv({ HEWN_KEY_SOURCE: undefined }, () => assert.equal(defaultKeySource(root), "file"));
    withEnv({ HEWN_KEY_SOURCE: "libsecret" }, () => assert.equal(defaultKeySource(root), "libsecret"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
