// SPDX-License-Identifier: AGPL-3.0-or-later
// The intake role's request/reply shapes (shared by the surface on every host; the CLI
// implementation lives in src/intake.ts).
import type { CapabilityManifest } from "@hewntools/core/manifest.ts";

export interface IntakeMessage {
  role: "user" | "intake";
  content: string;
}

export interface IntakeRequest {
  /** "modify" also covers widgets: the reply may propose widgets-only builds instead of a draft. */
  mode: "create" | "modify";
  capabilityId?: string;
  /** Modifying with one of its widgets in mind (its name): opened from that widget's Change…. */
  widget?: string;
  messages: IntakeMessage[];
  /** Filled in by the platform: the owner's capabilities, and the current manifest when modifying. */
  catalog?: { id: string; name: string; purpose: string; operations: string[]; kind?: "connection" }[];
  current?: CapabilityManifest;
  /** The intake's own model and effort for this conversation (the owner's setting, unless a client passes another); the host fills in the setting otherwise. */
  run?: { model?: string; effort?: string };
  /** One id per conversation, so a host that runs the intake can keep one session for all its turns. */
  session?: string;
}

/**
 * The draft at a glance, for the owner's spec card ("Will build"): presentation only. The builder
 * works from `requirements` / `request`; the platform enforces what the built manifest declares.
 */
export interface DraftSpec {
  operations: { name: string; sideEffect: "read" | "write" | "destructive" }[];
  /** Titles of the widgets it adds or changes. */
  widgets?: string[];
  /** The model tier it asks Hewn to run (requires.model), if any. */
  model?: "light" | "standard" | "strong" | "max";
  /** Capability ids it will call. */
  uses: string[];
  hosts: string[];
  secrets: string[];
}

/**
 * A connection to build or change first: the draft's capability calls it (only connections hold
 * credentials). The client builds it, then the draft with `after` set to that build.
 */
export type ConnectionStep = { mode: "create"; name: string; purpose: string; requirements: string } | { mode: "modify"; capabilityId: string; request: string };

/**
 * A widget the existing capability can already make: what it shows, in which template and sizes
 * (a widgets build makes the ones the owner keeps). Widgets that need the capability changed come
 * as a modify draft instead.
 */
export interface WidgetProposal {
  title: string;
  /** One sentence in the owner's words: what it shows and why it's worth a glance. */
  shows: string;
  template: "stat" | "list" | "chart" | "progress" | "text";
  sizes: ("small" | "medium" | "large")[];
  /** The existing widget (name) this one replaces, when it changes a widget rather than adding one. */
  replaces?: string;
}

/**
 * An operation to run on a timetable, suggested by the intake: the owner approves it on the card
 * (with a build, it's set up once the build promotes).
 */
export interface ScheduleSuggestion {
  /** Operation name (no version). */
  operation: string;
  /** "hourly", "daily 07:00", "weekly mon 07:00" or cron. */
  cadence: string;
  /** A few words for the owner: why it runs on its own. */
  why: string;
}

/** A new capability, ready to build: a create draft, or one of several ideas the owner ticks. */
export interface CreateDraft {
  name: string;
  purpose: string;
  requirements: string;
  spec?: DraftSpec;
  connection?: ConnectionStep;
  schedules?: ScheduleSuggestion[];
}

/** The most ideas one reply offers (each one ticked is a build, so this also bounds a batch). */
export const MAX_IDEAS = 5;

/** `message`: what the intake wants to say first (findings, assumptions, caveats); may be empty. */
export type IntakeReply =
  | { kind: "questions"; message: string; questions: string[] }
  | { kind: "widgets"; message: string; proposals: WidgetProposal[] }
  /** Creating: several separate new capabilities, each a full draft; the owner ticks which to build (in parallel). */
  | { kind: "ideas"; message: string; ideas: CreateDraft[] }
  /** Modifying: nothing to build, only existing operations to run on a timetable. */
  | { kind: "schedules"; message: string; schedules: ScheduleSuggestion[] }
  | { kind: "draft"; message: string; draft: CreateDraft }
  | { kind: "draft"; message: string; draft: { request: string; spec?: DraftSpec; connection?: ConnectionStep; schedules?: ScheduleSuggestion[] } };

/** What the intake has said so far while it is still answering (streamed to the owner). */
export interface IntakeProgress {
  message?: string;
  questions?: string[];
  /** What it is doing right now, e.g. "Looking up goodreads.com". */
  activity?: string;
}
/** `signal`: the owner stopped it (the CLI is stopped too). */
export type Intake = (req: IntakeRequest, onProgress?: (p: IntakeProgress) => void, signal?: AbortSignal) => Promise<IntakeReply>;
