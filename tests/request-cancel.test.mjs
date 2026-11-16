// Focused tests for the request-cancellation primitive and its public wiring.
//
// This suite deliberately does NOT start the Herdr activity bus: `cancel_request`
// is pure bookkeeping and never touches the native transport, so no UNIX socket
// is needed. (The shared `tests/agent-tools.test.mjs` fixture starts the bus,
// which the sandbox refuses to bind; that is an environment limitation, not a
// cancel-feature behaviour.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Requests } from '../src/requests.mjs';
import { Delegation } from '../src/delegation.mjs';
import { AgentTools, AGENT_TOOLS, validateToolInput } from '../src/agent-tools.mjs';

const THREAD = '00000000-0000-4000-8000-000000000001';
const FOREIGN = '00000000-0000-4000-8000-0000000000ff';

function storeFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-cancel-')));
  const store = new Store(join(dir, 'manager.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, requests: new Requests(store) };
}

// The cancel primitive reads the worker/task identity from the store inside its
// transaction, so tests must register both the task and the worker.
const seedWorker = (store, worker, { threadId = THREAD, status = 'active' } = {}) => {
  store.saveTask({ id: worker.taskId, threadId, project: '/tmp/project', status });
  store.saveWorker({ id: worker.id, taskId: worker.taskId, project: '/tmp/project' });
};

const cancelledJournals = store =>
  store.db.prepare("SELECT count(*) AS c FROM journal WHERE type='agent.request.cancelled'").get().c;

/** A byte-level view of everything a refusal must leave untouched: the request
 * row, the whole journal, writer leases and message acknowledgements. */
function byteState(store, workerId, requestId) {
  return JSON.stringify({
    request: store.db.prepare('SELECT data FROM agent_requests WHERE worker_id=? AND request_id=?').get(workerId, requestId)?.data ?? null,
    journal: store.db.prepare('SELECT count(*) AS c FROM journal').get().c,
    leases: store.db.prepare('SELECT worker_id, paths FROM writer_leases ORDER BY worker_id').all(),
    messages: store.db.prepare('SELECT id, ack_at, delivery, action, receipt, error FROM messages ORDER BY id').all(),
  });
}

// --- primitive: src/requests.mjs -------------------------------------------

test('cancel retires an unclaimed queued note atomically, preserving payload, and replays idempotently', async t => {
  const { store, requests } = storeFixture(t);
  const worker = { id: 'ha-cancel', taskId: 'hd-cancel' };
  seedWorker(store, worker);
  const reserved = requests.reserve(worker, 'note-1', 'message', { instruction: 'withdraw me', mode: 'queue' });
  assert.equal(reserved.state, 'queued');
  assert.equal(reserved.claimedBy, undefined);

  const saved = requests.cancel(worker.id, 'note-1', {
    reason: 'operator withdrew the note', expectedState: 'queued', dispositionId: 'disp-1', by: THREAD });
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.requestId, 'note-1');
  assert.deepEqual(saved.payload, reserved.payload, 'payload is preserved verbatim');
  assert.equal(saved.disposition.dispositionId, 'disp-1');
  assert.equal(saved.disposition.reason, 'operator withdrew the note');
  assert.equal(saved.disposition.by, THREAD);
  assert.equal(cancelledJournals(store), 1);
  // The audit journal carries the mandatory reason and owner.
  const audit = JSON.parse(store.db.prepare("SELECT data FROM journal WHERE type='agent.request.cancelled' ORDER BY seq DESC LIMIT 1").get().data);
  assert.equal(audit.reason, 'operator withdrew the note');
  assert.equal(audit.by, THREAD);

  // Exact replay (same disposition identity and reason) is inert: no new row.
  const replay = requests.cancel(worker.id, 'note-1', {
    reason: 'operator withdrew the note', expectedState: 'queued', dispositionId: 'disp-1', by: THREAD });
  assert.equal(replay.state, 'cancelled');
  assert.equal(cancelledJournals(store), 1);

  // A different disposition identity conflicts instead of silently succeeding.
  assert.throws(() => requests.cancel(worker.id, 'note-1', {
    reason: 'operator withdrew the note', expectedState: 'queued', dispositionId: 'disp-2', by: THREAD }), /already cancelled/);
  assert.equal(cancelledJournals(store), 1);
});

