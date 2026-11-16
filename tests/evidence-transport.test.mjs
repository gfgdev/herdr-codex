import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { appendMessage, readMailbox } from '../src/mailbox.mjs';
import { AgentTools } from '../src/agent-tools.mjs';
import { Notifications } from '../src/notifications.mjs';
import {
  canonicalize, canonicalEvidence, validateMessageEvidence, exposeEvidence, EVIDENCE_AUTHORITY,
} from '../src/evidence-transport.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER = '01a1d3b4-f77e-7363-b682-5c40fbe482f4';
const cli = fileURLToPath(new URL('../src/message-cli.mjs', import.meta.url));
const hc = fileURLToPath(new URL('./fixtures/mailbox-hc.mjs', import.meta.url));

/** A valid evidence v1 claim for worker-1 / task-1. */
function evidence(extra = {}) {
  return {
    version: 1, worker_id: 'worker-1', task_id: 'task-1', session_generation_id: 'gen-7',
    baseline_revision: null,
    final_revision: { sha256: 'a'.repeat(64), project: 'src/evidence-transport.mjs' },
    changed_paths: ['src/a.mjs'],
    artifacts: [{ path: 'out/log.txt', sha256: 'b'.repeat(64) }],
    tests: [{ argv: ['node', '--test'], cwd: '.', exit_code: 0, output_path: 'out/log.txt', truncated: false }],
    limitations: ['worker claim, not proof'], unresolved_requests: [], ...extra,
  };
}
const reverseKeys = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]))
  : value;

/* ------------------------------------------------------------------ *
 * message-cli / durable outbox path (reuses the mailbox-hc fixture)
 * ------------------------------------------------------------------ */
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = { version: 1, id: 'worker-1', taskId: 'task-1', name: 'test-agent', project: root,
    stateDir: join(root, 'worker'), hc, mailbox: 'test-inbox' };
  mkdirSync(worker.stateDir);
  const config = join(worker.stateDir, 'worker.json');
  const native = join(root, 'native.json');
  const log = join(root, 'requests.jsonl');
  writeFileSync(config, JSON.stringify(worker));
  writeFileSync(native, JSON.stringify({
    terminal: { name: worker.name, cwd: worker.project, turn: 2, labels: { 'codex.worker': worker.id, 'codex.task': worker.taskId } },
    doc: { value: null, version: 0 } }));
  writeFileSync(log, '');
  const evidenceFile = (value, name = `evidence-${Math.random().toString(16).slice(2)}.json`) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  return {
    root, worker, evidenceFile,
    env: { ...process.env, HERDR_CODEX_WORKER_CONFIG: config, HC_TERMINAL_ID: 't7',
      HERDR_TEST_MAILBOX_STATE: native, HERDR_TEST_MAILBOX_LOG: log },
    state: () => JSON.parse(readFileSync(native, 'utf8')),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    receipts: () => {
      const dir = join(worker.stateDir, 'runtime/message-outbox');
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')));
    },
  };
}

function run(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr,
      result: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null }));
  });
}
const baseArgs = ['--kind', 'result', '--text', 'Evidence attached.', '--idempotency-key', 'ev-1'];

test('plain-text messages stay compatible and carry no evidence fields', async t => {
  const f = setup(t);
  const result = await run(f.env, baseArgs);
  assert.equal(result.code, 0, result.stderr);
  const [stored] = f.state().doc.value.messages;
  assert.equal(stored.evidence, undefined);
  assert.deepEqual(f.receipts()[0].message, stored);
});

test('valid worker claims roundtrip unchanged through outbox and native mailbox', async t => {
  const f = setup(t);
  const claim = evidence();
  const result = await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(claim)]);
  assert.equal(result.code, 0, result.stderr);
  const [stored] = f.state().doc.value.messages;
  assert.deepEqual(stored.evidence, claim);
  // The validator's normalized authority tag must never be persisted as a field.
  assert.equal('authority' in stored.evidence, false);
  assert.deepEqual(f.receipts()[0].message.evidence, claim);
  // Exactly one durable native write.
  assert.equal(f.calls().filter(call => call.method === 'doc.set').length, 1);
});

