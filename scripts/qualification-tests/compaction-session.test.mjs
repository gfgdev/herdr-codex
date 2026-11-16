/**
 * Real-Pi-session boundary proof for the bounded compaction adapter.
 *
 * These tests drive a GENUINE installed `@earendil-works/pi-coding-agent` `AgentSession`
 * (disposable synthetic `SessionManager`, real `DefaultResourceLoader` inline factory,
 * real `AgentSession.compact()`). They prove the two boundary facts the bounded slice
 * exists to establish:
 *
 *   1. COMMIT   — the adapter's `session_before_compact` candidate is actually APPENDED
 *                 by Pi as a `CompactionEntry`, and the reconstructed context carries the
 *                 summary while the summarized history is omitted.
 *   2. CANCEL   — a real `session.abortCompaction()` makes the adapter return
 *                 `{ cancel: true }`; Pi then appends NOTHING and the session log is
 *                 byte-for-byte unchanged.
 *
 * NOT LIVE MODEL QUALIFICATION. The injected runner is a deterministic in-process stub;
 * no model, no Goose, no network, no credentials. The next slice swaps in the real Goose
 * recipe runner. See `scripts/qualify-compaction-session.mjs` and
 * `docs/compaction-live-qualification.md`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { runQualification } from "../qualify-compaction-session.mjs";

let report;

before(async () => {
  report = await runQualification();
});

after(() => {
  if (report?.scratchRoot) {
    try {
      rmSync(report.scratchRoot, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best-effort */
    }
  }
});

test("labels the slice as NOT live model qualification", () => {
  assert.equal(report.live_model_qualification, false);
  assert.equal(report.runner, "deterministic-in-process-stub");
  assert.match(report.capability, /compaction/);
});

test("commit: extension registers through the real loader and Pi appends a CompactionEntry", () => {
  const { commit } = report;
  assert.equal(commit.extensionsLoaded, 1, "extension must be registered through the real resource loader");
  assert.equal(commit.invoked, 1, "the injected runner must be invoked exactly once");
  assert.equal(commit.candidateReady, true, "adapter must report candidate_ready before commit");
  assert.ok(commit.compactionEntry, "a compaction entry must exist in the session");
  assert.equal(commit.compactionEntry.fromHook, true, "the entry must record fromHook: true");
  assert.equal(commit.entriesAfter, commit.entriesBefore + 1, "the session log must grow by exactly one entry");
  assert.deepEqual(commit.appendedEntries, ["compaction"], "the only appended entry must be the compaction entry");
  assert.equal(commit.jsonlCompactionCount, 1, "the persisted session JSONL must contain exactly one compaction line");
});

test("commit: returned hook result hands Pi the boundary the entry records", () => {
  const { commit } = report;
  assert.ok(commit.result, "compact() must resolve with a result on commit");
  assert.equal(commit.result.firstKeptEntryId, commit.compactionEntry.firstKeptEntryId);
  assert.equal(commit.result.tokensBefore, commit.compactionEntry.tokensBefore);
  assert.ok(commit.result.summaryTokens > 0, "committed summary must be non-empty");
});

test("commit: reconstructed context carries the summary and omits summarized history", () => {
  const { commit } = report;
  assert.equal(commit.reconstructed.hasSummary, true, "reconstructed context must contain a compactionSummary message");
  assert.equal(commit.reconstructed.droppedOld, true, "summarized (pre-boundary) history must be omitted");
  assert.ok(commit.reconstructed.messageCount >= 1);
});

test("commit: adapter observation confirms commit_confirmed only after Pi commits", () => {
  const { commit } = report;
  assert.equal(commit.committedObservation, true, "adapter must record a committed observation");
  assert.deepEqual(commit.committedCodes, ["commit_confirmed"]);
  const hooks = commit.observations.map((o) => o.hook);
  assert.ok(hooks.every((hook) => hook === "session_before_compact"), "all evidence must come from the real hook");
  assert.ok(commit.events.includes("compaction_start"));
  assert.ok(commit.events.includes("compaction_end"));
});

test("cancel: real abortCompaction() appends nothing and leaves the session unchanged", () => {
  const { cancel } = report;
  assert.equal(cancel.extensionsLoaded, 1, "extension must be registered through the real loader");
  assert.equal(cancel.appended, false, "cancellation must not append a session entry");
  assert.deepEqual(cancel.appendedEntries, [], "no entries may be appended on cancellation");
  assert.equal(cancel.entriesAfter, cancel.entriesBefore, "entry count must be unchanged");
  assert.equal(cancel.jsonlAppended, false, "the persisted session JSONL must be unchanged");
  assert.equal(cancel.jsonlAfter, cancel.jsonlBefore);
  assert.equal(cancel.compactionEntries, 0, "no compaction entry may exist after cancellation");
  assert.equal(cancel.committedObservation, false, "adapter must not report a commit on cancellation");
});

test("cancel: adapter reports cancellation and Pi surfaces it to the caller", () => {
  const { cancel } = report;
  assert.equal(cancel.cancellingObservation, true, "adapter must report a cancelled outcome with cancel_requested");
  const cancelled = cancel.observations.find((o) => o.outcome === "cancelled");
  assert.ok(cancelled, "a cancelled observation must be present");
  assert.equal(cancelled.cancel_requested, true);
  assert.equal(cancelled.committed, false);
  assert.equal(cancel.threw, true, "Pi must reject the compact() promise");
  assert.match(cancel.errorMessage ?? "", /cancel/i, "rejection must be the extension cancellation");
});
