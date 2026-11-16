import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Notifications } from '../src/notifications.mjs';
import { validateWorkerEvidence } from '../src/evidence.mjs';
import { ReviewPackets, REVIEW_PACKET_LIMITS, REVIEW_PACKET_VERSION } from '../src/review-packets.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER = '01a1d3b4-f77e-7363-b682-5c40fbe482f4';
const cfg = { path: '/test/herdr-config.json', packageRoot: '/test/herdr' };
const input = text => [{ type: 'text', text, text_elements: [] }];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-review-packets-'));
  const dbPath = join(root, 'store.db');
  const opened = [];
  const open = () => { const store = new Store(dbPath); opened.push(store); return store; };
  const store = open();
  t.after(async () => {
    for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
    await rm(root, { recursive: true, force: true });
  });
  for (const [i, task] of [
    { id: 'task-a', name: 'Project A', project: '/project/a', threadId: THREAD, status: 'active' },
    { id: 'task-b', name: 'Project B', project: '/project/b', threadId: OTHER, status: 'active' },
  ].entries()) {
    store.saveTask(task);
    store.saveWorker({ id: `worker-${i}`, name: `Worker ${i}`, project: task.project, taskId: task.id, terminalId: `t${i}`, mailbox: `box-${i}` });
  }
  let seq = 0;
  const rows = new Map();
  const queue = {
    async list(threadId) { return structuredClone(rows.get(threadId) ?? []); },
    async add(threadId, { clientId, text }) {
      const row = { id: `queue-${++seq}`, clientUserMessageId: clientId, input: input(text) };
      rows.set(threadId, [...(rows.get(threadId) ?? []), row]);
      return structuredClone(row);
    },
    async update(threadId, id, { text }) {
      const row = (rows.get(threadId) ?? []).find(r => r.id === id);
      row.input = input(text);
      return structuredClone(row);
    },
    async delete(threadId, id) {
      rows.set(threadId, (rows.get(threadId) ?? []).filter(r => r.id !== id));
      return true;
    },
  };
  const notifications = new Notifications({ store, queue, config: cfg });
  const ingest = (id, which = 0, extra = {}) => {
    const worker = store.worker(`worker-${which}`);
    store.ingest(worker, {
      id, taskId: worker.taskId, workerId: worker.id, terminalId: worker.terminalId,
      kind: 'result', text: `Report ${id}`, createdAt: new Date().toISOString(), ...extra,
    });
  };
  const ack = id => {
    store.recordAction(id, { kind: 'accept', requestId: `accept-${id}`, text: 'Verified fixture' });
    store.ack(id);
  };
  const openNotification = async (ids) => {
    for (const id of ids) ingest(id);
    await notifications.reconcile();
    const list = notifications.list(THREAD);
    return list[list.length - 1];
  };
  const service = (limits = {}) => new ReviewPackets({ store, config: cfg, notifications, limits });
  // A valid evidence v1 value: accepted fields only, matching the worker/task.
  const validEvidence = (worker, overrides = {}) => ({
    version: 1,
    worker_id: worker.id,
    task_id: worker.taskId,
    session_generation_id: 'review-packet-generation',
    baseline_revision: { sha256: 'a'.repeat(64), project: worker.project },
    final_revision: { sha256: 'b'.repeat(64), project: worker.project },
    changed_paths: ['src/index.mjs'],
    artifacts: [{ path: 'out/report.json', sha256: 'c'.repeat(64) }],
    tests: [{ argv: ['node', '--test'], cwd: '.', exit_code: 0, output_path: 'out/log.txt', truncated: false }],
    limitations: ['caf\u00e9'],
    unresolved_requests: [],
    ...overrides,
  });
  return { root, dbPath, open, store, queue, rows, notifications, ingest, ack, openNotification, service, validEvidence };
}

