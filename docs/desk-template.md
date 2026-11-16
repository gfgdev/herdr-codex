# Editable Desk workspaces

Desks are a module of the Herdr–Codex plugin. The vault contains authored instructions and task outputs; the service retains compiled versions, ownership, messages and execution history. No additional manager model or plugin is required.

## Initialize or migrate

`desk create` now initializes the basic template. For an existing registered desk, run:

```sh
herdr-codex desk scaffold --id bpm
herdr-codex desk validate --id bpm
herdr-codex desk sync --id bpm
```

The default location is `<registered-vault>/Desk/`. Without a linked vault it is the private desk directory's `Desk/` sibling of `home/`. Existing knowledge is not moved. Scaffolding refuses an unrelated nonempty `Desk/` folder and symlinked paths rather than merging blindly. A saved scaffold plan supports resuming interrupted creation. Repeating an initialized scaffold synchronizes valid edits without overwriting them.

Migration exports the latest existing roles and workflows, preserving IDs, historical versions and explicit workflow pins. Resolve active desk assignments before migration. New desks without definitions receive researcher, operator and reviewer roles; migration does not replace existing roles with these defaults. No agents, model calls or schedules start during creation.

```text
Desk/
  DESK.md                 # Editable priorities and navigation
  AGENTS.md               # Shared desk working conventions
  desk.yaml               # Schema/identity, name, purpose, knowledge reference
  agents/<role>/AGENT.md
  workflows/<procedure>/WORKFLOW.md
  automations/README.md
  work/<work-id>/
    BRIEF.md
    agents/<agent-id>/
      outputs/
      evidence/
  inbox/
  decisions/
  reports/
```

Task directories are created on first delegation. An assignment without a work-item ID uses `work/agent-<agent-id>/`. Per-agent directories allow collaborators to produce separate artifacts. Small identity files prevent an existing directory from being reused under a different task identity; they are not execution databases. Existing edited briefs survive retries. The registered work brief and explicit assignment remain the execution contract; editing a Markdown brief does not silently change a running job or its status.

## Author agent roles

An `AGENT.md` is ordinary Markdown with YAML frontmatter:

```markdown
---
id: operator
name: Desk operator
harness: pi
scope: write
writeMode: task
resourceIds:
  - vault
acceptance:
  - Cite the source material and report actual verification.
context: Use relevant files; do not load the entire vault.
---

Complete the assigned work. Save useful findings and deliverables in the task
output directory, and record checks and source references in evidence.
```

The ID must match its folder. Harness is `pi` or `goose`; the selected installation model/provider remains unchanged. Scope is `write` or `read-only`. Resources must already be registered in the same desk. Fields are validated; unknown fields, duplicate YAML keys, alias graphs, symlinks and case-alias collisions are rejected. Resolve conflict copies from synchronization before launching new work.

`writeMode: task` is the default for a file-managed role. It grants only the assignment's output and evidence directories. Its registered execution project and knowledge resources remain readable. Multiple such writers can share a read-only execution directory because their actual writes are disjoint.

`writeMode: project` additionally grants the registered project, for example a coding checkout. The existing one-writer-per-checkout rule still applies, including disjoint subdirectories inside that checkout. Overlapping write paths are always reserved exclusively. A read-only role gets no project/output write grants regardless of write mode or resource policy; it returns findings through the terminal/message path.

Normal file-managed roles do not acquire whole-vault write access merely because `vault` is registered read/write. New notes already live in the vault's task folders. Approved changes to shared knowledge use checked publication, or a separately explicit maintenance assignment with exclusive ownership. Native operator access remains trusted local authority; these checks do not claim a hostile-agent security boundary.

`AGENTS.md` is included in a new assignment's frozen context from the same validated snapshot as its role. `DESK.md` provides human navigation. `desk.yaml` is the authored name/purpose configuration; knowledge identity and resource authority cannot be repointed through arbitrary file edits.

## Author workflows

A `WORKFLOW.md` uses the same YAML-plus-Markdown form:

```markdown
---
id: procedure-review
name: Review the documented procedure
definitionId: operator
projectId: home
resourceIds: [vault]
trigger: manual
acceptance:
  - Return a source-supported summary and unresolved questions.
---

Read the relevant procedure and save a summary with source references.
```

Omit `definitionVersion` to compile against the current role. Add it to deliberately pin a historical version. Each job retains its workflow and role snapshot, so later edits do not change a running assignment. Migration preserves preexisting explicit pins.

New delegations and jobs validate and synchronize file definitions automatically. `desk sync` performs the same operation explicitly; `desk validate` reports validity without importing changes. Invalid files block new launches rather than silently falling back to history. Removing a role makes it unavailable for new assignments. An already-running agent's same-session follow-up and identical delegation retry retain the original context even if its authored role later becomes invalid.

The complete validated definition set is imported in one SQLite transaction. A bad workflow cannot partially update roles. `definition-put`, `workflow-put` and authored desk name/purpose changes write through the same files after migration. Their JSON payloads remain convenient authoring inputs rather than a second source of truth. Use the current files as the editing source and rerun validation after manual edits; avoid simultaneous edits to the same control file.

Version 0.7 adds teams, native Goose recipes, structured workflows and optional
manual/event/interval triggers. See the [general Desk guide](general-desks.md)
for their schemas. Automations default to disabled; enabling one needs an exact
owner chat and selected workflow. Older proposal files remain inert. QMD and
authenticated mail/spreadsheet connectors remain separate integrations.

## Publish approved task output

Read and verify the artifact first. Then use `desk publish --id bpm --file /absolute/publication.json`:

```json
{
  "requestId": "publish-reviewed-summary-1",
  "agentId": "bpm-operator-1",
  "source": "/absolute/task/outputs/summary.md",
  "sourceSha256": "SHA256_OF_REVIEWED_SOURCE",
  "resourceId": "vault",
  "target": "Procedures/PO summary.md",
  "expectedSha256": null
}
```

Supply the actual 64-character SHA-256 values. `expectedSha256: null` requires a new target. To replace an existing note, supply the hash of the version reviewed. Source must be inside this desk agent's output/evidence directories; target must be inside a registered writable directory. Publication refuses active writer ownership, traversal, symlinks, Obsidian configuration, Desk control files and other task folders. Publishing into `Desk/inbox`, `Desk/decisions` or `Desk/reports` is supported.

New targets use atomic no-replace creation. Replacements check the reviewed content and retain the previous bytes in private recovery storage. A durable request ID reconciles a crash and prevents a successful retry from overwriting a later human edit. Reusing an ID with different contents is an error. A rejected content check does not become success on retry.

The service serializes cooperating writers. Obsidian and other external editors do not share its lock: replacement rechecks immediately before the atomic rename, but there remains a narrow external-edit race. Previous-content recovery evidence is retained; do not describe this as a filesystem-wide transactional compare-and-swap.

## Watch and continue

`desk open` puts **Desk files** first and selects the actual template folder. New spaces start at that folder; migrated spaces preserve existing shells and workers. Native Files follows the focused terminal, so selecting an agent may show its execution folder. Reopen the desk to return to its files.

Use `desk open --id bpm`, then `show --worker AGENT-ID --place tab`. Agents retain the actual registered project cwd and Desk labels; output folders do not move them into another client's project. Existing text reads, follow-ups, peer consultation and event-driven notifications apply. There is no periodic Codex polling job.

Private runtime state and credentials remain outside the vault. The template and authored definitions can travel with the vault, but each host still requires explicit local Desk/resource registration. Syncing files to another machine does not start duplicate jobs.
