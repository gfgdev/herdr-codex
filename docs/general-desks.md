# General Desk definitions

A Desk is the durable home for a body of work. Its authored files describe reusable roles, teams, procedures and triggers. The integration database retains immutable versions, task ownership, execution state and evidence. Herdr remains the native worker interface; a Desk does not replace its terminal, session or tool capabilities.

## Start with a small real task

Use the [coding, research or operations starter](../examples/desks/README.md) to copy a complete, disabled-by-default example into a scaffolded Desk. Each starter includes roles, a team, a workflow, a native Goose recipe and an automation. Register an explicit `working` project, run one representative task manually, inspect the artifacts and native terminal text, then decide whether its trigger should be enabled. No client-specific folder layout or external connector is assumed.

## Files and ownership

New templates contain:

```text
Desk/
  desk.yaml                     identity and knowledge root
  DESK.md                       human orientation and priorities
  AGENTS.md                     shared working conventions
  agents/<role>/AGENT.md         specialist instructions and explicit authority
  teams/<team>/TEAM.md           member identities and reporting relationships
  workflows/<workflow>/WORKFLOW.md
  recipes/<recipe>/recipe.yaml   original native Goose recipe and companion files
  automations/<trigger>.yaml     disabled by default
  knowledge/                    reviewed, durable findings
  inbox/                        incoming material
  decisions/                    decisions and their supporting evidence
  reports/                      published reports
  work/<work>/agents/<agent>/
    outputs/                    task deliverables
    evidence/                   verification and source references
```

Existing vault files stay where they are. The template references the registered vault; it does not relocate it. Scaffolding an existing Desk adds missing `teams`, `recipes` and `knowledge` directories without replacing human notes or instructions. Task writers receive assigned output directories. Publication to shared knowledge remains an explicit, checked operation. Ordinary tasks cannot change Desk control files to increase their own permissions.

The Desk file sync validates the entire authored configuration before importing any changes. Invalid references, cycles, duplicate IDs, symlinks and conflicting synchronized files fail clearly. Editing a definition creates a new version; it does not rewrite an active job's instructions. Legacy single-specialist workflows retain their existing versions and behavior.

## Roles

Role Markdown has YAML frontmatter and a Markdown instruction body:

```markdown
---
id: operations-lead
name: Operations lead
harness: goose
scope: read-only
resourceIds: [vault]
authority:
  delegateRoles: [record-processor, reviewer]
  reviewRoles: [record-processor, reviewer]
---

Coordinate the assigned work. Resolve routine questions using documented Desk
policy. Escalate missing business decisions with the relevant source evidence.
```

The existing `harness`, `scope`, `writeMode`, resource grants, acceptance checks and context fields remain available. `authority` is optional and accepts only `delegateRoles` and `reviewRoles`. Empty or absent authority does not grant supervision. All referenced roles must exist in this Desk. A role grant does not itself provide additional projects, resources, credentials or external connectors.

## Teams

```markdown
---
id: records
name: Record processing team
members:
  - id: lead
    definitionId: operations-lead
  - id: intake
    definitionId: record-processor
    reportsTo: lead
---

The lead handles routine intake questions; Codex retains business decisions.
```

Each member has its own ID and a pinned role version. `reportsTo` is another member ID, or null for a root. Reporting cycles, missing parents and supervisors without both delegation and review authority for a child's role are rejected. Teams are reusable definitions, not automatically running agents.

## Structured workflows

A workflow may retain the legacy top-level `definitionId` and instruction body, or define explicit steps:

```markdown
---
id: record-intake
name: Record intake
projectId: home
teamId: records
resourceIds: [vault]
steps:
  - id: supervise
    kind: agent
    teamMemberId: lead
    instructions: Coordinate intake and inspect the final evidence.
  - id: extract
    kind: agent
    teamMemberId: intake
    instructions: Read the supplied document and prepare a checked draft record.
    acceptance:
      - Every extracted value references its source.
      - Ambiguous values are surfaced rather than guessed.
---

Process the supplied record under the current Desk policy.
```

Every step in a team workflow names `teamMemberId`. Its role/version must match that member. A child's supervisor step is resolved from the team's reporting tree; the parent must correspond to exactly one workflow step. Explicit `supervisorStepId` is also available without a team. Supervision is separate from dependencies: an active lead does not have to finish before its child can run.

Steps support:

