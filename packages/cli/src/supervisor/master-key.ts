// SPDX-License-Identifier: AGPL-3.0-or-later
// The secrets master key: generated once per Hewn home, kept outside it. The supervisor hands it
// to workerd at start; Hewn's own data dir only ever holds ciphertext.
//   macOS: the login Keychain (service "hewn-master", account = the home's real path)
//   Linux: libsecret via `secret-tool` when a desktop session is available, else a 0600 file
//          next to the data (<home>/master.key) — see the self-host threat model.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export type KeySource = "keychain" | "libsecret" | "file";

const SERVICE = "hewn-master";
const fresh = () => randomBytes(32).toString("base64");

function keychain(account: string): string {
  const found = spawnSync("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  const key = fresh();
  // Through `security -i` on stdin, so the key never appears in process arguments.
  const r = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s "${SERVICE}" -a "${account}" -l "Hewn secrets key" -w "${key}"\n`, encoding: "utf8" });
  if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`can't store the secrets key in the Keychain: ${r.stderr.trim()}`);
  return key;
}

function libsecret(account: string): string {
  const found = spawnSync("secret-tool", ["lookup", "service", SERVICE, "home", account], { encoding: "utf8" });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  const key = fresh();
  const r = spawnSync("secret-tool", ["store", "--label=Hewn secrets key", "service", SERVICE, "home", account], { input: key, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`can't store the secrets key with secret-tool: ${r.stderr.trim()}`);
  return key;
}

function file(root: string): string {
  const path = join(root, "master.key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = fresh();
  writeFileSync(path, key + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function defaultKeySource(): KeySource {
  const forced = process.env.HEWN_KEY_SOURCE;
  if (forced === "keychain" || forced === "libsecret" || forced === "file") return forced;
  if (platform() === "darwin") return "keychain";
  const hasSecretTool = spawnSync("sh", ["-c", "command -v secret-tool"], { encoding: "utf8" }).status === 0;
  return hasSecretTool && process.env.DBUS_SESSION_BUS_ADDRESS ? "libsecret" : "file";
}

/** The base64 AES-256 key for this Hewn home. */
export function masterKey(root: string, source: KeySource = defaultKeySource()): { key: string; source: KeySource } {
  const account = realpathSync(root);
  if (source === "keychain") return { key: keychain(account), source };
  if (source === "libsecret") return { key: libsecret(account), source };
  return { key: file(root), source };
}
