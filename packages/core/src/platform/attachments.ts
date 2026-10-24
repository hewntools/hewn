// SPDX-License-Identifier: AGPL-3.0-or-later
// Attachments: images and files the owner attaches in the intake's box, and their copies for a build.
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { fromBase64, toBase64 } from "../files.ts";
import { checkImage } from "../models.ts";
import type { Files } from "../ports.ts";
import type { AttachmentRef, BuildTurn } from "../registry.ts";
import { randomToken } from "../sha256.ts";
import { Domain } from "./context.ts";

/**
 * What the owner may attach in the intake's box: images (resized by the web client first) and
 * text files, per message and per conversation. The bytes are blobs; the builder gets copies.
 */
export const ATTACHMENT_LIMITS = {
  image: { bytes: 2 * 1024 * 1024, perMessage: 5, perConversation: 10 },
  file: { bytes: 256 * 1024, perMessage: 10, perConversation: 20 },
} as const;
const MAX_ATTACHMENT_NAME = 120;
const SESSION_ID = /^[\w-]{1,80}$/;
/** A text file: a known text type, or bytes that read as text (no NUL). */
const TEXT_MEDIA = /^(text\/.*|application\/(json|xml|x-yaml|yaml|toml|javascript|typescript|sql|csv|x-sh|x-httpd-php))$/;

/** The owner's attachment with its bytes, as the intake gets it (base64) or the owner's browser fetches it. */
export interface AttachmentWithData extends AttachmentRef {
  data: string;
}

/** The refs of everything a conversation attached, in order, each once. */
export const attachmentRefs = (turns: BuildTurn[]): string[] => [...new Set(turns.flatMap((t) => (t.attachments ?? []).map((a) => a.ref)))];

/** A file name the workspace can take: the base name, safe characters only, short. */
const safeName = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "").slice(0, 80);
  return clean || "file";
};