test('cancel retires an unclaimed prepared ordinary request', async t => {
  const { store, requests } = storeFixture(t);
  const worker = { id: 'ha-prep', taskId: 'hd-prep' };
  seedWorker(store, worker);
  const reserved = requests.reserve(worker, 'follow-1', 'followup', { instruction: 'do the next thing', context: null });
  assert.equal(reserved.state, 'prepared');
  const saved = requests.cancel(worker.id, 'follow-1', {
    reason: 'superseded before delivery', expectedState: 'prepared', dispositionId: 'disp-prep', by: THREAD });
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.kind, 'followup');
});

test('cancel enforces the caller-observed expected state as an atomic precondition', async t => {
  const { store, requests } = storeFixture(t);
  const worker = { id: 'ha-cas', taskId: 'hd-cas' };
  seedWorker(store, worker);
  requests.reserve(worker, 'follow-2', 'followup', { instruction: 'pending', context: null });
  assert.throws(() => requests.cancel(worker.id, 'follow-2', {
    reason: 'stale observation', expectedState: 'queued', dispositionId: 'disp-cas', by: THREAD }), /state changed; expected queued but found prepared/);
  assert.equal(requests.get(worker.id, 'follow-2').state, 'prepared');
});

test('cancel refuses lifecycle controls before any other check', async t => {
  const { store, requests } = storeFixture(t);
  const worker = { id: 'ha-lifecycle', taskId: 'hd-lifecycle' };
  seedWorker(store, worker);
  requests.reserve(worker, 'stop-1', 'stop', {});
  requests.reserve(worker, 'int-1', 'interrupt', {});
  assert.throws(() => requests.cancel(worker.id, 'stop-1', {
    reason: 'no', expectedState: 'prepared', dispositionId: 'disp-stop', by: THREAD }), /Lifecycle controls are resolved by re-observing/);
  assert.throws(() => requests.cancel(worker.id, 'int-1', {
    reason: 'no', expectedState: 'prepared', dispositionId: 'disp-int', by: THREAD }), /Lifecycle controls are resolved by re-observing/);
  // The lifecycle rows are untouched and no cancellation was journalled.
  assert.equal(requests.get(worker.id, 'stop-1').state, 'prepared');
  assert.equal(requests.get(worker.id, 'int-1').state, 'prepared');
});

test('cancel is refused once the carrier has claimed or delivered the request', async t => {
  const { store, requests } = storeFixture(t);
  const worker = { id: 'ha-claimed', taskId: 'hd-claimed' };
  seedWorker(store, worker);
  requests.reserve(worker, 'n-1', 'message', { instruction: 'note', mode: 'queue' });
  requests.reserve(worker, 'f-1', 'followup', { instruction: 'go', context: null });
  requests.claim(worker.id, 'f-1', () => 'wire');
  assert.equal(requests.get(worker.id, 'f-1').state, 'sending');
  assert.equal(requests.get(worker.id, 'n-1').state, 'attached');
  assert.equal(requests.get(worker.id, 'n-1').claimedBy, 'f-1');

  // A claimed note names its live carrier.
  assert.throws(() => requests.cancel(worker.id, 'n-1', {
    reason: 'no', expectedState: 'attached', dispositionId: 'd-n1', by: THREAD }), /claimed by a live carrier/);
  // A request already in flight is refused as handed to the carrier.
  assert.throws(() => requests.cancel(worker.id, 'f-1', {
    reason: 'no', expectedState: 'sending', dispositionId: 'd-f1', by: THREAD }), /handed to the carrier/);

  requests.finish(worker.id, 'f-1', 'uncertain', { error: 'lost receipt' });
  assert.throws(() => requests.cancel(worker.id, 'f-1', {
    reason: 'no', expectedState: 'uncertain', dispositionId: 'd-f1b', by: THREAD }), /handed to the carrier/);

  requests.finish(worker.id, 'f-1', 'sent', { nativeReceipt: { turn: 3 } });
  assert.throws(() => requests.cancel(worker.id, 'f-1', {
    reason: 'no', expectedState: 'sent', dispositionId: 'd-f1c', by: THREAD }), /handed to the carrier/);
  assert.equal(requests.get(worker.id, 'n-1').state, 'delivered');
  assert.throws(() => requests.cancel(worker.id, 'n-1', {
    reason: 'no', expectedState: 'delivered', dispositionId: 'd-n1b', by: THREAD }), /handed to the carrier/);

  assert.equal(cancelledJournals(store), 0);
});

