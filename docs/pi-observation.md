# Pi observation extension (version 1)

Additive, read-only observation of an interactive Pi session. This document
describes the foundation implemented in `src/pi-observation-extension.mjs`.

This module is a **foundation only**. Nothing here is auto-loaded, mutates global
state, opens the network, registers tools/commands, spawns or kills processes, or
changes the selected provider/model. Explicit launcher and bridge wiring follow
later.

## Purpose

Produce bounded, structural telemetry about a Pi session's lifecycle and
compaction behavior so a manager can later correlate worker activity without ever
receiving private content. Observation is strictly non-invasive: handlers return
`undefined` and never alter session behavior.

## API

| Export | Description |
| --- | --- |
| `OBSERVATION_VERSION` | Published event schema version (`1`). |
| `OBSERVED_EVENTS` | Frozen map of observed Pi event name → structural category (`lifecycle` / `compaction`). |
| `ID_MAX_LENGTH` | Maximum length (256) of a trusted identity string. |
| `validateObservationConfig(config)` | Returns `{ ok, errors, value }`; validates `worker_id`, `task_id`, `execution_generation`. |
| `createObservationRecorder({ config, sink, now, streamId })` | Builds a recorder, or returns `null` when config/sink are missing or invalid. |
| `createPiObservationExtension({ config, sink, now, streamId })` | Returns `{ configured, errors, recorder, register(pi), dispose() }`. Inert (`configured:false`) without valid config and a function sink. |
| `default export` | Pi-shaped entry point `(pi, options)`. Pi calls it with only `pi`, so it is inert; a later launcher may call `piObservationExtension(pi, { config, sink })`. |

### Trusted identity

`config` is manager-created and carries trusted, immutable values:

```js
{ worker_id, task_id, execution_generation }
```

Each must be a non-empty string of at most `ID_MAX_LENGTH` characters. Values are
echoed into events unchanged and are never inferred from the session.

### Observation stream id

Every recorder has an `observation_stream_id`: a unique, bounded (≤256) string
generated per recorder (`randomUUID`) or supplied via the `streamId` option for
deterministic tests. Because `seq` resets on each recorder/extension reload while
`execution_generation` may stay the same, the stream id lets a future durable
receiver distinguish separate observation streams without rewriting
`execution_generation`. An invalid injected `streamId` is ignored in favor of a
generated one.

### Registration lifecycle

- `register(pi)` subscribes one handler per observed event and is **idempotent
  per surface**: registering the same `pi` again returns `false` and adds no
  handlers, so a single event cannot produce duplicate incidents.
- `dispose()` unregisters every handler and clears the surface set, so a later
  `register(pi)` is defined and leak-free.

## Observed events

| Pi event | Category | Structural data |
| --- | --- | --- |
| `session_start` | lifecycle | `{ reason }` |
| `session_shutdown` | lifecycle | `{ reason }` |
| `input` | lifecycle | `{ source, streaming_behavior }` |
| `before_agent_start` | lifecycle | `{}` (no `message_type` is derived) |
| `agent_start` | lifecycle | `{}` |
| `agent_end` | lifecycle | `{}` |
| `session_before_compact` | compaction | `{ reason, will_retry }` |
| `session_compact` | compaction | `{ reason, will_retry, from_extension }` |
| `session_compact_failed` | compaction | `{ reason, will_retry, from_extension, aborted, error_code }` |

Enumerated values are validated against fixed allow-lists; anything else becomes
`"unknown"` (or `null` for optional fields). This keeps payloads bounded even if
an unexpected value is supplied.

## Event shape (version 1)

```jsonc
{
  "version": 1,
  "observation_stream_id": "3f2a...",   // unique per recorder; distinguishes reloads
  "seq": 1,                     // per-instance, starts at 1, incremented per observed event
  "ts": "2020-01-01T00:00:00.000Z",
  "type": "lifecycle",          // or "compaction"
  "event": "session_start",
  "worker_id": "worker-1",
  "task_id": "task-1",
  "execution_generation": "gen-1",
  "harness_session_id": "sess-1",   // observed per event; may change, null if unavailable
  "context": { "tokens": null, "context_window": 4096, "percent": null },
  "data": { "reason": "startup" }
}
```

