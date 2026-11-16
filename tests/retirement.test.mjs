import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Retirement, COVERAGE, RETIREMENT, executionBinding } from '../src/retirement.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER = '01a1d317-b5d9-7530-8623-f60c0df12d38';
const task = { id: 'task-1', name: 'Retirement fixture', project: '/private/project', threadId: THREAD, status: 'active' };
const worker = { id: 'worker-1', taskId: task.id, name: 'pi-work', role: 'pi', project: task.project,
  terminalId: 't7', mailbox: 'cx-worker-1', writePaths: [task.project] };
const child = (id, extra = {}) => ({ id, taskId: task.id, name: id, role: 'pi', project: task.project,
  terminalId: 't-' + id, mailbox: 'cx-' + id, ...extra });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-retirement-'));
  const store = new Store(join(dir, 'manager.sqlite'));
  store.saveTask(task);
  store.reserveWorker({ ...worker });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return store;
}
const boundComplete = (r, w, ref = 'review-1') => ({
  coverage: COVERAGE.COMPLETE, executionId: r.executionId(w), source: 'manager-observation',
  reference: ref, descendants: [],
});
// A genuinely authoritative fake containment provider: the injected function is
// the trust anchor, not a text label. It returns an exact execution-bound verdict
// and ignores any caller `claim`, so copying a source name cannot change it.
const provider = (extra = {}, source = 'manager-observation') => {
  const fn = ({ executionId }) => ({ coverage: COVERAGE.COMPLETE, executionId, source, descendants: [], ...extra });
  fn.source = source;
  return fn;
};

test('default provider never claims complete and a native exit retains the writer lease', async t => {
  const store = await fixture(t);
  const r = new Retirement(store);
  assert.equal(store.writerLeases().length, 1);
  const os = r.clearance(worker);
  assert.equal(os.complete, false);
  assert.equal(os.coverage, COVERAGE.UNKNOWN);
  // Copying the default provider's source name mints nothing: the provider is
  // still consulted and still reports unknown.
  const forged = r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: r.executionId(worker), source: 'default-no-os-containment', descendants: [] });
  assert.equal(forged.complete, false);
  assert.equal(forged.coverage, COVERAGE.UNKNOWN);
  const settled = r.settle({ worker, observedExit: { confirmed: true, reason: 'process_finished' } });
  assert.equal(settled.released, false);
  assert.equal(settled.state, RETIREMENT.PENDING);
  assert.equal(store.writerLeases().length, 1, 'lease must survive an unproven OS clearance');
  assert.equal(r.status(worker.id).reason, 'descendant-coverage-unknown');
});

test('a caller-copied source label cannot mint complete clearance', async t => {
  const store = await fixture(t);
  // The default provider reports unknown, so even a `complete` claim that copies
  // its exact source name is held.
  const def = new Retirement(store);
  const forgedDefault = def.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: def.executionId(worker), source: 'default-no-os-containment', descendants: [] });
  assert.equal(forgedDefault.complete, false);
  assert.equal(forgedDefault.coverage, COVERAGE.UNKNOWN);
  // Generalises beyond the default string: an ALLOWLISTED provider that itself
  // returns unknown is still held no matter what the caller labels the claim.
  const r = new Retirement(store, { provider: provider({ coverage: COVERAGE.UNKNOWN }, 'qualified-containment'), trustedSources: ['qualified-containment'] });
  const held = r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: r.executionId(worker), source: 'qualified-containment', descendants: [] });
  assert.equal(held.complete, false);
  assert.equal(held.coverage, COVERAGE.UNKNOWN);
  assert.equal(held.reason, 'descendant-coverage-unknown');
});

test('a complete verdict requires a well-formed quiescent descendant array', async t => {
  const store = await fixture(t);
  const held = descendants => new Retirement(store, { provider: provider({ descendants }, 'test') }).clearance(worker);
  // Missing / malformed / oversized descendant evidence is never exit proof.
  assert.equal(held(undefined).complete, false);
  assert.equal(held(undefined).reason, 'descendant-evidence-malformed');
  assert.equal(held(null).complete, false);
  assert.equal(held([null]).complete, false);
  assert.equal(held('nope').complete, false);
  assert.equal(held(Array.from({ length: 5000 }, (_, i) => ({ pid: i + 1, exited: true }))).reason, 'descendant-evidence-malformed');
  // A named entry with no explicit state is UNKNOWN, never inferred stopped.
  assert.equal(held([{ pid: 777 }]).complete, false);
  assert.equal(held([{ pid: 777 }]).reason, 'descendant-evidence-unknown');
  assert.equal(held([{ pid: 777, state: 'unknown' }]).complete, false);
  // Idle/done/closed turn state is NOT exit proof.
  assert.equal(held([{ pid: 777, state: 'idle' }]).complete, false);
  assert.equal(held([{ pid: 777, state: 'done' }]).complete, false);
  // Contradictory live + terminal indicators block.
  assert.equal(held([{ pid: 777, live: true, exited: true }]).complete, false);
  assert.equal(held([{ pid: 777, live: true, exited: true }]).reason, 'descendant-evidence-contradictory');
  // Explicit live blocks, even without a state token.
  assert.equal(held([{ pid: 777, live: true }]).reason, 'descendant-live-evidence');
  // An explicit quiescent shape that names the process is accepted.
  assert.equal(held([{ pid: 777, exited: true }]).complete, true);
  assert.equal(held([{ pid: 777, state: 'exited' }]).complete, true);
  assert.equal(held([{ id: 'proc-1', stopped: true }]).complete, true);
  assert.equal(held([]).complete, true);
});

