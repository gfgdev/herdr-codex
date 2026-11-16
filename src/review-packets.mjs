import { Notifications } from './notifications.mjs';
import { digest } from './config.mjs';

/**
 * Durable, compact review packets (packet record v1).
 *
 * A review packet is a manager-captured, content-addressed snapshot of one
 * notification handling operation for an exact manager chat. It reuses the
 * accepted `Notifications` service for ownership and receipt semantics and the
 * real `Store` for durable, transactional persistence. It deliberately adds no
 * scheduler, no native subprocess, no filesystem scan and no host/queue client.
 *
 * Guarantees enforced by construction:
 *   - Ownership validation, `Notifications.receive` and the durable packet save
 *     happen in ONE shared `Store.transaction`. A fault rolls back both the
 *     manager receipt and the packet, so a caller never sees a partial receive.
 *   - The finite report-count limit is checked BEFORE `receive` commits. An
 *     overflow is refused without marking any report received.
 *   - `batchId` is a stable idempotency key: a lost first response is recovered
 *     by replaying the original packet, and reuse with conflicting
 *     chat/notification parameters is refused.
 *   - Packet membership is the ORIGINAL batch membership. Per-report action,
 *     acknowledgement and task states are projected fresh on every read, so an
 *     already-handled member can never masquerade as pending and new unrelated
 *     reports are never swept into an old batch.
 *   - Captured history (`capturedActionable`) is kept distinct from the CURRENT
 *     per-report eligibility (`currentActionable`/`currentPending`) recomputed
 *     from the Store on every read. Task closure, worker absence and
 *     acknowledgement are explicit current states and never restart work.
 *   - Only a genuinely actionable receive keeps the current-inbox semantics for
 *     the chat. A stale envelope may recover its own known membership but never
 *     adopts unrelated newer work.
 *   - Report text, references and observation values are bounded; any clipping
 *     or dropped item is reported, never silently hidden.
 *   - Packets are evidence only: they never acknowledge, accept, reply to or
 *     signal a worker. They never dereference a referenced path, run a tests
 *     argv, read a terminal/log, or claim terminal verification.
 *   - Report text and evidence/revision references are bounded snapshots of
 *     untrusted worker claims, and are labelled as such.
 */

export const REVIEW_PACKET_LIMITS = Object.freeze({
  maxBatchIdLength: 128,
  maxNotificationIdLength: 128,
  maxReports: 256,
  maxPreviewBytes: 512,
  maxPageItems: 100,
  maxPageBytes: 32 * 1024,
  maxRefs: 32,
  maxRefLength: 512,
  maxRecordBytes: 4 * 1024 * 1024,
  maxCursorBytes: 4096,
});

export const REVIEW_PACKET_VERSION = 1;

const PACKET_PREFIX = 'review-packet:';
const OBSERVATION_PREFIX = 'observation:';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THREAD_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const CURSOR_FIELDS = Object.freeze(['v', 'batchId', 'threadId', 'fingerprint', 'after']);
const OBSERVATION_FIELDS = Object.freeze(['state', 'turn', 'episode', 'working', 'observedAt', 'activationId', 'quarantined']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const now = () => new Date().toISOString();
const packetKey = batchId => `${PACKET_PREFIX}${batchId}`;

function fields(value, allowed, name) {
  if (!object(value)) throw new TypeError(`${name} request must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field: ${key}`);
}

function requireThreadId(value) {
  if (typeof value !== 'string' || !THREAD_RE.test(value)) throw new TypeError('threadId must be the exact manager chat UUID');
  return value;
}

function requireId(value, name, max) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new TypeError(`${name} must be a safe identifier`);
  if (value.length > max) throw new RangeError(`${name} exceeds ${max} characters`);
  return value;
}

function requireCount(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  if (value > max) throw new RangeError(`${name} exceeds the ${max} limit`);
  return value;
}

/** Deterministic, key-sorted JSON so an identical packet always hashes identically. */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (object(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = canonicalValue(item);
    }
    return out;
  }
  return value;
}
const canonicalJson = value => JSON.stringify(canonicalValue(value));

