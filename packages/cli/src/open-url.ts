// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** WSL: Linux under Windows, where the browser is Windows' own. */
export const isWsl = (procVersion = (() => {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
})()) => process.platform === "linux" && /microsoft/i.test(procVersion);

/**
 * How to open a URL in the user's browser here. WSL: wslview if installed, else Windows' own URL
 * handler (explorer.exe isn't reliable: with a query string it may open a folder instead).
 */
export function openCommand(o: { platform: NodeJS.Platform; wsl: boolean; has: (bin: string) => boolean }): string[] {
  if (o.platform === "darwin") return ["open"];
  if (o.wsl) return o.has("wslview") ? ["wslview"] : ["rundll32.exe", "url.dll,FileProtocolHandler"];
  return ["xdg-open"];
}

const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

/** Open a URL in the browser. False if that failed (the caller prints the URL instead). */
export function openUrl(url: string): boolean {
  const [cmd, ...args] = openCommand({ platform: process.platform, wsl: isWsl(), has });
  const r = spawnSync(cmd, [...args, url], { stdio: "ignore" });
  return !r.error && r.status === 0;
}