| Kind | Additional fields | Purpose |
| --- | --- | --- |
| `agent` | `instructions` | Open-ended work by a scoped specialist |
| `recipe` | `recipeId`, optional `recipeVersion`, `parameters` | Native Goose recipe execution; requires a Goose role |
| `command` | `command: { argv: [...] }` | Deterministic operation with preserved argument boundaries |
| `review` | `dependsOn` and review authority | Review explicit upstream work |

Every step has an explicit role or the workflow's fallback `definitionId`, including commands. `dependsOn` is a list of prerequisite step IDs and must form an acyclic graph. Review roles need `authority.reviewRoles` for the roles of their dependencies. Optional per-step `acceptance` lists the evidence expected. Command arguments are an array; authoring an argv does not grant shell or filesystem privileges beyond the assigned scope.

Workflow resources cannot exceed its declared roles. At execution, each step receives the intersection of workflow resources and its own role's resource grants. Supervision does not permit a child to escape that bound. Workflow and team role versions remain explicit when imported.

## Native recipes

The recipe directory retains native YAML and companion files. The recipe library validates local file references and freezes the whole bundle, including nested recipes, with content hashes. Native validation and execution belong to the installed Goose runtime. Desk schemas do not translate recipe features into a narrower prompt-only representation. New native fields remain in the original recipe content.

A recipe step can pin a published recipe version. Without an explicit version, a new job snapshots the current authored recipe. Later edits do not change that job. Runtime validation preserves the selected model/provider and the assigned resource scope.

## Automations

```yaml
id: morning-intake
name: Morning intake
type: interval
workflowId: record-intake
enabled: false
everySeconds: 86400
startAt: '2026-11-14T08:00:00-08:00'
overlap: skip
catchup: latest
```

Types are `manual`, `event` and `interval`. An event uses `eventName`; an interval uses positive integer `everySeconds` and an optional timezone-qualified `startAt`. `overlap` is `skip` or `queue`. Interval `catchup` supports `latest`: after downtime, one latest interval is recorded with a count of missed slots, without launching every historical run. Each trigger pins a workflow version. Enabling requires an exact `ownerThread` UUID to route attention to the correct Codex chat. New triggers default to disabled. Previously authored disabled proposals with no recognized type remain inert and are reported separately; importing them never enables execution.

A trigger definition is not a mailbox or spreadsheet connector. It cannot grant access to an external service. The execution engine owns scheduling, event receipts, overlap handling and resumable run state; the authored file provides the configuration.

## Frozen run inputs

`Desks.jobCreate` accepts `parameters`, a bounded JSON object. The first registration freezes the workflow, step role versions, team, shared instructions, recursive delegated/reviewed role definitions, native recipe bundles, exact resource descriptors and run parameters. Object keys in parameters are canonicalized, so equivalent JSON with reordered keys reuses the same job; array order remains meaningful. Definition snapshot keys use `roleId@version`; recipe keys use `recipeId@version`. The legacy `snapshot.definition` remains available.

Retries with the same job ID retain the original snapshot even if files are later edited, removed or malformed. Changing run parameters, project or owner chat under the same ID is rejected. Use a new job ID for a new run. Jobs do not silently reopen after completion, failure or cancellation.

The schema API exposes `definitionPut`, `teamPut`, `workflowPut`, `automationPut`, corresponding singular/versioned lookups and lists, plus `jobCreate`. For a file-managed Desk these authoring APIs update the same files; they do not create a second conflicting source of intent.

## Trigger execution and recovery

The existing background bridge owns `DeskTriggers`. It performs deterministic scheduling without creating Codex polling jobs or invoking a model to decide whether a clock tick is due. There is one next-due service timer, plus filesystem watchers limited to registered Desk automation directories. File notifications cause the entire Desk configuration to be validated before dispatch. Stopping the trigger engine cancels the timer and closes its watchers; already accepted jobs retain their existing ownership.

The integration API is:

```js
const triggers = new DeskTriggers({
  store, config,
  createRun: input => workflowRuns.create(input),
  onError: (error, context) => report(error, context)
});
await triggers.start();
await triggers.emit({
  deskId: 'operations-demo', id: 'source-event-123',
  eventName: 'records.received', payload: { source: 'authorized-document-id' }
});
// Explicit manual automation invocation:
await triggers.emit({ deskId: 'operations-demo', id: 'manual-request-456', automationId: 'manual-intake', payload: {} });
triggers.status('operations-demo');
triggers.stop();
```