/** Truncate on a code-point boundary so a multibyte preview never gains U+FFFD. */
function truncateUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) return { text: out, truncated: true };
    out += ch;
    bytes += size;
  }
  return { text: out, truncated: true };
}

/**
 * Bounded textual references. Claims are recorded as strings but never opened.
 * Any per-item clipping or dropped item is reported in the envelope, never
 * silently hidden.
 */
function normalizeRefs(value, limits) {
  const list = value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]);
  const items = [];
  let kept = 0;
  let dropped = 0;
  let clipped = 0;
  for (const item of list) {
    let text;
    if (typeof item === 'string') text = item;
    else if (typeof item === 'number' || typeof item === 'boolean') text = String(item);
    else {
      try { text = JSON.stringify(item); } catch { text = String(item); }
    }
    if (typeof text !== 'string') text = String(item);
    if (text.length === 0 || text.includes('\0')) continue;
    if (kept >= limits.maxRefs) { dropped += 1; continue; }
    const bounded = truncateUtf8(text, limits.maxRefLength);
    if (bounded.truncated) clipped += 1;
    items.push(bounded.text);
    kept += 1;
  }
  return {
    items,
    total: kept + dropped,
    dropped,
    clipped,
    truncated: dropped > 0 || clipped > 0,
    maxRefs: limits.maxRefs,
    maxRefLength: limits.maxRefLength,
  };
}

/**
 * Bounded references extracted from an accepted worker-evidence v1 claim. No
 * referenced path is opened or resolved; only textual pointers are surfaced.
 */
function evidenceRefs(evidence, limits) {
  if (!object(evidence)) return normalizeRefs(evidence, limits);
  const list = [];
  const push = value => {
    if (typeof value === 'string' && value.length) list.push(value);
    else if (object(value)) {
      for (const key of ['sha256', 'project']) if (typeof value[key] === 'string' && value[key].length) list.push(value[key]);
    }
  };
  push(evidence.final_revision);
  push(evidence.baseline_revision);
  if (Array.isArray(evidence.artifacts)) for (const a of evidence.artifacts) if (object(a)) push(a.path);
  if (Array.isArray(evidence.tests)) for (const t of evidence.tests) if (object(t)) push(t.output_path);
  return normalizeRefs(list, limits);
}

/** Already-captured observation metadata only; no native probe or fs read. */
function observationsFor(store, workerId, limits) {
  if (typeof workerId !== 'string' || workerId.length === 0) return [];
  const raw = store.meta(`${OBSERVATION_PREFIX}${workerId}`);
  if (!object(raw)) return [];
  const value = {};
  let truncated = false;
  for (const key of OBSERVATION_FIELDS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'string') {
      const bounded = truncateUtf8(raw[key], limits.maxRefLength);
      if (bounded.truncated) truncated = true;
      value[key] = bounded.text;
    } else if (typeof raw[key] === 'number' || typeof raw[key] === 'boolean' || raw[key] === null) {
      value[key] = raw[key];
    } else {
      let text;
      try { text = JSON.stringify(raw[key]); } catch { text = String(raw[key]); }
      const bounded = truncateUtf8(text, limits.maxRefLength);
      if (bounded.truncated) truncated = true;
      value[key] = bounded.text;
    }
  }
  return [{
    source: 'store-metadata',
    key: `${OBSERVATION_PREFIX}${workerId}`,
    authority: 'store-recorded',
    referencesDereferenced: false,
    truncated,
    value,
  }];
}

const PACKET_PROVENANCE = Object.freeze({
  authority: 'worker-claims',
  untrusted: true,
  terminalVerified: false,
  referencesDereferenced: false,
  workerSignaled: false,
  acknowledged: false,
  accepted: false,
  note: 'Review packets are durable evidence only. They may mark manager receipt of a notification but never acknowledge, accept, reply to, or signal a worker; no terminal, log, or referenced path was inspected.',
});

function reportProvenance() {
  return {
    authority: 'worker-claims',
    untrusted: true,
    referencesDereferenced: false,
    note: 'Report text and evidence/revision references are untrusted worker claims read from the Store; they were not dereferenced and no terminal was inspected.',
  };
}

