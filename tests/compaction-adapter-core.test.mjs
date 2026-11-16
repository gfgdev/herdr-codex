/**
 * Focused core tests for the bounded compaction adapter.
 *
 * These exercise the PUBLIC paths of `src/compaction-service.mjs` and
 * `src/pi-compaction-extension.mjs` against the four manager-reported blockers plus the
 * core cancellation / no-fallthrough / runner-uncertainty behaviour:
 *
 *   1. live session identity is re-read before a candidate may be returned;
 *   2. cancellation is re-checked after every awaited validation and immediately before
 *      a candidate return;
 *   3. the prior summary (and the rest of the adapter-supplied state) is bound into the
 *      digest and re-supplied on EVERY attempt;
 *   4. native Pi `toolCall` / `toolResult` content links and error facts survive
 *      normalization, and bounded-away history is surfaced rather than hidden.
 *
 * The child-process cancellation test uses a REAL subprocess (`fixtures/compaction/
 * fake-sleeper.mjs`) so termination is observed from the OS, not inferred from wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  createCompactionService,
  normalizeHistory,
  normalizeHistoryDetailed,
  createProcessRecipeRunner,
  inspectRecipeAuthority,
} from "../src/compaction-service.mjs";
import { createPiCompactionExtension, collectPreparationHistory } from "../src/pi-compaction-extension.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "compaction");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PREP_SIMPLE = loadFixture("preparation-simple.json");
const PREP_SPLIT = loadFixture("preparation-split-turn.json");
const PREP_PREV = loadFixture("preparation-previous-compaction.json");
const CANDIDATE_OK = loadFixture("candidate-ok.json");

/** Build a schema/binding-valid candidate that echoes the adapter-owned passthrough. */
function candidateFor(request) {
  const slice = JSON.parse(request.history_json);
  return {
    ...CANDIDATE_OK,
    passthrough: {
      session_identity: slice.session_identity,
      input_digest: slice.input_digest,
      first_kept_entry_id: slice.first_kept_entry_id,
      tokens_before: slice.tokens_before,
    },
  };
}

