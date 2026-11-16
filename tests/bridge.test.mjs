import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { Store } from '../src/store.mjs';
import { Requests } from '../src/requests.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const task = { id: 'task-1', name: 'Repair browser persistence', project: '/private/project', threadId: THREAD, status: 'active' };
const worker = { id: 'worker-1', taskId: task.id, name: 'pi-work', role: 'pi', project: task.project, terminalId: 't7', mailbox: 'cx-worker-1', startTurn: 0 };
const message = (id = 'question-1', extra = {}) => ({
  id, taskId: task.id, workerId: worker.id, terminalId: worker.terminalId, kind: 'question',
  text: 'Which behavior should be preserved?', createdAt: '2026-11-13T00:00:00.000Z', turn: 1, ...extra,
});
const doc = messages => ({ version: 1, messages });
// A realistic native terminal for a worker. The shared identity validator reads
// cwd, the codex.task/codex.worker labels, pid and argv, so sparse fixtures would
// otherwise look like a replacement process. A test that models a changed
// process overrides the specific field (for example pid or codex.task) instead.
function terminalFor(w, extra = {}) {
  return {
    address: w.terminalId, state: 'live', status: { state: 'done' }, turn: 1,
    cwd: w.project,
    labels: {
      'codex.worker': w.id, 'codex.task': w.taskId,
      ...(w.deskId ? { 'codex.desk': w.deskId, 'codex.desk-project': w.deskProjectId } : {}),
    },
    ...(w.launchResult?.pid != null ? { pid: w.launchResult.pid } : {}),
    ...(w.launchArgv?.length ? { argv: w.launchArgv } : {}),
    ...(w.launchIdentity?.created_ms != null ? { created_ms: w.launchIdentity.created_ms } : {}),
    ...extra,
  };
}

function nativeFixture() {
  const documents = new Map(), terminals = new Map([[worker.terminalId, terminalFor(worker)]]);
  const calls = [], clients = [];
  let beforeSet;
  const put = (name, value) => documents.set(name, { version: (documents.get(name)?.version ?? 0) + 1, value: structuredClone(value) });
  return {
    documents, terminals, calls, clients, put,
    beforeSet(fn) { beforeSet = fn; },
    factory(options) {
      const client = {
        options, closed: false,
        async subscribe(handler) { this.handler = handler; return { seq: 1, terminals: [...terminals.values()] }; },
        close() { this.closed = true; },
        async request(method, params) {
          calls.push({ method, params: structuredClone(params) });
          if (method === 'doc.get') return structuredClone(documents.get(params.name) ?? { version: 0, value: null });
          if (method === 'doc.set') {
            if (beforeSet) { const fn = beforeSet; beforeSet = undefined; await fn(params); }
            if (params.version !== (documents.get(params.name)?.version ?? 0)) {
              throw Object.assign(Error('conflict'), { data: { kind: 'conflict' } });
            }
            put(params.name, params.value); return { version: documents.get(params.name).version };
          }
          if (method === 'terminal.get') {
            if (!terminals.has(params.terminal)) throw Object.assign(Error('not found'), { data: { kind: 'not_found' } });
            return structuredClone(terminals.get(params.terminal));
          }
          throw Error(`Unexpected fake native method ${method}`);
        },
      };
      clients.push(client); return client;
    },
  };
}

async function fixture(t, onAdd) {
  const stateDir = await mkdtemp(join(tmpdir(), 'herdr-bridge-'));
  const native = nativeFixture(), deliveries = [];
  const config = { version: 1, stateDir, path: join(stateDir, 'config.json'), packageRoot: '/integration', hc: '/fake/hc', codex: '/fake/codex', registryDoc: 'cx-reg-test' };
  // The lifecycle tests model a host that starts processing each accepted row
  // immediately. Queue persistence/coalescing is exercised by Notifications tests.
  const queue = {
    async list(threadId) { return []; },
    async add(threadId,{clientId,text}) {
      const row={id:'receipt-'+(deliveries.length+1),clientUserMessageId:clientId,input:[{type:'text',text}]};
      deliveries.push({threadId,message:text,clientId,row});
      if(onAdd)await onAdd({threadId,clientId,text,row});
      return structuredClone(row);
    },
    async update(){throw new Error('Immediately consumed host rows cannot be updated');},
    async delete(){throw new Error('Immediately consumed host rows cannot be deleted');},
    close(){this.closed=true;},
  };
  const bridge = new Bridge(config, {
    clientFactory: options => native.factory(options),
    queue,
  });
  bridge.store.saveTask(task); bridge.store.saveWorker(worker);
  t.after(async () => { await bridge.stop(); await bridge.chain; bridge.store.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { bridge, native, deliveries, config, queue, async start() { await bridge.start(); await bridge.chain; } };
}

test('native mailbox is durably archived before CAS pruning, preserving concurrent appends', async t => {
  const f = await fixture(t);
  f.native.put(worker.mailbox, doc([message()]));
  f.native.beforeSet(() => {
    const independentReader = new Store(join(f.config.stateDir, 'manager.sqlite'));
    try { assert.equal(independentReader.message('question-1').text, message().text); }
    finally { independentReader.close(); }
    f.native.put(worker.mailbox, doc([message(), message('concurrent')]));
  });
  await f.start();
  assert.deepEqual(f.native.documents.get(worker.mailbox).value.messages.map(m => m.id), ['concurrent']);
  assert.equal(f.bridge.store.message('question-1').delivery, 'queued');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].threadId, THREAD);
  assert.match(f.deliveries[0].message, /^Herdr inbox notification: hn-/);
  assert.match(f.deliveries[0].message, /- question question-1 /);
  await f.bridge.onNotification({ method: 'event', params: { type: 'doc', data: { name: worker.mailbox } } });
  assert.equal(f.bridge.store.message('concurrent').delivery, 'queued');
  assert.equal(f.deliveries.length, 2);
  assert.deepEqual(f.native.documents.get(worker.mailbox).value.messages, []);
});