test('same ID + same evidence in a different key order replays as a duplicate', async t => {
  const f = setup(t);
  const claim = evidence();
  assert.equal((await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(claim)])).code, 0);
  const replay = await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(reverseKeys(claim))]);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(replay.result.duplicate, true);
  assert.equal(f.calls().filter(call => call.method === 'doc.set').length, 1);
  assert.equal(f.state().doc.value.messages.length, 1);
});

test('same ID with changed evidence conflicts before any native write', async t => {
  const f = setup(t);
  assert.equal((await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(evidence())])).code, 0);
  const changed = await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(evidence({ final_revision: { sha256: 'c'.repeat(64), project: 'src/evidence-transport.mjs' } }))]);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /different message/);
  assert.equal(f.calls().filter(call => call.method === 'doc.set').length, 1);
  assert.equal(f.receipts().length, 1);
});

test('malformed, forged, mismatched and oversized evidence fail before the outbox', async t => {
  const f = setup(t);
  const cases = [
    ['unknown field', evidence({ authority: 'verified' }), /Unknown worker evidence field/],
    ['worker mismatch', evidence({ worker_id: 'worker-2' }), /worker_id does not match/],
    ['task mismatch', evidence({ task_id: 'task-9' }), /task_id does not match/],
    ['wrong version', evidence({ version: 2 }), /version must be 1/],
  ];
  for (const [name, claim, pattern] of cases) {
    const result = await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(claim)]);
    assert.equal(result.code, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, pattern, name);
  }
  // Valid but serialized over the evidence byte budget.
  const huge = evidence({ changed_paths: Array.from({ length: 8192 }, (_, i) => `p/${i}/${'x'.repeat(160)}`) });
  const oversized = await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(huge)]);
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /exceeds the 1048576-byte serialized limit/);
  assert.equal(f.calls().filter(call => call.method === 'doc.set').length, 0);
  assert.equal(f.receipts().length, 0);
});

test('the envelope budget fails explicitly instead of truncating or hiding a message', async t => {
  const f = setup(t);
  // Evidence stays under its own validator limit but admitted text pushes the
  // whole envelope past the mailbox budget.
  const claim = evidence({ changed_paths: Array.from({ length: 6300 }, (_, i) => `p/${i}/${'x'.repeat(150)}`) });
  const result = await run(f.env, ['--kind', 'result', '--text', 'y'.repeat(65_000), '--idempotency-key', 'ev-big', '--evidence-file', f.evidenceFile(claim)]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /envelope exceeds the mailbox size budget/);
  assert.equal(f.calls().filter(call => call.method === 'doc.set').length, 0);
  assert.equal(f.receipts().length, 0);
});

