# Desks in Herdr–Codex

A desk is a persistent area of responsibility, such as a client or a personal project. It brings together knowledge references, resources, projects, work items, specialist definitions, workflow definitions and execution records. Codex operates the desk through natural-language requests and the local CLI; Herdr hosts its agents.

## Where a desk lives

Version 0.5 adds the [editable Desk template](desk-template.md). New CLI-created desks initialize it; use `desk scaffold --id DESK` to migrate an existing desk. Authored role/workflow files become the source of intent, while the service retains compiled versions and execution state.

The authoritative desk registration lives in the integration's private SQLite database, alongside its durable task and message records. Each desk also has a private home directory with a generated `DESK.md` landing page. That page makes the registration readable; the database remains authoritative for identities, ownership and execution state.

An existing Obsidian vault is a referenced resource. Registering it does not move its files, copy the vault into worker state or enable a search index. QMD is deferred. Agents use the explicitly granted paths and ordinary text/file tools for the current release. Runtime databases, worker state and credentials remain outside the vault.

After migration, `Desk/DESK.md` in the vault is the editable navigation page; the old private-home page remains as a preserved registration landing page.

A native Herdr **space is a view of a desk**, rather than the desk itself. For file-managed desks, `desk open` selects a first **Desk files** tab at the registered template root. New spaces are created there; older spaces retain their native creation-folder fallback while the browse tab supplies the live files location. Agents can work in different explicitly registered project folders and appear together in the desk space. Their actual execution directories and identities are still checked. Closing a space/window does not delete the desk record; closing an agent pane can terminate that native process.

## What is registered

| Record | Purpose |
| --- | --- |
| Desk | Stable identity, name, purpose and home directory |
| Project | Explicit canonical execution directory belonging to a desk |
| Resource | A local knowledge/data path or external service reference, with declared intended access |
| Work item | A durable piece of work, its assigned context and recorded outcome |
| Specialist definition | Versioned instructions, harness, resource scope and acceptance guidance |
| Workflow definition | A versioned repeatable assignment referencing a specialist |
| Job | One execution record, with ownership, state and evidence |
| Activity | The journal of desk changes and work events |

Work items, jobs and native agent sessions have different lifetimes. A stopped or completed terminal is not proof that a job succeeded. Conversely, a completed job remains available after its agent session ends. Codex verifies evidence before recording completion.

The desk exists across chats. Each delegated task/job still belongs to one exact manager chat. Use that existing chat's UUID, and retain stable IDs when retrying. Do not silently change a running assignment's project, desk or manager destination. Each work item or job has one recorded primary agent. Give collaborating specialists separate work assignments within the same desk and their actual peer addresses; do not overwrite a primary-owner binding to add a reviewer.

## Ordinary use through Codex

You can say:

> Create a BPM desk and reference my existing vault. Register this project folder. Create a read-only operations analyst that can use the approved reference material, and have it explain the current purchase-order procedure. Show the analyst in BPM's Herdr space.

Codex checks the registration, creates any missing authorized records, chooses a specialist definition and delegates a natural-language task. The selected Modal/provider configuration is preserved. A business role such as analyst or purchase-order specialist is independent of whether Pi or Goose runs it.

For continuation:

> Continue the same BPM analyst. Compare the procedure with these examples and report unsupported assumptions.

Codex uses the existing session's follow-up operation. A new definition version describes future work; it does not silently expand the filesystem access of an already-running agent.

## CLI command groups

`herdr-codex` means the installed plugin's `scripts/herdr-codex.sh` or the configured wrapper. Configuration comes from the explicit `--config`, then `HERDR_CODEX_CONFIG`, then the selected user default. Desk discovery is independent of the current shell directory.

Use `--id DESK-ID` to select a desk. Compound mutation payloads are provided as JSON files with `--file /absolute/payload.json`; keep credential values out of those files. Run `help` for the exact supported flags.

