# Operating Desks

A desk is persistent context and responsibility owned by the Herdr–Codex integration. Its registration and work state live in SQLite. File-managed desks keep authored intent in the vault’s `Desk/` folder; SQLite retains compiled versions and execution records. Existing vaults and business resources are referenced without relocation. QMD is deferred.

A Herdr space displays the desk's agents. It is not the authoritative desk record. Desk projects still bind actual canonical execution directories, while a file-managed desk opens its registered template folder. Existing spaces can retain a legacy home fallback without changing worker execution. Never infer a desk from the selected desktop space, current shell directory or another chat.

Read the [desk operating guide](../../../docs/desks.md) for the record model and command groups. Core commands use `desk VERB --id DESK-ID`; compound mutation payloads use `--file /absolute/file.json`. Inspect existing desk, project, work and agent records before creating replacements.

## Editable definitions and task writing

Read the [template guide](../../../docs/desk-template.md) for schemas and publication. `desk create` initializes the template; `desk scaffold --id DESK` migrates an inactive existing desk without moving knowledge or overwriting unrelated files. Roles are `agents/ID/AGENT.md`, procedures are `workflows/ID/WORKFLOW.md`, each with YAML metadata and Markdown instructions. `desk validate` reports errors; `desk sync` compiles a complete versioned snapshot. New launches also sync automatically. Missing or invalid files block new work; existing sessions retain their frozen context.

File-managed writing roles default to `writeMode: task`: write only the returned workspace’s `outputs` and `evidence` directories. They can share a read-only project with other output writers. Use `writeMode: project` for an explicitly selected coding checkout; that checkout still permits one writer. Read-only roles cannot write task outputs. Inspect the returned workspace rather than guessing its location.

To maintain shared knowledge, verify the output and use `desk publish --id DESK --file JSON` with a stable request ID, actual source hash, writable resource, relative target and expected current target hash (null for a new file). It checks ownership/content and records a receipt; do not publish an unreviewed result. New notes already live in the vault’s task folders. Native operator tools remain available within authorized scope.

Read the [general Desk guide](../../../docs/general-desks.md) for teams, hierarchical supervision,
native recipes, mixed workflow steps and triggers. Automations start disabled;
only enable explicitly requested work with a workflow and exact owner chat.
Legacy proposal files remain inert. Runtime messages may have no worker terminal;
inspect their run or trigger status, record a decision, then acknowledge.

## Delegate an outcome

1. Establish the exact desk, registered project and current manager chat UUID.
2. Select or create a versioned specialist definition with useful instructions, available resource scope and acceptance criteria.
3. Give the agent a focused assignment and relevant context. Keep the selected provider/model. Do not attach the entire vault by default.
4. Delegate with stable identity, for example:

```sh
herdr-codex delegate --desk bpm --desk-project home --definition analyst --id bpm-analyst-1 --name bpm-analyst-1 --thread EXISTING-CHAT-UUID --text-file /absolute/assignment.md
```

Use actual registered IDs, not the example values. Existing `agent read`, `followup`, `message`, `wait` and `interrupt` operations apply. A definition revision affects future assignments; do not assume it changes the granted scope of an existing session. Raw native commands retain their full operator authority and bypass some plugin bookkeeping.

Legacy single-specialist jobs retain their primary agent. Structured workflows
have distinct step workers with frozen roles, dependencies and supervisor bindings.
Use `desk run-show` for the run and each step's workspace/evidence. Do not overwrite
an existing ownership binding or duplicate a run whose launch is uncertain.

Codex retains planning, implementation, research, review and native Herdr control. Delegate enough authority for ordinary task completion. Agents can consult assigned peers directly; material scope changes or unresolved business decisions return to Codex. Desk/workflow records must not create another permanent manager model.

## Show the correct desk

Open the native desktop with `app` when needed, then use `desk open --id DESK-ID` to establish/select its desk space and first **Desk files** browse tab. Reopening selects the actual template folder without starting agents. Native Files follows the focused terminal, so agent selection can change the visible folder; select **Desk files** to return. Use `show --worker AGENT-ID --place tab` for the first existing worker. Desk splits require registered same-desk anchor workers with verified native process and project identities. A generic shell is not sufficient for a desk split; use a new tab.

Check `app ls` for visibility after placement. Pending is not verified success. The native API still has a global-focus race; report a mismatch and inspect it without automatically moving or closing unrelated tabs. Existing unrelated installations are outside desk cleanup.

## Keep authority and evidence explicit

- Linked vaults default to read/write for new registrations. Use `desk resource-update --id DESK --file JSON` with `{ "id": "vault", "access": ["read", "write"] }` to change an existing resource explicitly. Active users and unsettled jobs using that resource must be resolved first; existing agent grants remain frozen. A read-only specialist still cannot write.
- Local resource references and explicit grants inform worker filesystem scope; resource membership does not grant write access by itself.
- External mailbox/spreadsheet/service records are metadata only until a runtime connector and its authority are implemented. A Codex-connected tool is not automatically available inside Herdr.
- Registering a Desk starts no QMD, email intake, spreadsheet publication or recurring work. Event/interval triggers need an explicitly enabled authored automation; connectors need their own implementation and configuration.
- Native Herdr socket authority means desk labels are not a hostile-agent security boundary. Keep trusted agents inside assigned scope.
- Task/job completion needs actual outcome evidence. A terminal finishing is not business success, and a final agent report is not verification.
- On a coalesced wake, use `notification receive` first. Reconcile stale/handled records without reopening work, then record individual actions before acknowledging messages.

Preserve original source files, exact source references, manual edits and selected model settings. Make permissions and uncertainty visible rather than claiming a resource was connected or a write completed from registration alone.
