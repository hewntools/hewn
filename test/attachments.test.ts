// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { decodeVersion, toBase64 } from "@hewntools/core/files.ts";
import { editJson, SEED, setup } from "./helpers.ts";

const seed = (ws: string) => cpSync(SEED, ws, { recursive: true });
/** A 2×1 PNG. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+9AAAADklEQVQIW2P4z8DwHwAFAAH/yQ0wtQAAAABJRU5ErkJggg==";
const b64 = (s: string) => toBase64(new TextEncoder().encode(s));
/** Just a PNG's header (signature + IHDR), declaring a size: enough for the size check, not a picture. */
const pngHeader = (width: number, height: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return toBase64(b);
};

describe("attachments: images and files the owner attaches in the intake's box", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("checked and kept: an image with its pixels, a text file; the limits; owner only", async () => {
    const img = await t.platform.addAttachment(USER, { session: "s-1", kind: "image", name: "../shots/screen one.png", mediaType: "image/png", data: PNG });
    assert.match(img.ref, /^at-[\w-]+$/);
    assert.deepEqual({ ...img, ref: "" }, { ref: "", kind: "image", name: "screen-one.png", mediaType: "image/png", bytes: 70, width: 2, height: 1 });
    const file = await t.platform.addAttachment(USER, { session: "s-1", kind: "file", name: "notes.csv", mediaType: "text/csv", data: b64("plant,watered\nfern,2026-10-20\n") });
    assert.equal(file.kind, "file");
    assert.equal(file.width, undefined);
    const got = await t.platform.attachmentBytes(USER, img.ref);
    assert.equal(got.bytes.length, 70);
    assert.equal(got.meta.name, "screen-one.png");
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "image", name: "x.png", mediaType: "image/png", data: b64("not a png") }), /isn't a readable image\/png/);
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "image", name: "x.bmp", mediaType: "image/bmp", data: PNG }), /mediaType must be one of/);
    // The same pixel cap as a tool's model call: a small file can still declare a huge picture.
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "image", name: "wide.png", mediaType: "image/png", data: pngHeader(9000, 10) }), /9000×10; the limit is 8000 px per side/);
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "file", name: "x.bin", mediaType: "application/octet-stream", data: b64("ab\0cd") }), /files must be text/);
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "file", name: "big.txt", mediaType: "text/plain", data: b64("x".repeat(256 * 1024 + 1)) }), /at most 256 KB/);
    await assert.rejects(t.platform.addAttachment(USER, { session: "bad session!", kind: "file", name: "x.txt", mediaType: "text/plain", data: b64("x") }), /session/);
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "thing", name: "x", mediaType: "text/plain", data: b64("x") }), /kind must be/);
    await assert.rejects(t.platform.addAttachment(t.claude, { session: "s-1", kind: "file", name: "x.txt", mediaType: "text/plain", data: b64("x") }), /owner actions/);
    await assert.rejects(t.platform.attachmentBytes(t.claude, img.ref), /owner actions/);
    await assert.rejects(t.platform.attachmentBytes(USER, "at-nope"), /no attachment/);
    for (let i = 0; i < 9; i++) await t.platform.addAttachment(USER, { session: "s-1", kind: "image", name: `${i}.png`, mediaType: "image/png", data: PNG });
    await assert.rejects(t.platform.addAttachment(USER, { session: "s-1", kind: "image", name: "11.png", mediaType: "image/png", data: PNG }), /at most 10 images/);
  });

  test("a conversation carries refs; the build copies them into the workspace, lists them in the request, never into a version", async () => {
    const img = await t.platform.addAttachment(USER, { session: "s-2", kind: "image", name: "screen.png", mediaType: "image/png", data: PNG });
    const file = await t.platform.addAttachment(USER, { session: "s-2", kind: "file", name: "import.csv", mediaType: "text/csv", data: b64("a,b\n1,2\n") });
    const conversation = [
      { role: "user" as const, content: "a plant log like this screenshot, with this data", attachments: [{ ref: img.ref, kind: "file", name: "lies" }, { ref: file.ref }] },
      { role: "intake" as const, content: "DRAFT\nPlant Log" },
    ];
    let brief = "";
    let seen: Record<string, string> = {};
    const b = await t.build(
      () => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r", conversation: conversation as any }),
      (ws) => {
        brief = readFileSync(join(ws, "BUILDER.md"), "utf8");
        seen = Object.fromEntries(["attachments/1-screen.png", "attachments/2-import.csv"].map((p) => [p, existsSync(join(ws, p)) ? readFileSync(join(ws, p), "latin1").length.toString() : "missing"]));
        seed(ws);
      },
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.deepEqual(seen, { "attachments/1-screen.png": "70", "attachments/2-import.csv": "8" });
    assert.match(brief, /Requirements: r\n\nThe owner attached these, in this workspace[^]*- `attachments\/1-screen\.png`: an image, 2×1, attached with: "a plant log like this screenshot[^]*- `attachments\/2-import\.csv`: a text file, 1 KB/);
    // What they are comes from the store, not the client's words.
    const kept = t.platform.buildContext(USER, b.buildId).conversation![0].attachments!;
    assert.deepEqual(kept.map((a) => [a.ref, a.kind, a.name]), [[img.ref, "image", "screen.png"], [file.ref, "file", "import.csv"]]);
    const v = t.platform.registry.getVersion("running-log", 1)!;
    const files = Object.keys(decodeVersion((await t.platform.blobs.get(`versions/${v.contentHash}.json`))!).files);
    assert.ok(!files.some((f) => f.startsWith("attachments/")), `never part of a version: ${files.join(", ")}`);
    // Claimed by the build: a day's cleanup leaves them; an unclaimed one goes.
    const stray = await t.platform.addAttachment(USER, { session: "s-3", kind: "file", name: "stray.txt", mediaType: "text/plain", data: b64("x") });
    await t.platform.cleanup(Date.now() + 2 * 86400_000);
    assert.ok(await t.platform.blobs.get(`attachments/${img.ref}`), "the build's attachment stays");
    assert.equal(await t.platform.blobs.get(`attachments/${stray.ref}`), undefined, "a stray one goes after a day");
    assert.equal(t.platform.registry.attachment(stray.ref), undefined);
    // A retry carries the conversation, attachments included; purge removes them.
    await assert.rejects(t.platform.create(USER, { name: "X", purpose: "x", requirements: "x", conversation: [{ role: "user", content: "x", attachments: [{ ref: "at-nope" }] }] as any }), /no attachment/);
    t.platform.archive(USER, "running-log");
    await t.platform.purge(USER, "running-log", "running-log");
    assert.equal(await t.platform.blobs.get(`attachments/${img.ref}`), undefined);
    assert.equal(t.platform.registry.attachment(img.ref), undefined);
  });

  test("a message carries at most 5 images and 10 files", async () => {
    const refs = [];
    for (let i = 0; i < 6; i++) refs.push((await t.platform.addAttachment(USER, { session: "s-5", kind: "image", name: `${i}.png`, mediaType: "image/png", data: PNG })).ref);
    await assert.rejects(t.platform.attachmentsWithData(USER, refs), /at most 5 images in one message/);
    assert.equal((await t.platform.attachmentsWithData(USER, [...refs.slice(0, 5), refs[0]])).length, 5, "five, a repeat not counted");
    const files = [];
    for (let i = 0; i < 11; i++) files.push((await t.platform.addAttachment(USER, { session: "s-5", kind: "file", name: `${i}.txt`, mediaType: "text/plain", data: b64("x") })).ref);
    await assert.rejects(t.platform.create(USER, { name: "X", purpose: "x", requirements: "x", conversation: [{ role: "user", content: "x", attachments: files.map((ref) => ({ ref })) }] as any }), /at most 10 files in one message/);
    await assert.rejects(t.platform.attachmentsWithData(USER, [...refs, ...files]), /a short list of refs/);
  });

  test("a retry gets the conversation's attachments and the owner's words, as the first try did", async () => {
    const img = await t.platform.addAttachment(USER, { session: "s-r", kind: "image", name: "screen.png", mediaType: "image/png", data: PNG });
    const conversation = [{ role: "user" as const, content: "like this screenshot", attachments: [{ ref: img.ref }] }];
    const failed = await t.build(
      () => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r", conversation: conversation as any }),
      () => {
        throw new Error("model overloaded");
      },
    );
    assert.equal(failed.status, "failed");
    let brief = "";
    let shot = false;
    t.queue((ws) => {
      brief = readFileSync(join(ws, "BUILDER.md"), "utf8");
      shot = existsSync(join(ws, "attachments/1-screen.png"));
      seed(ws);
    });
    const retried = await t.platform.settle((await t.platform.retryBuild(USER, failed.buildId)).buildId);
    assert.equal(retried.status, "promoted", retried.log.join("\n"));
    assert.ok(shot, "the screenshot is in the retry's workspace");
    assert.match(brief, /`attachments\/1-screen\.png`: an image/);
    assert.match(brief, /THE OWNER'S OWN WORDS[^]*OWNER: like this screenshot\n  \(attached: screen\.png\)/);
  });

  test("several tools from one conversation share its attachments; purging one leaves them for the other", async () => {
    const img = await t.platform.addAttachment(USER, { session: "s-6", kind: "image", name: "both.png", mediaType: "image/png", data: PNG });
    const conversation = [{ role: "user" as const, content: "two tools from this", attachments: [{ ref: img.ref }] }] as any;
    const a = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r", conversation }), seed);
    const b = await t.build(() => t.platform.create(USER, { name: "Walking Log", purpose: "walks", requirements: "w", conversation }), (ws) => {
      seed(ws);
      editJson(join(ws, "capability.json"), (m) => ((m.id = "walking-log"), (m.name = "Walking Log")));
    });
    assert.equal(a.status, "promoted", a.log.join("\n"));
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.equal(t.platform.registry.attachment(img.ref)!.buildId, a.buildId, "the first build claimed it");
    t.platform.archive(USER, "running-log");
    await t.platform.purge(USER, "running-log", "running-log");
    assert.ok(await t.platform.blobs.get(`attachments/${img.ref}`), "the blob stays for the other tool");
    assert.equal(t.platform.registry.attachment(img.ref)!.buildId, b.buildId, "now the other build's");
    assert.equal((await t.platform.attachmentsWithData(USER, t.platform.buildContext(USER, b.buildId).conversation![0].attachments!)).length, 1);
    t.platform.archive(USER, "walking-log");
    await t.platform.purge(USER, "walking-log", "walking-log");
    assert.equal(await t.platform.blobs.get(`attachments/${img.ref}`), undefined, "gone with the last one");
    assert.equal(t.platform.registry.attachment(img.ref), undefined);
  });

  test("with their bytes, for the intake", async () => {
    const img = await t.platform.addAttachment(USER, { session: "s-4", kind: "image", name: "a.png", mediaType: "image/png", data: PNG });
    const [a] = await t.platform.attachmentsWithData(USER, [{ ref: img.ref, kind: "image", name: "a.png", mediaType: "image/png" }]);
    assert.equal(a.data, PNG);
    assert.equal(a.width, 2);
    await assert.rejects(t.platform.attachmentsWithData(t.claude, [img.ref]), /owner actions/);
  });
});
