import { isAbsolute } from 'node:path';
import { subscribeJournalActivity } from './activity-ipc.mjs';

export const DEFAULT_ACTIVITY_TYPES = Object.freeze([
  'message.recorded', 'agent.request.failed', 'agent.request.uncertain',
  'agent.interrupted', 'agent.closed', 'agent.launch.failed', 'agent.launch.uncertain',
  'agent.stopped',
]);
const MESSAGE_KINDS = ['question', 'result', 'attention'];
const BATCH_SIZE = 100;

function inputOptions({ store, workers, dbPath, after, timeoutMs, includeProgress, types, previewChars }) {
  if (!store?.db?.prepare || !store?.message) throw new TypeError('A Herdr Store is required');
  if (typeof dbPath !== 'string' || !isAbsolute(dbPath) || dbPath.includes('\0')) throw new TypeError('dbPath must be an absolute SQLite path');
  if (!Array.isArray(workers) || !workers.length || workers.some(w => !w || typeof w.id !== 'string' || !w.id)) {
    throw new TypeError('workers must contain at least one registered worker object');
  }
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a nonnegative journal cursor');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new TypeError('timeoutMs must fit a Node timer');
  if (typeof includeProgress !== 'boolean') throw new TypeError('includeProgress must be boolean');
  if (!Array.isArray(types) || !types.length || types.some(t => typeof t !== 'string' || !t)) throw new TypeError('types must be nonempty event names');
  if (!Number.isSafeInteger(previewChars) || previewChars < 0 || previewChars > 2048) throw new TypeError('previewChars must be between 0 and 2048');
}

/** Subscribe acknowledgement precedes the consistent durable snapshot.
 * No filesystem watches, intervals, status polls, or native/model calls.
 * after=0 returns pending attention and starts at the journal head; nonzero
 * cursors replay subsequent selected activity. Closing a wait never stops agents.
 * The updated bridge must own this installation's activity bus.
 */
export function waitForAgentActivity({
  store, workers, dbPath, after = 0, timeoutMs = 30_000,
  includeProgress = false, types = DEFAULT_ACTIVITY_TYPES, previewChars = 0,
  signal, subscribe = subscribeJournalActivity,
} = {}) {
  inputOptions({ store, workers, dbPath, after, timeoutMs, includeProgress, types, previewChars });
  if (typeof subscribe !== 'function') throw new TypeError('subscribe must be a function');
  const ids = [...new Set(workers.map(w => w.id))];
  const marks = ids.map(() => '?').join(',');
  const kinds = includeProgress ? [...MESSAGE_KINDS, 'progress'] : MESSAGE_KINDS;
  const maxSequence = store.db.prepare('SELECT COALESCE(MAX(seq),0) AS head FROM journal');
  const outstanding = store.db.prepare(`SELECT j.seq,j.at,j.type,j.data
    FROM journal j JOIN messages m ON m.id=json_extract(j.data,'$.id')
    WHERE j.type='message.recorded' AND m.ack_at IS NULL
      AND m.worker_id IN (${marks}) AND m.kind IN (${kinds.map(() => '?').join(',')})
    ORDER BY j.seq`);
  const subsequent = store.db.prepare(`SELECT seq,at,type,data FROM journal
    WHERE seq>? AND seq<=? AND type IN (${types.map(() => '?').join(',')})
      AND (json_extract(data,'$.workerId') IN (${marks}) OR json_extract(data,'$.agentId') IN (${marks}))
    ORDER BY seq LIMIT ${BATCH_SIZE + 1}`);
  let cursor = after, bootstrap = after === 0;

  function compact(row) {
    const data = JSON.parse(row.data);
    const common = { seq: row.seq, at: row.at, type: row.type,
      workerId: data.workerId ?? data.agentId, ...(data.taskId ? { taskId: data.taskId } : {}) };
    if (row.type === 'message.recorded') {
      const message = store.message(data.id);
      if (!message || message.acknowledgedAt || !ids.includes(message.workerId) || !kinds.includes(message.kind)) return null;
      return { ...common, workerId: message.workerId, taskId: message.taskId,
        messageId: message.id, kind: message.kind, delivery: message.delivery,
        ...(previewChars ? { preview: message.text.slice(0, previewChars), previewTruncated: message.text.length > previewChars } : {}) };
    }
    return { ...common,
      ...(data.requestId ? { requestId: data.requestId } : {}),
      ...(data.state ? { state: data.state } : {}),
      ...(data.terminalId ? { terminalId: data.terminalId } : {}),
    };
  }

  function snapshot() {
    // Use a read transaction so cursor and rows describe one committed snapshot.
    // This helper is invoked outside any caller-owned Store transaction.
    if (store.transactionDepth) throw new Error('Activity wait cannot run inside a Store transaction');
    store.db.exec('BEGIN DEFERRED');
    try {
      const head = maxSequence.get().head;
      if (cursor > head) throw new Error('Journal cursor is ahead of this database; select the correct installation');
      if (bootstrap) {
        const activities = types.includes('message.recorded')
          ? outstanding.all(...ids, ...kinds).map(compact).filter(Boolean) : [];
        cursor = head; bootstrap = false;
        store.db.exec('COMMIT');
        return { cursor, activities, more: false };
      }
      const rows = subsequent.all(cursor, head, ...types, ...ids, ...ids);
      const more = rows.length > BATCH_SIZE;
      const batch = rows.slice(0, BATCH_SIZE);
      const activities = batch.map(compact).filter(Boolean);
      cursor = more ? batch.at(-1).seq : head;
      store.db.exec('COMMIT');
      return { cursor, activities, more };
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    const setupAbort = new AbortController();
    let subscription, timer, scheduled, done = false, ready = false;
    const cleanup = () => {
      clearTimeout(timer); clearImmediate(scheduled);
      signal?.removeEventListener('abort', aborted);
      setupAbort.abort(); subscription?.close();
    };
    const finish = (result, error) => {
      if (done) return;
      done = true;
      try { cleanup(); } catch (closeError) { error ??= closeError; }
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => finish(null, signal.reason ?? Object.assign(new Error('Activity wait aborted'), { name: 'AbortError' }));
    const check = (deadline = false) => {
      if (done || !ready) return;
      try {
        let result;
        do { result = snapshot(); } while (!result.activities.length && result.more);
        if (result.activities.length) finish({ reason: 'activity', ...result });
        else if (deadline) finish({ reason: 'timeout', ...result });
      } catch (error) { finish(null, error); }
    };
    const changed = () => {
      if (done || !ready || scheduled) return;
      scheduled = setImmediate(() => { scheduled = null; check(); });
    };
    try {
      if (signal?.aborted) { aborted(); return; }
      signal?.addEventListener('abort', aborted, { once: true });
      Promise.resolve(subscribe({ dbPath, onActivity: changed,
        onError: error => finish(null, error), signal: setupAbort.signal,
      })).then(handle => {
        if (typeof handle?.close !== 'function') throw new Error('Activity subscription returned no cleanup handle');
        subscription = handle;
        if (done) { subscription.close(); return; }
        ready = true;
        check(timeoutMs === 0);
        if (!done) timer = setTimeout(() => check(true), timeoutMs);
      }).catch(error => finish(null, error));
    } catch (error) { finish(null, error); }
  });
}
