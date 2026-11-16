import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTools, AGENT_TOOLS } from '../src/agent-tools.mjs';
import { RevisionReviews } from '../src/revision-reviews.mjs';
import { Delegation } from '../src/delegation.mjs';
import { Store } from '../src/store.mjs';
import { Notifications } from '../src/notifications.mjs';
import { startActivityBus, createJournalPublisher } from '../src/activity-ipc.mjs';
import { waitForAgentActivity } from '../src/activity-wait.mjs';

const THREAD = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-tools-')));
  const project = join(dir, 'project'); mkdirSync(project);
  const path = join(dir, 'manager.sqlite'), publisher = createJournalPublisher(path);
  const store = new Store(path, { onJournal: publisher });
  const bus = await startActivityBus({ dbPath: path });
  const config = { stateDir: dir }, terminals = new Map(), effects = [];
  const rpc = { loseRun: false, loseSend: false, async request(method, params) {
    if (method === 'terminal.run') {
      const address = 't' + (terminals.size + 1), pid = terminals.size + 1000;
      terminals.set(address, { address, pid, state: 'live', status: { state: 'idle' }, turn: 0, cwd: params.cwd, labels: params.labels, argv: params.argv, keep: false });
      effects.push({ method, params });
      if (this.loseRun) { this.loseRun = false; throw new Error('Lost launch receipt'); }
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
  const delegation = new Delegation({ config, store, rpc, prepare: async w => ({ argv: ['fake-worker'], cwd: w.project }) });
  const notices = new Notifications({ config, store });
  const resolveMessage = async (m, action) => { store.recordAction(m.id, action); return store.ack(m.id); };
  const adapter = new AgentTools({ config, store, delegation, notices, ensureBridge: async () => {}, resolveMessage,
    wait: options => waitForAgentActivity({ store, dbPath: path, ...options }), flush: () => publisher.flush() });
  const call = (name, args = {}, options) => adapter.call(name, { thread_id: THREAD, ...args }, options);
  const spawn = (extra = {}) => call('spawn_agent', { task_name: 'inspect', project, message: 'Inspect the code', ...extra });
  const report = (worker, id = 'report-1', kind = 'result') => store.ingest(worker, { id, taskId: worker.taskId, workerId: worker.id, terminalId: worker.terminalId, kind, text: 'Evidence from worker', createdAt: new Date().toISOString(), turn: 1 }, { lifecycle: true });
  t.after(async () => { await publisher.flush(); await bus.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { call, spawn, adapter, store, notices, delegation, terminals, rpc, effects, report, publisher, project, path, dir };
}

test('sixteen strict native-style tools; unsupported forks/models and malformed calls have no effects', async t => {
  const f = await fixture(t); assert.equal(AGENT_TOOLS.length, 16);
  assert.ok(AGENT_TOOLS.some(t=>t.name==='stop_agent'));
  assert.ok(AGENT_TOOLS.some(t=>t.name==='cancel_request'));
  assert.ok(AGENT_TOOLS.some(t=>t.name==='get_job_status'));
  assert.ok(AGENT_TOOLS.some(t=>t.name==='read_review_packet'));
  assert.ok(AGENT_TOOLS.some(t=>t.name==='capture_review'));
  assert.ok(AGENT_TOOLS.some(t=>t.name==='verify_review'));
  for (const extra of [{ fork_turns: 'all' }, { model: 'another-model' }, { message: '' }, { task_name: '../escape' }, { thread_id: 'not-a-chat' }, { project: undefined }, { desk_id: 'desk', desk_project: 'project', definition: 'role' }]) await assert.rejects(f.spawn(extra));
  assert.equal(f.effects.length, 0);
});

test('stable task names survive retries and freeze selected context', async t => {
  const f = await fixture(t);
  const one = await f.spawn({ context: 'Chosen decisions only' });
  const two = await f.spawn({ context: 'Chosen decisions only' });
  assert.equal(one.agent_id, two.agent_id); assert.equal(two.reused, true);
  assert.equal(f.effects.filter(e => e.method === 'terminal.run').length, 1);
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, 1);
  assert.match(f.effects.at(-1).params.text, /Chosen decisions only/);
  await assert.rejects(f.spawn({ context: 'Different context' }), /different frozen/);
  assert.equal(one.scope, 'read-only'); assert.equal(one.verified, false);
});

test('show_agent places a visible panel; a placement failure warns but never fails or relaunches the agent', async t => {
  const f = await fixture(t), seen = [];
  f.adapter.place = async worker => { seen.push(worker.id); return { status: 'placed', space_id: 'space-1', terminal_id: worker.terminalId, place: 'tab' }; };
  const one = await f.spawn({ show: true });
  assert.equal(one.placement.status, 'placed'); assert.equal(one.placement.terminal_id, f.store.worker(one.agent_id).terminalId);
  assert.deepEqual(seen, [one.agent_id]);
  const reused = await f.spawn({ show: true }); assert.equal(reused.reused, true);
  const shown = await f.call('show_agent', { target: one.agent_id });
  assert.equal(shown.agent_id, one.agent_id); assert.equal(shown.status, 'placed'); assert.equal(seen.length, 3);
  f.adapter.place = async () => { throw new Error('No Herdr desktop space matches /tmp/project'); };
  const warned = await f.call('show_agent', { target: 'inspect' });
  assert.equal(warned.status, 'unavailable'); assert.match(warned.warning, /No Herdr desktop space matches/);
  assert.equal(f.store.worker(one.agent_id).launchState, 'started');
  await assert.rejects(f.call('show_agent', { target: 'missing_agent' }), /Unknown agent/);
  assert.equal(f.effects.filter(e => e.method === 'terminal.run').length, 1);
});

test('lost launch/send responses expose the stable identity and never relaunch or resend', async t => {
  const f = await fixture(t); f.rpc.loseRun = true;
  await assert.rejects(f.spawn(), e => { assert.match(e.details.agent_id, /^ha-/); assert.equal(e.details.agent.launch_state, 'uncertain'); return true; });
  const retry = await f.spawn(); assert.equal(retry.launch_state, 'uncertain');
  assert.equal(f.effects.length, 1);
  f.rpc.loseSend = true;
  await assert.rejects(f.spawn({ task_name: 'send_failure' }), /Lost send/);
  const retry2 = await f.spawn({ task_name: 'send_failure' }); assert.equal(retry2.request.state, 'uncertain');
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, 1);
});

test('chat ownership applies to IDs, names, reports and notifications', async t => {
  const f = await fixture(t), one = await f.spawn();
  const other = await f.spawn({ thread_id: OTHER }); assert.notEqual(other.agent_id, one.agent_id);
  for (const name of ['send_message', 'followup_task', 'interrupt_agent', 'read_agent', 'wait_agent']) {
    const args = { target: other.agent_id, ...(['send_message', 'followup_task'].includes(name) ? { message: 'No cross-chat mutation' } : {}) };
    await assert.rejects(f.call(name, args), /another manager chat/);
  }
  const worker = f.store.worker(other.agent_id); f.report(worker);
  const n = f.notices.create(OTHER, [f.store.message('report-1')]);
  await assert.rejects(f.call('receive_notification', { notification_id: n.id }), /Unknown notification/);
  await assert.rejects(f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Reviewed' }), /Unknown manager message/);
  assert.equal((await f.call('list_agents')).agents.length, 1);
});

test('idle messages queue, follow-up drains once, explicit new keys repeat intentionally, interrupt retains writer lease', async t => {
  const f = await fixture(t), agent = await f.spawn({ template: 'implementer' });
  f.terminals.get(agent.terminal_id).status.state = 'idle';
  const note = await f.call('send_message', { target: 'inspect', message: 'Include this note' }); assert.equal(note.state, 'queued');
  const args = { target: 'inspect', message: 'Continue' };
  await f.call('followup_task', args); await f.call('followup_task', args);
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, 2);
  assert.match(f.effects.at(-1).params.text, /Include this note/);
  await f.call('followup_task', { ...args, request_id: 'repeat-intentionally' });
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, 3);
  await f.call('interrupt_agent', { target: 'inspect' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n, 1);
});

test('wait uses bridge activity, cursor scopes, report receipt and acknowledgement without accepting on read', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  const initial = await f.call('wait_agent', { timeout_ms: 0 }); assert.equal(initial.timed_out, true);
  const waiting = f.call('wait_agent', { after_cursor: initial.after_cursor, timeout_ms: 1000 });
  f.report(worker); await f.publisher.flush();
  const r = await waiting; assert.equal(r.reason, 'activity');
  assert.equal(r.reports_included, false, 'a wait is bounded by default');
  assert.deepEqual(r.messages.map(m => m.message_id), ['report-1']);
  assert.equal(r.messages[0].text_preview, 'Evidence from worker'); assert.equal(r.messages[0].text_truncated, false);
  assert.equal(f.store.message('report-1').acknowledgedAt, null);
  const n = f.notices.create(THREAD, [f.store.message('report-1')]);
  const received = await f.call('receive_notification', { notification_id: n.id }); assert.equal(received.actionable, true);
  const stale = await f.call('receive_notification', { notification_id: n.id });
  assert.equal(stale.actionable, false); assert.equal(stale.replayed, true);
  assert.ok(stale.report_ids.includes('report-1'), 'a stale replay still exposes its own known membership');
  assert.ok(!('messages' in stale), 'compact receive never re-sends report prose');
  await f.call('resolve_message', { message_id: 'report-1', action: 'accept', text: 'Inspected source and actual test output' });
  assert.ok(f.store.message('report-1').acknowledgedAt);
  await f.spawn({ task_name: 'second' });
  await assert.rejects(f.call('wait_agent', { after_cursor: r.after_cursor, timeout_ms: 0 }), /different installation, chat or agent selection/);
  await assert.rejects(f.call('wait_agent', { after_cursor: 'garbage', timeout_ms: 0 }), /Invalid after_cursor/);
});

test('abort releases a wait without stopping workers; replacement processes are never read', async t => {
  const f = await fixture(t), agent = await f.spawn(), controller = new AbortController();
  const waiting = f.call('wait_agent', { timeout_ms: 5000 }, { signal: controller.signal }); controller.abort(new Error('Cancelled wait'));
  await assert.rejects(waiting, /Cancelled wait/);
  assert.equal(f.effects.filter(e => e.method === 'terminal.interrupt').length, 0);
  f.terminals.get(agent.terminal_id).pid++;
  await assert.rejects(f.call('read_agent', { target: 'inspect' }), /identity/);
});

test('wait_agent bounds pending reports by default, returns full text/claim only on explicit request, and never acknowledges', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  const secret = 'REPORT-PROSE-' + 'x'.repeat(7000);
  ingestEvidenceResult(f, worker, 'big-report', secret, 'big');
  const sends = f.effects.filter(e => e.method === 'terminal.send').length;
  const compact = await f.call('wait_agent', { timeout_ms: 0 });
  assert.equal(compact.reports_included, false);
  assert.equal(compact.messages.length, 1);
  const [meta] = compact.messages;
  assert.equal(meta.message_id, 'big-report'); assert.equal(meta.agent_id, agent.agent_id); assert.equal(meta.kind, 'result');
  assert.equal(meta.text_bytes, Buffer.byteLength(secret, 'utf8'));
  assert.equal(meta.text_truncated, true); assert.ok(meta.text_preview.length < secret.length);
  assert.equal(meta.evidence_authority, 'worker-claims');
  assert.equal(meta.evidence.changed_paths.count, 16); assert.equal(meta.evidence.artifacts.count, 12);
  assert.equal(meta.evidence.references_dereferenced, false);
  assert.ok(!JSON.stringify(compact).includes(secret), 'the default wait must not echo report prose');
  const raw = await f.call('wait_agent', { timeout_ms: 0, include_reports: true });
  assert.equal(raw.reports_included, true);
  assert.equal(raw.messages[0].text, secret);
  assert.equal(raw.messages[0].evidence.changed_paths.length, 16);
  assert.equal(f.store.message('big-report').acknowledgedAt, null);
  assert.equal(f.store.message('big-report').action, null);
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, sends, 'a read-only wait sends nothing to the worker');
});

