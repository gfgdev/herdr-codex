# Durable review packets (v1)

`src/review-packets.mjs` captures a bounded, durable *review packet* for one
notification-handling operation and returns it in a compact form. It is built on
the real `Store` (`src/store.mjs`) and the real `Notifications` service
(`src/notifications.mjs`), which it imports and reuses — it does not copy the
notification inbox logic and never edits `src/notifications.mjs`.

A review packet answers one narrow question:

> *Which reports did the manager actually receive while handling this
> notification, and what did each of them claim, bound to a stable batch I can
> replay and re-read later?*

A packet is **evidence only**. It records that the manager marked manager
receipt of a notification, but it never acknowledges, accepts, replies to,
retires, closes, or signals a worker, and it never inspects a terminal, log, or
referenced path. The MCP tools (`receive_notification`, `read_review_packet`)
expose this library over the public subagent interface; the library itself
remains the single writer of packet records.

## Public tool interface (MCP)

`src/agent-tools.mjs` owns the compact review interface. It constructs one
`ReviewPackets` service bound to the same `Store` and transaction connection as
the `Notifications` service it receives, so `capture` and manager receipt commit
in one transaction. Two tools expose the packet:

- `receive_notification({ notification_id, batch_id?, legacy? })` — captures the
  packet (deriving `batch_id` deterministically from the chat and notification
  when omitted) and returns a compact summary of `read(...)` plus the capture
  outcome: `batch_id`, `replayed`, `actionable`/`already_received`,
  `captured_actionable`, `current_actionable`, `current_pending`,
  `current_handled`, `count`, `report_ids`, `task_ids`, `worker_ids`,
  `id_envelope`, `provenance` and a `members` list with per-report `current`
  state plus bounded worker-claim metadata (`evidence` + `evidence_authority`:
  session/revision identity, canonical digest and byte size, and count/clipped
  references — never the raw claim arrays). The capture consumes only the exact
  reports this notification currently owns (`notification.members`,
  re-evaluated against the live pending/host-eligible inbox); unrelated pending
  reports in the same chat are left untouched for their own notification. It
  never returns report prose and forces `can_acknowledge`, `can_accept`,
  `can_signal` to `false`. Reusing the same `batch_id` replays the original
  packet (`replayed: true`, `actionable: false`) without re-receiving, restarting,
  acking or reassigning. `legacy: true` restores the previous full pending-message
  list, including the raw claim projection, for compatibility.
- `read_review_packet({ batch_id, include_detail?, cursor?, limit?, max_bytes? })`
  — without `include_detail` returns the compact membership summary (every report
  ID preserved); with it returns one bounded `page(...)` of untrusted detail.
  `cursor`, `limit` and `max_bytes` are also what force detail mode. Cursors are
  bound to the exact chat and `batch_id` and are refused across either.

Related read paths use the same bounded style: `read_agent` returns report
metadata previews and bounded claim refs by default (`include_reports: true` for
full text and the raw claim, `include_messages: false` for terminal-only), and
`resolve_message` returns a short receipt separating inbound report delivery
(`report_delivery`) from the reply action's native delivery (`reply_delivery`)
instead of echoing report or reply text.

The library records the claims; the tools present them. Neither verifies a
terminal, so `provenance.terminal_verified` stays `false` and acceptance remains
a human/manager decision.

## Exports

```js
import { ReviewPackets, REVIEW_PACKET_LIMITS, REVIEW_PACKET_VERSION, REVIEW_PACKET_PROVENANCE } from './review-packets.mjs';

const packets = new ReviewPackets({ store, config, notifications });

packets.capture({ threadId, notificationId, batchId }); // write (one transaction) or replay
packets.read({ threadId, batchId });                    // membership + fresh per-report state
packets.page({ threadId, batchId, cursor, limit, maxBytes }); // bounded detail page
packets.list({ threadId });                             // packet index for one chat
```

`ReviewPackets` accepts `{ store, config = {}, queue, notifications, limits = {} }`.
`store` is required and must expose `transaction` and `meta`. If `notifications`
is omitted a `Notifications` service is constructed from `{ store, queue, config }`.
An explicitly injected service is reused **only when it is bound to the exact same
Store/transaction connection** (`notifications.store === store`, same `db`);
otherwise the constructor throws a `TypeError` naming the mismatch. This is
refused before any mutation, so a service bound to a different Store can never
have its `receive` calls commit outside the packet transaction. `limits`
overrides individual `REVIEW_PACKET_LIMITS` (defaults are merged over
`REVIEW_PACKET_LIMITS`).

`threadId` must be the exact manager chat UUID. `batchId` and `notificationId`
match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. An unknown field on any request is
rejected rather than ignored.

## `capture({ threadId, notificationId, batchId })`

Runs in a single `Store.transaction`, in this order:

1. If a packet already exists for `batchId`, it is a **replay**: the original
   packet is returned, but only when the stored `threadId` and `notificationId`
   match the request. A different chat or a different notification is refused
   and nothing is mutated.
