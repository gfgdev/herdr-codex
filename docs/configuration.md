# Configuration and installation

This first package supports **macOS**. Linux and Windows are currently unsupported
by its worker sandbox. The portable plugin contains integration code and skills,
not native worker binaries, a model server, credentials, or private state.

## Prerequisites

- Node.js 22.19 or newer, including `node:sqlite`.
- Python 3 for native worker launch and Goose lifecycle hooks. Set the profile's
  `python` to the verified absolute executable path (default `/usr/bin/python3`).
- Native Herdr core with `connect`, documents/CAS and event subscriptions, and
  native Herdr desktop. Development uses core 0.1.21 and app 0.1.15.
- Native worker binaries for the chosen roles/model. Development uses Pi CLI 1.4.0
  and Goose 1.57.0; these are observations, not a guarantee for every later release.
  Goose is optional when the task does not need it.
- A Codex host/CLI exposing experimental app-server `thread/queue/list`, `add`,
  `update` and `delete`. The tested protocol version is **0.167.0-alpha.4.1**;
  qualify compatibility and actual wake on each host. The existing desktop host
  must own the selected chat.
- The user's selected endpoint, model and approved credential-file reference.

Use the native vendors' verified installations. Herdr's original terminal TUI
has a separate runtime; it does not share agents with Herdr core/desktop.

## Configuration files

Copy [config.example.json](config.example.json) and
[profile.example.json](profile.example.json) into a private configuration directory.
Replace every example path/value with the actual selected installation. Do not
share the populated files with the plugin artifact. Keep the integration state
directory outside source checkouts and separate from other managers.

`hc` and `app` may be wrappers. Both must select the same private Herdr core and
session. A typical wrapper selects `HC_SESSION`, `XDG_CONFIG_HOME`,
`XDG_STATE_HOME`, and a short private `XDG_RUNTIME_DIR`; the app also selects its
own `HERDR_APP_HOME`. Do not alter `HOME` to isolate an application. Native socket
paths have OS length limits. Native app settings can pin the same `hc` wrapper.

`herdrReadPaths` supplies the runtime/config/state locations a worker needs when
the executable path alone does not reveal a wrapper's dependencies. Worker
processes get their own writable runtime/scratch directory and the task's explicit
writable paths. The native Herdr control API retains local operator authority;
the direct filesystem sandbox is not an authorization layer over that API.

The model profile holds only configuration and a credential-file path.
`piModelsFile` optionally points to an existing Pi models file containing the
selected endpoint/model's compatibility fields. If omitted, the launcher checks
for `pi-models.json` beside the profile, then uses generic OpenAI-compatible model
settings. Use the real provider compatibility settings where required; do not
substitute models after a failure. Credentials are read immediately before worker
execution and placed in the process environment, never in returned argv.

The package does not provision inference or impose request/turn-count cutoffs.
Worker output length/context settings remain model configuration, while wait
timeouts merely return control to the operator.

## Make the installation available in every chat

