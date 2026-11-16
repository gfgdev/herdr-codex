# Worker-evidence transport (v1)

`src/evidence.mjs` defines the standalone evidence contract (see
[`evidence.md`](./evidence.md)); `src/evidence-transport.mjs` wires that
contract into worker messages. Text-only reports are unchanged and carry no
evidence fields.

## Sending

`message-cli.mjs` accepts `--evidence-file PATH` alongside `--text` and
`--file`:

```sh
HERDR_CODEX_WORKER_CONFIG=/absolute/worker.json HC_TERMINAL_ID=t7 \
  node src/message-cli.mjs --kind result --text 'Report' \
  --evidence-file /absolute/report.json --idempotency-key result-1
```

In an installed plugin the same script ships at `runtime/src/message-cli.mjs`
(reached through the packaged launcher); the bare `src/message-cli.mjs` form above
is the source-checkout layout only.

The file is parsed and validated **before any durable write**: ahead of the
outbox receipt, at the mailbox compare-and-swap, and inside the durable
`Store.ingest`. Unknown fields, a wrong version, an over-limit payload, or an
evidence `worker_id`/`task_id` that does not match the actual sending worker and
task all fail loudly and write nothing — never a partial or hidden message.

## Claims, not proof

The raw evidence object is preserved exactly as claimed. The validator's
normalized `authority: 'worker-claims'` tag is used only for validation and
binding and is **never persisted**, so it cannot be mistaken for a
worker-provided trusted assertion. `session_generation_id` is an explicit
**unverified worker claim**; the transport never fabricates verification.
Runtime proof is established only by re-running or re-observing the referenced
work — the transport does not do that, and it never executes `tests.argv` or
dereferences `changed_paths`, `artifacts`, `output_path`, `cwd` or revision
references.

## Idempotency

Stable idempotency includes evidence and is canonicalized so object key order
never changes identity:

- Same report ID with the same evidence (any key order) is a replay and keeps
  the original receipt recorded by the outbox.
- The same ID with different evidence is a conflict, rejected by the outbox
  semantic comparison, the mailbox compare-and-swap
  (`MAILBOX_ID_CONFLICT`) and the `Store` fingerprint — even after the mailbox
  is pruned and re-ingested durably.
- Evidence-absent messages and their historical fingerprints are unchanged, so
  upgrading does not silently rewrite old records.

## Reading

`read_agent` and `receive_notification` return bounded worker-claim metadata
with a separate `evidence_authority: 'worker-claims'` label: session and
revision identity, a canonical digest and byte size, and count/clipping-limited
references — never the raw claim arrays, and nothing is dereferenced. The exact
raw evidence object is returned only on explicit opt-in (`read_agent`
`include_reports: true`, or `receive_notification` `legacy: true`). A packet
detail page carries bounded snapshot text and refs, not the full raw claim. An
evidence-absent message exposes `null`/`null`.

## Wire limits

Two budgets apply:

- **Text:** a message `text` is limited to `MAX_TEXT_BYTES` = **65536 UTF-8
  bytes**. The limit is measured in bytes, not code units, and is enforced
  identically at three layers — in `message-cli.mjs` *before* any outbox
  receipt or native write, at the mailbox append boundary
  (`MAILBOX_TOO_LARGE`), and in `Store.ingest` — so an oversized report is
  never reported as recorded.
- **Evidence:** the serialized evidence object is bounded by
  `LIMITS.maxEvidenceBytes` (**1 MiB**) and is never truncated. A whole message
  envelope that would exceed the mailbox document budget
  (`MAILBOX_DOC_LIMIT`) fails explicitly rather than being truncated.

A message is either written whole or not at all.

## Reject recovery and quarantine

Reads are deliberately decoupled from admission: `readMailbox` validates only
*structure*, so a legacy oversized entry or one with invalid evidence stays
readable and prunable and never hides the valid reports that follow it. Strict
admission is applied only to new writes.

When `Bridge.syncWorker` reads a structurally-readable entry that the durable
`Store` rejects for a **deterministic** reason (`REPORT_INVALID` or
`REPORT_CONFLICT`), it archives the exact bounded bytes to the `quarantine`
table *before* the mailbox copy may be pruned, then raises one bounded manager
incident (`attention.reason: 'rejected_report'`). Quarantine is idempotent by
worker + report id + payload hash + reason, so a replay after a crash never
duplicates; the same report id with different bytes is retained as a distinct
entry. The incident text describes the archive as pending mailbox cleanup and
the actual prune result is recorded separately as a `message.pruned` journal
entry.

Failures never cause silent loss:

- A **transient** fault (SQLite busy, I/O, unknown error) throws without a
  `REPORT_*` classification; the mailbox copy is retained and a later sync
  retries it.
- If the **archive** or **incident** commit fails, the mailbox copy is retained
  (`message.quarantine-deferred` / `message.incident-deferred`) and retried.
- Routing/identity mismatches (`REPORT_ROUTE` / `REPORT_INACTIVE`) are archived
  for audit but left in the mailbox for the rightful owner; logging is
  deduplicated by payload.

Malformed envelopes and unknown database exceptions are never broadly pruned.

The archive row and its `message.quarantined` journal entry commit in one
`Store` transaction, so a journal failure rolls the row back and the mailbox
copy is retained for a clean retry rather than a half-recorded archive.

## Reading quarantined reports (`quarantine` CLI)

Archived reports are unverified worker claims (authority `worker-claims`); they
are evidence to inspect, never permission to execute. The read surface is
read-only and bounded:

- `quarantine list --thread UUID [--task ID] [--worker ID]` — metadata only
  (`id`, `reportId`, `taskId`, `workerId`, `code`, `reason`, `sha256`, `bytes`,
  `at`). The raw report is never returned by `list`.
- `quarantine show --id ARCHIVE_ID --thread UUID` — the bounded raw report that
  was archived, exactly as the worker sent it.

Ownership is enforced with an **exact manager chat UUID** check: an entry is
visible only when the task that owns it has `threadId === --thread`. `--task`
and `--worker` only narrow the selection within that chat; they can never widen
it. A missing or malformed `--thread`, or an entry owned by a different chat,
returns a non-zero exit and no payload. Every response echoes
`authority: "worker-claims"` and a note reminding the reader that the report is
unverified.
