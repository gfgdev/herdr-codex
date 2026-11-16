import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTools, AGENT_TOOLS } from '../src/agent-tools.mjs';
import { Delegation } from '../src/delegation.mjs';
import { Store } from '../src/store.mjs';
import { Notifications } from '../src/notifications.mjs';
import { Retirement } from '../src/retirement.mjs';

const THREAD = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const EMPTY = '00000000-0000-4000-8000-000000000099';

async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-status-')));
  const project = join(dir, 'project'); mkdirSync(project);
  const path = join(dir, 'manager.sqlite');
  const store = new Store(path);
  const config = { stateDir: dir }, terminals = new Map(), effects = [];
  const rpc = { loseSend: false, async request(method, params) {
    if (method === 'terminal.run') {
      const address = 't' + (terminals.size + 1), pid = terminals.size + 1000;
      terminals.set(address, { address, pid, state: 'live', status: { state: 'idle' }, turn: 0, cwd: params.cwd, labels: params.labels, argv: params.argv, keep: false });
      effects.push({ method, params });
      return { address, pid };
    }
    const terminal = terminals.get(params.terminal);
    if (method === 'terminal.get') return structuredClone(terminal);
    if (method === 'terminal.wait') return { status: terminal.status };
    if (method === 'terminal.read') return 'actual terminal text';
    if (method === 'terminal.send') {
      effects.push({ method, params }); terminal.turn++; terminal.status.state = 'working';
      if (this.loseSend) { this.loseSend = false; throw new Error('Lost send receipt'); }
      return { turn: terminal.turn };
    }
    if (method === 'terminal.interrupt') { effects.push({ method, params }); terminal.status.state = 'done'; return { turn: terminal.turn, status: terminal.status }; }
    if (method === 'terminal.kill') { effects.push({ method, params }); terminal.state = 'finished'; terminal.exit_code = 0; terminal.status.state = 'done'; return { killed: true, exit_code: 0 }; }
    throw new Error('Unexpected native method ' + method);
  } };
  // The fixture verifier is the trust anchor: it returns `complete` only for an
  // execution the manager has independently attested out-of-band, and `unknown`
  // otherwise. A caller copying the source label therefore cannot release.
  const attested = new Set();
  const verifyContainment = ({ executionId }) => attested.has(executionId)
    ? { coverage: 'complete', executionId, source: 'fixture-containment', descendants: [] }
    : { coverage: 'unknown', source: 'fixture-containment' };
  const retirement = new Retirement(store, { provider: verifyContainment, trustedSources: ['fixture-containment'] });
  const delegation = new Delegation({ config, store, rpc, prepare: async w => ({ argv: ['fake-worker'], cwd: w.project }), retirement });
  const notices = new Notifications({ config, store });
  const resolveMessage = async (m, action) => { store.recordAction(m.id, action); return store.ack(m.id); };
  const adapter = new AgentTools({ config, store, delegation, notices, ensureBridge: async () => {}, resolveMessage, flush: async () => {} });
  const call = (name, args = {}, options) => adapter.call(name, { thread_id: THREAD, ...args }, options);
  const spawn = (extra = {}) => call('spawn_agent', { task_name: 'inspect', project, message: 'Inspect the code', ...extra });
  const report = (worker, id = 'report-1', kind = 'result') => store.ingest(worker, { id, taskId: worker.taskId, workerId: worker.id, terminalId: worker.terminalId, kind, text: 'Evidence from worker', createdAt: new Date().toISOString(), turn: 1 }, { lifecycle: true });
  const closeTask = taskId => store.saveTask({ ...store.task(taskId), status: 'closed', closedAt: new Date().toISOString() });
  const lease = (workerId, paths) => store.db.prepare('INSERT INTO writer_leases VALUES(?,?)').run(workerId, JSON.stringify(paths));
  // Explicit manager reconciliation with a trusted, execution-bound complete
  // clearance is the ONLY thing that releases a stopped worker's ownership.
  const release = (worker, requestId) => { const executionId = retirement.executionId(worker);
    attested.add(executionId); // the manager's independent verification of this exact execution
    return retirement.reconcile({ threadId: THREAD, workerId: worker.id, executionId, requestId,
      evidence: { coverage: 'complete', source: 'fixture-containment', reference: 'fixture-review', descendants: [], executionId } }); };
  t.after(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { call, spawn, adapter, store, notices, delegation, retirement, release, terminals, rpc, effects, report, project, closeTask, lease };
}