Version 0.8.1 and later also register the `herdr-agents` MCP server from the plugin-relative
`mcp.json`. Its [subagent tools](agent-tools.md) use the same configuration and
existing bridge. The manifest command must stay inside the plugin root; a
non-relative command is rejected and leaves the chat with no Herdr tools. Verify
surfacing with the read-only `plugin doctor` (see
[Local MCP discovery](agent-tools.md#local-mcp-discovery)) and reconnect/reload
the host's tools after upgrading if they are not discovered automatically. No
native tool interception hook is installed.

The installed plugin uses one explicit configuration selection, independent of
the current project or terminal directory:

1. An explicit `--config /absolute/config.json` argument.
2. `HERDR_CODEX_CONFIG`, if the argument is absent.
3. `~/.config/herdr-codex/config.json`, if neither is supplied.

The default path uses the current user's home directory; do not change `HOME`.
There is no search through the checkout, parent directories, other installations,
or `XDG_CONFIG_HOME`. A missing or invalid selected file fails instead of falling
back to another installation. This keeps a new chat from silently selecting the
wrong model, state directory or Herdr session.

The user default can contain the full configuration, or only this reference to
an existing private configuration:

```json
{
  "version": 1,
  "configFile": "/absolute/private/herdr-codex/config.json"
}
```

A reference must contain only these two fields and point directly to a full
configuration; chains are rejected. It does not copy credentials or runtime state.
From the expanded/installed plugin, create it with:

```sh
node /absolute/plugin/scripts/install-config.mjs --config /absolute/private/herdr-codex/config.json
```

The helper creates a mode-0600 reference, accepts an identical existing reference,
and refuses to overwrite a different default. It validates the target's
configuration without reading the model profile or credential file, creating
runtime state, starting the bridge or changing existing workers. Deliberately
switching the default affects future commands; inspect the existing registration
and live work first. Detached bridges retain their explicitly selected config.

Once the plugin is installed and the user default is set, start any Codex chat
and ask: “Use Herdr for [outcome] in [absolute project path]. Keep this chat as my
manager, use the selected model profile, and return questions and results here.”
Codex binds new work to that chat and chooses the workers the task needs.

## Durable runtime

An installed plugin cache is disposable: a host upgrade or reinstall can prune or
replace the version directory that a running worker, its `herdr-message` helper,
its Goose hooks/recipes and the detached bridge were launched from. Version 0.8.2
removes that coupling.

Before the first command of a process runs, Herdr publishes an immutable,
source-only snapshot of the integration runtime under the configured state
directory:

```
<stateDir>/runtime/v1-<content-key>/
  manifest.json      # version, key and per-file sha256/bytes
  src/*.mjs, *.py    # only the shipped integration sources
```

The snapshot contains no credentials, model or provider binaries, user state or
unrelated files. It is keyed by content, so identical runtimes reuse one copy and
changed sources publish a new directory. Publication is atomic (a staged
directory is `rename`d into place) and read-only (`0o400` files, `0o500`
directories).

`packageRoot` is then pinned to the snapshot for the whole process: worker helpers
and argv, the Goose Stop hook and recipes, the notification inbox references and
the bridge child all resolve inside `<stateDir>/runtime/v1-<content-key>`. The
bridge lock, ownership and lifecycle are unchanged, so no duplicate or restart is
triggered. A worker, helper or bridge keeps running if the installed cache it came
from is later pruned.

Reuse revalidates the recorded manifest and every file digest; a tampered,
extended, corrupt or symlink-substituted snapshot is refused rather than trusted.
Concurrent publication converges on one validated snapshot, and a losing
publisher removes only its own staging directory.

Legacy sessions that were launched before 0.8.2 keep their existing paths until
they drain. They are not retroactively migrated; let them finish, then start new
work so it binds to the durable snapshot. Treat the cache directory as
disposable only after any such session has drained.

## Run

From an expanded portable plugin:

```sh
/absolute/plugin/scripts/herdr-codex.sh help
/absolute/plugin/scripts/herdr-codex.sh bridge start
/absolute/plugin/scripts/herdr-codex.sh bridge status
```

The script uses `node` on PATH; `HERDR_CODEX_NODE` can select a particular Node
executable. These variables select only this integration. A local shell wrapper
can retain explicit executable/config paths without embedding them in a plugin.

Read the Herdr skill for task binding, worker launch, messages and viewing. A
registered task binds one explicit absolute project directory and one existing
chat. Paths are canonicalized; worker/task checkout bindings cannot be silently
changed. Native cwd, worker/task labels and recorded process identity are checked
before continuation and desktop placement. Workers can directly
consult each other, but manager messages route through that task's registration.
Codex operates through native text reads, prose sends, named keys and structured
CLI responses. It uses the app CLI to arrange the genuine native desktop. Routine
operation does not use screenshots, vision or computer-use tools.

## Wake qualification and persistence

The bridge is a background event listener, not a scheduled job. It subscribes to
Herdr events and ingests mailbox documents into SQLite. One mutable pending
notification per manager chat groups reports by project/task. Later reports update
its owned host queue entry while pending; handled entries can be withdrawn.
Queue maintenance verifies recorded identities and leaves unrelated messages
untouched. It does not start/resume a chat or reorder its queue.

The connector negotiates `experimentalApi` with the official app-server protocol.
It uses the shared app-server control socket when available; its stdio transport
can maintain queue metadata but does not by itself establish desktop liveness.
This does not depend on changing MCP tool lists. After host upgrades, verify the
queue methods and real delivery instead of assuming protocol compatibility.

On receipt, run `notification receive --id NOTIFICATION-ID` and use its current
inbox rather than the queued preview. `actionable=false` means reconcile only;
do not restart work. For each actionable message, inspect evidence, record a reply
or accept/abort decision, then acknowledge after that action completes. Legacy
single-message wakes can still use `message receive`.

Local state distinguishes queue acceptance, actual chat receipt, action and
acknowledgment. Definite host rejection can retry; ambiguous mutations require
identity reconciliation. An absent entry may already have started a turn, so
unknown delivery is never blindly re-added. These checks do not establish
exactly-once delivery. Runtime faults and settled teams can trigger attention even
without an explicit report; they do not establish correctness or completion.

**A queue receipt alone does not verify wake.** On each new host setup, exercise a
real registered worker question, let the Codex turn end, and observe the message
arrive before claiming successful idle-chat delivery. Then answer through the
integration and acknowledge after the action completes. Do not paper over a
failed host test with scheduled polling or another manager model.

Desktop `show` matches only local project spaces and verifies the target worker
and split anchors. Missing/ambiguous matches require an explicit matching space.
Native placement still depends on global focus: a last-moment race is reported
and is not automatically repaired by moving or closing tabs. Keep unrelated
project spaces and their agents outside cleanup.

No login supervisor is installed by this package. The bridge and workers can
outlive an individual Codex turn; closing applications, logout and reboot have
separate native lifecycle requirements. Herdr reports a direct-start fallback if
macOS launchd detachment fails. Preserve live work and inspect those logs instead
of promising app-exit durability from a successful window-reopen test alone.

Native Herdr updates remain the native installation's responsibility. Use `capabilities check` for candidate schema differences and `runtime qualify` for isolated behavioral checks before switching. Configure optional `nativeExecutables.core/app` paths for exact binary fingerprints. See the [native capability guide](native-capabilities.md) and [qualification guide](native-qualification.md).
The package does not fork Herdr or hide its native features behind a fixed MCP list.

References: [Herdr](https://herdr.dev/),
[native core](https://github.com/herdrdev/herdr-core),
[native app](https://github.com/herdrdev/herdr-app),
[plugin packaging](https://developers.openai.com/plugins/build/plugins).