test('a throwing provider is an honest unknown hold, not an escaped error', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: () => { throw new Error('probe-crashed'); } });
  const judged = r.clearance(worker);
  assert.equal(judged.complete, false);
  assert.equal(judged.coverage, COVERAGE.UNKNOWN);
  assert.equal(judged.reason, 'descendant-coverage-error');
  // The exit transaction is preserved: a provider fault holds the lease rather
  // than throwing past settle and aborting the caller.
  const held = r.settle({ worker, observedExit: { confirmed: true, reason: 'process_finished' } });
  assert.equal(held.released, false);
  assert.equal(held.state, RETIREMENT.PENDING);
  assert.equal(store.writerLeases().length, 1);
});

test('a live registered descendant blocks complete clearance even when evidence is bound', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider({}, 'test') });
  store.saveWorker(child('worker-2', { supervisorId: worker.id }));
  const exec = r.executionId(worker);
  const blocked = r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'test', descendants: [] });
  assert.equal(blocked.complete, false);
  assert.equal(blocked.reason, 'registered-child-live');
  assert.deepEqual(blocked.liveChildren, ['worker-2']);
  // Idle/done turn state is NOT exit proof, so it must not clear the child.
  store.meta('observation:worker-2', { state: 'idle', stopped: false });
  assert.equal(r.descendantExited(store.worker('worker-2')), false);
  assert.equal(r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'test', descendants: [] }).complete, false);
  // An explicit stopped observation is exit proof for this layer.
  store.meta('observation:worker-2', { state: 'done', stopped: true });
  const cleared = r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'test', descendants: [] });
  assert.equal(cleared.complete, true);
});

test('setClearance requires authority/reference and defers to the provider verdict', async t => {
  const store = await fixture(t);
  const exec = new Retirement(store).executionId(worker);
  const current = new Retirement(store, { provider: provider({}, 'mgr') });
  assert.throws(() => current.setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec }), /authority/);
  assert.throws(() => current.setClearance(worker, { coverage: COVERAGE.COMPLETE, reference: 'ref-1', executionId: exec }), /authority/);
  assert.throws(() => current.setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec }, { source: 'mgr' }), /bounded reference/);
  // A provider that reports unknown/partial/an error/a mismatched execution or
  // explicit live descendants is held, regardless of the caller's `complete`.
  assert.throws(() => new Retirement(store, { provider: provider({ coverage: COVERAGE.UNKNOWN }, 'mgr'), trustedSources: ['mgr'] }).setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'mgr' }), /not complete/);
  assert.throws(() => new Retirement(store, { provider: provider({ coverage: COVERAGE.PARTIAL }, 'mgr'), trustedSources: ['mgr'] }).setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'mgr' }), /not complete/);
  assert.throws(() => new Retirement(store, { provider: provider({ error: 'probe-failed' }, 'mgr'), trustedSources: ['mgr'] }).setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'mgr' }), /not complete/);
  assert.throws(() => new Retirement(store, { provider: provider({ executionId: 'stale' }, 'mgr'), trustedSources: ['mgr'] }).setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'mgr' }), /not complete/);
  assert.throws(() => new Retirement(store, { provider: provider({ descendants: [{ pid: 42, live: true }] }, 'mgr'), trustedSources: ['mgr'] }).setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'mgr' }), /not complete/);
  // The genuine execution-bound provider verdict releases.
  current.setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'mgr' });
  assert.equal(current.storedClearance(worker).coverage, COVERAGE.COMPLETE);
  assert.equal(current.storedClearance(worker).executionId, exec);
});

