import { captureRevision, verifyRevision, normalizeRelativePath, LIMITS as EVIDENCE_LIMITS } from './evidence.mjs';
import { assertWorkerTask } from './routing.mjs';
import { digest, uuid } from './config.mjs';

/**
 * Revision-bound review / acceptance service (review record v1).
 *
 * This module sits on top of the accepted content-revision primitives in
 * `evidence.mjs` and the durable `Store`. It binds an exact `result` message to
 * the registered worker/task/chat and to a canonical revision of an explicit,
 * bounded, project-relative scope set, then records an immutable review and a
 * revision-bound acceptance action that can be replayed after a restart.
 *
 * Guarantees:
 *  - The capture project is always the registered worker's project. A
 *    caller-supplied project/root is never trusted.
 *  - A review is bound to one manager chat, one result message, one worker/task
 *    and the launch/activation identity actually recorded in the Store. A new
 *    result, a new activation or a replaced native process binding invalidates an
 *    earlier review.
 *  - Acceptance re-verifies the selected files from disk (additions, deletions,
 *    content and executable mode) and refuses a changed revision *before* any
 *    action or acknowledgement is recorded.
 *  - The revision-bound action and its idempotency ledger are written in one
 *    Store transaction, so replay is stable and a failure leaves no partial
 *    acceptance.
 *  - A historical acceptance is never treated as proof that current content
 *    matches. `verifyAcceptedRevision` reports the two separately.
 *
 * Snapshotting remains best effort: there is no filesystem transaction. A
 * concurrent writer can race capture/verification, so an eventual completion
 * decision must re-verify with `verifyAcceptedRevision` at that time. The
 * revision uses per-file sha256 plus executable mode; filesystem timestamps and
 * SQLite rowids are never used as the content revision.
 */

export const REVIEW_LIMITS = Object.freeze({
  maxScopes: EVIDENCE_LIMITS.maxFiles,
  maxRequestIdLength: 200,
  maxTextBytes: 65536,
  maxRecordBytes: 4 * 1024 * 1024,
});

const REVIEW_VERSION = 1;
const REVIEW_ID_RE = /^rv-[0-9a-f]{48}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MESSAGE_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

const REVIEW_PREFIX = 'revision-review:';
const REQUEST_PREFIX = 'revision-review-request:';
const ACCEPT_PREFIX = 'revision-accept:';

const reviewKey = id => `${REVIEW_PREFIX}${id}`;
const requestKey = (threadId, resultId, requestId) => `${REQUEST_PREFIX}${threadId}:${resultId}:${requestId}`;
const acceptKey = id => `${ACCEPT_PREFIX}${id}`;

