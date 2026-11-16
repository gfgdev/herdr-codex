# Integration contract — bounded compaction summary candidate

Status: **dormant**. The adapter modules are implemented and reviewed
(`src/compaction-service.mjs`, `src/pi-compaction-extension.mjs`) and travel in the
runtime snapshot, but they are **not auto-wired**: nothing loads or registers them and no
hook is bound. A **narrow synthetic manual Goose → Pi slice has been live-observed** — an
append/reopen and a fresh no-tools continuation are recorded in
[compaction live qualification](../../docs/compaction-live-qualification.md) — but that is a
small hand-built history, **not** near-limit or automatic recovery, which remains
unqualified. The recipe and schema in this directory are documentation/example assets only;
selecting them for a durable snapshot is a separate, explicit decision.

This document separates what is **IMPLEMENTED (dormant)** from what remains
**UNWIRED (live hooks)**. No token usage is invented anywhere.

## 1. Purpose and scope

The recipe (`recipe.yaml`) produces a **summary candidate only** from a manager-provided,
bounded, already-selected history slice. It is deliberately narrow:

- It does **not** decide whether a compaction happens.
- It does **not** apply its own output.
- It does **not** issue lifecycle, native, reset, kill, interrupt, or `/new` commands.
- It does **not** rewrite the actual transcript.

## 2. Hook contract this is written against

From the pinned Pi agent-session source:

- The hook `session_before_compact` is emitted with
  `{ type, preparation, branchEntries, customInstructions, reason, willRetry, signal }`.
- `preparation` (from `prepareCompaction`) carries
  `{ firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings }`.
  `messagesToSummarize` is the **selected** slice, not the whole session.
- The extension returns either `{ cancel: true }` or
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage, details } }`.
- `session_compact` fires **after** the framework appends the compaction; that event — not
  the adapter's return value — is the commit proof.

## 3. Implemented (dormant) adapter behavior

`src/pi-compaction-extension.mjs` (adapter) and `src/compaction-service.mjs` (service):

- **Boundary and binding.** The adapter freezes the boundary
  (`first_kept_entry_id`, `tokens_before`, session identity, generation, input digest).
  The model's `passthrough` must byte-match it; an altered binding is rejected
  (`binding_mismatch`) and never applied.
- **Prior state and split turns.** `collectPreparationHistory` concatenates
  `messagesToSummarize` with `turnPrefixMessages` for `isSplitTurn`; `previousSummary` is
  re-supplied on **every** attempt (a fallback cannot silently drop accepted prior state);
  `fileOps` are summarized into read/modified file details.
- **Known-lossy pre-run refusal.** If normalization dropped messages, clipped text,
  skipped an unsupported content block, or dropped a file op, the run stops with
  `lossy_input` **before** the runner executes — no model call, and no attempt is claimed.
- **Attempts and dedupe.** A frozen boundary is claimed at most once per service instance
  (`duplicate_boundary`), and `maxAttempts` is capped at **2** (one fallback attempt). The
  claim set is **in-memory**: a per-instance dedupe guard, **not** a durable incident
  latch that survives a restart.
- **Cancellation, staleness, budget.** Cancellation composes the caller signal into a
  derived controller; `cancel_requested`, `runner_exit_confirmed` and `termination` are
  kept as distinct facts. A result arriving after cancellation or a session/generation
  change is reported `stale`. Oversized input (`budget_exceeded`) and oversized output
  (`output_cap_exceeded`) are refused by the adapter.
- **Commit proof.** `handler` returns a **candidate** only. `commitHandler` reports
  `committed: true` solely after correlating Pi's `session_compact` entry (boundary, token
  count, summary digest, session identity) with the last candidate.

## 4. Schema truth vs. semantic truth

`schema/summary-candidate.schema.json` and `lib/param-encode.mjs` enforce **shape only**:
types, required keys, `additionalProperties: false`, enums, the 64-hex digest pattern, and
`acceptance_inferred === false`. They do **not** prove semantic truth and do **not**
guarantee passthrough fidelity — the adapter's binding check (§3) is the separate
mechanism for that.

`passthrough` is adapter-owned and echoed verbatim; `usage` is intentionally **not** part
of the candidate — the adapter supplies it at append time. The model never computes or
invents token counts.

## 5. Not wired (live hooks — explicit)

1. **No activation.** `createPiCompactionExtension(...).register(pi)` is never called by
   the runtime; the extension is opt-in and refuses to register without a trusted
   `config.session_identity`.
2. **No wired or durable runner.** `createGooseRecipeRunner` still requires a
   caller-supplied absolute `gooseBin` **and** an absolute `recipePath`. Its Goose final
   structured-output parsing was exercised once in the recorded synthetic manual slice
   ([live qualification](../../docs/compaction-live-qualification.md)); that model-dependent
   observation does not make the runner auto-selected, durable or qualified for automatic
   recovery.
3. **No durable incident latch.** The at-most-once claim set (§3) is in memory only; a
   restart does not preserve it.
4. **No observer wiring.** The Pi observation extension is not connected to this path.
5. **No activation from live inference.** The recorded manual slice ran a real model once
   ([live qualification](../../docs/compaction-live-qualification.md)); the recipe and schema
   in this directory are otherwise validated structurally only, and nothing here activates
   compaction in a real worker.

## 6. Non-goals

Full automatic recovery, session reset, interrupt/kill, provider/model override,
transcript rewrite, and automatic asset selection/activation are explicitly out of scope.