test('wait_agent selection filters reports by target and never leaks a report into another chat', async t => {
  const f = await fixture(t), one = await f.spawn({ task_name: 'one' }), two = await f.spawn({ task_name: 'two' });
  const w1 = f.store.worker(one.agent_id), w2 = f.store.worker(two.agent_id);
  ingestEvidenceResult(f, w1, 'from-one', 'first', 'one');
  ingestEvidenceResult(f, w2, 'from-two', 'second', 'two');
  const sends = f.effects.filter(e => e.method === 'terminal.send').length;
  const targeted = await f.call('wait_agent', { target: one.agent_id, timeout_ms: 0 });
  assert.deepEqual(targeted.messages.map(m => m.message_id), ['from-one']);
  assert.equal(targeted.reports_included, false);
  const all = await f.call('wait_agent', { timeout_ms: 0 });
  assert.deepEqual(all.messages.map(m => m.message_id).sort(), ['from-one', 'from-two']);
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, sends, 'a wait never signals a worker');
  await assert.rejects(f.call('wait_agent', { target: two.agent_id, thread_id: OTHER, timeout_ms: 0 }), /another manager chat/);
});

test('wait_agent default response is at least half the size of the raw opt-in for the same two reports', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  ingestEvidenceResult(f, worker, 'measure-a', 'alpha-' + 'z'.repeat(6000), 'alpha');
  ingestEvidenceResult(f, worker, 'measure-b', 'beta-' + 'z'.repeat(6000), 'beta');
  const compact = await f.call('wait_agent', { timeout_ms: 0 });
  const raw = await f.call('wait_agent', { timeout_ms: 0, include_reports: true });
  const ids = response => response.messages.map(m => m.message_id).sort();
  assert.deepEqual(ids(compact), ['measure-a', 'measure-b']);
  assert.deepEqual(ids(raw), ['measure-a', 'measure-b'], 'the opt-in must retain every report ID');
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
  const rawBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  assert.ok(rawBytes >= 2 * 6000, `the raw response should carry both reports (got ${rawBytes})`);
  assert.ok(compactBytes < rawBytes / 2, `default wait should be at least 50% smaller (compact=${compactBytes} raw=${rawBytes})`);
});

test('uncertain replies cannot be acknowledged and handled actions retry without contacting a dead worker', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  f.report(worker, 'question', 'question');
  await assert.rejects(f.call('resolve_message', { message_id: 'question', action: 'reply', text: 'Answer' }), /completed decision or verified reply/);
  assert.equal(f.store.message('question').acknowledgedAt, null);
  f.report(worker, 'finished');
  const args = { message_id: 'finished', action: 'accept', text: 'Verified actual evidence' };
  const first = await f.call('resolve_message', args);
  f.adapter.resolveMessage = async () => { throw new Error('Must not contact worker again'); };
  const second = await f.call('resolve_message', args);
  assert.equal(first.acknowledged_at, second.acknowledged_at);
  await assert.rejects(f.call('resolve_message', { ...args, action: 'abort' }), /already recorded/);
});

test('an uncertain reply reports inbound delivery and reply delivery separately and never invents an acknowledgement', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  f.report(worker, 'question', 'question');
  // Simulate the real resolveMessage path: the action is durably recorded, the
  // native send fails without a receipt, and nothing is acknowledged.
  f.adapter.resolveMessage = async (m, action) => {
    f.store.recordAction(m.id, action);
    f.store.setActionState(m.id, 'uncertain', { error: 'Lost send receipt' });
    throw new Error('Native reply returned no delivery receipt; inspect the terminal before retrying');
  };
  await assert.rejects(f.call('resolve_message', { message_id: 'question', action: 'reply', text: 'Answer' }), error => {
    assert.match(error.message, /no delivery receipt/);
    const receipt = error.details?.receipt;
    assert.ok(receipt, 'a failed resolve still reports durable state');
    assert.equal(receipt.message_id, 'question');
    assert.equal(receipt.kind, 'question');
    assert.equal(receipt.acknowledged, false);
    assert.equal(receipt.acknowledged_at, null);
    assert.equal(receipt.action.kind, 'reply');
    assert.equal(receipt.action.state, 'uncertain');
    assert.equal(receipt.report_delivery.state, 'pending');
    assert.equal(receipt.report_delivery.received_at, null);
    assert.equal(receipt.reply_delivery.state, 'uncertain');
    assert.equal(receipt.reply_delivery.native_receipt, null);
    assert.match(receipt.reply_delivery.error, /Lost send receipt/);
    assert.equal(typeof error.details.request_id, 'string');
    assert.ok(!JSON.stringify(error.details).includes('Answer'), 'the receipt never echoes reply prose');
    return true;
  });
  assert.equal(f.store.message('question').acknowledgedAt, null);
  assert.equal(f.store.message('question').action.state, 'uncertain');
});