test('capture marks the exact reports received and records an evidence-only packet', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b']);
  const worker = f.store.worker('worker-0');
  const evidence = f.validEvidence(worker);
  assert.equal(Object.hasOwn(evidence, 'authority'), false, 'raw fixture carries no self-declared authority');
  assert.equal(validateWorkerEvidence(evidence).authority, 'worker-claims', 'fixture satisfies the accepted evidence v1 validator');
  f.ingest('report-c', 0, { evidence });
  // Membership must be current before capture: this report is added to the open
  // envelope, so capture legitimately owns it.
  await f.notifications.reconcile();
  const rp = f.service();
  const r = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-1' });

  assert.equal(r.version, REVIEW_PACKET_VERSION);
  assert.deepEqual(r.reportIds, ['report-a', 'report-b', 'report-c']);
  assert.equal(r.count, 3);
  assert.equal(r.evidenceOnly, true);
  assert.equal(r.canAcknowledge, false);
  assert.equal(r.canAccept, false);
  assert.equal(r.canSignal, false);
  assert.equal(r.restarted, false);
  assert.equal(r.capturedActionable, true, 'the batch was genuinely actionable when captured');
  assert.equal(r.actionable, true);
  assert.equal(r.currentActionable, true);
  assert.equal(r.currentPending, 3);
  assert.equal(r.currentEligible, 3);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(r.provenance.authority, 'worker-claims');
  assert.equal(r.provenance.terminalVerified, false);
  assert.equal(r.provenance.untrusted, true);

  for (const id of ['report-a', 'report-b', 'report-c']) assert.ok(f.store.message(id).receivedAt, `${id} should be received`);
  assert.ok(f.notifications.get(n.id).receivedAt, 'notification envelope records receipt');
  // Evidence only: nothing is acknowledged or actioned.
  for (const id of ['report-a', 'report-b', 'report-c']) {
    assert.equal(f.store.message(id).acknowledgedAt, null);
    assert.equal(f.store.message(id).action, null);
  }
  const page = rp.page({ threadId: THREAD, batchId: 'batch-1' });
  const c = page.items.find(i => i.messageId === 'report-c');
  // Accepted evidence v1 is surfaced as an explicit ref envelope, never opened.
  assert.ok(c.refs.evidence.items.includes('out/log.txt'), 'test output path is surfaced as a ref');
  assert.ok(c.refs.evidence.items.includes('a'.repeat(64)), 'baseline revision digest is surfaced');
  assert.ok(c.refs.evidence.items.includes('b'.repeat(64)), 'final revision digest is surfaced');
  assert.ok(c.refs.evidence.items.includes('out/report.json'), 'artifact path is surfaced as a ref');
  assert.ok(c.refs.evidence.items.includes(worker.project), 'revision project reference is surfaced');
  assert.equal(c.refs.evidence.truncated, false);
  assert.deepEqual(c.refs.revision.items, [], 'no top-level revision is invented');
  assert.equal(c.provenance.untrusted, true);
  assert.match(page.detailBudget.measuredOn, /JSON\.stringify/);
});

test('a lost-response retry with the same batch replays the original packet without re-receiving', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b']);
  const rp = f.service();
  const first = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-retry' });
  f.ingest('report-fresh');
  const second = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-retry' });

  assert.equal(second.replayed, true);
  assert.deepEqual(second.reportIds, first.reportIds);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.count, 2, 'a replay never expands the original batch');
  assert.equal(f.store.message('report-fresh').receivedAt, null, 'a new report is never swept into an old batch');
  const captures = f.store.db.prepare("SELECT COUNT(*) c FROM journal WHERE type='review-packet.captured'").get().c;
  assert.equal(captures, 1, 'replay writes no second capture journal entry');
});

