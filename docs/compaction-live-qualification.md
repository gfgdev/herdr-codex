# Compaction live qualification (manual Goose → Pi slice)

This document records a **manager-observed** qualification of the bounded compaction
adapter against a genuine Goose recipe runner and a genuine `@earendil-works/pi-coding-agent`
`AgentSession`. It is evidence for one narrow slice: a **manually requested** compaction on a
**synthetic** session, its **persisted reopen**, and a **separately observed** fresh no-tools
Pi continuation.

## Packaging status — source-development evidence, not a shipped harness

This document ships as **documentation only**. It is the record of work done in the
**source-development checkout**. The raw evidence files
(`inputs/qualification/pi-append-reopen.json`, `inputs/qualification/pi-live-continuation.json`)
and the harnesses that produced them (`scripts/qualify-goose-pi.mjs`,
`scripts/qualification-tests/compaction-session.test.mjs`) are **not part of the distributed
plugin package**. The distributed artifact ships the dormant compaction *example assets*
under `examples/compaction/` and this document, but neither the recorded evidence files nor
these Goose/Pi harnesses. Treat the commands below as **reproduction notes for the
development checkout**; they are not runnable from an installed plugin and must not be
presented as shipping scripts. No claim is made that the absent files travel with the
package.

The raw evidence is **also excluded from the public source export** (see the export manifest
in the development checkout's `docs/public-source-export.md`): `inputs/` and the
private historical reports stay local and are never published to the repository. The
qualification harnesses *are* part of the public source, and they are portable — they read
`PI_CODING_AGENT_DIST` and `GOOSE_BIN` and contain no hard-coded machine paths.

The raw evidence lives under `inputs/qualification/` in the development checkout (**local
only — excluded from the public source export**):

| Artifact | SHA-256 | Proves |
| --- | --- | --- |
| `pi-append-reopen.json` | `a2ade645307aef9ed039fdf405310b458523d242870e19a1819ef8b16fa1ce7d` | Scripted Goose → Pi MANUAL compact, Pi append, persisted reopen |
| `pi-live-continuation.json` | `b2c6118e58373e4f24b9ded7ed434da3feab3a7a991eb04d6a9797fc4d67ab55` | Separately observed live, no-tools Pi continuation over the reopened context |

## What this is not

This proves a **synthetic MANUAL session only**. It does **not** prove, and must not be
cited as:

- **near-limit / automatic recovery** — the slice compacts a small hand-built history
  (`tokens_before: 8` in the recorded run), not a real context approaching the limit;
- **broad summary quality** — only the recorded synthetic turns are checked, not diverse
  or long histories;
- **usage savings** — token counts are reported, not compared against an uncompacted
  baseline;
- **production activation** — nothing here enables compaction in a real worker, changes
  routing, or changes the selected provider/model.

Provider/model and credentials are manager-supplied for the run and are not part of this
document. `PI_CODING_AGENT_DIST`/`GOOSE_BIN` values are machine paths, not configuration.

## Command: scripted Goose → Pi compact + persisted reopen

*(Development checkout only — this harness is not packaged; see the packaging status above.)*

The scripted proof is produced by `scripts/qualify-goose-pi.mjs`. It builds a real
`AgentSession` through the same fixture path as the boundary proof, injects the **real**
Goose recipe runner (`createGooseRecipeRunner` over the source-checkout path
`recipes/compaction/recipe.yaml`; the packaged copy of the same file is
`examples/compaction/recipe.yaml`), calls
`session.compact()`, then reopens the on-disk session JSONL with a fresh
`SessionManager.open(path)` and rebuilds context.

```sh
PI_CODING_AGENT_DIST="/absolute/path/to/@earendil-works/pi-coding-agent/dist/index.js" \
GOOSE_BIN="/absolute/path/to/goose" \
node scripts/qualify-goose-pi.mjs --out /absolute/evidence/pi-append-reopen.json
```

- `PI_CODING_AGENT_DIST` overrides the installed Pi SDK entrypoint. The checkout has no
  local `node_modules`, so the SDK is imported by absolute path; the override selects a
  different installation (for example, another Pi dist) without editing source.
- `GOOSE_BIN` selects the Goose executable; the manager supplies the Goose profile via the
  process environment.
- `--out` (or `GOOSE_PI_QUALIFY_OUT`) writes the JSON report; the script exits non-zero
  unless Pi appended a `compaction` entry and the reopened context carries a non-empty
  summary.

### Recorded observations (`pi-append-reopen.json`)

- Runner `goose-recipe-runner`; exit confirmed for the runner (`goose_runner_exit_confirmed: true`).
- Append: `entries_before: 19` → `entries_after: 20`, `appended_types: ["compaction"]`.
- Compaction entry: `from_hook: true`, `first_kept_entry_id: "081d91d0"`, `tokens_before: 8`,
  `summary_sha256: 79d105e1…f643a`.
- Candidate/commit correlation: `candidate_ready: true` and `commit_confirmed: true` share
  the same `operation_id` (`cmp1:2604beb2…f106`); `last_committed: true`.
- **Persisted reopen** (fresh `SessionManager.open`): context messages `18 → 4`,
  `has_summary: true`, `summary_matches_compaction: true`, `dropped_old_goal: true`, and the
  recent kept turns are retained.
- Labels in the artifact: `reopened_context: "REAL (exercised)"`,
  `live_continuation_response: "NOT exercised: no live model continuation was requested"`.

## Separately observed: fresh no-tools Pi continuation

After the scripted run, a **live** Pi continuation was observed over the reopened session —
a separate step, not part of `qualify-goose-pi.mjs`, and recorded independently as
`pi-live-continuation.json`. It is a fresh, no-tools (`tools_enabled: []`) continuation,
with the real provider/model reported by the harness.

Do not assert that the two artifacts carry the same `session_identity` value — they do not:

- `pi-append-reopen.json` reports the **adapter-configured** identity
  `session_identity: "sess:goose-pi:0001"` (the script's fallback label when Pi does not
  supply its own).
- `pi-live-continuation.json` reports Pi's **actual** session UUID
  `session_identity: "01a1e0a9-2efc-749e-b2e9-75d82fd57ad4"`, which is also the `session:`
  line embedded in the compacted summary.

Both refer to the same synthetic Pi session, but the recorded field values differ: one is a
configured label, the other the real session UUID. Cite the continuation proof by its own
recorded field, not by equality with the scripted artifact.

### Recorded observations (`pi-live-continuation.json`)

- `live_continuation: true`, `timedOut: false`, `stop_reason: "stop"`, `error: null`.
- Model/provider: `deepseek-ai/DeepSeek-V4.1-Flash` / `modal` (environment-specific).
- Session grew `entries_before: 20` → `entries_after: 23` for the continuation turns.
- Usage reported: input `1251`, output `136`, total `1387` (reported, not a savings claim).
- The continuation text restates the summary's goal, the newer local-files-only scope, the
  pending/ unrun tests, and that no manager acceptance was given — i.e. it consumed the
  compacted summary as context.

## Relationship of the two proofs

Keep the two apart when citing this slice:

1. **Scripted reopen proof** (`pi-append-reopen.json`): produces the append/reopen result
   through a reproducible procedure (`scripts/qualify-goose-pi.mjs`) with the real Goose
   runner, but its **output is model-dependent** — the runner calls a model, so reruns need
   not be byte-identical. Only the in-process **stub** SDK boundary tests are deterministic;
   no deterministic claim is made for this live-Goose artifact. The live continuation was
   explicitly **not** exercised here.
2. **Live continuation observation** (`pi-live-continuation.json`): a separately observed,
   environment-specific model response; it demonstrates the reopened summary is usable as
   context, but it is not a reproducible test and not a quality benchmark.

## Related opt-in test

`scripts/qualification-tests/compaction-session.test.mjs` is the machine-specific SDK boundary
test **in the development checkout** (it is not part of the distributed package). It drives a
real `AgentSession` through the adapter and requires the installed SDK
(`PI_CODING_AGENT_DIST` to relocate it). It lives outside `tests/` so the default
`npm test` (`node --test tests/*.test.mjs`) does not run it; run it explicitly:

```sh
PI_CODING_AGENT_DIST="/absolute/path/to/.../dist/index.js" \
node --test scripts/qualification-tests/compaction-session.test.mjs
```
