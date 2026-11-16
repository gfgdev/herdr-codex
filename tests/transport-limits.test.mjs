import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { MAX_TEXT_BYTES } from '../src/evidence-transport.mjs';

const cli = fileURLToPath(new URL('../src/message-cli.mjs', import.meta.url));
const hc = fileURLToPath(new URL('./fixtures/mailbox-hc.mjs', import.meta.url));

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const task = { id: 'task-1', name: 'Repair browser persistence', project: '/private/project', threadId: THREAD, status: 'active' };
const worker = { id: 'worker-1', taskId: task.id, name: 'pi-work', role: 'pi', project: task.project, terminalId: 't7', mailbox: 'cx-worker-1', startTurn: 0 };

const validEvidence = {
  version: 1, worker_id: worker.id, task_id: task.id, session_generation_id: 'gen-7',
  baseline_revision: null, final_revision: null, changed_paths: [], artifacts: [], tests: [],
  limitations: [], unresolved_requests: [],
};
const message = (id, extra = {}) => ({
  id, taskId: task.id, workerId: worker.id, terminalId: worker.terminalId, kind: 'progress',
  text: `report ${id}`, createdAt: '2026-11-13T00:00:00.000Z', turn: 1, ...extra,
});

// A CAS-capable native doc store matching the mailbox module's contract. It is
// intentionally the same shape the real Bridge talks to through HerdrClient.
function native() {
  const documents = new Map(), calls = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  let beforeSet, failNextSet;
  const put = (name, value) => documents.set(name, { version: (documents.get(name)?.version ?? 0) + 1, value: clone(value) });
  return {
    documents, calls, put,
    beforeSet(fn) { beforeSet = fn; },
    failNextSet(error) { failNextSet = error; },
    async request(method, params) {
      calls.push({ method, params: clone(params) });
      if (method === 'doc.get') return clone(documents.get(params.name) ?? { version: 0, value: null });
      if (method === 'doc.set') {
        if (failNextSet) { const error = failNextSet; failNextSet = undefined; throw error; }
        if (beforeSet) { const fn = beforeSet; beforeSet = undefined; await fn(params); }
        if (params.version !== (documents.get(params.name)?.version ?? 0)) {
          throw Object.assign(new Error('conflict'), { data: { kind: 'conflict' } });
        }
        put(params.name, params.value);
        return { version: documents.get(params.name).version };
      }
      throw new Error(`Unexpected native method ${method}`);
    },
  };
}

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'herdr-limits-'));
  const config = { version: 1, stateDir, path: join(stateDir, 'config.json'), packageRoot: '/integration', hc: '/fake/hc', codex: '/fake/codex', registryDoc: 'cx-reg-test' };
  const queue = { async list() { return []; }, async add() { throw new Error('queue is not used by syncWorker'); }, async update() {}, async delete() {}, close() {} };
  const bridge = new Bridge(config, { clientFactory: () => { throw new Error('Bridge.start is not used in this test'); }, queue });
  bridge.store.saveTask(task);
  bridge.store.saveWorker(worker);
  const rpc = native();
  bridge.rpc = rpc;
  t.after(async () => { try { bridge.store.close(); } catch { /* already closed by a restart test */ } await rm(stateDir, { recursive: true, force: true }); });
  return { bridge, rpc, config, stateDir, queue };
}

const incidents = bridge => bridge.store.messages({ taskId: task.id }).filter(m => m.attention?.reason === 'rejected_report');
const mailboxIds = rpc => (rpc.documents.get(worker.mailbox)?.value.messages ?? []).map(m => m.id);

