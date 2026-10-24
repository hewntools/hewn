// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner presentation: a capability's name, icon, hue and saturation as the owner sets them
// (presentation only: its id, contract and data stay as they are).
import { type Agent, requireOwner } from "../auth.ts";
import { PlatformError } from "../errors.ts";
import { type Cells, glyphSvg } from "../glyph.ts";
import { Domain } from "./context.ts";

/** Tile saturation cap, in percent of the design system's chroma: more turns neon in dark mode. */
export const MAX_SATURATION = 150;

export class Presentation extends Domain {
  rename(owner: Agent, capabilityId: string, name: string) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    const clean = name.trim();
    if (!clean || clean.length > 60) throw new PlatformError("invalid_request", "name must be 1–60 characters");
    this.registry.setOwnerPrefs(capabilityId, { displayName: clean });
    this.logger(`${capabilityId} renamed to "${clean}" by ${owner.id} (id unchanged)`);
  }

  /** Owner icon: a 5×5 glyph, or an image (png/jpeg/webp/svg, ≤ 256 KB). null clears it. */
  async setIcon(owner: Agent, capabilityId: string, icon: { glyph: Cells } | { type: string; data: Uint8Array } | null) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    const key = `icons/${capabilityId}`;
    if (!icon) {
      await this.blobs.delete(key);
      return this.registry.setOwnerPrefs(capabilityId, { iconType: null });
    }
    if ("glyph" in icon) {
      if (!icon.glyph.length) throw new PlatformError("invalid_request", "a glyph needs at least one lit cell");
      await this.blobs.put(key, glyphSvg(icon.glyph));
      return this.registry.setOwnerPrefs(capabilityId, { iconType: "glyph" });
    }
    if (!ICON_TYPES.has(icon.type)) throw new PlatformError("invalid_request", `icon must be one of ${[...ICON_TYPES].join(", ")}`);
    if (icon.data.length > 256 * 1024) throw new PlatformError("invalid_request", "icon must be at most 256 KB");
    await this.blobs.put(key, icon.data);
    this.registry.setOwnerPrefs(capabilityId, { iconType: icon.type });
  }

  /** Owner tile hue (0–359), or null to use the manifest's. Presentation only. */
  setHue(owner: Agent, capabilityId: string, hue: number | null) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    if (hue !== null && !(Number.isInteger(hue) && hue >= 0 && hue <= 359)) throw new PlatformError("invalid_request", "hue must be an integer 0–359");
    this.registry.setOwnerPrefs(capabilityId, { hue });
  }

  /** Tile hue: the owner's, else the manifest's. */
  hueOf(capabilityId: string): number | null {
    return this.registry.getCapability(capabilityId)?.hue ?? this.activeManifest(capabilityId).hue ?? null;
  }

  /** Owner tile saturation (percent, 0–150), or null to use the manifest's. Presentation only. */
  setSaturation(owner: Agent, capabilityId: string, saturation: number | null) {
    requireOwner(owner);
    this.visibleActive(owner, capabilityId);
    if (saturation !== null && !(Number.isInteger(saturation) && saturation >= 0 && saturation <= MAX_SATURATION)) throw new PlatformError("invalid_request", `saturation must be an integer 0–${MAX_SATURATION}`);
    this.registry.setOwnerPrefs(capabilityId, { saturation });
  }

  /** Tile saturation in percent: the owner's, else the manifest's; null means the default (100). */
  saturationOf(capabilityId: string): number | null {
    return this.registry.getCapability(capabilityId)?.saturation ?? this.activeManifest(capabilityId).saturation ?? null;
  }

  /** The icon to show (owner's first, then the capability's ui/icon.svg), and whether it is a glyph. `owner: false`: the builder's only (Set icon's Use default). */
  async icon(capabilityId: string, { owner = true }: { owner?: boolean } = {}): Promise<{ data: Uint8Array; type: string; glyph: boolean } | undefined> {
    const cap = this.registry.getCapability(capabilityId);
    if (owner && cap?.iconType) {
      const data = await this.blobs.get(`icons/${capabilityId}`);
      const glyph = cap.iconType === "glyph";
      if (data) return { data, type: glyph ? "image/svg+xml" : cap.iconType, glyph };
    }
    // ui/icon.svg is the builder's glyph; it ships even without a UI, so look it up directly.
    if (!cap?.activeVersion) return undefined;
    const svg = (await this.loadVersion(capabilityId, cap.activeVersion)).files["ui/icon.svg"];
    return svg ? { data: svg, type: "image/svg+xml", glyph: true } : undefined;
  }
}

const ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
