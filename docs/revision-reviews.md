# Revision-bound reviews and acceptance (v1)

`src/revision-reviews.mjs` provides the review/acceptance layer on top of the
content-revision primitives in `src/evidence.mjs` and the durable `Store`. It
answers a narrow question: *was the exact content I reviewed the content that is
being accepted, for the exact worker, task, chat, launch and activation that
produced this result, and can I replay that decision after a restart?*

It does **not** schedule, launch, acknowledge or retire workers, and it reads no
logs, mailbox bodies, secrets or worker-supplied paths. It is suitable for later
CLI/MCP/`complete_agent` wiring; the `capture_review`, read-only `verify_review`
and revision-bound `resolve_message` accept agent tools below are the first,
deliberately narrow wiring.

## Agent tool integration

`capture_review(thread_id, result_id, paths, request_id)` in `src/agent-tools.mjs`
is a thin wrapper over `captureReview`. It enforces exact chat/host ownership of
the result **before** any dependency read or write, then returns only a compact
receipt (`review_id`, `result_id`, `thread_id`, `task_id`, `worker_id`,
`terminal_id`, `project`, `revision_sha256`, `provenance`, `scopes`, `files`,
`bytes`, `captured_at`, `verified: false`) and never the per-file manifest or raw
report text. The same `request_id` replays the identical capture; conflicting
arguments are refused.

abort a report and acknowledge it. For an accept, `resolve_message` also accepts
optional paired binding fields `review_id` + `expected_revision` (with an
explicit stable `request_id`): when supplied, the exact chat/host ownership gate
still runs first, then the request is validated (pairing, `action:accept` only,
explicit `request_id`) **before any effect** and the bound acceptance is routed
straight through `acceptReview` — never the unbound callback/CLI — then
acknowledged once through `Store.ack`. The acceptance is immutable and exact
replays are historical only (they never claim current verification: call
`verify_review` to observe later drift); a wrong review, wrong digest, conflicting
request, different text or a legacy unbound acceptance is refused with no extra
effect and no silent upgrade. A legacy call without binding fields keeps its
original behaviour and is never silently upgraded. The receipt stays compact:
the ordinary action/acknowledgement facts plus `review` binding facts
(`review_id`, `revision_sha256`, `task_id`, `worker_id`, `provenance`,
`captured_at`) and `replay`/`verified` flags — never the manifest or report text.

`verify_review(thread_id, result_id, review_id?)` is a thin, **read-only**
wrapper over `verifyAcceptedRevision` (`readOnlyHint: true`). It enforces the
same exact chat/host ownership **before** the read-only revision service is
consulted, so an unknown and a foreign result ID are indistinguishable and read
or write nothing. It returns compact explicit flags — `accepted`, `bound`,
`verified`, `stale` — plus a `reason`, the stable IDs, expected/actual revision
digests and bounded changed-path `count`/`preview`/`truncated`, and never the
manifest, per-file report or raw service object. A legacy unbound acceptance
reports `accepted:true, bound:false, verified:null`; no acceptance reports
`accepted:false`; a fresh bound acceptance reports `verified:true`; editing a
reviewed file reports `stale:true` while the historical `accepted` stays `true`.
A historical acceptance is never reported as current completion, and a review
ID mismatch, missing review record or binding drift stays conservative. It never
accepts, acknowledges, closes or signals a worker; `resolve_message` is the only
entry point that may record and acknowledge a revision-bound acceptance, and it
does so through `acceptReview` exactly as above.

## Exports

```js
import { RevisionReviews, createRevisionReviews, REVIEW_LIMITS } from './revision-reviews.mjs';

const reviews = new RevisionReviews(store);        // or createRevisionReviews(store)

reviews.captureReview({ threadId, resultId, paths, requestId });
reviews.acceptReview({ threadId, resultId, reviewId, expectedRevision, requestId, text });
reviews.verifyAcceptedRevision({ threadId, resultId, reviewId? });
```

