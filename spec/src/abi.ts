// SPDX-License-Identifier: Apache-2.0
// The Hewn ABI: one version for the whole contract (the manifest format, `ctx` and grant kinds).
// A tool declares the lowest version it needs in its manifest's `abi`; a host implements one major
// and runs every minor up to its own. Minor versions only add; anything else is a new major.

/** The ABI this spec describes. */
export const ABI = "2.4";

/** What a manifest without `abi` needs. */
export const DEFAULT_ABI = "2.0";

/** What each minor version added. A tool may use an addition only if its manifest declares at least that version. */
export const ABI_HISTORY: { version: string; added: string[] }[] = [
  { version: "2.0", added: ["the module (`operations`), `ctx.db`, `ctx.secrets`, `ctx.updateSecret`, `ctx.call`, `ctx.caller`, the manifest's operations, `requires` (hosts, capabilities), `ui`, tests/cases.json"] },
  { version: "2.1", added: ['manifest `kind` ("connection"), and `requires.secrets` (connections only: the only kind that holds credentials)', "deprecated operations", "manifest `config`, `ctx.config`, `config:NAME` hosts"] },
  { version: "2.2", added: ["manifest `requires.model`", "`ctx.model.generate`"] },
  { version: "2.3", added: ["manifest `widgets`, and the widget view models their operations return"] },
  { version: "2.4", added: ["manifest `saturation`"] },
];