| Commands | Use |
| --- | --- |
| `desk create`, `list`, `show`, `update` | Establish and inspect the persistent desk |
| `desk project-add`, `projects` | Register explicit project directories |
| `desk resource-add`, `resource-update`, `resources` | Catalogue local paths and external resource references |
| `desk definition-put`, `definitions` | Store and inspect versioned specialist definitions |
| `desk workflow-put`, `workflows` | Store and inspect single-specialist or structured workflow definitions |
| `desk team-put`, `teams` | Version role assignments and reporting relationships |
| `desk recipe-put`, `recipes`, `recipe-validate` | Preserve and validate native Goose recipe bundles |
| `desk runs`, `run-show`, `run-retry`, `run-cancel` | Inspect and recover durable multi-step runs |
| `desk automation-put`, `automations`, `event`, `trigger-status` | Configure and inspect optional service-owned triggers |
| `desk work-create`, `work-update`, `work` | Maintain the desk work register |
| `desk job-create`, `job-update`, `jobs` | Record and inspect execution state and evidence |
| `desk run` | Start an explicitly requested workflow execution |
| `desk open` | Open/select the matching native desk space and its Desk files tab |
| `desk agents`, `activity` | Inspect registered agents and recorded changes |
| `desk overview` | Compact read-only projection of registered projects, agents/tasks/roles, pending report/request counts and exact-checkout writer reservations |

For example, create the desk using an existing vault:

```sh
herdr-codex desk create --id bpm --name "BPM" --purpose "Client operations and project delivery" --vault /absolute/existing-vault
herdr-codex desk show --id bpm
```

`desk overview --id bpm [--thread UUID] [--limit N]` is a compact, read-only projection of the records already stored for the desk. It reports registered project IDs and paths, each agent/task/role ID with its owner chat, terminal reference, recorded launch/task/retirement state, pending report and request counts, and the writer reservations currently held on the desk's exact checkouts (its home and registered project paths). It performs no native calls and mutates nothing, so every value is a **recorded** fact rather than live verification; the output states this explicitly and no liveness is implied.

Lists are bounded (25 by default) and always include `total` and `truncated`, so a clipped view is visible rather than silent; `totals.agentsShown` is the number of agent rows actually returned after clipping, while `totals.agents` is the pre-clip recorded total. A `--thread UUID` filter narrows the agent projection to one owner chat but never hides another owner's blocking checkout reservation: reservations are reported separately with minimal ownership metadata and no report contents. Ownership is reported from recorded state alone: `ownership.stoppedButHeld` requires a recorded `stopped`/`finished` launch state **and** a still-held writer lease, while a pending retirement is reported separately as `retained` and never, by itself, implies that the process has stopped. Only a genuinely absent `agent_requests` table is reported as zero pending requests. A stored request is only trusted once it parses to a non-null object whose worker/request identity matches the row it was read under and whose `state` is a recognised lifecycle state; an unparseable, unclassifiable or foreign record, or an unexpected query failure, makes the affected `pendingRequests` counts `null` (unknown) rather than a misleading zero. Failures are listed in a bounded top-level `errors` object (`total`/`truncated`/`items`) whose items are metadata-only `{workerId,row,reason}` with stable reason codes (`malformed-json`, `not-an-object`, `missing-worker-id`, `worker-mismatch`, `missing-request-id`, `row-mismatch`, `missing-state`, `unknown-state`, `read-failed`); raw JSON-parse/SQL error text and record contents are never echoed.

The vault flag is optional. Creation registers the private `home` project and, when supplied, a read/write `vault` resource. A desk can be created before its external resources are known. File-managed writers use task output directories by default; resource read/write policy does not grant the whole vault to every task. See the template guide for `writeMode: project` and checked publication. `desk update` can later attach its first vault reference. An already-registered vault identity is not silently repointed; register another resource when a distinct location is intended.