test('reusing a batchId with a conflicting chat or notification is refused', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-conflict' });
  assert.throws(() => rp.capture({ threadId: OTHER, notificationId: n.id, batchId: 'batch-conflict' }), /different manager chat/);
  assert.throws(() => rp.capture({ threadId: THREAD, notificationId: 'hn-other', batchId: 'batch-conflict' }), /different notification/);
  assert.deepEqual(rp.read({ threadId: THREAD, batchId: 'batch-conflict' }).reportIds, ['report-a']);
});

test('a fresh inactive notification never restarts work and cannot signal a worker', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-1' });
  f.ack('report-a');

  const late = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-late' });
  assert.equal(late.capturedActionable, false, 'the batch was captured after being handled');
  assert.equal(late.capturedAlreadyHandled, true);
  assert.equal(late.actionable, false, 'a handled report is not currently actionable');
  assert.equal(late.alreadyHandled, true);
  assert.equal(late.currentPending, 0);
  assert.equal(late.currentEligible, 0);
  assert.equal(late.restarted, false);
  assert.equal(late.canSignal, false);

  const read = rp.read({ threadId: THREAD, batchId: 'batch-late' });
  assert.deepEqual(read.reportIds, ['report-a'], 'a stale envelope recovers only its own known membership');
  assert.equal(read.members[0].current.pending, false);
  assert.equal(read.members[0].current.eligible, false);
  assert.equal(read.members[0].current.reason, 'acknowledged');
  assert.equal(read.counts.pending, 0);
  assert.equal(read.alreadyHandled, true);
  assert.equal(f.store.message('report-a').action.kind, 'accept');
});

test('the finite report limit is enforced before receive commits, with no partial receive', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b', 'report-c']);
  const rp = f.service({ maxReports: 2 });
  assert.throws(() => rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-overflow' }), RangeError);
  for (const id of ['report-a', 'report-b', 'report-c']) {
    assert.equal(f.store.message(id).receivedAt, null, `${id} must remain unreceived`);
  }
  assert.equal(f.notifications.get(n.id).receivedAt, undefined);
  assert.equal(f.store.meta('review-packet:batch-overflow'), null);
  assert.equal(f.store.transactionDepth ?? 0, 0, 'the refused transaction released cleanly');
  const ok = f.service().capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-after' });
  assert.equal(ok.count, 3);
});

test('a fault after receive rolls back both the packet and the manager receipt', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b']);
  const failing = f.service({ maxRecordBytes: 10 });
  assert.throws(() => failing.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-rollback' }), RangeError);

  for (const id of ['report-a', 'report-b']) assert.equal(f.store.message(id).receivedAt, null, `${id} receipt rolled back`);
  assert.equal(f.notifications.get(n.id).receivedAt, undefined, 'notification receipt rolled back');
  assert.equal(f.store.meta('review-packet:batch-rollback'), null, 'no partial packet persisted');
  assert.equal(f.store.transactionDepth ?? 0, 0, 'transaction state released after rollback');

  const ok = f.service().capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-ok' });
  assert.equal(ok.count, 2);
  assert.ok(f.store.message('report-a').receivedAt);
});

test('an injected Notifications bound to a different Store is refused before any mutation', async t => {
  const f = await fixture(t);
  // Store B is a genuinely separate database/connection holding its own report.
  const storeB = new Store(join(f.root, 'store-b.db'));
  t.after(() => { try { storeB.close(); } catch { /* already closed */ } });
  storeB.saveTask({ id: 'task-b2', name: 'Project B2', project: '/project/b2', threadId: OTHER, status: 'active' });
  storeB.saveWorker({ id: 'worker-b2', name: 'Worker B2', project: '/project/b2', taskId: 'task-b2', terminalId: 'tb2', mailbox: 'box-b2' });
  const workerB = storeB.worker('worker-b2');
  storeB.ingest(workerB, { id: 'report-b2', taskId: 'task-b2', workerId: 'worker-b2', terminalId: 'tb2', kind: 'result', text: 'Report B2', createdAt: new Date().toISOString() });
  const notificationsB = new Notifications({ store: storeB, queue: f.queue, config: cfg });
  await notificationsB.reconcile();
  const nB = notificationsB.list(OTHER).at(-1);

  assert.throws(
    () => new ReviewPackets({ store: f.store, config: cfg, notifications: notificationsB }),
    /different Store/,
    'a mismatched Notifications service must be refused at construction',
  );
  // Refusal happens before any mutation: B's receipts and A's packet stay untouched.
  assert.equal(storeB.message('report-b2').receivedAt, null, 'B report must not be received');
  assert.equal(notificationsB.get(nB.id).receivedAt, undefined, 'B notification must not be received');
  assert.equal(f.store.meta('review-packet:batch-cross-store'), null, 'A must hold no packet');
  assert.equal(storeB.transactionDepth ?? 0, 0);

  // Same-Store injection is still accepted and remains transactional.
  const sameStore = new ReviewPackets({ store: f.store, config: cfg, notifications: f.notifications });
  assert.equal(sameStore.notifications, f.notifications);
});

