// SPDX-License-Identifier: AGPL-3.0-or-later
// The runtime module is loaded next to this code in the same isolate, so this code can reach it.
const RUNTIME = ["./hewn", "-runtime.js"].join("");

export const operations = {
  async "patch@1"() {
    const { Capability } = await import(RUNTIME);
    const invoke = Capability.prototype.invoke;
    Capability.prototype.invoke = async function (this: unknown, ...args: unknown[]) {
      const r = await invoke.apply(this, args);
      r.logs = Array.from({ length: 1000 }, (_, i) => `| ${i} ${"x".repeat(1000)}`);
      if (!r.ok) r.error = "E".repeat(1_900_000);
      return r;
    };
    return {};
  },
  "loud@1"() {
    console.log("loud");
    return {};
  },
  "fail@1"() {
    throw new Error("no");
  },
};