test('get_job_status schema is canonical snake_case and strictly read-only', async t => {
  const tool = AGENT_TOOLS.find(t => t.name === 'get_job_status');
  assert.ok(tool, 'get_job_status must be registered');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['thread_id', 'target']);
  assert.deepEqual(tool.inputSchema.required, ['thread_id']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.ok(!Object.keys(tool.inputSchema.properties).some(k => /[A-Z]/.test(k)), 'schema must not expose camelCase mirrors');
});

test('an idle agent with no accepted report is waiting_on_agents, never done', async t => {
  const f = await fixture(t), agent = await f.spawn();
  f.terminals.get(agent.terminal_id).status.state = 'idle';
  const nativeEffects = f.effects.filter(e => ['terminal.send', 'terminal.kill', 'terminal.interrupt'].includes(e.method)).length;
  const status = await f.call('get_job_status');
  assert.equal(status.job.state, 'waiting_on_agents');
  assert.equal(status.job.next_actor, 'agent');
  assert.equal(status.job.agent_count, 1);
  const one = status.agents[0];
  assert.equal(one.agent_id, agent.agent_id);
  assert.equal(one.task_status, 'active');
  assert.equal(one.review.accepted, false);
  assert.equal(one.native.state, 'idle');
  assert.equal(one.native.freshness, 'fresh');
  assert.equal(one.native.source, 'live');
  assert.notEqual(status.job.state, 'done');
  // A read-only status call must not touch the native process or mutate state.
  assert.equal(f.effects.filter(e => ['terminal.send', 'terminal.kill', 'terminal.interrupt'].includes(e.method)).length, nativeEffects);
});

test('an accepted report with a live or leased worker is not done', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  f.terminals.get(agent.terminal_id).status.state = 'idle';
  f.report(worker);
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Reviewed the evidence' });
  f.closeTask(worker.taskId);
  // (a) accepted + closed, worker still live and idle, no writer lease.
  const idle = await f.call('get_job_status');
  assert.equal(idle.agents[0].review.accepted, true);
  assert.equal(idle.agents[0].task_status, 'closed');
  assert.equal(idle.agents[0].ownership.writer, false);
  assert.notEqual(idle.job.state, 'done');
  // Accepted-but-not-retired is routine manager bookkeeping, not a user decision.
  assert.equal(idle.job.state, 'reviewing');
  assert.equal(idle.job.next_actor, 'manager');
  // (b) a retained writer lease keeps it out of done even while idle.
  f.lease(worker.id, [f.project]);
  const leased = await f.call('get_job_status');
  assert.equal(leased.agents[0].ownership.writer, true);
  assert.equal(leased.agents[0].ownership.path_count, 1);
  assert.equal(leased.job.state, 'reviewing');
  assert.equal(leased.job.next_actor, 'manager');
  assert.notEqual(leased.job.state, 'done');
  // (c) a still-working process is reported as working, not done.
  f.store.db.prepare('DELETE FROM writer_leases').run();
  f.terminals.get(agent.terminal_id).status.state = 'working';
  const working = await f.call('get_job_status');
  assert.equal(working.job.state, 'working');
});

