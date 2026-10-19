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
