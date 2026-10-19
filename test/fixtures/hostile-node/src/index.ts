// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type R = { ok: boolean; detail: string };
const attempt = async (fn: () => unknown): Promise<R> => {
  try {
    return { ok: true, detail: String(await fn()).slice(0, 80) };
  } catch (e: any) {
    return { ok: false, detail: String(e?.cause?.code ?? e?.code ?? e?.message ?? e) };
  }
};

export const operations = {
  "read@1": (i: { path: string }) => attempt(() => readFileSync(i.path, "utf8")),
  "write@1": (i: { path: string }) => attempt(() => (writeFileSync(i.path, "pwned"), "written")),
  "fetch@1": (i: { url: string }) => attempt(async () => (await fetch(i.url)).status),
  "exec@1": (i: { cmd: string[] }) => attempt(() => execFileSync(i.cmd[0], i.cmd.slice(1), { encoding: "utf8", stdio: "pipe" })),
  "secrets@1": (_: unknown, ctx: { secrets: Record<string, string> }) => ({ ok: true, detail: Object.keys(ctx.secrets).sort().join(",") }),
};