test('a legacy oversized mailbox report is archived per entry and does not hide the valid follower', async t => {
  const f = await fixture(t);
  const oversize = message('legacy-big', { text: 'z'.repeat(MAX_TEXT_BYTES + 4096) });
  const follower = message('valid-follower');
  f.rpc.put(worker.mailbox, { version: 1, messages: [oversize, follower] });

  await f.bridge.syncWorker(worker);

  // The oversized entry was classified, archived with its original bytes, and
  // pruned; the following valid report still ingested normally.
  assert.equal(f.bridge.store.message('valid-follower').kind, 'progress');
  assert.equal(f.bridge.store.message('legacy-big'), null);
  const [archived] = f.bridge.store.quarantines({ taskId: task.id });
  assert.equal(archived.reportId, 'legacy-big');
  assert.equal(archived.code, 'REPORT_INVALID');
  assert.equal(archived.bytes, Buffer.byteLength(JSON.stringify(oversize)));
  assert.equal(f.bridge.store.quarantineEntry(archived.id).message.text.length, oversize.text.length);
  assert.equal(incidents(f.bridge).length, 1);
  assert.deepEqual(mailboxIds(f.rpc), []);
});

test('malformed evidence is archived per entry and later valid reports still process', async t => {
  const f = await fixture(t);
  const bad = message('bad-evidence', { evidence: { ...validEvidence, unknown_field: true } });
  const good = message('good-evidence', { evidence: validEvidence, kind: 'question' });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad, good] });

  await f.bridge.syncWorker(worker);

  assert.equal(f.bridge.store.message('good-evidence').delivery, 'pending');
  assert.equal(f.bridge.store.message('bad-evidence'), null);
  const list = f.bridge.store.quarantines({ taskId: task.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].reportId, 'bad-evidence');
  assert.match(list[0].reason, /Unknown worker evidence field/);
  assert.deepEqual(mailboxIds(f.rpc), []);
});

test('replaying a rejected report after pruning is idempotent and does not duplicate the archive or incident', async t => {
  const f = await fixture(t);
  const bad = message('bad-replay', { evidence: { ...validEvidence, final_revision: { sha256: 'not-a-hash' } } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });
  await f.bridge.syncWorker(worker);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(incidents(f.bridge).length, 1);

  // Re-seed the identical payload (as a crash replay would) and sync again.
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });
  await f.bridge.syncWorker(worker);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(incidents(f.bridge).length, 1);
  assert.deepEqual(mailboxIds(f.rpc), []);
});

test('the same report ID with different bytes is retained as a distinct archive', async t => {
  const f = await fixture(t);
  const first = message('conflict-id', { evidence: { ...validEvidence, unknown_field: 1 } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [first] });
  await f.bridge.syncWorker(worker);
  const [archived] = f.bridge.store.quarantines({ taskId: task.id });

  // A different payload under the same report id must not overwrite the archive.
  const second = message('conflict-id', { text: 'different payload', evidence: { ...validEvidence, unknown_field: 2 } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [second] });
  await f.bridge.syncWorker(worker);
  const list = f.bridge.store.quarantines({ taskId: task.id });
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(f.bridge.store.quarantineEntry(archived.id).message.text, first.text);
});