test('hold preserves the original execution binding and records the mismatch', async t => {
  const store = await fixture(t);
  const r = new Retirement(store);
  r.request(worker, { requestId: 'stop-A' });
  const original = r.record(worker.id).binding;
  const replaced = { ...worker, launchResult: { pid: 9999 } };
  const held = r.hold(replaced, { reason: 'execution-binding-changed', requestId: 'stop-A' });
  assert.deepEqual(held.record.binding, original, 'a replaced process must not rewrite the leased identity');
  assert.equal(held.record.binding.pid, null);
  assert.equal(held.record.bindingMismatch.observed.pid, 9999);
  assert.deepEqual(held.record.bindingMismatch.expected, original);
  // A subsequent request on the same binding stays bound to the original request.
  assert.equal(r.request(worker, { requestId: 'stop-A' }).requestId, 'stop-A');
});

test('request and settle guard request conflicts and never release twice', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider() });
  r.request(worker, { requestId: 'stop-A' });
  assert.throws(() => r.request(worker, { requestId: 'stop-B' }), /already bound to request stop-A/);
  const released = () => store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='retirement.released'").get().n;
  const first = r.settle({ worker, requestId: 'stop-A', observedExit: { confirmed: true }, evidence: boundComplete(r, worker) });
  assert.equal(first.released, true);
  assert.equal(store.writerLeases().length, 0);
  assert.equal(released(), 1);
  const second = r.settle({ worker, requestId: 'stop-A', observedExit: { confirmed: true }, evidence: boundComplete(r, worker) });
  assert.equal(second.released, true);
  assert.equal(second.idempotent, true);
  assert.equal(released(), 1, 'an already-released retirement is never re-journaled');
  assert.equal(store.writerLeases().length, 0);
});

test('reconcile fails closed on incomplete, unbound or unverified evidence and releases on exact evidence', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider() });
  const exec = r.executionId(worker);
  r.request(worker, { requestId: 'stop-A' });
  const complete = { coverage: COVERAGE.COMPLETE, source: 'manager-observation', reference: 'review-1', descendants: [] };
  const call = evidence => r.reconcile({ threadId: THREAD, workerId: worker.id, executionId: exec, evidence });
  assert.throws(() => call(complete), /not durably verified/);
  store.meta('stop:' + worker.id, { requestId: 'stop-A', state: 'confirmed',
    observedExit: { reason: 'process_finished', at: '2026-11-13T00:00:00.000Z' }, attribution: 'intentional' });
  assert.throws(() => r.reconcile({ threadId: 'not-a-uuid', workerId: worker.id, executionId: exec, evidence: complete }), /exact manager chat/);
  assert.throws(() => r.reconcile({ threadId: OTHER, workerId: worker.id, executionId: exec, evidence: complete }), /does not belong to this chat/);
  assert.throws(() => r.reconcile({ threadId: THREAD, workerId: worker.id, executionId: 'stale', evidence: complete }), /Execution identity/);
  assert.throws(() => call({ ...complete, executionId: 'stale' }), /bound to a different execution/);
  assert.throws(() => call({ coverage: COVERAGE.UNKNOWN, reference: 'review-1', source: 'manager-observation', descendants: [] }), /explicit complete/);
  assert.throws(() => call({ coverage: COVERAGE.COMPLETE, source: 'manager-observation', descendants: [] }), /bounded reference/);
  const result = call(complete);
  assert.equal(result.released, true);
  assert.equal(result.record.reason, 'manager-reconciled');
  assert.equal(store.writerLeases().length, 0);
});

