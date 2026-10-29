// SPDX-License-Identifier: AGPL-3.0-or-later
// Stop in the chat on the real workerd host: the request closing stops the intake too, not only its view.
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import type { Intake } from "@hewntools/cli/intake.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("stopping the intake", () => {
  let h: TestHost;
  let started: () => void;
  let stopped: () => void;
  const running = new Promise<void>((r) => (started = r));
  const aborted = new Promise<void>((r) => (stopped = r));
  // An intake that writes a little, then waits to be stopped (as a CLI mid-reply would).
  const intake: Intake = (_req, onProgress, signal) =>
    new Promise((_resolve, reject) => {
      onProgress?.({ activity: "Thinking" });
      started();
      signal?.addEventListener("abort", () => (stopped(), reject(new Error("stopped"))), { once: true });
    });
  before(async () => {
    h = await startTestHost({ intake });
  });
  after(() => h?.stop());

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ headers: Record<string, unknown> }>((res, rej) => {
      const r = request({ host: "127.0.0.1", port: h.port, path, headers: { host: `hewn.localhost:${h.port}`, ...headers } }, (m) => (m.resume(), m.on("end", () => res({ headers: m.headers }))));
      r.on("error", rej);
      r.end();
    });

  test("Stop (the client closing the stream) stops the intake's run", async () => {
    const { ticket } = await h.sv.admin("web-ticket", {});
    const cookie = String([(await get(`/auth?ticket=${ticket}`)).headers["set-cookie"]].flat()[0]).split(";")[0];
    const body = JSON.stringify({ mode: "create", messages: [{ role: "user", content: "Track my coffee beans" }], session: "stop-test" });
    const headers = { host: `hewn.localhost:${h.port}`, cookie, "x-hewn-ui": "1", accept: "text/event-stream", "content-type": "application/json" };
    const r = request({ host: "127.0.0.1", port: h.port, path: "/api/intake", method: "POST", headers });
    r.on("error", () => {});
    const status = new Promise<number>((res) => r.on("response", (m) => (m.on("error", () => {}), res(m.statusCode!))));
    r.end(body);
    assert.equal(await status, 200);
    await running;
    // Stop: the chat aborts its fetch, which closes the connection.
    r.destroy();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("the intake was never stopped")), 5000).unref());
    await Promise.race([aborted, timeout]);
  });
});