test('an unacknowledged stop notice keeps a stopped, closed job out of done', async t => {
  const f = await fixture(t), agent = await f.spawn({ template: 'implementer' });
  const worker = f.store.worker(agent.agent_id);
  f.report(worker);
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Accepted after inspecting evidence' });
  await f.call('stop_agent', { target: agent.agent_id, request_id: 'stop-blocked' });
  f.closeTask(worker.taskId);
  const blocked = await f.call('get_job_status');
  assert.notEqual(blocked.job.state, 'done');
  // A routine lifecycle notice is manager bookkeeping, not a user escalation.
  assert.equal(blocked.job.state, 'reviewing');
  assert.equal(blocked.job.next_actor, 'manager');
  assert.equal(blocked.agents[0].messages.pending_count, 1, 'the stop notice is still pending');
  assert.match(blocked.job.reason, /lifecycle notice/);
  // Resolving the notice is what lets the terminal state be reached.
  const [notice] = f.store.messages({ taskId: worker.taskId }).filter(m => m.kind === 'attention');
  await f.call('resolve_message', { message_id: notice.id, action: 'accept', text: 'Resolved lifecycle notice' });
  // Resolving the notice is necessary but not sufficient: the native exit is
  // confirmed, yet writer ownership is retained as `pending_retirement` until
  // the manager reconciles complete descendant clearance (a separate fact).
  const held = await f.call('get_job_status');
  assert.equal(held.agents[0].retirement.state, 'pending_retirement');
  assert.notEqual(held.job.state, 'done');
  f.release(worker, 'stop-blocked');
  const cleared = await f.call('get_job_status');
  assert.equal(cleared.job.state, 'done');
});

test('a queued message obligation keeps a job out of done and is not mutated by the read', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  f.terminals.get(agent.terminal_id).status.state = 'idle';
  f.report(worker);
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Accepted after inspecting evidence' });
  await f.call('send_message', { target: agent.agent_id, message: 'Queued note for the next turn', mode: 'queue' });
  const status = await f.call('get_job_status');
  assert.notEqual(status.job.state, 'done');
  // Unresolved deliveries are manager reconciliation, not a user decision.
  assert.equal(status.job.state, 'reviewing');
  assert.equal(status.job.next_actor, 'manager');
  assert.ok(status.agents[0].requests.unresolved.some(r => r.state === 'queued' && r.kind === 'message'), 'the queued request is surfaced');
  // A pure read never settles or drops the obligation.
  const still = f.delegation.requests.list(worker.id).find(r => r.kind === 'message');
  assert.equal(still.state, 'queued');
});

test('an aborted report is a review outcome, not cancellation; mixed live agents stay actionable', async t => {
  const f = await fixture(t);
  const first = await f.spawn({ task_name: 'first' });
  const second = await f.spawn({ task_name: 'second' });
  const worker = f.store.worker(first.agent_id);
  f.report(worker, 'report-first');
  await f.call('resolve_message', { message_id: 'report-first', action: 'abort', text: 'Evidence was insufficient' });
  f.terminals.get(first.terminal_id).status.state = 'working';
  f.terminals.get(second.terminal_id).status.state = 'working';
  const status = await f.call('get_job_status');
  assert.notEqual(status.job.state, 'cancelled');
  assert.equal(status.job.counts.cancelled, 0);
  assert.equal(status.job.state, 'working');
  assert.equal(status.job.next_actor, 'agent');
  assert.equal(status.job.counts.working, 2);
  assert.equal(status.agents.find(a => a.agent_id === first.agent_id).review.aborted, true);
});

test('an accepted report on an idle active assignment hands the move to the manager', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  f.report(worker);
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Accepted after inspecting evidence' });
  f.terminals.get(agent.terminal_id).status.state = 'idle';
  const status = await f.call('get_job_status');
  assert.equal(status.agents[0].review.accepted, true);
  assert.equal(status.agents[0].task_status, 'active');
  assert.equal(status.job.state, 'reviewing');
  assert.equal(status.job.next_actor, 'manager');
});

test('a finished process without a report reviews with the manager, never waiting on the agent', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const terminal = f.terminals.get(agent.terminal_id);
  terminal.state = 'finished';
  terminal.status.state = 'done';
  const status = await f.call('get_job_status');
  assert.equal(status.job.state, 'reviewing');
  assert.equal(status.job.next_actor, 'manager');
  assert.notEqual(status.job.next_actor, 'agent');
});

