import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { waitForAgentActivity, DEFAULT_ACTIVITY_TYPES } from '../src/activity-wait.mjs';
import { startActivityBus, subscribeJournalActivity, publishJournalActivity, createJournalPublisher, activitySocketPath } from '../src/activity-ipc.mjs';

const THREAD = '00000000-0000-4000-8000-000000000001';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { bus: enabled = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-ipc-test-'));
  const dbPath = join(directory, 'manager.sqlite');
  const store = new Store(dbPath), writer = new Store(dbPath);
  const task = { id: 'task-a', name: 'IPC test', project: directory, threadId: THREAD, status: 'active' };
  const worker = { id: 'agent-a', taskId: task.id, project: task.project, name: 'worker-a', terminalId: 't1', mailbox: 'mail-a' };
  const other = { ...worker, id: 'agent-b', name: 'worker-b', terminalId: 't2', mailbox: 'mail-b' };
  store.saveTask(task); store.saveWorker(worker); store.saveWorker(other);
  const bus = enabled ? await startActivityBus({ dbPath }) : null;
  let closed = false;
  const closeBus = async () => { if (!closed) { closed = true; await bus?.close(); } };
  const publisher = createJournalPublisher(dbPath);
  const originalJournal = writer.journal.bind(writer);
  writer.journal = (...args) => { originalJournal(...args); publisher(); };
  t.after(async () => { await publisher.flush().catch(() => {}); await closeBus(); writer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const message = (id, kind = 'result', author = worker) => writer.ingest(author, {
    id, taskId: task.id, workerId: author.id, terminalId: author.terminalId,
    kind, text: `Actual ${id} text`, createdAt: new Date().toISOString(), turn: 1,
  }, { lifecycle: true });
  return { directory, dbPath, store, writer, task, worker, other, bus, closeBus, publisher, message,
    options: { store, workers: [worker], dbPath } };
}

function signalledSubscribe() {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  return { ready, subscribe: async options => {
    const handle = await subscribeJournalActivity(options);
    resolveReady(); return handle;
  } };
}

test('stop lifecycle events are part of the default wake set', () => {
  assert.ok(DEFAULT_ACTIVITY_TYPES.includes('agent.interrupted'));
  // The manager's own administrative stop request must not wake its own wait;
  // only the resulting confirmation is a wake-worthy lifecycle event.
  assert.ok(!DEFAULT_ACTIVITY_TYPES.includes('agent.stop.requested'));
  assert.ok(DEFAULT_ACTIVITY_TYPES.includes('agent.stopped'));
  assert.ok(DEFAULT_ACTIVITY_TYPES.includes('agent.request.uncertain'));
});

test('private socket is user-owned and removed on bridge close', async t => {
  const f = await fixture(t), path = activitySocketPath(f.dbPath);
  assert.equal(lstatSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(path).uid, process.getuid());
  await assert.rejects(startActivityBus({ dbPath: f.dbPath }), /already owns/);
  await f.closeBus(); assert.equal(existsSync(path), false);
});

test('bridge-off errors are explicit; no filesystem or polling fallback', async t => {
  const f = await fixture(t, { bus: false });
  await assert.rejects(waitForAgentActivity({ ...f.options, timeoutMs: 0 }), /Start the updated bridge.*no polling fallback/);
  await assert.rejects(publishJournalActivity(f.dbPath), /notifications unavailable/);
});

test('fresh cursor returns pending attention only and does not replay processed history', async t => {
  const f = await fixture(t);
  f.message('handled'); f.writer.recordAction('handled', { kind: 'accept', requestId: 'a', text: 'done' }); f.writer.ack('handled');
  f.message('other', 'result', f.other); f.message('progress', 'progress'); f.message('pending', 'question');
  f.writer.journal('agent.request.sent', { workerId: f.worker.id, requestId: 'historical' });
  await f.publisher.flush();
  const result = await waitForAgentActivity({ ...f.options, timeoutMs: 0 });
  assert.equal(result.reason, 'activity'); assert.equal(result.cursor, 7);
  assert.deepEqual(result.activities.map(a => a.messageId), ['pending']);
});

test('own administrative sends are excluded from the default wake set but remain explicitly selectable', async t => {
  const f = await fixture(t);
  f.writer.journal('baseline', {});
  f.writer.journal('agent.request.sent', { workerId: f.worker.id, requestId: 'own-sent' });
  f.writer.journal('agent.request.prepared', { workerId: f.worker.id, requestId: 'own-prepared' });
  f.writer.journal('agent.stop.requested', { workerId: f.worker.id, requestId: 'own-stop' });
  await f.publisher.flush();
  // The manager's own sends are not wake-worthy; neither is its own stop request.
  const none = await waitForAgentActivity({ ...f.options, after: 1, timeoutMs: 0 });
  assert.equal(none.reason, 'timeout'); assert.deepEqual(none.activities, []); assert.equal(none.cursor, 4);
  // The records are durable, so an explicit type selection still replays them.
  const selected = await waitForAgentActivity({ ...f.options, after: 1, types: ['agent.request.sent'], timeoutMs: 0 });
  assert.deepEqual(selected.activities.map(a => a.requestId), ['own-sent']);
});

test('immediate commit after acknowledged subscription cannot enter a startup gap', async t => {
  const f = await fixture(t), hook = signalledSubscribe();
  const started = performance.now();
  const waiting = waitForAgentActivity({ ...f.options, subscribe: hook.subscribe, timeoutMs: 2_000 });
  await hook.ready;
  f.message('immediate'); await f.publisher.flush();
  const result = await waiting;
  assert.equal(result.activities[0].messageId, 'immediate');
  assert.ok(performance.now() - started < 1_000);
});

test('a later committed message wakes an idle subscription through acknowledged IPC', async t => {
  const f = await fixture(t), hook = signalledSubscribe();
  let notifications = 0;
  const waiting = waitForAgentActivity({ ...f.options, timeoutMs: 2_000, subscribe: options => hook.subscribe({ ...options,
    onActivity: () => { notifications++; options.onActivity(); } }) });
  await hook.ready; await nextTurn();
  f.writer.transaction(() => { f.message('committed'); });
  await f.publisher.flush();
  const result = await waiting;
  assert.equal(result.activities[0].messageId, 'committed'); assert.ok(notifications > 0);
});

test('rollback, heartbeat, metadata, other-worker and progress hints do not return attention', async t => {
  const f = await fixture(t), hook = signalledSubscribe();
  const waiting = waitForAgentActivity({ ...f.options, subscribe: hook.subscribe, timeoutMs: 60 });
  await hook.ready; await nextTurn();
  assert.throws(() => f.writer.transaction(() => { f.message('rolled-back'); throw new Error('rollback'); }), /rollback/);
  f.writer.meta('bridge', { status: 'listening' });
  f.writer.journal('bridge.heartbeat', { workerId: f.worker.id });
  f.writer.journal('message.action', { workerId: f.worker.id });
  f.message('other', 'result', f.other); f.message('progress', 'progress');
  await f.publisher.flush();
  const result = await waiting;
  assert.equal(result.reason, 'timeout'); assert.deepEqual(result.activities, []); assert.equal(result.cursor, 4);
  assert.equal(f.store.message('rolled-back'), null);
});

test('cursor replay is bounded and does not duplicate or drop records', async t => {
  const f = await fixture(t);
  f.writer.journal('baseline', {});
  for (let i = 0; i < 105; i++) f.writer.journal('agent.request.uncertain', { workerId: f.worker.id, requestId: String(i) });
  await f.publisher.flush();
  const first = await waitForAgentActivity({ ...f.options, after: 1, timeoutMs: 0 });
  const second = await waitForAgentActivity({ ...f.options, after: first.cursor, timeoutMs: 0 });
  const third = await waitForAgentActivity({ ...f.options, after: second.cursor, timeoutMs: 0 });
  assert.equal(first.activities.length, 100); assert.equal(first.more, true);
  assert.equal(second.activities.length, 5); assert.equal(second.more, false);
  assert.deepEqual([...first.activities, ...second.activities].map(a => a.requestId), Array.from({ length: 105 }, (_, i) => String(i)));
  assert.equal(third.reason, 'timeout'); assert.equal(third.cursor, 106);
});

test('eight concurrent subscribers each observe the same committed activity once', async t => {
  const f = await fixture(t), hooks = Array.from({ length: 8 }, signalledSubscribe);
  const waits = hooks.map(hook => waitForAgentActivity({ ...f.options, subscribe: hook.subscribe, timeoutMs: 2_000 }));
  await Promise.all(hooks.map(hook => hook.ready)); await nextTurn();
  f.message('multicast'); await f.publisher.flush();
  const results = await Promise.all(waits);
  for (const result of results) assert.deepEqual(result.activities.map(a => a.messageId), ['multicast']);
  assert.equal(new Set(results.map(result => result.cursor)).size, 1);
});

test('a separate writer process notifies through the actual socket and receives acknowledgement', async t => {
  const f = await fixture(t), hook = signalledSubscribe();
  const waiting = waitForAgentActivity({ ...f.options, subscribe: hook.subscribe, timeoutMs: 4_000 });
  await hook.ready; await nextTurn();
  const storeURL = new URL('../src/store.mjs', import.meta.url).href;
  const ipcURL = new URL('../src/activity-ipc.mjs', import.meta.url).href;
  const code = `import {Store} from ${JSON.stringify(storeURL)}; import {publishJournalActivity} from ${JSON.stringify(ipcURL)};
    const store=new Store(process.argv[1]);
    store.journal('agent.interrupted',{workerId:'agent-a',taskId:'task-a',requestId:'cross-process'});
    await publishJournalActivity(process.argv[1]); store.close(); process.stdout.write('acknowledged');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit');
  const result = await waiting;
  const [status] = await exit;
  assert.equal(status, 0, stderr); assert.equal(stdout, 'acknowledged');
  assert.equal(result.activities[0].requestId, 'cross-process');
});

test('bridge crash/disconnect rejects a waiting caller and leaves worker state intact', async t => {
  const f = await fixture(t), hook = signalledSubscribe(), before = f.store.workers();
  const waiting = waitForAgentActivity({ ...f.options, subscribe: hook.subscribe });
  const rejection = assert.rejects(waiting, /closed|disconnected/);
  await hook.ready; await nextTurn(); await f.closeBus(); await rejection;
  assert.deepEqual(f.store.workers(), before);
});

test('abort closes only the subscription, and the bridge accepts a later wait', async t => {
  const f = await fixture(t), hook = signalledSubscribe(), controller = new AbortController();
  const waiting = waitForAgentActivity({ ...f.options, subscribe: hook.subscribe, signal: controller.signal });
  await hook.ready; controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  const next = await waitForAgentActivity({ ...f.options, timeoutMs: 0 });
  assert.equal(next.reason, 'timeout'); assert.equal(f.store.workers().length, 2);
});

test('publisher failures are preserved for CLI flush rather than silently lost', async t => {
  const f = await fixture(t, { bus: false });
  f.writer.journal('agent.interrupted', { workerId: f.worker.id });
  await assert.rejects(f.publisher.flush(), /Start the updated bridge/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, 1);
});