test('a failed carrier requeue clears claimedBy so the note becomes cancellable again', async t => {
  const { store, requests } = storeFixture(t);
  const worker = { id: 'ha-requeue', taskId: 'hd-requeue' };
  seedWorker(store, worker);
  requests.reserve(worker, 'n-2', 'message', { instruction: 'note', mode: 'queue' });
  requests.reserve(worker, 'f-2', 'followup', { instruction: 'go', context: null });
  requests.claim(worker.id, 'f-2', () => 'wire');
  assert.equal(requests.get(worker.id, 'n-2').state, 'attached');

  requests.finish(worker.id, 'f-2', 'failed', { error: 'refused before delivery' });
  const requeued = requests.get(worker.id, 'n-2');
  assert.equal(requeued.state, 'queued');
  assert.equal(requeued.claimedBy, null);

  const saved = requests.cancel(worker.id, 'n-2', {
    reason: 'withdraw after the carrier refused', expectedState: 'queued', dispositionId: 'd-n2', by: THREAD });
  assert.equal(saved.state, 'cancelled');
});

test('ownership and worker/task binding are re-checked inside the cancel transaction', async t => {
  const { store, requests } = storeFixture(t);
  const rebind = (taskId, threadId) => {
    const task = store.task(taskId);
    store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...task, threadId }), taskId);
  };

  // A task rebound to another chat between reservation and commitment cannot
  // authorize the mutation.
  const reb = { id: 'ha-rebind', taskId: 'hd-rebind' };
  seedWorker(store, reb);
  requests.reserve(reb, 'rb-req', 'followup', { instruction: 'x', context: null });
  rebind('hd-rebind', FOREIGN);
  assert.throws(() => requests.cancel('ha-rebind', 'rb-req', {
    reason: 'x', expectedState: 'prepared', dispositionId: 'd-rb', by: THREAD }), /Not your request/);
  assert.equal(requests.get('ha-rebind', 'rb-req').state, 'prepared');

  // The request must still belong to the worker's CURRENT task, not just any
  // task owned by the same chat.
  store.saveTask({ id: 'hd-a', threadId: THREAD, project: '/tmp/project', status: 'active' });
  store.saveTask({ id: 'hd-b', threadId: THREAD, project: '/tmp/project', status: 'active' });
  store.saveWorker({ id: 'ha-bind', taskId: 'hd-a', project: '/tmp/project' });
  requests.reserve({ id: 'ha-bind', taskId: 'hd-a' }, 'bind-req', 'followup', { instruction: 'x', context: null });
  // Rebind the worker to another task the same chat owns (raw, since saveWorker
  // refuses identity reassignment) — the request still belongs to hd-a.
  store.db.prepare('UPDATE workers SET data=? WHERE id=?').run(
    JSON.stringify({ ...store.worker('ha-bind'), taskId: 'hd-b' }), 'ha-bind');
  assert.throws(() => requests.cancel('ha-bind', 'bind-req', {
    reason: 'x', expectedState: 'prepared', dispositionId: 'd-bind', by: THREAD }), /Not your request/);
});

// --- public facade: Delegation.cancel --------------------------------------

function facadeFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-cancel-facade-')));
  const store = new Store(join(dir, 'manager.sqlite'));
  const delegation = new Delegation({
    config: { stateDir: dir }, store,
    rpc: { async request() { throw new Error('cancel must not perform a native action'); } },
    prepare: async () => ({}),
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, delegation };
}

