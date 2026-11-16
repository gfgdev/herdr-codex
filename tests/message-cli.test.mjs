import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../src/message-cli.mjs', import.meta.url));
const hc = fileURLToPath(new URL('./fixtures/mailbox-hc.mjs', import.meta.url));
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-message-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = { version: 1, id: 'worker-1', taskId: 'task-1', name: 'test-agent', project: root,
    stateDir: join(root, 'worker'), hc, mailbox: 'test-inbox' };
  mkdirSync(worker.stateDir);
  const config = join(worker.stateDir, 'worker.json');
  const native = join(root, 'native.json');
  const log = join(root, 'requests.jsonl');
  writeFileSync(config, JSON.stringify(worker));
  writeFileSync(native, JSON.stringify({ terminal: { name: worker.name, cwd: worker.project, turn: 2, labels:{'codex.worker':worker.id,'codex.task':worker.taskId} },
    doc: { value: null, version: 0 } }));
  writeFileSync(log, '');
  return {
    worker,
    env: { ...process.env, HERDR_CODEX_WORKER_CONFIG: config, HC_TERMINAL_ID: 't7',
      HERDR_TEST_MAILBOX_STATE: native, HERDR_TEST_MAILBOX_LOG: log },
    state: () => JSON.parse(readFileSync(native, 'utf8')),
    update: callback => {
      const state = JSON.parse(readFileSync(native, 'utf8')); callback(state); writeFileSync(native, JSON.stringify(state));
    },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    receipts: () => readdirSync(join(worker.stateDir, 'runtime/message-outbox')).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(worker.stateDir, 'runtime/message-outbox', name), 'utf8'))),
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
const args = ['--kind', 'question', '--text', 'Which behavior should be preserved?', '--idempotency-key', 'decision-1'];

test('native child cannot use an inherited parent report binding even with the same name and cwd',async t=>{
  const f=setup(t);f.update(state=>{state.terminal.labels={};});
  const result=await run(f.env,args);assert.equal(result.code,1);assert.match(result.stderr,/child needs its own adopted binding/);
  assert.equal(f.calls().some(c=>c.method==='doc.set'),false);
});

test('same-key retry preserves timestamp and original turn while still in native mailbox', async t => {
  const fixture = setup(t);
  assert.equal((await run(fixture.env, args)).code, 0);
  const original = fixture.state().doc.value.messages[0];
  fixture.update(state => { state.terminal.turn = 7; });
  const again = await run(fixture.env, args);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.result.duplicate, true);
  assert.deepEqual(fixture.state().doc.value.messages, [original]);
  assert.deepEqual(fixture.receipts(), [{ version: 1, message: original }]);
  assert.equal(fixture.calls().filter(call => call.method === 'doc.set').length, 1);
});

test('replay after bridge pruning restores identical payload for manager archive deduplication', async t => {
  const fixture = setup(t);
  assert.equal((await run(fixture.env, args)).code, 0);
  const original = fixture.state().doc.value.messages[0];
  fixture.update(state => { state.doc = { version: 2, value: { version: 1, messages: [] } }; state.terminal.turn = 9; });
  const replay = await run(fixture.env, args);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(fixture.state().doc.value.messages, [original]);
});

test('same-key changed text or kind fails before native mailbox write', async t => {
  const fixture = setup(t);
  assert.equal((await run(fixture.env, args)).code, 0);
  const changedText = args.map(value => value === 'Which behavior should be preserved?' ? 'A different question' : value);
  const changedKind = args.map(value => value === 'question' ? 'result' : value);
  for (const changed of [changedText, changedKind]) {
    const result = await run(fixture.env, changed);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /idempotency key already belongs to a different message/);
  }
  assert.equal(fixture.calls().filter(call => call.method === 'doc.set').length, 1);
  assert.equal(fixture.receipts().length, 1);
});

test('uncertain native write retains prepared receipt and replay does not conflict', async t => {
  const fixture = setup(t);
  fixture.update(state => { state.failAfterSet = true; });
  const failed = await run(fixture.env, args);
  assert.equal(failed.code, 1);
  const error = JSON.parse(failed.stderr);
  assert.ok(error.id);
  assert.ok(error.outboxFile);
  assert.equal(fixture.receipts().length, 1);
  fixture.update(state => { state.terminal.turn = 3; });
  const retry = await run(fixture.env, args);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(retry.result.duplicate, true);
  assert.equal(retry.result.id, error.id);
});

test('concurrent same-key helpers select one complete prepared payload', async t => {
  const fixture = setup(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => run(fixture.env, args)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(new Set(results.map(result => result.result.id)).size, 1);
  const [receipt] = fixture.receipts();
  assert.equal(fixture.receipts().length, 1);
  assert.deepEqual(fixture.state().doc.value.messages, [receipt.message]);
  const directory = join(fixture.worker.stateDir, 'runtime/message-outbox');
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, readdirSync(directory)[0])).mode & 0o777, 0o600);
});

test('retries still verify current terminal binding', async t => {
  const fixture = setup(t);
  assert.equal((await run(fixture.env, args)).code, 0);
  fixture.update(state => { state.terminal.name = 'unrelated-agent'; });
  const retry = await run(fixture.env, args);
  assert.equal(retry.code, 1);
  assert.match(retry.stderr, /does not match the worker binding/);
  assert.equal(fixture.calls().filter(call => call.method === 'doc.set').length, 1);
});

test('help works without a worker environment', async () => {
  const env = { ...process.env };
  delete env.HERDR_CODEX_WORKER_CONFIG;
  delete env.HC_TERMINAL_ID;
  const result = await run(env, ['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /herdr-message/);
});