function runInput(overrides = {}) {
  return {
    sessionIdentity: "sess:core:1",
    generation: 1,
    firstKeptEntryId: "entry_kept_0007",
    tokensBefore: 91234,
    isSplitTurn: false,
    history: PREP_SIMPLE.preparation.messagesToSummarize,
    previousSummary: null,
    reason: "threshold",
    requesterNote: "trigger=threshold",
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path: a candidate (never a commit)
// ---------------------------------------------------------------------------

test("simple preparation returns a candidate_ready result with a byte-matching digest", async () => {
  let seenSlice = null;
  const runner = async (request) => {
    seenSlice = JSON.parse(request.history_json);
    return { output: JSON.stringify(candidateFor(request)), usage: { input: 12, output: 34 } };
  };
  const service = createCompactionService({ runner });
  const result = await service.run(runInput());

  assert.equal(result.outcome, "candidate_ready");
  assert.equal(result.applicable, true);
  assert.equal(result.committed, false, "a hook return is a candidate, not a commit");
  assert.equal(result.reason, "candidate_ready");
  assert.equal(result.attempts, 1);
  assert.ok(result.compaction, "expected a compaction candidate");
  assert.equal(result.compaction.firstKeptEntryId, "entry_kept_0007");
  assert.equal(result.compaction.tokensBefore, 91234);
  assert.deepEqual(result.compaction.usage, { input: 12, output: 34 });
  assert.match(result.compaction.summary, /^# Compaction summary/);
  assert.match(result.input_digest, /^[a-f0-9]{64}$/);
  // The digest handed to the model inside the slice is byte-identical to the boundary digest.
  assert.equal(seenSlice.input_digest, result.input_digest);
  assert.equal(result.runner_exit_confirmed, true);
  assert.equal(result.cancel_requested, false);
});

test("split turn summarizes messagesToSummarize and turnPrefixMessages exactly once", async () => {
  let seenSlice = null;
  const runner = async (request) => {
    seenSlice = JSON.parse(request.history_json);
    return { output: JSON.stringify(candidateFor(request)) };
  };
  const service = createCompactionService({ runner });
  const history = collectPreparationHistory(PREP_SPLIT.preparation);
  assert.equal(history.length, PREP_SPLIT.preparation.messagesToSummarize.length + PREP_SPLIT.preparation.turnPrefixMessages.length);

  const result = await service.run(
    runInput({ sessionIdentity: "sess:core:split", firstKeptEntryId: "entry_kept_0104", isSplitTurn: true, reason: "overflow", history }),
  );
  assert.equal(result.outcome, "candidate_ready");
  assert.equal(seenSlice.is_split_turn, true);
  assert.equal(seenSlice.history.length, 6);
  const prefix = seenSlice.history.filter((m) => typeof m.text === "string" && m.text.includes("turn prefix"));
  assert.equal(prefix.length, 1, "turn prefix must appear exactly once");
});

// ---------------------------------------------------------------------------
// 3. Prior summary is bound and re-supplied on EVERY attempt
// ---------------------------------------------------------------------------

test("prior summary is preserved on every retry attempt", async () => {
  const attempts = [];
  let call = 0;
  const runner = async (request) => {
    call += 1;
    attempts.push(request.previous_summary_json);
    if (call === 1) return { output: "not json at all" };
    return { output: JSON.stringify(candidateFor(request)) };
  };
  const service = createCompactionService({ runner });
  const result = await service.run(
    runInput({
      sessionIdentity: "sess:core:prev",
      firstKeptEntryId: "entry_kept_0200",
      reason: "manual",
      history: PREP_PREV.preparation.messagesToSummarize,
      previousSummary: PREP_PREV.preparation.previousSummary,
    }),
  );

  assert.equal(result.outcome, "candidate_ready");
  assert.equal(result.attempts, 2, "a malformed candidate is retried once");
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0], "attempt 1 must carry previous_summary_json");
  assert.equal(attempts[1], attempts[0], "attempt 2 must NOT silently drop the prior summary");
  assert.match(attempts[1], /Compaction summary/);
});

test("changing an adapter-supplied input changes the input digest", async () => {
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) });
  const base = await createCompactionService({ runner }).run(runInput({ sessionIdentity: "sess:core:digest:a", firstKeptEntryId: "e-a" }));
  const withNote = await createCompactionService({ runner }).run(
    runInput({ sessionIdentity: "sess:core:digest:b", firstKeptEntryId: "e-b", requesterNote: "custom_instructions=differs" }),
  );
  const withPrev = await createCompactionService({ runner }).run(
    runInput({ sessionIdentity: "sess:core:digest:c", firstKeptEntryId: "e-c", previousSummary: "prior" }),
  );
  assert.notEqual(base.input_digest, withNote.input_digest);
  assert.notEqual(base.input_digest, withPrev.input_digest);
  assert.notEqual(withNote.input_digest, withPrev.input_digest);
});

// ---------------------------------------------------------------------------
// 1 + 2. Live identity/cancellation re-checks
// ---------------------------------------------------------------------------

test("a live session change during the run is detected and cancels the candidate", async () => {
  const observations = [];
  let live = "session-A";
  const runner = async (request) => {
    live = "session-B"; // the source session changes while the runner is awaited
    return { output: JSON.stringify(candidateFor(request)) };
  };
  const extension = createPiCompactionExtension({
    config: { session_identity: "session-A" },
    runner,
    sink: (event) => observations.push(event),
  });
  const event = {
    type: "session_before_compact",
    preparation: PREP_SIMPLE.preparation,
    reason: "threshold",
    signal: new AbortController().signal,
  };
  const ctx = { sessionManager: { getSessionId: () => live } };

  const result = await extension.handler(event, ctx);
  assert.equal(result.compaction, undefined, "a stale session must not yield an applicable compaction");
  assert.equal(result.cancel, true);
  assert.equal(observations.at(-1).outcome, "stale");
  assert.equal(observations.at(-1).committed, false);
});

test("cancellation is re-checked after the final awaited validation", async () => {
  const controller = new AbortController();
  let checks = 0;
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) });
  const service = createCompactionService({ runner });
  const result = await service.run(
    runInput({
      sessionIdentity: "sess:core:abort",
      firstKeptEntryId: "entry_abort",
      signal: controller.signal,
      isCurrent: async () => {
        checks += 1;
        if (checks === 2) controller.abort(); // abort during the last awaited validation
        return true;
      },
    }),
  );

  assert.equal(result.applicable, false, "a late abort must suppress the candidate");
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.cancel_requested, true);
  assert.equal(checks, 2);
});

