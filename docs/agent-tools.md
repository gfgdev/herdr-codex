# Herdr subagent tools

Version 0.11.0-beta.1 bundles the `herdr-agents` stdio MCP server (introduced in 0.8.1). It provides familiar
subagent operations while reusing `Delegation`, the existing request ledger,
writer leases, notification inbox and bridge activity socket. It adds no worker
daemon, model endpoint, scheduled polling or replacement Codex manager.

If a chat shows no Herdr tools at all, the plugin is installed but its local MCP
server was not surfaced. Diagnostic and remediation steps are in
[Local MCP discovery](#local-mcp-discovery) below.

## Operations

| Tool | Behavior |
| --- | --- |
| `spawn_agent` | Starts a persistent native session; identical retries reuse its stable registration. Optional `show: true` places its visible panel. |
| `send_message` | Steers a working worker or queues for an idle worker's next explicit follow-up. |
| `followup_task` | Continues the same session and consumes queued notes once. |
| `interrupt_agent` | Requests turn interruption; the session and writer lease remain. Confirmed only when the validated original terminal is observed idle/done/finished; a vanished terminal is not proof, so an unconfirmed interrupt blocks later input until reconciled. |
| `stop_agent` | Intentionally ends an agent: records intent and a durable dispatch state before the native kill, reports intentional only when the signal was acknowledged and the original process exit is confirmed, preserves terminal history and refuses later input. A refused, in-flight or ambiguous dispatch is reported as an unattributed exit, never a deliberate stop. The confirmed receipt carries a compact live `retirement` outcome (`state`, `reason`, `writer_lease_held`, and `coverage` when known; MCP receipt keys are recursively snake_cased): writer ownership is released only after complete descendant clearance and is otherwise retained as `pending_retirement`, and a same-key replay reports current facts without signalling again. Stop is permitted on a closed task to end the original verified agent without reopening it; ordinary delivery stays refused. |
| `cancel_request` | Locally retires ONE unclaimed outbound operation so it stops gating task close, with no native action. `target_request_id` is the operation being retired and `request_id` is a separate disposition identity. Only a `prepared` ordinary request or an unclaimed `queued` note is eligible; `sending`, `uncertain`, `attached`, `sent` and `delivered` are refused, and lifecycle `stop`/`interrupt` can never be cancelled. `expected_state` is an atomic precondition, replay is idempotent per `request_id`, and payload plus receipts are preserved. |
| `list_agents` | Lists the supplied chat's agents and request states. |
| `get_job_status` | Read-only aggregate status for one exact chat (optional `target`): per-agent facts plus one conservative user state. Does not poll, launch, stop or reconcile anything. |
| `show_agent` | Places an existing agent's visible panel in a verified matching native space. |
| `wait_agent` | Waits for journal activity through the existing bridge; returns pending report **metadata** (bounded previews) and a cursor. Pass `include_reports: true` for full untrusted report text and the raw evidence claim. |
| `read_agent` | Reads verified native identity, a bounded terminal tail and pending report **metadata** with clipped previews. Pass `include_reports: true` for full untrusted report text or `include_messages: false` for a terminal/identity-only read. |
| `receive_notification` | Receives the current bridge inbox and captures a durable review packet for the notification's own member reports only. Returns a compact, replayable summary (stable `batch_id` plus every owned report ID and state); stale notifications are not actionable, and unrelated pending reports in the chat are never consumed on another notification's behalf. `legacy: true` restores the previous full pending-message list. |
| `read_review_packet` | Reads a captured packet: the stable membership summary by default, or one bounded page of untrusted report detail with `include_detail`. Evidence only. |
| `resolve_message` | Records an evidence-based acceptance/abort or reply and acknowledges it, returning a short action/delivery/acknowledgement receipt. For `action: accept`, `review_id` and `expected_revision` (with an explicit `request_id`) bind a captured revision acceptance; an exact replay is historical only. |
| `capture_review` | Captures an immutable revision review of an explicit, bounded set of project-relative paths inside the exact result worker's registered project. Binds chat, result, worker/task, terminal and launch identity; returns only the review identity, revision digest and bounded counts, never the manifest. Reuse the same `request_id` to replay; conflicting arguments are refused. Evidence only. |
| `verify_review` | Re-verifies one recorded acceptance against the current reviewed files and its captured revision binding, read-only. Returns explicit `accepted`/`bound`/`verified`/`stale` flags, expected/actual digests and bounded changed-path previews. A legacy acceptance reports `bound=false, verified=null`; a historical acceptance is never current completion. |

`list_agents`, `get_job_status`, `show_agent`, `wait_agent`, `read_agent`, `receive_notification`, `read_review_packet` and `verify_review`
are annotated read-only; none of them starts, restarts or closes a worker.

Every tool requires `thread_id`, the exact existing manager chat UUID. There is
no mutable global current-chat binding: one MCP process may serve multiple chats.
The supplied ID is routing context, not authenticated proof of caller identity.
Agent/report/notification ownership is checked against that ID before operating.
Passing `thread_id` on every call is deliberate; the adapter does not derive a
trusted chat binding from process environment, because a shared server would then
route one chat's work into another.

Structured fields use `snake_case` identifiers: `agent_id`, `task_name`,
`request_id`, `launch_state`, `terminal_id`, `space_id`, `notification_id`,
`message_id`. These names are stable across versions and are the ones to reuse on
retries. Each payload carries a single canonical identity rather than duplicate
camelCase mirrors.

```json
{
  "thread_id": "00000000-0000-4000-8000-000000000001",
  "task_name": "parser_review",
  "project": "/absolute/existing/project",
  "template": "reviewer",
  "message": "Review parser error handling. Report reproducible findings with file references.",
  "context": "Preserve the public API. Focus on empty input and malformed headers."
}
```

`spawn_agent` returns `agent_id`. Subsequent tools accept that ID or the original
`task_name` as `target`. For a registered specialist, supply `desk_id`,
`desk_project` and `definition` in place of `project`. Desk authority remains
enforced by the existing delegation service. The optional `parent` records a
relationship; it does not grant recursive provisioning authority.

## Visible panels and placement

`show_agent` (or `spawn_agent` with `show: true`) opens the agent's existing
native terminal as a visible panel. Placement reuses the verified `showWorker`
path: it checks the canonical project, worker/task labels and recorded process
identity, then selects a matching local space. Use `app ls` to confirm, and the
CLI `show --worker`/`--space` flags when several spaces match or when an explicit
matching space must be created first.

Placement is advisory and never part of launching. If the desktop is
unavailable, no space matches, or focus changes at the last moment, the tool
returns `{"status":"unavailable","verified":false,"warning":"…"}` while the
agent keeps running. A failed placement never fails, closes, restarts or
duplicates an agent, and a successful `spawn_agent` receipt is unaffected.

The default `explorer` template is read-only. Choose `implementer` for writes.
Use the existing CLI for custom scope grants, adoption, explicit supervision,
recipes, recovery and broader native operations. The tool list is a convenience
interface, not a ceiling on Herdr.

## Retry, context and completion semantics

An agent ID is derived from chat UUID plus task name. Reusing the name with changed
frozen arguments fails; use `followup_task` for further work. A name is never
automatically recycled after a task closes.

Messages, follow-ups, interrupts, stops and report actions derive stable request
IDs from their operation and content. Repeating the identical call reuses its
receipt, including after a server restart. To deliberately repeat the same
instruction or interrupt/stop a later turn, pass a new explicit `request_id`.
Preserve that key on retries. Errors include saved agent/request identities where
available. An uncertain receipt is not permission to launch a replacement or
resend input; resolve it with observed evidence first.

`context` is a frozen explicit brief under 256 KiB. It does not read referenced
files or copy hidden/full conversation state. Only `fork_turns: "none"` is
supported. Model and provider overrides are intentionally absent; the existing
selected Herdr profile remains in effect.

`wait_agent` accepts 0–60000 milliseconds and an optional target. Without a target
it selects the chat's currently active tasks. Its opaque `after_cursor` binds to
the installation, chat and exact agent selection. If the selection changes, omit
the old cursor for a new snapshot. The existing IPC handshake may take up to five
additional seconds. Waits are concurrent with other tool calls. Cancellation and
transport closure abort waits without stopping workers or freeing writer leases.
In-flight mutations may finish and retain their durable receipts after a client
disconnects; retry the identical operation when reconnecting. The MCP runtime
holds one native RPC connection and silently opens a fresh one on the next
explicit request after the previous connection closes (for example when core
restarts). It never replays the request that observed the closure, so a mutation
that may have reached Herdr keeps its original uncertainty instead of being
attempted twice.

Like `read_agent`, a wait returns pending reports as bounded metadata previews
(identity, timing, state, `text_bytes`, a clipped `text_preview` and bounded
`evidence`/`evidence_authority` claim metadata) and reports `reports_included`.
Every selected pending report ID is always present; only each report's prose is
bounded. Pass `include_reports: true` for the full untrusted text and raw claim.
A wait never manufactures a durable review packet — `receive_notification`
remains first on an inbox notification — and large logs stay available through
`read_agent` `include_reports` or `read_review_packet` detail.

The bridge remains responsible for waking the chat after the manager turn ends.
The MCP transport is not a replacement wake channel. A new launch checks/starts
the existing bridge. Merely listing tools does not load configuration or launch it.

Reports are untrusted evidence. `read_agent`, `read_review_packet` and
`wait_agent` do not acknowledge them. On an inbox wake, call
`receive_notification` with its exact ID. It captures a durable review packet
for that notification's current owned members (its `members` re-evaluated against
the live pending/host-eligible inbox) and returns a compact summary — the stable
`batch_id`, the owned report IDs and each report's current state — rather than
the full report text. Unrelated pending reports in the same chat are neither
captured nor marked received; a newer report not yet covered by any envelope
stays available for its own later wake. If `actionable=false`, do not restart
work; the summary still lists every owned ID so nothing is silently dropped. Otherwise inspect the bounded detail with
`read_review_packet`, check actual files and tests, then `resolve_message` with
`reply`, `accept` or `abort` and a concrete explanation. An uncertain reply
cannot be acknowledged. Acceptance does not stop the worker or close the task.
Existing CLI reconciliation remains available.