function buildReport(message, store, limits) {
  const rawText = typeof message.text === 'string' ? message.text : '';
  const preview = truncateUtf8(rawText, limits.maxPreviewBytes);
  return {
    messageId: message.id,
    taskId: typeof message.taskId === 'string' ? message.taskId : null,
    workerId: typeof message.workerId === 'string' ? message.workerId : null,
    terminalId: typeof message.terminalId === 'string' ? message.terminalId : null,
    kind: typeof message.kind === 'string' ? message.kind : null,
    origin: typeof message.origin === 'string' ? message.origin : null,
    createdAt: typeof message.createdAt === 'string' ? message.createdAt : null,
    summary: {
      text: preview.text,
      bytes: Buffer.byteLength(preview.text, 'utf8'),
      sourceBytes: Buffer.byteLength(rawText, 'utf8'),
      truncated: preview.truncated,
    },
    refs: {
      evidence: evidenceRefs(message.evidence, limits),
      revision: normalizeRefs(message.revision, limits),
      handoff: normalizeRefs(message.handoff, limits),
    },
    observations: observationsFor(store, message.workerId, limits),
    provenance: reportProvenance(),
  };
}

function buildSnapshot(messages, store, limits) {
  const reportIds = [];
  const reports = {};
  const taskIds = new Set();
  const workerIds = new Set();
  for (const message of messages) {
    if (typeof message?.id !== 'string') continue;
    reportIds.push(message.id);
    reports[message.id] = buildReport(message, store, limits);
    if (typeof message.taskId === 'string') taskIds.add(message.taskId);
    if (typeof message.workerId === 'string' && message.workerId.length) workerIds.add(message.workerId);
  }
  return { reportIds, reports, taskIds: [...taskIds].sort(), workerIds: [...workerIds].sort() };
}

export class ReviewPackets {
  constructor({ store, config = {}, queue, notifications, limits = {} } = {}) {
    if (!store || typeof store.transaction !== 'function' || typeof store.meta !== 'function') {
      throw new TypeError('ReviewPackets requires a Store instance');
    }
    this.store = store;
    this.config = config;
    this.limits = Object.freeze({ ...REVIEW_PACKET_LIMITS, ...limits });
    // An injected service must share the EXACT Store connection used by the
    // packets: Notifications.receive and the packet write have to land in the
    // same Store.transaction, otherwise a fault rolls back one side only.
    if (notifications === undefined || notifications === null) {
      this.notifications = new Notifications({ store, queue, config });
    } else if (
      notifications instanceof Notifications
      && notifications.store === store
      && notifications.db === store.db
    ) {
      this.notifications = notifications;
    } else {
      throw new TypeError(
        'ReviewPackets was given a Notifications service bound to a different Store; an injected service must share the exact Store/transaction connection used by the packets',
      );
    }
  }

