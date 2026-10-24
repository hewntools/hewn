// SPDX-License-Identifier: AGPL-3.0-or-later
// Invocation: an operation run through its contract, with the call chain's checks (scope, cycles, depth,
// deadline, readiness, declared calls, the owner's confirmation), stored secrets kept in, and the call log.
import { type Agent, requireOwner, requireScope } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { type Deadline, deadlineOf } from "../deadline.ts";
import { abiAtLeast, type CapabilityManifest, compileSchema, connectOperation, type OperationManifest, opKey, schemaErrors } from "../manifest.ts";
import type { ModelHandler } from "../models.ts";
import type { CallHandler, ExecutionTarget } from "../ports.ts";
import { resolveHosts } from "./grants.ts";
import { Domain } from "./context.ts";

export interface InvokeRequest {
  capabilityId: string;
  operation: string;
  /** Contract version. Defaults to the highest available. */
  operationVersion?: number;
  input?: unknown;
}

/**
 * An operation's input as the failure record keeps it: values under names that look like
 * credentials (password, token, secret, key …) are masked. Stored secrets are redacted separately.
 */
export const maskInput = (v: unknown, depth = 0): unknown => {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, /pass(word)?|token|secret|api[-_]?key|private|credential|auth/i.test(k) ? "[hidden]" : maskInput(x, depth + 1)]));
};

