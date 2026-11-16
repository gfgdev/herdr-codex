# Delegating work through Herdr

The bundled [MCP tool adapter](agent-tools.md) exposes these lifecycle operations
as structured, native-style subagent tools. This CLI remains available for the
full integration and recovery operations.

Codex remains the manager in your existing chat. A delegation creates a named
native Herdr agent, binds its questions and results to that chat, and sends a
natural-language assignment. The local bridge handles delivery and lifecycle
attention. Codex decides scope, answers unresolved questions and verifies results.

This guide describes the 0.3.2 interface. It is an operating reference, not a
claim that every runtime, provider or host has passed qualification. Consult the
release report for actual test evidence.

## Normal use

`herdr-codex` below means the installed plugin's `scripts/herdr-codex.sh` or a
configured wrapper. Configuration comes from `--config`, `HERDR_CODEX_CONFIG`,
then `~/.config/herdr-codex/config.json`; it does not depend on the checkout.
Retrieve the actual existing chat UUID and use stable, distinct agent/request IDs.
`--project` must be an explicit absolute directory; its canonical path becomes
the fixed task/worker checkout. Relative paths and files are rejected before
registration. An existing task cannot be reused for another project or chat.

```sh
herdr-codex bridge status
herdr-codex agent list --thread EXISTING-CHAT-UUID
herdr-codex bridge start
herdr-codex delegate --id cli-impl --name cli-impl --project /absolute/checkout --thread EXISTING-CHAT-UUID --template implementer --text-file /absolute/assignment.md --context-file /absolute/context.json
```

The assignment should give the desired result, allowed scope and useful acceptance
checks. It can be ordinary prose. Neither recipes nor a prescribed review sequence
are required. Omit `--context-file` when the assignment is self-contained.

`delegate` returns the stable `agentId`, `taskId`, native `terminalId`, scope and
initial delivery state. The agent ID also works with older commands taking a
worker ID. Use native terminal addresses with `hc`; these are different IDs.
Repeating an identical delegation reuses its record rather than launching a second
agent. Reusing its ID with different frozen inputs fails; use a follow-up instead.

The default template is the read-only explorer. Choose `implementer` when writing
is intended. `--harness pi|goose` and `--scope read-only|write` override template
defaults within the authorized task. They do not choose a new endpoint or model.
`--read-path` and `--write-path` can repeat and name existing explicit paths.
Write scope defaults to the project; read-only scope rejects writable paths.
The configured runtime still has private writable state/scratch.

`--ready-timeout` is 0–60 seconds, default 20. It bounds how long the command waits
for startup readiness, not the agent's inference or assignment. A not-ready result
leaves the recorded agent intact; inspect it and repeat the identical delegation
when ready. An uncertain launch must be recovered rather than repeated blindly.

## Concurrency and peers

Parallelize independent work. Use separate checkouts for concurrent writers, or
let investigators/reviewers share a checkout read-only with one writer. Read-only
agents should account for files changing during a review; use a stable revision or
ask for a handoff when that matters. Plugin writer reservations reject overlapping
registered writers, including disjoint writable paths in the same checkout; they do not discover every process outside the plugin.

A delegation creates a task automatically unless `--task EXISTING-TASK-ID` is
supplied. Reuse the returned task ID for colleagues on the same checkout/chat:

```sh
herdr-codex delegate --id cli-review --name cli-review --project /absolute/checkout --thread EXISTING-CHAT-UUID --task RETURNED-TASK-ID --parent cli-impl --template reviewer --text-file /absolute/review-brief.md
herdr-codex agent list --task RETURNED-TASK-ID
```

This lets the settled-team attention logic account for colleagues still working.
Tasks bind a single checkout; separate writer checkouts need separate task
registrations. `--parent` records a relationship to an existing agent in the same
manager chat. It neither grants permissions nor automatically delegates more work.

Give each colleague the returned native terminal address and explain when contact
is useful. Workers can consult assigned peers with `hc send ADDRESS "message"`.
Peer messages go to the native session; they are not manager request records.
Do not invent terminal addresses or route through an unrelated task.

## Notes, follow-ups and interruption

```sh
herdr-codex agent message --id cli-impl --request-id fixture-note-1 --mode auto --text "The parser is already ruled out; focus on fixture setup."
herdr-codex agent message --id cli-impl --request-id next-note-1 --mode queue --text-file /absolute/next-note.md
herdr-codex agent followup --id cli-impl --request-id continue-1 --text-file /absolute/followup.md --context-file /absolute/new-context.json
herdr-codex agent interrupt --id cli-impl --request-id stop-1
herdr-codex agent stop --id cli-impl --request-id end-1 --note "Operator ended a wedged turn"
```

