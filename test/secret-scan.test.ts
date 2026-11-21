// SPDX-License-Identifier: AGPL-3.0-or-later
// The secret scan in validation: a known key shape in a tool's own files fails it, named by its file
// and line and never by its value; a long random string warns; npm's lockfile and made-up personal
// data in sample data do neither. One of the owner's stored keys fails every build, and only the owner
// learns where and which: an agent's check never looks, and an agent's build is told only that one is there.
// Sharing refuses a key shape as it refuses the owner's own keys: no Hewn would install it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER, WEB_USER } from "@hewntools/core/auth.ts";
import { bytes, contentHash, decodeVersion, encodeVersion } from "@hewntools/core/files.ts";
import type { FileEntry } from "@hewntools/core/platform.ts";
import { OWN_KEY_FOUND } from "@hewntools/core/platform/validation.ts";
import { KEY_LOCKED } from "@hewntools/core/platform/builds.ts";
import { installFrom, installSeed, SEED, setup } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));

/** A GitHub token's shape, made here so that no file in this repository holds one. */
const TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
/** A long random string: a key or a hash, nobody can tell. */
const RANDOM = "q8Zk3vN0pL2xR7tY9wB4mC6dF1hJ5sA0e";

/** A folder's files as a client sends them. */
function entriesOf(dir: string, rel = ""): FileEntry[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? entriesOf(dir, path) : [{ path, content: readFileSync(join(dir, path), "utf8") }];
  });
}
/** The running log's files with lines added to the end of one (or a file added). */
const plus = (path: string, ...lines: string[]): FileEntry[] => {
  const files = entriesOf(SEED);
  const had = files.some((f) => f.path === path);
  return had ? files.map((f) => (f.path === path ? { ...f, content: `${f.content}\n${lines.join("\n")}` } : f)) : [...files, { path, content: lines.join("\n") }];
};
/** The line the first added line lands on. */
const firstAdded = (path: string) => entriesOf(SEED).find((f) => f.path === path)!.content.split("\n").length + 1;

/** A lockfile as npm writes it: its integrity hashes look random. */
const LOCK = JSON.stringify(
  {
    name: "running-log",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "running-log" },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQBdKDyVvGzvh8Fts4hDsIwF5U2pLuGcuEPLQ2jKGIQr1d5Q==" },
    },
  },
  null,
  2,
);