test('a packet and its per-report state survive a Store restart', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b']);
  const first = f.service().capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-restart' });

  const store2 = f.open();
  const notifications2 = new Notifications({ store: store2, queue: f.queue, config: cfg });
  const rp2 = new ReviewPackets({ store: store2, config: cfg, notifications: notifications2 });
  const read = rp2.read({ threadId: THREAD, batchId: 'batch-restart' });
  assert.equal(read.found, true);
  assert.equal(read.fingerprint, first.fingerprint);
  assert.deepEqual(read.reportIds, ['report-a', 'report-b']);
  assert.equal(read.counts.pending, 2);
  assert.equal(rp2.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-restart' }).replayed, true);
});

test('cross-chat capture and read are refused', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-1' });
  assert.throws(() => rp.read({ threadId: OTHER, batchId: 'batch-1' }), /cross-chat/);
  assert.equal(rp.list({ threadId: OTHER }).count, 0);
  assert.throws(() => rp.capture({ threadId: OTHER, notificationId: n.id, batchId: 'batch-x' }), /different manager chat/);
});

test('malformed input and cursors are rejected', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-1' });
  assert.throws(() => rp.capture({ threadId: 'not-a-uuid', notificationId: n.id, batchId: 'batch-z' }), TypeError);
  assert.throws(() => rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'bad id!' }), TypeError);
  assert.throws(() => rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-z', extra: 1 }), /Unknown capture field/);
  assert.throws(() => rp.capture({ threadId: THREAD, notificationId: 'hn-missing', batchId: 'batch-missing' }), /Unknown notification/);
  assert.throws(() => rp.page({ threadId: THREAD, batchId: 'batch-1', cursor: 'not a cursor!' }), TypeError);
  assert.throws(() => rp.page({ threadId: THREAD, batchId: 'batch-1', cursor: 'x'.repeat(REVIEW_PACKET_LIMITS.maxCursorBytes + 1) }), TypeError);
  assert.throws(() => rp.page({ threadId: THREAD, batchId: 'batch-1', limit: 0 }), TypeError);
  assert.throws(() => rp.page({ threadId: THREAD, batchId: 'batch-1', limit: REVIEW_PACKET_LIMITS.maxPageItems + 1 }), RangeError);
});

