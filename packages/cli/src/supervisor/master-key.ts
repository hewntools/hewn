// SPDX-License-Identifier: AGPL-3.0-or-later
// The secrets master key: generated once per Hewn home, kept outside it. The supervisor hands it
// to workerd at start; Hewn's own data dir only ever holds ciphertext.
//   macOS: the login Keychain (service "hewn-master", account = the home's real path)
//   Linux: libsecret via `secret-tool` when a keyring actually answers (a desktop session), else a
//          0600 file next to the data (<home>/master.key) — see the self-host threat model.
// A home keeps the place its key is in: one with a master.key file goes on using it, even if a
// keyring turns up later (a new key there couldn't decrypt the secrets the old one encrypted).
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
  if (r.status !== 0) {
    throw new Error(
      `can't store the secrets key with secret-tool: ${r.stderr.trim()}. If this machine has no keyring (WSL, a server), remove libsecret-tools or set HEWN_KEY_SOURCE=file, then restart Hewn.`,
    );
  }
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

/**
 * Whether a keyring answers `secret-tool`. Installed isn't enough: on WSL and servers there's a
 * session bus but no Secret Service, and every call fails with "Could not connect".
 */
export function keyringAnswers(run = (args: string[]) => spawnSync("secret-tool", args, { encoding: "utf8", timeout: 5000 })): boolean {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  // A lookup for something that isn't there: exit 1 and no message when the keyring answers.
  const r = run(["lookup", "service", SERVICE, "probe", "hewn"]);
  return !r.error && (r.status === 0 || r.status === 1) && !(r.stderr ?? "").trim();
}

export function defaultKeySource(root?: string): KeySource {
  const forced = process.env.HEWN_KEY_SOURCE;
  if (forced === "keychain" || forced === "libsecret" || forced === "file") return forced;
  if (platform() === "darwin") return "keychain";
  if (root && existsSync(join(root, "master.key"))) return "file";
  return keyringAnswers() ? "libsecret" : "file";
}

/** The base64 AES-256 key for this Hewn home. */
export function masterKey(root: string, source: KeySource = defaultKeySource(root)): { key: string; source: KeySource } {
  const account = realpathSync(root);
  if (source === "keychain") return { key: keychain(account), source };
  if (source === "libsecret") return { key: libsecret(account), source };
  return { key: file(root), source };
}