  /**
   * Capture (or replay) the packet for one notification handling operation.
   * The count limit is enforced before `receive`; the byte limit is enforced
   * inside the same transaction, so either refusal rolls everything back.
   */
  capture(request = {}) {
    fields(request, ['threadId', 'notificationId', 'batchId'], 'capture');
    const threadId = requireThreadId(request.threadId);
    const notificationId = requireId(request.notificationId, 'notificationId', this.limits.maxNotificationIdLength);
    const batchId = requireId(request.batchId, 'batchId', this.limits.maxBatchIdLength);
    return this.store.transaction(() => {
      const prior = this.store.meta(packetKey(batchId));
      if (prior) {
        if (prior.version !== REVIEW_PACKET_VERSION || prior.type !== 'review-packet') throw new Error('Unsupported review packet record');
        if (prior.threadId !== threadId) throw new Error('batchId already captured a review packet for a different manager chat');
        if (prior.notificationId !== notificationId) throw new Error('batchId already captured a different notification');
        return this.#summary(this.#load(batchId), true);
      }

      const notification = this.notifications.get(notificationId);
      if (!notification) throw new Error(`Unknown notification: ${notificationId}`);
      if (notification.threadId !== threadId) throw new Error('Notification belongs to a different manager chat');

      const members = Array.isArray(notification.members)
        ? [...new Set(notification.members.filter(id => typeof id === 'string'))]
        : [];
      // A receive is genuinely actionable only while the envelope is still open
      // and still owns at least one unreceived member. Anything else is a stale
      // envelope: it may recover its own known membership, but it must never
      // adopt unrelated newer work from the chat.
      const genuinelyActionable = !notification.receivedAt
        && notification.state !== 'retired'
        && this.notifications.inbox(threadId, { unreceived: true }).some(m => members.includes(m.id));

      // The finite record limit is enforced BEFORE `receive` commits.
      // A genuinely actionable envelope captures only the reports it currently
      // owns. The chat-wide `Notifications.inbox(threadId)` is the explicit
      // full read and is deliberately NOT used here: an unrelated pending report
      // must not be swept into this packet or marked received on its behalf.
      const source = genuinelyActionable
        ? this.notifications.inbox(threadId).filter(m => members.includes(m.id))
        : members.map(id => this.store.message(id)).filter(Boolean);
      if (source.length > this.limits.maxReports) {
        throw new RangeError(`review packet would capture ${source.length} reports, exceeding the ${this.limits.maxReports}-report limit`);
      }

      const snapshot = buildSnapshot(source, this.store, this.limits);
      const received = this.notifications.receive(notificationId);
      const handled = this.notifications.get(notificationId) ?? notification;
      const capturedActionable = received.actionable === true;

      const body = {
        version: REVIEW_PACKET_VERSION,
        type: 'review-packet',
        batchId,
        threadId,
        notificationId,
        capturedAt: now(),
        // Captured history: what this batch observed at write time. Current
        // eligibility is always recomputed on read and is never stored here.
        capturedActionable,
        capturedAlreadyHandled: !capturedActionable,
        restarted: false,
        note: typeof received.note === 'string' ? received.note : null,
        notification: {
          state: typeof handled.state === 'string' ? handled.state : null,
          receivedAt: typeof handled.receivedAt === 'string' ? handled.receivedAt : null,
          createdAt: typeof notification.createdAt === 'string' ? notification.createdAt : null,
        },
        memberIds: members,
        reportIds: snapshot.reportIds,
        taskIds: snapshot.taskIds,
        workerIds: snapshot.workerIds,
        reports: snapshot.reports,
        provenance: PACKET_PROVENANCE,
      };

      const record = { ...body, fingerprint: digest(canonicalJson(body)) };
      const recordBytes = Buffer.byteLength(canonicalJson(record), 'utf8');
      if (recordBytes > this.limits.maxRecordBytes) {
        throw new RangeError(`review packet record is ${recordBytes} bytes, exceeding the ${this.limits.maxRecordBytes}-byte limit`);
      }
      this.store.meta(packetKey(batchId), record);
      this.store.journal('review-packet.captured', {
        batchId, threadId, notificationId, count: record.reportIds.length, capturedActionable,
      });
      return this.#summary(record, false);
    });
  }

  /** Compact packet view: original membership plus a fresh per-report state. */
  read(request = {}) {
    fields(request, ['threadId', 'batchId'], 'read');
    const threadId = requireThreadId(request.threadId);
    const batchId = requireId(request.batchId, 'batchId', this.limits.maxBatchIdLength);
    const record = this.#loadScoped(batchId, threadId);
    const members = record.reportIds.map(id => {
      const stored = record.reports[id] ?? {};
      return {
        messageId: id,
        captured: true,
        taskId: stored.taskId ?? null,
        workerId: stored.workerId ?? null,
        terminalId: stored.terminalId ?? null,
        kind: stored.kind ?? null,
        current: this.#currentState(id),
      };
    });
    const pending = members.filter(m => m.current.pending).length;
    const eligible = members.filter(m => m.current.eligible).length;
    return {
      found: true,
      ...this.#summary(record, false),
      members,
      counts: { members: members.length, pending, eligible, handled: members.length - pending },
    };
  }

