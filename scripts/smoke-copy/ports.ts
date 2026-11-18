// SPDX-License-Identifier: AGPL-3.0-or-later
// The copy's ports: spare ones, and never a live Hewn's (its web and MCP, its public listener, a metrics port).
import { createServer } from "node:net";

/** A live Hewn's defaults: 7717 (web, MCP), 7718 (the public listener), 9091 (metrics, as hosts set it). */
export const LIVE_PORTS: ReadonlySet<number> = new Set([7717, 7718, 9091]);

/** A port free on loopback a moment ago (the OS picks it). */
export const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

/**
 * Two spare ports for the copy (web and MCP, and the public listener), neither a live Hewn's nor the other.
 * `avoid`: more to keep off (a live Hewn on another port, from HEWN_PORT).
 */
export async function copyPorts(pick: () => Promise<number> = freePort, avoid: Iterable<number> = []): Promise<{ port: number; publicPort: number }> {
  const off = new Set([...LIVE_PORTS, ...avoid]);
  for (const p of [...off]) off.add(p + 1);
  const got: number[] = [];
  for (let tries = 0; got.length < 2; tries++) {
    if (tries > 50) throw new Error("no spare port found");
    const p = await pick();
    if (!off.has(p) && !got.includes(p)) got.push(p);
  }
  return { port: got[0], publicPort: got[1] };
}

/** Throws unless every port the copy uses is spare (a last look before it starts). */
export function assertSpare(ports: number[], avoid: Iterable<number> = []) {
  const off = new Set([...LIVE_PORTS, ...avoid]);
  for (const p of [...off]) off.add(p + 1);
  const bad = ports.filter((p) => off.has(p));
  if (bad.length) throw new Error(`port ${bad.join(", ")} is a live Hewn's: the copy never uses it`);
}