test('48-char task names are preserved and remain valid targets after 32-char native truncation', async t => {
  const f = await fixture(t), long = 'b'.repeat(48);
  const one = await f.spawn({ task_name: long });
  assert.equal(one.task_name, long);
  const worker = f.store.worker(one.agent_id);
  assert.equal(worker.name, long.slice(0, 32)); assert.equal(worker.requestedName, long);
  assert.equal((await f.call('list_agents')).agents.at(-1).task_name, long);
  assert.equal((await f.call('read_agent', { target: long })).task_name, long);
  const sends = f.effects.filter(e => e.method === 'terminal.send').length;
  await f.call('followup_task', { target: long, message: 'Continue' });
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, sends + 1);
});

test('a truncated 32-char alias shared by two agents is refused instead of silently resolved', async t => {
  const f = await fixture(t), prefix = 'c'.repeat(33), first = prefix + 'x', second = prefix + 'y';
  const one = await f.spawn({ task_name: first }), two = await f.spawn({ task_name: second });
  assert.notEqual(one.agent_id, two.agent_id);
  assert.equal(f.store.worker(one.agent_id).name, f.store.worker(two.agent_id).name);
  await assert.rejects(f.call('read_agent', { target: f.store.worker(one.agent_id).name }), /Ambiguous agent name/);
  assert.equal((await f.call('read_agent', { target: first })).task_name, first);
  assert.equal((await f.call('read_agent', { target: second })).task_name, second);
});

test('read_agent returns concise identity and screen, never launch argv/env/labels or the system prompt', async t => {
  const f = await fixture(t), long = 'r'.repeat(48);
  // The secret argv must be part of the launched program so the native identity
  // still matches the worker; a post-launch argv rewrite is a replaced process
  // and read_agent must refuse it (see the replacement-process test above).
  f.delegation.prepare = async w => ({ argv: ['--token', 'SECRET-ARGV'], cwd: w.project });
  const one = await f.spawn({ task_name: long });
  const terminal = f.terminals.get(one.terminal_id);
  terminal.labels = { ...terminal.labels, secret: 'SECRET-LABEL' };
  terminal.status = { state: 'working', turn: 4, detail: 'SECRET-SYSTEM-PROMPT' };
  const read = await f.call('read_agent', { target: long, lines: 12 });
  assert.equal(read.task_name, long); assert.equal(read.agent_id, one.agent_id);
  assert.deepEqual(read.screen, { text: 'actual terminal text', truncated: false, total_lines: 1 });
  assert.equal(read.native.address, one.terminal_id);
  assert.deepEqual(read.native.status, { state: 'working', turn: 4 });
  assert.ok(!('argv' in read.native) && !('labels' in read.native));
  const serialized = JSON.stringify(read);
  for (const secret of ['SECRET-ARGV', 'SECRET-LABEL', 'SECRET-SYSTEM-PROMPT', 'fake-worker']) assert.ok(!serialized.includes(secret), `read_agent leaked ${secret}`);
});

test('read_agent enforces the requested line count as a tail bound when native read returns full scrollback', async t => {
  const f = await fixture(t);
  const one = await f.spawn();
  const scrollback = Array.from({ length: 51 }, (_, i) => `line-${i + 1}`).join('\n');
  f.rpc.request = async (method, params) => method === 'terminal.get' ? structuredClone(f.terminals.get(params.terminal))
    : method === 'terminal.read' ? { text: scrollback } : (() => { throw new Error('Unexpected native method ' + method); })();
  const read = await f.call('read_agent', { target: one.agent_id, lines: 3 });
  assert.equal(read.screen.text, 'line-49\nline-50\nline-51');
  assert.equal(read.screen.truncated, true);
  assert.equal(read.screen.total_lines, 51);
  const whole = await f.call('read_agent', { target: one.agent_id, lines: 80 });
  assert.equal(whole.screen.text, scrollback);
  assert.equal(whole.screen.truncated, false);
  assert.equal(whole.screen.total_lines, 51);
});

test('show options forward exact space_id/place and a create-space action is advisory only', async t => {
  const f = await fixture(t), calls = [];
  f.adapter.place = async (worker, options) => { calls.push({ id: worker.id, options }); return { status: 'placed', verified: true, terminal_id: worker.terminalId, space_id: options.spaceId ?? 'auto' }; };
  const one = await f.spawn();
  const shown = await f.call('show_agent', { target: one.agent_id, space_id: 'space-7', place: 'right' });
  assert.equal(shown.verified, true);
  assert.deepEqual(calls.at(-1).options, { spaceId: 'space-7', place: 'right' });
  assert.equal(shown.space_id, 'space-7');
  f.adapter.place = async worker => ({ status: 'create-space-required', verified: false, terminalId: worker.terminalId, project: f.project, action: { method: 'space.new', params: { name: 'project', folder: f.project } } });
  const action = await f.call('show_agent', { target: one.agent_id });
  assert.equal(action.status, 'create-space-required'); assert.equal(action.verified, false);
  assert.equal(action.action.method, 'space.new');
  assert.equal(f.store.worker(one.agent_id).launchState, 'started');
});

test('send/follow-up/interrupt receipts omit the payload and wire text while storage and retries stay intact', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const base = f.effects.filter(e => e.method === 'terminal.send').length;
  const big = 'X'.repeat(4000), ctx = 'C'.repeat(2000);
  const args = { target: agent.agent_id, message: big, context: ctx };
  const first = await f.call('followup_task', args);
  assert.ok(!('payload' in first) && !('wire_text' in first) && !('instruction' in first) && !('context' in first));
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes('XXXX') && !serialized.includes('CCCC'), 'receipt echoed the assignment');
  assert.equal(first.agent_id, agent.agent_id); assert.equal(first.worker_id, undefined);
  assert.equal(first.state, 'sent'); assert.match(first.request_id, /^auto-/);
  assert.ok(first.fingerprint && first.native_receipt, 'retry identities must survive');
  // The full assignment is still queued/delivered and stored unchanged.
  const sent = f.effects.filter(e => e.method === 'terminal.send');
  assert.equal(sent.length, base + 1); assert.ok(sent.at(-1).params.text.includes(big) && sent.at(-1).params.text.includes(ctx));
  const stored = f.delegation.requests.get(agent.agent_id, first.request_id);
  assert.equal(stored.payload.instruction, big); assert.equal(stored.payload.context.content, ctx);
  assert.ok(stored.wireText.includes(big));
  // An identical retry returns the same short receipt and never resends.
  const retry = await f.call('followup_task', args);
  assert.deepEqual(retry, first);
  assert.equal(f.effects.filter(e => e.method === 'terminal.send').length, base + 1);
  // Uncertainty is still surfaced with identity and no payload.
  const uncertain = 'Continue after the uncertain delivery';
  f.rpc.loseSend = true;
  await assert.rejects(f.call('followup_task', { target: agent.agent_id, message: uncertain }), /Lost send/);
  const record = f.delegation.requests.list(agent.agent_id).find(r => r.payload.instruction === uncertain);
  assert.equal(record.state, 'uncertain'); assert.match(record.error, /Lost send/);
  const after = await f.call('followup_task', { target: agent.agent_id, message: uncertain });
  assert.equal(after.request_id, record.requestId); assert.equal(after.state, 'uncertain'); assert.match(after.error, /Lost send/);
  assert.ok(!JSON.stringify(after).includes('uncertain delivery'));
  // send_message (queued) and interrupt_agent share the same short receipt.
  f.terminals.get(agent.terminal_id).status.state = 'idle';
  const noteText = 'N'.repeat(3000);
  const note = await f.call('send_message', { target: agent.agent_id, message: noteText, mode: 'queue' });
  assert.equal(note.state, 'queued'); assert.ok(!('payload' in note) && !('wire_text' in note));
  assert.ok(!JSON.stringify(note).includes('NNNN'));
  assert.equal(f.delegation.requests.get(agent.agent_id, note.request_id).payload.instruction, noteText);
  const cut = await f.call('interrupt_agent', { target: agent.agent_id });
  assert.equal(cut.state, 'sent'); assert.ok(!('payload' in cut) && !('wire_text' in cut));
});