export class Invocation extends Domain {
  /**
   * `record: false`: not written to the call log (Accounts' health checks, which run on every visit).
   * `readOnly`: a widget's call. Its own state may only be read, and the whole chain may run read
   * operations only, without a model (`readChain`, passed on to the operations it calls).
   * `origin`: who started the call chain (passed on to the operations it calls): an agent's
   * destructive call waits for the owner however many capabilities it goes through.
   */
  async invoke(
    agent: Agent,
    req: InvokeRequest,
    trace: string[] = [agent.id],
    within: Deadline | number = Date.now() + CALL_DEADLINE_MS,
    { record = true, readOnly = false, readChain = readOnly, origin = agent }: { record?: boolean; readOnly?: boolean; readChain?: boolean; origin?: Agent } = {},
  ) {
    const deadline = deadlineOf(within, CALL_DEADLINE_MS);
    requireScope(agent, "invoke");
    const cap = this.visibleActive(agent, req.capabilityId);
    // trace = [origin caller, ...capabilities on the call path]
    if (trace.slice(1).includes(cap.id)) throw new PlatformError("forbidden", `call cycle: ${[...trace, cap.id].join(" → ")}`);
    if (trace.length > MAX_CALL_DEPTH) throw new PlatformError("forbidden", `call depth exceeds ${MAX_CALL_DEPTH}: ${[...trace, cap.id].join(" → ")}`);
    if (deadline.remaining() <= 0) throw new PlatformError("operation_failed", `call chain deadline exceeded: ${[...trace, cap.id].join(" → ")}`);
    const status = this.platform.readiness(cap.id);
    const signIn = connectOperation(this.activeManifest(cap.id));
    const isSignIn = !!signIn && req.operation === "connect";
    if (isSignIn && agent.kind !== "user") throw new PlatformError("forbidden", `connect is ${cap.id}'s sign-in step: only the owner runs it, under Accounts in Hewn`);
    // The sign-in step fills the secrets, so it runs without them (everything else must be in place).
    const missingOnlySecrets = !status.ready && !status.unsupportedAbi && !status.pendingGrants.length && !status.missingConfig.length && !status.missingDependencies.length;
    if (!status.ready && !(isSignIn && missingOnlySecrets)) throw new PlatformError("not_ready", `${cap.id} is not ready`, status);
    const version = await this.loadVersion(cap.id, cap.activeVersion!);
    const manifest = version.row.manifest;
    if (origin.kind === "agent" || readChain) {
      const op = resolveOperation(manifest, req.operation, req.operationVersion);
      if (readChain && op.sideEffect !== "read") throw new PlatformError("forbidden", `widgets are read-only: ${cap.id}/${opKey(op.name, op.version)} is a ${op.sideEffect} operation`);
      if (op.sideEffect === "destructive" && origin.kind === "agent") await this.d.grants.confirmDestructive(origin, cap.id, opKey(op.name, op.version), req.input ?? {}, trace.slice(1));
    }
    // Only what is declared, granted and stored reaches the capability.
    const declared = manifest.requires?.secrets?.map((s) => s.name) ?? [];
    const secrets = Object.fromEntries(declared.flatMap((n) => (this.secrets.get(cap.id, n) === undefined ? [] : [[n, this.secrets.get(cap.id, n)!]])));
    const config = this.registry.config(cap.id);
    const target: ExecutionTarget = {
      capabilityId: cap.id,
      code: version.code,
      state: { capabilityId: cap.id },
      hosts: resolveHosts(manifest, config),
      secrets,
      config: Object.fromEntries((manifest.config ?? []).filter((c) => config[c.name] !== undefined).map((c) => [c.name, config[c.name]])),
      caller: { kind: agent.kind, id: agent.kind === "capability" ? agent.id.replace(/^capability:/, "") : agent.id },
      deadline,
      ...(readOnly ? { readOnly: true } : {}),
    };
    const declaredCalls = manifest.requires?.capabilities ?? [];
    // A destructive call further down the chain waiting for the owner: reported as such to whoever
    // started the chain, not as this operation's failure.
    let held: PlatformError | undefined;
    const onCall = async (c: { capabilityId: string; operation: string; input: unknown }) => {
      const dep = declaredCalls.find((d) => d.id === c.capabilityId && d.operations.includes(c.operation));
      if (!dep) throw new PlatformError("forbidden", `${cap.id} did not declare ${c.capabilityId}/${c.operation} in requires.capabilities`);
      if (!this.registry.grants(cap.id).has(`capability:${c.capabilityId}/${c.operation}`)) {
        throw new PlatformError("forbidden", `${cap.id} is not granted ${c.capabilityId}/${c.operation}`);
      }
      const [name, v] = c.operation.split("@");
      const principal: Agent = { id: `capability:${cap.id}`, kind: "capability", scopes: new Set(["invoke"]), capabilities: new Set([c.capabilityId]) };
      try {
        const r = await this.invoke(principal, { capabilityId: c.capabilityId, operation: name, operationVersion: Number(v), input: c.input }, [...trace, cap.id], deadline, { readChain, origin });
        return r.result;
      } catch (e) {
        if (e instanceof PlatformError && e.code === "awaiting_confirmation") held = e;
        throw e;
      }
    };
    const model = manifest.requires?.model;
    // Widgets never call a model: background refreshes would quietly drain the budget.
    const onModel = model && abiAtLeast(manifest, "2.2") && !readChain ? this.d.models.modelHandler(cap.id, model, deadline, trace[0]) : undefined;
    const started = Date.now();
    // A backstop for code that hands out its credentials: no stored secret leaves in a result, an
    // error or a log line.
    const secretValues = Object.values(secrets).flatMap(secretNeedles);
    const leaks = (s: string) => secretValues.some((v) => s.includes(v));
    const redact = (s: string) => secretValues.reduce((acc, v) => acc.split(v).join("[secret]"), s);
    let executed: Awaited<ReturnType<Invocation["execute"]>>;
    try {
      executed = await this.execute(manifest, target, req, onCall, onModel);
    } catch (e) {
      if (held) throw held;
      const err = e as PlatformError;
      if (err instanceof Error && leaks(err.message)) err.message = redact(err.message);
      const logs = ((err.details as { logs?: string[] } | undefined)?.logs ?? []).map(redact);
      // The sign-in step handles credentials: neither its message nor its console lines are kept.
      if (!record) {
        // nothing kept
      } else if (isSignIn) this.capabilityLog(cap.id, trace.join(" → "), req, started, `ERROR ${err.code ?? "internal"}: (sign-in failed; details aren't kept)`, []);
      else {
        this.capabilityLog(cap.id, trace.join(" → "), req, started, `ERROR ${err.code ?? "internal"}: ${err.message}`, logs);
        this.noteFailure(cap.id, { caller: trace[0], operation: req.operationVersion ? `${req.operation}@${req.operationVersion}` : req.operation, error: err.message, input: redact(JSON.stringify(maskInput(req.input ?? {})) ?? "{}"), logs });
      }
      if (err.details && typeof err.details === "object" && "logs" in err.details) {
        const { logs: _omit, ...rest } = err.details as Record<string, unknown>;
        err.details = Object.keys(rest).length ? rest : undefined; // capability logs are for the user, not agents
      }
      throw e;
    }
    const { secretUpdates, logs: rawLogs, ...rest } = executed;
    for (const [name, value] of Object.entries(secretUpdates)) {
      if (declared.includes(name) && typeof value === "string") {
        this.secrets.set(cap.id, name, value);
        this.logger(`secret ${name} refreshed by ${cap.id}`);
        secretValues.push(...secretNeedles(value));
      } else {
        this.logger(`ignored secret update '${name}' from ${cap.id}: not declared`);
      }
    }
    const logs = rawLogs.map(redact);
    if (leaks(JSON.stringify(rest.result ?? null))) {
      const message = `${cap.id}/${rest.operation} returned one of its stored secrets; the result was withheld`;
      if (record) this.capabilityLog(cap.id, trace.join(" → "), req, started, `ERROR forbidden: ${message}`, isSignIn ? [] : logs);
      // A result carrying a stored secret is the tool's bug: worth asking the builder to fix.
      if (record && !isSignIn) this.noteFailure(cap.id, { caller: trace[0], operation: req.operationVersion ? `${req.operation}@${req.operationVersion}` : req.operation, error: message, input: redact(JSON.stringify(maskInput(req.input ?? {})) ?? "{}"), logs });
      this.logger(message);
      throw new PlatformError("forbidden", message);
    }
    const used = resolveOperation(manifest, req.operation, req.operationVersion);
    const out = used.deprecated ? { ...rest, deprecated: `${rest.operation} is deprecated${used.deprecated.replacement ? `; use ${used.deprecated.replacement}` : ""}${used.deprecated.note ? ` (${used.deprecated.note})` : ""}` } : rest;
    if (record) this.capabilityLog(cap.id, trace.join(" → "), req, started, "ok", isSignIn ? [] : logs);
    return out;
  }