- `seq` increments once per observed event for the lifetime of a recorder
  instance.
- `context` is the estimated usage from `ctx.getContextUsage()`. When usage is
  unavailable (undefined, throws, or non-object) `context` is `null`. Numeric
  fields are forwarded only when they are nonnegative safe integers (`tokens`,
  `context_window`) or finite nonnegative numbers (`percent`); anything else
  stays `null`, so "unknown" is never confused with zero.
- `harness_session_id` is read from `ctx.sessionManager.getSessionId()` on each
  event. Session changes are therefore observable, while `execution_generation`
  remains immutable for the recorder instance.

## Redaction rules

The extension records **only** structural facts:

- `input` records event kind and `source` / `streaming_behavior` only — never
  `text`, `images`, or any payload.
- `before_agent_start` records the event kind only. Its real payload exposes
  `prompt`/`images`/`systemPrompt`; no `message_type` (or any other field) is
  derived from absent fields, since that would be a false claim.
- `session_compact_failed` records a bounded `error_code` (`"aborted"` or
  `"compaction_failed"`) — never the verbatim `errorMessage`.
- Provider/model output, headers, and secrets are never read or forwarded.
- No raw transcript is persisted by this module.

Working/input/start events do **not** claim message acknowledgment or model
presentation; they record that a structural lifecycle event occurred.

## Failure handling

- A sink that throws synchronously never crashes the worker. `observe()` catches
  the error and returns `{ delivered:false, pending:false }`.
- A **thenable/async sink** is handled without blocking: `observe()` returns
  `{ delivered:false, pending:true, settled }` immediately (delivery is never
  claimed from Promise creation), and the attached rejection handler consumes
  any rejection so it can never become an unhandled rejection or crash Pi. When
  the promise settles, `stats()` records the truth: `delivered` on fulfilment,
  `failed` on rejection.
- `recorder.stats()` exposes `{ seq, delivered, failed, pending }`, so pending
  and failed emissions are never reported as delivered telemetry.
- Handlers wrap observation in `try/catch` and return `undefined`; observation
  cannot disrupt or alter the interactive session.
- Invalid or missing config yields an inert extension: `register()` registers
  nothing and the default export is a no-op.

## Testing

`tests/pi-observation-extension.test.mjs` uses a fake Pi registration surface and
controlled contexts/sinks to cover:

- versioned lifecycle shape and per-instance sequence;
- null/unknown and invalid (negative, non-integer, non-finite, unsafe) usage
  staying `null` while valid nonnegative values pass through;
- one bounded compaction-failure incident per event (no restart loop);
- session-id changes distinguishable without rewriting `execution_generation`;
- inert behavior with missing config;
- synchronous sink failure and async reject/resolve settling truthful
  `{ delivered, failed, pending }` stats with no unhandled rejection;
- idempotent double registration and defined dispose/re-register behavior;
- bounded, per-recorder `observation_stream_id`;
- private input/body/system-prompt/failure-message content never reaching the
  sink;
- observation-only registration (no tools, commands, or model mutation).

Run:

```sh
node --test tests/pi-observation-extension.test.mjs
```

## Limits

- Observation is best-effort and asynchronous with respect to Pi internals; the
  extension does not block or alter session execution.
- `seq` is per recorder instance and resets when a new instance is created;
  use `observation_stream_id` to distinguish reloads.
- No ordering guarantee across different event kinds beyond emission order.
- Async sink settlement is asynchronous; callers that need final counts should
  await the returned `settled` promise before reading `stats()`.
- This module does not deliver events anywhere by itself; a manager-supplied sink
  is required. Live loading, launcher wiring, and end-to-end qualification are
  out of scope for this foundation.