test('stop_agent preserves the original history for read_agent while later input stays refused', async t => {
  const f = await fixture(t);
  const agent = await f.spawn({ task_name: 'stopped' });
  const terminal = f.terminals.get(agent.terminal_id);
  const stopped = await f.call('stop_agent', { target: agent.agent_id, request_id: 'stop-1', note: 'operator ended it' });
  assert.equal(stopped.state, 'sent'); assert.equal(stopped.delivery, 'confirmed-stopped'); assert.equal(stopped.stop.confirmed, true);
  assert.equal(f.effects.filter(e => e.method === 'terminal.kill').length, 1);
  assert.equal(terminal.state, 'finished');
  // The stopped original is still readable: identity, terminal id and screen survive.
  const read = await f.call('read_agent', { target: agent.agent_id, lines: 5 });
  assert.equal(read.agent_id, agent.agent_id);
  assert.equal(read.terminal_id, agent.terminal_id);
  assert.equal(read.launch_state, 'stopped');
  assert.match(read.screen.text, /actual terminal text/);
  // Later sends and interrupts are refused and never reach the native process.
  const before = f.effects.filter(e => e.method === 'terminal.send' || e.method === 'terminal.interrupt').length;
  await assert.rejects(f.call('followup_task', { target: agent.agent_id, message: 'more' }), /intentionally stopped/);
  await assert.rejects(f.call('send_message', { target: agent.agent_id, message: 'more' }), /intentionally stopped/);
  await assert.rejects(f.call('interrupt_agent', { target: agent.agent_id, request_id: 'int-1' }), /intentionally stopped/);
  assert.equal(f.effects.filter(e => e.method === 'terminal.send' || e.method === 'terminal.interrupt').length, before);
});

const ingestResult = (f, worker, id, text) => f.store.ingest(worker, {
  id, taskId: worker.taskId, workerId: worker.id, terminalId: worker.terminalId, kind: 'result',
  text, createdAt: new Date().toISOString(), turn: 1,
}, { lifecycle: true });

// A valid v1 worker claim with a substantial changed-path/artifact manifest, so a
// bounded projection is observably smaller than the raw opt-in payload.
const workerEvidence = (worker, tag) => ({
  version: 1, worker_id: worker.id, task_id: worker.taskId, session_generation_id: `gen-${tag}`,
  baseline_revision: { sha256: 'a'.repeat(64), project: 'herdr' },
  final_revision: { sha256: 'b'.repeat(64), project: 'herdr' },
  changed_paths: Array.from({ length: 16 }, (_, i) => `src/${tag}/file-${String(i).padStart(2, '0')}.mjs`),
  artifacts: Array.from({ length: 12 }, (_, i) => ({ path: `artifacts/${tag}-${i}.bin`, sha256: 'c'.repeat(64) })),
  tests: [{ argv: ['node', '--test', `${tag}.test.mjs`], cwd: '.', exit_code: 0, output_path: `artifacts/${tag}.log`, truncated: false }],
  limitations: [`${tag} was measured with a constrained sandbox`],
  unresolved_requests: ['none'],
});
const ingestEvidenceResult = (f, worker, id, text, tag = id) => f.store.ingest(worker, {
  id, taskId: worker.taskId, workerId: worker.id, terminalId: worker.terminalId, kind: 'result',
  text, createdAt: new Date().toISOString(), turn: 1, evidence: workerEvidence(worker, tag),
}, { lifecycle: true });

test('receive_notification returns a compact, replayable packet summary and never accepts work', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  for (let i = 1; i <= 3; i++) ingestResult(f, worker, 'big-' + i, String.fromCharCode(64 + i).repeat(4096));
  const n = f.notices.create(THREAD, ['big-1', 'big-2', 'big-3'].map(id => f.store.message(id)));
  const received = await f.call('receive_notification', { notification_id: n.id });
  assert.equal(received.actionable, true); assert.equal(received.replayed, false);
  assert.equal(received.count, 3); assert.deepEqual(received.report_ids, ['big-1', 'big-2', 'big-3']);
  assert.equal(received.current_actionable, true); assert.equal(received.current_pending, 3); assert.equal(received.current_handled, 0);
  assert.equal(received.evidence_only, true);
  assert.equal(received.can_acknowledge, false); assert.equal(received.can_accept, false); assert.equal(received.can_signal, false);
  assert.equal(received.provenance.untrusted, true); assert.equal(received.provenance.terminal_verified, false); assert.equal(received.provenance.acknowledged, false);
  assert.ok(!JSON.stringify(received).includes('AAAA'), 'compact summary must not carry report prose');
  assert.equal(received.members.length, 3);
  assert.ok(received.members.every(m => m.current.reason === 'actionable' && m.current.pending === true && m.current.acknowledged_at === null));
  // Receiving marks manager receipt but never acknowledges, accepts or mutates a report.
  const stored = f.store.message('big-1'); assert.equal(stored.acknowledgedAt, null); assert.equal(stored.action, null); assert.ok(stored.receivedAt); assert.equal(stored.delivery, 'pending');
  // A lost first response is recovered by replay: same stable batch_id and the full membership survive.
  const replay = await f.call('receive_notification', { notification_id: n.id });
  assert.equal(replay.batch_id, received.batch_id); assert.equal(replay.replayed, true); assert.equal(replay.actionable, false); assert.equal(replay.already_received, true);
  assert.deepEqual(replay.report_ids, received.report_ids); assert.equal(replay.current_actionable, true, 'replay still shows the real current state');
  // Resolving returns a short truthful receipt and never repeats the report or reply prose.
  const resolved = await f.call('resolve_message', { message_id: 'big-1', action: 'accept', text: 'Inspected source and ran the actual tests' });
  assert.equal(resolved.acknowledged, true); assert.equal(resolved.action.kind, 'accept');
  assert.ok(!JSON.stringify(resolved).includes('AAAA') && !JSON.stringify(resolved).includes('Inspected source'));
  const after = await f.call('read_review_packet', { batch_id: received.batch_id });
  assert.equal(after.count, 3); assert.equal(after.current_pending, 2); assert.equal(after.current_actionable, true);
  const member = after.members.find(m => m.message_id === 'big-1');
  assert.equal(member.current.reason, 'acknowledged'); assert.equal(member.current.acknowledged_at !== null, true); assert.equal(member.current.action.kind, 'accept');
  assert.ok(!JSON.stringify(after).includes('AAAA'), 'summary read has no report prose');
});