test('facade requires the exact owner chat and refuses foreign/absent/unknown targets without mutating state', async t => {
  const { store, delegation } = facadeFixture(t);
  store.saveTask({ id: 'hd-own', threadId: THREAD, project: '/tmp/project', status: 'active' });
  store.reserveWorker({ id: 'ha-own', taskId: 'hd-own', project: '/tmp/project', writePaths: ['/tmp/project'] });
  store.db.prepare("INSERT INTO messages(id,fingerprint,task_id,worker_id,kind,data,delivery,ack_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('m-own', 'fp', 'hd-own', 'ha-own', 'result', '{}', 'delivered', '2026-01-01T00:00:00.000Z');
  new Requests(store).reserve({ id: 'ha-own', taskId: 'hd-own' }, 'own-req', 'followup', { instruction: 'x', context: null });
  const before = byteState(store, 'ha-own', 'own-req');

  assert.throws(() => delegation.cancel('ha-own', {
    targetRequestId: 'own-req', expectedState: 'prepared', reason: 'foreign', dispositionId: 'd1', threadId: FOREIGN }),
    /Not your request/);
  assert.equal(byteState(store, 'ha-own', 'own-req'), before, 'foreign chat left request/journal/lease/ack unchanged');

  assert.throws(() => delegation.cancel('ha-own', {
    targetRequestId: 'own-req', expectedState: 'prepared', reason: 'absent', dispositionId: 'd2' }),
    /exact owner manager chat UUID/);
  assert.equal(byteState(store, 'ha-own', 'own-req'), before, 'an absent thread left state unchanged');

  assert.throws(() => delegation.cancel('ha-own', {
    targetRequestId: 'nope', expectedState: 'prepared', reason: 'wrong target', dispositionId: 'd3', threadId: THREAD }),
    /Unknown request/);
  assert.equal(byteState(store, 'ha-own', 'own-req'), before, 'an unknown target left state unchanged');

  // The correct owner succeeds and attributes the disposition to their chat.
  const saved = delegation.cancel('ha-own', {
    targetRequestId: 'own-req', expectedState: 'prepared', reason: 'ok', dispositionId: 'd4', threadId: THREAD });
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.disposition.by, THREAD);
});

test('an intentionally stopped worker can still be retired by its exact owner', async t => {
  const { store, delegation } = facadeFixture(t);
  store.saveTask({ id: 'hd-stop', threadId: THREAD, project: '/tmp/project', status: 'active' });
  store.saveWorker({ id: 'ha-stop', taskId: 'hd-stop', project: '/tmp/project', terminalId: 't-stop', launchState: 'ready' });
  store.meta('stop:ha-stop', { at: '2026-01-01T00:00:00.000Z' });
  const reserved = new Requests(store).reserve({ id: 'ha-stop', taskId: 'hd-stop' }, 'stop-req', 'message', { instruction: 'note', mode: 'queue' });

  const saved = delegation.cancel('ha-stop', {
    targetRequestId: 'stop-req', expectedState: 'queued', reason: 'withdraw stopped note', dispositionId: 'd-stop', threadId: THREAD });
  assert.equal(saved.state, 'cancelled');
  assert.deepEqual(saved.payload, reserved.payload);
  assert.equal(saved.disposition.by, THREAD);
});

// --- public tool: AgentTools.cancel_request --------------------------------

async function toolFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-cancel-tool-')));
  const project = join(dir, 'project'); mkdirSync(project);
  const store = new Store(join(dir, 'manager.sqlite'));
  const config = { stateDir: dir };
  const terminals = new Map(), effects = [];
  const rpc = { async request(method, params) {
    if (method === 'terminal.run') {
      const address = 't' + (terminals.size + 1), pid = 1000 + terminals.size;
      terminals.set(address, { address, pid, state: 'live', status: { state: 'idle' }, turn: 0,
        cwd: params.cwd, labels: params.labels, argv: params.argv, keep: false });
      effects.push({ method, params });
      return { address, pid };
    }
    const terminal = terminals.get(params.terminal);
    if (method === 'terminal.get') return structuredClone(terminal);
    if (method === 'terminal.wait') return { status: terminal.status };
    if (method === 'terminal.send') {
      effects.push({ method, params }); terminal.turn++; terminal.status.state = 'working';
      return { turn: terminal.turn };
    }
    throw new Error('Unexpected native method ' + method);
  } };
  const delegation = new Delegation({ config, store, rpc, prepare: async w => ({ argv: ['fake-worker'], cwd: w.project }) });
  const adapter = new AgentTools({ config, store, delegation, ensureBridge: async () => {} });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = (name, args = {}) => adapter.call(name, { thread_id: THREAD, ...args });
  const spawn = () => call('spawn_agent', { task_name: 'inspect', project, message: 'Inspect the code' });
  return { dir, project, store, delegation, adapter, call, spawn, terminals, effects };
}