test('pagination honours UTF-8 byte bounds, truncates on code-point boundaries and closes', async t => {
  const f = await fixture(t);
  f.ingest('report-a', 0, { text: `Report report-a ${'α'.repeat(40)}` });
  f.ingest('report-b', 0, { text: `Report report-b ${'β'.repeat(40)}` });
  const n = await f.openNotification([]);
  const rp = f.service({ maxPreviewBytes: 8 });
  const r = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-page' });
  assert.equal(r.count, 2);

  // A byte budget below the minimum serialized item is refused explicitly — it
  // must never silently exceed the limit or emit a non-progress cursor.
  let tooSmall;
  try { rp.page({ threadId: THREAD, batchId: 'batch-page', maxBytes: 1 }); assert.fail('expected a page budget error'); }
  catch (error) { tooSmall = error; }
  assert.equal(tooSmall.code, 'PAGE_BUDGET_TOO_SMALL');
  assert.ok(tooSmall.requiredBytes > 1, 'the required byte count is reported');
  assert.match(tooSmall.message, /page byte budget is too small/);

  const page = rp.page({ threadId: THREAD, batchId: 'batch-page', maxBytes: 4096 });
  assert.equal(page.returned, 2);
  assert.equal(page.cursor, null);
  assert.ok(page.pageBytes <= 4096, 'the serialized page stays within the explicit byte budget');
  assert.equal(page.items[0].messageId, r.reportIds[0]);
  const preview = page.items[0].summary;
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.text, 'utf8') <= 8);
  assert.doesNotMatch(preview.text, /\uFFFD/);
  assert.equal(page.reportIds.length, 2, 'all captured IDs are always returned');
  assert.equal(page.detailBudget.maxBytes, 4096);
  assert.match(page.detailBudget.measuredOn, /UTF-8|utf8/);
});

test('a cursor is bound to its batch and chat', async t => {
  const f = await fixture(t);
  const n1 = await f.openNotification(['report-a', 'report-b']);
  const rp = f.service({ maxPageItems: 1 });
  rp.capture({ threadId: THREAD, notificationId: n1.id, batchId: 'batch-1' });
  const p = rp.page({ threadId: THREAD, batchId: 'batch-1' });
  assert.ok(p.cursor);
  f.ack('report-a');
  await f.notifications.reconcile();
  f.ingest('report-c');
  await f.notifications.reconcile();
  const n2 = f.notifications.list(THREAD).at(-1);
  rp.capture({ threadId: THREAD, notificationId: n2.id, batchId: 'batch-2' });
  assert.throws(() => rp.page({ threadId: THREAD, batchId: 'batch-2', cursor: p.cursor }), /does not belong/);
  assert.throws(() => rp.page({ threadId: OTHER, batchId: 'batch-1', cursor: p.cursor }), /cross-chat/);
});

test('replay separates original membership from current per-report state', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-1' });
  f.ack('report-a');
  f.ingest('report-new');

  const read = rp.read({ threadId: THREAD, batchId: 'batch-1' });
  assert.deepEqual(read.reportIds, ['report-a', 'report-b'], 'membership is the original batch');
  assert.deepEqual(read.reportIds.includes('report-new'), false);
  const a = read.members.find(m => m.messageId === 'report-a');
  const b = read.members.find(m => m.messageId === 'report-b');
  assert.equal(a.current.pending, false);
  assert.ok(a.current.acknowledgedAt);
  assert.equal(b.current.pending, true);
  assert.deepEqual(read.counts, { members: 2, pending: 1, eligible: 1, handled: 1 });
});

test('capture consumes only the current notification members across overlapping notifications', async t => {
  const f = await fixture(t);
  const n1 = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n1.id, batchId: 'batch-1' });
  await f.notifications.reconcile(); // n1 retired once handled
  f.ingest('report-b');
  await f.notifications.reconcile();
  const n2 = f.notifications.list(THREAD).at(-1);

  const r2 = rp.capture({ threadId: THREAD, notificationId: n2.id, batchId: 'batch-2' });
  assert.equal(r2.count, 1, 'capture consumes only this notification current owned members');
  assert.deepEqual(r2.reportIds, ['report-b']);
  assert.equal(r2.reportIds.includes('report-a'), false, 'an earlier report owned by another notification is never re-received');
  assert.notDeepEqual(n1.id, n2.id);
});

