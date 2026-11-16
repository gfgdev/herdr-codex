# QUICKSTART — recipient setup on macOS

This package lets an existing Codex chat operate real native Herdr workers. The
artifact is **source and configuration only**: it does not include Herdr, worker
binaries, a model server, credentials, or private task state. Nothing here installs
dependencies or runs a model for you.

Use your own absolute paths and your own provider credentials. Every placeholder in
this guide (`/absolute/...`, `ACTUAL-CODEX-CHAT-UUID`, `YOUR-MODEL`) must be
replaced with values from the recipient host. Never paste a credential value into a
chat, a config file, or the plugin; reference an approved credential **file**.

## 1. Supported prerequisites

- **macOS.** Linux and Windows are unsupported by this package's worker sandbox.
- **Node.js 22.19 or newer**, including the `node:sqlite` builtin. Confirm with
  `node --version`.
- **Python 3**, resolved to a verified absolute executable (default `/usr/bin/python3`).
- **Native Herdr core** with `connect`, documents/CAS and event subscriptions, plus the
  native Herdr desktop app. Development observed core 0.1.21 and app 0.1.15.
- **The worker harnesses you intend to use**: native Pi CLI (development observed
  Pi CLI 1.4.0) and optionally Goose (development observed Goose 1.57.0). Pi is not
  the Durable variant. These are observations, not a compatibility guarantee.
- **A compatible Codex desktop/CLI** that exposes the experimental app-server
  `thread/queue/list`, `add`, `update` and `delete` API. The tested protocol version is
  **0.167.0-alpha.4.1**. The existing desktop host must own the target chat.
- **Your selected endpoint, exact model, and an approved credential-file reference.**
  Preserve the model you selected; never silently substitute it.

See [configuration.md](configuration.md) for the full file contract and wrapper notes.

## 2. Install the local marketplace

From the extracted artifact folder (the folder containing `.agents/` and `plugins/`):

```sh
codex plugin marketplace add /absolute/path/to/this/folder --json
codex plugin add herdr-codex@herdr-codex-local --json
```

Reload the Codex host after installing. If the chat lists no Herdr tools, the host did
not surface the MCP server; see [troubleshooting.md](troubleshooting.md).

## 3. Configure with your own paths and credentials

Run the packaged **setup** skill (`plugins/herdr-codex/skills/setup/SKILL.md`) and let it
guide you. The essential steps are:

1. Copy [config.example.json](config.example.json) and
   [profile.example.json](profile.example.json) into a **private** directory outside any
   checkout, and replace every example path with your own absolute paths.
2. Point the profile's `credentialFile` at your approved credential file, and keep the
   selected endpoint/model unchanged.
3. Set `herdrReadPaths` to the runtime/config/state directories your `hc`/`app` wrappers
   need. Keep integration state outside source checkouts.
4. Make the installation available to every chat:

```sh
node /absolute/plugin/scripts/install-config.mjs --config /absolute/private/herdr-codex/config.json
```

Configuration selection is explicit and never searched from the working directory:
`--config` beats `HERDR_CODEX_CONFIG`, which beats `~/.config/herdr-codex/config.json`.

## 4. Verify before you trust it

```sh
/absolute/plugin/scripts/herdr-codex.sh plugin doctor --timeout-ms 15000
```

A healthy report is `"ok": true` with sixteen tools (`spawn_agent`, `send_message`,
`followup_task`, `interrupt_agent`, `stop_agent`, `cancel_request`, `list_agents`,
`get_job_status`, `show_agent`, `wait_agent`, `read_agent`, `receive_notification`,
`read_review_packet`, `resolve_message`, `capture_review`, `verify_review`). The doctor
performs one MCP initialize/tools-list handshake only: no tool call, no worker launch,
no model call, no writes.

Then bind work to the **actual existing chat UUID** and qualify a real wake: ask for one
small task, let the worker send a question or result, and confirm the message actually
arrives after the Codex turn ends. A queue receipt alone is not proof.

## 5. Give Codex a task

```text
Use Herdr for this task.
Project: /absolute/your/project
Outcome: [desired behavior and constraints]

Keep this Codex chat as my manager. Use my selected model profile. Choose the workers
useful for the task and let them consult each other directly. Send questions and
results back here. Show their native Herdr terminals and verify the actual changes and
tests.
```

Codex remains the manager in your existing chat; workers are genuine Herdr terminals you
can watch.

## 6. Optional Desk recipes

Three editable Desk recipe starters (coding, research, operations) and a dormant opt-in
compaction example ship with the package. They are examples, not active jobs. See
[recipe-catalog.md](recipe-catalog.md).

## 7. What is disabled by default

- **No recurring automation is enabled.** Every supplied automation ships with
  `enabled: false`; you enable one explicitly with its owner chat.
- **No scheduled polling job or second Codex manager is installed.**
- **Compaction is dormant and opt-in.** The adapter modules travel with the runtime but
  are not auto-wired; nothing activates them.
- **No login supervisor, exactly-once delivery, or cross-platform support** is claimed.

## 8. Limitations and recovery

Read [troubleshooting.md](troubleshooting.md) for common failures, upgrade/rollback, and
the full limitations list before you rely on the package for real work.
