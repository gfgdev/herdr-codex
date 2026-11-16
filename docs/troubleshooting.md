# Troubleshooting, upgrade/rollback and limitations

This page covers the failures recipients most often hit, how to upgrade or roll back,
and the limits you should not rely past. It is deliberately conservative: a receipt, a
file, or a terminal status is not proof of results.

## Troubleshooting

### The chat lists no Herdr tools

The plugin's MCP command must stay **plugin-relative** (`./scripts/herdr-agents.sh`).
An absolute or out-of-tree command is rejected and yields zero tools.

1. Run the read-only probe and confirm it reports `"ok": true` and sixteen tools:

   The packaged launcher is `/absolute/plugin/scripts/herdr-codex.sh` (it resolves
   `runtime/src/cli.mjs`); it is the supported recipient entry point.

   ```sh
   /absolute/plugin/scripts/herdr-codex.sh plugin doctor --timeout-ms 15000
   ```

2. If the probe passes but the chat still lists no tools, the host did not surface the
   server. Reinstall the corrected package, then reload the host:

   ```sh
   codex plugin marketplace add /absolute/path/to/this/folder --json
   codex plugin add herdr-codex@herdr-codex-local --json
   ```

3. Or register the server explicitly, then reload:

   ```sh
   codex mcp add herdr-agents -- /bin/sh /absolute/plugin/scripts/herdr-agents.sh
   ```

### `plugin doctor` fails or reports fewer/more tools

The doctor performs one MCP initialize/tools-list handshake, no tool call and no writes.
A non-zero count of duplicates, missing or unexpected tool names means the packaged
server graph is wrong — reinstall the artifact and re-run; do not hand-edit the tool list.
`--timeout-ms` only bounds the probe.

### A queue receipt arrived but no message reached the chat

A queue receipt means the host **accepted** the message, not that the chat consumed it.
Qualify real post-turn delivery: ask a worker for one small result, end the Codex turn,
and confirm the message actually appears. Verify the Codex host exposes the experimental
app-server `thread/queue/list`, `add`, `update` and `delete` API (tested protocol
**0.167.0-alpha.4.1**); a one-way queue command is insufficient. Keep the existing desktop
host for the target chat and do not start a second manager to make a failed wake look
successful. Offline delivery, app-exit recovery, logout and reboot are not universally
guaranteed, and this package installs no login supervisor.

### Native Herdr or app startup fails

Use the signed full Herdr core app bundle on macOS and an isolated
session/config/state. On a startup failure, **preserve live sessions** rather than
killing them. Herdr's older terminal TUI is a separate runtime — do not silently
substitute it for core/desktop.

### A worker cannot reach the native socket, or the sandbox denies access

`hc`/`app` may be wrappers. Ensure both select the same private core/session and that
`herdrReadPaths` includes the wrapper's runtime/config/state directories. The direct
filesystem sandbox is **not** an authorization layer over the native Herdr control API,
which retains local operator authority: only run trusted, scoped workers. Keep integration
state outside source checkouts and do not change `HOME` to isolate an application.

### Desk validation or sync fails

Fix the reported authored file, then re-run `desk validate` / `desk sync`. The starter
installer rejects a conflicting existing file before copying anything and never
overwrites `DESK.md`, `AGENTS.md` or `desk.yaml`. A resource's presence in a desk does not
make all of it writable; read/write access combines with the specialist's scope.

### A trigger did not fire

All supplied automations ship `enabled: false`. Enable one explicitly with its exact
owner chat and inspect `desk trigger-status`. Native recipe validation is not proof of
task quality: run one small representative task and inspect outputs first. Editing a file
to disabled stops future dispatch, not already-accepted work.

### Two writers touched the same checkout

Keep one writer per coding checkout and give independent jobs their own workspaces. If a
worker is lost or replaced, inspect the actual process before recovering it; a replacement
shell is not the original agent. Never blindly resend an ambiguous host add.

## Upgrade

1. Extract the new artifact to a **new** folder.
2. Re-add the marketplace from that folder and reinstall the plugin, then reload the host.
3. Re-run `plugin doctor` and hydrate the tool list.
4. Existing private configuration and the durable runtime snapshot are separate from the
   plugin cache, so a reinstall does not copy credentials or task state. Legacy sessions
   keep their original paths until they drain; start new work so it binds to the current
   snapshot.
5. After a host upgrade, re-verify the queue methods and a real post-turn wake instead of
   assuming protocol compatibility.

## Rollback

The installed plugin cache is disposable; keep a copy of the previous artifact folder.
To roll back, re-add the marketplace from the **previous** folder, reinstall, and reload
the host. Published runtime snapshots are content-keyed (`<stateDir>/runtime/v1-<key>/`)
and immutable, so the prior snapshot remains available if you still need it. Rollback does
not silently change your selected endpoint/model or reuse another installation's manager
database; if a chat still binds old paths, let those sessions drain and start new work.

## Limitations

- **macOS only.** Linux and Windows are unsupported by this package's worker sandbox.
- **No bundled native binaries, model server, credentials or private state.** Setup is
  guided, not a one-click dependency installer.
- **No exactly-once delivery.** Queue receipts prove acceptance, not consumption;
  ambiguous adds are reconciled and never blindly resent.
- **No login supervisor.** App-exit recovery, logout and reboot are not universally
  guaranteed.
- **Compaction is dormant and opt-in.** Only a narrow synthetic manual Goose → Pi slice
  is qualified; automatic/near-limit recovery, summary quality and usage savings are
  unqualified. See [compaction-live-qualification.md](compaction-live-qualification.md).
- **No scheduled polling job or second Codex manager** is installed, and no
  request/turn-count cutoff is imposed.
- **The local Herdr API retains operator authority.** Desk labels and file grants are not a
  hostile-agent, multi-tenant security boundary; use trusted workers.
- **Development harness versions are observations, not guarantees.** Preserve the selected
  model; never silently substitute another.
- **One shared Desk space** is the intended view, but a shared space does not imply shared
  write ownership.

## See also

- [QUICKSTART.md](QUICKSTART.md) — recipient setup
- [recipe-catalog.md](recipe-catalog.md) — optional starters and the dormant compaction example
- [configuration.md](configuration.md) — full configuration contract
- [native-qualification.md](native-qualification.md) — candidate-core qualification