test('a native error status never promises agent self-progress', async t => {
  const f = await fixture(t), agent = await f.spawn();
  // Real Herdr reports a crashed/faulted turn as `error`, not `failed`.
  f.terminals.get(agent.terminal_id).status.state = 'error';
  const status = await f.call('get_job_status');
  assert.notEqual(status.job.state, 'waiting_on_agents');
  assert.notEqual(status.job.next_actor, 'agent');
  assert.equal(status.job.state, 'reviewing');
  assert.equal(status.job.next_actor, 'manager');
  assert.equal(status.agents[0].native.state, 'error');
  assert.match(status.job.reason, /error/);
});

test('a pending uncertain delivery reviews with the manager and surfaces the unresolved request', async t => {
  const f = await fixture(t), agent = await f.spawn();
  f.rpc.loseSend = true;
  await assert.rejects(f.call('followup_task', { target: agent.agent_id, message: 'Continue the work' }), /Lost send/);
  const status = await f.call('get_job_status');
  assert.equal(status.job.state, 'reviewing');
  assert.equal(status.job.next_actor, 'manager');
  assert.equal(status.agents[0].requests.unresolved_count, 1);
  assert.equal(status.agents[0].requests.unresolved[0].state, 'uncertain');
});

test('native unavailable or stale reads are unknown, never fake completion', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  const original = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params) => { if (method === 'terminal.get' && params.terminal === agent.terminal_id) throw new Error('native transport down'); return original(method, params); };
  const down = await f.call('get_job_status');
  assert.equal(down.agents[0].native.freshness, 'unavailable');
  assert.equal(down.agents[0].native.source, 'none');
  assert.equal(down.job.state, 'unknown');
  assert.equal(down.job.next_actor, 'manager');
  // A stale recorded observation must not be used to claim liveness either.
  f.store.meta('observation:' + worker.id, { state: 'working', turn: 3, observedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const stale = await f.call('get_job_status');
  assert.equal(stale.agents[0].native.freshness, 'stale');
  assert.equal(stale.agents[0].native.source, 'recorded');
  assert.equal(stale.job.state, 'unknown');
  // Even a fresh recorded observation cannot prove a live turn on this call.
  f.store.meta('observation:' + worker.id, { state: 'working', turn: 4, observedAt: new Date().toISOString() });
  const recorded = await f.call('get_job_status');
  assert.equal(recorded.agents[0].native.source, 'recorded');
  assert.equal(recorded.job.state, 'unknown');
});

test('a replaced native process is a manager-owned identity mismatch', async t => {
  const f = await fixture(t), agent = await f.spawn();
  f.terminals.get(agent.terminal_id).pid += 1;
  const status = await f.call('get_job_status');
  assert.equal(status.agents[0].native.identity, 'mismatch');
  assert.equal(status.job.state, 'reviewing');
  assert.equal(status.job.next_actor, 'manager');
  assert.match(status.job.reason, /identity/);
});

test('an older accepted report cannot satisfy done after a newer rejection', async t => {
  const f = await fixture(t), agent = await f.spawn({ template: 'implementer' });
  const worker = f.store.worker(agent.agent_id);
  f.report(worker, 'report-1');
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'First report accepted' });
  // A newer result arrives and is explicitly rejected.
  f.report(worker, 'report-2');
  await f.call('resolve_message', { message_id: 'report-2', action: 'abort', text: 'Second report rejected' });
  await f.call('stop_agent', { target: agent.agent_id, request_id: 'stop-after-reject' });
  for (const m of f.store.messages({ taskId: worker.taskId }).filter(m => m.kind === 'attention' && !m.acknowledgedAt)) {
    await f.call('resolve_message', { message_id: m.id, action: 'accept', text: 'Resolved lifecycle notice' });
  }
  f.closeTask(worker.taskId);
  const status = await f.call('get_job_status');
  const one = status.agents[0];
  assert.equal(one.review.accepted, false, 'the stale acceptance must not count');
  assert.equal(one.review.aborted, true);
  assert.equal(one.task_status, 'closed');
  assert.notEqual(status.job.state, 'done');
  assert.equal(status.job.counts.done, 0);
});