test('mailbox replay and duplicate notifications do not queue a second copy', async t => {
  const f = await fixture(t);
  f.native.put(worker.mailbox, doc([message()])); await f.start();
  f.native.put(worker.mailbox, doc([message()]));
  for (let i = 0; i < 2; i++) await f.bridge.onNotification({ method: 'event', params: { type: 'doc', data: { name: worker.mailbox } } });
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.bridge.store.messages().length, 1);
});

test('foreign routing remains in Herdr and cannot be sent to any Codex chat', async t => {
  const f = await fixture(t);
  f.native.put(worker.mailbox, doc([message('foreign', { taskId: 'someone-elses-task' }), message()]));
  await f.start();
  assert.equal(f.bridge.store.message('foreign'), null);
  assert.deepEqual(f.native.documents.get(worker.mailbox).value.messages.map(m => m.id), ['foreign']);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].threadId, THREAD);
});

test('missed native events resynchronize mailboxes and queued messages without idle polling', async t => {
  const f = await fixture(t); await f.start();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.bridge.timers.size, 0);
  const before = f.native.calls.length;
  await f.bridge.onNotification({ method: 'heartbeat', params: { seq: 9 } });
  assert.equal(f.native.calls.length, before);
  assert.equal(f.bridge.timers.size, 0);
  f.native.put(worker.mailbox, doc([message()]));
  await f.bridge.onNotification({ method: 'missed', params: { terminals: [...f.native.terminals.values()] } });
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.bridge.timers.size, 0);
});

test('new bridge delivers durable unsent inbox without replaying already queued legacy records', async t => {
  const f = await fixture(t);
  f.bridge.store.ingest(worker, message('pending'));
  f.bridge.store.ingest(worker, message('already-queued'));
  f.bridge.store.startDispatch('already-queued');
  f.bridge.store.finishDispatch('already-queued', { status: 'queued', receipt: 'older-receipt' });
  await f.start();
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].message, /- question pending /);
  assert.equal(f.bridge.store.message('pending').attempts, 1);
  assert.equal(f.bridge.store.message('already-queued').receipt, 'older-receipt');
});

test('ambiguous host add survives bridge startup without blindly repeating the wake', async t => {
  const f=await fixture(t);
  f.bridge.store.ingest(worker,message('ambiguous'));
  const envelope=f.bridge.notifications.create(THREAD,[f.bridge.store.message('ambiguous')]);
  f.bridge.notifications.save({...envelope,state:'sending',attempted:true,attempts:1});
  await f.start();
  assert.equal(f.deliveries.length,0);
  assert.equal(f.bridge.notifications.get(envelope.id).state,'delivery_unknown');
  assert.equal(f.bridge.store.message('ambiguous').acknowledgedAt,null);
  await f.bridge.pump();
  assert.equal(f.deliveries.length,0);
  assert.equal(f.bridge.notifications.get(envelope.id).attempts,1);
});

test('malformed worker mailbox is isolated rather than starving other workers or reconnecting', async t => {
  const f = await fixture(t);
  const colleague = { ...worker, id: 'worker-2', name: 'goose-review', role: 'goose', mailbox: 'cx-worker-2', terminalId: 't8' };
  f.bridge.store.saveWorker(colleague);
  f.native.terminals.set('t8', terminalFor(colleague));
  f.native.put(worker.mailbox, { version: 99, messages: [] });
  f.native.put(colleague.mailbox, doc([message('good-worker', { workerId: colleague.id, terminalId: colleague.terminalId })]));
  await f.start();
  assert.equal(f.bridge.connected, true);
  assert.equal(f.bridge.store.message('good-worker')?.delivery, 'queued');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.bridge.timers.size, 0);
  assert.equal(f.native.documents.get(worker.mailbox).value.version, 99);
});

test('stopping during failed dispatch does not create a retry timer afterward', async t => {
  let fail,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const outstanding = new Promise((_resolve,reject) => { fail = reject; });
  const f = await fixture(t, async () => {started();await outstanding;});
  f.bridge.store.ingest(worker, message());
  const pumping = f.bridge.pump();
  await entered;
  assert.equal(f.bridge.activeDispatch.size, 1);
  const stopping = f.bridge.stop();
  fail(Object.assign(new Error('temporary host failure'),{uncertain:false}));
  await Promise.all([pumping, stopping]);
  assert.equal(f.bridge.stopped, true);
  assert.equal(f.bridge.timers.size, 0);
});

test('shutdown does not begin another chat notification after the in-flight add finishes', async t => {
  let finish, started, calls = 0;
  const entered=new Promise(resolve=>{started=resolve;});
  const outstanding = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async () => { calls++;started();return outstanding; });
  f.bridge.store.ingest(worker, message('first'));
  const secondTask={...task,id:'task-other-chat',threadId:'00000000-0000-4000-8000-000000000002'};
  const secondWorker={...worker,id:'worker-other-chat',taskId:secondTask.id,mailbox:'cx-other-chat',terminalId:'t8'};
  f.bridge.store.saveTask(secondTask);f.bridge.store.saveWorker(secondWorker);
  f.bridge.store.ingest(secondWorker, message('second',{taskId:secondTask.id,workerId:secondWorker.id,terminalId:secondWorker.terminalId}));
  const pumping = f.bridge.pump();
  await entered;
  const stopping = f.bridge.stop();
  finish();
  await Promise.all([pumping, stopping]);
  assert.equal(calls, 1);
  assert.equal(f.bridge.store.message('second').delivery, 'pending');
  assert.equal(f.bridge.store.message('second').attempts, 0);
});