test('read_review_packet pages bounded untrusted detail with batch- and chat-bound cursors', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  for (let i = 1; i <= 3; i++) ingestResult(f, worker, 'pg-' + i, String.fromCharCode(64 + i).repeat(4096));
  const n = f.notices.create(THREAD, ['pg-1', 'pg-2', 'pg-3'].map(id => f.store.message(id)));
  const received = await f.call('receive_notification', { notification_id: n.id });
  const summary = await f.call('read_review_packet', { batch_id: received.batch_id });
  assert.equal(summary.count, 3); assert.equal(summary.members.length, 3); assert.equal(summary.evidence_only, true);
  assert.ok(!JSON.stringify(summary).includes('AAAA'));
  const seen = []; let cursor = null, pages = 0;
  do {
    const page = await f.call('read_review_packet', { batch_id: received.batch_id, include_detail: true, limit: 1, max_bytes: 4096, ...(cursor ? { cursor } : {}) });
    pages += 1; assert.ok(page.page_bytes <= 4096, 'page stays within the byte budget');
    assert.equal(page.detail_budget.max_bytes, 4096); assert.equal(page.detail_budget.max_items, 1);
    for (const item of page.items) { seen.push(item.message_id); assert.equal(item.summary.truncated, true); assert.equal(item.summary.source_bytes, 4096); assert.ok(item.summary.text.length < 4096); }
    cursor = page.cursor;
  } while (cursor);
  assert.equal(pages, 3, 'one item per page must span more than one page');
  assert.deepEqual(seen, ['pg-1', 'pg-2', 'pg-3']);
  const firstPage = await f.call('read_review_packet', { batch_id: received.batch_id, include_detail: true, limit: 1, max_bytes: 4096 });
  assert.ok(firstPage.cursor);
  // A second packet in the same chat refuses the first packet's cursor.
  f.notices.save({ ...f.notices.get(n.id), state: 'retired' });
  const n2 = f.notices.create(THREAD, [f.store.message('pg-2')]);
  const received2 = await f.call('receive_notification', { notification_id: n2.id });
  assert.notEqual(received2.batch_id, received.batch_id);
  await assert.rejects(f.call('read_review_packet', { batch_id: received2.batch_id, include_detail: true, cursor: firstPage.cursor }), /cursor does not belong to this review packet/);
  await assert.rejects(f.call('read_review_packet', { thread_id: OTHER, batch_id: received.batch_id }), /different manager chat/);
  await assert.rejects(f.call('read_review_packet', { batch_id: 'rp-does-not-exist' }), /Unknown review packet/);
});

test('read_agent defaults to bounded report metadata and supports terminal-only and explicit full reports', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  const secret = 'S'.repeat(4096);
  ingestResult(f, worker, 'meta-1', secret);
  const terminalOnly = await f.call('read_agent', { target: agent.agent_id, include_messages: false });
  assert.equal(terminalOnly.messages_included, false); assert.ok(!('messages' in terminalOnly));
  assert.ok(!JSON.stringify(terminalOnly).includes('S'.repeat(64)));
  const compactRead = await f.call('read_agent', { target: agent.agent_id });
  assert.equal(compactRead.messages_included, true); assert.equal(compactRead.reports_included, false);
  assert.equal(compactRead.messages.length, 1); assert.equal(compactRead.messages[0].message_id, 'meta-1');
  assert.equal(compactRead.messages[0].text_bytes, 4096); assert.equal(compactRead.messages[0].text_truncated, true); assert.ok(compactRead.messages[0].text_preview.length < 4096);
  assert.ok(!JSON.stringify(compactRead).includes(secret), 'default read must not echo the full report');
  const full = await f.call('read_agent', { target: agent.agent_id, include_reports: true });
  assert.equal(full.reports_included, true); assert.equal(full.messages[0].text, secret);
});

test('scoped receive consumes only owned members; a later envelope takes the rest and replay stays immutable', async t => {
  const f = await fixture(t), agent = await f.spawn(), worker = f.store.worker(agent.agent_id);
  f.report(worker, 'ov-1'); f.report(worker, 'ov-2');
  const before = f.store.message('ov-2');
  const first = f.notices.save({ id: 'hn-overlap-a', threadId: THREAD, clientId: 'client-a', members: ['ov-1'], state: 'prepared', attempted: false, createdAt: new Date().toISOString(), retryAt: 0 });
  const receivedA = await f.call('receive_notification', { notification_id: first.id });
  // Only the envelope's own member is captured; the uncovered report is not swept in.
  assert.deepEqual([...receivedA.report_ids].sort(), ['ov-1']);
  assert.equal(receivedA.actionable, true); assert.equal(receivedA.captured_actionable, true);
  assert.equal(f.store.message('ov-2').receivedAt, before.receivedAt, 'unrelated pending report keeps its receipt');
  assert.equal(f.store.message('ov-2').action, before.action, 'unrelated pending report keeps its action state');
  assert.equal(f.store.message('ov-2').acknowledgedAt, before.acknowledgedAt, 'unrelated pending report is never acknowledged');

  // A later envelope legitimately owns the remaining report and receives it itself.
  const second = f.notices.save({ id: 'hn-overlap-b', threadId: THREAD, clientId: 'client-b', members: ['ov-2'], state: 'prepared', attempted: false, createdAt: new Date().toISOString(), retryAt: 0 });
  const receivedB = await f.call('receive_notification', { notification_id: second.id });
  assert.deepEqual([...receivedB.report_ids].sort(), ['ov-2']);
  assert.equal(receivedB.actionable, true);

  // Immutable replay of the first batch never adopts the later report.
  const replay = await f.call('receive_notification', { notification_id: first.id, batch_id: receivedA.batch_id });
  assert.equal(replay.replayed, true); assert.equal(replay.actionable, false);
  assert.deepEqual([...replay.report_ids].sort(), ['ov-1']);

  // The old batch keeps fresh per-report state for its own membership only.
  await f.call('resolve_message', { message_id: 'ov-1', action: 'accept', text: 'Verified current evidence' });
  const reread = await f.call('read_review_packet', { batch_id: receivedA.batch_id });
  assert.equal(reread.count, 1);
  assert.deepEqual([...reread.member_ids].sort(), ['ov-1']);
  assert.equal(reread.current_pending, 0);
  assert.equal(reread.members.find(m => m.message_id === 'ov-1').current.reason, 'acknowledged');
});

test('compact receive is materially smaller than the legacy full-report response (bytes only)', async t => {
  const f = await fixture(t);
  const measure = async (threadId, mode) => {
    const agent = await f.spawn({ thread_id: threadId, task_name: 'measure' });
    const worker = f.store.worker(agent.agent_id);
    const ids = [0, 1, 2].map(i => `m${i}-${threadId.slice(-1)}`);
    ids.forEach(id => ingestResult(f, worker, id, 'X'.repeat(4096)));
    const n = f.notices.create(threadId, ids.map(id => f.store.message(id)));
    return f.call('receive_notification', { thread_id: threadId, notification_id: n.id, ...(mode === 'legacy' ? { legacy: true } : {}) });
  };
  const compact = await measure(THREAD, 'compact');
  const legacy = await measure(OTHER, 'legacy');
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
  assert.equal(legacy.actionable, true); assert.equal(legacy.messages.length, 3);
  assert.ok(legacyBytes >= 3 * 4096, 'legacy baseline must actually carry the full reports');
  assert.ok(compactBytes < legacyBytes / 4, `compact ${compactBytes}B must be far smaller than legacy ${legacyBytes}B`);
  assert.ok(!JSON.stringify(compact).includes('X'.repeat(64)), 'compact summary must not carry report prose');
  console.log(`[measure] compact=${compactBytes}B legacy=${legacyBytes}B ratio=${(compactBytes / legacyBytes).toFixed(3)}`);
});

// Every durable revision state lives under a `revision-review*` metadata key, so
// audits can prove a refused call wrote nothing without trusting tool prose.
const revisionKeys = f => f.store.db.prepare("SELECT key FROM metadata WHERE key LIKE 'revision-review%'").all().map(row => row.key);
const captureJournal = f => f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='revision-review.captured'").get().n;