describe("the secret scan", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("a client's check: a key shape fails, named by its file and line, never its value", async () => {
    const r = await t.platform.checkFiles(t.claude, { files: plus("src/index.ts", `// ${TOKEN}`), capabilityId: "running-log" });
    assert.equal(r.passed, false, r.text);
    const failure = r.failures.find((f) => /a key in its files/.test(f));
    assert.ok(failure, r.text);
    assert.match(failure, new RegExp(`src/index\\.ts:${firstAdded("src/index.ts")}: looks like a GitHub token`));
    assert.ok(!JSON.stringify(r).includes(TOKEN.slice(4)), "never the value, nor a part of it");
  });

  test("a long random string warns, once a file at its first line, and passes; the lockfile's hashes and made-up personal data don't", async () => {
    const files = [
      ...plus("src/index.ts", `// ${RANDOM}`, `// ${RANDOM.split("").reverse().join("")}`),
      { path: "package-lock.json", content: LOCK },
    ].map((f) => (f.path === "sample/calls.json" ? { ...f, content: f.content.replace(/"notes": "[^"]*"/, '"notes": "with anna.berg@example.com, +44 20 7946 0958"') } : f));
    const r = await t.platform.checkFiles(t.claude, { files, capabilityId: "running-log" });
    assert.equal(r.passed, true, r.text);
    assert.deepEqual(r.warnings, [{ check: "secret-scan", message: "2 long random strings, the first here: if it's a key, it belongs in a connection's secrets, not in the tool's files (a hash or an id can stay)", file: "src/index.ts", line: firstAdded("src/index.ts") }]);
    assert.match(r.text, /Warnings \(they don't fail it/);
    assert.ok(!JSON.stringify(r).includes(RANDOM), "never the value");
  });

  test("a submission with a key shape fails by file and line; one with a long random string is held with the warning on its card and in its log", async () => {
    const failed = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: plus("tests/notes.txt", "a fixture", `token: ${TOKEN}`), capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(failed.status, "failed");
    const seen = JSON.stringify(t.platform.getBuild(t.claude, failed.buildId));
    assert.match(seen, /tests\/notes\.txt:2: looks like a GitHub token/);
    assert.ok(!seen.includes(TOKEN.slice(4)), seen);
    assert.equal(t.platform.registry.getCapability("running-log")!.activeVersion, 1);

    const held = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: plus("tests/notes.txt", "a fixture", `hash: ${RANDOM}`), capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(held.status, "review", held.log.join("\n"));
    assert.deepEqual(held.review!.warnings?.map((w) => [w.check, w.file, w.line]), [["secret-scan", "tests/notes.txt", 2]]);
    assert.ok(held.log.some((l) => /warning: secret-scan: a long random string.*\(tests\/notes\.txt:2\)/.test(l)), held.log.join("\n"));
  });
});

/** One of the owner's stored keys: nothing shaped like a key, as a password or an account's own token may be. */
const STORED = "correct-horse-battery-staple-42";
const LABEL = "your Site Connection key (API_KEY)";

describe("the owner's stored keys", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    await installFrom(t.platform, resolve(import.meta.dirname, "fixtures/site-connection"));
    await t.platform.setSecret(USER, "site-connection", "API_KEY", STORED);
  });
  afterEach(() => t.cleanup());
  const holding = () => plus("tests/notes.txt", "a fixture", `password: ${STORED}`);

  test("a client's check never looks for them: it can't answer whether a guess is one", async () => {
    const r = await t.platform.checkFiles(t.claude, { files: holding(), capabilityId: "running-log" });
    assert.equal(r.passed, true, r.text);
    assert.ok(!JSON.stringify(r).includes("notes.txt:2") && !JSON.stringify(r).includes("Site Connection"), r.text);
  });

  test("a client's submission fails, telling the agent only that one is there; the owner's build log says where and which, never the value", async () => {
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: holding(), capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(b.status, "failed");
    const seen = JSON.stringify(t.platform.getBuild(t.claude, b.buildId));
    assert.ok(seen.includes(OWN_KEY_FOUND), seen);
    for (const leak of [STORED, "notes.txt:2", "Site Connection", "API_KEY"]) assert.ok(!seen.includes(leak), `${leak} in ${seen}`);
    const log = (await t.platform.buildTranscript(USER, b.buildId)) ?? "";
    assert.ok(log.includes(`tests/notes.txt:2: ${LABEL}`), log);
    assert.ok(!log.includes(STORED), "never the value, not even in the owner's log");
    assert.equal(t.platform.registry.getCapability("running-log")!.activeVersion, 1);
  });

  test("Hewn's builder on an agent's request: its check doesn't look; validation fails it the same way", async () => {
    const seen: string[] = [];
    t.queue((async (ws: string, job: { check?: (id: string) => Promise<unknown> }) => {
      writeFileSync(join(ws, "tests", "notes.txt"), `a fixture\npassword: ${STORED}\n`);
      seen.push(JSON.stringify(await job.check!("1")));
    }) as never);
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.ok(!seen[0].includes("notes.txt:2") && !seen[0].includes("Site Connection"), seen[0]);
    assert.equal(b.status, "failed");
    const view = JSON.stringify(t.platform.getBuild(t.claude, b.buildId));
    assert.ok(view.includes(OWN_KEY_FOUND) && !view.includes("notes.txt:2"), view);
  });

  test("the owner's own build: its check names the file, the line and which key; its failure, which an agent may read, says only that one is there", async () => {
    const seen: string[] = [];
    t.queue((async (ws: string, job: { check?: (id: string) => Promise<unknown> }) => {
      writeFileSync(join(ws, "tests", "notes.txt"), `a fixture\npassword: ${STORED}\n`);
      seen.push(JSON.stringify(await job.check!("1")));
    }) as never);
    const b = await t.platform.settle((await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.ok(seen[0].includes(`tests/notes.txt:2: ${LABEL}`) && !seen[0].includes(STORED), seen[0]);
    assert.equal(b.status, "failed");
    // An agent that can see the tool can read its builds: only the generic line.
    const view = JSON.stringify(t.platform.getBuild(t.claude, b.buildId));
    assert.ok(view.includes(OWN_KEY_FOUND), view);
    for (const leak of [STORED, "notes.txt:2", "Site Connection", "API_KEY"]) assert.ok(!view.includes(leak), `${leak} in ${view}`);
    const log = (await t.platform.buildTranscript(USER, b.buildId)) ?? "";
    assert.ok(log.includes(`tests/notes.txt:2: ${LABEL}`) && !log.includes(STORED), log);
  });

  test("what an agent is told of key shapes doesn't depend on the owner's keys: one that is a stored key is listed like any other", async () => {
    const shaped = (n: string) => `ghp_${n.repeat(5)}`;
    await t.platform.setSecret(USER, "site-connection", "API_KEY", shaped("Z9y8X7w6"));
    const submit = async (guess: string) => {
      const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: plus("tests/notes.txt", "fixtures", `one: ${shaped("Q1w2E3r4")}`, `two: ${guess}`), capabilityId: "running-log", request: "fixtures" })).buildId);
      const v = t.platform.getBuild(t.claude, b.buildId);
      return { id: b.buildId, said: JSON.stringify({ status: v.status, failure: v.failure, log: v.log }).replaceAll(b.buildId, "BUILD") };
    };
    const unmatched = await submit(shaped("M5n6B7v8"));
    const matched = await submit(shaped("Z9y8X7w6"));
    assert.equal(matched.said, unmatched.said);
    // What it does learn is the lockout: one bit, after which it builds nothing until the owner looks.
    assert.deepEqual(Object.keys(t.platform.keyLocks(USER)), ["claude-code"]);
    assert.match(matched.said, /tests\/notes\.txt:3: looks like a GitHub token/);
    // The owner's log has it all the same, though the shapes failed it first.
    assert.ok(((await t.platform.buildTranscript(USER, matched.id)) ?? "").includes(`tests/notes.txt:3: ${LABEL}`));
    assert.ok(!((await t.platform.buildTranscript(USER, unmatched.id)) ?? "").includes(LABEL));
  });

  test("an agent whose build held one is locked out of building until the owner has looked; the owner's own build locks nobody", async () => {
    const hit = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: holding(), capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(hit.status, "failed");
    assert.deepEqual(Object.keys(t.platform.keyLocks(USER)), ["claude-code"]);
    assert.equal(t.platform.keyLocks(USER)["claude-code"].buildId, hit.buildId);
    assert.throws(() => t.platform.keyLocks(t.claude), (e: { code?: string }) => e.code === "forbidden");
    const locked = (e: unknown) => (e as { code?: string; message?: string }).code === "forbidden" && (e as Error).message === KEY_LOCKED;
    await assert.rejects(t.platform.submitFiles(t.claude, { files: entriesOf(SEED), capabilityId: "running-log", request: "again" }), locked);
    await assert.rejects(t.platform.modify(t.claude, { capabilityId: "running-log", request: "again" }), locked);
    await assert.rejects(t.platform.retryBuild(t.claude, hit.buildId), locked);
    assert.equal((await t.platform.checkFiles(t.claude, { files: entriesOf(SEED), capabilityId: "running-log" })).passed, true, "a check still runs: it never looks for the owner's keys");
    assert.throws(() => t.platform.acknowledgeKeyLock(t.claude, "claude-code"), (e: { code?: string }) => e.code === "forbidden");
    t.platform.acknowledgeKeyLock(USER, "claude-code");
    assert.deepEqual(t.platform.keyLocks(USER), {});
    const again = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: entriesOf(SEED).map((f) => (f.path === "capability.json" ? { ...f, content: f.content.replace("durable", "lasting") } : f)), capabilityId: "running-log", request: "again" })).buildId);
    assert.equal(again.status, "review", again.log.join("\n"));
    // The owner's own build with one in it: failed, nobody locked.
    t.queue((ws: string) => writeFileSync(join(ws, "tests", "notes.txt"), `password: ${STORED}\n`));
    const own = await t.platform.settle((await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "a fixture" })).buildId);
    assert.equal(own.status, "failed");
    assert.deepEqual(t.platform.keyLocks(USER), {});
  });

  test("settings' values are never looked for: a city in a tool's files is no key", async () => {
    t.platform.registry.setConfig("running-log", "CITY", "Bergen city centre", "user");
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: plus("tests/notes.txt", "Runs around Bergen city centre"), capabilityId: "running-log", request: "a note" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
  });
});

