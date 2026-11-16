/**
 * Pi `session_before_compact` adapter for the bounded compaction service.
 *
 * This is an ADDITIVE, opt-in extension. Nothing here is auto-loaded; the launcher must
 * register it explicitly with a trusted `session_identity` from manager config. The
 * adapter is the single supported compaction trigger: it never calls `/new`, never
 * rewrites the transcript, and never mutates Store request/lease/acceptance state.
 *
 * Division of responsibility (see `src/compaction-service.mjs`):
 *   - The adapter (this file + the service) owns session identity, the history digest,
 *     the boundary (`first_kept_entry_id` / `tokens_before`), the input budget,
 *     cancellation, and the application fields.
 *   - The recipe runner supplies ONLY a summary candidate for a bounded, already
 *     selected history slice.
 *
 * Failure policy: EVERY non-applicable outcome (including failure, timeout, staleness
 * and an unconfigured adapter) explicitly returns `{ cancel: true }`. It never returns an
 * empty object, so it can never fall through to Pi's built-in summarizer. A late result
 * after cancellation or a source-session change is suppressed by the service and also
 * never becomes an applicable compaction. The empty-return/no-fallthrough distinction is
 * covered by an explicit NEGATIVE CONTROL in the adapter tests.
 *
 * Tool authority: a recipe's prose that forbids tools is NOT enforcement. When the
 * launcher supplies `recipeAuthority` (from `inspectRecipeAuthority`) and the recipe
 * declares tool-bearing extensions such as `developer`, the adapter refuses to run unless
 * the launcher explicitly sets `allowToolBearingRecipe: true`. This makes the summarizer's
 * real authority a configuration decision, not a prompt instruction.
 *
 * Trusted identity binding: `session_identity` comes from manager config, not from the
 * model or transcript. The adapter reads the live Pi session id when available and
 * increments a bounded generation on every session change so stale generations cannot
 * return an applicable result. The identity is re-read AGAIN after every awaited
 * callback (and after the final adapter await/sink) so a callback that switches the live
 * session mid-validation cannot return an applicable candidate for the old session.
 *
 * Operational failures never escape: a throwing `ctx.sessionManager.getSessionId()` or a
 * throwing `isCurrent` callback is converted into a structured `{cancel: true}` result
 * (`identity_unavailable` / `is_current_unavailable`), matching the pinned Pi runner's
 * behaviour of catching handler errors. This adapter therefore never rejects out to the
 * Pi built-in fallback path.
 *
 * Commit proof: `{compaction}` from `handler` is only a CANDIDATE. `commitHandler`
 * (`session_compact`) correlates the framework's `compactionEntry` (boundary, token
 * count, summary digest) and the session identity against the last candidate before it
 * reports `committed: true`; an unrelated `session_compact` is reported as an observation
 * with `committed: false`.
 */
import { COMPACTION_SERVICE_VERSION, ID_MAX_LENGTH, boundedId, createCompactionService, sha256 } from "./compaction-service.mjs";

export const COMPACTION_EXTENSION_VERSION = 1;
export const COMPACTION_HOOK = "session_before_compact";
/**
 * Pi fires `session_compact` AFTER the framework appends the compaction to the
 * transcript. That event — not this adapter's return value — is the proof of commit.
 */
export const COMPACTION_COMMIT_HOOK = "session_compact";
export const COMPACTION_OUTCOMES = Object.freeze([
  "candidate_ready",
  "committed",
  "observed",
  "cancelled",
  "timeout",
  "stale",
  "failed",
  "inactive",
]);

/**
 * Operational hook failure (not a model/runner failure). Thrown internally by identity
 * reads; `handler` converts it into a structured `{cancel: true}` result so it can never
 * reject out to Pi and silently fall through to the built-in summarizer.
 */
export class CompactionHookError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "CompactionHookError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Validate the trusted adapter config. Throws on a malformed config so a misconfigured
 * launcher fails loudly instead of running unbound.
 */
export function validateCompactionConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("compaction config must be an object");
  }
  const identity = config.session_identity;
  if (typeof identity !== "string" || identity.length === 0) {
    throw new Error("compaction config requires a non-empty session_identity");
  }
  if (identity.length > ID_MAX_LENGTH) {
    throw new Error(`compaction session_identity must be at most ${ID_MAX_LENGTH} characters`);
  }
  if (config.budget !== undefined && (config.budget === null || typeof config.budget !== "object")) {
    throw new Error("compaction config budget must be an object when present");
  }
  return {
    session_identity: identity,
    budget: config.budget,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    abortGraceMs: config.abortGraceMs,
  };
}

