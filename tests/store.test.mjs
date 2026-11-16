import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER = '01a1d317-b5d9-7530-8623-f60c0df12d38';
const task = { id: 'task-1', name: 'Real checkout repair', project: '/private/project', threadId: THREAD, status: 'active' };
const worker = { id: 'worker-1', taskId: task.id, name: 'pi-work', role: 'pi', project: task.project, terminalId: 't7', mailbox: 'cx-worker-1' };
const message = (id = 'question-1', extra = {}) => ({
  id, taskId: task.id, workerId: worker.id, terminalId: worker.terminalId,
  kind: 'question', text: 'Which compatibility behavior should be preserved?',
  createdAt: '2026-11-13T00:00:00.000Z', turn: 1, ...extra,
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-store-'));
  const path = join(dir, 'manager.sqlite');
  let store = new Store(path);
  store.saveTask(task); store.saveWorker(worker);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    path, get store() { return store; },
    reopen() { store.close(); store = new Store(path); return store; },
  };
}

test('persisted task and worker identities cannot silently route a message elsewhere', async t => {
  const f = await fixture(t);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.throws(() => f.store.saveTask({ ...task, threadId: OTHER }), /reroute/);
  assert.throws(() => f.store.saveTask({ ...task, project: '/another/project' }), /reroute/);
  assert.throws(() => f.store.saveWorker({ ...worker, terminalId: 't8' }), /reassigned/);
  assert.throws(() => f.store.saveWorker({ ...worker, mailbox: 'foreign-box' }), /reassigned/);
  for (const extra of [{ taskId: 'other-task' }, { workerId: 'other-worker' }, { terminalId: 't8' }]) {
    assert.throws(() => f.store.ingest(worker, message('spoofed', extra)), /registered/);
  }
  f.reopen();
  assert.equal(f.store.task(task.id).threadId, THREAD);
  assert.equal(f.store.worker(worker.id).terminalId, 't7');
  assert.equal(f.store.messages().length, 0);
});

test('message replay after reopening is idempotent; conflicting payloads are not accepted', async t => {
  const f = await fixture(t);
  assert.equal(f.store.ingest(worker, message()), true);
  f.reopen();
  assert.equal(f.store.ingest(worker, message()), false);
  assert.throws(() => f.store.ingest(worker, message('question-1', { text: 'Different request' })), /different contents/);
  assert.equal(f.store.messages().length, 1);
  assert.equal(f.store.message('question-1').text, message().text);
});

test('restart recovers interrupted sends while retaining already queued and informational messages', async t => {
  const f = await fixture(t);
  f.store.ingest(worker, message('interrupted'));
  f.store.ingest(worker, message('queued'));
  f.store.ingest(worker, message('progress', { kind: 'progress' }));
  assert.equal(f.store.startDispatch('interrupted'), true);
  assert.equal(f.store.startDispatch('queued'), true);
  f.store.finishDispatch('queued', { status: 'queued', receipt: 'native-receipt', warning: null, error: null });
  f.reopen().recoverDispatches();
  assert.equal(f.store.message('interrupted').delivery, 'uncertain');
  assert.equal(f.store.message('interrupted').attempts, 1);
  assert.deepEqual(f.store.pendingDispatch().map(m => m.id), ['interrupted']);
  assert.equal(f.store.message('queued').receipt, 'native-receipt');
  assert.equal(f.store.message('progress').delivery, 'informational');
});

test('two store connections cannot both claim the same dispatch', async t => {
  const f = await fixture(t);
  f.store.ingest(worker, message());
  const observer = new Store(f.path);
  try {
    assert.equal(f.store.startDispatch('question-1'), true);
    assert.equal(observer.startDispatch('question-1'), false);
    assert.equal(observer.message('question-1').attempts, 1);
  } finally { observer.close(); }
});

test('only an explicit same-task report can supersede an unsent completion notice', async t => {
  const f = await fixture(t);
  const notice = id => message(id, { kind: 'attention', attention: { reason: 'turn_ended' } });
  for (const id of ['unsent', 'sending', 'received', 'fault']) {
    f.store.ingest(worker, id === 'fault' ? message(id, {kind:'attention',attention:{reason:'process_lost'}}) : notice(id), {lifecycle:true});
  }
  f.store.ingest(worker, message('report', { kind: 'result' }));
  f.store.startDispatch('sending');
  f.store.receive('received');
  assert.equal(f.store.supersedeAttention('unsent', 'absent'), false);
  for(const id of ['sending','received','fault']) assert.equal(f.store.supersedeAttention(id,'report'),false);
  assert.equal(f.store.supersedeAttention('unsent', 'report'), true);
  f.reopen();
  const saved = f.store.message('unsent');
  assert.equal(saved.delivery, 'superseded');
  assert.equal(saved.action.kind, 'superseded');
  assert.ok(saved.acknowledgedAt);
  assert.equal(f.store.startDispatch('unsent'), false);
  assert.equal(f.store.supersedeAttention('unsent', 'report'), false);
});