  /** Contract-enforcing call: resolve operation, validate input, run, validate output. */
  async execute(manifest: CapabilityManifest, target: ExecutionTarget, req: InvokeRequest, onCall?: CallHandler, onModel?: ModelHandler) {
    const op = resolveOperation(manifest, req.operation, req.operationVersion);
    const key = opKey(op.name, op.version);
    const input = req.input ?? {};
    const checkIn = compileSchema(op.inputSchema);
    if (!checkIn(input)) throw inputMismatch(key, schemaErrors(checkIn));
    const { output: result, secretUpdates, logs } = await this.runtime.invoke(target, key, input, onCall, onModel);
    const checkOut = compileSchema(op.outputSchema);
    if (!checkOut(result)) {
      throw new PlatformError("invalid_output", `implementation returned output violating ${key} outputSchema`, schemaErrors(checkOut));
    }
    return { capabilityId: manifest.id, operation: key, result, secretUpdates, logs };
  }

  /** Per-capability call log (user-facing). Records who/what/outcome, never inputs or outputs. */
  private capabilityLog(id: string, caller: string, req: InvokeRequest, started: number, outcome: string, lines: string[]) {
    try {
      const now = new Date();
      const op = req.operationVersion ? `${req.operation}@${req.operationVersion}` : req.operation;
      this.registry.addCapabilityLog(id, now.toISOString(), `${now.toISOString()} ${caller} ${op} ${outcome} ${now.getTime() - started}ms`, lines);
    } catch {
      // logging must never break a call
    }
  }

  /**
   * The tool's last failed calls (newest first, at most 10), for "Ask builder to fix this": what ran,
   * who started it, the error, the input and the last console lines. Owner only; never secrets (the
   * sign-in step isn't kept, and stored secrets are redacted as in the log).
   */
  private noteFailure(id: string, f: { caller: string; operation: string; error: string; input: string; logs: string[] }) {
    try {
      const key = `failures:${id}`;
      const entry = { at: new Date().toISOString(), caller: f.caller, operation: f.operation, error: f.error.slice(0, 1000), input: f.input.slice(0, 2000), logs: f.logs.slice(-10).map((l) => l.slice(0, 300)) };
      // Kept no longer than the call log (Settings › Data › Keep call logs; 0 = forever).
      const days = this.platform.logRetentionDays();
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
      this.registry.setKv(key, [entry, ...(this.registry.getKv<(typeof entry)[]>(key) ?? [])].filter((x) => x.at >= since).slice(0, 10));
    } catch {
      // never breaks a call
    }
  }

  recentFailures(owner: Agent, capabilityId: string) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    return this.registry.getKv<{ at: string; caller: string; operation: string; error: string; input: string; logs: string[] }[]>(`failures:${capabilityId}`) ?? [];
  }

  /** The last `n` lines of a capability's call log. */
  logLines(capabilityId: string, n: number): string[] {
    return this.registry.capabilityLogLines(capabilityId, n);
  }
}

export function resolveOperation(m: CapabilityManifest, name: string, version?: number): OperationManifest {
  const candidates = m.operations.filter((o) => o.name === name);
  const op = version === undefined ? candidates.sort((a, b) => b.version - a.version)[0] : candidates.find((o) => o.version === version);
  if (!op) {
    throw new PlatformError("not_found", `${m.id} has no operation ${version ? opKey(name, version) : name}`, {
      available: m.operations.map((o) => opKey(o.name, o.version)),
    });
  }
  return op;
}

/** How long a whole call chain may take (an agent's call and every capability call it causes). */
export const CALL_DEADLINE_MS = 30_000;

/** Invalid operation input, naming missing required fields in the message (details keep every schema error). */
export function inputMismatch(key: string, errors: string[]): PlatformError {
  const missing = errors.map((e) => /^\$ Instance does not have required property "(.+)"/.exec(e)?.[1]).filter(Boolean);
  return new PlatformError("invalid_input", `input does not match ${key} inputSchema${missing.length ? ` (missing ${missing.join(", ")})` : ""}`, errors);
}

/** Maximum capability → capability nesting (origin caller excluded). */
export const MAX_CALL_DEPTH = 3;

/**
 * What of a stored secret must never leave a capability: the value itself, or for a JSON object (a
 * token set) each long string in it, except email addresses (who is signed in isn't secret).
 * Short values would match by accident; real credentials aren't short.
 */
function secretNeedles(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // not JSON
  }
  if (!parsed || typeof parsed !== "object") return value.length >= 8 ? [value] : [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.length >= 16 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) out.push(v);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(parsed);
  return out;
}