test('capture_review binds a compact revision of exactly the registered project and never returns the manifest', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  mkdirSync(join(f.project, 'sub'), { recursive: true });
  writeFileSync(join(f.project, 'sub', 'beta.txt'), 'beta\n');
  ingestResult(f, worker, 'rev-result', 'R'.repeat(4096));
  const receipt = await f.call('capture_review', { result_id: 'rev-result', paths: ['alpha.txt', 'sub'], request_id: 'req-alpha-1' });
  assert.match(receipt.review_id, /^rv-[0-9a-f]{48}$/);
  assert.equal(receipt.result_id, 'rev-result'); assert.equal(receipt.thread_id, THREAD);
  assert.equal(receipt.task_id, worker.taskId); assert.equal(receipt.worker_id, agent.agent_id);
  assert.equal(receipt.terminal_id, agent.terminal_id); assert.equal(receipt.project, realpathSync(f.project));
  assert.match(receipt.revision_sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.scopes, 2); assert.equal(receipt.files, 2);
  assert.equal(receipt.bytes, Buffer.byteLength('alpha\n') + Buffer.byteLength('beta\n'));
  assert.equal(receipt.verified, false);
  // Compact response only: identity, digest and counts; no per-file manifest or report text.
  assert.equal(JSON.stringify(receipt).includes('alpha'), false);
  assert.equal(JSON.stringify(receipt).includes('beta'), false);
  assert.equal(JSON.stringify(receipt).includes('R'.repeat(64)), false);
  for (const leaked of ['manifest', 'members', 'report', 'files_detail']) assert.equal(leaked in receipt, false, `receipt must not expose ${leaked}`);
  assert.equal(revisionKeys(f).length, 2); // one review record + one request record
  assert.ok(f.store.meta('revision-review:' + receipt.review_id), 'review record must be durable');
  assert.equal(captureJournal(f), 1);
});

test('capture_review replays a stable request and refuses a conflicting reuse without new state', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'one.txt'), 'one\n'); writeFileSync(join(f.project, 'two.txt'), 'two\n');
  ingestResult(f, worker, 'rev-replay', 'evidence');
  const args = { result_id: 'rev-replay', paths: ['one.txt'], request_id: 'replay-key' };
  const first = await f.call('capture_review', args);
  const second = await f.call('capture_review', args);
  assert.deepEqual(second, first); assert.equal(second.review_id, first.review_id);
  assert.equal(revisionKeys(f).length, 2); assert.equal(captureJournal(f), 1);
  await assert.rejects(f.call('capture_review', { ...args, paths: ['two.txt'] }), /already captured a different review/);
  assert.equal(revisionKeys(f).length, 2, 'a conflicting reuse must not add durable state');
  assert.equal(captureJournal(f), 1);
});

test('capture_review refuses foreign and unknown results with the same error and no state', async t => {
  const f = await fixture(t), mine = await f.spawn();
  const foreign = await f.spawn({ thread_id: OTHER, task_name: 'foreign' });
  ingestResult(f, f.store.worker(mine.agent_id), 'mine-result', 'mine');
  ingestResult(f, f.store.worker(foreign.agent_id), 'foreign-result', 'foreign');
  const unknownError = await f.call('capture_review', { result_id: 'does-not-exist', paths: ['alpha.txt'], request_id: 'r1' }).then(() => null, error => error.message);
  const foreignError = await f.call('capture_review', { result_id: 'foreign-result', paths: ['alpha.txt'], request_id: 'r2' }).then(() => null, error => error.message);
  assert.equal(unknownError, 'Unknown result message in this chat');
  assert.equal(foreignError, 'Unknown result message in this chat', 'a foreign id must be indistinguishable from an unknown id');
  assert.equal(revisionKeys(f).length, 0); assert.equal(captureJournal(f), 0);
});

test('capture_review rejects invalid scopes and non-result messages with no effects', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'rev-invalid', 'evidence');
  // A non-result message in the same chat must be refused by the revision service.
  f.store.ingest(worker, { id: 'q-1', taskId: worker.taskId, workerId: worker.id, terminalId: worker.terminalId, kind: 'question', text: 'ask', createdAt: new Date().toISOString(), turn: 2 }, { lifecycle: true });
  await assert.rejects(f.call('capture_review', { result_id: 'rev-invalid', paths: [], request_id: 'r-empty' }), /Too few items: paths/);
  await assert.rejects(f.call('capture_review', { result_id: 'rev-invalid', paths: ['/etc/passwd'], request_id: 'r-abs' }), /project-relative/);
  await assert.rejects(f.call('capture_review', { result_id: 'rev-invalid', paths: ['a/../b'], request_id: 'r-dot' }), /must not contain empty/);
  await assert.rejects(f.call('capture_review', { result_id: 'rev-invalid', paths: ['alpha.txt'] }), /Missing request_id/);
  await assert.rejects(f.call('capture_review', { result_id: 'q-1', paths: ['alpha.txt'], request_id: 'r-question' }), /Only a result message/);
  assert.equal(revisionKeys(f).length, 0); assert.equal(captureJournal(f), 0);
});

test('capture_review replay is stable across a store reopen', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'rev-reopen', 'evidence');
  const args = { result_id: 'rev-reopen', paths: ['alpha.txt'], request_id: 'reopen-key' };
  const first = await f.call('capture_review', args);
  const reopened = new Store(f.path, { onJournal: () => {} });
  try {
    const replay = new RevisionReviews(reopened).captureReview({ threadId: THREAD, resultId: 'rev-reopen', paths: ['alpha.txt'], requestId: 'reopen-key' });
    assert.equal(replay.reviewId, first.review_id); assert.equal(replay.revisionSha256, first.revision_sha256);
  } finally { reopened.close(); }
  assert.equal(captureJournal(f), 1, 'a replay after reopen must not record a second capture');
});

const acceptJournal = f => f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='revision-review.accepted'").get().n;

test('verify_review reports no acceptance conservatively and never returns the manifest or report', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'v-none', 'V'.repeat(4096));
  const receipt = await f.call('verify_review', { result_id: 'v-none' });
  assert.equal(receipt.accepted, false); assert.equal(receipt.bound, false);
  assert.equal(receipt.verified, null); assert.equal(receipt.stale, false);
  assert.equal(receipt.reason, 'no-acceptance');
  assert.equal(receipt.result_id, 'v-none'); assert.equal(receipt.thread_id, THREAD);
  assert.equal(receipt.review_id, null);
  assert.equal(JSON.stringify(receipt).includes('alpha'), false);
  assert.equal(JSON.stringify(receipt).includes('V'.repeat(64)), false);
  for (const leaked of ['manifest', 'members', 'report', 'files_detail']) assert.equal(leaked in receipt, false);
  assert.equal(acceptJournal(f), 0);
});

test('verify_review reports a legacy unbound acceptance as bound=false and verified=null', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'v-legacy', 'evidence');
  // Legacy setup: an acceptance recorded before revision binding existed.
  f.store.recordAction('v-legacy', { kind: 'accept', text: 'ok', requestId: 'legacy-1' });
  const receipt = await f.call('verify_review', { result_id: 'v-legacy' });
  assert.equal(receipt.accepted, true); assert.equal(receipt.bound, false);
  assert.equal(receipt.verified, null); assert.equal(receipt.stale, false);
  assert.equal(receipt.reason, 'legacy-unbound-acceptance');
  assert.equal(receipt.request_id, 'legacy-1');
});

test('verify_review attests a fresh bound acceptance and marks an edited file stale while acceptance stays historical', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'v-bound', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'v-bound', paths: ['alpha.txt'], request_id: 'v-cap-1' });
  // Bound public acceptance is the next checkpoint; set up the accepted binding via the accepted library only.
  new RevisionReviews(f.store).acceptReview({ threadId: THREAD, resultId: 'v-bound', reviewId: captured.review_id, expectedRevision: captured.revision_sha256, requestId: 'v-acc-1', text: 'reviewed' });
  const fresh = await f.call('verify_review', { result_id: 'v-bound', review_id: captured.review_id });
  assert.equal(fresh.accepted, true); assert.equal(fresh.bound, true);
  assert.equal(fresh.verified, true); assert.equal(fresh.stale, false);
  assert.equal(fresh.reason, 'revision-verified');
  assert.equal(fresh.review_id, captured.review_id);
  assert.equal(fresh.expected_sha256, captured.revision_sha256);
  assert.equal(fresh.actual_sha256, captured.revision_sha256);
  assert.equal(fresh.changed_paths.count, 0);
  // Edit a reviewed file: the historical acceptance stays true, but current content is stale.
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha changed\n');
  const stale = await f.call('verify_review', { result_id: 'v-bound' });
  assert.equal(stale.accepted, true); assert.equal(stale.bound, true);
  assert.equal(stale.verified, false); assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'revision-changed');
  assert.equal(stale.changed_paths.count, 1);
  assert.ok(stale.changed_paths.preview.includes('alpha.txt'));
  assert.equal(stale.changed_paths.truncated, false);
  assert.notEqual(stale.actual_sha256, stale.expected_sha256);
  for (const leaked of ['manifest', 'members', 'report', 'files_detail']) assert.equal(leaked in stale, false);
});