  /** Detail page with explicit UTF-8 byte bounds and a batch/chat-bound cursor. */
  page(request = {}) {
    fields(request, ['threadId', 'batchId', 'cursor', 'limit', 'maxBytes'], 'page');
    const threadId = requireThreadId(request.threadId);
    const batchId = requireId(request.batchId, 'batchId', this.limits.maxBatchIdLength);
    const record = this.#loadScoped(batchId, threadId);
    const itemLimit = request.limit === undefined
      ? this.limits.maxPageItems
      : requireCount(request.limit, 'limit', this.limits.maxPageItems);
    const byteLimit = request.maxBytes === undefined
      ? this.limits.maxPageBytes
      : requireCount(request.maxBytes, 'maxBytes', this.limits.maxPageBytes);
    const after = request.cursor === undefined || request.cursor === null ? 0 : this.#decodeCursor(request.cursor, record);

    const items = [];
    let pageBytes = 0;
    let index = after;
    while (index < record.reportIds.length && items.length < itemLimit) {
      const item = this.#detailItem(record, record.reportIds[index]);
      // Measure the serialized items array, including JSON separators, so the
      // explicit budget is a real bound and never silently exceeded.
      const candidateBytes = Buffer.byteLength(JSON.stringify([...items, item]), 'utf8');
      if (candidateBytes > byteLimit) {
        if (items.length === 0) {
          const requiredBytes = Buffer.byteLength(JSON.stringify([item]), 'utf8');
          const error = new RangeError(`page byte budget is too small: the first detail item needs ${requiredBytes} bytes but maxBytes is ${byteLimit}`);
          error.code = 'PAGE_BUDGET_TOO_SMALL';
          error.requiredBytes = requiredBytes;
          throw error;
        }
        break;
      }
      items.push(item);
      pageBytes = candidateBytes;
      index += 1;
    }

    const cursor = index < record.reportIds.length ? this.#encodeCursor(record, index) : null;
    return {
      ...this.#summary(record, false),
      cursor,
      returned: items.length,
      remaining: record.reportIds.length - index,
      pageBytes,
      detailBudget: { maxBytes: byteLimit, maxItems: itemLimit, measuredOn: 'utf8(JSON.stringify(items)) including JSON separators' },
      items,
    };
  }