test("an async isCurrent that resolves false is awaited, not treated as truthy", async () => {
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) });
  const service = createCompactionService({ runner });
  const result = await service.run(
    runInput({ sessionIdentity: "sess:core:isCurrent", firstKeptEntryId: "entry_ic", isCurrent: async () => false }),
  );
  assert.equal(result.outcome, "stale");
  assert.equal(result.applicable, false);
});

// ---------------------------------------------------------------------------
// 1. Identity read failures never escape to Pi and never run the model
// ---------------------------------------------------------------------------

function identityFailureEvent(overrides = {}) {
  return {
    type: "session_before_compact",
    preparation: PREP_SIMPLE.preparation,
    reason: "threshold",
    willRetry: false,
    signal: undefined,
    ...overrides,
  };
}

test("a throwing FIRST session-identity read cancels with identity_unavailable and runs no model", async () => {
  const observations = [];
  let runnerCalls = 0;
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:ident-first" },
    runner: async (request) => {
      runnerCalls += 1;
      return { output: JSON.stringify(candidateFor(request)) };
    },
    sink: (event) => observations.push(event),
  });
  let reads = 0;
  const ctx = {
    sessionManager: {
      getSessionId: () => {
        reads += 1;
        throw new Error("session store unavailable");
      },
    },
  };

  const result = await extension.handler(identityFailureEvent(), ctx);

  assert.deepEqual(result, { cancel: true }, "a hook failure must resolve to a structured cancellation, not reject");
  assert.equal(reads, 1, "the first identity read is the one that was attempted");
  assert.equal(runnerCalls, 0, "no model call may be made for an unavailable identity");
  assert.equal(extension.state.inflight, 0, "inflight accounting must return to zero");
  assert.equal(observations.at(-1).outcome, "failed");
  assert.equal(observations.at(-1).code, "identity_unavailable");
  assert.equal(observations.at(-1).cancel_requested, false);
});

test("a session-identity read that throws DURING validation cancels and runs no model", async () => {
  const observations = [];
  let runnerCalls = 0;
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:ident-mid" },
    runner: async (request) => {
      runnerCalls += 1;
      return { output: JSON.stringify(candidateFor(request)) };
    },
    sink: (event) => observations.push(event),
  });
  let reads = 0;
  const ctx = {
    sessionManager: {
      getSessionId: () => {
        reads += 1;
        if (reads >= 2) throw new Error("store went away mid-validation");
        return "sess:core:ident-mid";
      },
    },
  };

  const result = await extension.handler(identityFailureEvent(), ctx);

  assert.deepEqual(result, { cancel: true });
  assert.equal(reads, 2, "the validation-time read must have been attempted");
  assert.equal(runnerCalls, 0, "a validation failure must be detected before the runner");
  assert.equal(extension.state.inflight, 0);
  assert.equal(observations.at(-1).code, "identity_unavailable");
});

test("a throwing isCurrent callback cancels with is_current_unavailable and runs no model", async () => {
  const observations = [];
  let runnerCalls = 0;
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:isCurrent-throw" },
    runner: async (request) => {
      runnerCalls += 1;
      return { output: JSON.stringify(candidateFor(request)) };
    },
    sink: (event) => observations.push(event),
    isCurrent: () => {
      throw new Error("validation hook failed");
    },
  });

  const result = await extension.handler(identityFailureEvent(), {
    sessionManager: { getSessionId: () => "sess:core:isCurrent-throw" },
  });

  assert.deepEqual(result, { cancel: true });
  assert.equal(runnerCalls, 0);
  assert.equal(extension.state.inflight, 0);
  assert.equal(observations.at(-1).code, "is_current_unavailable");
});

test("a pre-aborted hook signal cancels with not_started and runs no model", async () => {
  const observations = [];
  let runnerCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:preabort" },
    runner: async (request) => {
      runnerCalls += 1;
      return { output: JSON.stringify(candidateFor(request)) };
    },
    sink: (event) => observations.push(event),
  });

  const result = await extension.handler(identityFailureEvent({ signal: controller.signal }), {
    sessionManager: { getSessionId: () => "sess:core:preabort" },
  });

  assert.deepEqual(result, { cancel: true });
  assert.equal(runnerCalls, 0);
  assert.equal(extension.state.inflight, 0);
  assert.equal(observations.at(-1).outcome, "cancelled");
  assert.equal(observations.at(-1).attempts, 0);
  assert.equal(observations.at(-1).termination, "not_started");
  assert.equal(observations.at(-1).cancel_requested, true);
});