`agent message --mode auto` sends to an agent that is currently working. If it is
idle, or becomes idle before conditional delivery, the note stays queued and does
not start another turn. `--mode queue` always queues. Queued notes are included in
the next explicit plugin follow-up; use `agent followup` when the agent is idle
and you want it to continue. A native send, desktop typing, an incoming-message
reply or the mere end of a turn does not drain that queue.

Follow-up reuses the existing native session. Its optional context is another
explicit snapshot; it does not erase the agent's earlier session history. A sent
receipt means native input was accepted, not that the model has answered or
completed the task. Native harness behavior governs how a working agent processes
steering; this layer does not make Pi and Goose identical.

Each outgoing operation has a request ID scoped to that agent. Retry with the same
ID and same content to inspect/reuse its record. Different content with the same
ID fails.

Every record separates *durable queueing* from *native acceptance* from *observed
consumption*. `delivery` is one of `queued` (durable only, not yet sent),
`native-injected` (the native transport accepted the input; the model has **not**
been confirmed to consume it), `confirmed` (an operator recorded observed
evidence), `refused` (a terminal non-delivery) or `uncertain`. A `sent` receipt is
native acceptance only — never read it as the model having acted. Resolve an
uncertain record with `agent reconcile` using actual terminal evidence; that
upgrades the record to `confirmed` without re-sending.

Interruption requests native cancellation and retains both the session and writer
lease; it is not permission to start a competing writer. An interrupt is confirmed
only when the *validated original* native identity is observed idle or done (or
its state is finished). A vanished terminal is not proof that the original turn
stopped, so the request stays `uncertain` and blocks later input until it is
reconciled; the native harness governs how a working agent processes steering.

`agent cancel-request` locally retires one **unclaimed** outbound operation so it
stops gating task close, with no native action, signal or task closure. Only a
`prepared` ordinary request or an unclaimed `queued` note is eligible; anything
already handed to the carrier (`sending`, `uncertain`, `attached`, `sent`,
`delivered`) is refused, and lifecycle `stop`/`interrupt` can never be cancelled
here. The `--target-request-id` names the operation being retired and
`--request-id` is a separate disposition identity: an exact replay returns the
recorded disposition, while any other identity conflicts. `--expected-state` is
an atomic precondition — the cancel is refused unless the target still holds that
state — and the payload plus receipts are preserved. The caller must pass the
exact owner manager chat UUID with `--thread`; it is compared against the target
agent's registered task thread before the request row is read, so a different
chat is refused as `Not your request`.

`agent stop` intentionally ends an agent. Stop intent is recorded **before** the
native kill, together with a durable dispatch state (`not-dispatched`,
`dispatching`, `accepted`, `refused` or `uncertain`). A recorded intent alone is
not a deliberate stop: only an acknowledged kill plus an observed original
`finished` exit is reported as intentional. An original already finished before
dispatch is `already-exited`; a refused, in-flight or ambiguous dispatch with an
observed exit is `unattributed`, never reported as deliberate. The stopped state,
request receipt, single `agent.stopped` audit row and one lifecycle notice commit
atomically. Terminal history is preserved and later input is refused. Retrying the
same `--request-id` re-checks confirmation without killing again, and late native
evidence is retained. A replaced process (identity mismatch) is never excused by
stop intent. A missing or replaced process faults and retains the reservation; a
verified original finished exit permits lease release and is still reported as a
fault when unexpected.

A confirmed stop receipt also carries a compact `retirement` outcome derived live
from durable state: `state` (`pending_retirement` or `released`), its `reason`,
whether writer ownership is still held (`writerLeaseHeld`) and, when known, the
descendant `coverage`. Writer ownership is a **separate** fact from the observed
exit: a confirmed stop releases the lease only once descendant clearance is
complete, and otherwise retains it as `pending_retirement`. The outcome never
claims complete descendant coverage it does not have, and a same-key replay
reports the current saved facts without signalling again.

Stop is also the one intentional lifecycle request permitted after its task is
closed: it ends the original verified agent (identity/ownership checks unchanged)
without reopening the task. Ordinary messages, followups and interrupts remain
refused on a closed task; the close is not undone by the stop.

## Context handoff

`--context-file` accepts UTF-8 text/Markdown or a structured `.json` file:

```json
{
  "version": 1,
  "summary": "Add stdin support while retaining file input.",
  "decisions": ["Use '-' to select stdin; './-' remains a filename."],
  "constraints": ["Preserve validation-before-read and one-line JSON output."],
  "acceptance": ["Exercise both file and stdin error paths."],
  "references": [
    {"path": "src/cli.mjs", "note": "Current entry point"},
    {"path": "test/cli.test.mjs"}
  ]
}
```

The optional fields must contain at least one meaningful value. Unknown fields,
invalid JSON schemas, NUL characters and files of 256 KiB or more are rejected
without truncation. The source and SHA-256 of its exact bytes are recorded with
the saved snapshot. Later changes to the source file do not alter a saved request.
References are labels to inspect when relevant; their files are not read or
attached automatically. Include only task-relevant material the worker may use.

This is selected context, not an automatic fork of the Codex conversation or
access to hidden reasoning. Rendered handoffs distinguish manager instructions
from quotations and agent claims that require verification.

## Reusable templates

| Template | Harness | Project scope | Intended use |
| --- | --- | --- | --- |
| `explorer` | Pi | Read-only | Trace source, behavior and failure causes |
| `implementer` | Pi | Write | Make a scoped change and verify it |
| `reviewer` | Goose | Read-only | Inspect actual changes and evidence |
| `tester` | Pi | Read-only | Run existing checks and independent scratch probes |
| `investigator` | Goose | Read-only | Investigate an open question and synthesize findings |

```sh
herdr-codex template list
herdr-codex template show --name reviewer
herdr-codex template install --file /absolute/api-review.json
```

A custom template is an explicit JSON instruction file:

```json
{
  "version": 1,
  "name": "api-review",
  "description": "Review API compatibility and error behavior.",
  "harness": "goose",
  "scope": "read-only",
  "instructions": "Inspect callers, schemas and actual error paths. Identify breaking behavior with concrete evidence. Keep project files unchanged."
}
```

Those are the only allowed fields. Names use lowercase letters, digits and hyphens
and begin with a letter. Templates do not carry credentials, provider/model
settings or executable overrides. They are stored in the selected installation's
private template directory. Identical installation is idempotent; a differing
template of the same name is not overwritten. Built-ins cannot be replaced and
symlinked template paths are refused. Share the reviewed JSON itself with friends,
not your runtime state or populated private configuration.

## Activity and returning to Codex

```sh
herdr-codex agent read --id cli-impl --lines 80
herdr-codex agent wait --thread EXISTING-CHAT-UUID --timeout 30
herdr-codex agent wait --id cli-impl --after RETURNED-CURSOR --timeout 30
```

`agent read` returns actual terminal text and native state. `agent wait` subscribes
to the bridge's local event socket and reads durable activity during the command;
it does not repeat model or native status checks. Timeout is 0–60 seconds, default 30, and
does not stop workers. With no cursor it reports outstanding attention, then new
activity. Reuse the returned cursor only with this installation. Activity may be
a question, delivery result or fault; it is not a correctness verdict.

The background bridge handles native events and waking this chat after Codex ends
its turn. Agents use `herdr-message` for questions/results; settled-team and fault
attention can cover missing reports. It maintains one mutable pending notification
per manager chat, grouping reports by project/task. Later reports update that
owned queue entry while pending; handled entries can be withdrawn. The original
message records and decisions remain durable. Unrelated host queue entries are
not modified.

For an incoming `Herdr inbox notification`, first read the current inbox:

```sh
herdr-codex notification receive --id NOTIFICATION-ID
herdr-codex notification show --id NOTIFICATION-ID
herdr-codex message list --thread EXISTING-CHAT-UUID --pending
```

The queued preview can be older than the current inbox. If receipt returns
`actionable=false`, reconcile only and do not restart the work. Otherwise handle
each actionable message using its own ID:

```sh
herdr-codex message show --id MESSAGE-ID
herdr-codex message reply --id MESSAGE-ID --request-id answer-1 --text-file /absolute/answer.md
herdr-codex message ack --id MESSAGE-ID
```

Read terminal/files and inspect prior actions first. Use a reply for an answer or
revision, OR `message decision --action accept|abort` for that decision. Record the
action before acknowledging; an already acknowledged duplicate is reconciliation
only. `notification receive` records receipt, not a decision or completion. Legacy
wakes with a single message ID still use `message receive --id MESSAGE-ID`.
These incoming commands differ from `agent message`, which sends an outgoing note.

The connector uses experimental app-server queue list/add/update/delete methods,
tested against Codex **0.167.0-alpha.4.1**. It does not depend on replacing MCP tool
lists. Queue acceptance is distinct from actual chat receipt and acknowledgment;
qualify post-turn wake on each host. Do not schedule periodic Codex checks. An
event listener cannot diagnose a silent hang that emits no new state or message.