test('a verified never-launched rollback releases the reservation explicitly', async t => {
  const store = await fixture(t);
  const r = new Retirement(store);
  // A worker that ever reached native retains ownership even with no confirmed
  // exit: an unconfirmed observation is not release proof.
  const held = r.settle({ worker, observedExit: { confirmed: false, reason: 'gone' } });
  assert.equal(held.released, false);
  assert.equal(held.state, RETIREMENT.PENDING);
  assert.equal(store.writerLeases().some(l => l.workerId === worker.id), true, 'a launched worker retains ownership');

  // Local preparation failed before any native request, so this worker never
  // reached a process or any descendant: an explicit non-holding release. The
  // fixture must carry the ACTUAL rollback launch state -- the guard is not
  // loosened.
  store.releaseWriter(worker.id); // free the shared checkout for the reservation
  store.reserveWorker({ id: 'worker-unstarted', taskId: task.id, name: 'pi-unstarted', role: 'pi',
    project: task.project, terminalId: null, launchState: 'preparation_failed', mailbox: 'cx-unstarted', writePaths: [task.project] });
  const unstarted = store.worker('worker-unstarted');
  assert.equal(store.writerLeases().some(l => l.workerId === 'worker-unstarted'), true, 'the reservation holds a lease');
  const released = r.settle({ worker: unstarted, observedExit: { confirmed: false, reason: 'never-launched' }, reason: 'never-launched' });
  assert.equal(released.released, true);
  assert.equal(released.record.reason, 'never-launched');
  assert.equal(store.writerLeases().some(l => l.workerId === 'worker-unstarted'), false, 'the reservation lease is released');

  // An UNKNOWN launch state (no proven `preparation_failed`) must stay held:
  // the unknown-state guard is NOT weakened.
  store.reserveWorker({ id: 'worker-unknown', taskId: task.id, name: 'pi-unknown', role: 'pi',
    project: task.project, terminalId: null, mailbox: 'cx-unknown', writePaths: [task.project] });
  const unknown = store.worker('worker-unknown');
  const stillHeld = r.settle({ worker: unknown, observedExit: { confirmed: false, reason: 'gone' }, reason: 'never-launched' });
  assert.equal(stillHeld.released, false, 'an unknown launch state is not release proof');
  assert.equal(stillHeld.state, RETIREMENT.PENDING);
  assert.equal(store.writerLeases().some(l => l.workerId === 'worker-unknown'), true, 'an unknown launch state retains the lease');
  store.releaseWriter('worker-unknown');

  // Atomicity: a fault inside the never-launched transaction rolls the release
  // back -- the lease survives and no released record is written.
  store.reserveWorker({ id: 'worker-fault', taskId: task.id, name: 'pi-fault', role: 'pi',
    project: task.project, terminalId: null, launchState: 'preparation_failed', mailbox: 'cx-fault', writePaths: [task.project] });
  const faulted = store.worker('worker-fault');
  const real = store.journal;
  store.journal = () => { throw new Error('journal-fault'); };
  assert.throws(() => r.settle({ worker: faulted, observedExit: { confirmed: false, reason: 'never-launched' }, reason: 'never-launched' }), /journal-fault/);
  store.journal = real;
  assert.equal(store.writerLeases().some(l => l.workerId === 'worker-fault'), true, 'a fault rolls the lease release back');
  assert.equal(r.record('worker-fault'), null, 'a fault writes no released record');
});

test('graph resolves the frozen delegation parent link and flags cross-chat children', async t => {
  const store = await fixture(t);
  const r = new Retirement(store);
  store.saveWorker(child('delegated', { delegation: { spec: { parentId: worker.id } } }));
  store.saveWorker(child('supervised', { supervisorId: worker.id }));
  const graph = r.graph(worker);
  assert.deepEqual(graph.descendants.map(w => w.id).sort(), ['delegated', 'supervised']);
  assert.deepEqual(graph.issues, []);
  assert.equal(executionBinding(store.worker('delegated')).parentId, worker.id);

  store.saveTask({ id: 'task-2', name: 'Other chat', project: task.project, threadId: OTHER, status: 'active' });
  store.saveWorker({ id: 'foreign', taskId: 'task-2', name: 'foreign', role: 'pi', project: task.project,
    terminalId: 't-foreign', mailbox: 'cx-foreign', supervisorId: worker.id });
  const poisoned = r.graph(worker);
  assert.equal(poisoned.issues.some(i => i.issue === 'cross-chat'), true);
  const exec = r.executionId(worker);
  const judgement = r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'test', descendants: [] });
  assert.equal(judgement.complete, false);
  assert.equal(judgement.reason, 'registered-child-graph-unsafe');
});

test('a caller-chosen source label is not provenance and never mints authority', async t => {
  const store = await fixture(t);
  const exec = new Retirement(store).executionId(worker);
  // The authority gate on setClearance still rejects an unknown authority.
  const r = new Retirement(store, { provider: provider({}, 'approved-containment'), trustedSources: ['approved-containment'] });
  assert.throws(() => r.setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1', source: 'worker-claim' }), /not a trusted containment provider/);
  // clearance() never reads the caller label: an allowlisted label whose provider
  // reports unknown is still held.
  const unknown = new Retirement(store, { provider: provider({ coverage: COVERAGE.UNKNOWN }, 'approved-containment'), trustedSources: ['approved-containment'] });
  const judged = unknown.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'approved-containment', descendants: [] });
  assert.equal(judged.complete, false);
  assert.equal(judged.coverage, COVERAGE.UNKNOWN);
  assert.equal(judged.reason, 'descendant-coverage-unknown');
  // The genuine provider verdict still succeeds.
  r.setClearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, reference: 'ref-1' }, { source: 'approved-containment' });
  assert.equal(r.storedClearance(worker).coverage, COVERAGE.COMPLETE);
});

