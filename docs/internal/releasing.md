# Releasing

Users install with `npm install -g @hewntools/cli` (or `curl -fsSL https://hewn.tools/install.sh | sh`, which does the same). `hewn upgrade` installs the newest published version in their 0.x line (or prints the command when npm's global folder needs sudo), then backs up and restarts. Contributors who run Hewn from a checkout (`./install.sh`) upgrade by moving to the newest tag in their line. Either way, a release is a tag **and** a published package with the same version.

## Cut a release

1. On `main`, with CI green:
   - bump `version` in `package.json` and every `packages/*/package.json`, then `npm install --package-lock-only`
   - add the `CHANGELOG.md` entry
   - commit
2. Tag that commit with the same version and a leading `v`: `git tag v0.4.1 && git push origin v0.4.1`.
3. CI runs on the tag on Linux (macOS only on a manual run: Actions → CI → Run workflow, worth doing before a release that touches the macOS sandbox, service or install). It fails if the tag and `package.json` disagree. Don't publish a tag that's red: delete it (`git push origin :v0.4.1`) and fix forward.

## Publish to npm

**Be careful with publishing:** a version can only be unpublished for 72 hours, and a version number is never reusable.

After the tag is green:

1. `npm run build:npm`: builds `build/npm/cli` (the CLI bundled to `dist/cli.js`, the workerd host prebuilt, the web client and the UI kit) and `build/npm/spec` (the contract as JavaScript with declarations, and its JSON Schemas). `test/npm-package.test.ts` checks what they contain and that they run.
2. `npm pack build/npm/cli` and install the tarball into a scratch prefix (`npm install -g --prefix /tmp/x ./hewntools-cli-<v>.tgz`), then start it on spare ports with its own home (`HEWN_HOME=/tmp/x/home HEWN_KEY_SOURCE=file HEWN_PORT=17817 HEWN_PUBLIC_PORT=17818 hewn serve`): `hewn doctor`, `hewn install seeds/running-log`.
3. `npm publish build/npm/cli` and, when the contract changed (its own version, by ABI), `npm publish build/npm/spec`.

An npm install keeps its data in `~/.hewn` (backups in `~/.hewn-backups`; `HEWN_HOME` overrides), never in the package folder, which every upgrade replaces.

## Data format changes

Bump `DATA_FORMAT` in `packages/cli/src/supervisor/format.ts`, and make the core's start-up migration handle the old format. Older versions of Hewn refuse newer data, so say so in the changelog. From 0.4.0 on, every published version's data must keep loading in later versions.