/** Bounded, structural-only observation of one compaction attempt. No prompt/history text. */
function toObservation({ outcome, code, operationId, attempts, isSplitTurn, inputBytes, runnerExitConfirmed, cancelRequested, termination, committed, trigger }) {
  return {
    capability: "bounded-compaction",
    hook: COMPACTION_HOOK,
    outcome,
    code,
    operation_id: operationId ? boundedId(operationId) : undefined,
    attempts,
    is_split_turn: Boolean(isSplitTurn),
    input_bytes: inputBytes,
    runner_exit_confirmed: Boolean(runnerExitConfirmed),
    cancel_requested: Boolean(cancelRequested),
    termination,
    committed: committed === true,
    trigger,
  };
}

/**
 * Resolve the live Pi session id if present, else the trusted configured identity.
 * A throwing `getSessionId()` becomes a `CompactionHookError` (operational failure), not
 * an escaping exception.
 */
export function resolveSessionIdentity(event, ctx, fallback) {
  let live;
  try {
    live = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
  } catch (error) {
    throw new CompactionHookError("identity_unavailable", `ctx.sessionManager.getSessionId() threw: ${error?.message ?? error}`, error);
  }
  const candidates = [live, ctx?.sessionManager?.sessionId, event?.sessionId, event?.session_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return boundedId(candidate);
  }
  return boundedId(fallback);
}

/**
 * Assemble the bounded history to summarize from a Pi `CompactionPreparation`.
 *
 * `messagesToSummarize` and `turnPrefixMessages` are disjoint contiguous ranges
 * (`[boundaryStart, turnStartIndex)` and `[turnStartIndex, firstKeptEntryIndex)`), so
 * concatenating them preserves the split turn's prefix exactly once.
 */
export function collectPreparationHistory(preparation) {
  const history = [];
  if (Array.isArray(preparation?.messagesToSummarize)) history.push(...preparation.messagesToSummarize);
  if (preparation?.isSplitTurn && Array.isArray(preparation.turnPrefixMessages)) history.push(...preparation.turnPrefixMessages);
  return history;
}

/** Adapter-owned requester note. Never derived from model output. */
export function buildRequesterNote(event) {
  const parts = [`trigger=${event?.reason ?? "unknown"}`];
  if (event?.willRetry) parts.push("will_retry=true");
  if (typeof event?.customInstructions === "string" && event.customInstructions.length > 0) {
    parts.push(`custom_instructions=${event.customInstructions}`);
  }
  return parts.join(" ");
}

/**
 * Create the adapter. Pass `runner` to inject a recipe runner boundary; pass
 * `config.session_identity` for trusted identity. Without a config the extension is
 * INACTIVE: `handler` still returns `{cancel:true}` and `register()` refuses, so an
 * unconfigured adapter can never silently fall through to the built-in summarizer.
 *
 * Pass `recipeAuthority` (from `inspectRecipeAuthority`) with
 * `allowToolBearingRecipe: true` to acknowledge a recipe that grants the summarizer
 * real tool access; otherwise a tool-bearing recipe is refused.
 */