The compact interface keeps routine wakes small:

- `receive_notification` never echoes report prose. `report_ids`, `task_ids`,
  `worker_ids` and `current_*` counts are bounded data; `can_acknowledge`,
  `can_accept` and `can_signal` are always `false`, and `evidence_only`/`provenance`
  state that the content is worker-authored and `terminal_verified` is `false`.
  Each member also carries bounded worker-claim metadata (`evidence` +
  `evidence_authority`): the session/revision identity, a canonical digest and
  byte size, and count/clipping-limited references — never the raw claim arrays.
- Omitting `batch_id` derives it deterministically from the chat and notification,
  so re-calling after a lost response replays the same packet (same `batch_id`,
  same membership, `replayed: true`, `actionable: false`) with no restart, ack or
  reassignment. Supplying a `batch_id` reuses or replays that exact packet and is
  refused if it is reused for a different chat or notification.
- `read_review_packet` returns the membership summary by default and one bounded
  page when `include_detail` is set (`limit` 1–100, `max_bytes` 1–32768, both
  enforced on UTF-8 byte and code-point boundaries). Its opaque `cursor` binds to
  the exact chat and batch and is refused across either, and every report ID stays
  visible even while its preview is truncated.
- `read_agent` defaults to bounded report metadata (identity, timing, state,
  `text_bytes`, clipped `text_preview`, `text_truncated`, plus the same bounded
  `evidence`/`evidence_authority` claim metadata). Full report text and the raw
  claim are returned only with `include_reports: true`; `include_messages: false`
  returns a terminal/identity-only read with no reports at all. Bounded claim refs
  report explicit `count`, `dropped`, `clipped` and `truncated` flags and set
  `references_dereferenced: false` — nothing is fetched or verified.