export class Attachments extends Domain {
  /**
   * Keep an image or file the owner attached (the web client uploads each as it's added): checked
   * (type, size, an image's pixels), stored as a blob, and remembered under the conversation. It
   * goes to a build when the conversation leads to one; otherwise it's dropped after a day.
   */
  async addAttachment(owner: Agent, a: { session?: unknown; kind?: unknown; name?: unknown; mediaType?: unknown; data?: unknown }): Promise<AttachmentRef> {
    requireOwner(owner);
    if (typeof a.session !== "string" || !SESSION_ID.test(a.session)) throw new PlatformError("invalid_request", "session must be a short id");
    if (a.kind !== "image" && a.kind !== "file") throw new PlatformError("invalid_request", 'kind must be "image" or "file"');
    if (typeof a.name !== "string" || !a.name.trim() || a.name.length > MAX_ATTACHMENT_NAME) throw new PlatformError("invalid_request", `name: up to ${MAX_ATTACHMENT_NAME} characters`);
    if (typeof a.mediaType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mediaType)) throw new PlatformError("invalid_request", "mediaType must be a media type");
    if (typeof a.data !== "string") throw new PlatformError("invalid_request", "data must be base64");
    const limits = ATTACHMENT_LIMITS[a.kind];
    const invalid = (message: string) => new PlatformError("invalid_request", message);
    let bytes: Uint8Array;
    let size: { width: number; height: number } | undefined;
    if (a.kind === "image") {
      // The same check a tool's model call gets: type, bytes, pixels (a 2 MB image can still be 20000 px wide).
      ({ bytes, ...size } = checkImage(a.data, a.mediaType, limits.bytes, invalid));
    } else {
      try {
        bytes = fromBase64(a.data);
      } catch {
        throw invalid("data must be base64");
      }
      if (!bytes.length) throw invalid("the attachment is empty");
      if (bytes.length > limits.bytes) throw invalid(`a file may be at most ${Math.round(limits.bytes / 1024)} KB`);
      if (!TEXT_MEDIA.test(a.mediaType) || bytes.subarray(0, 4096).includes(0)) throw invalid("files must be text (a script, notes, CSV, JSON…)");
    }
    const have = this.registry.attachmentsOf(a.session).filter((x) => x.kind === a.kind).length;
    if (have >= limits.perConversation) throw invalid(`at most ${limits.perConversation} ${a.kind}s in one conversation`);
    const ref = `at-${randomToken(9)}`;
    await this.blobs.put(`attachments/${ref}`, bytes);
    const row: AttachmentRef & { session: string } = { ref, session: a.session, kind: a.kind, name: safeName(a.name), mediaType: a.mediaType, bytes: bytes.length, ...(size ?? {}) };
    this.registry.insertAttachment(row);
    const { session: _s, ...meta } = row;
    return meta;
  }

  /** An attachment's bytes, for the owner's browser (a thumbnail, a file) and the intake. */
  async attachmentBytes(owner: Agent, ref: string): Promise<{ meta: AttachmentRef; bytes: Uint8Array }> {
    requireOwner(owner);
    const a = typeof ref === "string" ? this.registry.attachment(ref) : undefined;
    const bytes = a ? await this.blobs.get(`attachments/${ref}`) : undefined;
    if (!a || !bytes) throw new PlatformError("not_found", `no attachment ${ref}`);
    const { session: _s, buildId: _b, createdAt: _c, ...meta } = a;
    return { meta, bytes };
  }

  /** The owner's attachments behind one message's refs (what they are, from the store), in order, each once; within the per-message limits. */
  resolveAttachments(refs: unknown): AttachmentRef[] {
    if (!Array.isArray(refs) || refs.length > ATTACHMENT_LIMITS.file.perMessage + ATTACHMENT_LIMITS.image.perMessage) throw new PlatformError("invalid_request", "attachments: a short list of refs");
    const out: AttachmentRef[] = [];
    for (const x of refs) {
      const ref = typeof x === "string" ? x : x && typeof x.ref === "string" ? x.ref : undefined;
      if (!ref) throw new PlatformError("invalid_request", "each attachment needs a ref");
      const a = this.registry.attachment(ref);
      if (!a) throw new PlatformError("not_found", `no attachment ${ref}`);
      if (out.some((o) => o.ref === ref)) continue;
      const { session: _s, buildId: _b, createdAt: _c, ...meta } = a;
      out.push(meta);
    }
    for (const kind of ["image", "file"] as const) {
      const max = ATTACHMENT_LIMITS[kind].perMessage;
      if (out.filter((a) => a.kind === kind).length > max) throw new PlatformError("invalid_request", `at most ${max} ${kind}s in one message`);
    }
    return out;
  }

  /** Attachments with their bytes (base64), for the intake to read. Owner only. */
  async attachmentsWithData(owner: Agent, refs: unknown): Promise<AttachmentWithData[]> {
    requireOwner(owner);
    const out: AttachmentWithData[] = [];
    for (const meta of this.resolveAttachments(refs)) {
      const bytes = await this.blobs.get(`attachments/${meta.ref}`);
      if (bytes) out.push({ ...meta, data: toBase64(bytes) });
    }
    return out;
  }

  /**
   * The owner's attachments for the builder: copied into the workspace under `attachments/`
   * (never part of a version) and listed in the request, so the builder reads a screenshot of the
   * screen to change, or a script to port, as part of what was asked.
   */
  async attachmentsForBuild(buildId: string): Promise<{ files: Files; note: string }> {
    const turns = this.registry.buildContext(buildId)?.conversation ?? [];
    const files: Files = {};
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const turn of turns) {
      for (const a of turn.attachments ?? []) {
        if (seen.has(a.ref)) continue;
        seen.add(a.ref);
        const bytes = await this.blobs.get(`attachments/${a.ref}`);
        if (!bytes) continue;
        const path = `attachments/${seen.size}-${safeName(a.name)}`;
        files[path] = bytes;
        lines.push(`- \`${path}\`: ${a.kind === "image" ? `an image, ${a.width}×${a.height}` : `a text file, ${Math.max(1, Math.round(a.bytes / 1024))} KB`}, attached with: "${turn.content.slice(0, 120).replace(/\s+/g, " ")}${turn.content.length > 120 ? "…" : ""}"`);
      }
    }
    if (!lines.length) return { files, note: "" };
    return { files, note: `\n\nThe owner attached these, in this workspace (read them as part of the request: a screenshot shows the screen or the look they mean, a file is reference material such as a script to port or data to import):\n${lines.join("\n")}` };
  }
}