test('a stopped worker retains ownership as pending retirement until reconciled, then is done', async t => {
  const f = await fixture(t), agent = await f.spawn({ template: 'implementer' });
  const worker = f.store.worker(agent.agent_id);
  assert.equal(f.store.writerLeases().length, 1, 'implementer launch grants one writer lease');
  f.report(worker);
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Inspected source and actual test output' });
  await f.call('stop_agent', { target: agent.agent_id, request_id: 'stop-done' });
  // The intentional-stop notice is an actionable pending message; a job is not
  // done until every actionable pending kind (including attention) is resolved.
  const [notice] = f.store.messages({ taskId: worker.taskId }).filter(m => m.kind === 'attention' && !m.acknowledgedAt);
  assert.ok(notice, 'an intentional stop records one unacknowledged lifecycle notice');
  await f.call('resolve_message', { message_id: notice.id, action: 'accept', text: 'Confirmed the intentional stop and preserved terminal history' });
  f.closeTask(worker.taskId);
  // Native-exit confirmation and writer ownership are SEPARATE facts: the stop
  // is confirmed, yet ownership is retained as `pending_retirement` because
  // registered-graph emptiness is not proof about unregistered descendants.
  assert.equal(f.store.writerLeases().length, 1, 'confirmed stop retains the writer lease as pending_retirement');
  const pending = await f.call('get_job_status');
  assert.equal(pending.agents[0].ownership.writer, true);
  assert.equal(pending.agents[0].retirement.state, 'pending_retirement');
  assert.notEqual(pending.job.state, 'done');
  assert.equal(pending.job.next_actor, 'manager');
  assert.match(pending.job.reason, /pending_retirement/);
  // Only explicit, trusted, execution-bound complete clearance releases it.
  f.release(worker, 'stop-done');
  assert.equal(f.store.writerLeases().length, 0, 'reconciliation releases the writer lease');
  const status = await f.call('get_job_status');
  const one = status.agents[0];
  assert.equal(one.review.accepted, true);
  assert.equal(one.task_status, 'closed');
  assert.equal(one.ownership.writer, false);
  assert.equal(one.retirement.state, 'released');
  assert.equal(one.native.state, 'done');
  assert.equal(one.native.lifecycle, 'finished');
  assert.equal(status.job.state, 'done');
  assert.equal(status.job.next_actor, null);
  assert.equal(status.job.counts.done, 1);
});

test('agents are isolated per chat and zero selected work is unknown, not done', async t => {
  const f = await fixture(t), mine = await f.spawn({ task_name: 'mine' });
  const theirs = await f.spawn({ thread_id: OTHER, task_name: 'theirs' });
  assert.notEqual(mine.agent_id, theirs.agent_id);

  const here = await f.call('get_job_status');
  assert.equal(here.thread_id, THREAD);
  assert.equal(here.job.agent_count, 1);
  assert.equal(here.agents[0].agent_id, mine.agent_id);

  const there = await f.call('get_job_status', { thread_id: OTHER });
  assert.equal(there.job.agent_count, 1);
  assert.equal(there.agents[0].agent_id, theirs.agent_id);

  // A target from another chat is never resolvable here.
  await assert.rejects(f.call('get_job_status', { target: theirs.agent_id }), /Unknown agent/);

  const empty = await f.call('get_job_status', { thread_id: EMPTY });
  assert.equal(empty.job.state, 'unknown');
  assert.equal(empty.job.agent_count, 0);
  assert.equal(empty.job.counts.done, 0);
  assert.deepEqual(empty.agents, []);
});
