/**
 * Bounded compaction service.
 *
 * This module is the adapter-owned half of the accepted bounded-compaction capability.
 * It is deliberately separate from Pi so it can be exercised with an INJECTED recipe
 * runner and no live inference:
 *
 *   - The ADAPTER owns session identity, history digest, boundary selection
 *     (`first_kept_entry_id` / `tokens_before`), input budget, cancellation, output
 *     validation, and application fields.
 *   - The RECIPE RUNNER (injected) is only allowed to supply a summary CANDIDATE for a
 *     bounded, already-selected history slice. It never owns identity, boundary, budget,
 *     or application.
 *
 * Safety invariants enforced here:
 *
 *   1. Bounded operation identity. Each frozen boundary produces one bounded
 *      `operation_id`; a boundary is claimed at most once (`duplicate_boundary`).
 *   2. At most ONE fallback attempt per frozen boundary (`maxAttempts` is capped at 2).
 *   3. Cancellation is COMPOSED, not faked: the adapter creates an internal
 *      `AbortController`, forwards the caller-owned hook signal into it, and aborts only
 *      that derived controller (an `AbortSignal` cannot be aborted). `requested`,
 *      `confirmed` and `uncertain` termination are three separate facts
 *      (`cancel_requested` / `runner_exit_confirmed` / `termination`). A runner that
 *      ignores the derived signal is reported as `uncertain`, never as success, and the
 *      caller's own signal is left untouched.
 *   4. A late result after cancellation or a source-session / boundary change is
 *      suppressed by `isCurrent(boundary)` immediately before an applicable result is
 *      returned (`stale`).
 *   5. The model's `passthrough` binding must byte-match the adapter-frozen values;
 *      a mismatch is rejected (`binding_mismatch`) and never applied.
 *   6. Oversized input is refused by the adapter (`budget_exceeded`) rather than passed
 *      to the model; oversized output is refused (`output_cap_exceeded`).
 *   7. Late-result rejection (`isCurrent` before apply) and source-session identity
 *      changes (`generation`) are DISTINCT from confirmed runner exit; none is inferred
 *      from another.
 *   8. `inspectRecipeAuthority` reports the tool authority a recipe declares, because
 *      recipe prose that forbids tools is NOT enforcement.
 *   9. The digest binds EVERY adapter-supplied input (history, prior summary, requester
 *      note / custom instructions, file operations, and bounded-history truncation), and
 *      the prior summary is re-supplied on EVERY attempt — a fallback cannot silently
 *      drop accepted prior state. Truncated history is surfaced as `history_truncation`.
 *  9a. LOSSY INPUT IS REFUSED, NOT SUMMARIZED AROUND. If normalization had to drop
 *      messages, clip message or tool-argument text, discard file operations, or skip an
 *      unrecognized content block, the run stops with `lossy_input` BEFORE the runner
 *      runs. Truncation metadata alone does not make application safe: the service never
 *      advances an (unchanged) `firstKeptEntryId` over content it did not summarize.
 *  10. The service returns a CANDIDATE (`candidate_ready`), never a commit. Only Pi's
 *      `session_compact` event proves the transcript was appended; `committed` is false
 *      here by construction.
 *
 * Canonical encoding: Pi's native Goose recipe renderer interpolates `--params` values
 * verbatim into a YAML block scalar, so the adapter must hand the runner CANONICAL
 * SINGLE-LINE JSON (see `encodeCanonicalJson`). A raw LF/CR/NEL/LS/PS/TAB in an
 * interpolated value either fails native rendering or can break out of the scalar and
 * inject recipe fields; `assertInterpolatable` refuses those values before a run.
 *
 * Staged wiring state: the real Goose invocation (`createGooseRecipeRunner`) is
 * implemented against the inspected Goose 1.57.0 CLI contract (`run --recipe ...
 * --params KEY=VALUE --no-session --quiet --no-profile --max-turns 4 --output-format json`)
 * and spawns an argv array, never a shell string. Its stdout is parsed by the strict
 * `extractGooseCandidate` native-envelope extractor, qualified against captured
 * fixtures (not a fresh model run); the launcher must still inject a qualified runner
 * before activation.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { load as loadRecipeYaml } from "./vendor-js-yaml.mjs";

export const COMPACTION_SERVICE_VERSION = 1;
export const ID_MAX_LENGTH = 256;
export const MAX_HISTORY_MESSAGES = 4096;
export const MAX_MESSAGE_TEXT = 16384;
export const MAX_ATTEMPTS = 2;
export const DEFAULT_ABORT_GRACE_MS = 250;
export const DEFAULT_BUDGET = Object.freeze({
  max_input_bytes: 65536,
  max_summary_tokens: 2048,
  max_output_bytes: 262144,
});
export const COMPACTION_REASONS = Object.freeze(["manual", "threshold", "overflow"]);
/** Runner failures that are eligible for the single fallback attempt. */
export const RETRYABLE_FAILURES = Object.freeze([
  "runner_error",
  "runner_paused",
  "runner_protocol",
  "malformed_candidate",
  "output_cap_exceeded",
  "candidate_failed",
]);

// ---------------------------------------------------------------------------
// Canonical single-line JSON encoding (adapter-side refusal contract)
// ---------------------------------------------------------------------------

export class ParamEncodeError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ParamEncodeError";
    this.code = code;
  }
}