export function createPiCompactionExtension(options = {}) {
  const rawConfig = options.config;
  const configured = rawConfig !== null && rawConfig !== undefined;
  const config = configured ? validateCompactionConfig(rawConfig) : null;
  const sink = typeof options.sink === "function" ? options.sink : null;
  const recipeAuthority = options.recipeAuthority ?? null;
  const allowToolBearingRecipe = options.allowToolBearingRecipe === true;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  const service = createCompactionService({
    runner: options.runner ?? null,
    budget: config?.budget,
    now: options.now,
    timeoutMs: options.timeoutMs ?? config?.timeoutMs,
    maxAttempts: options.maxAttempts ?? config?.maxAttempts,
    abortGraceMs: options.abortGraceMs ?? config?.abortGraceMs,
  });

  const state = {
    sessionId: config?.session_identity ?? null,
    generation: 0,
    inflight: 0,
    registered: false,
    disposed: false,
    unregister: null,
    unregisterFns: [],
    commits: 0,
    lastOutcome: null,
    lastCommitted: null,
    lastCandidate: null,
  };

  function emit(observation) {
    state.lastOutcome = observation.outcome;
    if (!sink) return;
    try {
      sink(observation);
    } catch {
      // A sink failure must never change compaction correctness.
    }
  }

  /**
   * LIVE staleness check. Re-reads the actual session identity from the live Pi `ctx`
   * (never a cached value), bumps the bounded generation on change, and awaits an
   * optional async `options.isCurrent` hook instead of testing `Promise !== false`.
   * Called immediately before the run and again after every awaited validation.
   */
  async function liveIsCurrent(event, ctx, boundary) {
    if (state.disposed) return false;
    const live = resolveSessionIdentity(event, ctx, config.session_identity);
    if (live !== state.sessionId) {
      state.sessionId = live;
      state.generation += 1;
    }
    if (boundary.session_identity !== live || boundary.generation !== state.generation) return false;
    if (typeof options.isCurrent === "function") {
      let extra;
      try {
        extra = await options.isCurrent(boundary);
      } catch (error) {
        throw new CompactionHookError("is_current_unavailable", `isCurrent callback threw: ${error?.message ?? error}`, error);
      }
      if (extra === false) return false;
      // Re-read the ACTUAL identity/generation AFTER the awaited callback. The callback may
      // have switched the live session out from under us; a cached pre-await value must
      // never authorize a candidate for the old session.
      const after = resolveSessionIdentity(event, ctx, config.session_identity);
      if (after !== state.sessionId) {
        state.sessionId = after;
        state.generation += 1;
      }
      if (boundary.session_identity !== after || boundary.generation !== state.generation) return false;
    }
    return true;
  }

  async function handler(event, ctx) {
    if (!configured) {
      emit(toObservation({ outcome: "inactive", code: "not_configured", trigger: event?.reason }));
      return { cancel: true };
    }
    if (state.disposed) return { cancel: true };
    const preparation = event?.preparation;
    if (preparation === null || typeof preparation !== "object") {
      emit(toObservation({ outcome: "failed", code: "invalid_preparation", trigger: event?.reason }));
      return { cancel: true };
    }
    if (recipeAuthority && recipeAuthority.toolAccessUnconstrained === true && !allowToolBearingRecipe) {
      emit(toObservation({ outcome: "failed", code: "runner_authority_unconstrained", trigger: event?.reason }));
      return { cancel: true };
    }

    state.inflight += 1;
    let outcome;
    let identity;
    try {
      // The FIRST identity read is an operational call too: a throwing
      // `ctx.sessionManager.getSessionId()` must become a structured `{cancel:true}`
      // failure (`identity_unavailable`), never an escaping rejection that Pi catches and
      // falls through to the built-in summarizer. It is inside the try so the `finally`
      // keeps `inflight` accounting exact and no model call is made on a failed read.
      identity = resolveSessionIdentity(event, ctx, config.session_identity);
      if (identity !== state.sessionId) {
        state.sessionId = identity;
        state.generation += 1;
      }
      outcome = await service.run({
        sessionIdentity: identity,
        generation: state.generation,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        isSplitTurn: preparation.isSplitTurn,
        history: collectPreparationHistory(preparation),
        previousSummary: preparation.previousSummary,
        fileOps: preparation.fileOps,
        reason: event?.reason,
        requesterNote: buildRequesterNote(event),
        signal: event?.signal,
        isCurrent: (boundary) => liveIsCurrent(event, ctx, boundary),
      });
    } catch (error) {
      // An operational hook failure (e.g. `ctx.getSessionId()` throwing mid-validation)
      // must NOT reject out to Pi: the pinned runner would catch it and fall through to the
      // built-in summarizer. Convert it to an explicit structured cancellation instead.
      const code = error instanceof CompactionHookError ? error.code : "handler_error";
      emit(toObservation({ outcome: "failed", code, trigger: event?.reason, cancelRequested: false }));
      return { cancel: true };
    } finally {
      state.inflight -= 1;
    }

    // Re-confirm the live identity/generation AFTER the final adapter await AND after the
    // sink emit, immediately before a candidate could be returned. A session switch that
    // happened during the runner/model work must not yield an applicable candidate here.
    // The read itself is an operational call, so a throw is handled as a structured
    // failure rather than escaping to Pi.
    let identityDrifted = false;
    let finalCode = null;
    let finalIdentity = identity;
    try {
      finalIdentity = resolveSessionIdentity(event, ctx, config.session_identity);
      if (finalIdentity !== state.sessionId) {
        state.sessionId = finalIdentity;
        state.generation += 1;
      }
      identityDrifted =
        outcome.applicable === true &&
        (finalIdentity !== identity || state.generation !== outcome.boundary?.generation);
    } catch (error) {
      identityDrifted = true;
      finalCode = error instanceof CompactionHookError ? error.code : "handler_error";
    }

    emit(
      toObservation({
        outcome: identityDrifted ? (finalCode ? "failed" : "stale") : outcome.outcome,
        code: identityDrifted ? finalCode ?? "session_changed_before_return" : outcome.reason,
        operationId: outcome.operation_id,
        attempts: outcome.attempts,
        isSplitTurn: preparation.isSplitTurn,
        inputBytes: outcome.input_bytes,
        runnerExitConfirmed: outcome.runner_exit_confirmed,
        cancelRequested: outcome.cancel_requested,
        termination: outcome.termination,
        committed: false,
        trigger: event?.reason,
      }),
    );

    if (outcome.applicable === true && outcome.compaction && !identityDrifted) {
      // This is a CANDIDATE. Whether Pi commits it is proven only by the subsequent
      // `session_compact` event (see `commitHandler`), never by this return value. Record
      // the correlation facts a later commit proof must match.
      state.lastCandidate = {
        operation_id: outcome.operation_id ?? null,
        input_digest: outcome.input_digest ?? null,
        session_identity: outcome.boundary?.session_identity ?? identity,
        generation: outcome.boundary?.generation ?? state.generation,
        first_kept_entry_id: outcome.compaction.firstKeptEntryId,
        tokens_before: outcome.compaction.tokensBefore,
        summary_sha256: sha256(String(outcome.compaction.summary ?? "")),
      };
      return { compaction: outcome.compaction };
    }
    return { cancel: true };
  }

  /**
   * Pi `session_compact` is the commit proof: the framework has appended the compaction.
   * It emits a distinct `committed` observation and does NOT overwrite the candidate
   * outcome, so candidate-ready and committed stay separate facts.
   */
  function observeCommit(observation) {
    if (!sink) return observation;
    try {
      sink(observation);
    } catch {
      /* a throwing sink must not break the Pi lifecycle */
    }
    return observation;
  }

  /**
   * Pi `session_compact` is the commit proof. To report `committed: true` this handler
   * must correlate the framework's `compactionEntry` with the LAST candidate produced by
   * this adapter: same boundary (`firstKeptEntryId`), same `tokensBefore`, same summary
   * digest, and the same session identity. Any mismatch (including no candidate at all)
   * is reported as a plain observation with `committed: false` — an unrelated
   * `session_compact` cannot prove this operation committed.
   */
  function commitHandler(event, ctx) {
    const candidate = state.lastCandidate;
    const entry = event?.compactionEntry ?? (event && typeof event.summary === "string" ? event : null);
    if (!candidate || !entry || typeof entry.summary !== "string") {
      return observeCommit(
        toObservation({ outcome: "observed", code: candidate ? "unrelated_commit" : "no_candidate", committed: false, trigger: event?.reason }),
      );
    }
    let live = candidate.session_identity;
    try {
      live = resolveSessionIdentity(event, ctx, candidate.session_identity);
    } catch {
      live = null;
    }
    const matches =
      entry.firstKeptEntryId === candidate.first_kept_entry_id &&
      entry.tokensBefore === candidate.tokens_before &&
      sha256(entry.summary) === candidate.summary_sha256 &&
      (live === null || live === candidate.session_identity);
    if (!matches) {
      return observeCommit(toObservation({ outcome: "observed", code: "unrelated_commit", committed: false, trigger: event?.reason }));
    }
    state.commits += 1;
    state.lastCommitted = now();
    return observeCommit(
      toObservation({ outcome: "committed", code: "commit_confirmed", committed: true, operationId: candidate.operation_id, trigger: event?.reason }),
    );
  }

  function register(pi) {
    if (!configured) {
      throw new Error("refusing to register an unconfigured compaction extension; pass config.session_identity");
    }
    if (state.registered) return state.unregister;
    if (!pi || typeof pi.on !== "function") throw new Error("register(pi) requires a Pi extension API with .on()");
    const before = pi.on(COMPACTION_HOOK, handler);
    const after = pi.on(COMPACTION_COMMIT_HOOK, commitHandler);
    state.unregisterFns = [before, after].filter((fn) => typeof fn === "function");
    state.unregister = () => {
      for (const fn of state.unregisterFns) fn();
      state.unregisterFns = [];
    };
    state.registered = true;
    return state.unregister;
  }

  /**
   * Negative-control helper. `returnEmpty` deliberately returns `{}` (rather than
   * `{cancel:true}`) so a test can demonstrate that Pi's built-in summarizer DOES run on
   * an empty result. It is never used by the production path.
   */
  async function returnEmpty() {
    return {};
  }

  function dispose() {
    state.disposed = true;
    if (typeof state.unregister === "function") {
      state.unregister();
      state.unregister = null;
    }
    state.unregisterFns = [];
    state.registered = false;
  }

  return {
    version: COMPACTION_EXTENSION_VERSION,
    serviceVersion: COMPACTION_SERVICE_VERSION,
    hook: COMPACTION_HOOK,
    commitHook: COMPACTION_COMMIT_HOOK,
    configured,
    config,
    recipeAuthority,
    allowToolBearingRecipe,
    service,
    state,
    handler,
    commitHandler,
    returnEmpty,
    register,
    dispose,
  };
}

/** Pi extension entrypoint: `pi.on("session_before_compact", ...)` on construction. */
export default function piCompactionExtension(pi, options = {}) {
  const extension = createPiCompactionExtension(options);
  if (pi && typeof pi.on === "function" && extension.configured) extension.register(pi);
  return extension;
}