test('reconnect resubscribes and drains messages written while disconnected', async t => {
  const f = await fixture(t); await f.start();
  const oldClients = [...f.native.clients];
  const makeClient = f.bridge.clientFactory;
  let signalSubscribed;
  const subscribed = new Promise(resolve => { signalSubscribed = resolve; });
  f.bridge.clientFactory = options => {
    const client = makeClient(options), subscribe = client.subscribe;
    client.subscribe = async handler => {
      const snapshot = await subscribe.call(client, handler);
      setImmediate(signalSubscribed);
      return snapshot;
    };
    return client;
  };
  oldClients[1].options.onClose(Object.assign(Error('native connection lost'), { code: 'HERDR_DISCONNECTED' }));
  assert.equal(f.bridge.connected, false);
  assert.equal(oldClients.every(client => client.closed), true);
  f.native.put(worker.mailbox, doc([message('offline-question')]));
  await subscribed; await f.bridge.chain;
  assert.equal(f.native.clients.length, 4);
  assert.equal(f.bridge.connected, true);
  assert.equal(f.bridge.store.message('offline-question').delivery, 'queued');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.bridge.timers.size, 0);
});

test('registration pulse discovers a worker that exited before its terminal binding was saved', async t => {
  const f = await fixture(t); await f.start();
  // Native finished can arrive during terminal.run, before the CLI has saved
  // the returned address. No registered worker exists for that first event.
  f.native.terminals.set('t8', terminalFor({ ...worker, id: 'failed-launch', terminalId: 't8' }, { state: 'finished', status: null, turn: 0, exit_code: 127 }));
  await f.bridge.onNotification({ method: 'event', params: { type: 'finished', terminal: 't8' } });
  assert.equal(f.deliveries.length, 0);
  f.bridge.store.saveWorker({ ...worker, id: 'failed-launch', name: 'failed-worker', mailbox: 'cx-failed', terminalId: 't8' });
  await f.bridge.onNotification({ method: 'event', params: { type: 'doc', data: { name: f.config.registryDoc } } });
  const notice = f.bridge.store.messages().find(m => m.workerId === 'failed-launch');
  assert.ok(notice, 'post-registration reconciliation must observe the already-finished terminal');
  assert.equal(notice.kind, 'attention');
  assert.equal(notice.delivery, 'queued');
  assert.equal(f.deliveries.length, 1);
});

test('optional done fallback does not duplicate an explicit result emitted before turn increments', async t => {
  const f = await fixture(t);
  f.bridge.store.saveWorker({ ...worker, notifyOnDone: true });
  f.native.terminals.set(worker.terminalId, terminalFor(worker, { turn: 2 }));
  f.native.put(worker.mailbox, doc([message('explicit-result', { kind: 'result', turn: 1 })]));
  await f.start();
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual(f.bridge.store.messages().map(m => m.kind), ['result']);
});

test('default fallback ignores initial done then reports a later silent turn despite an older result', async t => {
  const f = await fixture(t);
  f.bridge.store.saveWorker({ ...worker, notifyOnDone: true });
  f.bridge.store.ingest(worker, message('old-result', { kind: 'result', turn: 0 }));
  f.bridge.store.startDispatch('old-result');
  f.bridge.store.finishDispatch('old-result', { status: 'queued', receipt: 'old-receipt' });
  f.native.terminals.set(worker.terminalId, terminalFor(worker, { turn: 3 }));
  await f.start();
  assert.equal(f.deliveries.length, 0, 'historical idle is not an activation');
  f.native.terminals.get(worker.terminalId).turn = 4;
  await f.bridge.checkWorker(worker, { type: 'turn', data: { state: 'done' } });
  await f.bridge.settledNotice(task.id);
  assert.equal(f.deliveries.length, 1);
  const notice = f.bridge.store.messages().find(m => m.kind === 'attention');
  assert.equal(notice?.turn, 4);
  assert.equal(notice?.delivery, 'queued');
});