test('evidence is never executed or dereferenced: argv and artifact/output paths are inert', async t => {
  const f = setup(t);
  const trap = join(f.root, 'EXECUTED');
  const claim = evidence({
    artifacts: [{ path: 'does/not/exist.bin', sha256: 'd'.repeat(64) }],
    tests: [{ argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(trap)}, 'x')`], cwd: '.', exit_code: 0, output_path: 'missing/output.txt', truncated: false }],
  });
  const result = await run(f.env, [...baseArgs, '--evidence-file', f.evidenceFile(claim)]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(trap), false);
  assert.deepEqual(f.state().doc.value.messages[0].evidence.tests, claim.tests);
});

/* ------------------------------------------------------------------ *
 * Direct module-level contracts
 * ------------------------------------------------------------------ */
test('canonicalization is stable and key-order independent', () => {
  const claim = evidence();
  assert.equal(canonicalEvidence(claim), canonicalEvidence(reverseKeys(claim)));
  assert.deepEqual(canonicalize({ b: { d: 1, c: 2 }, a: 3 }), { a: 3, b: { c: 2, d: 1 } });
});

test('validateMessageEvidence returns raw claims, binds identity, rejects unknowns', () => {
  const claim = evidence();
  assert.equal(validateMessageEvidence(claim, { workerId: 'worker-1', taskId: 'task-1' }), claim);
  assert.equal(validateMessageEvidence(undefined), null);
  assert.throws(() => validateMessageEvidence(evidence({ worker_id: 'other' }), { workerId: 'worker-1' }), /worker_id/);
  assert.throws(() => validateMessageEvidence(evidence({ task_id: 'other' }), { taskId: 'task-1' }), /task_id/);
  assert.throws(() => validateMessageEvidence(evidence({ authority: 'verified' })), /Unknown worker evidence field/);
});

test('exposeEvidence labels worker claims separately and stays null when absent', () => {
  const claim = evidence();
  assert.deepEqual(exposeEvidence(claim), { evidence: claim, evidence_authority: EVIDENCE_AUTHORITY });
  assert.deepEqual(exposeEvidence(undefined), { evidence: null, evidence_authority: null });
  assert.deepEqual(exposeEvidence(null), { evidence: null, evidence_authority: null });
});

/* ------------------------------------------------------------------ *
 * Mailbox boundary
 * ------------------------------------------------------------------ */
function clientStore() {
  let state = { value: null, version: 0 };
  const calls = [];
  return {
    calls,
    state: () => structuredClone(state),
    replace: value => { state = { value, version: state.version + 1 }; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'doc.get') return structuredClone(state);
      assert.equal(method, 'doc.set');
      if (params.version !== state.version) throw Object.assign(new Error('stale'), { code: -32000, data: { kind: 'conflict' } });
      state = { version: state.version + 1, value: structuredClone(params.value) };
      return { version: state.version };
    },
  };
}
const mbWorker = { id: 'worker-1', taskId: 'task-1', mailbox: 'cm-inbox-t7' };
const mbMessage = (id = 'm1', extra = {}) => ({ id, taskId: mbWorker.taskId, workerId: mbWorker.id, terminalId: 't7',
  kind: 'result', text: 'Evidence attached.', createdAt: '2026-11-13T00:00:00.000Z', turn: 2, ...extra });

test('mailbox preserves raw evidence and label-free storage', async () => {
  const client = clientStore();
  const claim = evidence();
  const first = await appendMessage(client, mbWorker, mbMessage('m1', { evidence: claim }));
  assert.equal(first.duplicate, false);
  const read = await readMailbox(client, mbWorker.mailbox);
  assert.deepEqual(read.messages[0].evidence, claim);
  assert.equal('authority' in read.messages[0].evidence, false);
});

test('mailbox idempotency covers evidence: reordered replay duplicates, changed conflicts', async () => {
  const client = clientStore();
  const claim = evidence();
  await appendMessage(client, mbWorker, mbMessage('m1', { evidence: claim }));
  const replay = await appendMessage(client, mbWorker, mbMessage('m1', { evidence: reverseKeys(claim) }));
  assert.equal(replay.duplicate, true);
  await assert.rejects(appendMessage(client, mbWorker, mbMessage('m1', { evidence: evidence({ session_generation_id: 'gen-8' }) })),
    { code: 'MAILBOX_ID_CONFLICT' });
  assert.equal(client.calls.filter(c => c.method === 'doc.set').length, 1);
});

test('mailbox rejects malformed, forged and mismatched evidence before any write', async () => {
  const client = clientStore();
  for (const bad of [evidence({ authority: 'verified' }), evidence({ worker_id: 'worker-2' }), evidence({ task_id: 'task-9' })]) {
    await assert.rejects(appendMessage(client, mbWorker, mbMessage('m1', { evidence: bad })), { code: 'MAILBOX_INVALID' });
  }
  assert.equal(client.calls.filter(c => c.method === 'doc.set').length, 0);
});

/* ------------------------------------------------------------------ *
 * Durable Store
 * ------------------------------------------------------------------ */
const task = { id: 'task-1', name: 'Real checkout repair', project: '/private/project', threadId: THREAD, status: 'active' };
const worker = { id: 'worker-1', taskId: task.id, name: 'pi-work', role: 'pi', project: task.project, terminalId: 't7', mailbox: 'cx-worker-1' };
const storeMessage = (id = 'result-1', extra = {}) => ({ id, taskId: task.id, workerId: worker.id, terminalId: worker.terminalId,
  kind: 'result', text: 'Evidence attached.', createdAt: '2026-11-13T00:00:00.000Z', turn: 1, ...extra });

function storeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-evidence-store-'));
  const path = join(dir, 'manager.sqlite');
  let store = new Store(path);
  store.saveTask(task); store.saveWorker(worker);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, get store() { return store; }, reopen() { store.close(); store = new Store(path); return store; } };
}

test('durable Store preserves evidence and is idempotent only for identical claims', async t => {
  const f = storeFixture(t);
  const claim = evidence();
  assert.equal(f.store.ingest(worker, storeMessage('r1', { evidence: claim })), true);
  assert.deepEqual(f.store.message('r1').evidence, claim);
  assert.equal(f.store.ingest(worker, storeMessage('r1', { evidence: reverseKeys(claim) })), false);
  assert.throws(() => f.store.ingest(worker, storeMessage('r1', { evidence: evidence({ session_generation_id: 'gen-8' }) })), /different contents/);
  assert.equal(f.store.messages().length, 1);
});

test('durable evidence conflict survives a restart and pruning of the mailbox', async t => {
  const f = storeFixture(t);
  assert.equal(f.store.ingest(worker, storeMessage('r1', { evidence: evidence() })), true);
  f.reopen();
  assert.equal(f.store.ingest(worker, storeMessage('r1', { evidence: evidence() })), false);
  assert.throws(() => f.store.ingest(worker, storeMessage('r1', { evidence: evidence({ limitations: ['changed'] }) })), /different contents/);
});

test('Store rejects mismatched/malformed evidence without recording a row', async t => {
  const f = storeFixture(t);
  for (const bad of [evidence({ worker_id: 'worker-2' }), evidence({ task_id: 'task-9' }), evidence({ authority: 'verified' })]) {
    assert.throws(() => f.store.ingest(worker, storeMessage('r-bad', { evidence: bad })));
  }
  assert.equal(f.store.messages().length, 0);
});

test('evidence-absent messages keep their historical fingerprint across restart', async t => {
  const f = storeFixture(t);
  assert.equal(f.store.ingest(worker, storeMessage('plain')), true);
  f.reopen();
  assert.equal(f.store.ingest(worker, storeMessage('plain')), false);
  assert.throws(() => f.store.ingest(worker, storeMessage('plain', { text: 'Different' })), /different contents/);
});

/* ------------------------------------------------------------------ *
 * Read adapters: bounded worker-claims metadata by default, raw claim only on
 * explicit opt-in (include_reports / legacy / packet detail page)
 * ------------------------------------------------------------------ */
function adapters(t, { notifications = true, resolveMessage } = {}) {
  const f = storeFixture(t);
  const delegation = {
    worker: (id) => f.store.worker(id),
    list: ({ threadId } = {}) => f.store.workers().filter(w => !threadId || f.store.task(w.taskId)?.threadId === threadId),
    verify: async () => {},
    read: async (id) => ({ agentId: id, screen: 'line one\nline two', native: { address: 't7' } }),
  };
  const config = { stateDir: f.path, path: '/cfg', packageRoot: '/pkg' };
  const notices = notifications ? new Notifications({ store: f.store, config }) : null;
  const tools = new AgentTools({ config, store: f.store, delegation, notices, resolveMessage });
  return { ...f, tools, notices };
}

test('read_agent returns bounded worker-claims metadata and the full report only on explicit include_reports', async t => {
  const f = adapters(t);
  f.store.ingest(worker, storeMessage('r1', { evidence: evidence(), text: 'x'.repeat(600) }));
  const bounded = await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id });
  const [entry] = bounded.messages;
  assert.equal(entry.message_id, 'r1');
  // Bounded claim metadata (digest/bytes/revision/bounded refs), not the raw claim.
  assert.equal(entry.evidence_authority, EVIDENCE_AUTHORITY);
  assert.equal(entry.evidence.version, 1);
  assert.equal(entry.evidence.final_revision.sha256, 'a'.repeat(64));
  assert.equal(entry.evidence.final_revision.project, 'src/evidence-transport.mjs');
  assert.equal(entry.evidence.session_generation_id, 'gen-7');
  assert.match(entry.evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.evidence.references_dereferenced, false);
  assert.equal(entry.evidence.truncated, false);
  assert.deepEqual(entry.evidence.changed_paths.items, ['src/a.mjs']);
  assert.equal(entry.evidence.changed_paths.count, 1);
  assert.deepEqual(entry.evidence.artifacts.items, [{ path: 'out/log.txt', sha256: 'b'.repeat(64), clipped: false }]);
  assert.equal(entry.evidence.tests.items[0].output_path, 'out/log.txt');
  assert.equal('authority' in entry.evidence, false);
  assert.ok(!JSON.stringify(entry.evidence).includes('argv'), 'bounded claim does not echo raw test argv');
  // The default read is bounded: identity + claim + clipped preview, no full body.
  assert.equal(entry.text_bytes, 600);
  assert.equal(entry.text_truncated, true);
  assert.equal(entry.text_preview.length < 600, true);
  assert.equal('text' in entry, false);
  const full = await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id, include_reports: true });
  assert.equal(full.reports_included, true);
  assert.equal(full.messages[0].text, 'x'.repeat(600));
  assert.deepEqual(full.messages[0].evidence, evidence());
  assert.equal(full.messages[0].evidence_authority, EVIDENCE_AUTHORITY);
});

test('receive_notification carries revision identity and bounded refs; raw claim stays on demand', async t => {
  const f = adapters(t);
  f.store.ingest(worker, storeMessage('r1', { evidence: evidence(), text: 'z'.repeat(4000) }));
  const notification = f.notices.create(THREAD, f.store.messages({ pending: true }));
  const summary = await f.tools.call('receive_notification', { thread_id: THREAD, notification_id: notification.id });
  assert.deepEqual(summary.report_ids, ['r1']);
  assert.equal(summary.count, 1);
  assert.equal(summary.evidence_only, true);
  assert.equal(summary.actionable, true);
  assert.equal(summary.provenance.authority, 'worker-claims');
  assert.equal(summary.provenance.untrusted, true);
  assert.equal(summary.provenance.terminal_verified, false);
  assert.equal('messages' in summary, false);
  const member = summary.members[0];
  assert.equal(member.message_id, 'r1');
  // Revision identity and bounded refs are visible on the compact path.
  assert.equal(member.evidence.final_revision.sha256, 'a'.repeat(64));
  assert.equal(member.evidence.baseline_revision, null);
  assert.equal(member.evidence.session_generation_id, 'gen-7');
  assert.equal(member.evidence.changed_paths.items.includes('src/a.mjs'), true);
  assert.equal(member.evidence_authority, EVIDENCE_AUTHORITY);
  assert.equal(member.evidence.references_dereferenced, false);
  // Still no report prose and no raw claim arrays on the compact path.
  assert.ok(!JSON.stringify(summary).includes('z'.repeat(64)));
  assert.ok(!JSON.stringify(member.evidence).includes('argv'));
  // Bounded evidence/revision references remain reachable by explicit detail page.
  const page = await f.tools.call('read_review_packet', { thread_id: THREAD, batch_id: summary.batch_id, include_detail: true, max_bytes: 8192 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].message_id, 'r1');
  assert.equal(page.items[0].summary.truncated, true);
  assert.ok(page.items[0].refs.evidence.items.includes('out/log.txt'));
  assert.ok(page.items[0].refs.evidence.items.includes('src/evidence-transport.mjs'));
});

test('legacy receive mode still exposes the raw evidence projection with its claim label', async t => {
  const f = adapters(t);
  f.store.ingest(worker, storeMessage('r1', { evidence: evidence() }));
  const notification = f.notices.create(THREAD, f.store.messages({ pending: true }));
  const result = await f.tools.call('receive_notification', { thread_id: THREAD, notification_id: notification.id, legacy: true });
  const [entry] = result.messages;
  assert.deepEqual(entry.evidence, evidence());
  assert.equal(entry.evidence_authority, EVIDENCE_AUTHORITY);
  assert.equal('authority' in entry.evidence, false);
});

test('evidence-absent messages surface null evidence and null authority', async t => {
  const f = adapters(t);
  f.store.ingest(worker, storeMessage('r1'));
  const result = await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id });
  assert.equal(result.messages[0].evidence, null);
  assert.equal(result.messages[0].evidence_authority, null);
  const notification = f.notices.create(THREAD, f.store.messages({ pending: true }));
  const summary = await f.tools.call('receive_notification', { thread_id: THREAD, notification_id: notification.id });
  assert.equal(summary.members[0].evidence, null);
  assert.equal(summary.members[0].evidence_authority, null);
  assert.equal(summary.provenance.authority, 'worker-claims');
});

test('substantial structured evidence stays bounded by default and matches the raw claim only on opt-in', async t => {
  const f = adapters(t);
  const claim = evidence({
    changed_paths: Array.from({ length: 2000 }, (_, i) => `src/${i}-${'p'.repeat(120)}.mjs`),
    artifacts: Array.from({ length: 100 }, (_, i) => ({ path: `out/artifact-${i}.log`, sha256: 'c'.repeat(64) })),
    tests: Array.from({ length: 60 }, (_, i) => ({ argv: ['node', '--test'], cwd: '.', exit_code: 0, output_path: `out/test-${i}.log`, truncated: false })),
    limitations: Array.from({ length: 60 }, (_, i) => `limitation ${i} ${'l'.repeat(300)}`),
  });
  f.store.ingest(worker, storeMessage('r-big', { evidence: claim, text: 'q'.repeat(3000) }));
  const rawBytes = Buffer.byteLength(JSON.stringify(claim));
  const bounded = await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id });
  const entry = bounded.messages[0];
  const boundedBytes = Buffer.byteLength(JSON.stringify(entry));
  assert.ok(boundedBytes < rawBytes / 4, `bounded ${boundedBytes}B must stay far below raw ${rawBytes}B`);
  // Counts/clipping/truncation are explicit; refs are sampled, never dereferenced.
  assert.equal(entry.evidence.changed_paths.count, 2000);
  assert.equal(entry.evidence.changed_paths.items.length, 8);
  assert.equal(entry.evidence.changed_paths.dropped, 1992);
  assert.equal(entry.evidence.changed_paths.truncated, true);
  assert.equal(entry.evidence.artifacts.count, 100);
  assert.equal(entry.evidence.artifacts.items.length, 8);
  assert.equal(entry.evidence.tests.count, 60);
  assert.equal(entry.evidence.tests.items.length, 8);
  assert.ok(entry.evidence.limitations.clipped > 0);
  assert.equal(entry.evidence.truncated, true);
  assert.equal(entry.evidence.references_dereferenced, false);
  // The digest/byte count describe the raw canonical claim exactly once (no double encoding).
  const canonical = canonicalEvidence(claim);
  assert.equal(entry.evidence.bytes, Buffer.byteLength(canonical, 'utf8'));
  assert.equal(entry.evidence.sha256, createHash('sha256').update(canonical, 'utf8').digest('hex'));
  assert.equal(entry.evidence.final_revision.sha256, 'a'.repeat(64));
  // The compact inbox path is bounded too and still carries revision identity.
  const notification = f.notices.create(THREAD, f.store.messages({ pending: true }));
  const summary = await f.tools.call('receive_notification', { thread_id: THREAD, notification_id: notification.id });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < rawBytes / 4);
  assert.equal(summary.members[0].evidence.final_revision.sha256, 'a'.repeat(64));
  assert.equal(summary.members[0].evidence.changed_paths.count, 2000);
  // Exactly the raw claim is returned only on explicit opt-in.
  const full = await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id, include_reports: true });
  assert.deepEqual(full.messages[0].evidence, claim);
});

test('over-long artifact and test refs are flagged and aggregated even when the outer count is below the limit', async t => {
  const f = adapters(t);
  // Only one artifact and one test: a small outer count must not mask a clipped path.
  const longPath = `out/${'p'.repeat(244)}.log`;
  const longCwd = `${'q'.repeat(260)}/dir`;
  const claim = evidence({
    artifacts: [{ path: longPath, sha256: 'd'.repeat(64) }],
    tests: [{ argv: ['node', '--test'], cwd: longCwd, exit_code: 0, output_path: longPath, truncated: false }],
  });
  f.store.ingest(worker, storeMessage('r-long', { evidence: claim }));
  const entry = (await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id })).messages[0];
  assert.equal(entry.evidence.artifacts.count, 1);
  assert.equal(entry.evidence.artifacts.items.length, 1);
  assert.equal(entry.evidence.artifacts.truncated, true);
  assert.equal(entry.evidence.artifacts.items[0].clipped, true);
  assert.ok(Buffer.byteLength(entry.evidence.artifacts.items[0].path, 'utf8') <= 200);
  assert.equal(entry.evidence.tests.count, 1);
  assert.equal(entry.evidence.tests.truncated, true);
  assert.equal(entry.evidence.tests.items[0].clipped, true);
  assert.ok(Buffer.byteLength(entry.evidence.tests.items[0].output_path, 'utf8') <= 200);
  assert.equal(entry.evidence.truncated, true);
  // Multi-byte clipping stays valid UTF-8 and does not split a code point.
  const wide = evidence({ changed_paths: ['\u00e9'.repeat(400)] });
  f.store.ingest(worker, storeMessage('r-wide', { evidence: wide }));
  const wideEntry = (await f.tools.call('read_agent', { thread_id: THREAD, target: worker.id })).messages.find(m => m.message_id === 'r-wide');
  assert.equal(wideEntry.evidence.changed_paths.truncated, true);
  const clippedWide = wideEntry.evidence.changed_paths.items[0];
  assert.ok(Buffer.byteLength(clippedWide, 'utf8') <= 200);
  assert.equal(Buffer.from(clippedWide, 'utf8').toString('utf8'), clippedWide);
  assert.ok(!clippedWide.includes('\uFFFD'));
});

test('resolve_message never leaks a recovery receipt for foreign, non-host or missing messages', async t => {
  const calls = [];
  const uncertain = async (message, action) => {
    calls.push(message.id);
    f.store.recordAction(message.id, action);
    f.store.setActionState(message.id, 'uncertain', { error: 'Lost send receipt' });
    throw new Error('Native reply returned no delivery receipt; inspect the terminal before retrying');
  };
  const f = adapters(t, { resolveMessage: uncertain });
  const foreignTask = { id: 'task-2', name: 'Other', project: '/other', threadId: OTHER, status: 'active' };
  const foreignWorker = { id: 'worker-2', taskId: 'task-2', name: 'other', role: 'pi', project: '/other', terminalId: 't8', mailbox: 'cx-worker-2' };
  f.store.saveTask(foreignTask); f.store.saveWorker(foreignWorker);
  f.store.ingest(foreignWorker, { id: 'foreign-1', taskId: 'task-2', workerId: 'worker-2', terminalId: 't8',
    kind: 'result', text: 'foreign chat report', createdAt: '2026-11-13T00:00:00.000Z', turn: 1 });
  for (const id of ['foreign-1', 'missing-1']) {
    const err = await f.tools.call('resolve_message', { thread_id: THREAD, message_id: id, action: 'reply', text: 'ok' }).then(() => null, e => e);
    assert.match(err.message, /Unknown manager message in this chat/);
    assert.equal(err.details.receipt, undefined);
    assert.equal(JSON.stringify(err.details).includes('worker-2'), false);
    assert.equal(JSON.stringify(err.details).includes('foreign'), false);
  }
  // A supervised worker's message in this chat is not host-eligible either.
  const supervised = { id: 'worker-3', taskId: 'task-1', name: 'sub', role: 'pi', project: task.project, terminalId: 't9', mailbox: 'cx-worker-3', supervisorId: 'worker-1' };
  f.store.saveWorker(supervised);
  f.store.ingest(supervised, { id: 'sub-1', taskId: 'task-1', workerId: 'worker-3', terminalId: 't9', kind: 'result', text: 'sub report', createdAt: '2026-11-13T00:00:00.000Z', turn: 1 });
  const hostErr = await f.tools.call('resolve_message', { thread_id: THREAD, message_id: 'sub-1', action: 'reply', text: 'ok' }).then(() => null, e => e);
  assert.match(hostErr.message, /Unknown manager message in this chat/);
  assert.equal(hostErr.details.receipt, undefined);
  // A same-chat host reply that fails still reports truthful, separate deliveries.
  f.store.ingest(worker, storeMessage('host-1'));
  const err = await f.tools.call('resolve_message', { thread_id: THREAD, message_id: 'host-1', action: 'reply', text: 'answer' }).then(() => null, e => e);
  assert.match(err.message, /no delivery receipt/);
  assert.equal(err.details.receipt.message_id, 'host-1');
  assert.equal(err.details.receipt.acknowledged, false);
  assert.equal(err.details.receipt.report_delivery.state, 'pending');
  assert.equal(err.details.receipt.reply_delivery.state, 'uncertain');
  assert.deepEqual(calls, ['host-1']);
  assert.equal(JSON.stringify(err.details).toLowerCase().includes('answer'), false);
});