If a queue mutation times out, the bridge reconciles its persisted identity before
acting again. An absent entry may already have been consumed; `delivery_unknown`
does not cause an automatic resend of those messages. Definite rejections can
retry. These controls avoid blind duplicate work but do not promise exactly-once
delivery. Use `notification list`/`show` and the message inbox when investigating
delivery uncertainty.

## Uncertain delivery and native fallback

```sh
herdr-codex agent request --id cli-impl --request-id continue-1
herdr-codex agent read --id cli-impl --lines 100
herdr-codex agent recover --id cli-impl
herdr-codex agent reconcile --id cli-impl --request-id continue-1 --text "Observed the exact continuation in the original terminal, with its returned turn."
```

`recover` looks for the original labeled live terminal; it does not launch a
replacement. `reconcile` records observed delivery for an unresolved request by
upgrading a `native-injected` record to `confirmed`; it never performs a new
native send. Use actual evidence, never the example sentence alone. An unresolved
send blocks later operations so uncertainty does not silently duplicate work. If
delivery cannot be established, preserve the record and inspect the original
process. Closing a task is separate from stopping its workers; do not free a writer
merely because its turn is idle or a cancellation was requested — writer
ownership is released only by a completed retirement (confirmed exit **plus**
complete descendant clearance) and is otherwise retained as `pending_retirement`.

Native functionality remains available:

```sh
herdr-codex native --skill
herdr-codex native get NATIVE-ADDRESS
herdr-codex native read NATIVE-ADDRESS --lines 80
herdr-codex native keys NATIVE-ADDRESS down enter
herdr-codex app
herdr-codex app ls
herdr-codex show --worker cli-impl --place right
herdr-codex native attach --observe NATIVE-ADDRESS
```

Read prompts before answering them. Use native help/schema for features outside
the convenience layer. Native sends and app input bypass plugin request records;
account for them before interpreting delivery state. The local Herdr API retains
operator authority. Worker filesystem scope and plugin writer reservations are
not a security boundary over unfenced native operations.

The desktop and terminal attach show the same worker content, with different
surrounding chrome. Routine Codex operation reads text; it needs no screenshots
or vision. Prepared Pi workers use native Pi CLI, not Pi Durable.

## Installation and sharing

The plugin is available from any local chat once installed and configured at the
user level. It does not require a copy inside every project. See the
[configuration guide](configuration.md) and packaged setup skill for the native
dependencies, selected profile, credential-file reference and default-config
installer. The supported first platform is macOS.

Build a shareable local marketplace from the source package:

```sh
node scripts/build-plugin.mjs --out /absolute/new/share-folder
```

Share the generated artifact,
not the populated private state directory. Each friend supplies their own native
binaries, model configuration and credentials and qualifies actual host wake.
This interface does not replace or intercept Codex's built-in subagent tools, copy
hidden chat context, sandbox all Herdr API calls, or guarantee application-exit,
logout or reboot recovery.

## Boundaries of the subagent analogy

This plugin does not replace the host implementation of Codex’s built-in tools.
It supplies equivalent manager operations through MCP tools and a local CLI. Context is selected
explicitly; exact full-chat forks are unavailable. `--parent` records a relationship,
not recursive worker provisioning. Codex can provision a team and give workers
peer addresses; native Herdr operations remain available when broader authorized
control is needed. Workers use their harness’s own context, cancellation and
steering semantics. A cancelled model turn is not necessarily a killed shell
command; inspect the native interruption result and actual processes.

`agent wait` requires the updated bridge. Its private local socket acknowledges
subscription before a durable journal snapshot. The wait duration starts after
a bounded connection handshake of at most five seconds. It neither polls status
nor launches a model. If a writer crashes between committing and publishing, the
journal preserves the event for recovery or the final deadline snapshot. A bridge
disconnect fails visibly; no silent polling fallback is installed.

Desktop placement verifies the worker's live native cwd, worker/task labels and
recorded PID before selecting a matching local space. Remote spaces with the same
folder spelling are not local matches. `--space SPACE-ID` resolves multiple local
matches; if none exists, create one explicitly with
`app do space.new --name NAME --folder /absolute/checkout`. Split anchors must
also be live local terminals in the same canonical project.

The upstream placement operation uses global focus, so a final focus race can
still put a terminal in another space. The plugin reports the mismatch and does
not automatically move or close tabs. Inspect `app ls` after uncertainty; a
pending native receipt is not confirmed visibility. Launch does not automatically
adopt terminals into whichever project space happens to be focused.