- `wait_agent` shares the same bounded projection for its `messages` list by
  default (`reports_included: false`) and the `include_reports: true` opt-in for
  the full untrusted text and raw claim. Membership is never clipped — every
  selected pending report ID is returned — and a wait never acknowledges,
  accepts or signals a report.
- `resolve_message` returns only a short receipt (`message_id`, `agent_id`,
  `acknowledged`, `acknowledged_at`, `report_delivery`, `reply_delivery`,
  `action`). Inbound report delivery (`report_delivery.received_at`/`state`) is
  reported separately from the reply action's native delivery
  (`reply_delivery.state`/`native_receipt`/`error`). It never repeats the
  report or the reply prose, and an uncertain reply stays unacknowledged.
- The host wake body is itself a compact routing envelope: the exact
  `Herdr inbox notification: <id>` first line (so ownership/coalescing is
  unchanged), the manager chat, integration config/CLI fallback identity, a
  receive-first instruction that names the notification ID, and one line per
  actionable report with its kind, ID and worker/terminal (or
  `desk runtime, no terminal`) routing identity. Report prose, raw escalation
  reasons and repeated per-task project paths are omitted; the receive/read
  tools remain authoritative for full text, evidence and routing detail.

These are serialized-JSON byte reductions, not model-token measurements: the
bundled test measures three 4096-byte reports and asserts the compact receive is
materially smaller than the legacy full-report response, and a two-report
`wait_agent` fixture with substantial text and valid evidence measures the
default response against the `include_reports: true` response. A one- and
four-report host wake fixture compares the current body against the frozen
previous `render` and asserts the compact envelope is smaller.

