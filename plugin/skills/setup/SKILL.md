---
name: setup
description: Configure the Herdr–Codex plugin on macOS with existing native Herdr, Pi, Goose, and the user's selected model endpoint.
---

Set up Codex chats as external Herdr operators. This plugin includes its
integration runtime and skills; it does not include Herdr, worker binaries,
credentials, or a model server. macOS is the supported first platform. Other
platforms are currently unsupported by this package's worker sandbox.

Start with the packaged [recipient quickstart](../../docs/QUICKSTART.md) for the
end-to-end install, configuration, verification and disabled-default summary, and the
[recipe catalog](../../docs/recipe-catalog.md) and
[troubleshooting guide](../../docs/troubleshooting.md) for optional starters and
upgrade/rollback/limitations.

Resolve `../../scripts/herdr-codex.sh` relative to this skill directory. Check
its `help` using Node 22.19 or newer. Read the packaged
[configuration guide](../../docs/configuration.md) for the exact files and native
prerequisites. Use an existing installation if it satisfies the contract; avoid
reinstalling or changing unrelated Herdr instances.

Find the chosen native `hc`, `herdr-app`, Codex CLI, Node, Python 3, and worker
binaries needed for the task (Pi CLI and optionally Goose). Verify the profile's
Python executable with `--version`; every worker launcher needs it.
Check their installed help/version and actual paths. Keep an isolated Herdr
session/config/state, and use wrappers that consistently select it. On macOS use
the signed full Herdr Core app bundle; preserve any live sessions when addressing
a native startup failure. A desktop app and the older Herdr TUI use different
runtimes, so do not silently substitute the latter.

Verify Codex's experimental app-server queue list/add/update/delete API; the tested
protocol version is 0.167.0-alpha.4.1. A CLI with only a one-way queue command is
insufficient for updating and withdrawing owned notifications. Keep the existing
desktop host for the target chat; do not start another manager. Qualify actual
post-turn delivery separately from a successful queue API call.

Use the user's selected inference endpoint and exact model. Reference an approved
credential file; never request a secret in chat, print its value, or embed it in
the plugin or runtime configuration. Retain provider-specific Pi model
compatibility from the existing profile when available. Ask only for genuinely
missing configuration that connected/local evidence cannot supply.

Create a private integration configuration and model profile using the guide's
examples. All executable, state and profile paths must be absolute. Keep worker
state outside project checkouts. Include the configured Herdr runtime/config/state
directories in `herdrReadPaths` when its CLI is a wrapper. Save the configuration
outside the shareable plugin. Make the selected installation available from any
chat using the packaged `node scripts/install-config.mjs --config /absolute/config.json`
helper. It writes only a private reference at `~/.config/herdr-codex/config.json`,
is idempotent for that same target, and refuses to overwrite another installation.
Inspect an existing default before deliberately changing it. Explicit `--config`
takes precedence over `HERDR_CODEX_CONFIG`, which takes precedence over the user
default. There is no working-directory discovery. Do not reuse another
installation's manager database or change `HOME` to isolate it.

Use native text reads/commands and the app CLI for setup and routine operation;
do not use screenshots, vision or computer use for routine Herdr work. Verify
the selected core and native app, start the bridge, and inspect its
listening state. Bind an explicit absolute project directory to the exact current
existing chat UUID; the canonical checkout is shared by its task and worker. Qualify a
real question/result through the selected worker, yield the Codex turn, and
record actual receipt before claiming the wake path is working. Do not add
scheduled polling, a second Codex manager, or an alternative host/model to make
a failed wake test appear successful.

On an inbox notification run `notification receive --id ID`, read its current
messages, and reconcile only if `actionable=false`. Resolve each actionable
message before acknowledging it. Never blindly resend an ambiguous host add.

Use the [Herdr operating skill](../herdr/SKILL.md) to delegate the user's task and
answer returning messages. Report what was configured, what was actually tested,
and any remaining host or startup limitation. Runtime-fault and settled-team
attention notifications still require review; they do not certify success.

After installing or upgrading the plugin, verify that its local MCP server is
actually surfaced rather than merely enabled. Run the packaged launcher relative
to this skill directory; it resolves the installed runtime entry point
(`runtime/src/cli.mjs`) itself:

```sh
../../scripts/herdr-codex.sh plugin doctor --timeout-ms 15000
```

A healthy report is `"ok": true` with sixteen tools (`spawn_agent`, `send_message`,
`followup_task`, `interrupt_agent`, `stop_agent`, `cancel_request`, `list_agents`,
`get_job_status`, `show_agent`, `wait_agent`, `read_agent`, `receive_notification`,
`read_review_packet`, `resolve_message`, `capture_review`, `verify_review`). It performs
one MCP initialize/tools-list handshake only: no tool call, no worker launch, no model
and no writes. This doctor is a **packaging/MCP handshake check only**. It does not prove
that native Herdr, Pi, Goose, Python or a compatible Codex app-server are installed, and
it does not prove that a worker message reaches the chat. Verify those prerequisites
explicitly and qualify a real post-turn wake before treating the chat as ready. An
`node src/cli.mjs` invocation is a **source-development** form that only works inside the
source checkout; installed plugins must use the packaged launcher above. If it passes but the chat lists no Herdr tools, the host did not
surface the plugin server: reinstall the corrected package with
`codex plugin marketplace add /absolute/share-folder --json` then
`codex plugin add herdr-codex@herdr-codex-local --json`, or register the server
explicitly with
`codex mcp add herdr-agents -- /bin/sh /absolute/plugin/scripts/herdr-agents.sh`,
then reload the host. The plugin's `mcp.json` must keep a plugin-relative
command (`./scripts/herdr-agents.sh`); absolute or out-of-tree commands are
rejected and yield zero tools.

Desks are additive to this installation. After runtime setup, use `desk create`
to register an explicitly chosen area of responsibility and optional existing
vault. Keep database/worker state outside that vault. Consult the
[Desk guide](../../docs/desks.md) for resources and specialist definitions.
Do not import another client's desk or enable recurring/email/spreadsheet work
as an implicit setup step.