test('capture never sweeps unrelated pending work, and a newer uncovered report still wakes later', async t => {
  const f = await fixture(t);
  // A: the notification under test owns exactly report-a.
  const n = await f.openNotification(['report-a']);
  // B: an earlier report already manager-received by another envelope, still pending.
  f.ingest('report-b');
  f.store.receive('report-b');
  const bBefore = f.store.message('report-b');
  assert.ok(bBefore.receivedAt);
  // C: newer, unreceived and not covered by A.
  f.ingest('report-c');
  assert.equal(f.notifications.covered('report-c'), null);

  const rp = f.service();
  const r = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-scope' });
  assert.equal(r.count, 1, 'only the notification owned report is captured');
  assert.deepEqual(r.reportIds, ['report-a']);
  assert.ok(f.store.message('report-a').receivedAt, 'report-a is received');
  // B is unrelated: receipt, action and ack are unchanged.
  assert.equal(f.store.message('report-b').receivedAt, bBefore.receivedAt);
  assert.equal(f.store.message('report-b').action, null);
  assert.equal(f.store.message('report-b').acknowledgedAt, null);
  // C is not consumed on A's behalf.
  assert.equal(f.store.message('report-c').receivedAt, null, 'uncovered newer report stays unreceived');

  // C still gets its own subsequent wake once A is handled.
  await f.notifications.reconcile();
  const fresh = f.notifications.list(THREAD).at(-1);
  assert.notEqual(fresh.id, n.id);
  assert.ok(fresh.members.includes('report-c'));
  assert.equal(f.store.message('report-c').receivedAt, null);
});

test('a report added to an open notification before receive is consumed with the envelope', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  f.ingest('report-b');
  const covered = f.notifications.cover(f.notifications.get(n.id), [f.store.message('report-b')]);
  assert.ok(covered.members.includes('report-b'), 'mutable membership is added to the open envelope');
  const rp = f.service();
  const r = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-mutable' });
  assert.deepEqual(r.reportIds, ['report-a', 'report-b']);
  assert.ok(f.store.message('report-b').receivedAt);
});

test('large results page through every captured ID with a stable cursor', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 23 }, (_, i) => `report-${String(i).padStart(2, '0')}`);
  const n = await f.openNotification(ids);
  const rp = f.service({ maxPageItems: 5 });
  const r = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-many' });
  assert.equal(r.count, ids.length);
  assert.deepEqual(r.reportIds, ids);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = rp.page({ threadId: THREAD, batchId: 'batch-many', cursor, limit: 5 });
    assert.equal(page.reportIds.length, ids.length);
    seen.push(...page.items.map(i => i.messageId));
    cursor = page.cursor;
    pages += 1;
  } while (cursor && pages < 20);
  assert.equal(cursor, null);
  assert.deepEqual(seen, ids);
});

test('observation references reuse already-captured Store metadata only', async t => {
  const f = await fixture(t);
  f.store.meta('observation:worker-0', { state: 'idle', turn: 3, quarantined: false, ignored: 'not-copied' });
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-obs' });
  const item = rp.page({ threadId: THREAD, batchId: 'batch-obs' }).items[0];
  assert.equal(item.observations.length, 1);
  const [obs] = item.observations;
  assert.equal(obs.source, 'store-metadata');
  assert.equal(obs.key, 'observation:worker-0');
  assert.equal(obs.referencesDereferenced, false);
  assert.equal(obs.value.state, 'idle');
  assert.equal(obs.value.turn, 3);
  assert.equal(obs.value.quarantined, false);
  assert.equal(obs.truncated, false);
  assert.equal('ignored' in obs.value, false);
});

test('list enumerates exactly the packets of one chat', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-a' });
  f.ingest('report-other', 1);
  await f.notifications.reconcile();
  const nOther = f.notifications.list(OTHER).at(-1);
  rp.capture({ threadId: OTHER, notificationId: nOther.id, batchId: 'batch-b' });

  const listA = rp.list({ threadId: THREAD });
  assert.equal(listA.count, 1);
  assert.equal(listA.packets[0].batchId, 'batch-a');
  assert.equal(listA.packets[0].count, 1);
  const listB = rp.list({ threadId: OTHER });
  assert.equal(listB.count, 1);
  assert.equal(listB.packets[0].batchId, 'batch-b');
});