  #detailItem(record, id) {
    const stored = record.reports[id] ?? {};
    return {
      messageId: id,
      taskId: stored.taskId ?? null,
      workerId: stored.workerId ?? null,
      terminalId: stored.terminalId ?? null,
      kind: stored.kind ?? null,
      summary: stored.summary ?? null,
      refs: stored.refs ?? null,
      observations: stored.observations ?? [],
      provenance: stored.provenance ?? null,
      current: this.#currentState(id),
    };
  }

  /** Enumerate the packets for one chat only; never crosses chats. */
  list(request = {}) {
    fields(request, ['threadId'], 'list');
    const threadId = requireThreadId(request.threadId);
    const rows = this.store.db.prepare('SELECT data FROM metadata WHERE key LIKE ? ORDER BY key').all(`${PACKET_PREFIX}%`);
    const packets = [];
    for (const row of rows) {
      let record;
      try { record = JSON.parse(row.data); } catch { continue; }
      if (!object(record) || record.type !== 'review-packet' || record.version !== REVIEW_PACKET_VERSION) continue;
      if (record.threadId !== threadId) continue;
      const summary = this.#summary(record, false);
      packets.push({
        batchId: record.batchId,
        notificationId: record.notificationId,
        capturedAt: record.capturedAt,
        count: summary.count,
        capturedActionable: summary.capturedActionable,
        currentActionable: summary.currentActionable,
        currentPending: summary.currentPending,
        fingerprint: record.fingerprint,
      });
    }
    return { threadId, count: packets.length, packets };
  }

  #summary(record, replayed) {
    const states = record.reportIds.map(id => this.#currentState(id));
    const currentPending = states.filter(s => s.pending).length;
    const currentEligible = states.filter(s => s.eligible).length;
    const currentActionable = currentEligible > 0;
    return {
      version: record.version,
      type: record.type,
      batchId: record.batchId,
      threadId: record.threadId,
      notificationId: record.notificationId,
      capturedAt: record.capturedAt,
      fingerprint: record.fingerprint,
      replayed: Boolean(replayed),
      // Captured history: what this batch observed at write time. This is never
      // treated as live eligibility.
      capturedActionable: record.capturedActionable === true,
      capturedAlreadyHandled: record.capturedActionable !== true,
      // Current state: recomputed from the Store on every read. `actionable` and
      // `alreadyHandled` are the CURRENT aliases; a handled report can never
      // masquerade as pending and no work is ever restarted here.
      actionable: currentActionable,
      alreadyHandled: currentPending === 0,
      currentActionable,
      currentEligible,
      currentPending,
      currentHandled: record.reportIds.length - currentPending,
      restarted: false,
      evidenceOnly: true,
      canAcknowledge: false,
      canAccept: false,
      canSignal: false,
      note: record.note ?? null,
      count: record.reportIds.length,
      reportIds: [...record.reportIds],
      idEnvelope: {
        count: record.reportIds.length,
        boundedBy: 'maxReports',
        maxReports: this.limits.maxReports,
      },
      memberIds: [...record.memberIds],
      taskIds: [...record.taskIds],
      workerIds: [...record.workerIds],
      provenance: record.provenance,
    };
  }

  #currentState(messageId) {
    const message = this.store.message(messageId);
    if (!message) {
      return {
        present: false, pending: false, eligible: false, reason: 'missing-message',
        acknowledgedAt: null, receivedAt: null, delivery: null, action: null,
        taskStatus: null, taskActive: false, workerPresent: false,
      };
    }
    const taskStatus = this.store.task(message.taskId)?.status ?? null;
    const workerPresent = Boolean(this.store.worker(message.workerId));
    const pending = !message.acknowledgedAt && message.kind !== 'progress';
    const reasons = [];
    if (!pending) reasons.push(message.kind === 'progress' ? 'progress-report' : 'acknowledged');
    if (taskStatus !== 'active') reasons.push(`task-${taskStatus ?? 'missing'}`);
    if (!workerPresent) reasons.push('worker-missing');
    return {
      present: true,
      pending,
      eligible: pending && taskStatus === 'active' && workerPresent,
      reason: reasons.length ? reasons.join('+') : 'actionable',
      acknowledgedAt: message.acknowledgedAt ?? null,
      receivedAt: message.receivedAt ?? null,
      delivery: message.delivery ?? null,
      action: message.action
        ? { kind: message.action.kind ?? null, state: message.action.state ?? null, requestId: message.action.requestId ?? null }
        : null,
      taskStatus,
      taskActive: taskStatus === 'active',
      workerPresent,
    };
  }

  #load(batchId) {
    const record = this.store.meta(packetKey(batchId));
    if (!record) throw new Error(`Unknown review packet: ${batchId}`);
    if (record.version !== REVIEW_PACKET_VERSION || record.type !== 'review-packet') throw new Error('Unsupported review packet record');
    const { fingerprint, ...body } = record;
    if (typeof fingerprint !== 'string' || digest(canonicalJson(body)) !== fingerprint) {
      throw new Error('Review packet record failed integrity verification');
    }
    return record;
  }

  #loadScoped(batchId, threadId) {
    const record = this.#load(batchId);
    if (record.threadId !== threadId) throw new Error('Review packet belongs to a different manager chat; cross-chat reads are refused');
    return record;
  }

  #encodeCursor(record, after) {
    return Buffer.from(JSON.stringify({
      v: 1, batchId: record.batchId, threadId: record.threadId, fingerprint: record.fingerprint, after,
    }), 'utf8').toString('base64url');
  }

  #decodeCursor(cursor, record) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > this.limits.maxCursorBytes || !CURSOR_RE.test(cursor)) {
      throw new TypeError('cursor is malformed');
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new TypeError('cursor is malformed'); }
    if (!object(parsed)) throw new TypeError('cursor is malformed');
    for (const key of Object.keys(parsed)) if (!CURSOR_FIELDS.includes(key)) throw new TypeError('cursor is malformed');
    if (parsed.v !== 1 || parsed.batchId !== record.batchId || parsed.threadId !== record.threadId || parsed.fingerprint !== record.fingerprint) {
      throw new Error('cursor does not belong to this review packet');
    }
    if (!Number.isSafeInteger(parsed.after) || parsed.after < 0 || parsed.after > record.reportIds.length) throw new TypeError('cursor is malformed');
    return parsed.after;
  }
}

export { PACKET_PROVENANCE as REVIEW_PACKET_PROVENANCE };
