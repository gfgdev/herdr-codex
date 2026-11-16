import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Requests } from '../src/requests.mjs';
import { Delegation } from '../src/delegation.mjs';
import { Retirement, COVERAGE } from '../src/retirement.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const task = { id: 'task-1', name: 'Requests/Delegation retirement fixture', project: '/private/project', threadId: THREAD, status: 'active' };
const worker = { id: 'worker-1', taskId: task.id, name: 'pi-work', role: 'pi', project: task.project,
  terminalId: 't7', mailbox: 'cx-worker-1', writePaths: [task.project],
  launchState: 'started', launchResult: { pid: 4242 }, launchIdentity: { created_ms: 1 } };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-req-ret-'));
  const store = new Store(join(dir, 'manager.sqlite'));
  store.saveTask(task);
  store.reserveWorker({ ...worker });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return store;
}
const leases = (store, id) => store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id=?').get(id).n;
const retirementState = (store, id) => store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get(id)?.state;
// The finished terminal matches the ORIGINAL frozen identity, so the stop is
// truthfully confirmed without a signal.
const finishedNative = () => ({ state: 'finished', address: worker.terminalId, cwd: task.project,
  labels: { 'codex.worker': worker.id, 'codex.task': task.id }, machine: null, pid: 4242, created_ms: 1, argv: [] });

test('Requests defaults to a conservative retirement: omission cannot raw-release the lease', async t => {
  const store = await fixture(t);
  const requests = new Requests(store); // no retirement injected
  requests.reserve(worker, 'stop-1', 'stop', {});
  requests.settleStop(worker.id, 'stop-1', { confirmed: true, reason: 'process_finished', observedBy: 'test' });
  assert.equal(leases(store, worker.id), 1, 'a bare Requests must retain writer ownership, not raw-release it');
  assert.equal(retirementState(store, worker.id), 'pending_retirement');
  assert.equal(store.meta('stop:' + worker.id).state, 'confirmed', 'the native stop itself is still recorded');
});

test('Delegation.stop shares the conservative default and retains ownership', async t => {
  const store = await fixture(t);
  const rpc = { request: async method => { if (method !== 'terminal.get') throw new Error('unexpected rpc ' + method); return finishedNative(); } };
  const delegation = new Delegation({ config: {}, store, rpc });
  await delegation.stop(worker.id, 'stop-1');
  assert.equal(store.meta('stop:' + worker.id).state, 'confirmed');
  assert.equal(leases(store, worker.id), 1, 'the shared retirement must retain writer ownership');
  assert.equal(retirementState(store, worker.id), 'pending_retirement');
});

test('an injected verified provider releases ownership once, and Requests reuses that same retirement', async t => {
  const store = await fixture(t);
  // Trust anchor is the injected function bound to the EXACT execution; the
  // shared instance is handed to Requests so the request layer cannot disagree.
  const provider = ({ executionId }) => ({ coverage: COVERAGE.COMPLETE, executionId, source: 'manager-observation', descendants: [] });
  provider.source = 'manager-observation';
  const retirement = new Retirement(store, { provider });
  const requests = new Requests(store, { retirement });
  assert.equal(requests.retirement, retirement, 'Requests must reuse the resolved retirement');
  requests.reserve(worker, 'stop-1', 'stop', {});
  requests.settleStop(worker.id, 'stop-1', { confirmed: true, reason: 'process_finished', observedBy: 'test' });
  assert.equal(leases(store, worker.id), 0, 'a trusted, execution-bound complete verdict releases ownership');
  assert.equal(retirementState(store, worker.id), 'released');
});
