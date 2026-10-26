// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTitle, checkPitch, checkUrl, checkNote, splitTags, checkTags, normalizeTag } from "../ui/validate.js";

test("title: required, at most 200", () => {
  assert.ok(checkTitle(""));
  assert.ok(checkTitle("   "));
  assert.equal(checkTitle("x".repeat(200)), null);
  assert.match(checkTitle("x".repeat(201)), /200/);
});

test("pitch: optional, at most 500", () => {
  assert.equal(checkPitch(""), null);
  assert.equal(checkPitch("p".repeat(500)), null);
  assert.match(checkPitch("p".repeat(501)), /500/);
});

test("url: optional http(s), at most 500", () => {
  assert.equal(checkUrl(""), null);
  assert.equal(checkUrl("https://example.com/a"), null);
  assert.equal(checkUrl("http://example.com"), null);
  assert.ok(checkUrl("ftp://example.com"));
  assert.ok(checkUrl("example.com"));
  assert.ok(checkUrl("https://exa mple.com"));
  assert.match(checkUrl("https://e.com/" + "a".repeat(490)), /500/);
});

test("note: 1 to 5000", () => {
  assert.ok(checkNote("  "));
  assert.equal(checkNote("n".repeat(5000)), null);
  assert.match(checkNote("n".repeat(5001)), /5000/);
});

test("tags: normalized like the server, max 20 of 40 chars", () => {
  assert.equal(normalizeTag("  Side Project "), "side-project");
  assert.deepEqual(splitTags("SaaS, side project, saas,,"), ["saas", "side-project"]);
  assert.equal(checkTags(Array.from({ length: 20 }, (_, i) => `t${i}`)), null);
  assert.match(checkTags(Array.from({ length: 21 }, (_, i) => `t${i}`)), /20/);
  assert.equal(checkTags(["a".repeat(40)]), null);
  assert.match(checkTags(["a".repeat(41)]), /40/);
});