test('verify_review refuses a mismatched or missing review conservatively without new state', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'v-mismatch', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'v-mismatch', paths: ['alpha.txt'], request_id: 'v-cap-2' });
  new RevisionReviews(f.store).acceptReview({ threadId: THREAD, resultId: 'v-mismatch', reviewId: captured.review_id, expectedRevision: captured.revision_sha256, requestId: 'v-acc-2', text: 'reviewed' });
  const acceptedBefore = acceptJournal(f);
  const mismatch = await f.call('verify_review', { result_id: 'v-mismatch', review_id: 'rv-' + '0'.repeat(48) });
  assert.equal(mismatch.accepted, true); assert.equal(mismatch.bound, true);
  assert.equal(mismatch.verified, false); assert.equal(mismatch.stale, true);
  assert.equal(mismatch.reason, 'review-id-mismatch');
  assert.equal(mismatch.review_id, captured.review_id);
  // Drop the durable review record: verification stays conservative and writes nothing.
  f.store.db.prepare('DELETE FROM metadata WHERE key = ?').run('revision-review:' + captured.review_id);
  const missing = await f.call('verify_review', { result_id: 'v-mismatch', review_id: captured.review_id });
  assert.equal(missing.accepted, true); assert.equal(missing.bound, true);
  assert.equal(missing.verified, false); assert.equal(missing.stale, true);
  assert.equal(missing.reason, 'review-record-missing');
  assert.equal(acceptJournal(f), acceptedBefore);
});

test('verify_review refuses foreign and unknown results with the same error and no state', async t => {
  const f = await fixture(t), mine = await f.spawn();
  const foreign = await f.spawn({ thread_id: OTHER, task_name: 'foreign' });
  ingestResult(f, f.store.worker(mine.agent_id), 'v-mine', 'mine');
  ingestResult(f, f.store.worker(foreign.agent_id), 'v-foreign', 'foreign');
  const before = { keys: revisionKeys(f).length, accepted: acceptJournal(f) };
  const unknownError = await f.call('verify_review', { result_id: 'does-not-exist' }).then(() => null, error => error.message);
  const foreignError = await f.call('verify_review', { result_id: 'v-foreign' }).then(() => null, error => error.message);
  assert.equal(unknownError, 'Unknown result message in this chat');
  assert.equal(foreignError, 'Unknown result message in this chat', 'a foreign id must be indistinguishable from an unknown id');
  assert.equal(revisionKeys(f).length, before.keys); assert.equal(acceptJournal(f), before.accepted);
});

test('capture_review and verify_review replay stably through a public adapter rebuilt on a reopened Store', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'v-reopen', 'evidence');
  const args = { result_id: 'v-reopen', paths: ['alpha.txt'], request_id: 'v-reopen-key' };
  const first = await f.call('capture_review', args);
  const reopened = new Store(f.path, { onJournal: () => {} });
  try {
    const adapter = new AgentTools({ store: reopened });
    const replay = await adapter.call('capture_review', { thread_id: THREAD, ...args });
    assert.equal(replay.review_id, first.review_id);
    assert.equal(replay.revision_sha256, first.revision_sha256);
    const verified = await adapter.call('verify_review', { thread_id: THREAD, result_id: 'v-reopen' });
    assert.equal(verified.accepted, false); assert.equal(verified.verified, null);
  } finally { reopened.close(); }
  assert.equal(captureJournal(f), 1, 'a public replay after reopen must not record a second capture');
});

test('AgentTools reuses an injected revision service only when bound to the same Store', async t => {
  const f = await fixture(t);
  const before = revisionKeys(f).length;
  const foreign = new Store(':memory:');
  try {
    assert.throws(() => new AgentTools({ store: f.store, reviews: new RevisionReviews(foreign) }), /reviews must be bound to the same Store/);
  } finally { foreign.close(); }
  assert.equal(revisionKeys(f).length, before, 'a refused injection must not touch the real store');
  const sameStore = new AgentTools({ store: f.store, reviews: new RevisionReviews(f.store) });
  assert.equal(sameStore.reviews.store, f.store);
});

test('verify_review bounds the changed-path preview and flags truncation without leaking the manifest', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  mkdirSync(join(f.project, 'many'));
  const files = [];
  for (let i = 0; i < 25; i++) { const name = `many/f${String(i).padStart(2, '0')}.txt`; files.push(name); writeFileSync(join(f.project, name), `v${i}\n`); }
  ingestResult(f, worker, 'v-many', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'v-many', paths: files, request_id: 'v-cap-many' });
  new RevisionReviews(f.store).acceptReview({ threadId: THREAD, resultId: 'v-many', reviewId: captured.review_id, expectedRevision: captured.revision_sha256, requestId: 'v-acc-many', text: 'reviewed' });
  for (let i = 0; i < 25; i++) writeFileSync(join(f.project, `many/f${String(i).padStart(2, '0')}.txt`), `changed-${i}\n`);
  const receipt = await f.call('verify_review', { result_id: 'v-many' });
  assert.equal(receipt.verified, false); assert.equal(receipt.stale, true);
  assert.equal(receipt.changed_paths.count, 25);
  assert.equal(receipt.changed_paths.preview.length, 20);
  assert.equal(receipt.changed_paths.truncated, true);
  assert.equal(JSON.stringify(receipt).includes('changed-'), false, 'the preview carries paths, never file contents');
});

const boundArgs = (captured, overrides = {}) => ({ action: 'accept', text: 'Reviewed the exact captured revision',
  request_id: 'b-acc', review_id: captured.review_id, expected_revision: captured.revision_sha256, ...overrides });

test('resolve_message binds a revision acceptance through the accepted library and verify_review attests it', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-happy', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'b-happy', paths: ['alpha.txt'], request_id: 'b-happy-cap' });
  // The unbound callback/CLI must never run for a bound acceptance.
  f.adapter.resolveMessage = async () => { throw new Error('bound acceptance must not use the unbound resolveMessage callback'); };
  const receipt = await f.call('resolve_message', { message_id: 'b-happy', ...boundArgs(captured, { request_id: 'b-happy-acc' }) });
  assert.equal(receipt.message_id, 'b-happy'); assert.equal(receipt.agent_id, agent.agent_id);
  assert.equal(receipt.acknowledged, true); assert.ok(receipt.acknowledged_at);
  assert.equal(receipt.action.kind, 'accept'); assert.equal(receipt.action.state, 'recorded'); assert.equal(receipt.action.request_id, 'b-happy-acc');
  assert.equal(receipt.review.review_id, captured.review_id); assert.equal(receipt.review.revision_sha256, captured.revision_sha256);
  assert.equal(receipt.replay, false); assert.equal(receipt.verified, true);
  assert.equal(acceptJournal(f), 1);
  const verified = await f.call('verify_review', { result_id: 'b-happy' });
  assert.equal(verified.accepted, true); assert.equal(verified.bound, true);
  assert.equal(verified.verified, true); assert.equal(verified.reason, 'revision-verified');
  assert.equal(verified.review_id, captured.review_id);
});

test('resolve_message refuses a bound acceptance when the reviewed files changed before it', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-drift', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'b-drift', paths: ['alpha.txt'], request_id: 'b-drift-cap' });
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha changed\n');
  await assert.rejects(f.call('resolve_message', { message_id: 'b-drift', ...boundArgs(captured, { request_id: 'b-drift-acc' }) }), /changed since capture/);
  assert.equal(f.store.message('b-drift').action, null);
  assert.equal(f.store.message('b-drift').acknowledgedAt, null);
  assert.equal(acceptJournal(f), 0);
});

