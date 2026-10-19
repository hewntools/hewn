// SPDX-License-Identifier: AGPL-3.0-or-later
import { initConfig } from "../config.ts";
import type { PendingRequest } from "@hewntools/core/agents.ts";
import type { Home } from "../home.ts";
import { LOGIN_TIMEOUT_MS, type LoginRunner, realLogin } from "./connect.ts";
import type { Harness, Step } from "./harnesses.ts";

export interface WizardIO {
  /** Rejects when `signal` aborts (the question was answered elsewhere). */
  ask(question: string, signal?: AbortSignal): Promise<string>;
  print(line: string): void;
}

export interface SetupOptions {
  home: Home;
  url: string;
  /** User's home directory (for agent config and shell profile files). */
  userHome: string;
  harnesses: Harness[];
  io: WizardIO;
  /** Pre-selected agent ids; skips the selection questions. */
  agents?: string[];
  /** Add optional pointers too (undefined = ask). */
  pointer?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  /** The running Hewn's connection requests: the wizard approves the harness's sign-in in the terminal. */
  approvals?: {
    pending(): Promise<PendingRequest[]>;
    decide(id: string, d: { approve: boolean; scopes?: string[] }): Promise<unknown>;
  };
  login?: LoginRunner;
  pollMs?: number;
}

async function confirm(io: WizardIO, question: string, defaultYes: boolean, signal?: AbortSignal): Promise<boolean> {
  const a = (await io.ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, signal)).trim().toLowerCase();
  return a === "" ? defaultYes : a.startsWith("y");
}

const WORDS: Record<string, string> = { discover: "see your tools", invoke: "use them", create: "make new ones", modify: "change existing ones", manage: "manage them", delete: "delete them" };

/**
 * Sign the harness in: run its OAuth login (it opens the browser at Hewn's approval page) and
 * approve the request right here when it shows up.
 */
async function signIn(o: SetupOptions, h: Harness): Promise<boolean> {
  const { io } = o;
  const seen = new Set((await o.approvals?.pending().catch(() => []))?.map((p) => p.id) ?? []);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LOGIN_TIMEOUT_MS);
  io.print(`  … ${h.login(o.url).join(" ")} (opens your browser; approve below or in Hewn)`);
  let done = false;
  let output = "";
  const login = (o.login ?? realLogin)(h.login(o.url), (line) => ((output += line + "\n"), io.print(`    ${line}`)), abort.signal).finally(() => {
    done = true;
    clearTimeout(timer);
  });
  if (o.approvals) {
    while (!done) {
      const fresh = (await o.approvals.pending().catch(() => [])).find((p) => !seen.has(p.id));
      if (fresh) {
        seen.add(fresh.id);
        io.print(`\n  ${fresh.clientName} asks to: ${fresh.requested.map((s) => WORDS[s] ?? s).join(", ")}. Code ${fresh.userCode} (check the browser shows the same).`);
        const ok = o.yes || (await askUnlessDecided(o, fresh.id, () => done, `  Approve (${fresh.suggested.join(", ")})?`));
        if (ok === "elsewhere") io.print("\n  Decided in Hewn.");
        else {
          await o.approvals.decide(fresh.id, ok ? { approve: true, scopes: fresh.suggested } : { approve: false }).catch(() => io.print("  Already decided in Hewn."));
          if (!ok) io.print("  Declined.");
        }
      }
      await Promise.race([login, new Promise((r) => setTimeout(r, o.pollMs ?? 1000))]);
    }
  }
  const code = await login;
  io.print(code === 0 ? `  ✔ signed in` : abort.signal.aborted ? "  ✖ not approved in time: run hewn setup again" : `  ✖ ${h.label} couldn't sign in. ${h.loginFix(output)}`);
  return code === 0;
}

/**
 * Ask whether to approve, but stop asking once the request is decided elsewhere (in Hewn's web
 * page, where the owner may approve it first) or the sign-in finished: no stale [Y/n] left behind.
 */
async function askUnlessDecided(o: SetupOptions, id: string, finished: () => boolean, question: string): Promise<boolean | "elsewhere"> {
  const stop = new AbortController();
  const decidedElsewhere = (async () => {
    while (!stop.signal.aborted) {
      await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
      if (stop.signal.aborted) return;
      const still = await o.approvals!.pending().then((list) => list.some((p) => p.id === id), () => true);
      if (finished() || !still) return void stop.abort();
    }
  })();
  try {
    return await confirm(o.io, question, true, stop.signal);
  } catch (e) {
    if (stop.signal.aborted) return "elsewhere";
    throw e;
  } finally {
    stop.abort();
    await decidedElsewhere;
  }
}

/** `hewn setup`: connect agent harnesses to Hewn (register the address, pointer, OAuth sign-in). */
export async function runSetup(o: SetupOptions): Promise<{ applied: string[]; failed: string[] }> {
  const { io } = o;
  initConfig(o.home);
  io.print(`Hewn setup — platform at ${o.url}\n`);

  // 1. choose harnesses
  const chosen: Harness[] = [];
  for (const h of o.harnesses) {
    const found = h.detect();
    if (o.agents) {
      if (!o.agents.includes(h.agentId)) continue;
      if (!found) {
        io.print(`✖ ${h.label}: not found on PATH, skipping`);
        continue;
      }
      chosen.push(h);
    } else if (!found) {
      io.print(`  ${h.label}: not found on PATH`);
    } else if (await confirm(io, `Set up ${h.label}?`, true)) {
      chosen.push(h);
    }
  }
  if (!chosen.length) {
    io.print("Nothing to set up.");
    return { applied: [], failed: [] };
  }

  // 2. plan
  const plan: { harness: Harness; steps: Step[] }[] = [];
  for (const h of chosen) {
    let pointer = h.pointerRequired;
    if (!pointer) pointer = o.pointer ?? (await confirm(io, `Add Hewn pointer to ${h.label}'s instructions (${h.pointerNote})?`, false));
    plan.push({ harness: h, steps: h.steps({ url: o.url, home: o.userHome, pointer }) });
    io.print(`\n${h.label}:`);
    for (const s of plan.at(-1)!.steps) io.print(`  - ${s.describe}`);
    io.print(`  - sign in: ${h.login(o.url).join(" ")} (you approve it; no token is stored in ${h.label}'s config)`);
  }

  if (o.dryRun) {
    io.print("\nDry run: nothing changed.");
    return { applied: [], failed: [] };
  }
  if (!o.yes && !(await confirm(io, "\nApply these changes?", true))) {
    io.print("Aborted. Nothing changed.");
    return { applied: [], failed: [] };
  }

  // 3. apply
  const applied: string[] = [];
  const failed: string[] = [];
  for (const { harness, steps } of plan) {
    io.print(`\n${harness.label}`);
    let ok = true;
    for (const s of steps) {
      try {
        s.run();
        io.print(`  ✔ ${s.describe}`);
      } catch (e) {
        ok = false;
        io.print(`  ✖ ${s.describe}\n    ${(e as Error).message}`);
        break;
      }
    }
    if (ok) ok = await signIn(o, harness);
    (ok ? applied : failed).push(harness.agentId);
  }

  io.print("\nNext:");
  io.print("  - Start new agent sessions. Running sessions keep their old tool list.");
  return { applied, failed };
}
