# Native Goose recipes in a Desk

A recipe is a reusable **native Goose configuration**, distinct from a Desk workflow. A workflow assigns roles and coordinates steps. A Goose recipe configures one Goose run, including its own instructions, prompt, parameters, extensions, structured response, retries and subrecipes.

Author a recipe at `Desk/recipes/<id>/recipe.yaml`. Put its local companions underneath the same directory. Native fields, including fields introduced by future Goose releases, remain in the authored source; the integration does not translate them into a smaller recipe schema. Goose remains the authority on its recipe syntax.

```yaml
title: Evidence review
description: Review a task's evidence and save supported findings
instructions: Distinguish checked facts from assumptions. Preserve unrelated files.
prompt: Review the assigned work for {{ focus }} and report evidence.
parameters:
  - key: focus
    input_type: string
    requirement: optional
    default: correctness
    description: Review focus
extensions:
  - type: builtin
    name: developer
```

The installed Goose 1.57.0 CLI supports recipes through `goose run --recipe`, with `--params KEY=VALUE`. Although its help lists `--system`, Goose 1.57.0 rejects combining that flag with `--recipe`; `session` also does not accept a recipe. The integration therefore adds manager/supervisor instructions and assigned context to a protected execution-recipe overlay, while retaining the original source snapshot and recording the effective overlay hash. Authored YAML fields are preserved; inherited templates that cannot be parsed as YAML use the selected native renderer before the overlay is built. The integration therefore performs a genuine headless recipe run, rather than sending a recipe description to an ordinary interactive session. The run's output appears in its native Herdr terminal. A follow-up after it exits requires an explicitly assigned new run; it is not an interactive continuation.

## Authored source and frozen versions

`RecipeLibrary.put(deskId, {id, content, files?})` writes `recipe.yaml` and optional companions (`files` is an array of `{path,content}`). It preserves unspecified companions. You can also edit the authored files directly. `list`, `get` and `snapshot` import current authored content; `get` and `snapshot` accept a version to retrieve an immutable historical version.

Each snapshot contains the recipe ID, library version, entry path, a hash for every text file, the combined bundle hash, and native parameter definitions when directly inspectable. The library version is separate from the recipe's own `version` field. Changes to a companion create a new version too. Jobs pin snapshots, so editing the Desk's recipe cannot silently change an already assigned run.

Local `sub_recipes[].path` references, including transitive subrecipes, must stay inside the bundle. Relative paths and Goose's `{{ recipe_dir }}/...` form work. Companion files and literal template references are included. Symlinks, absolute/outside references, missing dependencies, cycles and ambiguous case/Unicode paths are rejected. Dynamic subrecipe paths cannot be frozen; use an explicit bundle-relative path. Bundles currently contain UTF-8 text, at most 1,000 files and 8 MiB; this is a snapshot storage limit, not an inference budget.

`validateNative(snapshot)` invokes the selected Goose binary's `recipe validate` against an isolated temporary copy with no model credentials. It returns the binary hash and actual validation exit/output for each known subrecipe. This is syntax/configuration validation, not evidence that a recipe completes its task. Execution also uses Goose's native `--render-recipe` before any credential is loaded, then checks the rendered configuration against the worker's selected model and resource policy.

## Running and inspecting a recipe

A delegated Goose worker carries `recipe` (the pinned snapshot) and `recipeParameters` (an object of scalar values). `prepareWorker` materializes immutable source files outside the agent's writable runtime. It does not execute Goose or read the model credential. The terminal initially waits at a software assignment gate. The manager releases that gate only after persisting and checking the actual terminal binding; the full task/context payload becomes additional recipe instructions in the protected overlay, with template-looking manager text preserved literally. Repeated release with the same payload is idempotent, and a different payload is rejected.

Execution preserves the configured Modal endpoint and selected model. Recipes may omit model settings or repeat the selected `openai` provider/model; incompatible settings and direct configuration/resource overrides are rejected. Recipe parameters do not grant additional file access. File parameters must belong to the worker's assigned resources. Native tools, extensions and retry commands run under the same macOS filesystem policy as other Goose work. The native Herdr operator API remains trusted authority; this is not a hostile-agent isolation boundary.

The launcher adds no turn, request or wall-clock inference cutoff. A recipe's own native retry/turn settings retain their authored meaning. Native rendering has a startup deadline, independent of model work.

New workers advertise `executionReceiptVersion: 1`. On termination the launcher writes the parent-owned `execution/recipe-result.json` (already-created older workers retain their legacy runtime receipt path) with the actual numeric exit or signal, source/parameter/assignment hashes, start/end times, and hashes and byte counts for the complete native stdout/stderr streams. Each protected log retains at most 1 MiB; receipts report retained bytes and truncation explicitly. Native terminal output remains untruncated. Log handles are created exclusively, without following symlinks, before starting the child. It also sends idempotent informational progress metadata through the existing bridge; this does not create a second review or require an acknowledgment. When the native process has actually finished, the workflow engine supplies one actionable evidence report only if the recipe did not send a substantive result itself. Delivery failure leaves the receipt and logs available for recovery. A zero exit, a model's success claim, and a terminal ending are **not acceptance**; the manager or authorized supervisor must inspect the actual output and evidence.

A recipe can use the normal `herdr-message` helper. If a business decision is required, it reports the question and ends; it must not wait for interactive input. Explicitly authorized supervisors also receive `herdr-supervise` and their scoped grant. Recipes do not implicitly receive supervisor authority.

References: [Goose recipe reference](https://goose-docs.ai/docs/guides/recipes/recipe-reference/), [tagged recipe implementation](https://github.com/aaif-goose/goose/blob/v1.57.0/crates/goose/src/recipe/mod.rs), and installed `goose run --help`, `goose session --help`, `goose recipe validate --help`.