test('a failed outer handoff transaction rolls back nested notice supersession and its context', async t => {
  const f=await fixture(t);
  f.store.ingest(worker,message('notice',{kind:'attention',attention:{reason:'turn_ended'}}),{lifecycle:true});
  f.store.ingest(worker,message('report',{kind:'result'}));
  assert.throws(()=>f.store.transaction(()=>{
    assert.equal(f.store.supersedeAttention('notice','report'),true);
    f.store.meta('handoff:report',{workers:[worker.id]});
    throw new Error('simulated interrupted handoff');
  }),/interrupted/);
  f.reopen();
  assert.equal(f.store.message('notice').delivery,'pending');
  assert.equal(f.store.message('notice').acknowledgedAt,null);
  assert.equal(f.store.message('report').handoff,null);
});

test('actual chat receipt fences further delivery retries before the final action/ack', async t => {
  const f = await fixture(t);
  f.store.ingest(worker, message());
  f.store.startDispatch('question-1');
  f.store.finishDispatch('question-1', { status: 'uncertain', receipt: null, error: 'timeout' });
  f.store.db.prepare('UPDATE messages SET retry_at=0 WHERE id=?').run('question-1');
  const received = f.store.receive('question-1').receivedAt;
  assert.ok(received);
  f.reopen().recoverDispatches();
  assert.equal(f.store.receive('question-1').receivedAt, received);
  assert.deepEqual(f.store.pendingDispatch(), []);
  assert.equal(f.store.startDispatch('question-1'), false);
});

test('reply intent is durable, only claimed once, and cannot be acknowledged while ambiguous', async t => {
  const f = await fixture(t);
  f.store.ingest(worker, message()); f.store.receive('question-1');
  const action = { kind: 'reply', text: 'Preserve nullish fallback semantics.', requestId: 'reply-1' };
  assert.throws(() => f.store.ack('question-1'), /Record a completed/);
  f.store.recordAction('question-1', action);
  assert.throws(() => f.store.ack('question-1'), /Record a completed/);
  assert.equal(f.store.claimReply('question-1'), true);
  f.reopen();
  assert.equal(f.store.recordAction('question-1', action).state, 'sending');
  assert.equal(f.store.claimReply('question-1'), false);
  assert.throws(() => f.store.recordAction('question-1', { ...action, text: 'Changed decision' }), /already recorded/);
  assert.throws(() => f.store.ack('question-1'), /Record a completed/);
  f.store.setActionState('question-1', 'uncertain', { error: 'Response lost after native send' });
  assert.equal(f.store.claimReply('question-1'), false);
  assert.throws(() => f.store.ack('question-1'), /Record a completed/);
  f.store.setActionState('question-1', 'sent', { reconciliation: 'Observed correlated reply in native terminal.' });
  const acknowledged = f.store.ack('question-1').acknowledgedAt;
  f.reopen();
  assert.equal(f.store.ack('question-1').acknowledgedAt, acknowledged);
  assert.equal(f.store.messages({ pending: true }).length, 0);
});

test('decisions are recorded before acknowledgement and remain replayable after restart', async t => {
  const f = await fixture(t);
  f.store.ingest(worker, message('done', { kind: 'result' })); f.store.receive('done');
  const action = { kind: 'accept', text: 'Independent test passed.', requestId: 'accept-1' };
  f.store.recordAction('done', action); f.reopen();
  assert.equal(f.store.recordAction('done', action).state, 'recorded');
  assert.ok(f.store.ack('done').acknowledgedAt);
  assert.equal(f.store.pendingDispatch().length, 0);
});

test('durable writer reservation fences simultaneous launches and nested writable paths', async t => {
  const f = await fixture(t);
  const first = { ...worker, id: 'writer-1', terminalId: null, mailbox: 'cx-writer-1', launchState: 'preparing', writePaths: ['/private/project'] };
  f.store.reserveWorker(first);
  const contender = new Store(f.path);
  try {
    for (const path of ['/private/project', '/private/project/src', '/private']) {
      assert.throws(() => contender.reserveWorker({ ...first, id: 'writer-2', mailbox: 'cx-writer-2', writePaths: [path] }), /already owned/);
      assert.equal(contender.worker('writer-2'), null);
    }
    contender.reserveWorker({ ...first, id: 'reader', mailbox: 'cx-reader', writePaths: [] });
    const independentTask={...task,id:'task-independent',project:'/private/project-other'};
    contender.saveTask(independentTask);
    contender.reserveWorker({ ...first, id: 'independent', taskId:independentTask.id, project:independentTask.project, mailbox: 'cx-independent', writePaths: [independentTask.project] });
    assert.equal(contender.worker('independent').taskId,independentTask.id);
    assert.equal(contender.task(task.id).project,task.project);
  } finally { contender.close(); }
  f.reopen();
  assert.throws(() => f.store.reserveWorker({ ...first, id: 'writer-3', mailbox: 'cx-writer-3' }), /already owned/);
  f.store.releaseWriter(first.id);
  f.store.reserveWorker({ ...first, id: 'writer-3', mailbox: 'cx-writer-3' });
  assert.equal(f.store.worker('writer-3').launchState, 'preparing');
});
