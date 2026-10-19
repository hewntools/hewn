# Licensing

Hewn is open source under two licences, by folder:

| Path | Licence | Why |
| --- | --- | --- |
| everything not listed below: `packages/core`, `packages/host-workerd`, `packages/cli`, `packages/test-host`, `test/`, `docs/`, the web client | [AGPL-3.0-or-later](LICENSE) | Hewn itself. Anyone may run, change and share it; whoever offers a changed Hewn to others over a network must offer them its source. |
| `spec/` (`@hewntools/spec`) | [Apache-2.0](spec/LICENSE) | The capability contract: types, JSON Schemas, the capability model and the build brief. Anyone may build tools on it or implement another host, without the AGPL applying to them. |
| `packages/ui` (`@hewntools/ui`) | [Apache-2.0](packages/ui/LICENSE) | The UI kit tool UIs load from `/_platform/`. Tool UIs build on it, so it carries no AGPL question. |
| `seeds/` | [Apache-2.0](seeds/LICENSE) | Example tools, meant to be copied. |

Each source file says which applies in its first line (`SPDX-License-Identifier`); a test checks that every file does. Where a file and this table disagree, the file's header wins.

Contributions are made under the licence of the folder they change, with a Developer Certificate of Origin sign-off (`git commit -s`; see `CONTRIBUTING.md`). There is no CLA: Hewn can't be relicensed without its contributors.

## Third-party marks

`packages/host-workerd/web/logos/` holds other companies' logos (agents and model providers), used nominatively. They are not Hewn's and not under its licences: the SVG files come from Simple Icons (CC0-1.0) and LobeHub Icons (MIT), as listed in that folder's `SOURCES.md`, and each mark belongs to its owner.
