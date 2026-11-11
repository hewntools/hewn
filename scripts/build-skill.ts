// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes skills/build-a-hewn-tool/SKILL.md from spec/builder-brief.md. Run: npm run skill (a test checks it's current).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_PATH, skillText } from "@hewntools/core/skill.ts";

const root = join(import.meta.dirname, "..");
writeFileSync(join(root, SKILL_PATH), skillText(readFileSync(join(root, "spec", "builder-brief.md"), "utf8")));