`read_agent` accepts `lines` (1–500, default 80) as a hard tail bound. Some
native `terminal.read` implementations ignore that argument and return the whole
scrollback, so the adapter re-bounds `screen.text` to the last `lines` rows and
reports `screen.truncated` plus `screen.total_lines`. This keeps a small read
small; it never changes the terminal or the agent.

## Aggregate job status

`get_job_status` takes an exact `thread_id` and an optional `target` (agent ID or
full task name, resolved with the same rules as the other tools). The CLI
equivalent is `agent status --thread UUID [--target ID]`. Both call the same
shared projection, so they cannot disagree.

It is a pure read. It performs at most one bounded native read per selected
agent on the call — there is no polling loop, no model turn and no write. The
aggregate state is one of `working`, `waiting_on_agents`, `reviewing`,
`needs_you`, `done`, `unknown`, `failed` or `cancelled`, chosen by most-actionable
priority. Each agent is also reported separately with its native state and
freshness, review/result state, unresolved request and message IDs, writer
ownership, and `next_actor`/`reason`.

Strict truth rules:

- A live, idle or finished process is **not** a completed job. `done` requires an
  accepted report **and** a closed task **and** a retired worker (no writer lease,
  no running process) with no actionable pending messages or unresolved
  deliveries. Every actionable pending kind gates completion, including
  lifecycle/attention notices such as an unacknowledged intentional-stop notice.
- An accepted report alone is never completion; `task close` guards still apply.
- An accepted report on a still-active, idle assignment is `reviewing` for the
  manager (retire the worker, close the task) rather than "waiting on agents".
- Zero selected agents is `unknown`, not `done`: zero selected work is not
  completed work.
- If native state cannot be confirmed (read failed, or only a stale recorded
  observation is available), the state is `unknown`, never a fabricated success.
  Freshness/source/identity are reported so the manager can tell live evidence
  from recorded evidence.
- A native process whose identity no longer matches the registration is
  `reviewing` for the manager (reconcile the original terminal), not silently
  trusted.
- An unresolved (`prepared`/`queued`/`sending`/`uncertain`/`dispatching`) or
  refused (`failed`) delivery is `reviewing` for the manager. A queued or
  prepared obligation is surfaced until it is explicitly settled or cancelled;
  the projection never mutates it.
- A pending agent question or unreviewed report is `reviewing` for the manager;
  ordinary worker questions are a manager review, not automatic user escalation.
- Routine reconciliation — unacknowledged lifecycle notices, unresolved
  deliveries and accepted-but-not-yet-retired workers — is `reviewing` for the
  manager. `needs_you` means a genuine user decision is required, not routine
  manager bookkeeping.
- A finished process or a non-settled native status (`error`, `blocked`, `failed`,
  `cancelled` or anything unrecognised) must not promise agent progress: it is
  `reviewing` for the manager, never `working`/`waiting_on_agents`.
- The aggregate `next_actor` is the winning agent's own verdict, so mixed
  actors for one state are never collapsed onto a static lookup.