Existing registrations retain their saved access until explicitly changed. Change a resource's access with `desk resource-update --id bpm --file /absolute/resource-access.json` and a payload such as `{"id":"vault","access":["read","write"]}`. This operation cannot repoint its path or change its kind. It records the old/new access and refuses a permission change while active desk agents or unsettled jobs reference the resource; resolve those assignments first. It never changes an existing worker's frozen grants. For a read-only resource, use `["read"]`.

The vault is a shared working knowledge base where authorized agents and Codex can add findings and maintain documents. Read/write resource access still combines with the selected specialist's scope: a read-only reviewer remains read-only, while a `write` specialist can write its declared writable resources. Instructions should describe useful edits and preservation of existing human work rather than treating all vault content as immutable.

Register another execution project with `desk project-add --id bpm --file /absolute/project.json`:

```json
{
  "id": "client-report",
  "name": "Client report workspace",
  "path": "/absolute/report-workspace",
  "description": "Local files for the reporting project."
}
```

Create a read-only specialist with `desk definition-put --id bpm --file /absolute/analyst.json`:

```json
{
  "id": "analyst",
  "name": "Operations analyst",
  "harness": "goose",
  "scope": "read-only",
  "instructions": "Investigate the assigned question using the approved reference material. Distinguish documented facts from assumptions, cite exact sources, and report unresolved questions.",
  "resourceIds": ["vault"],
  "acceptance": ["Every substantive finding identifies its source.", "Missing information is reported rather than invented."],
  "context": "Use the desk's actual instructions and examples. Resource references are not automatic attachments."
}
```

The `vault` resource must already exist in this desk. Definitions accept `pi` or `goose` and `read-only` or `write`; they retain the configured endpoint/model. Different content creates a new version, while repeating identical content preserves the existing version. Register only the resources needed for the role.

Desk delegation extends the existing interface:

```sh
herdr-codex delegate --desk bpm --desk-project home --definition analyst --id bpm-analyst-1 --name bpm-analyst-1 --thread EXISTING-CHAT-UUID --text-file /absolute/assignment.md
```

Use the registered project ID that actually matches the assignment; `home` is the desk's default project when present. Retrieve the returned agent/task/terminal IDs. The same stable agent ID and unchanged payload reconcile a retry; a different assignment belongs in an explicit follow-up or a new agent.

Existing follow-up and inspection commands remain available:

```sh
herdr-codex agent read --id bpm-analyst-1 --lines 80
herdr-codex agent followup --id bpm-analyst-1 --request-id followup-1 --text-file /absolute/followup.md
herdr-codex show --worker bpm-analyst-1 --place tab
```

The full native CLI remains available for supported operations outside these conveniences. Using it requires the same attention to scope and ownership; it can bypass integration bookkeeping.

## Manual workflows and work records

A workflow is a repeatable assignment, pinned to a specialist version. Register one with `desk workflow-put --id bpm --file /absolute/workflow.json`:

```json
{
  "id": "procedure-review",
  "name": "Review the documented PO procedure",
  "definitionId": "analyst",
  "projectId": "home",
  "instructions": "Read the approved desk material and summarize the current purchase-order procedure. Identify exact sources, decision points and missing details. Keep source files read-only.",
  "resourceIds": ["vault"],
  "acceptance": ["Return a source-supported procedure summary and a distinct list of unresolved questions."],
  "trigger": "manual"
}
```

Run it explicitly:

```sh
herdr-codex desk run --id bpm --workflow procedure-review --job procedure-review-1 --thread EXISTING-CHAT-UUID
herdr-codex desk jobs --id bpm
herdr-codex desk agents --id bpm
herdr-codex desk activity --id bpm
```

The job ID identifies one execution. Retrying uses the same ID; an independent future run gets a new ID. `--desk-project PROJECT-ID` chooses a registered execution project and `--work WORK-ID` links an existing compatible work item. The workflow's resource list may narrow its specialist's resources; it cannot grant additional ones. Scheduled triggers are rejected in this release.