test('a stale envelope captured under a new batch never sweeps unrelated newer work', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a', 'report-b']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-original' });
  // The chat's original work is fully handled and its envelope retired.
  f.ack('report-a');
  f.ack('report-b');
  await f.notifications.reconcile();
  // A brand-new, unrelated report arrives and is not part of the old envelope.
  f.ingest('report-new');
  assert.equal(f.store.message('report-new').receivedAt, null, 'the unrelated report is not yet received');

  const stale = rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-stale-new' });
  assert.equal(stale.capturedActionable, false);
  assert.equal(stale.actionable, false);
  assert.deepEqual(stale.reportIds, ['report-a', 'report-b'], 'a stale envelope keeps only its known membership');
  assert.equal(stale.reportIds.includes('report-new'), false, 'unrelated newer work is never swept in');

  const read = rp.read({ threadId: THREAD, batchId: 'batch-stale-new' });
  assert.deepEqual(read.reportIds, ['report-a', 'report-b']);
  assert.equal(read.counts.pending, 0);
  assert.equal(read.currentPending, 0);
  assert.equal(f.store.message('report-new').receivedAt, null, 'no receive happened for unrelated work');
});

test('ref clipping and dropping are reported, never silent', async t => {
  const f = await fixture(t);
  const worker = f.store.worker('worker-0');
  const artifacts = Array.from({ length: 40 }, (_, i) => ({
    path: `out/artifact-${String(i).padStart(2, '0')}-${'z'.repeat(40)}.bin`, sha256: 'd'.repeat(64),
  }));
  const evidence = f.validEvidence(worker, { baseline_revision: null, final_revision: null, artifacts });
  assert.equal(validateWorkerEvidence(evidence).artifacts.length, 40);
  f.ingest('report-a', 0, { evidence });
  const n = await f.openNotification([]);
  const rp = f.service({ maxRefs: 5, maxRefLength: 24 });
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-refs' });

  const refs = rp.page({ threadId: THREAD, batchId: 'batch-refs' }).items[0].refs.evidence;
  assert.equal(refs.truncated, true);
  assert.equal(refs.items.length, 5);
  assert.equal(refs.total, 41, '40 artifacts plus the test output path');
  assert.equal(refs.dropped, 36, 'the excess refs are explicitly reported as dropped');
  assert.equal(refs.clipped, 5, 'over-long refs are explicitly reported as clipped');
  assert.ok(refs.items.every(v => Buffer.byteLength(v, 'utf8') <= 24));
});

test('oversized observation values are bounded and flagged', async t => {
  const f = await fixture(t);
  f.store.meta('observation:worker-0', { state: 'x'.repeat(500), turn: 3, quarantined: false });
  const n = await f.openNotification(['report-a']);
  const rp = f.service({ maxRefLength: 32 });
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-obs-big' });
  const [obs] = rp.page({ threadId: THREAD, batchId: 'batch-obs-big' }).items[0].observations;
  assert.equal(obs.truncated, true);
  assert.ok(Buffer.byteLength(obs.value.state, 'utf8') <= 32);
  assert.equal(obs.value.turn, 3);
});

test('packet record integrity is enforced on read', async t => {
  const f = await fixture(t);
  const n = await f.openNotification(['report-a']);
  const rp = f.service();
  rp.capture({ threadId: THREAD, notificationId: n.id, batchId: 'batch-tamper' });
  const key = 'review-packet:batch-tamper';
  const record = f.store.meta(key);
  f.store.meta(key, { ...record, reportIds: [...record.reportIds, 'injected'] });
  assert.throws(() => rp.read({ threadId: THREAD, batchId: 'batch-tamper' }), /integrity/);
});
