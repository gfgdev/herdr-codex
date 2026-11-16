# Verification assessment

`src/verification-assessment.mjs` is a read-only, reusable service that assesses
one **already-owned** Desk command against a **caller-supplied trusted pre-run
revision baseline**. It is deliberately narrow: it certifies only that a single
frozen command finished, that the host observed a zero exit, and that the
selected project scopes still match the baseline. It is not a test runner, a
business-correctness oracle, or an acceptance mechanism.

## What a pass means

A `passed` verdict means exactly three things:

1. The frozen command's execution receipt exists and its identity matches the
   frozen worker, task, fingerprint, terminal and pid.
2. The receipt's exit is `code === 0 && !signal`, **and** the host explicitly
   observed a native exit code of `0`. A successful receipt with a missing or
   non-integer host exit is `uncertain`, never a pass.
3. The caller's `captureRevision` baseline still verifies byte-for-byte against
   the worker's registered project — no additions, deletions, content or
   executable-mode changes in the selected scopes — read **after** the single
   awaited observation.

A pass **does not** prove business correctness, that any assertion about the
work is true, or that no transient edit happened. Revision v1 hashes current
file bytes; a file edited and restored to its original bytes is invisible to it.
Snapshotting is best-effort and has no filesystem transaction.

## What the caller must supply

| Input | Meaning |
| --- | --- |
| `deskId` | Registered desk that owns the run. |
| `runId` | Frozen workflow run id. |
| `stepId` | Frozen command step within that run. |
| `workerId` | Frozen worker recorded on that step. |
| `ownerThread` | The **exact** manager chat UUID that owns the run/task. |
| `baseline` | A `captureRevision(project, { paths })` result taken **before** the command ran. |

The baseline-before-execution ordering is a **caller contract**. This service
has no temporal proof of when the baseline was captured and does not fabricate
one. Supplying an after-the-fact baseline silently invalidates the guarantee;
the service cannot detect it.

Command identity is taken from the frozen worker record plus the execution
receipt written by the command worker — never from caller prose. Ownership
(manager chat, worker/task binding, project) is validated with
`routing.assertWorkerTask` **before** any report, path or native evidence is
read.

## Dependency shape

```js
new VerificationAssessment({ store, config, rpc, runs = null })
```

- `store` — a real `Store` (used for worker/task lookup).
- `config` — the resolved integration config (used if `runs` is constructed).
- `rpc` — a client exposing `request(method, params)`; only
  `terminal.get` is ever issued.
- `runs` — optional pre-built `WorkflowRuns`; when omitted this module builds
  one from `{ store, config, rpc }`. Injection lets a caller share one instance
  and its retirement service.

## Observation ordering and stale authority

The single `terminal.get` observation is awaited, so it yields control. After
that await the service:

1. **Re-reads ownership** — the desk, run, step, worker, task and exact owning
   manager chat — and re-asserts the frozen run/step/worker binding. If a
   concurrent rebind changed the run owner, step worker, terminal, fingerprint or
   project, the verdict is `uncertain` (`ownership-changed`).
2. **Reads the revision last**, immediately before any pass decision. A process
   that mutates the project while the observation is in flight therefore cannot
   be certified against a baseline match captured before the await.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `passed` | Finished + zero exit + baseline still verifies. |
| `failed` | Receipt shows a nonzero exit or death by signal. |
| `pending` | The frozen worker's native process is still `live`. |
| `uncertain` | Missing/mismatched receipt, observation failure, exit disagreement, unknown native state, or revision drift/unverifiable manifest. |

`uncertain` is the default for every incomplete or contradictory observation:
a live worker is never a pass, a missing or mismatched receipt is never a pass,
a nonzero exit is never rescued by unchanged bytes, and a revision mismatch or
unverifiable baseline is never a pass.

## Result shape

`assess()` returns a frozen, bounded object:

```js
{
  version: 1,
  deskId, runId, stepId, workerId, taskId, chatId,
  command: { kind: 'command', fingerprint, argv, project },
  observation: { state, exitCode, error? } | null,
  execution: { exit: { code, signal }, success, receiptSha256 } | null,
  revision: {
    project, baselineSha256, actualSha256,
    match, consistent,
    changedPaths, changedPathsTruncated,
    error
  },
  verdict, reason,
  limits
}
```

`argv` and `changedPaths` are truncated to fixed limits
(`ASSESSMENT_LIMITS.maxArgv`, `.maxChangedPaths`); full command logs are never
loaded and worker-claimed arbitrary artifact paths are never dereferenced.

## What it never does

- No launch, signal, kill, poll or wait.
- No filesystem writes or Store mutations.
- No model call.
- No acceptance, acknowledgement, retirement or ownership release.
- No command timeout: the frozen worker has no timeout contract, so no timeout
  field is invented or reported.

## Reasons

`reason` is a stable machine token. Among them:

| Reason | Verdict |
| --- | --- |
| `declared-command-check-passed-and-baseline-unchanged` | `passed` |
| `command-exit-nonzero` | `failed` |
| `command-still-running` | `pending` |
| `execution-receipt-missing` / `execution-receipt-mismatch` | `uncertain` |
| `native-exit-unobserved` | `uncertain` |
| `exit-evidence-disagreement` | `uncertain` |
| `native-identity-changed` / `native-state-unknown` | `uncertain` |
| `native-observation-failed` / `worker-never-launched` | `uncertain` |
| `ownership-changed` | `uncertain` |
| `revision-drift` / `revision-unverifiable` / `revision-manifest-inconsistent` | `uncertain` |

## Behavior table

| Situation | Verdict |
| --- | --- |
| Finished, exit 0, baseline matches | `passed` |
| Finished, exit nonzero | `failed` |
| Native still `live` | `pending` |
| Receipt file absent | `uncertain` |
| Receipt identity/fingerprint/pid mismatch | `uncertain` |
| Receipt vs host exit disagreement | `uncertain` |
| Baseline drifted | `uncertain` |
| Baseline structurally unverifiable | `uncertain` |
| Receipt success but no/invalid host exit code | `uncertain` |
| Native observation throws | `uncertain` |
| Ownership or frozen binding changed during observation | `uncertain` |
| Native never launched | `uncertain` |
| Caller is not the exact owning chat / worker not bound to step | throws |

## Testing

`tests/verification-assessment.test.mjs` uses a real `Store`, real
`WorkflowRuns`, and a fake native RPC. It covers the happy path, nonzero exit
with unchanged bytes, live/pending, missing receipt, receipt mismatch, revision
drift and wrong-owner refusal. It also pins the two review regressions — a
project edited during the observation await, and a successful receipt with no
observed host exit — plus a concurrent run rebind during the await. It asserts
that exactly one native observation is issued.

```sh
node --test tests/verification-assessment.test.mjs
```