test('a real Store close/reopen keeps exactly one archive and incident, then recovers after a failed prune', async t => {
  const f = await fixture(t);
  const bad = message('restart-bad', { evidence: { ...validEvidence, unknown_field: true } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });

  // First pass archives durably, but the prune attempt fails transiently, so the
  // mailbox copy must remain readable by the next process.
  f.rpc.failNextSet(Object.assign(new Error('EIO: native write failed'), { code: 'EIO' }));
  await assert.rejects(f.bridge.syncWorker(worker), /EIO/);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(incidents(f.bridge).length, 1);
  assert.deepEqual(mailboxIds(f.rpc), ['restart-bad']);

  // Real restart: close the database and rebuild the bridge on the same path.
  f.bridge.store.close();
  const reopened = new Bridge({ ...f.config }, { clientFactory: () => { throw new Error('Bridge.start is not used in this test'); }, queue: f.queue });
  const rpc = native();
  reopened.rpc = rpc;
  t.after(() => { try { reopened.store.close(); } catch { /* already closed */ } });

  // The durable archive and its single incident survived the restart.
  assert.equal(reopened.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(incidents(reopened).length, 1);

  // Re-seed the identical report: the replay is idempotent and now prunes cleanly.
  rpc.put(worker.mailbox, { version: 1, messages: [bad] });
  await reopened.syncWorker(worker);
  assert.equal(reopened.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(incidents(reopened).length, 1);
  assert.deepEqual(mailboxIds(rpc), []);
});

test('the rejection notice carries the persisted bounded reason and never renders undefined', async t => {
  const f = await fixture(t);
  const bad = message('notice', { evidence: { ...validEvidence, unknown_field: true } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });
  await f.bridge.syncWorker(worker);

  const [incident] = incidents(f.bridge);
  assert.equal(incident.attention.code, 'REPORT_INVALID');
  assert.equal(incident.attention.reportId, 'notice');
  assert.match(incident.text, /Rejected worker report notice from pi-work \(t7\)\./);
  assert.match(incident.text, /Reason \(REPORT_INVALID\): Unknown worker evidence field: unknown_field/);
  assert.ok(!incident.text.includes('undefined'), 'notice must not contain undefined');
  assert.equal(incident.attention.quarantine, f.bridge.store.quarantines({ taskId: task.id })[0].id);

  // A replay with a DIFFERENT caller reason must return the ORIGINAL persisted
  // reason (an immutable fact), and must not add an archive row or journal entry.
  const quarantineCount = () => f.bridge.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='message.quarantined'").get().n;
  const replay = f.bridge.store.quarantine(worker, bad, { code: 'REPORT_INVALID', reason: 'a different retry reason' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reason, 'Unknown worker evidence field: unknown_field');
  assert.equal(replay.reason, f.bridge.store.quarantines({ taskId: task.id })[0].reason);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(quarantineCount(), 1);

  // The persisted reason is stable across a real Store close/reopen.
  f.bridge.store.close();
  const reopened = new Bridge({ ...f.config }, { clientFactory: () => { throw new Error('Bridge.start is not used in this test'); }, queue: f.queue });
  reopened.rpc = f.rpc;
  t.after(() => { try { reopened.store.close(); } catch { /* already closed */ } });
  const replayed = reopened.store.quarantine(worker, bad, { code: 'REPORT_INVALID', reason: 'yet another retry reason' });
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.reason, 'Unknown worker evidence field: unknown_field');
  assert.equal(reopened.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='message.quarantined'").get().n, 1);
});

test('a failing archive journal rolls back the archive and preserves the mailbox for retry', async t => {
  const f = await fixture(t);
  const bad = message('journal-fail', { evidence: { ...validEvidence, unknown_field: true } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });

  const realJournal = f.bridge.store.journal.bind(f.bridge.store);
  let armed = true;
  f.bridge.store.journal = (type, data) => {
    if (armed && type === 'message.quarantined') { armed = false; throw new Error('journal device offline'); }
    return realJournal(type, data);
  };

  await f.bridge.syncWorker(worker);

  // The archive row and its journal commit atomically: nothing was recorded, no
  // incident was emitted, and the mailbox copy is still present for the retry.
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 0);
  assert.equal(incidents(f.bridge).length, 0);
  assert.deepEqual(mailboxIds(f.rpc), ['journal-fail']);

  f.bridge.store.journal = realJournal;
  await f.bridge.syncWorker(worker);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.equal(incidents(f.bridge).length, 1);
  assert.deepEqual(mailboxIds(f.rpc), []);
});

test('a transient Store failure retains the mailbox report for a later successful sync', async t => {
  const f = await fixture(t);
  const bad = message('transient', { evidence: { ...validEvidence, unknown_field: true } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });

  const realIngest = f.bridge.store.ingest.bind(f.bridge.store);
  let calls = 0;
  f.bridge.store.ingest = (...args) => { if (calls++ === 0) throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }); return realIngest(...args); };
  await f.bridge.syncWorker(worker);
  f.bridge.store.ingest = realIngest;

  // Unknown/transient failure must not prune or archive.
  assert.deepEqual(mailboxIds(f.rpc), ['transient']);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 0);

  await f.bridge.syncWorker(worker);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.deepEqual(mailboxIds(f.rpc), []);
});

