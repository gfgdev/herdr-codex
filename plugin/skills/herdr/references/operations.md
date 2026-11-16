# Operating and recovering Herdr work

In these examples, `herdr-codex` means the installed plugin's
`scripts/herdr-codex.sh` or a configured wrapper. The plugin uses the selected user
configuration from any working directory; `--config /absolute/config.json` selects
an explicit installation. IDs are returned by commands; retrieve them rather than
substituting a previous task's IDs.

## Legacy launch commands

Prefer the one-command delegation interface in the [delegation guide](../../../docs/delegation.md). These lower-level commands remain compatible.

Write a brief with the outcome, explicit absolute checkout directory, allowed
scope and useful acceptance checks. The canonical project binds task and worker;
relative paths and files are rejected. Use the exact existing manager chat UUID.
Confirm the checkout has no
other active writer before creating a task. This is an example team, not a fixed
workflow; launch Goose only when its investigation or review is useful:

```sh
herdr-codex bridge start
herdr-codex task create --name "CLI pipeline input" --project /absolute/checkout --thread EXISTING-CHAT-UUID --brief-file /absolute/brief.md
herdr-codex worker launch --task TASK-ID --role pi --name implementation
herdr-codex worker launch --task TASK-ID --role goose --name review --read-only
herdr-codex worker list --task TASK-ID
herdr-codex send --worker WORKER-ID --text-file /absolute/instruction.txt
```

Worker launch prepares the conversation; the task brief alone does not activate
implementation. Send an explicit instruction. Each returned worker has an
integration ID and a native terminal address; they are different identifiers.
Use integration IDs with `send`/`show`, native addresses with `hc`.

Pi defaults to writing its project. `--read-only` removes project write scope.
`--write-path` and `--read-path` select additional explicit scope. Prepared roles
are Pi and Goose; `native run` remains available for other native programs, but
unregistered terminals do not automatically gain bridge routing.

Native examples:

```sh
herdr-codex native --skill
herdr-codex native get TERMINAL
herdr-codex native read TERMINAL --lines 80
herdr-codex native send --wait --timeout 45 TERMINAL "Explain the failing case."
herdr-codex native keys TERMINAL down enter
herdr-codex native interrupt TERMINAL
```

Use native text reads and structured responses for normal operation, including
terminal menus and permission prompts. Inspect a prompt before sending named keys;
the example is not an instruction to approve every prompt. Use `app` commands to
operate the desktop. Screenshots, vision and computer use are unnecessary for
routine Herdr work.

A wait timeout returns control while work continues. It is not an inference
deadline. A lifecycle status is not proof that code is correct. Verify files and
test results independently before accepting results.

## Receive, answer and acknowledge

The bridge listens to Herdr events and ingests durable mailbox documents. It
routes only registered task/worker/terminal identities to the bound chat. Progress
messages are informational; questions, results and relevant lifecycle attention
can request a host wake. Runtime faults and a task's settled team can also request
attention when no explicit result was sent. The attention message's plain-text
terminal excerpt helps locate the issue; a settled state or wake is not proof of
task success. Read the actual terminal, changes and checks before deciding.
Reconnect and definite-failure retry timers are transport recovery, not scheduled
polling of agents by a model. There is one mutable pending notification per chat,
grouped by project/task. The bridge updates its owned queue entry while pending
and withdraws handled entries without touching unrelated queued messages.

On a `Herdr inbox notification`:

```sh
herdr-codex notification receive --id NOTIFICATION-ID
```

Read its current inbox; the queued preview may be stale. `actionable=false` means
reconcile only and do not restart work. Otherwise handle each actionable message
by its ID. Receipt marks the inbox as seen, not accepted or completed:

```sh
herdr-codex message show --id MESSAGE-ID
```

Legacy single-message wakes still start with `message receive --id MESSAGE-ID`.
Inspect its recorded action and acknowledgment before doing anything. For a
question or revision, prepare a useful answer and send it:

```sh
herdr-codex message reply --id MESSAGE-ID --text-file /absolute/answer.txt --request-id STABLE-ACTION-KEY
herdr-codex message ack --id MESSAGE-ID
```

`reply` records the action before attempting native delivery. Check its receipt
and action state before acknowledging. If it is `sending` or `uncertain`, read
the actual terminal. When delivery is positively observed, record that evidence:

```sh
herdr-codex message reconcile-reply --id MESSAGE-ID --text "Observed this exact reply in terminal ..."
herdr-codex message ack --id MESSAGE-ID
```

For a completed result, inspect actual changes and run relevant checks, then:

```sh
herdr-codex message decision --id MESSAGE-ID --action accept --text-file /absolute/review.txt --request-id STABLE-ACTION-KEY
herdr-codex message ack --id MESSAGE-ID
```

Use `abort` when that is the actual decision. **Reply and accept/abort are
alternative actions for one message**; do not record a second decision after a
reply. An abort decision records intent; it does not itself kill a worker.
If stopping execution is required, interrupt/stop the exact worker, inspect the
outcome, then record and acknowledge the resolved decision. A repeated wake for an
acknowledged message is reconciliation only, not a new task.

## Display

```sh
herdr-codex app
herdr-codex app ls
herdr-codex app status
herdr-codex app commands
herdr-codex show --worker WORKER-ID --place tab
```

`show` verifies the registered worker's live native cwd, worker/task labels and
recorded process identity. It selects a local space whose canonical folder matches
the project; remote spaces are not matches. Use `--space SPACE-ID` when several
local spaces match. If none exists, create one explicitly:

```sh
herdr-codex app do space.new --name NAME --folder /absolute/checkout
herdr-codex show --worker WORKER-ID --space SPACE-ID --place tab
```

`--place right` or `down` additionally verifies the focused tab's live local
anchors against the same project. An unrelated current space is never a fallback.
The native placement API still uses global focus, so a last-moment race can occur
after checking. The plugin reports mismatches and does not automatically move or
close tabs. Inspect `app ls` after uncertainty; pending is not verified visibility.
`app do pane.split` starts another terminal rather than adopting the existing worker.

For terminal observation:

```sh
herdr-codex native attach --observe TERMINAL
```

Ctrl+Backslash detaches. Omitting `--observe` permits input. The native desktop
and attach view share the live terminal, while font, size and surrounding UI can
differ. Coordinate human typing with Codex sends. The original Herdr TUI is a
different runtime and does not adopt these desktop/core workers.

## Recovery and limits

- Inspect `bridge status`, pending messages and the registered worker before
  recovery. `bridge start` reconnects to durable state. It does not restart tasks.
- If launch status is uncertain, use `worker recover --id WORKER-ID` and inspect
  its native label/address. Do not launch a replacement blindly.
- `queued` means the host API returned a queue receipt. `receivedAt` records
  actual receipt through `notification receive` or legacy `message receive`;
  `acknowledgedAt` records resolution.
  Do not present these as interchangeable.
- Inspect `notification list`, `notification show --id ID` and the current message
  inbox for delivery problems. A definite host rejection may retry automatically.
  An ambiguous add is reconciled by its persisted identity; an absent entry might
  already have started a turn. `delivery_unknown` is not automatically resent.
  `message retry` refuses attempted or notification-covered messages. Duplicate
  receipts must reconcile recorded actions; there is no exactly-once guarantee.
- `bridge stop` stops only the listener. It does not stop Herdr or its workers.
- Closing the task requires its pending messages to be resolved. Stop/reconcile
  retained workers separately when appropriate; a closed task is not a kill.
- This release does not install a login supervisor. A stopped host or failed core
  needs explicit recovery. Idle-chat wake must be qualified on the actual Codex
  host; an installation or synthetic transport test alone is insufficient.
- Host queue maintenance needs experimental app-server list/add/update/delete
  methods (tested Codex protocol: 0.167.0-alpha.4.1). It does not start/resume chats,
  reorder their queue or depend on changing MCP tool lists.
- Direct process file permissions do not sandbox the full local Herdr API.
  Only trusted agents should receive its native control socket.

Keep unrelated Herdr sessions, model profiles and original
projects outside cleanup for this integration.


## Native access and adoption

Use the [native feature guide](../../../docs/native-capabilities.md) for installed help/schema discovery and candidate comparison, the [adoption guide](../../../docs/native-adoption.md) for binding existing workers and children, and the [qualification guide](../../../docs/native-qualification.md) for isolated runtime tests. Integration `--config` precedes `native`/`app`; every following token is forwarded literally. No fixed native operation allowlist is applied.
