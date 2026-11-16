# Native features and compatibility

The integration keeps native execution separate from discovery. `native ...`
forwards Herdr core (`hc`) arguments; `app ...` forwards desktop arguments. The
catalog is documentation and compatibility evidence, never an execution
allowlist. A new installed native feature can be used through the same commands.

Herdr's original terminal TUI uses the older `herdr` CLI and a different API.
Its TUI reference is useful background, but this integration targets `hc` and
`herdr-app`; do not translate TUI command names by guessing. Use the selected
installation's native guides.

```sh
herdr-codex native --help
herdr-codex native --skill
herdr-codex native schema
herdr-codex app --skill
herdr-codex app commands
herdr-codex capabilities status
herdr-codex capabilities search --query 'terminal send'
herdr-codex capabilities describe --id core:terminal.send
herdr-codex capabilities describe --id app:space.new
herdr-codex capabilities describe --id core:skill
herdr-codex capabilities refresh
```

Every explicit catalog access checks the selected native versions and current
inventories. Changes therefore become searchable without replacing MCP tools
or adding wrapper commands. This is ordinary software inspection, not a
scheduled Codex polling job. Use `describe --revision REVISION` when relying on
an earlier description: a changed revision returns `stale: true`, not an
outdated signature. Native commands remain available when discovery fails.

Private state holds the current catalog and revision history under
`capabilities/`. Each snapshot retains full OpenRPC definitions and referenced
schemas, desktop command definitions, help text, agent guides, versions and
hashes. Added, removed and changed entries remain inspectable. Invalid JSON,
duplicate names, missing references and failed probes are reported; the last
valid catalog is retained but is not silently represented as current.

The configured launcher files are hashed. When launchers wrap native binaries,
optionally declare their exact paths in the integration configuration:

```json
{
  "nativeExecutables": {
    "core": "/absolute/path/to/herdr-core",
    "app": "/absolute/path/to/Herdr.app/Contents/MacOS/Herdr"
  }
}
```

Those binaries are also hashed, so a same-version rebuild changes identity.
Without explicit binary paths, inventories still detect feature changes behind
a stable launcher, but a same-version binary change that preserves every
reported inventory cannot be identified. The integration does not parse shell
scripts or inspect model credentials to guess binary locations.

## Checking an upgrade

```sh
herdr-codex capabilities check \
  --candidate-hc /absolute/isolated/hc \
  --candidate-app /absolute/isolated/herdr-app
```

Optional `--candidate-core-binary` and `--candidate-app-binary` add underlying
binary hashes. Select launchers configured for an isolated candidate session:
native CLI discovery may connect to or auto-start the session selected by that
launcher. The checker itself requests only versions, help, guides, schema and
command catalogs. It never requests an install, upgrade, restart, worker launch
or runtime switch, and never replaces the active catalog with a candidate.

Reports distinguish three structural results:

- `requirements-present`: the integration's required methods, parameters,
  result fields and desktop commands are present.
- `review-required`: a consumed contract or referenced schema changed.
- `incompatible`: a required operation, parameter, field or command is absent.

These results are **not behavioral qualification**. The current native schema
describes lifecycle notifications in prose; existence of `events.subscribe`
does not prove that status, turn, crash, recovery or missed-event delivery still
behaves the same way. Reports retain the native event description and mark
behavior `not-verified` until independently tested. They never recommend
activation solely from discovery.

`runtime qualify` runs the packaged isolated native suites and records exact
core-binary and integration/test-source hashes. When `nativeExecutables.core`
identifies the selected binary, capability reports verify that receipt and
show `local-core-fixtures-passed` only while its binary and source hashes still
match. A stale or missing receipt stays unverified. This qualification covers
local core fixtures; desktop behavior, remote hosts and actual later-turn
Codex host wake remain explicitly separate and unverified by those fixtures.

Before switching runtime versions, run isolated tests for transparent native
forwarding, worker adoption, child discovery, lifecycle/recovery, duplicate
delivery and actual Codex host wake. A queue receipt does not prove receipt in
a later chat turn. New native entry points need no wrapper implementation;
new execution, persistence or notification behavior may need integration work.

References: [Herdr core](https://github.com/herdrdev/herdr-core),
[Herdr desktop](https://github.com/herdrdev/herdr-app),
[original TUI CLI](https://herdr.dev/tui/docs/cli-reference/).