test('a held child writer lease blocks clearance even with a stopped observation', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider({}, 'test') });
  const c = child('worker-2', { supervisorId: worker.id });
  // The parent's own lease is freed so the child can register its overlapping checkout.
  store.releaseWriter(worker.id);
  store.reserveWorker({ ...c, writePaths: [task.project] });
  store.meta('observation:worker-2', { state: 'done', stopped: true });
  assert.equal(store.writerLeases().some(l => l.workerId === 'worker-2'), true, 'the child still holds its lease');
  assert.equal(r.descendantExited(store.worker('worker-2')), false, 'a held child lease is not exit proof');
  const exec = r.executionId(worker);
  const blocked = r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'test', descendants: [] });
  assert.equal(blocked.complete, false);
  assert.equal(blocked.reason, 'registered-child-live');
  assert.deepEqual(blocked.liveChildren, ['worker-2']);
  // Only when the child lease is itself released does the parent clear.
  store.releaseWriter('worker-2');
  assert.equal(r.descendantExited(store.worker('worker-2')), true);
  assert.equal(r.clearance(worker, { coverage: COVERAGE.COMPLETE, executionId: exec, source: 'test', descendants: [] }).complete, true);
});

test('released replay still rejects a different request ID or execution binding', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider() });
  r.request(worker, { requestId: 'stop-A' });
  const first = r.settle({ worker, requestId: 'stop-A', observedExit: { confirmed: true }, evidence: boundComplete(r, worker) });
  assert.equal(first.released, true);
  // Same request, same binding: idempotent no-op (no re-release, no re-journal).
  const replay = r.settle({ worker, requestId: 'stop-A', observedExit: { confirmed: true }, evidence: boundComplete(r, worker) });
  assert.equal(replay.idempotent, true);
  // A different request ID must be refused even though the record is released.
  assert.throws(() => r.settle({ worker, requestId: 'stop-B', observedExit: { confirmed: true } }), /already bound to request stop-A/);
  assert.throws(() => r.request(worker, { requestId: 'stop-B' }), /already bound to request stop-A/);
  // A changed execution binding after release is a conflict, not a silent replay.
  const replaced = { ...worker, launchResult: { pid: 9999 } };
  assert.throws(() => r.settle({ worker: replaced, requestId: 'stop-A', observedExit: { confirmed: true } }), /requires a new retirement/);
  assert.throws(() => r.request(replaced, { requestId: 'stop-A' }), /requires a new retirement/);
});

test('a late closeTask after an open release is refused with no mutation', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider({}, 'test') });
  // First settle releases ownership but deliberately leaves the task open.
  const first = r.settle({ worker, observedExit: { confirmed: true, reason: 'process_finished' }, closeTask: false });
  assert.equal(first.released, true);
  assert.equal(first.state, RETIREMENT.RELEASED);
  assert.equal(store.writerLeases().length, 0, 'ownership was released');
  assert.equal(store.task(task.id).status, 'active', 'the release did not close the task');
  const recordBefore = JSON.stringify(r.record(worker.id));
  const journalBefore = store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n;
  // Asking to close it now is an explicit refusal, not an idempotent success.
  assert.throws(
    () => r.settle({ worker, observedExit: { confirmed: true, reason: 'process_finished' }, closeTask: true }),
    error => error.code === 'retirement-released-without-close' && /without closing task task-1/.test(error.message),
  );
  // Nothing moved: task, lease, record and journal are all unchanged.
  assert.equal(store.task(task.id).status, 'active', 'task must not be silently closed');
  assert.equal(store.writerLeases().length, 0, 'no re-release or new lease');
  assert.equal(JSON.stringify(r.record(worker.id)), recordBefore, 'retirement record unchanged');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, journalBefore, 'no re-journal');
});

test('replaying a release that already closed the task stays idempotent', async t => {
  const store = await fixture(t);
  const r = new Retirement(store, { provider: provider({}, 'test') });
  const first = r.settle({ worker, observedExit: { confirmed: true, reason: 'process_finished' }, closeTask: true });
  assert.equal(first.released, true);
  assert.equal(store.task(task.id).status, 'closed');
  const journalAfterFirst = store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n;
  // A genuine replay against the already-closed task is still a clean no-op.
  const replay = r.settle({ worker, observedExit: { confirmed: true, reason: 'process_finished' }, closeTask: true });
  assert.equal(replay.released, true);
  assert.equal(replay.idempotent, true);
  assert.equal(store.task(task.id).status, 'closed');
  assert.equal(store.writerLeases().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, journalAfterFirst, 'replay does not re-journal');
});