test('missing registered terminal raises one notice, retains its writer lease, and does not starve a colleague', async t => {
  const f = await fixture(t);
  const lostWriter = { ...worker, id: 'missing-writer', name: 'missing-pi', mailbox: 'cx-missing', terminalId: 't9', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(lostWriter);
  // t9 is deliberately absent from the snapshot and terminal.get returns
  // not_found; absence is not evidence that its old processes have stopped.
  f.native.put(worker.mailbox, doc([message('healthy-colleague')]));
  await f.start();
  const notice = f.bridge.store.messages().find(m => m.workerId === lostWriter.id);
  assert.equal(notice?.kind, 'attention');
  assert.equal(notice?.delivery, 'queued');
  assert.match(notice?.text, /reservation is retained/);
  assert.equal(f.bridge.store.message('healthy-colleague').delivery, 'queued');
  assert.equal(f.bridge.connected, true);
  assert.equal(f.deliveries.length, 1, 'simultaneous same-chat attention shares one host envelope');
  const envelope=f.bridge.notifications.list(THREAD)[0];
  assert.deepEqual([...envelope.members].sort(),['healthy-colleague',notice.id].sort());
  assert.ok(f.deliveries[0].message.includes('- attention '+notice.id+' — '));
  assert.match(f.deliveries[0].message,/- question healthy-colleague /);
  assert.throws(() => f.bridge.store.reserveWorker({ ...lostWriter, id: 'replacement', mailbox: 'cx-replacement', terminalId: null }), /already owned/);
  await f.bridge.onNotification({ method: 'missed', params: { terminals: [...f.native.terminals.values()] } });
  await f.bridge.onNotification({ method: 'event', params: { type: 'doc', data: { name: f.config.registryDoc } } });
  assert.equal(f.deliveries.length, 1, 'reconciliation must not resend either covered message');
  assert.equal(f.bridge.store.messages().filter(m => m.workerId === lostWriter.id).length, 1);
  assert.equal(f.bridge.timers.size, 0);
});

test('a quarantined peer preserves its fault and lease without blocking healthy team completion', async t => {
  const f = await fixture(t);
  const lost = { ...worker, id: 'lost-goose', name: 'goose-lost', role: 'goose', mailbox: 'cx-lost', terminalId: 't8', writePaths: ['/private/review-scratch'] };
  const healthy = { ...worker, id: 'healthy-goose', name: 'goose-healthy', role: 'goose', mailbox: 'cx-healthy', terminalId: 't9' };
  f.bridge.store.reserveWorker(lost);
  f.bridge.store.saveWorker(healthy);
  // The missing original process gets its own fault. Another healthy worker is
  // still working, so it must continue to gate a routine team completion.
  f.native.terminals.set('t9', terminalFor(healthy, { status: { state: 'working' }, turn: 0 }));
  await f.start();
  const fault = f.bridge.store.messages().find(m => m.workerId === lost.id);
  assert.equal(fault?.attention.reason, 'missing');
  assert.equal(f.bridge.observation(lost).quarantined, true);
  f.bridge.store.receive(fault.id);
  f.bridge.store.recordAction(fault.id, { kind: 'abort', text: 'Continue with the healthy workers; preserve the lost process reservation for reconciliation.', requestId: 'handle-lost-peer' });
  f.bridge.store.ack(fault.id);
  f.native.terminals.get(worker.terminalId).status = { state: 'working' };
  await f.bridge.checkWorker(worker);
  f.native.terminals.get(worker.terminalId).status = { state: 'done' };
  f.native.terminals.get(worker.terminalId).turn = 2;
  await f.bridge.checkWorker(worker);
  f.bridge.scheduleSettle(task.id);
  assert.equal(f.bridge.settleTimers.has(task.id), false, 'a genuinely working healthy peer still gates settlement');
  f.native.terminals.get('t9').status = { state: 'done' };
  f.native.terminals.get('t9').turn = 1;
  await f.bridge.checkWorker(healthy);
  f.bridge.scheduleSettle(task.id);
  assert.equal(f.bridge.settleTimers.has(task.id), true, 'the quarantined peer cannot permanently veto healthy completion');
  f.bridge.cancelSettle(task.id);
  await f.bridge.settledNotice(task.id);
  const completion = f.bridge.store.messages().find(m => m.attention?.reason === 'turn_ended');
  assert.equal(completion?.delivery, 'queued');
  assert.deepEqual(completion.attention.workers.map(w => w.workerId).sort(), [worker.id, healthy.id].sort());
  assert.equal(f.deliveries.length, 2, 'one fault wake and one later healthy-team wake');
  assert.ok(f.bridge.store.message(fault.id).acknowledgedAt);
  assert.equal(f.bridge.observation(lost).quarantined, true);
  assert.throws(() => f.bridge.store.reserveWorker({ ...lost, id: 'unsafe-replacement', mailbox: 'cx-replacement', terminalId: null }), /already owned/);
});

test('a delayed explicit report cannot consume a newer peer completion or supersede its notice', async t => {
  const f = await fixture(t);
  const peer = { ...worker, id: 'worker-2', name: 'goose-review', role: 'goose', terminalId: 't8', mailbox: 'cx-worker-2' };
  f.bridge.store.saveWorker(peer);
  const pending = { episode: 2, startTurn: 2, turn: 3, endedAt: '2026-11-13T00:00:03.000Z' };
  const observation = { episode: 2, turn: 3, state: 'done', working: false, pending };
  f.bridge.saveObservation(peer, observation);
  f.bridge.store.ingest(peer, message('newer-peer-notice', {
    workerId: peer.id, terminalId: peer.terminalId, kind: 'attention', turn: 3,
    attention: { reason: 'turn_ended', workers: [{ workerId: peer.id, terminalId: peer.terminalId, ...pending }] },
  }), { lifecycle: true });
  const oldReport = message('delayed-report', { kind: 'result', createdAt: '2026-11-13T00:00:01.000Z' });
  f.bridge.store.ingest(worker, oldReport);
  f.bridge.explicitReport(oldReport);
  assert.deepEqual(f.bridge.observation(peer).pending, pending);
  assert.equal(f.bridge.store.message('newer-peer-notice').delivery, 'pending');
  assert.equal(f.bridge.store.message('newer-peer-notice').acknowledgedAt, null);
});

test('a current explicit report durably exposes the peer completion it covers', async t => {
  const f = await fixture(t);
  const peer = { ...worker, id: 'worker-2', name: 'goose-review', role: 'goose', terminalId: 't8', mailbox: 'cx-worker-2' };
  f.bridge.store.saveWorker(peer);
  const pending = { episode: 2, startTurn: 2, turn: 3, endedAt: '2026-11-13T00:00:03.000Z' };
  f.bridge.saveObservation(peer, { episode: 2, turn: 3, state: 'done', working: false, pending });
  f.bridge.store.ingest(peer, message('covered-peer-notice', {
    workerId: peer.id, terminalId: peer.terminalId, kind: 'attention', turn: 3,
    attention: { reason: 'turn_ended', workers: [{ workerId: peer.id, terminalId: peer.terminalId, ...pending }] },
  }), { lifecycle: true });
  const report = message('current-report', { kind: 'result', createdAt: '2026-11-13T00:00:04.000Z' });
  f.bridge.store.ingest(worker, report);
  f.bridge.explicitReport(report);
  assert.equal(f.bridge.observation(peer).pending, null);
  const independentReader = new Store(join(f.config.stateDir, 'manager.sqlite'));
  try {
    const handoff = independentReader.meta(`handoff:${report.id}`);
    assert.ok(handoff, 'coalesced peer completion must survive bridge restart');
    assert.deepEqual(independentReader.message(report.id).handoff, handoff);
    assert.equal(independentReader.message('covered-peer-notice').delivery, 'superseded');
    assert.equal(independentReader.message('covered-peer-notice').action.requestId, `covered-by:${report.id}`);
    const context = JSON.stringify(handoff);
    assert.match(context, /"workerId":"worker-2"/);
    assert.match(context, /"terminalId":"t8"/);
    assert.match(context, /"episode":2/);
    const storedReport=independentReader.message(report.id);
    const envelope=f.bridge.notifications.create(THREAD,[storedReport]);
    const text = f.bridge.notifications.render(envelope,[storedReport]);
    assert.match(text, /t8/, 'the delivered wake must identify the covered peer');
  } finally { independentReader.close(); }
});


test('native heartbeats cannot hide a notification transport failure before recovery', async t => {
  const f=await fixture(t);await f.start();
  f.bridge.store.ingest(worker,message('host-outage'));
  const list=f.bridge.queue.list;f.bridge.queue.list=async()=>{throw new Error('Queue unavailable fixture');};
  await f.bridge.pump();
  await f.bridge.onNotification({method:'heartbeat',params:{seq:99}});
  assert.match(f.bridge.store.meta('bridge').notificationError,/Queue unavailable fixture/);
  f.bridge.queue.list=list;await f.bridge.pump();
  assert.equal(f.bridge.store.meta('bridge').notificationError,null);
});

test('a recorded stop intent turns a native exit into a deliberate stop, not a runtime fault', async t => {
  const f = await fixture(t);
  const stopped = { ...worker, id: 'stopped-pi', name: 'pi-stopped', mailbox: 'cx-stopped', terminalId: 't9', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(stopped);
  f.native.terminals.set('t9', terminalFor(stopped, { state: 'finished', status: { state: 'done' }, turn: 1, exit_code: 0 }));
  f.bridge.store.meta('stop:stopped-pi', { requestId: 'stop-1', state: 'confirmed' });
  await f.start();
  assert.equal(f.bridge.observation(stopped).stopped, true);
  assert.equal(f.bridge.observation(stopped).quarantined, false);
  assert.equal(f.bridge.store.messages().filter(m => m.workerId === stopped.id).length, 0, 'an intentional stop must not raise runtime attention');
  assert.equal(f.bridge.store.meta('fault:stopped-pi'), null);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(stopped.id).n, 1, 'a confirmed stop retains writer ownership pending descendant clearance');
  assert.equal(f.bridge.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get(stopped.id)?.state, 'pending_retirement');
  const stoppedJournal = f.bridge.store.db.prepare("SELECT data FROM journal WHERE type='agent.stopped'").all();
  assert.equal(stoppedJournal.length, 1);
  // Later native echoes for the same stopped worker are ignored rather than re-reported.
  await f.bridge.checkWorker(stopped, { type: 'finished' });
  assert.equal(f.bridge.store.messages().filter(m => m.workerId === stopped.id).length, 0);
});

test('a vanished terminal with a stop intent is recorded as stopped, not missing', async t => {
  const f = await fixture(t);
  const stopped = { ...worker, id: 'gone-pi', name: 'pi-gone', mailbox: 'cx-gone', terminalId: 't9' };
  f.bridge.store.saveWorker(stopped);
  f.bridge.store.meta('stop:gone-pi', { requestId: 'stop-1', state: 'confirmed' });
  await f.start();
  assert.equal(f.bridge.observation(stopped).stopped, true);
  assert.equal(f.bridge.store.messages().filter(m => m.workerId === stopped.id).length, 0);
});

test('a missing terminal without stop intent is still a runtime fault that retains its lease', async t => {
  const f = await fixture(t);
  const lost = { ...worker, id: 'crashed-pi', name: 'pi-crashed', mailbox: 'cx-crashed', terminalId: 't9', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(lost);
  await f.start();
  const fault = f.bridge.store.messages().find(m => m.workerId === lost.id);
  assert.equal(fault?.attention.reason, 'missing');
  assert.equal(f.bridge.observation(lost).quarantined, true);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(lost.id).n, 1, 'a fault retains the writer reservation');
});

test('a replaced process after a stop intent still faults instead of being excused', async t => {
  const f = await fixture(t);
  const stopped = { ...worker, id: 'replaced-pi', name: 'pi-replaced', mailbox: 'cx-replaced', terminalId: 't9', launchResult: { pid: 9999 }, writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(stopped);
  f.native.terminals.set('t9', terminalFor(stopped, { status: { state: 'working' }, turn: 1, pid: 1234 }));
  f.bridge.store.meta('stop:replaced-pi', { requestId: 'stop-1', state: 'requested' });
  await f.start();
  const fault = f.bridge.store.messages().find(m => m.workerId === stopped.id);
  assert.equal(fault?.attention.reason, 'process_replaced');
  assert.equal(f.bridge.observation(stopped).quarantined, true);
});

test('a delayed intentional stop is confirmed by the bridge exactly once and wakes the task chat', async t => {
  const f = await fixture(t);
  const stopped = { ...worker, id: 'late-pi', name: 'pi-late', mailbox: 'cx-late', terminalId: 't9' };
  f.bridge.store.saveWorker(stopped);
  f.native.terminals.set('t9', terminalFor(stopped, { status: { state: 'working' }, turn: 3 }));
  f.bridge.store.meta('stop:late-pi', { requestId: 'stop-1', state: 'requested', signalled: true });
  // Drive the bridge observation directly; no activity bus or IPC is required.
  f.bridge.rpc = f.native.factory({});
  // The original is still running: nothing may be latched as stopped.
  await f.bridge.checkWorker(stopped, { type: 'checked' });
  assert.notEqual(f.bridge.observation(stopped).stopped, true);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
  // The original now exits; the bridge confirms the durable stop once.
  f.native.terminals.get('t9').state = 'finished'; f.native.terminals.get('t9').exit_code = 0;
  await f.bridge.checkWorker(stopped, { type: 'finished' });
  assert.equal(f.bridge.observation(stopped).stopped, true);
  assert.equal(f.bridge.store.meta('stop:late-pi').state, 'confirmed');
  const notices = f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop');
  assert.equal(notices.length, 1, 'the exact chat is woken exactly once');
  assert.equal(notices[0].taskId, task.id);
  assert.equal(notices[0].kind, 'attention');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(stopped.id).n, 0);
  // Repeat observations stay idempotent: no second journal or lifecycle notice.
  await f.bridge.checkWorker(stopped, { type: 'finished' });
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
});

test('a CLI-confirmed stop and the later bridge observation commit exactly one notice', async t => {
  const f = await fixture(t);
  const stopped = { ...worker, id: 'cli-pi', name: 'pi-cli', mailbox: 'cx-cli', terminalId: 't9', launchState: 'started', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(stopped);
  f.bridge.store.meta('stop:cli-pi', { requestId: 'stop-1', state: 'requested', signalled: true });
  f.bridge.store.journal('agent.stop.requested', { workerId: 'cli-pi', taskId: task.id, requestId: 'stop-1' });
  const requests = new Requests(f.bridge.store);
  requests.reserve(stopped, 'stop-1', 'stop', {});
  requests.claim('cli-pi', 'stop-1');
  // The CLI observes the original exit first and commits the shared transition.
  const cli = requests.settleStop('cli-pi', 'stop-1', { confirmed: true, reason: 'process_finished', observedBy: 'cli', turn: 3 });
  assert.equal(cli.state, 'sent');
  assert.equal(f.bridge.store.meta('stop:cli-pi').state, 'confirmed');
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get('cli-pi').n, 1, 'a CLI-confirmed stop retains writer ownership pending descendant clearance');
  assert.equal(f.bridge.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get('cli-pi')?.state, 'pending_retirement');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
  // The bridge later observes the same exit; it must not journal or notify again.
  f.native.terminals.set('t9', terminalFor(stopped, { state: 'finished', status: { state: 'done' }, turn: 3, exit_code: 0 }));
  await f.bridge.intentionalStop(stopped, 'process_finished', f.native.terminals.get('t9'), { type: 'finished' });
  assert.equal(f.bridge.observation(stopped).stopped, true);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
  // A same-key CLI retry after the bridge observation is also a no-op.
  const retry = requests.settleStop('cli-pi', 'stop-1', { confirmed: true, reason: 'process_finished', observedBy: 'cli' });
  assert.equal(retry.state, 'sent');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
});

test('a failed bridge stop settlement leaves no latch and the retry commits exactly one notice', async t => {
  const f = await fixture(t);
  const rollback = { ...worker, id: 'rollback-pi', name: 'pi-rollback', mailbox: 'cx-rollback', terminalId: 't9', launchState: 'started', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(rollback);
  const requests = new Requests(f.bridge.store);
  requests.reserve(rollback, 'stop-1', 'stop', {});
  requests.claim(rollback.id, 'stop-1');
  f.bridge.store.meta('stop:' + rollback.id, { requestId: 'stop-1', state: 'requested', signalled: true });
  f.native.terminals.set('t9', terminalFor(rollback, { state: 'finished', status: { state: 'done' }, turn: 3, exit_code: 0 }));
  f.bridge.rpc = f.native.factory({});
  // A synchronous lifecycle-notice failure must abort the whole confirmed
  // transition. `ingest` is synchronous, so the fault throws synchronously and
  // unwinds the enclosing transaction (an async throw would be an unobserved
  // rejection and would not roll anything back).
  const ingest = f.bridge.store.ingest.bind(f.bridge.store);
  f.bridge.store.ingest = () => { throw new Error('inbox failure'); };
  await assert.rejects(f.bridge.checkWorker(rollback, { type: 'finished' }), /inbox failure/);
  // Nothing was latched or committed; the bridge must be able to retry.
  assert.notEqual(f.bridge.observation(rollback)?.stopped, true, 'a failed settlement must not latch the bridge stopped flag');
  assert.equal(f.bridge.store.meta('stop:' + rollback.id).state, 'requested');
  assert.equal(f.bridge.store.worker(rollback.id).launchState, 'started');
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(rollback.id).n, 1, 'the writer lease survives a rollback');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
  // Clear the fault; the same observation must now commit once.
  f.bridge.store.ingest = ingest;
  await f.bridge.checkWorker(rollback, { type: 'finished' });
  assert.equal(f.bridge.observation(rollback).stopped, true);
  assert.equal(f.bridge.store.meta('stop:' + rollback.id).state, 'confirmed');
  assert.equal(f.bridge.store.worker(rollback.id).launchState, 'stopped');
  // The native stop is confirmed, but writer ownership is RETAINED as a
  // separate fact: an empty registered graph is not proof about unregistered
  // detached descendants, so clearance stays `unknown` until the manager
  // reconciles it with explicit evidence.
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(rollback.id).n, 1, 'writer ownership is retained pending descendant clearance');
  assert.equal(f.bridge.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get(rollback.id)?.state, 'pending_retirement');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
  assert.equal(requests.get(rollback.id, 'stop-1').state, 'sent');
  // Reopen: a fresh bridge over the same durable state observes the same exit
  // and must not journal or notify a second time.
  const reopened = new Bridge(f.config, { clientFactory: options => f.native.factory(options), queue: f.queue });
  t.after(async () => { await reopened.stop(); await reopened.chain; reopened.store.close(); });
  reopened.rpc = f.native.factory({});
  await reopened.checkWorker(reopened.store.worker(rollback.id), { type: 'finished' });
  assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(reopened.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
});

test('a refused stop dispatch is faulted, never masked, when the original later exits', async t => {
  const f = await fixture(t);
  const refused = { ...worker, id: 'refused-pi', name: 'pi-refused', mailbox: 'cx-refused', terminalId: 't9', launchState: 'started', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(refused);
  // The native layer explicitly refused the signal; only the intent is recorded.
  f.bridge.store.meta('stop:refused-pi', { requestId: 'stop-1', state: 'requested', dispatch: 'refused' });
  f.native.terminals.set('t9', terminalFor(refused, { state: 'finished', status: { state: 'done' }, turn: 2, exit_code: 137 }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(refused, { type: 'finished' });
  // The exit is an unrelated runtime fault, not our intentional stop.
  const attention = f.bridge.store.messages().find(m => m.workerId === 'refused-pi');
  assert.equal(attention?.attention?.reason, 'process_finished');
  assert.equal(f.bridge.store.meta('stop:refused-pi').state, 'requested');
  assert.notEqual(f.bridge.store.meta('stop:refused-pi').state, 'confirmed');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a pre-dispatch stop never masks an unrelated later exit', async t => {
  const f = await fixture(t);
  const pending = { ...worker, id: 'nodispatch-pi', name: 'pi-nodispatch', mailbox: 'cx-nodispatch', terminalId: 't9', launchState: 'started', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(pending);
  f.bridge.store.meta('stop:nodispatch-pi', { requestId: 'stop-1', state: 'requested', dispatch: 'not-dispatched' });
  f.native.terminals.set('t9', terminalFor(pending, { state: 'finished', status: { state: 'done' }, turn: 1, exit_code: 1 }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(pending, { type: 'finished' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === 'nodispatch-pi')?.attention?.reason, 'process_finished');
  assert.equal(f.bridge.store.meta('stop:nodispatch-pi').state, 'requested');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a finished exit observed while a kill is in flight settles conservatively as unattributed exactly once', async t => {
  const f = await fixture(t);
  const inflight = { ...worker, id: 'inflight-pi', name: 'pi-inflight', mailbox: 'cx-inflight', terminalId: 't9', launchState: 'started', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(inflight);
  // The kill was issued but its receipt is still outstanding.
  f.bridge.store.meta('stop:inflight-pi', { requestId: 'stop-1', state: 'requested', dispatch: 'dispatching' });
  f.bridge.store.journal('agent.stop.requested', { workerId: 'inflight-pi', requestId: 'stop-1' });
  f.native.terminals.set('t9', terminalFor(inflight, { state: 'finished', status: { state: 'done' }, turn: 4, exit_code: 137 }));
  f.bridge.rpc = f.native.factory({});
  // A pending dispatch is NOT acceptance, and no second native event is
  // guaranteed, so the FIRST finished observation settles conservatively as
  // UNATTRIBUTED with exactly one durable wake. We must not defer.
  await f.bridge.checkWorker(inflight, { type: 'finished' });
  const settled = f.bridge.store.meta('stop:inflight-pi');
  assert.equal(settled.state, 'confirmed');
  assert.equal(settled.attribution, 'unattributed');
  assert.equal(settled.observedExit.reason, 'process_finished', 'raw exit evidence is preserved separately');
  assert.equal(f.bridge.store.worker('inflight-pi').launchState, 'stopped');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'unattributed_exit').length, 1);
  // A late accepted receipt is recorded as dispatch evidence but never rewrites
  // the frozen verdict or adds a second notice.
  f.bridge.store.meta('stop:inflight-pi', { ...f.bridge.store.meta('stop:inflight-pi'), dispatch: 'accepted' });
  await f.bridge.checkWorker(inflight, { type: 'finished' });
  assert.equal(f.bridge.store.meta('stop:inflight-pi').attribution, 'unattributed', 'an accepted late receipt never rewrites the verdict');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'unattributed_exit').length, 1);
  // Another echo does not duplicate the stop or the notice.
  await f.bridge.checkWorker(inflight, { type: 'finished' });
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'unattributed_exit').length, 1);
});

// --- R2-5 original-process identity precedence (direct bridge observation) ---
// These drive `checkWorker` against a fake native transport, so they do not bind
// the activity IPC socket and can run in a sandboxed environment. Each asserts
// that an explicit identity mismatch wins over a lifecycle event and over an
// accepted stop, produces a fault/quarantine, and never confirms the stop or
// releases the original writer lease.
test('a changed pid wins over a lost event even with an accepted stop', async t => {
  const f = await fixture(t);
  const replaced = { ...worker, id: 'lost-replaced', name: 'pi-lost-replaced', mailbox: 'cx-lr', terminalId: 't9', launchResult: { pid: 9999 }, writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(replaced);
  // The signal was acknowledged by native; only a DIFFERENT process is visible now.
  f.bridge.store.meta('stop:lost-replaced', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.native.terminals.set('t9', terminalFor(replaced, { status: { state: 'working' }, turn: 1, pid: 1234 }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(replaced, { type: 'lost' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === replaced.id)?.attention?.reason, 'process_replaced');
  assert.equal(f.bridge.observation(replaced).quarantined, true);
  assert.ok(f.bridge.store.meta('fault:lost-replaced'), 'a replacement is recorded as a durable runtime fault');
  assert.equal(f.bridge.store.meta('stop:lost-replaced').state, 'requested', 'a replacement never confirms the original stop');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(replaced.id).n, 1, 'a replacement never releases the original writer lease');
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a changed pid wins over a removed event even with an accepted stop', async t => {
  const f = await fixture(t);
  const replaced = { ...worker, id: 'removed-replaced', name: 'pi-removed-replaced', mailbox: 'cx-rr', terminalId: 't9', launchResult: { pid: 9999 }, writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(replaced);
  f.bridge.store.meta('stop:removed-replaced', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.native.terminals.set('t9', terminalFor(replaced, { status: { state: 'working' }, turn: 1, pid: 1234 }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(replaced, { type: 'removed' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === replaced.id)?.attention?.reason, 'process_replaced');
  assert.equal(f.bridge.observation(replaced).quarantined, true);
  assert.equal(f.bridge.store.meta('stop:removed-replaced').state, 'requested');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(replaced.id).n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a swapped codex.task label is a process replacement, not the original', async t => {
  const f = await fixture(t);
  const swapped = { ...worker, id: 'task-swapped', name: 'pi-task-swapped', mailbox: 'cx-ts', terminalId: 't9', writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(swapped);
  f.bridge.store.meta('stop:task-swapped', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.native.terminals.set('t9', terminalFor(swapped, { turn: 1, labels: { 'codex.worker': swapped.id, 'codex.task': 'task-OTHER' } }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(swapped, { type: 'checked' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === swapped.id)?.attention?.reason, 'process_replaced');
  assert.equal(f.bridge.observation(swapped).quarantined, true);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a swapped codex.desk label is a process replacement, not the original', async t => {
  const f = await fixture(t);
  const deskTask = { ...task, id: 'task-desk', deskId: 'desk-1', deskProjectId: '/private/desk' };
  const swapped = { ...worker, id: 'desk-swapped', taskId: 'task-desk', name: 'pi-desk-swapped', mailbox: 'cx-ds', terminalId: 't9', deskId: 'desk-1', deskProjectId: '/private/desk', writePaths: ['/private/project/src'] };
  f.bridge.store.saveTask(deskTask);
  f.bridge.store.reserveWorker(swapped);
  f.bridge.store.meta('stop:desk-swapped', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.native.terminals.set('t9', terminalFor(swapped, { turn: 1, labels: { 'codex.worker': swapped.id, 'codex.task': swapped.taskId, 'codex.desk': 'desk-OTHER', 'codex.desk-project': swapped.deskProjectId } }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(swapped, { type: 'checked' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === swapped.id)?.attention?.reason, 'process_replaced');
  assert.equal(f.bridge.observation(swapped).quarantined, true);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a swapped argv is a process replacement, not an intentional stop', async t => {
  const f = await fixture(t);
  const swapped = { ...worker, id: 'argv-swapped', name: 'pi-argv-swapped', mailbox: 'cx-as', terminalId: 't9', launchArgv: ['fake-agent', '--run'], writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(swapped);
  f.bridge.store.meta('stop:argv-swapped', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.native.terminals.set('t9', terminalFor(swapped, { turn: 1, argv: ['fake-agent', '--different'] }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(swapped, { type: 'checked' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === swapped.id)?.attention?.reason, 'process_replaced');
  assert.equal(f.bridge.observation(swapped).quarantined, true);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a finished adopted process with a different argv is never confirmed as the original stop', async t => {
  const f = await fixture(t);
  const adopted = { ...worker, id: 'adopted-pi', name: 'pi-adopted', mailbox: 'cx-adopted', terminalId: 't9',
    launchResult: { pid: 4321 }, launchIdentity: { created_ms: 111 },
    adoption: { nativeIdentity: { address: 't9', pid: 4321, created_ms: 111, argv: ['other-program'], parent: null }, labels: {} },
    writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(adopted);
  f.bridge.store.meta('stop:adopted-pi', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.native.terminals.set('t9', terminalFor(adopted, { state: 'finished', status: { state: 'done' }, turn: 5, exit_code: 0, created_ms: 111, argv: ['fake-agent'] }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(adopted, { type: 'finished' });
  assert.equal(f.bridge.store.messages().find(m => m.workerId === adopted.id)?.attention?.reason, 'process_replaced', 'an adopted identity mismatch is not a plain finished exit');
  assert.equal(f.bridge.observation(adopted).quarantined, true);
  assert.equal(f.bridge.store.meta('stop:adopted-pi').state, 'requested');
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 0);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(adopted.id).n, 1, 'a mismatched adopted process never releases the original lease');
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 0);
});

test('a matching original with an accepted stop is still confirmed exactly once', async t => {
  const f = await fixture(t);
  const stopped = { ...worker, id: 'matching-pi', name: 'pi-matching', mailbox: 'cx-matching', terminalId: 't9', launchResult: { pid: 9999 }, writePaths: ['/private/project/src'] };
  f.bridge.store.reserveWorker(stopped);
  f.bridge.store.meta('stop:matching-pi', { requestId: 'stop-1', state: 'requested', dispatch: 'accepted' });
  f.bridge.store.journal('agent.stop.requested', { workerId: 'matching-pi', taskId: task.id, requestId: 'stop-1' });
  f.native.terminals.set('t9', terminalFor(stopped, { state: 'finished', status: { state: 'done' }, turn: 6, exit_code: 0, pid: 9999 }));
  f.bridge.rpc = f.native.factory({});
  await f.bridge.checkWorker(stopped, { type: 'finished' });
  assert.equal(f.bridge.store.meta('stop:matching-pi').state, 'confirmed');
  assert.equal(f.bridge.observation(stopped).stopped, true);
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
  assert.equal(f.bridge.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(stopped.id).n, 1, 'a confirmed original stop retains writer ownership pending descendant clearance');
  assert.equal(f.bridge.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get(stopped.id)?.state, 'pending_retirement');
  await f.bridge.checkWorker(stopped, { type: 'finished' });
  assert.equal(f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n, 1);
  assert.equal(f.bridge.store.messages().filter(m => m.attention?.reason === 'intentional_stop').length, 1);
});