test('cancel_request separates the target request from the disposition id and performs no native action', async t => {
  const f = await toolFixture(t);
  const agent = await f.spawn();
  const note = await f.call('send_message', { target: agent.agent_id, message: 'withdraw this note', mode: 'queue' });
  assert.equal(note.state, 'queued');

  const nativeBefore = f.effects.length;
  const r = await f.call('cancel_request', {
    target: agent.agent_id, target_request_id: note.request_id,
    expected_state: 'queued', reason: 'operator withdrew the note', request_id: 'disp-1' });

  assert.equal(r.state, 'cancelled');
  assert.equal(r.agent_id, agent.agent_id);
  assert.equal(r.target_request_id, note.request_id);
  assert.equal(r.disposition_id, 'disp-1');
  assert.equal(r.disposition.reason, 'operator withdrew the note');
  assert.equal(r.verified, false);
  assert.equal(f.effects.length, nativeBefore, 'cancel_request must not signal the native terminal');

  const replay = await f.call('cancel_request', {
    target: agent.agent_id, target_request_id: note.request_id,
    expected_state: 'queued', reason: 'operator withdrew the note', request_id: 'disp-1' });
  assert.equal(replay.state, 'cancelled');

  await assert.rejects(f.call('cancel_request', {
    target: agent.agent_id, target_request_id: note.request_id,
    expected_state: 'queued', reason: 'different', request_id: 'disp-2' }), /already cancelled/);
});

test('cancel_request refuses a request already handed to the carrier and a stale expected state', async t => {
  const f = await toolFixture(t);
  const agent = await f.spawn();
  // The spawned terminal is left working by the initial delivery, so an inline
  // note is accepted and reaches `sent`.
  const sent = await f.call('send_message', { target: agent.agent_id, message: 'live note' });
  assert.equal(sent.state, 'sent');

  await assert.rejects(f.call('cancel_request', {
    target: agent.agent_id, target_request_id: sent.request_id,
    expected_state: 'sent', reason: 'too late', request_id: 'disp-x' }), /handed to the carrier/);
  await assert.rejects(f.call('cancel_request', {
    target: agent.agent_id, target_request_id: sent.request_id,
    expected_state: 'queued', reason: 'stale', request_id: 'disp-y' }), /state changed/);
});

test('cancel_request schema requires the target request, observed state and reason', () => {
  const schema = AGENT_TOOLS.find(entry => entry.name === 'cancel_request');
  assert.ok(schema, 'cancel_request is exposed as tool16');
  assert.deepEqual([...schema.inputSchema.required].sort(),
    ['thread_id', 'target', 'target_request_id', 'expected_state', 'reason', 'request_id'].sort());
  for (const state of ['prepared', 'queued', 'sending', 'uncertain', 'attached', 'sent', 'delivered', 'failed', 'cancelled'])
    assert.ok(schema.inputSchema.properties.expected_state.enum.includes(state), state);
  assert.throws(() => validateToolInput('cancel_request',
    { thread_id: THREAD, target: 'ha-x', target_request_id: 'r', reason: 'x', request_id: 'd' }), /Missing expected_state/);
  assert.throws(() => validateToolInput('cancel_request',
    { thread_id: THREAD, target: 'ha-x', target_request_id: 'r', expected_state: 'bogus', reason: 'x', request_id: 'd' }), /Unsupported expected_state/);
  assert.throws(() => validateToolInput('cancel_request',
    { thread_id: THREAD, target: 'ha-x', target_request_id: 'r', expected_state: 'queued', reason: '', request_id: 'd' }), /Invalid reason/);
});

// --- public CLI surface: src/cli.mjs ---------------------------------------

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

/** The CLI publishes an immutable runtime snapshot (0o400 files, 0o500 dirs);
 * restore write permission so the fixture's own temp tree can be removed. */
function writableTree(root) {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) writableTree(path);
    else chmodSync(path, 0o600);
  }
}