2. The notification is loaded and its ownership is checked: an unknown
   notification is refused, and a notification that belongs to a different
   manager chat is refused.
3. The finite report limit is checked **before** any receipt commits. If the
   chat currently holds more actionable reports than `maxReports`, a `RangeError`
   is thrown and no notification is received and no packet is written.
4. A genuine capture snapshots only the notification's exact current owned
   members: `Notifications.inbox(threadId)` filtered to `notification.members`,
   re-evaluated against the live pending/host-eligible inbox. Reports the
   notification does not name (for example a newer, still-uncovered report) are
   never swept in. `Notifications.inbox(threadId)` remains the explicit
   full-inbox read for callers that want the whole chat.
5. `Notifications.receive(notificationId)` marks manager receipt, then the
   packet is validated against `maxRecordBytes` and durably saved. Because all of
   this is one transaction, a parse/size fault after `receive` rolls back the
   manager receipt and the notification timestamp along with the packet.
6. A `review-packet.captured` journal entry is written once.

Returned summary (also the shape of `read`, minus members):

```js
{
  version: 1, type: 'review-packet', batchId, threadId, notificationId,
  capturedAt, fingerprint,            // sha256 hex of the canonical record body
  replayed,                           // true when returned from a durable replay
  capturedActionable, capturedAlreadyHandled, // state of the received inbox when captured
  actionable, alreadyHandled,          // ALIASES for the current state below
  currentActionable, currentEligible, currentPending, currentHandled,
  restarted: false,
  evidenceOnly: true, canAcknowledge: false, canAccept: false, canSignal: false,
  note, count, reportIds, idEnvelope, memberIds, taskIds, workerIds, provenance
}
```

- `reportIds` is always the **complete** captured set, even when detail pages
  truncate. `idEnvelope` reports `{ count, boundedBy: 'maxReports', maxReports }`
  so a caller can see that the ID list itself is bounded by `maxReports` and
  never silently loses IDs inside a page.
- `capturedActionable`/`capturedAlreadyHandled` describe the **received batch as
  captured**. `actionable`/`alreadyHandled` are **aliases for the current state
  recomputed on every call**: a report actioned after capture is never reported
  as pending. `currentActionable`/`currentEligible`/`currentPending`/
  `currentHandled` make the current projection explicit and unambiguous.
- `restarted`/`canSignal` are always `false`: a fresh, already-inactive
  notification never restarts work and a packet never signals a worker.
- `provenance` is the frozen `REVIEW_PACKET_PROVENANCE` object
  (`authority: 'worker-claims'`, `untrusted: true`, `terminalVerified: false`).

### Which reports a capture receives

Capture only treats a notification as genuinely actionable when the notification
itself is **unreceived and not retired** *and* the current inbox still holds one
of its **owned** members. In that case the snapshot is exactly those owned
members — `notification.members` intersected with the current pending,
host-eligible inbox for that chat — and each is marked received. An unrelated
pending report in the same chat (for example one already received by an earlier
envelope, or a newer report not yet covered by any envelope) is neither captured
nor received on this notification's behalf.

For the explicit full-chat read, use `Notifications.inbox(threadId)` (or the
`legacy: true` compatibility path of `receive_notification`).

Otherwise — a replay of an already-received notification, or a stale envelope
examined under a **new** `batchId` — the packet is the recovered **known
original membership only**. New, unrelated work that arrived after the envelope
was received is never swept into the stale snapshot, and no receive is performed
for it.

## `read({ threadId, batchId })`

Pure read (plus the fresh per-report projection below). Returns the `capture`
summary fields plus:

```js
{
  found: true,
  members: [{ messageId, captured, taskId, workerId, terminalId, kind, current }],
  counts: { members, pending, eligible, handled }
}
```

`current` is projected fresh from the Store on every read, so a replay never
claims stale state:

```js
{
  present, pending, eligible, reason, acknowledgedAt, receivedAt, delivery,
  action: { kind, state, requestId } | null,
  taskStatus, taskActive, workerPresent
}
```

`reason` names the explicit current eligibility: `'actionable'`,
`'progress-report'`, `'acknowledged'`, `'task-<status>'`, or
`'worker-missing'`. Task closure, ownership, and a missing worker are therefore
visible as current ineligibility — never an automatic restart.

This separates **original batch membership** from **current per-report state**:
a report that was actioned after capture is reported as handled
(`current.pending === false`, `current.eligible === false`), and new unrelated
reports are never swept into the old batch (`counts.pending` stays `0`).

## `page({ threadId, batchId, cursor, limit, maxBytes })`

Returns the full `reportIds` set plus one bounded page of detail:

```js
{
  ..., reportIds, idEnvelope,
  cursor,        // base64url cursor, or null when exhausted
  returned, remaining, pageBytes,
  detailBudget: { maxBytes, maxItems, measuredOn },
  items: [{ messageId, taskId, workerId, terminalId, kind,
            summary, refs, observations, provenance, current }]
}
```

