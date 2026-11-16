# Contributing

Thanks for helping improve Herdr–Codex. This project is a **macOS-first beta**
(`0.11.0-beta.1`) that lets an existing Codex chat operate native Herdr workers.

The public source repository is [github.com/gfgdev/herdr-codex](https://github.com/gfgdev/herdr-codex)
(verified public). Report problems through its
[issue tracker](https://github.com/gfgdev/herdr-codex/issues); sensitive reports follow
[SECURITY.md](SECURITY.md) instead of a public issue.

## Development setup

- macOS with Node.js **22.19 or newer** (the runtime uses `node:sqlite`).
- Python 3 (the integration shells out to `/usr/bin/python3`).
- For integration work: the native Herdr core and desktop app, the Pi CLI, and an
  optional Goose CLI. See the [recipient QUICKSTART](docs/QUICKSTART.md) and the
  [configuration guide](docs/configuration.md).

There is no build step for the runtime: it is plain ESM under `src/`.

## Running checks

```sh
npm test                                   # full unit/integration suite (node --test tests/*.test.mjs)
node --test tests/plugin-manifest.test.mjs # focused manifest/provider checks
```

Some integration tests create local Unix domain sockets. In a sandbox that forbids
socket creation they fail with `EPERM`; that is an environment restriction, not a code
defect. Run them on a host that permits local sockets before reporting a failure.

Live-provider qualification harnesses under `scripts/` are **optional** and are not part
of `npm test`. They are portable via environment overrides and require explicit paths:

- `PI_CODING_AGENT_DIST` — absolute path to the installed
  `@earendil-works/pi-coding-agent` dist entry.
- `GOOSE_BIN` — Goose executable (otherwise `goose` is resolved on `PATH`).

They never print credential values and never change the selected provider/model.

## Packaging checks

The share artifact is produced only by the reviewed builder, which refuses to overwrite an
existing destination and re-runs a private-content scan, document-link check, packaged CLI
help check and packaged MCP tool-discovery check:

```sh
node scripts/build-plugin.mjs --out /absolute/new/share-folder
```

## Contribution expectations

- Keep changes inside a clearly described scope; one writer per checkout.
- Keep `package.json` and `plugin/plugin.json` versions in agreement.
- Do not commit credentials, `sk-`-style tokens, private absolute paths, session
  transcripts, model output dumps or machine-specific state.
- Update `CHANGELOG.md` and the relevant document under `docs/` with behavior changes.
- Keep documentation honest about what is **shipped and runnable** versus what is
  recorded development evidence.

## Reporting problems

Use the repository's [issue tracker](https://github.com/gfgdev/herdr-codex/issues) for bugs
and feature requests. For anything sensitive, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## License

By contributing you agree that your contributions are licensed under the MIT License; see
[LICENSE](LICENSE).