test("sharing refuses a key shape, naming its file and line, as it refuses the owner's own keys", async () => {
  const t = setup();
  try {
    await installSeed(t.platform);
    // A version kept before the scan, its test holding a fake token: written as an earlier Hewn would have kept it.
    const row = t.platform.registry.getVersion("running-log", 1)!;
    const kept = decodeVersion((await t.platform.blobs.get(`versions/${row.contentHash}.json`))!);
    const files = { ...kept.files, "tests/notes.txt": bytes(`fixtures\ntoken: ${TOKEN}\n`) };
    const hash = contentHash(files, kept.bundle);
    await t.platform.blobs.put(`versions/${hash}.json`, encodeVersion(hash, files, kept.bundle));
    t.platform.registry.insertVersion({ capabilityId: "running-log", version: 2, manifest: row.manifest, contentHash: hash, buildId: row.buildId });
    const check = await t.platform.shareCheck(USER, "running-log", 2);
    assert.deepEqual(check.blocked, { kind: "key", file: "tests/notes.txt", line: 2, label: "Looks like a GitHub token" });
    assert.ok(check.findings.find((f) => f.file === "tests/notes.txt")?.blocks);
    await assert.rejects(t.platform.shareBundle(USER, "running-log", 2), /tests\/notes\.txt:2 looks like a GitHub token\. Remove it, then share again \(a tool with a key in it doesn't install anywhere\)/);
    await assert.rejects(t.platform.createShareLink(USER, "running-log", { version: 2 }), /looks like a GitHub token/);
  } finally {
    t.cleanup();
  }
});

test("npm's lockfile and binary files are scanned for key shapes too (only long random strings are let off in the lockfile)", async () => {
  const t = setup();
  try {
    await installSeed(t.platform);
    const lock = JSON.stringify({ name: "running-log", lockfileVersion: 3, packages: { "": { name: "running-log" } }, note: TOKEN });
    const locked = await t.platform.checkFiles(t.claude, { files: [...entriesOf(SEED), { path: "package-lock.json", content: lock }], capabilityId: "running-log" });
    assert.ok(locked.failures.some((f) => f.includes("package-lock.json:1: looks like a GitHub token")), locked.text);
    const blob = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`\n${TOKEN}`), Buffer.from([0])]).toString("base64");
    const binary = await t.platform.checkFiles(t.claude, { files: [...entriesOf(SEED), { path: "ui/blob.bin", content: blob, encoding: "base64" }], capabilityId: "running-log" });
    assert.ok(binary.failures.some((f) => f.includes("ui/blob.bin:2: looks like a GitHub token")), binary.text);
  } finally {
    t.cleanup();
  }
});

