# Spec note: tools that build on published tools

Status: decided (owner, 2026-10-26; design pass 3, frame R8 in `reference/ui_kits/web/Hewn Screens v3.dc.html`). The feature is 0.5, with the hub; the manifest fields are ABI 2.5, with 0.4.9. Extends 0.4.10's connections in bundles (use the recipient's connection, or install the bundled one alongside) from connections to tools.

## Problem
A tool can already use another tool's operations (`requires.capabilities`, e.g. Brew Stats on Coffee Log). A bundle only carries itself, and 0.4.10 only carries a **connection** with it. Installing a hub tool that uses another tool leaves the recipient with a broken tool, or forces the publisher to merge both into one.

## Decision
- **A listing can declare that it builds on other listings:** `requires.capabilities[]` entries gain an optional `hub: "<publisher>/<slug>"` and `minVersion`. On publish, Hewn fills these in for any required tool that came from the hub (its `source`). A required tool the publisher made themselves must be published first, or publishing stops: "Brew Stats uses Coffee Log, which isn't on Hub. Publish Coffee Log first."
- **The bundle never contains the other tool.** It's fetched from the hub by reference, like a package dependency, so updates and takedowns stay with its own listing.
- **Install resolves before the sheet** and shows "Installs N tools, in this order" (dependencies first), each with its Hub page link. One level deep in 0.5; a dependency's own dependencies are refused ("Too many steps: install Sky Log first").
- **The recipient already has it**, matched by `source`:
  - From the same listing, at `minVersion` or newer: used as is.
  - From the same listing but older: updated first, through the normal update (T2/T3: unchanged updates directly, changed asks).
  - Same id but made locally or from elsewhere: asks **Use mine** / **Install alongside** (as with connections). Use mine checks that the required operations exist; if they don't, a build adds them, and the sheet says so.
- **Grants:** each installed tool asks for its own grants after install. The dependant's grant to call the dependency is pre-filled from the manifest and still needs approval (the Request pattern).
- **Uninstall, takedown and Unlist:** deleting a dependency that others use warns with the cap-refs (existing delete confirm). A takedown of a dependency leaves installed copies working, as now; new installs of the dependant are refused with "Sky Log was removed from Hub." **Unlist** does the same for new installs ("Sky Log was unlisted.") until the dependant's publisher publishes a version that doesn't build on it; the publisher who unlists is told first ("Aurora Watch by @anna builds on it: new installs of it stop"), and the dependant's publisher gets an Inbox note.
- **Shown on the listing (Q3):** "What it needs › Builds on ▣ Sky Log · @hewn · installed with it if you don't have it".
- **The hub service:** the listing stores the resolved references. Install counts for a dependency installed this way count once, as an install.

## Not in scope
Version ranges beyond `minVersion`; more than one level; dependencies on links or files (only hub listings can be depended on).

## Settled (owner, 2026-10-26)
- A dependency installed only for another tool is **not** hidden from Home. It's a tool like any other, and its tile shows it's used by the other.
- **Unlist blocks new installs of dependants** (above), until they publish a version without it.
- The `hub` and `minVersion` fields are **ABI 2.5** (0.4.9), unused until the hub resolves them in 0.5. Until then a bundle that names a tool the recipient lacks fails validation as it does today ("sky-log/get_night@1 does not exist").
