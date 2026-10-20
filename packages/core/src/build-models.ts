// SPDX-License-Identifier: AGPL-3.0-or-later
// The shape of a model name and an effort a build or the intake may run on. They become a builder
// CLI's arguments (and Codex config), so every host checks them the same way.

/** A model name as a builder's CLI takes it: an alias ("fable"), a full name, or "default". */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;

/** A reasoning effort level ("low", "high", "xhigh" …). */
export const EFFORT = /^[a-z]{2,12}$/;