Work records use `planned`, `assigned`, `running`, `blocked`, `review`, `done` or `cancelled`. Job records use `pending`, `running`, `blocked`, `review`, `completed`, `failed` or `cancelled`. Work/task/agent links must match the registered desk, project and manager chat. Settled work and jobs do not silently reopen. Completion, cancellation or failure requires a recorded explanation/evidence note; inspecting process state alone does not settle a job.

The first release stores instructions, resource references and acceptance guidance. It does not claim automatic validation of arbitrary business output schemas or a built-in specialist evaluation framework. Codex still inspects actual output and relevant checks before recording the outcome.

## Desktop placement

Start the native desktop with `herdr-codex app` if it is not already running. Use `desk open` to establish or select the native space and its **Desk files** tab. That tab opens the editable template (`<vault>/Desk` when a vault is linked), not private execution storage. Reopening selects it again without starting an agent. Then use `show --worker AGENT-ID` to display the existing terminal; showing it must not launch another agent.

Herdr’s Files panel follows the focused terminal. Selecting an agent can show its working directory; select **Desk files** or run `desk open` again to return to the template. The plugin does not pin the Files panel or replace worker working directories.

Desk placement checks the worker's registered desk and project, native working directory, task/worker labels and process identity. A matching display folder alone is insufficient. Remote spaces, unrelated selected spaces and ambiguous matches require explicit resolution.

For the first worker, use `--place tab`. A desk split (`right` or `down`) requires every existing pane to resolve to a verified same-desk registered worker. A generic shell pane or another client's terminal is not a valid split anchor. Different registered project directories within the same desk can share a split once those checks pass.

Herdr's native placement operation still uses global focus. The integration checks before and after placement and reports a last-moment race; it does not close or move unrelated tabs to conceal one. Inspect `app ls` after a pending or uncertain placement. Agent execution remains bound to the registered project even if desktop focus changes.

## Authority and resources

Resource registration and a specialist definition describe intended access. Local path grants constrain integration-generated worker launch scope and the direct process filesystem sandbox. A resource's presence in a desk does not automatically make all of it writable, and a natural-language reference does not grant access.

External mailbox, spreadsheet and service references are **metadata in this release**. They do not install a connector, grant OAuth access, ingest mail, update a spreadsheet or send email. Those operations need a separately implemented runtime connector and explicitly configured authority. Tools connected to Codex are not automatically inherited by Herdr agents.

The native Herdr control socket still retains local operator capabilities. Desk labels and file grants are not a hostile-agent, multi-tenant security boundary. Use trusted agents and preserve desk scope when operating native commands.

Codex retains its ordinary capabilities and can work directly, delegate, review, revise or take over an assignment after coordinating the writer. Keep one writer per coding checkout. Give independent business jobs their own execution workspaces rather than treating an entire vault as one shared writable checkout.

## Completion and notifications

Use the existing coalesced manager inbox. On a `Herdr inbox notification`, first run `notification receive --id …` and inspect the current records. If `actionable=false`, reconcile only. For an actionable report, verify actual evidence, record a reply or accept/abort decision, then acknowledge it.

Worker claims, task completion, job completion and message acknowledgment are distinct. A final report is evidence to review. Recording a job outcome should identify the actual output/checks; a native `done` status alone is insufficient. Preserving those distinctions avoids falsely completed business work.

## Current boundaries

The [general Desk framework](general-desks.md) adds native recipes, teams and
durable mixed workflows. Event/interval triggers are available but start disabled.
A workflow definition alone is not a running schedule. QMD, email ingestion and
authenticated spreadsheet connectors need separate implementation/configuration;
registering a resource never silently authenticates or starts business work.

See [delegation](delegation.md) for session semantics and [configuration](configuration.md) for the existing native runtime and provider setup.