- `limit` defaults to `maxPageItems`; `maxBytes` defaults to `maxPageBytes`.
- `maxBytes` is a **real serialized-byte budget**: it measures the UTF-8 byte
  length of `JSON.stringify(items)`, including JSON commas, brackets, and object
  separators — not just the sum of the individual string lengths. Items are
  appended while the serialized array still fits, so `pageBytes <= maxBytes`
  always holds.
- If even one serialized item cannot fit, `page` **throws** a `RangeError` with
  `code === 'PAGE_BUDGET_TOO_SMALL'` and `requiredBytes`. It never silently
  exceeds the budget and never emits a non-progress cursor.
- The cursor encodes `{ v: 1, batchId, threadId, fingerprint, after }` and is
  validated against the loaded packet, so a cursor from one batch (or another
  chat) is refused.
- `summary` is a code-point-safe preview: `{ text, bytes, sourceBytes, truncated }`.
  Truncation never produces U+FFFD.

Each `item.summary` is a bounded preview of the worker's text. Full report text
and full logs remain available only through the existing read tools; a packet
does not echo a large report or evidence body into the normal summary.

### Untrusted references and observations

`refs.evidence`, `refs.revision`, and `refs.handoff` are **bounded ref
envelopes**, never bare arrays and never dereferenced:

```js
{ items: [string, ...], total, dropped, clipped, truncated, maxRefs, maxRefLength }
```

- `items` holds at most `maxRefs` refs; `total` is the number that existed,
  `dropped` the count omitted by the `maxRefs` cap, and `clipped` the count
  shortened to `maxRefLength` UTF-8 bytes. `truncated` is true when any ref was
  dropped or clipped, so truncation is always **visible** — a caller is never
  told it saw everything when it did not.
- `refs.evidence` is derived from a valid **worker evidence v1** value
  (`final_revision`/`baseline_revision` digests and projects, `artifacts[].path`,
  `tests[].output_path`); no path is opened and no revision is verified.
- Each item carries a report-level `provenance` object stating
  `authority: 'worker-claims'`, `untrusted: true`, and
  `referencesDereferenced: false`.

`observations` reuses **already-captured** Store metadata only
(`observation:<workerId>`), whitelisting `state`, `turn`, `episode`, `working`,
`observedAt`, `activationId`, and `quarantined`. It performs no native probe and
no filesystem read, and each entry states `authority: 'store-recorded'`,
`referencesDereferenced: false`, and its own `truncated` flag for a bounded
`state`.

## `list({ threadId })`

```js
{ threadId, count, packets: [{ batchId, notificationId, capturedAt, count, actionable, fingerprint }] }
```

Reads the `review-packet:` metadata keys, ignores records belonging to other
chats, and returns only this chat's packets.

## Persistence and integrity

- Packets live in `Store` metadata under `review-packet:<batchId>`; they survive
  a Store restart.
- Every record carries a `fingerprint` = `sha256(canonicalJson(body))`. `read`,
  `page`, and `list`-independent loads re-derive the digest and reject a
  tampered record.
- A conflicting `batchId` reuse is refused; an identical replay returns the same
  fingerprint.

## Limits (`REVIEW_PACKET_LIMITS`)

```js
{
  maxBatchIdLength: 128,
  maxNotificationIdLength: 128,
  maxReports: 256,
  maxPreviewBytes: 512,
  maxPageItems: 100,
  maxPageBytes: 32 * 1024,
  maxRefs: 32,
  maxRefLength: 512,
  maxRecordBytes: 4 * 1024 * 1024,
  maxCursorBytes: 4096
}
```

## Tests

`tests/review-packets.test.mjs` exercises the real `Store` and real
`Notifications`. It covers lost-response replay, conflicting batch reuse,
finite-limit enforcement before receipt, transaction rollback of a fault after
`receive`, plus refusal of a `Notifications` service bound to a different Store
(proving the foreign Store's receipts and the packet stay unchanged),
Store restart, cross-chat refusal, malformed input/cursors,
UTF-8-bounded pagination with code-point-safe truncation, an explicit
`PAGE_BUDGET_TOO_SMALL` refusal, a stale envelope captured under a new batch
(no sweep of unrelated new work), visible ref clipping/dropping, bounded
observation values, cursor binding, membership-vs-current-state replay,
overlapping-notification receive semantics, large multi-page results,
observation-reference whitelisting, per-chat listing, and record-integrity
enforcement.

## Known limits

- Capture/verification is best-effort against a live Store; callers should
  re-read before acting on a packet.
- Packets record worker claims; they do not verify a terminal, a revision, or a
  referenced path, and they confer no authority to acknowledge or accept work.
- The bounded report limit is a safety bound, not a policy: callers must size it
  for their workload.