function requireText(value, name, maxBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be nonempty text without NUL`);
  }
  if (!value.trim()) throw new TypeError(`${name} must not be blank`);
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new RangeError(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function requireThreadId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new TypeError('threadId must be the exact manager chat UUID');
  return value;
}

function requireResultId(value) {
  if (typeof value !== 'string' || !MESSAGE_ID_RE.test(value)) throw new TypeError('resultId must be a valid message id');
  return value;
}

function requireRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) {
    throw new TypeError('requestId must be 1-200 characters from [A-Za-z0-9._:-] and start alphanumeric');
  }
  return value;
}

function requireReviewId(value) {
  if (typeof value !== 'string' || !REVIEW_ID_RE.test(value)) throw new TypeError('reviewId is not a valid recorded review id');
  return value;
}

/**
 * Canonical, order-stable JSON. References inside report evidence are bound as
 * raw data only: they are never dereferenced or executed.
 */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value === undefined ? null : value;
}
const canonicalJson = value => JSON.stringify(canonicalValue(value));

/** The complete report payload a review binds, including optional evidence. */
function reportPayload(message) {
  return {
    id: message.id,
    taskId: message.taskId,
    workerId: message.workerId,
    terminalId: message.terminalId,
    kind: message.kind,
    text: message.text,
    idempotencyKey: message.idempotencyKey ?? null,
    evidence: message.evidence ?? null,
    turn: message.turn ?? null,
    createdAt: message.createdAt ?? null,
  };
}
const reportFingerprint = message => digest(canonicalJson(reportPayload(message)));

/** Canonical activation identity recorded by the manager, not worker claims. */
function activationIdentity(activation) {
  if (!activation) return null;
  return {
    id: activation.id ?? null,
    at: activation.at ?? null,
    pid: activation.pid ?? null,
    baselineTurn: activation.baselineTurn ?? null,
  };
}

/**
 * Classify whether a result demonstrably precedes the current activation.
 * `stale` is rejected; `unknown` is allowed but kept explicit because result
 * timestamps and turns are worker claims, not independent runtime proof.
 */
function resultProvenance(message, activation) {
  const created = typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : null;
  const turn = Number.isInteger(message.turn) ? message.turn : null;
  const actAt = activation && typeof activation.at === 'string' && Number.isFinite(Date.parse(activation.at)) ? Date.parse(activation.at) : null;
  const baselineTurn = activation && Number.isInteger(activation.baselineTurn) ? activation.baselineTurn : null;
  const reasons = [];
  let comparable = false;
  if (created !== null && actAt !== null) {
    comparable = true;
    if (created < actAt) reasons.push(`result createdAt ${message.createdAt} predates activation at ${activation.at}`);
  }
  if (turn !== null && baselineTurn !== null) {
    comparable = true;
    if (turn < baselineTurn) reasons.push(`result turn ${turn} predates activation baselineTurn ${baselineTurn}`);
  }
  if (reasons.length) return { status: 'stale', reasons };
  return { status: comparable ? 'current' : 'unknown', reasons: [] };
}

function normalizeScopes(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('paths must be a nonempty array of project-relative scopes');
  if (paths.length > REVIEW_LIMITS.maxScopes) throw new RangeError(`paths exceeds the ${REVIEW_LIMITS.maxScopes}-scope limit`);
  const seen = new Set();
  const normalized = paths.map((value, index) => normalizeRelativePath(value, `paths[${index}]`));
  for (const path of normalized) {
    if (seen.has(path)) throw new TypeError(`duplicate selected path: ${path}`);
    seen.add(path);
  }
  return normalized.sort();
}

const samePaths = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Resolve the exact registered binding for a result message. Reads only the
 * Store: it never dereferences worker-supplied paths or evidence and never
 * invents a launch generation.
 */
function bindResult(store, threadId, resultId) {
  requireThreadId(threadId);
  requireResultId(resultId);
  const message = store.message(resultId);
  if (!message) throw new Error(`Unknown result message: ${resultId}`);
  if (message.kind !== 'result') throw new TypeError('Only a result message can be reviewed');
  if (message.origin === 'desk-runtime' || !message.workerId) throw new TypeError('A Desk runtime incident has no registered worker and cannot be reviewed');
  const task = store.task(message.taskId);
  if (!task) throw new Error('The result task is not registered');
  if (task.threadId !== threadId) throw new Error('The result does not belong to this manager chat');
  const worker = store.worker(message.workerId);
  if (!worker) throw new Error('The result worker is not registered');
  assertWorkerTask(worker, task);
  if (!worker.terminalId) throw new Error('The result worker has no confirmed native terminal');
  if (worker.terminalId !== message.terminalId) throw new Error('The result terminal does not match its registered worker');
  const results = store.messages({ taskId: task.id }).filter(item => item.kind === 'result' && item.workerId === worker.id);
  const latest = results[results.length - 1];
  if (!latest || latest.id !== resultId) throw new Error('A newer result from this worker supersedes the selected result');
  const activation = activationIdentity(store.meta(`activation:${worker.id}`) ?? null);
  const provenance = resultProvenance(message, activation);
  if (provenance.status === 'stale') {
    throw new Error(`The result predates the current worker activation and is not current (${provenance.reasons.join('; ')})`);
  }
  return {
    threadId,
    resultId,
    task,
    worker,
    project: worker.project,
    reportFingerprint: reportFingerprint(message),
    provenance: provenance.status,
    activation,
    launch: {
      pid: worker.launchResult?.pid ?? null,
      created_ms: worker.launchIdentity?.created_ms ?? null,
      launchState: worker.launchState ?? null,
    },
  };
}

function reviewIdentity(binding, scopes, revisionSha256) {
  return digest(JSON.stringify({
    version: REVIEW_VERSION,
    threadId: binding.threadId,
    resultId: binding.resultId,
    taskId: binding.task.id,
    workerId: binding.worker.id,
    project: binding.project,
    terminalId: binding.worker.terminalId,
    reportFingerprint: binding.reportFingerprint,
    provenance: binding.provenance ?? null,
    activation: binding.activation ?? null,
    launch: { pid: binding.launch.pid, created_ms: binding.launch.created_ms },
    scopes,
    revisionSha256,
  }));
}

function requestRecord(record, scopes) {
  return {
    version: REVIEW_VERSION,
    reviewId: record.reviewId,
    threadId: record.threadId,
    resultId: record.resultId,
    taskId: record.taskId,
    workerId: record.workerId,
    project: record.project,
    reportFingerprint: record.reportFingerprint,
    scopes,
    revisionSha256: record.revisionSha256,
    provenance: record.provenance ?? null,
    capturedAt: record.capturedAt,
  };
}

/** Compare a stored review against a freshly resolved binding. */
function bindingDrift(record, binding) {
  const drift = [];
  if (record.resultId !== binding.resultId) drift.push('resultId');
  if (record.taskId !== binding.task.id) drift.push('taskId');
  if (record.workerId !== binding.worker.id) drift.push('workerId');
  if (record.project !== binding.project) drift.push('project');
  if (record.terminalId !== binding.worker.terminalId) drift.push('terminalId');
  if ((record.launch?.pid ?? null) !== (binding.launch.pid ?? null)) drift.push('launch.pid');
  if ((record.launch?.created_ms ?? null) !== (binding.launch.created_ms ?? null)) drift.push('launch.created_ms');
  if (canonicalJson(record.activation ?? null) !== canonicalJson(binding.activation ?? null)) drift.push('activation');
  if ((record.provenance ?? null) !== (binding.provenance ?? null)) drift.push('provenance');
  if (record.reportFingerprint !== binding.reportFingerprint) drift.push('report');
  return drift;
}

function acceptanceBinding(record, reviewId) {
  return {
    version: REVIEW_VERSION,
    reviewId,
    threadId: record.threadId,
    revisionSha256: record.revisionSha256,
    project: record.project,
    taskId: record.taskId,
    workerId: record.workerId,
    terminalId: record.terminalId,
    reportFingerprint: record.reportFingerprint,
    activation: record.activation ?? null,
    provenance: record.provenance ?? null,
    launch: record.launch,
    scopes: record.scopes,
    capturedAt: record.capturedAt,
  };
}

/**
 * Resolve an already-recorded acceptance action: an exact replay returns the
 * recorded binding; any other action (including a legacy unbound acceptance) is
 * a conflict and is refused rather than silently replaced or upgraded.
 */
function replayOrConflict(store, message, { threadId, resultId, reviewId, expectedRevision, requestId, text }) {
  const action = message.action;
  if (action.kind !== 'accept') throw new Error(`A ${action.kind} action is already recorded for this result; it cannot be replaced by an acceptance`);
  if (!action.review) throw new Error('A legacy unbound acceptance is already recorded; it cannot be silently upgraded to a revision-bound acceptance');
  if (action.review.threadId !== threadId) throw new Error('A different manager chat already owns this result acceptance');
  if (action.requestId !== requestId) throw new Error('A different requestId is already recorded for this result');
  if (action.text !== text) throw new Error('Different acceptance text is already recorded for this result');
  if (action.review.reviewId !== reviewId) throw new Error('A different review is already recorded for this result');
  if (action.review.revisionSha256 !== expectedRevision) throw new Error('A different revision is already recorded for this result');
  const record = store.meta(reviewKey(reviewId));
  return {
    accepted: true,
    bound: true,
    replay: true,
    reviewId,
    resultId,
    threadId,
    taskId: action.review.taskId,
    workerId: action.review.workerId,
    expectedRevision,
    revisionSha256: action.review.revisionSha256,
    revision: record?.revision ?? null,
    action,
  };
}

export class RevisionReviews {
  constructor(store) {
    if (!store || typeof store.transaction !== 'function' || typeof store.message !== 'function' || typeof store.meta !== 'function') {
      throw new TypeError('RevisionReviews requires a Store instance');
    }
    this.store = store;
  }

  /**
   * Capture an immutable, versioned review of an explicit bounded scope set
   * inside the registered worker's project. A stable replay for the same
   * `requestId` returns the same record; changed arguments conflict.
   */
  captureReview({ threadId, resultId, paths, requestId } = {}) {
    requireThreadId(threadId);
    requireResultId(resultId);
    requireRequestId(requestId);
    const scopes = normalizeScopes(paths);
    const store = this.store;
    return store.transaction(() => {
      const prior = store.meta(requestKey(threadId, resultId, requestId));
      if (prior) {
        if (prior.version !== REVIEW_VERSION) throw new Error('Unsupported review request version');
        if (prior.threadId !== threadId || prior.resultId !== resultId || !samePaths(prior.scopes, scopes)) {
          throw new Error(`requestId ${requestId} already captured a different review for this result; use a new requestId for different arguments`);
        }
        const replay = store.meta(reviewKey(prior.reviewId));
        if (!replay) throw new Error('The recorded review is missing; refusing to silently recreate it');
        return replay;
      }
      const binding = bindResult(store, threadId, resultId);
      const revision = captureRevision(binding.project, { paths: scopes });
      const project = revision.project;
      const reviewId = `rv-${reviewIdentity({ ...binding, project }, scopes, revision.sha256).slice(0, 48)}`;
      const record = {
        version: REVIEW_VERSION,
        type: 'revision-review',
        reviewId,
        threadId,
        resultId,
        requestId,
        taskId: binding.task.id,
        workerId: binding.worker.id,
        project,
        terminalId: binding.worker.terminalId,
        launch: binding.launch,
        activation: binding.activation,
        provenance: binding.provenance,
        reportFingerprint: binding.reportFingerprint,
        scopes,
        revision,
        revisionSha256: revision.sha256,
        capturedAt: new Date().toISOString(),
      };
      if (Buffer.byteLength(JSON.stringify(record)) > REVIEW_LIMITS.maxRecordBytes) {
        throw new RangeError(`review record exceeds the ${REVIEW_LIMITS.maxRecordBytes}-byte limit`);
      }
      const existing = store.meta(reviewKey(reviewId));
      if (existing) {
        if (existing.revisionSha256 !== revision.sha256) throw new Error('A different review already uses this identity; refusing to overwrite it');
        store.meta(requestKey(threadId, resultId, requestId), requestRecord(existing, scopes));
        return existing;
      }
      store.meta(reviewKey(reviewId), record);
      store.meta(requestKey(threadId, resultId, requestId), requestRecord(record, scopes));
      store.journal('revision-review.captured', { reviewId, resultId, workerId: binding.worker.id, scopes, revisionSha256: revision.sha256 });
      return record;
    });
  }

  /**
   * Freshly verify the reviewed files and, only if the exact captured revision
   * still matches and the worker/result/activation binding is unchanged, record
   * a revision-bound acceptance action atomically. A stable retry is idempotent;
   * changed review/hash/text/request or a legacy unbound acceptance conflicts.
   */
  acceptReview({ threadId, resultId, reviewId, expectedRevision, requestId, text } = {}) {
    requireThreadId(threadId);
    requireResultId(resultId);
    requireReviewId(reviewId);
    if (typeof expectedRevision !== 'string' || !SHA256_RE.test(expectedRevision)) throw new TypeError('expectedRevision must be the captured lowercase sha256 digest');
    requireRequestId(requestId);
    const note = requireText(text, 'text', REVIEW_LIMITS.maxTextBytes);
    const store = this.store;

    const message = store.message(resultId);
    if (!message) throw new Error(`Unknown result message: ${resultId}`);
    if (message.action) return replayOrConflict(store, message, { threadId, resultId, reviewId, expectedRevision, requestId, text: note });

    const record = store.meta(reviewKey(reviewId));
    if (!record) throw new Error('Unknown review; capture it before accepting');
    if (record.version !== REVIEW_VERSION || record.type !== 'revision-review') throw new Error('Unsupported review record');
    if (record.threadId !== threadId) throw new Error('The review belongs to a different manager chat');
    if (record.resultId !== resultId) throw new Error('The review was captured for a different result');
    if (record.revisionSha256 !== expectedRevision) throw new Error('expectedRevision does not match the captured review');

    const preBinding = bindResult(store, threadId, resultId);
    const preDrift = bindingDrift(record, preBinding);
    if (preDrift.length) throw new Error(`The reviewed worker/result binding changed (${preDrift.join(', ')}); capture a fresh review before accepting`);

    // Fresh, observable verification before any action or acknowledgement.
    const verification = verifyRevision(record.project, record.revision);
    if (!verification.match) {
      const what = verification.changed_paths.length ? verification.changed_paths.join(', ') : verification.error?.message ?? 'unreadable revision';
      throw new Error(`The reviewed files changed since capture (${what}); refusing acceptance before recording any action`);
    }

    return store.transaction(() => {
      const current = store.message(resultId);
      if (!current) throw new Error(`Unknown result message: ${resultId}`);
      if (current.action) return replayOrConflict(store, current, { threadId, resultId, reviewId, expectedRevision, requestId, text: note });
      const accepted = store.meta(acceptKey(reviewId));
      if (accepted && accepted.resultId !== resultId) throw new Error(`Review ${reviewId} was already accepted for a different result`);
      const binding = bindResult(store, threadId, resultId);
      const drift = bindingDrift(record, binding);
      if (drift.length) throw new Error(`The reviewed worker/result binding changed (${drift.join(', ')}); capture a fresh review before accepting`);
      const action = { kind: 'accept', text: note, requestId, review: acceptanceBinding(record, reviewId) };
      const recorded = store.recordAction(resultId, action);
      store.meta(acceptKey(reviewId), {
        version: REVIEW_VERSION,
        reviewId,
        resultId,
        threadId,
        requestId,
        revisionSha256: record.revisionSha256,
        acceptedAt: recorded.at,
      });
      store.journal('revision-review.accepted', {
        reviewId, resultId, workerId: record.workerId, requestId, revisionSha256: record.revisionSha256,
      });
      return {
        accepted: true,
        bound: true,
        replay: false,
        reviewId,
        resultId,
        threadId,
        taskId: record.taskId,
        workerId: record.workerId,
        expectedRevision,
        revisionSha256: record.revisionSha256,
        revision: record.revision,
        verification,
        action: recorded,
      };
    });
  }

  /**
   * Report the recorded acceptance for a result separately from whether the
   * currently selected files still match the accepted revision. Historical
   * acceptance is never reported as current completion.
   */
  verifyAcceptedRevision({ threadId, resultId, reviewId } = {}) {
    requireThreadId(threadId);
    requireResultId(resultId);
    if (reviewId !== undefined) requireReviewId(reviewId);
    const store = this.store;
    const message = store.message(resultId);
    if (!message) throw new Error(`Unknown result message: ${resultId}`);
    const task = store.task(message.taskId);
    if (!task || task.threadId !== threadId) {
      return { accepted: false, bound: false, verified: null, stale: false, resultId, threadId, reason: 'result-does-not-belong-to-chat' };
    }
    const action = message.action;
    if (!action || action.kind !== 'accept') {
      return { accepted: false, bound: false, verified: null, stale: false, resultId, threadId, reason: 'no-acceptance' };
    }
    if (!action.review) {
      return {
        accepted: true, bound: false, verified: null, stale: false, resultId, threadId,
        requestId: action.requestId ?? null, acceptedAt: action.at ?? null,
        reason: 'legacy-unbound-acceptance',
        note: 'This acceptance predates revision binding; current content is not attested.',
      };
    }
    const bound = action.review;
    if (reviewId !== undefined && reviewId !== bound.reviewId) {
      return { accepted: true, bound: true, verified: false, stale: true, resultId, threadId, reviewId: bound.reviewId, reason: 'review-id-mismatch' };
    }
    const record = store.meta(reviewKey(bound.reviewId));
    if (!record) {
      return { accepted: true, bound: true, verified: false, stale: true, resultId, threadId, reviewId: bound.reviewId, reason: 'review-record-missing' };
    }
    let binding;
    try {
      binding = bindResult(store, threadId, resultId);
    } catch (error) {
      const predates = /predates the current worker activation/.test(error.message);
      return {
        accepted: true, bound: true, verified: false, stale: true, resultId, threadId, reviewId: bound.reviewId,
        expectedSha256: record.revisionSha256, reason: predates ? 'result-predates-activation' : 'binding-unavailable', error: error.message,
      };
    }
    const drift = bindingDrift(record, binding);
    if (drift.length) {
      return {
        accepted: true, bound: true, verified: false, stale: true, resultId, threadId, reviewId: bound.reviewId,
        expectedSha256: record.revisionSha256, reason: 'binding-changed', changed: drift,
      };
    }
    const verification = verifyRevision(record.project, record.revision);
    return {
      accepted: true,
      bound: true,
      verified: verification.match,
      stale: !verification.match,
      resultId,
      threadId,
      reviewId: bound.reviewId,
      taskId: record.taskId,
      workerId: record.workerId,
      provenance: record.provenance ?? null,
      expectedSha256: record.revisionSha256,
      actualSha256: verification.actual_sha256,
      changedPaths: verification.changed_paths,
      revisionConsistent: verification.revision_consistent,
      error: verification.error ?? null,
      scopes: record.scopes,
    };
  }
}

/** Convenience factory for callers that only have a Store. */
export function createRevisionReviews(store) {
  return new RevisionReviews(store);
}
