# Portable Desk starters

These are editable examples, not preconfigured client operations. They contain no credentials, personal paths, provider changes or active schedules. Installing a starter only copies authored files into an existing Desk template. It does not launch workers or run native/model commands.

| Starter | Team and workflow | Writes | Disabled automation |
| --- | --- | --- | --- |
| `coding` | Goose lead → Pi implementer → native Goose review recipe | Implementer writes the registered checkout; reviewer writes its own task outputs | Explicit manual request |
| `research` | Goose lead → native Goose sourced-brief recipe → Goose review | Task outputs only; source documents remain unchanged | Named research-question event |
| `operations` | Goose lead → deterministic file inventory → Pi record processing → native Goose validation recipe | Proposed task artifacts only; originals and external systems remain unchanged | Daily interval, latest-slot catchup |

Every workflow uses the explicitly registered project ID `working`. Role, team, workflow and recipe IDs are prefixed so the starter does not replace default Desk roles. The lead is an ongoing agent with both delegation and review authority. Recipe runs are finite native Goose processes; they report evidence to the lead and do not replace its continuing conversation. Codex retains business decisions, scope changes and final review of the lead's consolidated outcome.

## Install one starter

In commands below, `herdr-codex` means your installed plugin launcher or configured wrapper. It is not an assumption that a global executable is already on `PATH`. Use your actual configuration and chat UUID. Placeholder paths must be replaced with existing absolute paths.

Create a Desk with the supported JSON interface:

```json
{
  "name": "Research Desk",
  "purpose": "Answer scoped questions from our source documents",
  "vaultPath": "/absolute/path/to/existing/knowledge-folder"
}
```

```sh
herdr-codex desk create --id research-demo --file /absolute/path/desk-create.json
```

The `vaultPath` is optional. The result returns `fileTemplate.root`, the actual location of its `Desk` directory. Next register the folder where this starter will work:

```json
{
  "id": "working",
  "name": "Trial documents",
  "path": "/absolute/path/to/local/source-documents",
  "description": "Local documents authorized for this trial"
}
```

```sh
herdr-codex desk project-add --id research-demo --file /absolute/path/project.json
node /absolute/path/to/herdr-codex/examples/desks/install.mjs --kit research --desk-root /absolute/path/to/knowledge-folder/Desk
herdr-codex desk validate --id research-demo
herdr-codex desk sync --id research-demo
herdr-codex desk open --id research-demo
```

The installer rejects a conflicting existing file before copying anything. Identical files can be copied again. It never overwrites `DESK.md`, `AGENTS.md` or `desk.yaml`. After installation, edit the examples to fit your actual task. If validation fails, fix the reported authored file before running work.

For `coding`, register a disposable or explicitly authorized checkout as `working`; the implementer can edit it. For `operations`, use a local folder with the sample records and their processing rules. No email or spreadsheet connector is implied by that kit.

## Try a manual run first

Create `/absolute/path/inputs.json` with meaningful inputs, for example:

```json
{
  "question": "What changed between the two supplied plans?",
  "sourceFiles": ["plan-before.md", "plan-after.md"],
  "acceptance": ["Every material change cites a section in both documents"]
}
```

```sh
herdr-codex desk run --id research-demo --workflow research-brief --job comparison-001 --thread ACTUAL-CODEX-CHAT-UUID --params-file /absolute/path/inputs.json
herdr-codex desk run-show --id research-demo --job comparison-001
herdr-codex desk agents --id research-demo --thread ACTUAL-CODEX-CHAT-UUID
```

Use `coding-change` or `operations-batch` for the other starters. Run parameters are given to each agent as context; the sample workflows do not assume a fixed business input format. A repeated job ID with the same inputs reuses its frozen run. Use a new ID for a separate task.

Open the native desktop and show a returned worker ID:

```sh
herdr-codex app
herdr-codex show --worker RETURNED-WORKER-ID --place right
herdr-codex native read RETURNED-TERMINAL-ADDRESS --lines 80
```

`desk open` shows the Desk's authored files. Workers execute in the registered `working` folder; `show` selects that exact project inside the desk's **one shared Desk space**, so keep related agents and files together in a single space instead of creating a space per agent. Inspect actual terminal text and produced files before accepting results. Native agent messages return through the existing bridge; do not create a Codex polling schedule.

## Reusable recipes and triggers

Inspect and validate the selected starter's native recipe without starting model work:

```sh
herdr-codex desk recipes --id research-demo
herdr-codex desk recipe-validate --id research-demo --recipe research-brief
herdr-codex desk trigger-status --id research-demo
```

Native syntax validation is not proof of task quality. Run a small, representative task and inspect the outputs before enabling a recurring trigger.

All supplied automations contain `enabled: false`. To enable an event trigger, author a complete JSON definition with the exact managing chat:

```json
{
  "id": "research-new-question",
  "name": "New research question",
  "type": "event",
  "workflowId": "research-brief",
  "eventName": "research.question.received",
  "enabled": true,
  "ownerThread": "ACTUAL-CODEX-CHAT-UUID",
  "overlap": "queue"
}
```

```sh
herdr-codex desk automation-put --id research-demo --file /absolute/path/trigger.json
```

An authorized connector or explicit operator can then submit an event:

```json
{
  "id": "question-request-001",
  "eventName": "research.question.received",
  "payload": {
    "question": "What changed between the two supplied plans?",
    "sourceFiles": ["plan-before.md", "plan-after.md"]
  }
}
```

```sh
herdr-codex desk event --id research-demo --file /absolute/path/event.json
```

An event's stable ID identifies its delivery. Repeating that ID with the same contents does not create another job; changing its contents under the same ID fails. Trigger-run inputs are `{payload, trigger}`, unlike direct `desk run` inputs. Both are visible in agent context. Manual automations use `{"id":"request-001","automationId":"coding-on-request","payload":{...}}` instead of `eventName`, after explicitly enabling that automation with its owner chat.

For intervals, review `everySeconds`, optional timezone-qualified `startAt`, `catchup: latest` and overlap policy before enabling. Editing a file to disabled stops future dispatch from that trigger, not already accepted work. Trigger status reports queued/skipped occurrences, errors and watcher health. Keep triggers disabled if the task rules or source access are not yet reliable.

See [Desk framework](../../docs/general-desks.md) and [native recipe behavior](../../docs/recipes.md) for authority, snapshots and recovery details.