test("hewn share on a key shape: the finding marked ✖, the reason said, nothing written", async () => {
  const home = mkdtempSync(join(tmpdir(), "hewn-cli-share-"));
  const finding = { file: "tests/notes.txt", line: 2, kind: "key", label: "Looks like a GitHub token", masked: "ghp_••••", blocks: true };
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    req.resume();
    req.on("end", () => res.setHeader("content-type", "application/json").end(JSON.stringify({ check: { name: "Running Log", version: 1, files: 6, sample: { calls: 3 }, findings: [finding], blocked: { kind: "key", file: finding.file, line: finding.line, label: finding.label } } })));
  }).listen(0, "127.0.0.1");
  try {
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(home, "supervisor.json"), JSON.stringify({ url, adminToken: "t", control: { url, token: "t" }, pid: 1 }));
    const run = await new Promise<{ code: number; out: string; err: string }>((done) =>
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "share", "running-log", "--out", join(home, "x.zip")], { env: { ...process.env, HEWN_HOME: home } }, (e, out, err) => done({ code: (e as { code?: number } | null)?.code ?? 0, out, err })),
    );
    assert.equal(run.code, 1, run.err);
    assert.match(run.out, /✖ tests\/notes\.txt:2 {2}Looks like a GitHub token: ghp_••••/);
    assert.match(run.err, /✖ keys are in it \(✖ above: tests\/notes\.txt:2\)\. Remove them, then share again\./);
    assert.ok(!existsSync(join(home, "x.zip")));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