// ---------------------------------------------------------------------------
// Malformed / output-cap / paused / timeout / duplicate
// ---------------------------------------------------------------------------

test("a malformed candidate is retried and can succeed on attempt 2", async () => {
  let call = 0;
  const runner = async (request) => {
    call += 1;
    if (call === 1) return { output: "}{ not json" };
    return { output: JSON.stringify(candidateFor(request)) };
  };
  const service = createCompactionService({ runner });
  const result = await service.run(runInput({ sessionIdentity: "sess:core:malformed", firstKeptEntryId: "entry_m" }));
  assert.equal(result.outcome, "candidate_ready");
  assert.equal(result.attempts, 2);
});

test("an over-cap candidate output is refused as output_cap_exceeded", async () => {
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) + " ".repeat(4096) });
  const service = createCompactionService({ runner, budget: { max_output_bytes: 128 } });
  const result = await service.run(runInput({ sessionIdentity: "sess:core:cap", firstKeptEntryId: "entry_cap" }));
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "output_cap_exceeded");
  assert.equal(result.applicable, false);
});

test("an over-budget input is refused before the runner is invoked", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { output: "{}" };
  };
  const service = createCompactionService({ runner, budget: { max_input_bytes: 32 } });
  const result = await service.run(runInput({ sessionIdentity: "sess:core:inbytes", firstKeptEntryId: "entry_ib" }));
  assert.equal(result.reason, "budget_exceeded");
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 2. Known-lossy input is refused BEFORE the runner/fallback (no process launched)
// ---------------------------------------------------------------------------

async function assertPreRunLossyRefusal(service, input, label, expectedTruncation = {}, detailIncludes = null) {
  const result = await service.run(input);
  assert.equal(result.outcome, "failed", `${label}: outcome`);
  assert.equal(result.reason, "lossy_input", `${label}: reason`);
  assert.equal(result.applicable, false, `${label}: not applicable`);
  assert.equal(result.lossy, true, `${label}: flagged lossy`);
  assert.equal(result.attempts, 0, `${label}: no attempt may be spent`);
  assert.equal(result.cancel_requested, false, `${label}: not a cancellation`);
  assert.equal(result.runner_exit_confirmed, false, `${label}: no process was launched`);
  assert.equal(result.termination, "not_started", `${label}: nothing to terminate`);
  assert.equal(service.stats().runnerCalls, 0, `${label}: runner must not be called`);
  assert.ok(result.operation_id, `${label}: operation identity is preserved`);
  assert.match(result.input_digest, /^[0-9a-f]{64}$/, `${label}: digest is preserved`);
  for (const [key, value] of Object.entries(expectedTruncation))
    assert.equal(result.history_truncation[key], value, `${label}: truncation.${key}`);
  if (detailIncludes !== null) assert.match(String(result.detail), detailIncludes, `${label}: detail`);
  return result;
}

test("a clipped 20000-char message is refused as lossy_input before the runner", async () => {
  const service = createCompactionService({ runner: async () => ({ output: "{}" }) });
  const result = await assertPreRunLossyRefusal(
    service,
    runInput({ sessionIdentity: "sess:core:lossy-clip", firstKeptEntryId: "entry_lc", history: [{ role: "user", content: "x".repeat(20000) }] }),
    "clipped message",
    { text_clipped_messages: 1 },
  );
  assert.ok(result.input_bytes > 0);
});

test("an unsupported content block is refused as lossy_input before the runner", async () => {
  const service = createCompactionService({ runner: async () => ({ output: "{}" }) });
  await assertPreRunLossyRefusal(
    service,
    runInput({
      sessionIdentity: "sess:core:lossy-unsupported",
      firstKeptEntryId: "entry_lu",
      history: [{ role: "user", content: [{ type: "image", source: { data: "AAAA" } }] }],
    }),
    "unsupported block",
    { unsupported_content: 1 },
  );
});

