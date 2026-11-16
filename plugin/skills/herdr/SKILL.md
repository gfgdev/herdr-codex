---
name: herdr
description: Operate persistent client/project desks and delegate work to native Herdr agents from this Codex chat. Continue sessions and handle event-driven questions and results when the user selects Herdr.
---

Stay the manager in this chat. Use native Herdr workers for useful parallel or
delegated work; do not launch another Codex manager. The bridge carries attention
back to the registered chat and does not decide correctness or the next task.

## Operating guidance

- Prefer a flat set of small, independent assignments over deep hierarchies.
  Break out parallel work only when the work is genuinely independent.
- Give every assignment an explicit write scope, the exact deliverable, and the
  acceptance checks that prove it. Name the files or directories you authorize.
- Ask for a final report of **200 words or fewer plus the artifact** (path, hash
  or diff) — not a narrative. Require the commands actually run and their observed
  results; treat an agent claim as a claim, never as verification.
- Ask workers to run targeted tests for the change and to preserve exit status.
  If an IPC/socket fixture is blocked by the sandbox, report it once; do not
  re-run the full suite to chase the same environmental failure.
- End your turn and rely on the bridge wake for results, questions, blocked states
  and intentional stops; do not poll or create scheduled checking jobs.

When the bundled `herdr-agents` MCP tools are available, use them as your default
subagent interface for Herdr work: `spawn_agent`, `send_message`, `followup_task`,
`interrupt_agent`, `stop_agent`, `list_agents`, `get_job_status`, `show_agent`,
`wait_agent`. Use `read_agent` for
terminal text. Pass this chat's exact UUID as `thread_id` on every call; the server
can be shared by multiple chats and must not guess it. Keep `task_name` stable
across retries; use returned `agent_id` or the same task name as `target`.
Structured fields are `snake_case` (`agent_id`, `task_name`, `request_id`,
`launch_state`, `terminal_id`, `space_id`). Default template is read-only
`explorer`; choose `implementer` for authorized writes. Supply `context` as a
focused brief; only `fork_turns: "none"` is supported. No model override is
provided. The selected Herdr profile stays in control.

Calls with the same content derive the same retry key. Supply a new `request_id`
when intentionally repeating identical messages, follow-ups or interruption.
An interruption retains the writer lease. `wait_agent` returns a scoped
`after_cursor`; reuse it only for the same chat and agent selection. Cancelling
the tool wait does not cancel a worker. A report or native idle state is not
verified completion. Read the [tool adapter guide](../../docs/agent-tools.md).

For a bridge notification, use `receive_notification` first. If actionable, inspect
the current reports, native text and files, then use `resolve_message` to reply OR
accept/abort with evidence and acknowledge. Uncertain replies stay unacknowledged.
The CLI remains available for Desk administration, adoption, recovery, explicit
scope grants and all native capabilities. Do not route Herdr IDs into Codex's
built-in collaboration tools. This adapter does not replace those built-ins.

Resolve `../../scripts/herdr-codex.sh` relative to this installed skill directory.
Configuration is explicit `--config`, then `HERDR_CODEX_CONFIG`, then
`~/.config/herdr-codex/config.json`, independently of the current directory. Use
setup if none is configured. Inspect this chat's existing agents and bridge
status before launching; delayed or uncertain work must not be duplicated.

For desk work, discover `desk list` and inspect `desk show --id DESK`. A desk is
persistent integration state linking existing vaults/resources/projects; a native
desktop space is its optional view. Keep QMD deferred. Read the
[Desk operating reference](references/desks.md) before registering resources,
creating specialists, running manual workflows or displaying a desk team.
Use an explicit desk ID and registered project ID. Bind each new task to this
chat's exact UUID; a desk does not have one implicit global manager chat.
Version specialist definitions as needed, then use `delegate --desk DESK
--desk-project PROJECT --definition ROLE` with the normal delegation arguments.
Local grants come from the registered definition; direct path/scope overrides
cannot silently expand them. External service references are disconnected
metadata until a real connector is implemented and configured. Inspect and
acknowledge evidence before settling work/jobs. Routine native status does not
prove completion. Codex retains its ordinary tools and judgment.

For reusable procedures and teams, read the [general Desk guide](../../docs/general-desks.md)
and [native recipe guide](../../docs/recipes.md). Roles describe reusable expertise;
teams describe reporting; a run freezes selected versions and inputs. Use
`desk run` with a stable job ID for authored workflow steps. `desk run-show`
reports dependencies, execution receipts, artifacts and decisions. Code changes
use explicit project writers; research and operations normally write only their
task's outputs and evidence. Review before publishing shared knowledge.

Grant supervisors only their required `delegateRoles` and `reviewRoles`. Use
`--supervisor AGENT-ID` for an explicit hierarchy or the workflow's team/step bindings.
Child questions and results go to the assigned supervisor through its authenticated
`herdr-supervise` helper. Nested leads are supported. Codex handles policy changes,
out-of-scope authority, unavailable supervisors and consolidated final acceptance.
A native parent label alone grants no authority. Do not have a supervisor recruit
children that the workflow already starts.

Native Goose recipes remain YAML with native fields intact. Each job freezes its
sources; selected model/provider and file authority remain enforced. Recipe runs
end when `goose run` exits; follow-up work uses an explicit new run. Use
conversational Goose for ongoing supervision. Authored command steps are argv
executions with no model call. Their verified zero exit may satisfy a command
gate; an agent claim or recipe exit alone never proves business correctness.

