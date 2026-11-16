import { join } from 'node:path';
import { digest, uuid } from './config.mjs';
import { getTemplate } from './templates.mjs';
import { MAX_CONTEXT_BYTES } from './context.mjs';
import { isHostMessage } from './supervision.mjs';
import { requestSummary } from './delegation.mjs';
import { projectJobStatus } from './job-status.mjs';
import { canonicalEvidence, exposeEvidence, EVIDENCE_AUTHORITY } from './evidence-transport.mjs';
import { ReviewPackets } from './review-packets.mjs';
import { RevisionReviews } from './revision-reviews.mjs';

const string = (description, extra = {}) => ({ type: 'string', minLength: 1, description, ...extra });
const integer = (description, minimum, maximum) => ({ type: 'integer', minimum, maximum, description });
const thread = string('Exact existing Codex chat UUID. Never infer it from the server process or another chat.', { pattern: uuid.source });
const target = string('Agent ID or task_name returned by spawn_agent, within this chat.');
const message = string('Natural-language assignment or message.', { maxLength: 524288 });
const request = string('Optional stable retry key. Reuse for retries; use a new key to intentionally repeat identical work.', { pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$' });
const targetRequest = string('Exact request ID of the outbound operation to retire (the TARGET request), as returned by send_message/followup_task/spawn_agent.', { pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$' });
const requestState = { type: 'string', enum: ['prepared', 'queued', 'sending', 'uncertain', 'attached', 'sent', 'delivered', 'failed', 'cancelled'], description: 'The state you actually observed for the target request. Cancellation is refused unless this still holds atomically.' };
const context = string('Explicit context brief. References are not automatically attached; this is not a conversation fork.', { maxLength: MAX_CONTEXT_BYTES - 1 });
const spaceId = string('Optional exact Herdr space ID. Must be a local space matching the agent project; omit to use the single matching space.');
const placement = { type: 'string', enum: ['tab', 'right', 'down'], description: 'Panel placement when showing: tab (default), right or down split.' };
const batchId = string('Stable review-packet batch ID returned by receive_notification.', { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const cursor = string('Opaque cursor returned by read_review_packet for the same batch.');
function tool(name, description, properties, required, annotations = {}) {
  const readOnly = annotations.readOnlyHint === true;
  return { name, description, inputSchema: { type: 'object', properties: { thread_id: thread, ...properties }, required: ['thread_id', ...required], additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: true, ...annotations } };
}
// One canonical snake_case identity per value; drops the camelCase mirrors that
// doubled most tool results. Applied to every adapter payload.
const RENAME = { agentId: 'agent_id', name: 'task_name' };
const snake = key => key.replace(/[A-Z]/g, character => '_' + character.toLowerCase());
const compact = value => {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [RENAME[key] ?? snake(key), compact(item)]));
};
export const AGENT_TOOLS = [
  tool('spawn_agent', 'Spawn a persistent Herdr subagent. Returns agent_id; use followup_task to continue it. Identical task_name and arguments reuse the original launch. Preserve the configured model/provider. Default explorer is read-only. The existing bridge returns questions and results to this chat.', {
    task_name: string('Stable task name, unique in this chat.', { pattern: '^[a-z][a-z0-9_]{0,47}$' }), message,
    project: string('Absolute existing checkout directory. Required unless using a registered Desk.'),
    template: string('Herdr template, default explorer. Use implementer for writes; reviewer/tester/investigator for read-only help.'),
    context, fork_turns: { type: 'string', enum: ['none'], description: 'Only none is supported. Supply context for a selected brief; full chat forks are unavailable.' },
    parent: target, desk_id: string('Registered Desk ID.'), desk_project: string('Registered Desk project ID.'), definition: string('Registered specialist definition ID.'),
    show: { type: 'boolean', description: 'Also place a visible Herdr panel for the new agent. A placement failure is reported separately and never fails or repeats the launch.' }, space_id: spaceId, place: placement,
  }, ['task_name', 'message']),
  tool('send_message', 'Send a note to an existing Herdr agent. A working agent receives it; an idle agent queues it without starting. Use followup_task to activate an idle agent. A send receipt is not completion.', { target, message, request_id: request, mode: { type: 'string', enum: ['auto', 'queue'] } }, ['target', 'message']),
  tool('followup_task', 'Continue the same Herdr session with a new assignment and its queued notes. Does not launch a replacement. An uncertain earlier delivery must be reconciled first.', { target, message, context, request_id: request }, ['target', 'message']),
  tool('interrupt_agent', 'Request interruption of the current Herdr turn. Retains the session and writer lease. Does not claim that shell subprocesses stopped or release the checkout. An unconfirmed interrupt blocks later input until it is reconciled.', { target, request_id: request }, ['target']),
  tool('stop_agent', 'Intentionally end an agent: record the stop before signalling the native process, confirm the original process exited, preserve terminal history and refuse later input. Idempotent for a given request_id. Unexpected crashes still fault instead.', { target, request_id: request, note: string('Optional operator note recording why the agent was stopped.') }, ['target']),
  tool('cancel_request', 'Locally retire ONE unclaimed outbound operation so it stops gating task close, without any native action. Only a prepared ordinary request or an unclaimed queued note is eligible; anything already handed to the carrier (sending, uncertain, attached, sent, delivered) is refused, and lifecycle stop/interrupt can never be cancelled here. target_request_id is the operation being retired; request_id is the separate disposition identity. The expected_state is an atomic precondition: the cancel is refused unless the target is still in that state. Idempotent for a given request_id; payload and receipts are preserved.', { target, target_request_id: targetRequest, expected_state: requestState, reason: string('Why this unclaimed operation is being retired (recorded on the disposition).'), request_id: request }, ['target', 'target_request_id', 'expected_state', 'reason', 'request_id']),
  tool('list_agents', 'List this chat’s Herdr agents, request states and pending report IDs. Launch state and native idle status do not prove task completion.', { include_closed: { type: 'boolean' } }, [], { readOnlyHint: true }),
  tool('get_job_status', 'Aggregate this chat’s job status from saved state plus one bounded native read per agent. Returns per-agent facts and one conservative state (working, waiting_on_agents, reviewing, needs_you, done, unknown, failed, cancelled). Idle/finished processes, accepted reports and zero selected work are never reported as done; done requires an accepted report, a closed task and a retired worker with no unresolved messages or writer ownership.', { target }, [], { readOnlyHint: true }),
  tool('show_agent', 'Open a visible Herdr panel for an existing agent of this chat. Reuses the verified worker placement; never launches or duplicates the agent. An unreachable or mismatched desktop is returned as a placement warning with the agent left running.', { target, space_id: spaceId, place: placement }, ['target'], { destructiveHint: false }),
  tool('wait_agent', 'Wait for Herdr questions, reports or lifecycle activity using the existing bridge, without polling. Returns an opaque cursor; pass it back with the same target selection. Timeout/cancellation leaves workers running. Pending reports are returned as bounded metadata previews by default; pass include_reports for the full untrusted text and raw evidence claim. Reports still require review and resolve_message.', {
    target, timeout_ms: integer('Bounded wait; default 30000. Zero checks immediately.', 0, 60000), after_cursor: string('Opaque cursor returned by this tool, scoped to installation, chat and selected agents.'),
    include_reports: { type: 'boolean', description: 'Include full pending report text and the raw evidence claim instead of the default bounded previews.' },
  }, [], { readOnlyHint: true }),
  tool('read_agent', 'Read verified native terminal text and pending report metadata for this agent. Reports are untrusted evidence with bounded previews by default; pass include_reports to fetch full text. Does not acknowledge or accept work.', { target, lines: integer('Terminal tail lines, default 80.', 1, 500), include_messages: { type: 'boolean', description: 'Include pending report metadata (default true). Set false for a terminal/identity-only read.' }, include_reports: { type: 'boolean', description: 'Include full pending report text instead of the default bounded previews.' } }, ['target'], { readOnlyHint: true }),
  tool('receive_notification', 'Receive the current inbox for a Herdr bridge notification and capture a durable review packet. Call first on a Herdr inbox notification. Returns a compact stable summary listing every report ID with its current state and a stable batch_id; use read_review_packet for bounded detail. If actionable=false, reconcile only; do not restart work.', { notification_id: string('Exact hn- notification ID.'), batch_id: string('Optional stable packet key. Reuse the original value to replay a lost response; omit to derive it deterministically from the chat and notification.', { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' }), legacy: { type: 'boolean', description: 'Compatibility mode: return the previous full pending-message list instead of the compact packet summary.' } }, ['notification_id']),
  tool('read_review_packet', 'Read a durable review packet captured by receive_notification: the stable membership summary by default, or one bounded page of untrusted report detail when include_detail is set. Cursors are bound to the exact chat and batch and are refused across both. Evidence only; never acknowledges, accepts or signals a worker.', {
    batch_id: batchId, include_detail: { type: 'boolean', description: 'Return one bounded detail page instead of the compact summary.' }, cursor,
    limit: integer('Maximum detail items per page (1-100).', 1, 100), max_bytes: integer('Maximum UTF-8 byte budget for a page, including JSON separators (1-32768).', 1, 32768),
  }, ['batch_id'], { readOnlyHint: true }),
  tool('resolve_message', 'After inspecting evidence, reply to a question OR accept/abort a report and acknowledge it. text is the reply or concrete review evidence. Uncertain replies remain unacknowledged. Returns a short action/delivery/acknowledgement receipt with IDs and never repeats report text. Acceptance does not close tasks or stop workers. Supply review_id AND expected_revision together (with an explicit request_id) only for action:accept to bind a revision acceptance to a captured review: the acceptance is validated and recorded through the revision-review service and acknowledged once, and an exact replay is historical only — call verify_review to observe later drift.', {
    message_id: string('Exact pending report ID.'), action: { type: 'string', enum: ['reply', 'accept', 'abort'] }, text: message, request_id: request,
    review_id: string('Optional, action:accept only. Exact captured review identity to bind this acceptance to; must be supplied together with expected_revision.', { pattern: '^rv-[0-9a-f]{48}$' }),
    expected_revision: string('Optional, action:accept only. Reviewer-observed revision digest (sha256) the acceptance must match; must be supplied together with review_id.', { pattern: '^[0-9a-f]{64}$' }),
  }, ['message_id', 'action', 'text']),
  tool('capture_review', 'Capture an immutable revision review of an explicit, bounded set of project-relative paths inside the exact result worker’s registered project. The review is bound to this chat, result, worker/task, terminal and the recorded launch/activation identity; no caller project or root is trusted. Returns only the stable review identity, revision digest and bounded counts, never the per-file manifest or report text. Reuse the identical request_id to replay the same capture; conflicting arguments are refused. Evidence only: never accepts, acknowledges, closes or signals a worker.', {
    result_id: string('Exact result message ID in this chat.', { pattern: '^[a-zA-Z0-9._-]{1,128}$' }),
    paths: { type: 'array', minItems: 1, maxItems: 4096,
      description: 'Explicit nonempty project-relative file or directory scopes to bind into the review.', items: { type: 'string', maxLength: 1024 } },
    request_id: string('Mandatory stable retry key for this capture. Reuse the identical key to replay the same review; different arguments conflict.', { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' }),
  }, ['result_id', 'paths', 'request_id']),
  tool('verify_review', 'Re-verify one already-recorded acceptance for a result in this chat against the current reviewed files and its captured revision binding, without changing anything. Returns compact explicit accepted/bound/verified/stale flags with a reason, the stable identities, expected/actual revision digests and bounded changed-path counts and previews; never the manifest or report text. A legacy acceptance reports accepted=true, bound=false, verified=null; no acceptance reports accepted=false; and a historical acceptance is never reported as current completion. Read-only: never accepts, acknowledges, closes or signals a worker.', {
    result_id: string('Exact result message ID in this chat.', { pattern: '^[a-zA-Z0-9._-]{1,128}$' }),
    review_id: string('Optional exact recorded review id to check against the accepted binding.', { pattern: '^rv-[0-9a-f]{48}$' }),
  }, ['result_id'], { readOnlyHint: true }),
];

// Validate the deliberately small JSON Schema subset used above before any side effect.
export function validateToolInput(name, args) {
  const schema = AGENT_TOOLS.find(t => t.name === name)?.inputSchema;
  if (!schema) throw new Error('Unknown Herdr tool: ' + name);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw new Error('Missing ' + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new Error('Unsupported argument: ' + key);
    if (rule.type === 'array') {
      if (!Array.isArray(value)) throw new Error('Invalid type for ' + key);
      if (rule.minItems !== undefined && value.length < rule.minItems) throw new Error('Too few items: ' + key);
      if (rule.maxItems !== undefined && value.length > rule.maxItems) throw new Error('Too many items: ' + key);
      const item = rule.items ?? {};
      for (const [index, entry] of value.entries()) {
        if (item.type === 'integer' ? !Number.isSafeInteger(entry) : typeof entry !== item.type) throw new Error(`Invalid type for ${key}[${index}]`);
        if (typeof entry === 'string' && (!entry.trim() || entry.includes('\0') || entry.length > (item.maxLength ?? 4096) || (item.pattern && !new RegExp(item.pattern).test(entry)))) throw new Error(`Invalid ${key}[${index}]`);
      }
      continue;
    }
    if (rule.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== rule.type) throw new Error('Invalid type for ' + key);
    if (rule.enum && !rule.enum.includes(value)) throw new Error('Unsupported ' + key + ': ' + value);
    if (typeof value === 'string' && (!value.trim() || value.includes('\0') || value.length > (rule.maxLength ?? 4096) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) throw new Error('Invalid ' + key);
    if (typeof value === 'number' && (value < rule.minimum || value > rule.maximum)) throw new Error('Out of range: ' + key);
  }
  return args;
}

const agentId = (threadId, name) => 'ha-' + digest(threadId + ':' + name).slice(0, 28);
const snapshot = text => {
  if (text === undefined) return null;
  if (Buffer.byteLength(text) >= MAX_CONTEXT_BYTES) throw new Error('Context brief must be smaller than 256 KiB');
  return { version: 1, format: 'text', content: text, sha256: digest(text) };
};
const key = (name, args) => args.request_id ?? 'auto-' + digest(JSON.stringify([name, args.message ?? args.text ?? null, args.context ?? null, args.mode ?? 'auto', args.action ?? null])).slice(0, 32);
const compactMessage = m => ({ message_id: m.id, agent_id: m.workerId, kind: m.kind, text: m.text, action: m.action, acknowledged_at: m.acknowledgedAt ?? null, ...exposeEvidence(m.evidence) });
const MESSAGE_PREVIEW_BYTES = 512;
// Clip untrusted report text on a code-point boundary so a preview never gains
// U+FFFD and the byte count is exact.
const previewText = text => {
  const value = typeof text === 'string' ? text : '';
  const total = Buffer.byteLength(value, 'utf8');
  if (total <= MESSAGE_PREVIEW_BYTES) return { text: value, bytes: total, truncated: false };
  let out = '', bytes = 0;
  for (const ch of value) { const size = Buffer.byteLength(ch, 'utf8'); if (bytes + size > MESSAGE_PREVIEW_BYTES) break; out += ch; bytes += size; }
  return { text: out, bytes: total, truncated: true };
};
// Bounded, non-dereferenced view of a worker's untrusted evidence claim. The
// default manager-facing paths carry only this metadata; the full raw claim is
// returned solely on explicit opt-in (`read_agent` with `include_reports: true`
// or the `receive_notification` legacy path). The accepted ReviewPackets detail
// page exposes bounded textual evidence references, not the raw claim object.
// References are clipped and counted, never fetched, and no path is opened. This
// is why a huge structured claim cannot bloat a routine read: only identity,
// revision digests and a bounded reference sample travel.
const EVIDENCE_REF_LIMIT = 8;
const EVIDENCE_REF_LENGTH = 200;
// Byte-aware clip: measures UTF-8 bytes (not code points) and never splits a
// multibyte sequence. A split trailing sequence decodes to U+FFFD and is dropped.
const clipBytes = text => {
  if (Buffer.byteLength(text, 'utf8') <= EVIDENCE_REF_LENGTH) return text;
  let clipped = Buffer.from(text, 'utf8').subarray(0, EVIDENCE_REF_LENGTH).toString('utf8');
  if (clipped.endsWith('\uFFFD')) clipped = clipped.slice(0, -1);
  return clipped;
};
const clipRefDetail = value => {
  if (value === undefined || value === null) return { value: null, clipped: false };
  const text = typeof value === 'string' ? value : String(value);
  const clipped = Buffer.byteLength(text, 'utf8') > EVIDENCE_REF_LENGTH;
  return { value: clipped ? clipBytes(text) : text, clipped };
};
const refList = values => {
  const list = Array.isArray(values) ? values : [];
  const details = list.slice(0, EVIDENCE_REF_LIMIT).map(clipRefDetail);
  const items = details.map(detail => detail.value).filter(item => item !== null);
  const clipped = details.filter(detail => detail.clipped).length;
  return { count: list.length, items, dropped: Math.max(0, list.length - EVIDENCE_REF_LIMIT), clipped, truncated: list.length > EVIDENCE_REF_LIMIT || clipped > 0 };
};
// Object refs project a few nested string fields. Any field that had to be
// clipped is flagged per item and aggregated, so one over-long path cannot hide
// behind a small outer array count.
const objRefList = (values, project) => {
  const list = Array.isArray(values) ? values : [];
  let nested = false;
  const items = list.slice(0, EVIDENCE_REF_LIMIT).map(item => {
    const projected = project(item);
    if (projected.clipped === true) nested = true;
    return projected;
  });
  return { count: list.length, items, dropped: Math.max(0, list.length - EVIDENCE_REF_LIMIT), truncated: list.length > EVIDENCE_REF_LIMIT || nested };
};
const revisionMeta = value => value && typeof value === 'object'
  ? { sha256: typeof value.sha256 === 'string' ? value.sha256 : null, project: typeof value.project === 'string' ? value.project : null }
  : null;
const evidenceClaim = evidence => {
  if (evidence === undefined || evidence === null) return { evidence: null, evidence_authority: null };
  // canonicalEvidence already returns stable JSON for the raw claim; hashing or
  // measuring it again would double-encode and report a different digest.
  const serialized = canonicalEvidence(evidence);
  const changed_paths = refList(evidence.changed_paths);
  const artifacts = objRefList(evidence.artifacts, item => {
    const path = clipRefDetail(item?.path);
    return { path: path.value, sha256: item?.sha256 ?? null, clipped: path.clipped };
  });
  const tests = objRefList(evidence.tests, item => {
    const cwd = clipRefDetail(item?.cwd), output = clipRefDetail(item?.output_path);
    return { cwd: cwd.value, exit_code: item?.exit_code ?? null, output_path: output.value, truncated: item?.truncated ?? null, clipped: cwd.clipped || output.clipped };
  });
  const limitations = refList(evidence.limitations);
  const unresolved_requests = refList(evidence.unresolved_requests);
  return { evidence: {
    version: evidence.version ?? null, worker_id: evidence.worker_id ?? null, task_id: evidence.task_id ?? null,
    session_generation_id: evidence.session_generation_id ?? null,
    baseline_revision: revisionMeta(evidence.baseline_revision), final_revision: revisionMeta(evidence.final_revision),
    sha256: digest(serialized), bytes: Buffer.byteLength(serialized, 'utf8'),
    changed_paths, artifacts, tests, limitations, unresolved_requests,
    references_dereferenced: false,
    truncated: changed_paths.truncated || artifacts.truncated || tests.truncated || limitations.truncated || unresolved_requests.truncated,
  }, evidence_authority: EVIDENCE_AUTHORITY };
};
// Default manager-facing report shape: bounded identity/timing/state metadata, a
// clipped preview and bounded claim metadata (digest/bytes/revision/untrusted
// references). Full untrusted report text and the raw claim stay opt-in so
// routine reads and inbox wakes never re-send multi-KiB payloads.
const messageMeta = m => {
  const preview = previewText(m.text);
  return { message_id: m.id, agent_id: m.workerId, kind: m.kind, created_at: m.createdAt ?? null, turn: m.turn ?? null,
    received_at: m.receivedAt ?? null, acknowledged_at: m.acknowledgedAt ?? null, delivery: m.delivery ?? null,
    action: m.action ? { kind: m.action.kind, state: m.action.state, request_id: m.action.requestId } : null,
    text_bytes: preview.bytes, text_preview: preview.text, text_truncated: preview.truncated, ...evidenceClaim(m.evidence) };
};
// Short truthful resolve receipt: identities, acknowledgement and the two
// deliveries kept deliberately separate — the inbound report delivery that
// produced the message and the native delivery of the reply action. Never echoes
// report text or the reply prose, and never invents a successful acknowledgement.
// Compact revision-binding facts for one bound acceptance: stable identities, the
// accepted revision digest and the capture time only. The per-file manifest, the
// report payload and the raw verification result are deliberately excluded.
const bindingFacts = review => ({ review_id: review.reviewId, revision_sha256: review.revisionSha256, bound: true,
  task_id: review.taskId, worker_id: review.workerId, provenance: review.provenance ?? null, captured_at: review.capturedAt ?? null });
const actionReceipt = m => ({ message_id: m.id, agent_id: m.workerId, kind: m.kind,
  acknowledged: Boolean(m.acknowledgedAt), acknowledged_at: m.acknowledgedAt ?? null,
  report_delivery: { received_at: m.receivedAt ?? null, state: m.delivery ?? null },
  action: m.action ? { kind: m.action.kind, state: m.action.state, request_id: m.action.requestId } : null,
  review: m.action?.review ? bindingFacts(m.action.review) : null,
  reply_delivery: m.action ? { state: m.action.state, native_receipt: m.action.nativeReceipt ?? null, error: m.action.error ?? null } : null });
// Bound acceptance receipt: the ordinary action/acknowledgement receipt plus the
// compact binding facts. A fresh acceptance reports the verification the library
// performed before recording; an exact replay is historical only and never claims
// the current files still match — call verify_review to observe later drift.
const acceptanceReceipt = (m, accepted) => ({ ...actionReceipt(m),
  replay: accepted?.replay === true,
  verified: accepted?.replay === false && accepted?.verification?.match === true ? true : null });
// Compact review-capture receipt: stable capture identity, the revision digest
// and bounded counts. The per-file manifest and the reviewed report text are
// deliberately never returned, so a routine capture cannot echo a large diff.
const captureReceipt = record => {
  const scopes = Array.isArray(record.revision?.scopes) ? record.revision.scopes : [];
  const members = scopes.flatMap(scope => Array.isArray(scope.members) ? scope.members : []);
  return { review_id: record.reviewId, result_id: record.resultId, thread_id: record.threadId, task_id: record.taskId,
    worker_id: record.workerId, terminal_id: record.terminalId, project: record.project,
    revision_sha256: record.revisionSha256, provenance: record.provenance ?? null,
    scopes: scopes.length, files: members.filter(member => member.type === 'file').length,
    bytes: members.reduce((total, member) => total + (member.type === 'file' ? member.size : 0), 0),
    captured_at: record.capturedAt, verified: false };
};
// Bounded preview of a path/drift list: a count, a clipped sample and an
// explicit truncation flag. The full list is never returned.
const CHANGED_PATH_PREVIEW = 20;
const pathPreview = values => {
  const list = Array.isArray(values) ? values : [];
  const details = list.slice(0, CHANGED_PATH_PREVIEW).map(value => clipRefDetail(value));
  const clipped = details.filter(detail => detail.clipped).length;
  return { count: list.length, preview: details.map(detail => detail.value), clipped, truncated: list.length > CHANGED_PATH_PREVIEW || clipped > 0 };
};
// Compact verification receipt: explicit acceptance/binding/verification/staleness
// flags, the stable identities, expected/actual digests and bounded changed-path
// counts. It never returns the review manifest, the per-file report or the raw
// service object, and a historical acceptance is never reported as current
// completion. `verified` stays null when there is nothing to attest.
const verifyReceipt = value => {
  const bound = value.bound === true;
  const reason = value.reason ?? (bound ? (value.verified === true ? 'revision-verified' : 'revision-changed') : 'no-acceptance');
  return { result_id: value.resultId, thread_id: value.threadId, review_id: value.reviewId ?? null,
    accepted: value.accepted === true, bound, verified: value.verified ?? null, stale: value.stale === true,
    reason, task_id: value.taskId ?? null, worker_id: value.workerId ?? null, provenance: value.provenance ?? null,
    expected_sha256: value.expectedSha256 ?? null, actual_sha256: value.actualSha256 ?? null,
    revision_consistent: value.revisionConsistent ?? null,
    changed_paths: pathPreview(value.changedPaths), changed_bindings: pathPreview(value.changed),
    scopes: Array.isArray(value.scopes) ? value.scopes.length : null,
    request_id: value.requestId ?? null, accepted_at: value.acceptedAt ?? null, error: value.error ?? null };
};
// Deterministic packet key so an omitted batch_id recovers a lost receive response.
const packetBatchId = (threadId, notificationId) => 'rp-' + digest(JSON.stringify(['review-packet', threadId, notificationId])).slice(0, 32);
// Preserve the exact requested task name (up to 48 chars) instead of the
// 32-char native name, so list/read/spawn targets stay stable.
const named = summary => { const out = compact(summary); delete out.requested_name; if (summary?.requestedName) out.task_name = summary.requestedName; return out; };
// Native-style short receipt for manager-to-agent operations. Keeps the identity,
// durable state, retry keys, native receipt and error/note, but never echoes the
// assignment payload or exact wire text (a large instruction was returned twice).
const receipt = request => { const out = compact(requestSummary(request) ?? {}); delete out.worker_id; return out; };
// Native identity/status only: never expose argv, env, labels or the launch
// command/system instructions. Pending/uncertain launch state stays in the
// summary fields (launch_state, request state) that callers rely on.
const nativeSummary = native => {
  if (!native || typeof native !== 'object') return native ?? null;
  const status = native.status && typeof native.status === 'object'
    ? Object.fromEntries(['state', 'turn'].filter(k => native.status[k] !== undefined).map(k => [k, native.status[k]]))
    : native.status ?? null;
  return Object.fromEntries([['address', native.address], ['pid', native.pid], ['state', native.state], ['status', status]].filter(([, value]) => value !== undefined));
};

// Native `terminal.read` may ignore `lines` and return the whole scrollback, so
// enforce the requested tail here. A string result becomes `{text,truncated,
// total_lines}`; an object keeps its fields. Truncation is always explicit.
export const tailScreen = (screen, limit) => {
  if (screen == null) return screen;
  const object = typeof screen === 'object' && !Array.isArray(screen);
  const text = typeof screen === 'string' ? screen : object && typeof screen.text === 'string' ? screen.text : null;
  if (text === null) return screen;
  const rows = text.split('\n');
  const truncated = rows.length > limit;
  const bounded = (truncated ? rows.slice(-limit) : rows).join('\n');
  if (!object) return { text: bounded, truncated, total_lines: rows.length };
  return { ...screen, text: bounded, truncated, total_lines: rows.length };
};

export class AgentTools {
  constructor({ config, store, delegation, notices, packets, reviews, wait, ensureBridge, place, resolveMessage, flush = async () => {} }) {
    Object.assign(this, { config, store, delegation, notices, wait, ensureBridge, place, resolveMessage, flush });
    // Reuse the accepted durable review-packet service; when only the accepted
    // Notifications service is injected, bind packets to the SAME Store so the
    // receive and the packet write share one transaction.
    this.packets = packets ?? (notices ? new ReviewPackets({ store, config, notifications: notices }) : null);
    // Reuse the accepted revision-review service. An injected instance must be
    // bound to this exact Store: a foreign store would resolve ownership and
    // write the review/ledger in a different database than the tool validates.
    if (reviews && reviews.store !== store) throw new Error('reviews must be bound to the same Store as the adapter');
    this.reviews = reviews ?? (store ? new RevisionReviews(store) : null);
  }
  owned(threadId, id) {
    const worker = this.delegation.worker(id, { active: false });
    if (this.store.task(worker.taskId)?.threadId !== threadId) throw new Error('Agent belongs to another manager chat');
    return worker;
  }
  target(threadId, value) {
    // Exact IDs win. The full requested task_name and the 32-char native name
    // both resolve deterministically within this chat.
    const byId = this.store.worker(value) ? value : this.store.worker(agentId(threadId, value)) ? agentId(threadId, value) : null;
    if (byId) return this.owned(threadId, byId);
    const matches = this.delegation.list({ threadId }).filter(w => w.requestedName === value || w.name === value);
    if (!matches.length) throw new Error('Unknown agent');
    // The 32-char native name is not unique: two distinct 48-char task names can
    // share their first 32 characters. Refuse rather than silently pick one.
    if (matches.length > 1) throw new Error(`Ambiguous agent name ${JSON.stringify(value)} matches ${matches.length} agents in this chat; pass the full agent_id`);
    return this.owned(threadId, matches[0].agentId);
  }
  messages(threadId, workerId, project = compactMessage) {
    return this.store.messages({ pending: true }).filter(m => this.store.task(m.taskId)?.threadId === threadId &&
      (!workerId || m.workerId === workerId) && isHostMessage(this.store, m)).map(project);
  }
  async placeAgent(id, options = {}) {
    if (typeof this.place !== 'function') return { status: 'unavailable', verified: false, warning: 'Desktop placement is unavailable in this runtime; the agent itself is unaffected.' };
    try {
      // Pass the registered worker, never the bare ID, so placement verifies native identity.
      return { verified: false, ...(await this.place(this.delegation.worker(id, { active: false }), { spaceId: options.space_id, place: options.place })) };
    } catch (error) {
      // A desktop problem must never fail, close or relaunch an already running agent.
      return { status: 'unavailable', verified: false, warning: `Desktop placement failed: ${error.message} The agent is running; select the intended space and retry show_agent.` };
    }
  }
  async call(name, raw, { signal } = {}) {
    const a = validateToolInput(name, raw);
    signal?.throwIfAborted();
    let id, requestId, recover;
    try {
      let result;
      if (name === 'spawn_agent') {
        if (a.desk_id ? (!a.desk_project || !a.definition || a.project) : (!a.project || a.desk_project || a.definition)) throw new Error('Supply project, or desk_id + desk_project + definition, but not both');
        id = agentId(a.thread_id, a.task_name);
        const input = { id, name: a.task_name.slice(0, 32), requestedName: a.task_name, threadId: a.thread_id, project: a.project, instruction: a.message,
          template: getTemplate(a.template ?? 'explorer', { templateDir: join(this.config.stateDir, 'templates') }), context: snapshot(a.context),
          parentId: a.parent ? this.target(a.thread_id, a.parent).id : undefined,
          deskId: a.desk_id, deskProjectId: a.desk_project, deskDefinitionId: a.definition, readyTimeout: 20 };
        await this.ensureBridge();
        signal?.throwIfAborted();
        const r = await this.delegation.delegate(input);
        // A desktop failure is reported separately; the launched agent is never failed or repeated here.
        const placement = a.show ? compact(await this.placeAgent(id, { space_id: a.space_id, place: a.place })) : null;
        result = { backend: 'herdr', ...named(r), task_name: a.task_name, context_mode: 'explicit-brief', ...(placement ? { placement } : {}), verified: false };
      } else if (name === 'list_agents') {
        result = { agents: this.delegation.list({ threadId: a.thread_id }).filter(w => a.include_closed || w.taskStatus === 'active').map(named) };
      } else if (name === 'get_job_status') {
        // One shared projection: the CLI `agent status` command calls the same function.
        result = await projectJobStatus({ store: this.store, delegation: this.delegation, threadId: a.thread_id, target: a.target ?? null });
      } else if (name === 'wait_agent') {
        const workers = a.target ? [this.target(a.thread_id, a.target)] : this.delegation.list({ threadId: a.thread_id }).filter(w => w.taskStatus === 'active').map(w => this.owned(a.thread_id, w.agentId));
        const selection = workers.map(w => w.id).sort();
        const scope = digest(JSON.stringify([this.config.stateDir, a.thread_id, selection]));
        let after = 0;
        if (a.after_cursor) {
          let cursor; try { cursor = JSON.parse(Buffer.from(a.after_cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid after_cursor'); }
          if (cursor.scope !== scope || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) throw new Error('Cursor belongs to a different installation, chat or agent selection; omit it to resnapshot');
          after = cursor.seq;
        }
        if (!workers.length) return { reason: 'no-agents', activities: [], messages: [], reports_included: a.include_reports === true, timed_out: false };
        const r = await this.wait({ workers, after, timeoutMs: a.timeout_ms ?? 30000, signal });
        // Pending reports travel as bounded metadata previews by default; full
        // untrusted text and the raw claim stay behind an explicit opt-in, so a
        // routine wake never re-sends multi-KiB payloads. Membership is never
        // clipped: every selected pending report ID still appears.
        const projectReport = a.include_reports === true ? compactMessage : messageMeta;
        result = { ...compact(r), activities: compact(r.activities ?? []), timed_out: r.reason === 'timeout', after_cursor: Buffer.from(JSON.stringify({ scope, seq: r.cursor })).toString('base64url'),
          messages: compact(this.messages(a.thread_id, null, projectReport).filter(m => selection.includes(m.agent_id))),
          reports_included: a.include_reports === true, verified: false };
      } else if (name === 'receive_notification') {
        const notification = this.notices.get(a.notification_id);
        if (notification?.threadId !== a.thread_id) throw new Error('Unknown notification in this chat');
        if (a.legacy === true || !this.packets) {
          // Compatibility mode: the previous full pending-message list.
          const r = this.notices.receive(a.notification_id);
          result = { ...r, messages: r.actionable ? this.messages(a.thread_id) : [] };
        } else {
          const batch = a.batch_id ?? packetBatchId(a.thread_id, a.notification_id);
          // Capture is a durable replay-safe write; a stale envelope keeps its own
          // captured membership but is never actionable again.
          const captured = this.packets.capture({ threadId: a.thread_id, notificationId: a.notification_id, batchId: batch });
          const view = this.packets.read({ threadId: a.thread_id, batchId: batch });
          const actionable = captured.capturedActionable === true && captured.replayed !== true;
          result = compact({
            notification_id: view.notificationId, batch_id: view.batchId, replayed: captured.replayed === true,
            actionable, already_received: !actionable,
            captured_actionable: view.capturedActionable, current_actionable: view.currentActionable,
            current_pending: view.currentPending, current_handled: view.currentHandled,
            count: view.count, report_ids: view.reportIds, task_ids: view.taskIds, worker_ids: view.workerIds,
            id_envelope: view.idEnvelope, note: view.note, evidence_only: true,
            can_acknowledge: false, can_accept: false, can_signal: false, provenance: view.provenance,
            members: view.members.map(m => ({ message_id: m.messageId, task_id: m.taskId, worker_id: m.workerId, terminal_id: m.terminalId, kind: m.kind,
              current: { pending: m.current.pending, eligible: m.current.eligible, reason: m.current.reason, acknowledged_at: m.current.acknowledgedAt,
                received_at: m.current.receivedAt, delivery: m.current.delivery, action: m.current.action },
              ...evidenceClaim(this.store.message(m.messageId)?.evidence) })),
          });
        }
      } else if (name === 'read_review_packet') {
        if (!this.packets) throw new Error('Review packets are unavailable in this runtime');
        const detail = a.include_detail === true || a.cursor !== undefined || a.limit !== undefined || a.max_bytes !== undefined;
        result = detail
          ? compact(this.packets.page({ threadId: a.thread_id, batchId: a.batch_id, cursor: a.cursor, limit: a.limit, maxBytes: a.max_bytes }))
          : compact(this.packets.read({ threadId: a.thread_id, batchId: a.batch_id }));
      } else if (name === 'resolve_message') {
        const m = this.store.message(a.message_id);
        if (!m || this.store.task(m.taskId)?.threadId !== a.thread_id || !isHostMessage(this.store, m)) throw new Error('Unknown manager message in this chat');
        // Only a message that passed the exact chat + host eligibility checks may
        // surface a recovery receipt if the reply side effect then fails.
        recover = m.id;
        const bound = a.review_id !== undefined || a.expected_revision !== undefined;
        if (bound) {
          // Validate the binding request strictly BEFORE any effect. Binding fields
          // are accepted only for a revision-bound acceptance, must be paired, and
          // require an explicit stable request_id (never the derived auto key).
          if (a.action !== 'accept') throw new Error('review_id and expected_revision are only valid for action:accept');
          if (a.review_id === undefined || a.expected_revision === undefined) throw new Error('review_id and expected_revision must be supplied together');
          if (a.request_id === undefined) throw new Error('A revision-bound acceptance requires an explicit stable request_id');
          if (!this.reviews) throw new Error('Revision reviews are unavailable in this runtime');
          requestId = a.request_id;
          // The accepted library owns current revision/binding validation, immutable
          // acceptance and exact replay/conflict refusal. Bind straight through it:
          // a bound acceptance is NEVER routed through the unbound resolveMessage
          // callback/CLI, and it never silently upgrades a legacy unbound action.
          const accepted = this.reviews.acceptReview({ threadId: a.thread_id, resultId: a.message_id, reviewId: a.review_id,
            expectedRevision: a.expected_revision, requestId: a.request_id, text: a.text });
          // The acceptance is durably recorded; acknowledge it now. Store.ack is
          // idempotent, so an exact replay acknowledges exactly once with no second
          // acceptance and no second native action.
          result = acceptanceReceipt(this.store.ack(a.message_id), accepted);
        } else {
          requestId = key(name, a);
          if (m.acknowledgedAt) {
            if (m.action?.kind !== a.action || m.action?.text !== a.text || m.action?.requestId !== requestId) throw new Error('An action is already recorded; inspect it instead of repeating work');
            result = actionReceipt(m);
          } else result = actionReceipt(await this.resolveMessage(m, { kind: a.action, text: a.text, requestId }));
        }
      } else if (name === 'capture_review') {
        // Exact chat + host ownership, uniformly for an unknown and a foreign
        // result, and strictly BEFORE the revision service reads or writes
        // anything. A foreign/unknown id therefore mutates nothing and does not
        // leak whether the id exists in another chat.
        const m = this.store.message(a.result_id);
        if (!m || this.store.task(m.taskId)?.threadId !== a.thread_id || !isHostMessage(this.store, m)) throw new Error('Unknown result message in this chat');
        if (!this.reviews) throw new Error('Revision reviews are unavailable in this runtime');
        // The accepted library owns ownership re-checks, scope normalization,
        // revision capture, replay and conflict refusal; this tool only wraps it.
        result = captureReceipt(this.reviews.captureReview({ threadId: a.thread_id, resultId: a.result_id, paths: a.paths, requestId: a.request_id }));
      } else if (name === 'verify_review') {
        // Same exact chat + host ownership as capture_review, uniformly for an
        // unknown and a foreign result, and strictly BEFORE the read-only revision
        // service is consulted. A foreign/unknown id therefore reads and writes
        // nothing and does not leak whether the id exists in another chat.
        const m = this.store.message(a.result_id);
        if (!m || this.store.task(m.taskId)?.threadId !== a.thread_id || !isHostMessage(this.store, m)) throw new Error('Unknown result message in this chat');
        if (!this.reviews) throw new Error('Revision reviews are unavailable in this runtime');
        // The accepted library owns the conservative acceptance/binding/staleness
        // logic; this tool only wraps it and compacts the result.
        result = verifyReceipt(this.reviews.verifyAcceptedRevision({ threadId: a.thread_id, resultId: a.result_id, reviewId: a.review_id }));
      } else {
        const worker = this.target(a.thread_id, a.target); id = worker.id;
        if (name === 'read_agent') {
          // A deliberately stopped original stays readable: the stop operation
          // itself instructs the operator to inspect the preserved terminal
          // history. `delegation.read` still verifies the immutable identity
          // with `allowFinished`; the strict live `verify` is skipped only when a
          // durable stop was recorded. Later sends remain refused by
          // `delegation.worker({ active: true })`.
          const stopped = Boolean(this.store.meta('stop:' + worker.id)) || worker.launchState === 'stopped';
          if (worker.terminalId && !stopped) await this.delegation.verify(worker);
          const limit = a.lines ?? 80;
          const read = await this.delegation.read(id, limit);
          // Terminal/identity-only reads omit reports entirely; the default
          // returns bounded metadata previews and include_reports is the only
          // path that returns full untrusted report text.
          const reports = a.include_messages === false ? {}
            : { messages: this.messages(a.thread_id, id, a.include_reports === true ? compactMessage : messageMeta), messages_included: true, reports_included: a.include_reports === true };
          result = { ...named(read), screen: tailScreen(read.screen, limit), native: nativeSummary(read.native), agent_id: id,
            ...(a.include_messages === false ? { messages_included: false } : reports), verified: false };
        } else if (name === 'show_agent') {
          result = { agent_id: id, ...compact(await this.placeAgent(id, { space_id: a.space_id, place: a.place })) };
        } else if (name === 'cancel_request') {
          // `request_id` is the disposition identity; `target_request_id` is the
          // operation being retired. Keep them distinct in the receipt.
          requestId = a.request_id;
          const r = this.delegation.cancel(id, { targetRequestId: a.target_request_id, expectedState: a.expected_state, reason: a.reason, dispositionId: a.request_id, threadId: a.thread_id });
          const { request_id: _targetId, ...summary } = receipt(r) ?? {};
          result = { agent_id: id, target_request_id: a.target_request_id, disposition_id: a.request_id, ...summary, verified: false };
        } else {
          requestId = key(name, a);
          const r = name === 'send_message' ? await this.delegation.message(id, requestId, { instruction: a.message, mode: a.mode ?? 'auto' })
            : name === 'followup_task' ? await this.delegation.followup(id, requestId, { instruction: a.message, context: snapshot(a.context) })
              : name === 'stop_agent' ? await this.delegation.stop(id, requestId, { note: a.note ?? null })
                : await this.delegation.interrupt(id, requestId);
          result = { agent_id: id, ...receipt(r), request_id: requestId, verified: false };
        }
      }
      await this.flush();
      return result;
    } catch (error) {
      // Preserve identities even when the external side effect outlives a lost receipt.
      // A resolve failure still reports the durable truth, but only when this exact
      // message passed the same-chat host eligibility check; a foreign chat, a
      // non-host message or a missing id yields no receipt and leaks no existence.
      const resolved = recover ? this.store.message(recover) : null;
      error.details = { ...(id ? { agent_id: id } : {}), ...(requestId ? { request_id: requestId } : {}),
        ...(resolved ? { receipt: actionReceipt(resolved) } : {}),
        ...(id && this.store.worker(id) ? { agent: named(this.delegation.list({ threadId: a.thread_id }).find(w => w.agentId === id)) } : {}),
        recovery: 'Inspect saved state. Retry the identical call or request key; do not create a replacement for uncertain delivery.' };
      throw error;
    }
  }
}