test("history beyond the message cap is refused as lossy_input before the runner", async () => {
  // A large budget keeps the refusal reason pinned to lossy_input rather than budget_exceeded.
  const service = createCompactionService({ runner: async () => ({ output: "{}" }), budget: { max_input_bytes: 10_000_000 } });
  const history = Array.from({ length: 4097 }, (_, i) => ({ role: "user", content: `m${i}` }));
  await assertPreRunLossyRefusal(
    service,
    runInput({ sessionIdentity: "sess:core:lossy-dropped", firstKeptEntryId: "entry_ld", history }),
    "dropped messages",
    { dropped_messages: 1 },
  );
});

test("dropped file operations are refused as lossy_input before the runner", async () => {
  const service = createCompactionService({ runner: async () => ({ output: "{}" }), budget: { max_input_bytes: 10_000_000 } });
  const read = new Set(Array.from({ length: 2050 }, (_, i) => `/tmp/f${i}.txt`));
  await assertPreRunLossyRefusal(
    service,
    runInput({ sessionIdentity: "sess:core:lossy-fileops", firstKeptEntryId: "entry_lf", fileOps: { read, written: new Set(), edited: new Set() } }),
    "dropped file ops",
    {},
    /2 file op\(s\) dropped/,
  );
});

test("a paused runner is classified as runner_paused and never yields a candidate", async () => {
  const runner = async () => {
    const error = new Error("runner paused by the host");
    error.code = "PENDING";
    throw error;
  };
  const service = createCompactionService({ runner });
  const result = await service.run(runInput({ sessionIdentity: "sess:core:paused", firstKeptEntryId: "entry_p" }));
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "runner_paused");
  assert.equal(result.applicable, false);
});

test("a runner that ignores abort reports an uncertain termination, never success", async () => {
  // A runner that ignores the derived signal. The ref'd (non-unref'd) timer keeps the
  // event loop alive so the adapter's own unref'd timeout/grace timers can actually fire;
  // the runner is still unresolved when the adapter returns, which is the point.
  let keepAlive;
  const runner = () =>
    new Promise((resolve) => {
      keepAlive = setTimeout(() => resolve({ output: "{}" }), 10000);
    });
  const service = createCompactionService({ runner, timeoutMs: 60, abortGraceMs: 40 });
  const result = await service.run(runInput({ sessionIdentity: "sess:core:timeout", firstKeptEntryId: "entry_t" }));
  clearTimeout(keepAlive);
  assert.equal(result.outcome, "timeout");
  assert.equal(result.applicable, false);
  assert.equal(result.cancel_requested, true);
  assert.equal(result.runner_exit_confirmed, false);
  assert.equal(result.termination, "uncertain");
});

test("re-running the same frozen boundary is refused as duplicate_boundary", async () => {
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) });
  const service = createCompactionService({ runner });
  const input = runInput({ sessionIdentity: "sess:core:dup", firstKeptEntryId: "entry_dup" });
  const first = await service.run(input);
  const second = await service.run(input);
  assert.equal(first.outcome, "candidate_ready");
  assert.equal(second.outcome, "failed");
  assert.equal(second.reason, "duplicate_boundary");
});

// ---------------------------------------------------------------------------
// 4. Native Pi content shapes
// ---------------------------------------------------------------------------

test("native Pi toolCall/toolResult links and error facts survive normalization", () => {
  const entries = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.txt", content: "IMPORTANT" } }] },
    { role: "tool", content: [{ type: "toolResult", toolCallId: "call-1", toolName: "write", content: "failed", isError: true }] },
  ];
  const { messages, truncation } = normalizeHistoryDetailed(entries);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].tool_name, "write");
  assert.equal(messages[0].tool_call_id, "call-1");
  assert.match(messages[0].text, /\[tool_use write id=call-1\]/);
  assert.match(messages[0].text, /IMPORTANT/, "tool arguments must not be silently dropped");
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].tool_call_id, "call-1");
  assert.equal(messages[1].tool_name, "write");
  assert.equal(messages[1].is_error, true, "tool error facts must survive");
  assert.equal(truncation.unresolved_tool_calls, 0);
  assert.deepEqual(normalizeHistory(entries), messages, "normalizeHistory delegates to the detailed form");
});