const FORBIDDEN_RAW = /[\u000A\u000D\u0085\u2028\u2029\t]/;
const SEP_NAMES = new Map([
  ["\n", "LF (U+000A)"],
  ["\r", "CR (U+000D)"],
  ["\u0085", "NEL (U+0085)"],
  ["\u2028", "LINE SEPARATOR (U+2028)"],
  ["\u2029", "PARAGRAPH SEPARATOR (U+2029)"],
  ["\t", "TAB (U+0009)"],
]);
function sepName(ch) {
  return SEP_NAMES.get(ch) || `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Canonical single-line JSON: `JSON.stringify(value)` with raw NEL/LS/PS escaped.
 * `JSON.stringify` already escapes LF/CR/TAB but leaves NEL/LS/PS raw; the native YAML
 * parser still treats those as line breaks, so the adapter closes the gap here.
 */
export function encodeCanonicalJson(value) {
  const s = JSON.stringify(value);
  if (s === undefined) throw new ParamEncodeError("unencodable_value", "value has no JSON representation");
  const escaped = s.replace(/\u0085/g, "\\u0085").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  if (FORBIDDEN_RAW.test(escaped)) {
    const m = FORBIDDEN_RAW.exec(escaped);
    throw new ParamEncodeError("raw_separator_after_encode", `encoder produced a raw ${sepName(m[0])} at index ${m.index}`);
  }
  return escaped;
}

/** Encode a parameter value for native interpolation. `kind` is "json" or "text". */
export function encodeParam(value, kind = "json") {
  if (kind === "json") return encodeCanonicalJson(value);
  if (kind === "text") {
    if (typeof value !== "string") throw new ParamEncodeError("text_not_string", `expected string, got ${typeof value}`);
    return encodeCanonicalJson(value);
  }
  throw new ParamEncodeError("bad_kind", `unknown kind ${JSON.stringify(kind)}`);
}

/** Refuse any value containing a raw YAML line-break separator or TAB. */
export function assertInterpolatable(s, label = "param") {
  if (typeof s !== "string") throw new ParamEncodeError("not_a_string", `${label} must be a string before interpolation`);
  const m = FORBIDDEN_RAW.exec(s);
  if (m) {
    throw new ParamEncodeError(
      "multiline_refused",
      `${label} contains a raw ${sepName(m[0])} at index ${m.index}; adapter must supply canonical single-line JSON`,
    );
  }
  return s;
}

/** True iff `s` is canonical single-line JSON. */
export function isCanonicalSingleLineJson(s) {
  if (typeof s !== "string") return false;
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return false;
  }
  try {
    return encodeCanonicalJson(parsed) === s;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function boundedId(value, max = ID_MAX_LENGTH) {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max);
}

function codepointSlice(s, max) {
  if (s.length <= max) return s;
  return `${[...s].slice(0, max).join("")}…`;
}

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4);
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function toSet(value) {
  if (value instanceof Set) return new Set([...value]);
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

/**
 * Normalize Pi's `FileOperations` (`{read,written,edited}` Sets) into the
 * `CompactionDetails` shape (`{readFiles,modifiedFiles}`). Files that were both read
 * and modified count as modified, matching Pi's `computeFileLists`.
 */
export function computeFileDetailsDetailed(fileOps, { maxFiles = 2048 } = {}) {
  const read = toSet(fileOps?.read);
  const modified = new Set([...toSet(fileOps?.written), ...toSet(fileOps?.edited)]);
  const readFiles = [...read].filter((p) => typeof p === "string" && !modified.has(p)).sort();
  const modifiedFiles = [...modified].filter((p) => typeof p === "string").sort();
  const keptRead = readFiles.slice(0, maxFiles);
  const keptModified = modifiedFiles.slice(0, maxFiles);
  const dropped = readFiles.length - keptRead.length + (modifiedFiles.length - keptModified.length);
  return { readFiles: keptRead, modifiedFiles: keptModified, dropped };
}

/** Pi `CompactionDetails` shape (`{readFiles, modifiedFiles}`); see `computeFileDetailsDetailed` for loss reporting. */
export function computeFileDetails(fileOps, options) {
  const { readFiles, modifiedFiles } = computeFileDetailsDetailed(fileOps, options);
  return { readFiles, modifiedFiles };
}

// ---------------------------------------------------------------------------
// History normalization (bounded)
// ---------------------------------------------------------------------------

const MAX_TOOL_ARG_TEXT = 2048;

/** Bounded string slice plus whether it was actually truncated. */
function boundedString(value, max) {
  if (value === undefined) return { text: "", clipped: false };
  let s;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = "[unserializable]";
  }
  const full = String(s ?? "");
  return { text: codepointSlice(full, max), clipped: [...full].length > max };
}

/**
 * Extract bounded text + tool facts from a Pi content value.
 *
 * Real Pi sessions use `toolCall` blocks (`{type:"toolCall",id,name,arguments}`) and
 * `toolResult` blocks (`{type:"toolResult",toolCallId,toolName,content,isError}`) — NOT
 * the Anthropic `tool_use`/`tool_result` spellings. Both are handled so a real tool call
 * is never silently normalized to empty text. EVERY tool-call id in a message is kept
 * (`toolCallIds`), not just the first, and any clipping or unrecognized content block is
 * reported (`clipped` / `unsupported`) so a caller can refuse to apply a summary over
 * silently omitted history instead of advancing an unchanged boundary over it.
 */
function extractContent(content, maxText) {
  const base = { text: "", toolName: null, toolCallId: null, toolCallIds: [], isError: false, clipped: false, unsupported: [] };
  if (typeof content === "string") {
    const { text, clipped } = boundedString(content, maxText);
    return { ...base, text, clipped };
  }
  if (Array.isArray(content)) {
    const parts = [];
    const toolCallIds = [];
    const unsupported = [];
    let toolName = null;
    let isError = false;
    let clipped = false;
    for (const block of content) {
      if (typeof block === "string") {
        const b = boundedString(block, maxText);
        clipped = clipped || b.clipped;
        parts.push(b.text);
        continue;
      }
      if (block === null || typeof block !== "object") {
        if (block !== null && block !== undefined) unsupported.push(typeof block);
        continue;
      }
      const type = block.type;
      if (type === "toolCall" || type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : null;
        toolName = toolName ?? name;
        if (id && !toolCallIds.includes(id)) toolCallIds.push(id);
        const args = boundedString(block.arguments, MAX_TOOL_ARG_TEXT);
        clipped = clipped || args.clipped;
        parts.push(`[tool_use ${name}${id ? ` id=${id}` : ""}]${args.text ? ` ${args.text}` : ""}`);
      } else if (type === "toolResult" || type === "tool_result") {
        const id = typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : null;
        const name = typeof block.toolName === "string" ? block.toolName : typeof block.name === "string" ? block.name : null;
        if (id && !toolCallIds.includes(id)) toolCallIds.push(id);
        if (name) toolName = toolName ?? name;
        const inner = extractContent(block.content ?? block.text ?? "", maxText);
        clipped = clipped || inner.clipped;
        parts.push(`[tool_result${id ? ` id=${id}` : ""}${name ? ` name=${name}` : ""}${block.isError ? " error" : ""}]${inner.text ? ` ${inner.text}` : ""}`);
        if (block.isError === true) isError = true;
      } else if (type === "thinking" && typeof block.thinking === "string") {
        const b = boundedString(block.thinking, maxText);
        clipped = clipped || b.clipped;
        parts.push(`[thinking] ${b.text}`);
      } else if (typeof block.text === "string") {
        const b = boundedString(block.text, maxText);
        clipped = clipped || b.clipped;
        parts.push(b.text);
      } else if (typeof block.content === "string") {
        const b = boundedString(block.content, maxText);
        clipped = clipped || b.clipped;
        parts.push(b.text);
      } else {
        unsupported.push(typeof type === "string" ? type : "unknown");
      }
    }
    const joined = boundedString(parts.join("\n"), maxText);
    return {
      text: joined.text,
      toolName,
      toolCallId: toolCallIds[0] ?? null,
      toolCallIds,
      isError,
      clipped: clipped || joined.clipped,
      unsupported,
    };
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      const b = boundedString(content.text, maxText);
      return { ...base, text: b.text, clipped: b.clipped };
    }
    if (typeof content.type === "string") return { ...base, unsupported: [content.type] };
  }
  return { ...base };
}

/** Convert one Pi message-like entry into a bounded `{role,text,tool_name?,tool_call_id?,is_error?}` row. */
export function toHistoryMessage(entry, maxText = MAX_MESSAGE_TEXT) {
  if (entry == null) return null;
  const source = entry.message && typeof entry.message === "object" ? entry.message : entry;
  const role = typeof source.role === "string" ? source.role : typeof entry.type === "string" ? entry.type : null;
  const raw = source.content ?? source.text ?? "";
  const { text, toolName, toolCallIds, isError, clipped, unsupported } = extractContent(raw, maxText);
  let name = toolName;
  if (!name && typeof source.toolName === "string") name = source.toolName;
  if (!name && typeof source.name === "string" && role === "tool") name = source.name;
  const callIds = [...toolCallIds];
  for (const key of ["toolCallId", "tool_call_id", "callId"]) {
    if (typeof source[key] === "string" && !callIds.includes(source[key])) callIds.push(source[key]);
  }
  if (Array.isArray(source.toolCallIds)) {
    for (const id of source.toolCallIds) if (typeof id === "string" && !callIds.includes(id)) callIds.push(id);
  }
  const callId = callIds[0] ?? null;
  const error = isError === true || source.isError === true;
  if (role === null && name === null && callIds.length === 0 && !text) return null;
  const message = { role: role ?? "tool", text };
  if (name) message.tool_name = name;
  if (callId) message.tool_call_id = callId;
  if (callIds.length > 1) message.tool_call_ids = callIds;
  if (error) message.is_error = true;
  if (clipped) message.clipped = true;
  if (unsupported.length > 0) message.unsupported = unsupported;
  return message;
}

/**
 * Normalize history AND report what was bounded away, so the adapter can refuse to apply
 * a summary over incompletely normalized input instead of silently advancing the frozen
 * boundary over content it never saw. A `toolCall` with no matching `toolResult` is
 * marked `unresolved`.
 */
export function normalizeHistoryDetailed(entries, { maxMessages = MAX_HISTORY_MESSAGES, maxText = MAX_MESSAGE_TEXT } = {}) {
  const input = Array.isArray(entries) ? entries : [];
  const messages = [];
  let textClipped = 0;
  let unsupportedContent = 0;
  for (const entry of input.slice(0, maxMessages)) {
    const message = toHistoryMessage(entry, maxText);
    if (!message) continue;
    if (message.clipped) textClipped += 1;
    if (Array.isArray(message.unsupported)) unsupportedContent += message.unsupported.length;
    messages.push(message);
  }
  const calls = new Map();
  const results = new Set();
  messages.forEach((m, index) => {
    const ids = Array.isArray(m.tool_call_ids) ? m.tool_call_ids : m.tool_call_id ? [m.tool_call_id] : [];
    for (const id of ids) {
      if (m.role === "assistant") calls.set(id, index);
      else results.add(id);
    }
  });
  const unresolved = [...calls.keys()].filter((id) => !results.has(id));
  for (const id of unresolved) {
    const m = messages[calls.get(id)];
    if (!m) continue;
    m.unresolved = true;
    m.unresolved_tool_call_ids = m.unresolved_tool_call_ids ?? [];
    m.unresolved_tool_call_ids.push(id);
  }
  const droppedMessages = Math.max(0, input.length - maxMessages);
  const lossy = droppedMessages > 0 || textClipped > 0 || unsupportedContent > 0;
  return {
    messages,
    lossy,
    truncation: {
      input_messages: input.length,
      kept_messages: messages.length,
      dropped_messages: droppedMessages,
      text_clipped_messages: textClipped,
      unsupported_content: unsupportedContent,
      unresolved_tool_calls: unresolved.length,
    },
  };
}

export function normalizeHistory(entries, options) {
  return normalizeHistoryDetailed(entries, options).messages;
}

// ---------------------------------------------------------------------------
// Candidate validation + rendering
// ---------------------------------------------------------------------------

const ARRAY_OF_STRING = ["goals", "constraints", "completed", "pending"];

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDecision(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.decision === "string" &&
    typeof value.rationale === "string" &&
    isNonNegativeInt(value.position) &&
    (value.superseded_by_position === null || value.superseded_by_position === undefined || isNonNegativeInt(value.superseded_by_position))
  );
}

function isContradiction(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.topic === "string" &&
    typeof value.earlier === "string" &&
    typeof value.newer === "string" &&
    ["newer_wins_flagged", "unresolved", "escalate"].includes(value.resolution)
  );
}

function isEvidence(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    ["file", "test", "command", "tool_result", "claim"].includes(value.kind) &&
    typeof value.ref === "string" &&
    typeof value.observed_result === "string" &&
    (value.trusted === undefined || typeof value.trusted === "boolean")
  );
}

function isUncertainty(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.item === "string" &&
    typeof value.why_unresolved === "string" &&
    (value.ref === undefined || typeof value.ref === "string")
  );
}

/**
 * Validate a parsed summary candidate against the frozen success schema and the
 * adapter-owned `passthrough` binding. Never throws; returns a discriminated result.
 */
export function validateCandidate(candidate, boundary) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, code: "malformed_candidate", detail: "candidate is not a JSON object" };
  }
  if (candidate.status === "failed") {
    const code = typeof candidate.code === "string" ? candidate.code : "internal_error";
    return { ok: false, code: "candidate_failed", detail: `model refused: ${code}`, refusalCode: code };
  }
  if (candidate.status !== "ok") return { ok: false, code: "malformed_candidate", detail: "status is not 'ok'" };
  for (const field of ARRAY_OF_STRING) {
    if (!isStringArray(candidate[field])) return { ok: false, code: "malformed_candidate", detail: `${field} must be an array of strings` };
  }
  for (const field of ["decisions", "contradictions", "evidence", "uncertainty"]) {
    if (candidate[field] !== undefined && !Array.isArray(candidate[field])) {
      return { ok: false, code: "malformed_candidate", detail: `${field} must be an array` };
    }
  }
  if (!(candidate.decisions ?? []).every(isDecision)) return { ok: false, code: "malformed_candidate", detail: "invalid decision entry" };
  if (!(candidate.contradictions ?? []).every(isContradiction)) return { ok: false, code: "malformed_candidate", detail: "invalid contradiction entry" };
  if (!(candidate.evidence ?? []).every(isEvidence)) return { ok: false, code: "malformed_candidate", detail: "invalid evidence entry" };
  if (!(candidate.uncertainty ?? []).every(isUncertainty)) return { ok: false, code: "malformed_candidate", detail: "invalid uncertainty entry" };
  if (candidate.acceptance_inferred !== false) return { ok: false, code: "malformed_candidate", detail: "acceptance_inferred must be false" };

  const p = candidate.passthrough;
  if (p === null || typeof p !== "object") return { ok: false, code: "malformed_candidate", detail: "missing passthrough binding" };
  const mismatch = (field, expected) => p[field] !== expected;
  if (
    mismatch("session_identity", boundary.session_identity) ||
    mismatch("input_digest", boundary.input_digest) ||
    mismatch("first_kept_entry_id", boundary.first_kept_entry_id) ||
    mismatch("tokens_before", boundary.tokens_before)
  ) {
    return { ok: false, code: "binding_mismatch", detail: "model altered adapter-owned passthrough fields" };
  }
  return { ok: true, candidate };
}

/** Deterministically render a validated candidate into the compaction `summary` string. */
export function renderSummaryText(candidate, boundary) {
  const lines = [];
  lines.push("# Compaction summary (model candidate, adapter-validated)");
  lines.push(`session: ${boundary.session_identity}`);
  lines.push(`tokens_before: ${boundary.tokens_before}`);
  lines.push(`input_digest: ${boundary.input_digest}`);
  lines.push(`is_split_turn: ${boundary.is_split_turn}`);
  const list = (title, items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    lines.push(`## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  };
  list("Goals", candidate.goals);
  list("Constraints", candidate.constraints);
  if (candidate.decisions?.length) {
    lines.push("## Decisions");
    for (const d of candidate.decisions) {
      const superseded = d.superseded_by_position === null || d.superseded_by_position === undefined ? "" : `, superseded by position ${d.superseded_by_position}`;
      lines.push(`- ${d.decision} — ${d.rationale} (position ${d.position}${superseded})`);
    }
  }
  if (candidate.contradictions?.length) {
    lines.push("## Contradictions");
    for (const c of candidate.contradictions) lines.push(`- ${c.topic}: earlier=${c.earlier}; newer=${c.newer}; resolution=${c.resolution}`);
  }
  list("Completed", candidate.completed);
  list("Pending", candidate.pending);
  if (candidate.evidence?.length) {
    lines.push("## Evidence (claims are not acceptance)");
    for (const e of candidate.evidence) lines.push(`- [${e.trusted === true ? "observed" : "claim"}] ${e.kind}: ${e.ref} -> ${e.observed_result}`);
  }
  if (candidate.uncertainty?.length) {
    lines.push("## Uncertainty");
    for (const u of candidate.uncertainty) lines.push(`- ${u.item}: ${u.why_unresolved}${u.ref ? ` (${u.ref})` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

const ABORTED = Symbol("aborted");

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Compose an INTERNAL AbortController with the caller-owned hook signal and the adapter
 * timeout. An `AbortSignal` has no `.abort()`; the adapter therefore never tries to
 * abort the caller's signal — it forwards the caller's abort *event* into its own
 * controller and aborts that derived controller only. Three facts are kept distinct:
 *   - `requested`  — an abort was asked for (external hook signal or timeout);
 *   - `confirmed`  — the runner promise actually settled after the request;
 *   - `uncertain`  — the runner ignored the derived signal (reported, never as success).
 * `external.aborted` remains false even after an adapter timeout, because the adapter
 * does not own (and cannot abort) the caller's controller.
 */
function combineSignals(external, timeoutMs) {
  const controller = new AbortController();
  const sources = { external: false, timeout: false };
  let timer = null;
  const onExternal = () => {
    sources.external = true;
    controller.abort();
  };
  if (external) {
    if (external.aborted) {
      sources.external = true;
      controller.abort();
    } else {
      external.addEventListener("abort", onExternal, { once: true });
    }
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      sources.timeout = true;
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }
  return {
    signal: controller.signal,
    sources,
    reason() {
      if (sources.external) return "cancelled";
      if (sources.timeout) return "timeout";
      return null;
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternal);
    },
  };
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Invoke the injected runner once. Returns `{ok, value, error, aborted, exitConfirmed, invoked, ms}`.
 * `exitConfirmed` is true only when the runner promise actually settled; a runner that
 * ignores the abort signal is reported as not confirmed rather than as success.
 */
async function invokeRunner({ runner, request, signal, now, abortGraceMs }) {
  if (signal.aborted) {
    return { invoked: false, ok: false, error: normalizeError(new Error("aborted before start")), aborted: true, exitConfirmed: false, termination: "not_started", ms: 0 };
  }
  const started = now();
  let settled = false;
  const outcome = Promise.resolve()
    .then(() => runner(request, { signal }))
    .then(
      (value) => {
        settled = true;
        return { ok: true, value, error: undefined };
      },
      (error) => {
        settled = true;
        return { ok: false, value: undefined, error: normalizeError(error) };
      },
    );
  const raced = await Promise.race([outcome, waitForAbort(signal).then(() => ABORTED)]);
  if (raced !== ABORTED) {
    const result = await outcome;
    return { invoked: true, ...result, aborted: false, exitConfirmed: true, termination: "confirmed", ms: now() - started };
  }
  // The derived signal aborted. Distinguish a runner that honoured it (settled within the
  // grace window → confirmed) from one that ignored it (still pending → uncertain).
  const confirmed = await Promise.race([outcome.then(() => true), delay(abortGraceMs).then(() => false)]);
  const exitConfirmed = confirmed && settled;
  return {
    invoked: true,
    ok: false,
    value: undefined,
    error: normalizeError(new Error("aborted")),
    aborted: true,
    exitConfirmed,
    termination: exitConfirmed ? "confirmed" : "uncertain",
    ms: now() - started,
  };
}

function classifyRunnerError(error) {
  const code = error?.code;
  if (code === "PENDING" || code === "PAUSED" || code === "RUNNER_PAUSED") return { reason: "runner_paused", detail: error?.message ?? "runner paused" };
  return { reason: "runner_error", detail: error?.message ? codepointSlice(String(error.message), 500) : "runner threw" };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function normalizeBudget(budget) {
  const b = budget && typeof budget === "object" ? budget : {};
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
  return {
    max_input_bytes: positive(b.max_input_bytes, DEFAULT_BUDGET.max_input_bytes),
    max_summary_tokens: positive(b.max_summary_tokens, DEFAULT_BUDGET.max_summary_tokens),
    max_output_bytes: positive(b.max_output_bytes, DEFAULT_BUDGET.max_output_bytes),
  };
}

function buildRequest({ operationId, boundary, historyJson, requesterNote, previousSummaryJson, reason, attempt, budget }) {
  return {
    operation_id: operationId,
    session_identity: boundary.session_identity,
    input_digest: boundary.input_digest,
    first_kept_entry_id: boundary.first_kept_entry_id,
    tokens_before: boundary.tokens_before,
    is_split_turn: boundary.is_split_turn,
    has_previous_summary: boundary.has_previous_summary,
    reason,
    attempt,
    budget,
    history_json: historyJson,
    requester_note: requesterNote,
    previous_summary_json: previousSummaryJson,
  };
}

export function createCompactionService(options = {}) {
  const runner = options.runner ?? null;
  const budget = normalizeBudget(options.budget);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const maxAttempts = Math.min(Math.max(1, Number(options.maxAttempts) || MAX_ATTEMPTS), MAX_ATTEMPTS);
  const abortGraceMs = Number.isFinite(options.abortGraceMs) ? Math.max(0, options.abortGraceMs) : DEFAULT_ABORT_GRACE_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 0;
  const defaultIsCurrent = typeof options.isCurrent === "function" ? options.isCurrent : () => true;
  const claimed = new Set();
  const stats = { runs: 0, runnerCalls: 0, candidateReady: 0, cancelled: 0, timedOut: 0, failed: 0, stale: 0 };

  function failure(reason, detail, extra = {}) {
    stats.failed += 1;
    return { outcome: "failed", applicable: false, reason, detail, ...extra };
  }

  async function run(input = {}) {
    stats.runs += 1;
    const {
      sessionIdentity,
      generation = 0,
      firstKeptEntryId,
      tokensBefore,
      isSplitTurn = false,
      history = [],
      previousSummary,
      reason,
      requesterNote,
      fileOps,
      signal,
      isCurrent = defaultIsCurrent,
    } = input;

    if (typeof sessionIdentity !== "string" || sessionIdentity.length === 0 || sessionIdentity.length > ID_MAX_LENGTH) {
      return failure("invalid_preparation", "sessionIdentity must be a non-empty bounded string");
    }
    if (typeof firstKeptEntryId !== "string" || firstKeptEntryId.length === 0 || firstKeptEntryId.length > ID_MAX_LENGTH) {
      return failure("invalid_preparation", "firstKeptEntryId must be a non-empty bounded string");
    }
    if (!isNonNegativeInt(tokensBefore)) return failure("invalid_preparation", "tokensBefore must be a non-negative integer");
    if (!isNonNegativeInt(generation)) return failure("invalid_preparation", "generation must be a non-negative integer");
    if (!COMPACTION_REASONS.includes(reason)) return failure("invalid_preparation", `reason must be one of ${COMPACTION_REASONS.join(", ")}`);
    if (runner === null || typeof runner !== "function") return failure("runner_missing", "no recipe runner was injected");
    if (signal !== undefined && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
      return failure("invalid_preparation", "signal must be an AbortSignal");
    }
    // Cancellation is reported truthfully at the earliest break: a hook signal that is
    // already aborted when we are invoked is a cancellation, never a runner error.
    if (signal?.aborted) {
      stats.cancelled += 1;
      return {
        outcome: "cancelled",
        applicable: false,
        reason: "cancelled",
        detail: "hook signal was already aborted before the attempt started",
        cancel_requested: true,
        runner_exit_confirmed: false,
        termination: "not_started",
        attempts: 0,
        spots: [],
      };
    }

    const { messages, truncation, lossy } = normalizeHistoryDetailed(history);
    const hasPreviousSummary = typeof previousSummary === "string" && previousSummary.length > 0;
    const requesterNoteText = typeof requesterNote === "string" && requesterNote.length > 0 ? requesterNote : "(none)";
    const fileDetailsDetailed = computeFileDetailsDetailed(input.fileOps);
    const fileDetails = { readFiles: fileDetailsDetailed.readFiles, modifiedFiles: fileDetailsDetailed.modifiedFiles };
    // Incomplete normalization (dropped messages, clipped text/tool arguments, dropped
    // file ops, unsupported content) is NEVER applied: truncation metadata alone is not
    // consent to advance an unchanged boundary over content the model never saw. The
    // refusal is enforced BEFORE the runner (and before the boundary is claimed), so no
    // model call and no fallback attempt is ever made for known-lossy input.
    const lossyRefusal = lossy || fileDetailsDetailed.dropped > 0;
    const lossyDetail = `input was incompletely normalized (${truncation.dropped_messages} message(s) dropped, ${truncation.text_clipped_messages} clipped, ${truncation.unsupported_content} unsupported block(s), ${fileDetailsDetailed.dropped} file op(s) dropped); refusing to advance the boundary`;
    // The digest binds ALL adapter-supplied state, not just history: the prior summary, the
    // requester note / custom instructions, the file operations, and any bounded-history
    // truncation. This keeps the frozen boundary honest — a later attempt cannot silently
    // drop the prior summary and still match the same digest.
    const bindingCore = {
      session_identity: sessionIdentity,
      first_kept_entry_id: firstKeptEntryId,
      tokens_before: tokensBefore,
      is_split_turn: Boolean(isSplitTurn),
      budget: { max_input_bytes: budget.max_input_bytes, max_summary_tokens: budget.max_summary_tokens },
      previous_summary: hasPreviousSummary ? previousSummary : null,
      requester_note: requesterNoteText,
      file_ops: { read_files: fileDetails.readFiles, modified_files: fileDetails.modifiedFiles },
      history_truncation: truncation,
      history: messages,
    };
    // What the model receives for the history slice (no self-reference to the digest; the
    // digest is inserted after it is computed).
    const modelSlice = {
      session_identity: sessionIdentity,
      first_kept_entry_id: firstKeptEntryId,
      tokens_before: tokensBefore,
      is_split_turn: Boolean(isSplitTurn),
      budget: { max_input_bytes: budget.max_input_bytes, max_summary_tokens: budget.max_summary_tokens },
      history_truncation: truncation,
      history: messages,
    };

    let historyJson;
    let previousSummaryJson = null;
    let requesterNoteJson;
    let inputDigest;
    try {
      const coreJson = encodeCanonicalJson(bindingCore);
      assertInterpolatable(coreJson, "history_json");
      inputDigest = sha256(coreJson);
      historyJson = encodeCanonicalJson({ ...modelSlice, input_digest: inputDigest });
      assertInterpolatable(historyJson, "history_json");
      requesterNoteJson = encodeCanonicalJson(requesterNoteText);
      assertInterpolatable(requesterNoteJson, "requester_note");
      if (hasPreviousSummary) {
        previousSummaryJson = encodeCanonicalJson(previousSummary);
        assertInterpolatable(previousSummaryJson, "previous_summary_json");
      }
    } catch (error) {
      return failure("invalid_preparation", `could not encode history slice: ${error.message}`);
    }
    const inputBytes =
      Buffer.byteLength(historyJson, "utf8") +
      Buffer.byteLength(requesterNoteJson, "utf8") +
      (previousSummaryJson ? Buffer.byteLength(previousSummaryJson, "utf8") : 0);
    const operationId = boundedId(`cmp1:${sha256([sessionIdentity, String(generation), firstKeptEntryId, inputDigest].join("\n"))}`);

    const boundary = {
      operation_id: operationId,
      session_identity: sessionIdentity,
      generation,
      first_kept_entry_id: firstKeptEntryId,
      tokens_before: tokensBefore,
      is_split_turn: Boolean(isSplitTurn),
      has_previous_summary: hasPreviousSummary,
      history_truncation: truncation,
      input_digest: inputDigest,
      input_bytes: inputBytes,
    };

    if (inputBytes > budget.max_input_bytes) {
      return failure("budget_exceeded", `history slice ${inputBytes} B exceeds ${budget.max_input_bytes} B`, {
        operation_id: operationId,
        input_digest: inputDigest,
        input_bytes: inputBytes,
      });
    }

    // LOSSY INPUT IS REFUSED BEFORE THE RUNNER RUNS, not summarized around. If
    // normalization had to drop messages, clip message or tool-argument text, discard file
    // operations, or skip an unrecognized content block, no model/fallback attempt is
    // made. Nothing was launched, so termination is `not_started` and no process exit is
    // claimed; the frozen operation identity and truncation diagnostics are still reported.
    if (lossyRefusal) {
      return failure("lossy_input", lossyDetail, {
        operation_id: operationId,
        input_digest: inputDigest,
        input_bytes: inputBytes,
        history_truncation: truncation,
        lossy: true,
        attempts: 0,
        cancel_requested: false,
        runner_exit_confirmed: false,
        termination: "not_started",
        spots: [],
      });
    }

    if (claimed.has(operationId)) {
      return failure("duplicate_boundary", "this frozen boundary already ran; no unbounded retry", {
        operation_id: operationId,
        input_digest: inputDigest,
      });
    }
    claimed.add(operationId);

    const combined = combineSignals(signal, timeoutMs);
    const spots = [];
    let attempt = 0;
    let lastFailure = { reason: "runner_error", detail: "runner did not return a result" };
    try {
      for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (combined.signal.aborted) break;
        if (!(await isCurrent(boundary))) {
          stats.stale += 1;
          return { outcome: "stale", applicable: false, reason: "stale", detail: "source session or boundary changed before the run", operation_id: operationId, input_digest: inputDigest, attempts: attempt - 1, spots };
        }
        // Re-check cancellation AFTER the awaited validation above.
        if (combined.signal.aborted) break;

        // The prior summary is supplied on EVERY attempt (not just the first): a fallback
        // must not silently drop accepted prior state.
        const request = buildRequest({
          operationId,
          boundary,
          historyJson,
          requesterNote: requesterNoteJson,
          previousSummaryJson,
          reason,
          attempt,
          budget,
        });
        assertInterpolatable(request.requester_note, "requester_note");
        if (request.previous_summary_json) assertInterpolatable(request.previous_summary_json, "previous_summary_json");

        stats.runnerCalls += 1;
        const result = await invokeRunner({ runner, request, signal: combined.signal, now, abortGraceMs });
        const spot = { attempt, aborted: result.aborted, exitConfirmed: result.exitConfirmed, ms: result.ms };
        if (result.value && typeof result.value === "object") {
          if (Number.isInteger(result.value.exit_code)) spot.exit_code = result.value.exit_code;
          if (result.value.exit_signal !== undefined) spot.exit_signal = result.value.exit_signal;
          if (typeof result.value.termination === "string") spot.termination = result.value.termination;
        }
        spots.push(spot);

        if (result.aborted) {
          const why = combined.reason() ?? "cancelled";
          if (why === "timeout") stats.timedOut += 1;
          else stats.cancelled += 1;
          return {
            outcome: why,
            applicable: false,
            reason: why,
            detail: why === "timeout" ? `runner exceeded ${timeoutMs} ms` : "compaction attempt cancelled",
            operation_id: operationId,
            input_digest: inputDigest,
            attempts: attempt,
            cancel_requested: true,
            runner_exit_confirmed: result.exitConfirmed,
            termination: result.termination ?? (result.exitConfirmed ? "confirmed" : "uncertain"),
            spots,
          };
        }

        if (result.ok) {
          const value = result.value;
          // The runner RESOLVED with a structured failure (e.g. the strict extractor
          // refused the native envelope). Preserve the concrete code/detail and the
          // real exit evidence; there is no candidate output to validate.
          let candidateText = null;
          if (value && typeof value === "object" && value.status === "error") {
            lastFailure = {
              structured: true,
              reason: typeof value.code === "string" && value.code ? value.code : "runner_protocol",
              detail: typeof value.detail === "string" && value.detail ? value.detail : "runner reported an error",
              exit_code: Number.isInteger(value.exit_code) ? value.exit_code : null,
              exit_signal: value.exit_signal ?? null,
              termination: typeof value.termination === "string" ? value.termination : "confirmed",
            };
          } else if (value && typeof value === "object" && typeof value.output === "string") {
            candidateText = value.output;
          } else if (typeof value === "string") {
            candidateText = value;
          } else {
            lastFailure = { reason: "runner_protocol", detail: "runner did not return a string output" };
          }
          const outputBytes = typeof candidateText === "string" ? Buffer.byteLength(candidateText, "utf8") : 0;
          if (typeof candidateText !== "string") {
            // lastFailure was set above (structured runner error / non-string value); fall
            // through to the shared retryability gate instead of skipping it.
          } else if (outputBytes > budget.max_output_bytes) {
            lastFailure = { reason: "output_cap_exceeded", detail: `candidate ${outputBytes} B exceeds ${budget.max_output_bytes} B` };
          } else {
            let parsed;
            try {
              parsed = JSON.parse(candidateText);
            } catch (error) {
              lastFailure = { reason: "malformed_candidate", detail: `candidate is not JSON: ${error.message}` };
              parsed = undefined;
            }
            if (parsed !== undefined) {
              const validated = validateCandidate(parsed, boundary);
              if (validated.ok) {
                const summary = renderSummaryText(validated.candidate, boundary);
                const summaryTokens = estimateTokens(summary);
                if (summaryTokens > budget.max_summary_tokens) {
                  lastFailure = { reason: "output_cap_exceeded", detail: `rendered summary ~${summaryTokens} tokens exceeds ${budget.max_summary_tokens}` };
                } else {
                  // Cancellation and staleness are re-checked AFTER every awaited validation
                  // and immediately before a candidate could be returned.
                  const finalAbort = combined.signal.aborted ? (combined.reason() ?? "cancelled") : null;
                  if (finalAbort) {
                    if (finalAbort === "timeout") stats.timedOut += 1;
                    else stats.cancelled += 1;
                    return {
                      outcome: finalAbort,
                      applicable: false,
                      reason: finalAbort,
                      detail: finalAbort === "timeout" ? `runner exceeded ${timeoutMs} ms` : "compaction attempt cancelled during final validation",
                      operation_id: operationId,
                      input_digest: inputDigest,
                      attempts: attempt,
                      cancel_requested: true,
                      runner_exit_confirmed: result.exitConfirmed,
                      termination: result.termination ?? (result.exitConfirmed ? "confirmed" : "uncertain"),
                      spots,
                    };
                  }
                  if (!(await isCurrent(boundary))) {
                    stats.stale += 1;
                    return { outcome: "stale", applicable: false, reason: "stale", detail: "source session or boundary changed before apply", operation_id: operationId, input_digest: inputDigest, attempts: attempt, spots };
                  }
                  if (combined.signal.aborted) {
                    const why = combined.reason() ?? "cancelled";
                    if (why === "timeout") stats.timedOut += 1;
                    else stats.cancelled += 1;
                    return {
                      outcome: why,
                      applicable: false,
                      reason: why,
                      detail: why === "timeout" ? `runner exceeded ${timeoutMs} ms` : "compaction attempt cancelled before candidate return",
                      operation_id: operationId,
                      input_digest: inputDigest,
                      attempts: attempt,
                      cancel_requested: true,
                      runner_exit_confirmed: result.exitConfirmed,
                      termination: result.termination ?? (result.exitConfirmed ? "confirmed" : "uncertain"),
                      spots,
                    };
                  }
                  const compaction = {
                    summary,
                    firstKeptEntryId: boundary.first_kept_entry_id,
                    tokensBefore: boundary.tokens_before,
                    details: fileDetails,
                  };
                  if (value && typeof value.usage === "object" && value.usage !== null) compaction.usage = value.usage;
                  stats.candidateReady += 1;
                  return {
                    outcome: "candidate_ready",
                    applicable: true,
                    committed: false,
                    reason: "candidate_ready",
                    operation_id: operationId,
                    input_digest: inputDigest,
                    input_bytes: inputBytes,
                    attempts: attempt,
                    compaction,
                    boundary,
                    cancel_requested: false,
                    runner_exit_confirmed: true,
                    spots,
                  };
                }
              } else {
                lastFailure = { reason: validated.code, detail: validated.detail };
              }
            }
          }
        } else {
          lastFailure = classifyRunnerError(result.error);
        }

        const retryable = RETRYABLE_FAILURES.includes(lastFailure.reason);
        if (!retryable || attempt >= maxAttempts) break;
        if (combined.signal.aborted) break;
        if (!(await isCurrent(boundary))) {
          stats.stale += 1;
          return { outcome: "stale", applicable: false, reason: "stale", detail: "source session changed before fallback", operation_id: operationId, input_digest: inputDigest, attempts: attempt, spots };
        }
        // Re-check cancellation AFTER the awaited validation above.
        if (combined.signal.aborted) break;
      }
    } finally {
      combined.cleanup();
    }

    const lastSpot = spots.length > 0 ? spots[spots.length - 1] : null;
    // Report cancellation accurately at EVERY break, including a non-retryable failure
    // that coincides with an abort (e.g. an adapter timeout that fired mid-run).
    const aborted = combined.signal.aborted || Boolean(signal?.aborted);
    const why = aborted ? combined.reason() ?? "cancelled" : null;
    if (why === "timeout") stats.timedOut += 1;
    else if (why === "cancelled") stats.cancelled += 1;
    return failure(
      why ?? lastFailure.reason,
      why ? (why === "timeout" ? `runner exceeded ${timeoutMs} ms` : "compaction attempt cancelled") : lastFailure.detail,
      {
        ...(why ? { outcome: why, applicable: false, reason: why } : {}),
        operation_id: operationId,
        input_digest: inputDigest,
        input_bytes: inputBytes,
        attempts: spots.length,
        cancel_requested: aborted,
        runner_exit_confirmed: lastSpot ? lastSpot.exitConfirmed === true : false,
        termination: lastSpot ? (lastSpot.exitConfirmed === true ? "confirmed" : "uncertain") : "not_started",
        runner_exit_code: lastFailure.exit_code ?? null,
        runner_exit_signal: lastFailure.exit_signal ?? null,
        ...(lastFailure.structured
          ? { runner_error: { code: lastFailure.reason, detail: lastFailure.detail, exit_code: lastFailure.exit_code ?? null, exit_signal: lastFailure.exit_signal ?? null, termination: lastFailure.termination ?? "confirmed" } }
          : {}),
        spots,
      },
    );
  }

  return {
    version: COMPACTION_SERVICE_VERSION,
    budget,
    maxAttempts,
    timeoutMs,
    abortGraceMs,
    run,
    stats: () => ({ ...stats }),
    claimedBoundaries: () => new Set(claimed),
  };
}

// ---------------------------------------------------------------------------
// Real process/recipe runner boundary (argv-only; never a shell string)
// ---------------------------------------------------------------------------

/** Best-effort extraction of the final JSON value from Goose stdout. */
export function extractFinalJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function isCompleteToolResult(tr) {
  // Supported native success body. `{status:"success"}` alone is NOT sufficient.
  return Boolean(
    tr && typeof tr === "object" && tr.status === "success" &&
      tr.value && typeof tr.value === "object" && tr.value.isError === false &&
      tr.value.resultType === "complete" && Array.isArray(tr.value.content),
  );
}

function jsonEquals(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEquals(a[k], b[k]));
}

/**
 * Strict extractor for the Goose 1.57.0 `--output-format json` native envelope.
 *
 * The whole stdout must be ONE JSON value whose `metadata.status` is `"completed"`.
 * Exactly one COMPLETE successful pair is required: a `recipe__final_output`
 * toolRequest that parsed (`toolCall.status:"success"`) with a UNIQUE matching
 * toolResponse appearing later that carries the supported native value shape
 * (`status:"success"`, `value.resultType:"complete"`, `value.isError:false`,
 * `value.content[]`). A parsed request whose response explicitly failed is tolerated
 * (never unwrapped) but does not count; absent/malformed/duplicate/out-of-order
 * responses are refused. The candidate is taken from the request's object `arguments`.
 * request's object `arguments` (never from a rejected `{output:string}` attempt or
 * from free text). A trailing final assistant JSON text block that disagrees with the
 * successful result is refused. Failures are explicit codes, never guesses.
 *
 * Returns `{ok:true, output}` (canonical single-line candidate JSON) or
 * `{ok:false, code, detail}`.
 */
export function extractGooseCandidate(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return { ok: false, code: "goose_empty_output", detail: "stdout was empty" };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: "goose_output_not_json", detail: `stdout is not a single JSON value: ${error?.message ?? error}` };
  }
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.messages)) {
    return { ok: false, code: "goose_envelope_malformed", detail: "envelope lacks a messages array" };
  }
  const status = envelope?.metadata?.status;
  if (status !== "completed") {
    return { ok: false, code: "goose_status_not_completed", detail: `envelope status=${JSON.stringify(status ?? null)}` };
  }
  const requests = [];
  const responses = new Map(); // id -> [{ tr, order }]
  let finalAssistantText = null;
  let order = 0;
  for (const message of envelope.messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "toolRequest" && block?.toolCall?.value?.name === "recipe__final_output") {
        requests.push({ id: block.id, status: block.toolCall.status, args: block.toolCall.value.arguments, order: order++ });
      } else if (block?.type === "toolResponse" && block?.id !== undefined) {
        const list = responses.get(block.id) ?? [];
        list.push({ tr: block.toolResult, order: order++ });
        responses.set(block.id, list);
      } else {
        if (block?.type === "text" && message?.role === "assistant" && typeof block.text === "string") finalAssistantText = block.text;
        order++;
      }
    }
  }
  // A genuine success requires a COMPLETE request/response pair: the request parsed
  // (toolCall.status "success") AND a unique, later, non-error toolResponse carrying the
  // supported native value shape. A parsed request whose response explicitly failed is
  // tolerated (never unwrapped) but is not a success.
  const genuine = [];
  let sawExplicitFailure = false;
  for (const request of requests) {
    if (request.status !== "success") continue; // parsed-but-rejected attempt; never unwrapped
    const matches = responses.get(request.id) ?? [];
    if (matches.length === 0) return { ok: false, code: "goose_final_response_missing", detail: `no toolResponse for ${request.id}` };
    if (matches.length > 1) return { ok: false, code: "goose_final_response_duplicate", detail: `${matches.length} toolResponses for ${request.id}` };
    const { tr, order: trOrder } = matches[0];
    if (trOrder < request.order) return { ok: false, code: "goose_final_response_out_of_order", detail: `toolResponse for ${request.id} precedes its request` };
    if (tr?.status !== "success" || tr?.value?.isError === true) {
      sawExplicitFailure = true; // explicitly failed execution pair; tolerated, never unwrapped
      continue;
    }
    if (!isCompleteToolResult(tr)) {
      return { ok: false, code: "goose_final_response_malformed", detail: `toolResponse for ${request.id} lacks resultType:"complete"/isError:false/content[]` };
    }
    if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) {
      return { ok: false, code: "goose_final_output_unusable", detail: `arguments for ${request.id} are not an object` };
    }
    genuine.push(request);
  }
  if (genuine.length === 0) {
    if (sawExplicitFailure) return { ok: false, code: "goose_final_response_failed", detail: "every parsed final-output request had an explicitly failed toolResponse" };
    return {
      ok: false,
      code: "goose_final_output_missing",
      detail: requests.length ? `${requests.length} recipe__final_output request(s), none a complete success` : "no recipe__final_output request",
    };
  }
  if (genuine.length > 1) {
    return { ok: false, code: "goose_final_output_ambiguous", detail: `${genuine.length} complete successful recipe__final_output pairs` };
  }
  const chosen = genuine[0];
  if (typeof finalAssistantText === "string" && finalAssistantText.trim()) {
    let textCandidate;
    try {
      textCandidate = JSON.parse(finalAssistantText);
    } catch {
      textCandidate = undefined;
    }
    if (textCandidate !== undefined && !jsonEquals(textCandidate, chosen.args)) {
      return { ok: false, code: "goose_final_text_disagrees", detail: "final assistant text differs from the successful final output" };
    }
  }
  return { ok: true, output: encodeCanonicalJson(chosen.args) };
}

/**
 * Generic child-process recipe runner.
 *
 * `command` is an absolute executable and `argsFor(request)` returns an argv ARRAY.
 * The child is spawned with `shell: false`, so neither the recipe path nor any history
 * value can be interpreted as a command. On abort the adapter forwards the derived
 * signal to `child.kill(killSignal)` and resolves with the REAL exit code and signal
 * observed on `close`, so termination is a measured fact, not an inference from wiring.
 *
 * Resolves `{status:"ok", output}` on exit 0, or
 * `{status:"error", code, detail, exit_code, exit_signal, termination}` otherwise.
 */
export function createProcessRecipeRunner(options = {}) {
  const { command, argsFor, cwd, env } = options;
  if (typeof command !== "string" || !isAbsolute(command)) {
    throw new Error("createProcessRecipeRunner requires an absolute executable path");
  }
  if (typeof argsFor !== "function") throw new Error("createProcessRecipeRunner requires an argsFor(request) function");
  const maxStdoutBytes = Number.isFinite(options.maxStdoutBytes) ? options.maxStdoutBytes : 1024 * 1024;
  const killSignal = options.killSignal ?? "SIGTERM";
  // Generic default preserves the historical first-brace/last-brace behaviour; a strict
  // extractor (e.g. extractGooseCandidate) may be injected without changing this runner.
  const parseOutput = typeof options.parseOutput === "function" ? options.parseOutput : (stdout) => ({ ok: true, output: extractFinalJson(stdout) });
  return function processRecipeRunner(request, { signal } = {}) {
    return new Promise((resolve) => {
      let args;
      try {
        args = argsFor(request);
      } catch (error) {
        resolve({ status: "error", code: "runner_protocol", detail: `argsFor threw: ${error?.message ?? error}` });
        return;
      }
      if (!Array.isArray(args)) {
        resolve({ status: "error", code: "runner_protocol", detail: "argsFor did not return an argv array" });
        return;
      }
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try {
          child.kill(killSignal);
        } catch {
          // The child may already have exited; `close` reports the truth either way.
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.on("data", (chunk) => {
        if (stdout.length < maxStdoutBytes) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < maxStdoutBytes) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        cleanup();
        resolve({ status: "error", code: "runner_spawn_failed", detail: error.message });
      });
      child.on("close", (code, sig) => {
        cleanup();
        if (aborted) {
          resolve({
            status: "error",
            code: "aborted",
            detail: `runner terminated after abort request (exit_code=${code}, exit_signal=${sig})`,
            exit_code: code,
            exit_signal: sig,
            termination: "confirmed",
          });
        } else if (code === 0) {
          let parsed;
          try {
            parsed = parseOutput(stdout);
          } catch (error) {
            parsed = { ok: false, code: "runner_protocol", detail: `parseOutput threw: ${error?.message ?? error}` };
          }
          if (parsed && parsed.ok === true && typeof parsed.output === "string") {
            resolve({ status: "ok", output: parsed.output, exit_code: 0, exit_signal: null, termination: "confirmed" });
          } else if (parsed && parsed.ok === false) {
            resolve({ status: "error", code: parsed.code ?? "runner_parse_failed", detail: parsed.detail ?? "output parse failed", exit_code: 0, exit_signal: null, termination: "confirmed" });
          } else {
            resolve({ status: "error", code: "runner_protocol", detail: "parseOutput returned an unusable result", exit_code: 0, exit_signal: null, termination: "confirmed" });
          }
        } else {
          resolve({
            status: "error",
            code: "runner_exit",
            detail: `goose exited ${code ?? sig}: ${stderr.slice(0, 500)}`,
            exit_code: code,
            exit_signal: sig,
            termination: "confirmed",
          });
        }
      });
      function cleanup() {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    });
  };
}

/**
 * Goose 1.57.0 recipe runner.
 *
 * The history slice is passed as the value of a single `--params history_json=<canonical
 * single-line JSON>` argv element, never interpolated into a shell command.
 *
 * Qualified against a captured native `--output-format json` envelope. The strict
 * `extractGooseCandidate` extractor is injected here; the generic process runner's
 * default text extraction is unchanged.
 */
export function createGooseRecipeRunner(options = {}) {
  const { gooseBin, recipePath, cwd, env } = options;
  if (typeof gooseBin !== "string" || !isAbsolute(gooseBin)) throw new Error("createGooseRecipeRunner requires an absolute gooseBin");
  if (typeof recipePath !== "string" || !isAbsolute(recipePath)) throw new Error("createGooseRecipeRunner requires an absolute recipePath");
  return createProcessRecipeRunner({
    command: gooseBin,
    cwd,
    env,
    maxStdoutBytes: options.maxStdoutBytes,
    killSignal: options.killSignal,
    parseOutput: extractGooseCandidate,
    argsFor: (request) => {
      const args = [
        "run",
        "--recipe",
        recipePath,
        "--params",
        `history_json=${request.history_json}`,
        "--params",
        `requester_note=${request.requester_note}`,
        "--no-session",
        "--quiet",
        "--no-profile",
        "--max-turns",
        "4",
        "--output-format",
        "json",
      ];
      if (request.previous_summary_json) args.push("--params", `previous_summary_json=${request.previous_summary_json}`);
      return args;
    },
  });
}

// ---------------------------------------------------------------------------
// Recipe authority inspection
// ---------------------------------------------------------------------------

/**
 * Goose extensions that grant the summarizer real tool access (file/system/etc).
 * A recipe's PROSE cannot remove tool access it declares here: instructions forbidding
 * tools are not enforcement. The launcher must either accept this authority or run the
 * summarizer with a recipe/runner configuration that does not declare tools.
 */
export const TOOL_BEARING_EXTENSIONS = Object.freeze(new Set(["developer", "computercontroller", "memory", "computer-controller"]));

/**
 * Inspect the authority a recipe grants its summarizer. Returns the declared extensions
 * and whether any of them is tool-bearing. This is a READ-ONLY structural inspection; it
 * does not modify the recipe and does not itself enforce anything.
 */
export function inspectRecipeAuthority(recipeYaml) {
  let doc;
  try {
    doc = loadRecipeYaml(String(recipeYaml));
  } catch (error) {
    return { ok: false, code: "recipe_unparseable", detail: String(error?.message ?? error), extensions: [], toolBearing: [], toolAccessUnconstrained: false };
  }
  const raw = Array.isArray(doc?.extensions) ? doc.extensions : [];
  const extensions = raw.map((entry) => ({
    type: typeof entry?.type === "string" ? entry.type : null,
    name: typeof entry?.name === "string" ? entry.name : null,
  }));
  const toolBearing = extensions.filter((entry) => entry.name !== null && TOOL_BEARING_EXTENSIONS.has(entry.name.toLowerCase()));
  return { ok: true, extensions, toolBearing, toolAccessUnconstrained: toolBearing.length > 0 };
}