`threadId` must be the exact manager chat UUID. `resultId` must be an existing
`result` message. `requestId` is a caller-chosen idempotency key of 1–200
characters matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`.

## `captureReview`

Captures a deterministic, immutable, versioned review of an explicit bounded
scope set and returns the stored review record.

```js
const record = reviews.captureReview({
  threadId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  resultId: 'result-1',
  paths: ['src/revision-reviews.mjs', 'tests'],
  requestId: 'review-2024-06-01-1',
});
// {
//   version: 1, type: 'revision-review', reviewId: 'rv-…',
//   threadId, resultId, requestId, taskId, workerId, project, terminalId,
//   launch: { pid, created_ms, launchState },
//   activation: { id, at, pid, baselineTurn } | null,
//   provenance: 'current' | 'unknown' (a 'stale' result is refused),
//   reportFingerprint: '…', scopes: [...],
//   revision: { /* evidence.mjs revision v1 */ }, revisionSha256: '…',
//   capturedAt: '…'
// }
```

Binding rules:

- The project is **always** the registered worker's project, canonicalized by
  `captureRevision` (`realpath`). A caller-supplied project/root is not part of
  the API and is never trusted.
- The result must be a `result` message whose registered worker/task/chat match,
  whose terminal matches the worker, and which is the **latest** result from
  that worker. A Desk runtime incident (no worker) and non-result messages are
  rejected.
- The record stores the launch identity (`launchResult.pid`,
  `launchIdentity.created_ms`) and the **complete** activation identity
  (`meta['activation:'+workerId]` = `{ id, at, pid, baselineTurn }`) actually
  present in the `Store`. No launch/activation/generation marker is invented.
- `reportFingerprint` binds the **full** report payload with an order-stable
  canonical encoding (`canonicalValue`/`canonicalJson`): id, task, worker,
  terminal, kind, text, idempotency key, `turn`, `createdAt` and the canonical
  raw `evidence` object when present. Unlike the legacy `Store` plaintext
  formula it does not reduce the report to seven fields, and it never
  dereferences references (unresolved values are encoded as-is/`null`). A result
  whose evidence, turn or creation time changed cannot keep a review. When
  present, `evidence` is inert worker-claims evidence v1 validated by the Store
  (unknown fields, including a self-declared verification authority, are
  rejected); the binding never treats it as proof of anything.
- `reviewId` is `rv-` plus the first 48 hex characters of a digest over the
  binding (version, chat, result, task, worker, project, terminal,
  report fingerprint, **full activation identity**, launch pid/creation,
  scopes, revision hash). The same inputs therefore replay to the same
  `reviewId`.

Provenance is explicit and never inferred from trust:

- `resultProvenance` compares the result's own `createdAt`/`turn` (worker
  **claims**, not runtime proof) against the activation's `at`/`baselineTurn`
  and classifies the result as `current`, `unknown` or `stale`.
- A result demonstrably older than the current activation is **`stale`**;
  `captureReview` refuses it before writing any review, request or journal row.
- `current` records `provenance: 'current'`; when the result has no comparable
  timestamp/turn the record is still captured but marked
  `provenance: 'unknown'`, so unknown provenance stays visible instead of being
  silently trusted.

Idempotency and integrity:

- A repeated `requestId` with identical arguments returns the same stored
  record byte-for-byte. The request ledger is **namespaced by exact
  chat + result + requestId**
  (`revision-review-request:<threadId>:<resultId>:<requestId>`), so two
  workers/chats that happen to choose the same `requestId` do not collide,
  while changed arguments in the same scope still conflict and throw. It never
  overwrites the first review. Review and acceptance records are
  content-addressed by `reviewId` (which already embeds the chat), so they live
  under global `revision-review:<reviewId>` / `revision-accept:<reviewId>` keys
  without cross-chat aliasing.
- The record is immutable: if a record already exists for the computed
  `reviewId`, it is returned unchanged (and a differing revision under the same
  id is refused).
- Scopes are validated by `evidence.mjs`: nonempty, bounded, project-relative,
  unique, no absolute/`.`/`..`/empty segments, no symlink escape. Within
  `worker.project` only those scopes are read.

## `acceptReview`

Freshly verifies the reviewed revision and, only then, records a
revision-bound acceptance action atomically.

```js
const outcome = reviews.acceptReview({
  threadId, resultId: 'result-1',
  reviewId: record.reviewId,
  expectedRevision: record.revisionSha256,
  requestId: 'accept-2024-06-01-1',
  text: 'Reviewed the selected files and accepted this result.',
});
// { accepted: true, bound: true, replay: false, reviewId, resultId, threadId,
//   taskId, workerId, expectedRevision, revisionSha256, revision, verification, action }
```

Ordering and refusal:

1. Validate arguments and `expectedRevision` (`^[0-9a-f]{64}$`).
2. If an action is already recorded on the result, resolve it as an exact
   replay or a conflict. A **legacy unbound acceptance** (recorded before this
   module, with no `review` binding) is refused and is never silently upgraded
   to a revision-bound acceptance.
3. Load the stored review and check chat, result and `expectedRevision`.
4. Re-resolve the registered binding and refuse if the result, task, worker,
   project, terminal, launch pid/creation, **full activation identity** or
   report fingerprint drifted (for example a new activation with the same id
   but different `at`/`pid`/`baselineTurn`, a result that now predates the
   activation, or a replaced native process).
5. Re-run `verifyRevision` against the actual files, including added, deleted
   and chmod'd members. A changed revision throws **before any action,
   acknowledgement or mailbox mutation**.
6. Only inside a single `Store.transaction` write the `accept` action (with the
   review binding) and the `revision-accept:` ledger. Nested `recordAction`
   conflicts roll the whole transaction back, so a failure never leaves a
   partial acceptance.

Idempotency and conflicts:

- An exact retry (same result, review, revision, request and text) returns
  `replay: true` with the recorded binding and records no second acceptance.
- A different `requestId`, text, review or revision for an already-accepted
  result is a conflict and throws.
- The action never acknowledges, retires or closes the worker; it records only
  the acceptance decision.

## `verifyAcceptedRevision`

Reports recorded acceptance and current-content match as **separate** facts, so
accepted history is never mistaken for current completion.

```js
const v = reviews.verifyAcceptedRevision({ threadId, resultId: 'result-1' });
// Revision-bound acceptance, still matching:
// { accepted: true, bound: true, verified: true, stale: false,
//   reviewId, taskId, workerId, expectedSha256, actualSha256,
//   changedPaths: [], revisionConsistent: true, scopes }
//
// Accepted earlier, content changed since:
// { accepted: true, bound: true, verified: false, stale: true,
//   changedPaths: ['src/a.mjs'], expectedSha256, actualSha256, ... }
```

Other outcomes:

- No acceptance: `{ accepted: false, bound: false, verified: null, reason: 'no-acceptance' }`.
- Legacy unbound acceptance: `{ accepted: true, bound: false, verified: null, reason: 'legacy-unbound-acceptance' }`.
- Review id mismatch: `reason: 'review-id-mismatch'`.
- Missing review record: `reason: 'review-record-missing'`.
- Binding changed since acceptance: `reason: 'binding-changed'`, `changed: [...]`.
- Result not in the chat: `reason: 'result-does-not-belong-to-chat'`.

After a subsequent edit the result is reported stale, never as a fresh
completion.

## Limits

`REVIEW_LIMITS`:

| Limit | Value |
| --- | --- |
| scopes per review | 4096 (from `evidence.LIMITS.maxFiles`) |
| request id length | 200 |
| acceptance text size | 65536 UTF-8 bytes |
| serialized review record | 4 MiB |

Per-file sizes, directory depth, total bytes and path length follow
`evidence.LIMITS`. The review record stores only paths, modes, sizes and
hashes — never file contents, logs or secrets. `captureReview` holds a single
`Store` write transaction across hashing so the request ledger and the review
record are consistent; scope the selected paths to keep that window short.

## Snapshot race limits

There is no filesystem transaction. `captureReview` observes a moment in time
and `acceptReview`/`verifyAcceptedRevision` re-observe later; a concurrent writer
can change bytes, modes or directory membership between the individual
`lstat`/`open`/`read` calls that `evidence.mjs` performs. Verification narrows
the window by re-checking identity and high-resolution timestamps and by
diffing a fresh capture, but this is best effort. A writer that mutates and
restores a file (including timestamps) between the read and the comparison can
still evade detection, and coarse-timestamp filesystems widen the window.

Treat `verified: true` as "the selected scopes were consistent at this
observation", not as proof that nothing else changed. An eventual completion
decision must call `verifyAcceptedRevision` at that time; a historical
acceptance is not current-completion proof.