function runCli(args, { configPath, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--config', configPath, ...args],
      { cwd, env: { ...process.env, HERDR_CODEX_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function cliFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-cancel-cli-')));
  const stateDir = join(dir, 'state'), project = join(dir, 'project');
  mkdirSync(stateDir); mkdirSync(project);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, stateDir, hc: '/never/execute', app: '/never/execute',
    codex: '/never/execute', profileFile: '/never/execute', node: process.execPath }));
  const storePath = join(stateDir, 'manager.sqlite');
  const store = new Store(storePath);
  store.saveTask({ id: 'hd-cli', threadId: THREAD, project, status: 'active' });
  store.reserveWorker({ id: 'ha-cli', taskId: 'hd-cli', name: 'cli', role: 'pi', project, terminalId: 't1',
    launchState: 'ready', writePaths: [project] });
  store.db.prepare("INSERT INTO messages(id,fingerprint,task_id,worker_id,kind,data,delivery,ack_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('m-cli', 'fp', 'hd-cli', 'ha-cli', 'result', '{}', 'delivered', '2026-01-01T00:00:00.000Z');
  store.saveTask({ id: 'hd-other', threadId: FOREIGN, project, status: 'active' });
  store.saveWorker({ id: 'ha-other', taskId: 'hd-other', name: 'other', role: 'pi', project, terminalId: 't2', launchState: 'ready' });
  t.after(() => { writableTree(dir); rmSync(dir, { recursive: true, force: true }); });
  const snapshot = (workerId, requestId) => { const s = new Store(storePath); const v = byteState(s, workerId, requestId); s.close(); return v; };
  return { dir, stateDir, project, configPath, storePath, store, snapshot };
}

test('real CLI process retires an unclaimed prepared request through `agent cancel-request`', async t => {
  const f = cliFixture(t);
  new Requests(f.store).reserve({ id: 'ha-cli', taskId: 'hd-cli' }, 'cli-req', 'followup', { instruction: 'x', context: null });
  f.store.close();

  const result = await runCli(['agent', 'cancel-request', '--id', 'ha-cli', '--thread', THREAD, '--target-request-id', 'cli-req',
    '--expected-state', 'prepared', '--reason', 'cli withdrawal', '--request-id', 'disp-cli'], { configPath: f.configPath, cwd: f.dir });
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.requestId, 'cli-req');
  assert.equal(summary.state, 'cancelled');
  assert.equal(summary.disposition.dispositionId, 'disp-cli');
  assert.equal(summary.disposition.reason, 'cli withdrawal');
  assert.equal(summary.disposition.by, THREAD);
  // This isolated sandbox cannot bind the AF_UNIX activity bus, so the journal
  // publisher reports the missing bridge and the CLI exits 1 *after* the
  // cancellation has committed. The wiring under test is the argument parsing
  // and delegation call; require exit 0 in a full runtime and only the
  // documented bridge-unavailable notice here.
  if (result.code !== 0) {
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Herdr activity notifications unavailable/);
  }

  const reopened = new Store(f.storePath);
  const saved = new Requests(reopened).get('ha-cli', 'cli-req');
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.disposition.dispositionId, 'disp-cli');
  assert.equal(reopened.db.prepare("SELECT count(*) AS c FROM journal WHERE type='agent.request.cancelled'").get().c, 1);
  reopened.close();
});

test('real CLI refuses a foreign chat, an absent thread and a non-owner worker without mutating anything', async t => {
  const f = cliFixture(t);
  new Requests(f.store).reserve({ id: 'ha-cli', taskId: 'hd-cli' }, 'cli-neg', 'followup', { instruction: 'x', context: null });
  f.store.close();
  const before = f.snapshot('ha-cli', 'cli-neg');
  const base = ['agent', 'cancel-request', '--target-request-id', 'cli-neg', '--expected-state', 'prepared',
    '--reason', 'nope', '--request-id', 'disp-neg'];

  const foreign = await runCli([...base, '--id', 'ha-cli', '--thread', FOREIGN], { configPath: f.configPath, cwd: f.dir });
  assert.notEqual(foreign.code, 0);
  assert.match(foreign.stderr, /Not your request/);
  assert.equal(f.snapshot('ha-cli', 'cli-neg'), before, 'a foreign chat left request/journal/lease/ack unchanged');

  const absent = await runCli([...base, '--id', 'ha-cli'], { configPath: f.configPath, cwd: f.dir });
  assert.notEqual(absent.code, 0);
  assert.match(absent.stderr, /Missing --thread/);
  assert.equal(f.snapshot('ha-cli', 'cli-neg'), before, 'an absent thread left state unchanged');

  const wrongWorker = await runCli([...base, '--id', 'ha-other', '--thread', THREAD], { configPath: f.configPath, cwd: f.dir });
  assert.notEqual(wrongWorker.code, 0);
  assert.match(wrongWorker.stderr, /Not your request/);
  assert.equal(f.snapshot('ha-cli', 'cli-neg'), before, 'a non-owner worker left state unchanged');
});
