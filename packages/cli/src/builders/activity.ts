// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turn headless builder event streams into one-line, human-readable activity.
 * Returns null for events not worth showing.
 */

const clip = (s: string, n = 160) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

const rel = (p: string, cwd: string) => {
  for (const base of [cwd, `/private${cwd}`]) if (p.startsWith(base + "/")) return p.slice(base.length + 1);
  return p;
};

/** An activity line that means the builder used a tool: a Claude Code or OpenCode tool call, a Codex command or file change. */
export const USED_TOOL = /^(→|\$|✎) /;

/** `opencode run --format json` events: a part per line (text, reasoning, a tool call once it ended, a step), or an error. */
export function opencodeActivity(e: any, cwd: string): string | null {
  if (e?.type === "error") return `✖ ${clip(errorText(e.error))}`;
  const part = e?.part;
  if (!part) return null;
  if (e.type === "text") return part.text?.trim() ? `💬 ${clip(part.text)}` : null;
  if (e.type === "reasoning") return part.text?.trim() ? `… ${clip(part.text)}` : null;
  if (e.type === "step_finish") return part.reason === "stop" ? "✔ builder finished its turn" : null;
  if (e.type !== "tool_use") return null;
  const i = part.state?.input ?? {};
  const target = i.filePath ?? i.path ?? i.pattern ?? i.command ?? i.url ?? "";
  const line = `→ ${part.tool ?? "tool"} ${clip(rel(String(target), cwd), 120)}`.trimEnd();
  return part.state?.status === "error" ? `${line}\n  ↳ ${clip(String(part.state.error ?? "failed"))}` : line;
}

/** An OpenCode error, as its event carries it: a name with the message in `data`, or a message. */
/** An OpenCode error, in words: its message when it has one, else its name. */
export const errorText = (err: any): string => (typeof err === "string" ? err : err?.data?.message ?? err?.message ?? err?.name ?? JSON.stringify(err ?? "error"));

/** `codex exec --json` events. */
export function codexActivity(e: any, cwd: string): string | null {
  const item = e?.item;
  if (e?.type === "turn.completed") return "✔ builder finished its turn";
  if (e?.type === "error" || e?.type === "turn.failed") return `✖ ${clip(e.message ?? e.error?.message ?? JSON.stringify(e))}`;
  if (!item) return null;
  const started = e.type === "item.started";
  switch (item.type) {
    case "agent_message":
      return started ? null : `💬 ${clip(item.text ?? "")}`;
    case "reasoning":
      return started || !item.text ? null : `… ${clip(item.text)}`;
    case "command_execution": {
      const cmd = clip(String(item.command ?? "").replace(/^\/bin\/\w+ -lc '([\s\S]*)'$/, "$1"), 120);
      if (started) return `$ ${cmd}`;
      return item.exit_code === 0 ? null : `  ↳ exit ${item.exit_code ?? "?"}`;
    }
    case "file_change":
      return started
        ? null
        : `✎ ${(item.changes ?? []).map((c: any) => `${c.kind ?? "edit"} ${rel(c.path ?? "", cwd)}`).join(", ")}`;
    case "todo_list":
      return started ? null : `☐ plan: ${clip((item.items ?? []).map((i: any) => i.text).join(" · "))}`;
    default:
      return null;
  }
}

/** `claude -p --output-format stream-json --verbose` events. */
export function claudeActivity(e: any, cwd: string): string | null {
  if (e?.type === "result") {
    return e.is_error ? `✖ ${clip(String(e.result ?? e.subtype))}` : `✔ builder finished (${e.num_turns ?? "?"} turns)`;
  }
  if (e?.type !== "assistant") return null;
  const out: string[] = [];
  for (const c of e.message?.content ?? []) {
    if (c.type === "text" && c.text?.trim()) out.push(`💬 ${clip(c.text)}`);
    if (c.type === "tool_use") {
      const i = c.input ?? {};
      const target = i.file_path ? rel(i.file_path, cwd) : (i.pattern ?? i.path ?? i.command ?? "");
      out.push(`→ ${c.name} ${clip(String(target), 120)}`.trimEnd());
    }
  }
  return out.length ? out.join("\n") : null;
}