test('a failed prune leaves the archive durable and the mailbox copy in place for retry', async t => {
  const f = await fixture(t);
  const bad = message('prune-fail', { evidence: { ...validEvidence, unknown_field: true } });
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad] });

  f.rpc.failNextSet(Object.assign(new Error('EIO: native write failed'), { code: 'EIO' }));
  await assert.rejects(f.bridge.syncWorker(worker), /EIO/);

  // Archive happened before the prune attempt; the mailbox copy is still present.
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
  assert.deepEqual(mailboxIds(f.rpc), ['prune-fail']);

  await f.bridge.syncWorker(worker);
  assert.deepEqual(mailboxIds(f.rpc), []);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
});

test('concurrent appends survive CAS pruning of an archived rejected report', async t => {
  const f = await fixture(t);
  const bad = message('cas-bad', { evidence: { ...validEvidence, unknown_field: true } });
  const valid = message('cas-valid');
  f.rpc.put(worker.mailbox, { version: 1, messages: [bad, valid] });

  f.rpc.beforeSet(() => {
    const current = f.rpc.documents.get(worker.mailbox).value;
    f.rpc.put(worker.mailbox, { version: 1, messages: [...current.messages, message('concurrent')] });
  });

  await f.bridge.syncWorker(worker);

  // The pruned entries are gone; the append that raced the CAS is preserved.
  assert.deepEqual(mailboxIds(f.rpc), ['concurrent']);
  assert.equal(f.bridge.store.quarantines({ taskId: task.id }).length, 1);
});

// --- CLI subprocess wire-budget boundary (real message-cli + mailbox fixture) ---

function cliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-wire-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const w = { version: 1, id: worker.id, taskId: worker.taskId, name: 'pi-work', project: root, stateDir: join(root, 'worker'), hc, mailbox: worker.mailbox };
  mkdirSync(w.stateDir);
  const config = join(w.stateDir, 'worker.json');
  const nativePath = join(root, 'native.json');
  const log = join(root, 'requests.jsonl');
  writeFileSync(config, JSON.stringify(w));
  writeFileSync(nativePath, JSON.stringify({ terminal: { name: w.name, cwd: w.project, turn: 2, labels: { 'codex.worker': w.id, 'codex.task': w.taskId } }, doc: { value: null, version: 0 } }));
  writeFileSync(log, '');
  return {
    env: { ...process.env, HERDR_CODEX_WORKER_CONFIG: config, HC_TERMINAL_ID: worker.terminalId, HERDR_TEST_MAILBOX_STATE: nativePath, HERDR_TEST_MAILBOX_LOG: log },
    state: () => JSON.parse(readFileSync(nativePath, 'utf8')),
    receipts: () => readdirSync(join(w.stateDir, 'runtime/message-outbox')).filter(n => n.endsWith('.json')),
  };
}

function runCli(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI admits exactly 65536 UTF-8 bytes and rejects 65537 before any write', async t => {
  const f = cliFixture(t);
  const atLimit = await runCli(f.env, ['--text', 'a'.repeat(65536)]);
  assert.equal(atLimit.code, 0, atLimit.stderr);
  assert.equal(f.state().doc.value.messages[0].text.length, 65536);

  const over = await runCli(f.env, ['--text', 'b'.repeat(65537)]);
  assert.equal(over.code, 1);
  assert.match(over.stderr, /exceeds the 65536-byte wire budget/);
  assert.equal(f.state().doc.value.messages.length, 1);
  assert.equal(f.receipts().length, 1);
});

test('CLI measures the budget in UTF-8 bytes, not code units', async t => {
  const f = cliFixture(t);
  const multibyte = 'é'.repeat(32768); // 65536 UTF-8 bytes, 32768 code units
  assert.equal(Buffer.byteLength(multibyte), 65536);
  const ok = await runCli(f.env, ['--text', multibyte]);
  assert.equal(ok.code, 0, ok.stderr);

  const over = await runCli(f.env, ['--text', multibyte + 'a']);
  assert.equal(over.code, 1);
  assert.match(over.stderr, /exceeds the 65536-byte wire budget/);
  assert.equal(f.state().doc.value.messages.length, 1);
});