test('a bound acceptance replays exactly after the files change and verify_review reports it stale', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-replay', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'b-replay', paths: ['alpha.txt'], request_id: 'b-replay-cap' });
  const args = { message_id: 'b-replay', ...boundArgs(captured, { request_id: 'b-replay-acc' }) };
  const first = await f.call('resolve_message', args);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha changed\n');
  const second = await f.call('resolve_message', args);
  assert.equal(second.acknowledged_at, first.acknowledged_at);
  assert.equal(second.replay, true);
  assert.equal(second.verified, null, 'an exact replay is historical only and never claims current verification');
  assert.equal(JSON.stringify(second).includes('alpha changed'), false);
  assert.equal(acceptJournal(f), 1, 'an exact replay must not record a second acceptance');
  const verified = await f.call('verify_review', { result_id: 'b-replay' });
  assert.equal(verified.accepted, true); assert.equal(verified.bound, true);
  assert.equal(verified.verified, false); assert.equal(verified.stale, true); assert.equal(verified.reason, 'revision-changed');
  // Conflicting replays are refused with no extra effects.
  await assert.rejects(f.call('resolve_message', { ...args, review_id: 'rv-' + '0'.repeat(48) }), /different review/);
  await assert.rejects(f.call('resolve_message', { ...args, expected_revision: '0'.repeat(64) }), /different revision/);
  await assert.rejects(f.call('resolve_message', { ...args, text: 'a different review' }), /Different acceptance text/);
  await assert.rejects(f.call('resolve_message', { ...args, request_id: 'b-replay-other' }), /different requestId/);
  assert.equal(acceptJournal(f), 1);
});

test('resolve_message never silently upgrades a legacy unbound acceptance', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-legacy', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'b-legacy', paths: ['alpha.txt'], request_id: 'b-legacy-cap' });
  f.store.recordAction('b-legacy', { kind: 'accept', text: 'legacy review', requestId: 'legacy-key' });
  await assert.rejects(f.call('resolve_message', { message_id: 'b-legacy', ...boundArgs(captured, { request_id: 'b-legacy-acc' }) }), /legacy unbound acceptance/);
  assert.equal(f.store.message('b-legacy').action.requestId, 'legacy-key');
  assert.equal(f.store.message('b-legacy').acknowledgedAt, null);
  assert.equal(acceptJournal(f), 0);
});

test('a bound acceptance that commits before a failed acknowledgement is acknowledged exactly once on a public retry', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-ack', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'b-ack', paths: ['alpha.txt'], request_id: 'b-ack-cap' });
  const args = { message_id: 'b-ack', ...boundArgs(captured, { request_id: 'b-ack-acc' }) };
  const original = f.store.ack.bind(f.store);
  let calls = 0;
  f.store.ack = () => { calls++; throw new Error('Acknowledgement transport failed'); };
  await assert.rejects(f.call('resolve_message', args), error => {
    const receipt = error.details?.receipt;
    assert.ok(receipt, 'a failed acknowledgement still reports the durable action');
    assert.equal(receipt.action.kind, 'accept'); assert.equal(receipt.action.state, 'recorded');
    assert.equal(receipt.acknowledged, false, 'the recovery receipt never invents an acknowledgement');
    assert.equal(receipt.review.review_id, captured.review_id);
    return true;
  });
  assert.equal(calls, 1);
  f.store.ack = original;
  assert.equal(f.store.message('b-ack').acknowledgedAt, null);
  assert.equal(acceptJournal(f), 1, 'the acceptance itself was durable');
  const reopened = new Store(f.path, { onJournal: () => {} });
  try {
    const adapter = new AgentTools({ store: reopened });
    const retried = await adapter.call('resolve_message', { thread_id: THREAD, ...args });
    assert.equal(retried.acknowledged, true);
    assert.equal(retried.replay, true); assert.equal(retried.verified, null);
    assert.equal(acceptJournal(f), 1);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='message.acknowledged'").get().n, 1);
  } finally { reopened.close(); }
});

test('resolve_message validates the binding pairing, action and request key before any effect', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-validate', 'evidence');
  const captured = await f.call('capture_review', { result_id: 'b-validate', paths: ['alpha.txt'], request_id: 'b-val-cap' });
  const base = { message_id: 'b-validate', ...boundArgs(captured, { request_id: 'b-val-acc' }) };
  // Pairing: one binding field without the other is refused.
  await assert.rejects(f.call('resolve_message', { message_id: 'b-validate', action: 'accept', text: 'Reviewed', request_id: 'b-val-acc', review_id: captured.review_id }), /must be supplied together/);
  await assert.rejects(f.call('resolve_message', { message_id: 'b-validate', action: 'accept', text: 'Reviewed', request_id: 'b-val-acc', expected_revision: captured.revision_sha256 }), /must be supplied together/);
  // Action: binding fields are valid only for a bound acceptance.
  await assert.rejects(f.call('resolve_message', { ...base, action: 'reply' }), /only valid for action:accept/);
  await assert.rejects(f.call('resolve_message', { ...base, action: 'abort' }), /only valid for action:accept/);
  // Key: a bound acceptance requires an explicit stable request_id.
  await assert.rejects(f.call('resolve_message', { message_id: 'b-validate', action: 'accept', text: 'Reviewed', review_id: captured.review_id, expected_revision: captured.revision_sha256 }), /explicit stable request_id/);
  // Malformed binding shapes are refused by validation before any effect.
  await assert.rejects(f.call('resolve_message', { ...base, review_id: 'not-a-review' }), /Invalid review_id/);
  await assert.rejects(f.call('resolve_message', { ...base, expected_revision: 'XYZ' }), /Invalid expected_revision/);
  assert.equal(f.store.message('b-validate').action, null);
  assert.equal(f.store.message('b-validate').acknowledgedAt, null);
  assert.equal(acceptJournal(f), 0);
});

test('resolve_message refuses a foreign or unknown bound result with the same error and no effect', async t => {
  const f = await fixture(t);
  const foreign = await f.spawn({ thread_id: OTHER, task_name: 'foreign' });
  ingestResult(f, f.store.worker(foreign.agent_id), 'b-foreign', 'foreign');
  const args = { action: 'accept', text: 'Reviewed', request_id: 'b-foreign-acc', review_id: 'rv-' + '0'.repeat(48), expected_revision: '0'.repeat(64) };
  const before = acceptJournal(f);
  const unknownError = await f.call('resolve_message', { message_id: 'does-not-exist', ...args }).then(() => null, error => error.message);
  const foreignError = await f.call('resolve_message', { message_id: 'b-foreign', ...args }).then(() => null, error => error.message);
  assert.equal(unknownError, 'Unknown manager message in this chat');
  assert.equal(foreignError, 'Unknown manager message in this chat', 'a foreign id must be indistinguishable from an unknown id');
  assert.equal(f.store.message('b-foreign').action, null);
  assert.equal(acceptJournal(f), before);
});

test('a bound acceptance returns a compact receipt without the manifest or report prose', async t => {
  const f = await fixture(t), agent = await f.spawn();
  const worker = f.store.worker(agent.agent_id);
  writeFileSync(join(f.project, 'alpha.txt'), 'alpha\n');
  ingestResult(f, worker, 'b-compact', 'R'.repeat(4096));
  const captured = await f.call('capture_review', { result_id: 'b-compact', paths: ['alpha.txt'], request_id: 'b-compact-cap' });
  const receipt = await f.call('resolve_message', { message_id: 'b-compact', ...boundArgs(captured, { request_id: 'b-compact-acc', text: 'S'.repeat(2048) }) });
  const json = JSON.stringify(receipt);
  assert.equal(json.includes('R'.repeat(64)), false);
  assert.equal(json.includes('S'.repeat(64)), false);
  assert.equal(json.includes('alpha'), false);
  for (const leaked of ['manifest', 'members', 'report', 'files_detail', 'revision', 'scopes']) assert.equal(leaked in receipt, false, `receipt must not expose ${leaked}`);
  assert.equal(receipt.review.review_id, captured.review_id);
  assert.deepEqual(Object.keys(receipt.review).sort(), ['bound', 'captured_at', 'provenance', 'review_id', 'revision_sha256', 'task_id', 'worker_id']);
});