test("an unresolved tool call is surfaced, and bounded-away history is reported", () => {
  const entries = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "b.txt" } }] },
    { role: "user", content: "third message" },
  ];
  const { messages, truncation } = normalizeHistoryDetailed(entries, { maxMessages: 2 });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].unresolved, true, "a tool call with no result must be marked unresolved");
  assert.equal(truncation.unresolved_tool_calls, 1);
  assert.equal(truncation.input_messages, 2);
  assert.equal(truncation.kept_messages, 2);

  const { truncation: dropped } = normalizeHistoryDetailed(entries, { maxMessages: 1 });
  assert.equal(dropped.dropped_messages, 1, "bounded-away history must be reported, not hidden");
});

// ---------------------------------------------------------------------------
// Tool authority gate + no-fallthrough
// ---------------------------------------------------------------------------

test("a tool-bearing recipe is refused unless the launcher acknowledges it", async () => {
  const observations = [];
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) });
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:authority" },
    runner,
    sink: (event) => observations.push(event),
    recipeAuthority: { ok: true, toolBearing: [{ name: "developer" }], toolAccessUnconstrained: true },
  });
  const event = {
    type: "session_before_compact",
    preparation: PREP_SIMPLE.preparation,
    reason: "threshold",
    signal: new AbortController().signal,
  };
  const result = await extension.handler(event, { sessionManager: { getSessionId: () => "sess:core:authority" } });
  assert.equal(result.compaction, undefined);
  assert.equal(result.cancel, true, "a tool-bearing recipe must not silently run");
  assert.equal(observations.at(-1).code, "runner_authority_unconstrained");
});

test("the same recipe runs when the launcher sets allowToolBearingRecipe", async () => {
  const runner = async (request) => ({ output: JSON.stringify(candidateFor(request)) });
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:authority2" },
    runner,
    recipeAuthority: { ok: true, toolBearing: [{ name: "developer" }], toolAccessUnconstrained: true },
    allowToolBearingRecipe: true,
  });
  const event = {
    type: "session_before_compact",
    preparation: PREP_SIMPLE.preparation,
    reason: "threshold",
    signal: new AbortController().signal,
  };
  const result = await extension.handler(event, { sessionManager: { getSessionId: () => "sess:core:authority2" } });
  assert.ok(result.compaction, "an acknowledged tool-bearing recipe may run");
});

test("an unconfigured adapter cancels (never an empty fall-through) and refuses to register", async () => {
  const extension = createPiCompactionExtension({});
  assert.equal(extension.configured, false);
  const result = await extension.handler({ reason: "manual" }, {});
  assert.deepEqual(result, { cancel: true });
  assert.throws(() => extension.register({ on: () => () => {} }), /unconfigured compaction extension/);
});

test("negative control: returnEmpty() is an empty result that does NOT cancel", async () => {
  const extension = createPiCompactionExtension({ config: { session_identity: "sess:core:neg" } });
  const result = await extension.returnEmpty();
  assert.deepEqual(result, {});
  assert.equal(result.cancel, undefined, "the empty return is the documented fall-through negative control");
});