`createRun` receives the exact pinned workflow version and owner chat, a stable occurrence/job ID, and `parameters: { payload, trigger }`. The trigger metadata includes its version, interval slot or event ID, and missed-slot count. A durable occurrence is recorded before dispatch. Repeated events with the same ID and payload reuse their receipt; changed contents under an existing ID fail. An event that matched no enabled triggers is still recorded and cannot activate newly added triggers when replayed later.

`skip` records why an occurrence was skipped while its workflow had unsettled work. `queue` retains the occurrence until that work settles. Simultaneous trigger instances claim intent transactionally before calling the run engine. A process crash leaves the same occurrence available for recovery. A lost callback acknowledgement retries the same job ID and parameters, so the run engine can reconcile accepted work without inventing another run. There is no arbitrary request-count cutoff.

Removing, disabling or revising a trigger prevents its undispatched old occurrences from starting. Already accepted jobs remain visible and are not canceled by editing a file. Invalid authored files block dispatch with a visible configuration error; the engine does not fall back to an older enabled version. `status` includes occurrence states, errors, watcher health and missed counts. Watcher failure is reported explicitly; a CLI/service pulse can still revalidate the files. New Desk registration refreshes the watcher set on the next service pulse.

These triggers schedule existing workflows. Email ingestion, document extraction and spreadsheet updates still require separately authorized connectors and task logic.

## Supported CLI authoring and inspection

Use the installed plugin launcher (or your configured wrapper) wherever `herdr-codex` appears. JSON payload files use ordinary JSON without comments. The Desk ID comes from `--id`; a payload may omit `deskId` and cannot substitute another Desk.

| Command | JSON payload or purpose |
| --- | --- |
| `desk create --id DESK --file desk.json` | `{name,purpose,vaultPath?}`; creates the authored template |
| `desk project-add --id DESK --file project.json` | `{id,name,path,description?}`; exact absolute working folder |
| `desk definition-put --id DESK --file role.json` | Role fields described above; updates `agents/<id>/AGENT.md` |
| `desk team-put --id DESK --file team.json` | `{id,name,instructions?,members}` |
| `desk workflow-put --id DESK --file workflow.json` | `{id,name,projectId,teamId?,steps,...}` |
| `desk recipe-put --id DESK --file recipe.json` | `{id,content,files?}`; `content` is the original native YAML string |
| `desk automation-put --id DESK --file trigger.json` | The complete trigger definition; does not infer an owner chat |
| `desk validate --id DESK` / `desk sync --id DESK` | Validate all authored files / import new versions |
| `desk run --id DESK --workflow FLOW --job RUN --thread CHAT --params-file inputs.json` | Start or reconcile the same frozen run |
| `desk runs --id DESK` / `desk run-show --id DESK --job RUN` | Inspect recorded step state and evidence |
| `desk agents --id DESK --thread CHAT` | Find this chat's actual workers and terminal addresses |
| `desk trigger-status --id DESK` | Occurrences, errors, missed intervals and watcher health |
| `desk event --id DESK --file event.json` | Explicit event or manual-trigger invocation |

For example, this complete role payload creates a task-output-only researcher:

```json
{
  "id": "document-analyst",
  "name": "Document analyst",
  "harness": "goose",
  "scope": "write",
  "writeMode": "task",
  "resourceIds": [],
  "instructions": "Answer the assigned question from authorized project documents. Save a sourced brief in your task outputs and report gaps.",
  "acceptance": ["Every material claim cites a source file and section"]
}
```

```sh
herdr-codex desk definition-put --id research-demo --file /absolute/path/role.json
herdr-codex desk open --id research-demo
herdr-codex app
herdr-codex show --worker ACTUAL-WORKER-ID --place right
herdr-codex native read ACTUAL-TERMINAL-ADDRESS --lines 80
```

`desk open` browses the Desk's authored files. `show` selects the verified worker inside the desk's **one shared Desk space**, so the desk's agents and files stay together in a single space rather than a space per agent; the Files panel can still follow focus to that worker's execution folder. Neither command moves project files. See the starter README for complete creation, project registration, inputs and trigger examples.

When a step needs intervention, inspect `run-show` and the actual evidence first. Recorded step operations use a JSON payload with `stepId`, a stable `requestId`, and an evidence-bearing `note`: `step-decision` additionally requires `action: "accept"` or `"abort"`; `run-retry` is for a failed/blocked step. `run-cancel` uses `requestId` and `note` for the whole run. Pending agent messages must first receive their decision and acknowledgement through the existing message interface. A terminal ending alone is never sufficient evidence for acceptance.
