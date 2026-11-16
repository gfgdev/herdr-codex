# Codex operating Herdr

Give Codex an outcome. It operates real native Herdr workers through terminal
text, sends natural instructions, answers questions and verifies results. Pi can
implement; Goose can investigate or review when useful. Agents can consult each
other directly while Codex remains the manager in your existing chat.

This is the **0.11.0-beta.1** prerelease: a macOS-first, source-only package you can
share. Start with the [recipient QUICKSTART](docs/QUICKSTART.md), which lists the
supported prerequisites and explains setup with your own absolute paths, provider
credential file and existing chat IDs. The [recipe catalog](docs/recipe-catalog.md)
describes three optional Desk recipe starters plus a dormant opt-in compaction example,
and [troubleshooting](docs/troubleshooting.md) covers failures, upgrade/rollback and
limitations. No recurring automation runs by default.

The runtime keeps workers and the bridge running from a durable, immutable
runtime snapshot and bundles a native-style MCP adapter with subagent tools over
the existing lifecycle and bridge, plus a read-only `plugin doctor` that proves
the local MCP server is discoverable. Steering is truthful: a receipt records
native acceptance, not confirmed consumption, and an intentional `agent stop`
records intent before the kill and confirms the original process exit. The
notification inbox is scoped: `receive_notification` reconciles exactly the
current envelope's member reports and preserves unrelated receipts and future
wakes. Durable review packets, revision-bound reviews and exact owner-scoped
request cancellation round out the manager workflow. A bounded-compaction recipe
ships as a documented example only — it is not wired in or activated. See the
[tool adapter guide](docs/agent-tools.md) and [durable runtime](docs/configuration.md#durable-runtime).
The interface also includes general-purpose **Desks** for coding, research and operations:
linked vaults/resources, work registers, versioned roles, reporting hierarchies,
native Goose recipes and durable multi-step workflows. Native Herdr spaces display desk agents while preserving their actual
project bindings. See the [Desk guide](docs/desks.md).
Linked vaults are shared read/write knowledge resources; read-only roles retain
their narrower scope. Existing resource access can be changed explicitly.
The [editable Desk template](docs/desk-template.md) adds vault scaffolding, Markdown/YAML roles and workflows, separate task output folders and checked publication into shared knowledge.
The coalesced notification inbox and explicit project-routing checks remain.
The [general Desk guide](docs/general-desks.md) explains teams, mixed agent/recipe/command/review
steps, frozen inputs, restart recovery and optional event/interval triggers.
Triggers start disabled and run in the existing bridge when explicitly enabled.
Use the [portable starter kits](examples/desks/README.md) for coding, research or operations.
QMD and authenticated business connectors remain separate integrations.

## Delegate agents and continue their work

The delegation interface gives Codex familiar operations for starting named
agents, handing off selected context, sending notes, continuing sessions,
interrupting, and waiting for activity. The agents are real Herdr terminals you
can watch. It does not intercept Codex's built-in subagent tools: ask Codex to use
Herdr when that is where you want delegation to run.

For a larger task, try:

```text
Use Herdr for this task in [absolute project path]. Break out independent work
into concurrent agents where useful. Give each a focused assignment and the
relevant decisions and constraints. Use separate checkouts for concurrent
writers, let the agents consult assigned peers, and keep this chat as manager.
Show their native terminals. Answer questions here and verify the final result.
```

Codex chooses from reusable explorer, implementer, reviewer, tester and
investigator templates, or an explicitly installed custom template. Templates
provide role guidance and a harness/scope default; they do not change your model
profile or impose a fixed team workflow. Goose is optional.

```sh
herdr-codex delegate --id feature-impl --name feature-impl --project /absolute/checkout --thread EXISTING-CHAT-UUID --template implementer --text-file /absolute/assignment.md --context-file /absolute/brief.json
herdr-codex agent list --thread EXISTING-CHAT-UUID
herdr-codex agent read --id feature-impl --lines 80
herdr-codex agent followup --id feature-impl --request-id clarify-1 --text-file /absolute/clarification.md
herdr-codex show --worker feature-impl --place right
```

An explicit context file transfers a selected brief, not the entire Codex
conversation. Follow-ups reuse the native agent session. `agent message` delivers
to a working agent or queues for an explicit plugin follow-up; an idle agent does
not restart merely because a note was queued. The background event bridge returns
questions and results without periodic Codex checks.

The [delegation guide](docs/delegation.md) covers concurrent agents, context,
templates, message delivery, recovery and differences from native subagent tools.
Native Herdr CLI access remains available for everything outside the convenience
interface. The [configuration guide](docs/configuration.md) explains installation
for all local chats and setup on a friend's Mac.

## Give it a task

After the plugin and user configuration are installed, use any Codex chat:

```text
Use Herdr for this task.
Project: [absolute project path]
Outcome: [desired behavior and constraints]

Keep this Codex chat as my manager. Use the selected provider/model profile.
Choose the workers useful for the task and let them consult each other directly.
Send questions and attention back here. Show their native Herdr terminals and
verify the actual changes and tests. Keep unrelated projects unchanged.
```

No old task ID is needed. Codex binds an explicit absolute project directory and
new task to the actual current chat. It stores the canonical checkout path, checks
for an existing writer, and gives addressed work to its
workers. Ask normally to clarify an instruction, investigate a failure, show
workers side by side, or review their evidence. Goose is optional.

The installed plugin resolves its CLI independently of the current directory.
Configuration selection is explicit `--config`, then `HERDR_CODEX_CONFIG`, then
`~/.config/herdr-codex/config.json`. That default may point to the existing
installation. It never searches the checkout or silently chooses another setup.
See [configuration](docs/configuration.md) for the reference installer.

The installed plugin ships a launcher that works from any working directory, and
installing the marketplace also puts the bare `herdr-codex`, `herdr-message` and
`herdr-agents` commands on your `PATH`:

```sh
herdr-codex help
herdr-codex bridge status
```

## Native controls and following along

In the examples below, `herdr-codex` means that wrapper or the installed plugin's
`scripts/herdr-codex.sh`. Integration worker IDs and native terminal addresses are
separate; retrieve them with `worker list`.

```sh
herdr-codex worker list
herdr-codex native read TERMINAL --lines 0
herdr-codex native read TERMINAL --lines 80
herdr-codex send --worker WORKER-ID --text-file /absolute/instruction.txt
herdr-codex native keys TERMINAL down enter
herdr-codex app
herdr-codex app ls
herdr-codex show --worker WORKER-ID --place right
```

`read --lines 0` returns the current terminal screen as text; `--lines 80` includes
history. Read a prompt before sending named keys. Routine operation uses these
native text controls and the app CLI, without screenshots, vision or computer use.
`native` forwards the full Herdr core CLI; `app` forwards its desktop CLI. Consult
native help/schema as capabilities evolve. Access does not depend on changing an
MCP tool list.

`show` verifies the worker's live checkout, task labels and recorded process
identity, then selects a matching local desktop space. Use `--space SPACE-ID` if
several match; create an explicit matching space if none exists. Remote spaces
with the same folder spelling are not local matches. Splits also verify anchors.
Native placement still depends on global desktop focus: a final focus race is
reported without automatically moving or closing tabs. Inspect `app ls` after
uncertainty; a pending receipt is not confirmed visibility.

You see the genuine native desktop with its sidebar, tabs, splits and terminal
input. `native attach --observe TERMINAL` shows the same live terminal content in
an interactive terminal; Ctrl+Backslash detaches. Desktop chrome, fonts and layout
can differ. The desktop is a separate macOS window, not an embedded Codex panel.
Herdr's older TUI is a separate runtime. Coordinate human typing with Codex sends;
closing a worker pane/tab ends its terminal, while closing the app window preserves
terminals subject to the native core's lifecycle.

## How Codex gets attention

The background bridge subscribes to native events. Workers can send explicit
questions and results with `herdr-message`. It also requests attention when an
observed working team settles without a report, or when a registered worker
reports a runtime problem. Messages include bounded terminal text. The settled
fallback waits while a colleague is still working, coalesces the team's handoff,
and avoids another notice when an explicit report already covers it.

The bridge maintains **one mutable pending notification per manager chat**,
grouping messages by project/task. Later reports update its owned queue entry
while pending; handled entries can be withdrawn. Unrelated queued messages remain
untouched. The durable inbox is authoritative even when a queued preview is old.

On `Herdr inbox notification`, Codex first runs
`notification receive --id NOTIFICATION-ID` and reads the current inbox. If
`actionable=false`, it reconciles only and does not restart work. For each
actionable message, it inspects terminal text and checkout evidence, records
`message reply` OR an accept/abort `message decision`, then `message ack` after the
action completes. A turn ending or attention message is not a success verdict.
See the [operator skill](plugin/skills/herdr/SKILL.md) and
[recovery reference](plugin/skills/herdr/references/operations.md).

New workers enable the settled fallback by default; `--no-notify-done` opts out
of that fallback. It does not disable explicit messages or runtime-fault attention.
There are no periodic Codex checks, extra manager model, or arbitrary inference
request/turn-count cutoffs. Reconnect/retry and one-shot settle timers are transport
mechanisms. A silent hang with no state transition or message is not detected by
an event listener alone.

Keep the existing Codex desktop host, bridge and Herdr core running. Codex can
end its turn while workers continue. A queue receipt only means the host accepted
the message; actual chat receipt is recorded separately. Ambiguous adds are
reconciled by persisted identity; messages that may already have been consumed
are not blindly resent. This is not an exactly-once delivery guarantee.

Queue maintenance requires the experimental app-server list/add/update/delete API;
the tested Codex protocol version is **0.167.0-alpha.4.1**. Each host still needs
an actual post-turn wake test. Offline delivery, app-exit
recovery, logout and reboot are not universally guaranteed. This package installs
no login supervisor.

## Beta status, dependencies and licensing

This repository is a **macOS-only beta** (`0.11.0-beta.1`). Linux and Windows are
unsupported. Nothing here is bundled as a binary: you supply the external tools and
your own provider credentials. Required on macOS: Node.js 22.19 or newer (including
`node:sqlite`), Python 3, the native Herdr core and desktop app, the Pi CLI, and a
compatible Codex desktop/CLI. Goose is optional. The tested Codex app-server protocol
version is `0.167.0-alpha.4.1`; a host with only a one-way queue command is not
sufficient. See the [recipient QUICKSTART](docs/QUICKSTART.md) for the exact list.

**Experimental Codex queue compatibility is a disclosed beta limitation.** Queue
maintenance relies on the host's *experimental* app-server `thread/queue` list/add/
update/delete API. That surface can change between host releases, so re-verify it per
host instead of assuming stable support. A queue receipt only means the host accepted a
message; it is not proof that the message reached the chat. Qualify a real post-turn
wake on every host before relying on it.

**Recipe and automation status.** The Desk recipe starters and the bounded-compaction
example are documented examples, not active features. Automations ship `enabled: false`
and the compaction hooks are dormant and opt-in; nothing runs on a timer and no login
supervisor is installed. Activating a trigger is an explicit operator action and runs
in the existing bridge. See the [recipe catalog](docs/recipe-catalog.md).

**Ownership and cleanup limits.** The local Herdr API retains operator authority, so
only trusted, scoped workers should receive it. A replacement shell is a new process,
not the original agent: inspect actual processes before recovering a lost or replaced
worker, and keep unrelated Herdr work out of cleanup. Related desk agents and files
belong in the desk's one shared Desk space. This integration is not an exactly-once
delivery guarantee, and offline delivery, app-exit recovery, logout and reboot are not
universally guaranteed.

**License.** Released under the MIT License; see [LICENSE](LICENSE). Public source lives at
[github.com/gfgdev/herdr-codex](https://github.com/gfgdev/herdr-codex); bugs and feature
requests go to
[github.com/gfgdev/herdr-codex/issues](https://github.com/gfgdev/herdr-codex/issues).
Contribution and security policy: [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) (report vulnerabilities there rather than in a public issue).
What is published versus kept local is defined in
[docs/public-source-export.md](docs/public-source-export.md); bundled third-party notices
(js-yaml) stay in [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md).

## Download and install

Release archives are published at
[github.com/gfgdev/herdr-codex/releases](https://github.com/gfgdev/herdr-codex/releases).
Use the packaged archive from the release assets; GitHub’s automatic source archives
contain the development checkout and must be built before installation.

1. Download the packaged archive (`herdr-codex-0.11.0-beta.1.tar.gz`) from the release
   assets and confirm the SHA-256 published with that release.
2. Unpack it to a folder you control.
3. Follow [QUICKSTART](docs/QUICKSTART.md), section 2, to add that folder as a local
   marketplace and install the plugin into your own Codex setup.

Nothing installs itself: the archive is a folder you add as a local marketplace, using your
own paths and your own approved credential file. To build the archive yourself from source
instead, see **Build and share** below.

## Build and share

From this package directory:

```sh
node scripts/build-plugin.mjs --out /absolute/new/share-folder
```

The builder emits an expanded local marketplace, skills plugin/runtime, archive
and file hashes. It checks the packaged CLI, document links, file inventory and
private-content patterns; it makes no model calls and refuses to overwrite an
existing destination. The release report identifies the artifact and checks
actually completed for each build.

A friend needs macOS, Node 22.19+, Python 3, native Herdr core/desktop, the worker
binaries they use, a compatible Codex desktop/CLI, and their chosen endpoint/model
with a private credential-file reference. The artifact contains no native binaries,
model service, credentials, task state or project source. Setup is guided rather
than a one-click dependency installer. Linux and Windows are unsupported. Use the
packaged setup skill, the [recipient QUICKSTART](docs/QUICKSTART.md) and
[configuration guide](docs/configuration.md), then qualify
an actual message arriving after a Codex turn ends on that host.

Prepared roles are native Pi CLI and Goose; Pi CLI is not Pi Durable. The local
Herdr API retains operator authority, so only trusted scoped workers should receive
it. Inspect actual processes before recovering a lost or replaced worker; its
replacement shell is not the original agent. Keep unrelated Herdr work outside cleanup.
Development tests run with `npm test`.


Native access remains available through `native` and `app`, with literal argument forwarding and caller-provided terminal I/O. The [native feature guide](docs/native-capabilities.md) covers searchable installed capabilities, [adoption](docs/native-adoption.md) binds existing workers without relaunching them, and [runtime qualification](docs/native-qualification.md) tests candidate cores in isolated sessions.