- Acceptance tracks the **latest** result verdict only: an older accepted report
  cannot satisfy `done` after a newer report was rejected or replied to.

`failed` is explicit (a registered failure or a quarantine). `cancelled` is
reserved for a genuine durable cancellation record; a rejected (`abort`) report
is a review outcome and never cancels the job. The result never echoes payload or
conversation history — only bounded facts (IDs, counts, clipped paths) — so it
stays a small, safe status read.

## Packaging and local verification

The root `mcp.json` registers `herdr-agents` through
`scripts/herdr-agents.sh`. It uses `HERDR_CODEX_NODE` or `node` and resolves
configuration in the same order as the CLI: explicit `--config`,
`HERDR_CODEX_CONFIG`, then the user default. The protocol implementation is
dependency-free and keeps stdout exclusively for newline-delimited JSON-RPC.
It supports tools discovery/calls, ping, cancellation and concurrent requests.

Build with `node scripts/build-plugin.mjs --out /absolute/new/share-folder`.
The build checks portable files, document links, private-content exclusion,
packaged CLI help and packaged MCP initialization/tool discovery without model
calls. Install/upgrade the local marketplace using the normal plugin workflow
and reconnect/reload the host's tools if necessary. A package build alone does
not prove desktop tool discovery or post-turn wake delivery.

## Local MCP discovery

A plugin can be enabled and still contribute no tools if its local MCP manifest
is rejected. `plugin/mcp.json` must use a plugin-relative command that stays
inside the plugin root (`"command": "./scripts/herdr-agents.sh"`); an absolute or
out-of-tree command is refused by the Agent Plugins schema, leaving the chat with
zero Herdr tools.

`plugin doctor` is a read-only check. It reads the local manifests, validates
them and performs one MCP `initialize` + `tools/list` handshake with the declared
command. It calls no tool, launches no worker, contacts no model and writes
nothing.

```sh
# Installed plugin: use the packaged launcher (resolves runtime/src/cli.mjs)
../../scripts/herdr-codex.sh plugin doctor --timeout-ms 15000
# Source checkout only: the raw entry point exists there, not in the artifact
node src/cli.mjs plugin doctor --timeout-ms 15000
```

`plugin doctor` is a **packaging/MCP handshake check only**. It confirms the
packaged manifest and tool list are well formed; it does **not** prove that native
Herdr, Pi, Goose, Python or a compatible Codex app-server are installed, and it
does **not** prove that a worker message reaches the chat after a turn ends.
Check prerequisites explicitly and qualify a real post-turn wake before treating
the chat as ready. The installed artifact ships its entry point at
`runtime/src/cli.mjs`; the raw `src/cli.mjs` path above is a source-development
form only.

It prints JSON: `ok`, `pluginRoot`, `plugin`, `servers`, `tools`, `checks` and
`remediation`, and exits non-zero when a check fails. A healthy run reports
`"ok": true` and sixteen tools: `spawn_agent`, `send_message`, `followup_task`,
`interrupt_agent`, `stop_agent`, `cancel_request`, `list_agents`, `get_job_status`,
`show_agent`, `wait_agent`, `read_agent`, `receive_notification`,
`read_review_packet`, `resolve_message`, `capture_review`, `verify_review`.
`--skip-probe` validates manifests
only; `--codex PATH` selects a specific CLI binary for the fallback checks.

If the doctor passes but the chat still lists no Herdr tools, the host did not
surface the plugin's server. Register the same server explicitly (this writes to
the host's own MCP configuration; run it deliberately, once):

```sh
codex mcp add herdr-agents -- /bin/sh /absolute/plugin/scripts/herdr-agents.sh
codex mcp list
```

Prefer reinstalling the corrected plugin when possible, so host-managed
`PLUGIN_ROOT`/`PLUGIN_DATA` stay in place:

```sh
codex plugin marketplace add /absolute/share-folder --json
codex plugin add herdr-codex@herdr-codex-local --json
```

This adapter supplements Codex tools; it does not intercept the built-in
`collaboration` namespace or implement exact conversation forks. No blocking hook
is installed. Host hooks, if desired later, require separate qualification.
