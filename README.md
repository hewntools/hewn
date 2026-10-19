<p align="center">
  <a href="https://hewn.tools">
    <picture>
      <source srcset="docs/images/hewn-lockup-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="docs/images/hewn-lockup-light.svg" media="(prefers-color-scheme: light)">
      <img src="docs/images/hewn-lockup-light.svg" alt="Hewn" width="236">
    </picture>
  </a>
</p>
<p align="center">Your own tools. Every agent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@hewntools/cli"><img alt="npm" src="https://img.shields.io/npm/v/@hewntools/cli?style=flat-square"></a>
  <a href="https://github.com/hewntools/hewn/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hewntools/hewn/ci.yml?style=flat-square&branch=main"></a>
  <a href="LICENSING.md"><img alt="Licence" src="https://img.shields.io/badge/licence-AGPL--3.0%20%7C%20Apache--2.0-blue?style=flat-square"></a>
</p>

---

<p align="center"><img src="docs/images/home.png" alt="Hewn's Home: your tools and widgets" width="840"></p>

Hewn keeps small [tools](docs/concepts.md#tools) of your own (a running log, a reading list, a word quiz) on your machine, each with its own data. Describe a tool, and your coding agent builds it in a sandbox; Hewn tests it on a copy of your data before it goes live. Claude, ChatGPT, Codex and any MCP client can then use it, once you've approved them: what you record in one, you can read in another.

### Installation

```sh
curl -fsSL https://hewn.tools/install.sh | sh   # or: npm install -g @hewntools/cli

hewn service install   # run in the background, start at login
hewn open              # connect an agent, build your first tool
```

You need Node.js 24 and Claude Code or Codex, signed in. macOS, Linux and Windows (WSL). See the [quickstart](docs/quickstart.md).

### Documentation

- [Quickstart](docs/quickstart.md)
- [Concepts](docs/concepts.md)
- [Building tools](docs/building-tools.md)
- [Connecting agents](docs/agents.md)
- [Connections](docs/connections.md)
- [Models](docs/models.md)
- [Your data](docs/data.md)
- [Using Hewn from anywhere](docs/remote-access.md)
- [All the docs](docs/README.md), and what changed in the [changelog](CHANGELOG.md)

### Support

Hewn is pre-1.0 and maintained in spare time. Upgrades migrate your data forward, and the tool contract ([the ABI](spec/README.md#versions)) only adds within a major version.

- **Bugs:** an [issue](https://github.com/hewntools/hewn/issues) with `hewn doctor` output and steps to reproduce.
- **Security:** privately, see [SECURITY.md](SECURITY.md).
- **Ideas:** [discussions](https://github.com/hewntools/hewn/discussions). We'll say no to most, to keep Hewn small.

Rather not keep a machine running? [Hewn Cloud](https://hewn.tools/#cloud) is coming.

### Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md): setup, layout, how the contract is versioned, and the DCO sign-off.

### Licence

- Hewn: AGPL-3.0-or-later
- The tool spec (`spec/`), the UI kit (`packages/ui`) and the example tools (`seeds/`): Apache-2.0

Details are in [LICENSING.md](LICENSING.md).