test("session_compact proves a commit ONLY when it correlates with the last candidate", async () => {
  const observations = [];
  const handlers = new Map();
  const pi = {
    on: (name, fn) => {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
  };
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:core:commit" },
    runner: async (request) => ({ output: JSON.stringify(candidateFor(request)) }),
    sink: (event) => observations.push(event),
  });
  extension.register(pi);
  assert.ok(handlers.has("session_before_compact"));
  assert.ok(handlers.has("session_compact"), "commit proof must be observed via session_compact");

  // No candidate exists yet: an unrelated event must NOT report a commit.
  handlers.get("session_compact")({ compactionEntry: { summary: "unrelated" } }, {});
  assert.equal(extension.state.commits, 0);
  assert.equal(observations.at(-1).outcome, "observed");
  assert.equal(observations.at(-1).code, "no_candidate");
  assert.equal(observations.at(-1).committed, false);

  // Produce a real candidate through the public hook path.
  const event = {
    type: "session_before_compact",
    preparation: PREP_SIMPLE.preparation,
    reason: "threshold",
    signal: new AbortController().signal,
  };
  const ctx = { sessionManager: { getSessionId: () => "sess:core:commit" } };
  const ready = await handlers.get("session_before_compact")(event, ctx);
  assert.ok(ready.compaction, "expected a candidate");
  assert.equal(observations.at(-1).outcome, "candidate_ready");
  assert.equal(observations.at(-1).committed, false);

  // An unrelated commit event (wrong boundary/summary) is an observation, not proof.
  handlers.get("session_compact")({ compactionEntry: { firstKeptEntryId: "other", tokensBefore: 1, summary: "unrelated" }, reason: "manual" }, ctx);
  assert.equal(extension.state.commits, 0);
  assert.equal(observations.at(-1).outcome, "observed");
  assert.equal(observations.at(-1).code, "unrelated_commit");
  assert.equal(observations.at(-1).committed, false);

  // The framework's real compactionEntry (same boundary + tokens + summary digest + session)
  // is the ONLY thing that proves this operation committed.
  handlers.get("session_compact")({
    type: "session_compact",
    compactionEntry: {
      summary: ready.compaction.summary,
      firstKeptEntryId: ready.compaction.firstKeptEntryId,
      tokensBefore: ready.compaction.tokensBefore,
    },
    reason: "threshold",
  }, ctx);
  assert.equal(extension.state.commits, 1);
  assert.equal(observations.at(-1).outcome, "committed");
  assert.equal(observations.at(-1).code, "commit_confirmed");
  assert.equal(observations.at(-1).committed, true);
  assert.ok(observations.at(-1).operation_id, "commit proof carries the correlated operation id");
});

// ---------------------------------------------------------------------------
// Recipe authority inspection + process runner guards
// ---------------------------------------------------------------------------

test("inspectRecipeAuthority reports declared tool-bearing extensions", () => {
  const tool = inspectRecipeAuthority("extensions:\n  - type: builtin\n    name: developer\n");
  assert.equal(tool.ok, true);
  assert.equal(tool.toolAccessUnconstrained, true);
  assert.equal(tool.toolBearing.length, 1);

  const plain = inspectRecipeAuthority("extensions:\n  - type: builtin\n    name: summarizer\n");
  assert.equal(plain.toolAccessUnconstrained, false);

  const broken = inspectRecipeAuthority("extensions: [ : : :\n");
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "recipe_unparseable");
});

test("createProcessRecipeRunner requires an absolute command and an argv builder", () => {
  assert.throws(() => createProcessRecipeRunner({ command: "goose", argsFor: () => [] }), /absolute executable/);
  assert.throws(() => createProcessRecipeRunner({ command: process.execPath }), /argsFor/);
});

// ---------------------------------------------------------------------------
// Real child-process cancellation
// ---------------------------------------------------------------------------

test("abort actually terminates a real child process", async (t) => {
  const base = process.env.HERDR_CODEX_SCRATCH || tmpdir();
  let scratch;
  try {
    scratch = mkdtempSync(join(base, "cmp-core-"));
  } catch (error) {
    t.skip(`scratch directory unavailable: ${error.message}`);
    return;
  }
  try {
    const sleeper = join(FIXTURES, "fake-sleeper.mjs");
    const pidFile = join(scratch, "sleeper.pid");
    const runner = createProcessRecipeRunner({
      command: process.execPath,
      argsFor: () => [sleeper],
      env: { ...process.env, FAKE_PID_FILE: pidFile },
    });
    const controller = new AbortController();
    const service = createCompactionService({ runner, abortGraceMs: 3000 });
    const promise = service.run(
      runInput({ sessionIdentity: "sess:core:child", firstKeptEntryId: "entry_child", signal: controller.signal }),
    );

    const startDeadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < startDeadline) await sleep(20);
    assert.ok(existsSync(pidFile), "fixture setup: child process did not start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0, "fixture setup: no pid recorded");

    controller.abort();
    const result = await promise;

    assert.equal(result.outcome, "cancelled");
    assert.equal(result.applicable, false);
    assert.equal(result.runner_exit_confirmed, true);
    assert.equal(result.termination, "confirmed");

    let dead = false;
    const killDeadline = Date.now() + 3000;
    while (Date.now() < killDeadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          dead = true;
          break;
        }
      }
      await sleep(25);
    }
    assert.ok(dead, `child pid ${pid} was still alive after the abort was confirmed`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
