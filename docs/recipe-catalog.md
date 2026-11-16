# Recipe catalog

Herdr–Codex ships **examples**, not preconfigured operations. Nothing in this catalog
runs on install: no worker, recipe, trigger or model call is started by copying the
package. Each starter is Markdown/YAML/JSON you edit to fit your task, and every
supplied automation is `enabled: false`.

All commands below use your installed `herdr-codex` launcher or configured wrapper and
your real absolute paths. `ACTUAL-CODEX-CHAT-UUID` means the exact UUID of the existing
Codex chat that will own the work.

## Desk recipe starters

The [portable Desk starters](../examples/desks/README.md) provide three optional
workflows. Each registers the project ID `working`, uses prefixed role/team/recipe IDs so
it does not replace shared defaults, and keeps a continuing lead agent plus short-lived
recipe processes.

| Starter | Workflow ID | Team | Native recipe | Automation (disabled) |
| --- | --- | --- | --- | --- |
| [coding](../examples/desks/coding/workflows/coding-change/WORKFLOW.md) | `coding-change` | `coding-team` | [coding-review](../examples/desks/coding/recipes/coding-review/recipe.yaml) | `coding-on-request` (`type: manual`) |
| [research](../examples/desks/research/workflows/research-brief/WORKFLOW.md) | `research-brief` | `research-team` | [research-brief](../examples/desks/research/recipes/research-brief/recipe.yaml) | `research-new-question` (`type: event`) |
| [operations](../examples/desks/operations/workflows/operations-batch/WORKFLOW.md) | `operations-batch` | `operations-team` | [operations-review](../examples/desks/operations/recipes/operations-review/recipe.yaml) | `operations-daily` (`type: interval`) |

- **coding** — Goose lead → Pi implementer → native Goose review recipe. The implementer
  edits the registered `working` checkout; the reviewer writes only its own task outputs.
  Register a disposable or explicitly authorized checkout as `working`.
- **research** — Goose lead → native Goose sourced-brief recipe → Goose review. Writes task
  outputs only; source documents stay unchanged.
- **operations** — Goose lead → deterministic file inventory → Pi record processing → native
  Goose validation recipe. Produces proposed task artifacts only; originals and external
  systems stay unchanged. No email or spreadsheet connector is implied.

Recipe runs are finite native Goose processes. They report evidence to the lead and do not
replace its continuing conversation; Codex keeps business decisions, scope changes and
final review.

## Dormant opt-in compaction example

The bounded-compaction example is **documentation only** and is **not wired in or
activated**. It contains a native Goose recipe, a summary-candidate schema, a small
parameter encoder and the integration contract.

| Asset | Path | Status |
| --- | --- | --- |
| Recipe | [../recipes/compaction/recipe.yaml](../recipes/compaction/recipe.yaml) | Dormant example |
| Schema | [../recipes/compaction/schema/summary-candidate.schema.json](../recipes/compaction/schema/summary-candidate.schema.json) | Structural only |
| Integration contract | [../recipes/compaction/integration-contract.md](../recipes/compaction/integration-contract.md) | Dormant |
| Live qualification | [compaction-live-qualification.md](compaction-live-qualification.md) | Narrow synthetic manual slice |

The links above resolve inside the tree you are reading. The source checkout keeps these
assets under `recipes/compaction/`; the packaging builder copies them to
`examples/compaction/` and rewrites these links to match, so the installed plugin links its
own copies instead of a source-only path. Neither layout is wired into a running desk.

**Qualification status.** A narrow synthetic manual Goose → Pi append/reopen and no-tools
continuation were observed once. Automatic/near-limit recovery, summary quality and usage
savings remain **unqualified**, and the adapter modules stay dormant. Never describe this
example as production compaction.

## Inspect and validate without running model work

```sh
herdr-codex desk recipes --id DESK-ID
herdr-codex desk recipe-validate --id DESK-ID --recipe RESEARCH-RECIPE
herdr-codex desk trigger-status --id DESK-ID
```

Native syntax validation is not proof of task quality. Run one small, representative task
and inspect actual terminal text and produced files before enabling any recurring trigger.

## How to install a starter

```sh
node /absolute/path/to/herdr-codex/examples/desks/install.mjs --kit research --desk-root /absolute/path/to/knowledge-folder/Desk
herdr-codex desk validate --id DESK-ID
herdr-codex desk sync --id DESK-ID
herdr-codex desk open --id DESK-ID
```

The installer rejects a conflicting existing file before copying anything and never
overwrites `DESK.md`, `AGENTS.md` or `desk.yaml`. See the
[starter README](../examples/desks/README.md) for full creation, project-registration and
trigger examples.

## One shared Desk space

Use the desk's **one shared Desk space** for related work: `desk open` and `show` target
the same space so the desk's agents and files stay together, rather than creating a space
per agent or per view. A shared space does not imply shared write ownership — keep one
writer per coding checkout and give independent jobs their own workspaces.
