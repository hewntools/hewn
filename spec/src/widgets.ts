// SPDX-License-Identifier: Apache-2.0
// Widgets (ABI 2.3): a tool's data snapshot plus a layout, drawn by the host on Home and in agent
// chats. A widget names a read operation; the operation returns a view model for one of these
// templates. Tool code never ships widget HTML. The manifest side is `WidgetManifest`.

export const WIDGET_TEMPLATES = ["stat", "list", "chart", "progress", "text"] as const;
export type WidgetTemplate = (typeof WIDGET_TEMPLATES)[number];

/**
 * A button on a widget: runs one of the tool's own operations (writes included) when pressed,
 * then the widget refreshes. Drawing a widget never writes; pressing a button is an action, with
 * the same rules as any call by whoever pressed it (the owner on Home, the agent in a chat).
 */
export interface WidgetButton {
  label: string;
  operation: string;
  input?: Record<string, unknown>;
}

/** Shared by every template: up to three buttons. */
interface Actions {
  buttons?: WidgetButton[];
}

export type WidgetView =
  | ({ template: "stat"; value: string | number; unit?: string; caption?: string; reveal?: string } & Actions)
  | ({ template: "list"; items: { title: string; detail?: string; value?: string | number }[]; empty?: string; reveal?: string } & Actions)
  | ({ template: "chart"; kind?: "bar" | "line"; labels: string[]; series: { name: string; values: number[] }[]; unit?: string; caption?: string } & Actions)
  | ({ template: "progress"; value: number; max: number; label?: string; caption?: string } & Actions)
  | ({ template: "text"; text: string; caption?: string; reveal?: string } & Actions);

/** What a widget operation returns: one view for every size, or a view per size (e.g. a list when large). */
export type WidgetOutput = WidgetView | Partial<Record<"small" | "medium" | "large", WidgetView>>;