Automations start disabled. Enabling a trigger requires explicit authorization,
a selected workflow and this chat's exact owner UUID. The bridge owns timers
and file events; no scheduled Codex checking job is needed. Inspect
`desk trigger-status`; duplicates reuse one occurrence/job. Blocked runs need
evidence and an explicit retry/cancel decision. Do not relaunch uncertain native
work. Runtime messages have no terminal: inspect their run/evidence, record a
decision and acknowledge them.

Use native Herdr for its full installed capabilities. Consult `native --skill`,
`app --skill` and `capabilities search/describe` as needed. New native commands
do not need a wrapper allowlist or MCP refresh. Put integration `--config` before
`native`/`app`; every subsequent argument belongs to Herdr. The older `herdr` TUI
uses a separate API. Read the [native feature guide](../../docs/native-capabilities.md)
when discovering features and the [qualification guide](../../docs/native-qualification.md)
before switching a core. A schema match alone does not prove lifecycle/wake compatibility.

`delegate` remains convenient for ordinary delegation. Supply a stable agent ID, useful name,
explicit absolute project directory, exact existing chat UUID, and natural-language
assignment. The canonical project is bound to the task and worker. Choose
an appropriate template: `explorer`, `implementer`, `reviewer`, `tester`, or
`investigator`. The default explorer is read-only. Goose is optional; preserve
the selected provider/model. Multiple agents may work concurrently: separate
checkouts for coding writers, disjoint task-output folders for file-managed Desk writers,
or one writer with shared read-only helpers.
Inspect the actual work before editing a worker-owned checkout yourself.

Use `--context-file` for a deliberately selected brief of decisions, constraints,
acceptance checks and references. It is an explicit snapshot, not a fork of this
chat or hidden reasoning. References are not automatically attached. Give peers
their actual native terminal addresses when consultation is useful; they can use
`hc send` directly. A `--parent` records a relationship, not delegated authority.

Continue the same agent with `agent followup`, using a stable request ID. Use
`agent message --mode auto` to send a note to a working agent; if it is idle, the
note queues without activating it. `--mode queue` always queues. Queued notes
join an explicit plugin follow-up; they are not automatically drained when a
turn ends or when someone types into the native terminal. Read request state
before assuming delivery. `agent interrupt` retains the session and writer lease.
See the [delegation guide](../../docs/delegation.md) for commands, context formats,
templates and uncertainty recovery. This interface does not intercept Codex's
built-in subagent tools or reproduce an exact conversation fork.

For an existing local native worker, use `agent adopt` with its exact address,
project, chat and optional Desk binding. `agent children --parent` discovers actual
native children; adoption remains explicit. Read the [adoption guide](../../docs/native-adoption.md)
first. Adoption preserves process/model/permissions and sends no assignment.
Declared scope is not a retroactive sandbox. Unregistered children do not acquire
wake routing automatically; adopted children need their own explicit-report binding.

Use `agent read` and native `read/send/keys/get` for text-only operation. `native`
forwards the full `hc` CLI; `app` forwards `herdr-app`. Consult installed `--skill`,
`--help`, `schema` and `commands` when needed. The convenience layer is not a
capability ceiling and does not depend on replacing MCP tool lists. Read prompts
before answering or sending named keys. Pass
prose as argv or `--text-file`, not shell interpolation. Native control bypasses
plugin request bookkeeping and retains local operator authority; worker file
permissions and writer checks do not fence the full Herdr API.

Ensure the bridge is listening, delegate addressed work, then yield while agents
work. A bounded `agent wait` can wait on local activity during this turn; it does
not replace the bridge that wakes a later turn. Do not create scheduled Codex
checks or a polling manager chat. Queue receipts do not prove actual host wake;
qualify receipt after a Codex turn ends on each new host.

The bridge groups project/task messages into one mutable pending notification per
chat. On `Herdr inbox notification`, use its config and run `notification receive
--id NOTIFICATION-ID` first. Read the returned current inbox; the queued preview
may be old. If `actionable=false`, reconcile only and do not restart work. For each
actionable message inspect `message show`, terminal text and checkout evidence,
then record `message reply` OR an accept/abort `message decision`, and only then
`message ack` after the action completes. Legacy single-message wakes start with
`message receive`. Already acknowledged messages must not be repeated.

The bridge updates/withdraws only its owned queued entries; unrelated messages
remain untouched. Ambiguous delivery is reconciled, never blindly resent; this
is not an exactly-once guarantee. Queue CRUD needs the experimental app-server
API (tested protocol: Codex 0.167.0-alpha.4.1). See the
[configuration guide](../../docs/configuration.md) for host qualification and
[operations](references/operations.md) for individual message recovery. A settled
team, runtime attention or agent claim is not proof of completion.

Show workers through `app` and `show --worker AGENT-ID`, or observe the same live
terminal with `native attach --observe ADDRESS`. The `show_agent` tool (or
`spawn_agent` with `show: true`) does the same panel placement and reports
`status: "unavailable"` with a warning instead of failing when the desktop cannot
place it; the agent keeps running either way. Use text, not screenshots or
vision, for routine operation. Desktop chrome differs from terminal attachment.
Confirm placement using `app ls`; closing a worker pane ends its terminal, while
closing the desktop window preserves workers subject to native lifecycle rules.

`show` verifies native cwd, worker/task labels and recorded process identity, then
selects a matching local project space. Use `--space SPACE-ID` if several match;
create an explicit matching space if none exists. Split anchors are verified too.
Never use an unrelated current space as fallback. Native placement still depends
on global focus: a last-moment race is reported, not automatically repaired by
moving or closing tabs. Inspect `app ls`; pending does not mean verified visibility.
