// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isWsl, openCommand } from "@hewntools/cli/open-url.ts";

test("opening a link: macOS open, Linux xdg-open, WSL through Windows", () => {
  const none = () => false;
  assert.deepEqual(openCommand({ platform: "darwin", wsl: false, has: none }), ["open"]);
  assert.deepEqual(openCommand({ platform: "linux", wsl: false, has: none }), ["xdg-open"]);
  assert.deepEqual(openCommand({ platform: "linux", wsl: true, has: none }), ["rundll32.exe", "url.dll,FileProtocolHandler"]);
  assert.deepEqual(openCommand({ platform: "linux", wsl: true, has: (b) => b === "wslview" }), ["wslview"]);
  if (process.platform === "linux") assert.equal(isWsl("Linux version 6.6.87.2-microsoft-standard-WSL2"), true);
  assert.equal(isWsl("Linux version 6.8.0-45-generic"), false);
});
