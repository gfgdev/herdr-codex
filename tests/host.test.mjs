import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostEnv, parseQueueReceipt, dispatchCodex } from '../src/host.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const RECEIPT = '01a198fc-0b31-7a21-a259-8fe0225d9a06';
const OTHER = '01a1d317-b5d9-7530-8623-f60c0df12d38';
const receipt = (messageId = RECEIPT, thread = THREAD) => `Queued message ${messageId} for thread ${thread}.\n`;
const dispatch = (response, options = {}) => dispatchCodex({
  executable: '/fixture/codex', threadId: THREAD, message: 'A worker needs an answer.',
  runner: async () => ({ code: 0, stdout: '', stderr: '', ...response }), ...options,
});

test('host environment forwards paths and locale, excluding all worker/provider secrets', () => {
  const env = buildHostEnv({
    PATH: '/usr/bin', HOME: '/Users/example', CODEX_HOME: '/private/codex', LANG: 'en_US.UTF-8',
    MODAL_API_KEY: 'private-modal-value', OPENAI_API_KEY: 'private-openai-value',
    HC_TERMINAL_ID: 't9', HERDR_CODEX_WORKER_CONFIG: '/private/worker.json', NODE_OPTIONS: '--require malicious',
  });
  assert.deepEqual({ ...env }, { PATH: '/usr/bin', HOME: '/Users/example', CODEX_HOME: '/private/codex', LANG: 'en_US.UTF-8' });
  assert.equal(JSON.stringify(env).includes('private-modal-value'), false);
  assert.deepEqual({ ...buildHostEnv({ HOME: 'bad\0path', PATH: 123, LANG: '' }) }, {});
});

test('normal prose remains one literal argv argument; default does not request resume', async () => {
  const message = 'Look at `file.js`; $(touch /tmp/not-run)\nQuoted "text"; $HOME';
  let invocation;
  const answer = await dispatchCodex({
    executable: '/fixture path/codex', threadId: THREAD, message,
    env: { HOME: '/Users/example', MODAL_API_KEY: 'private' }, timeoutMs: 91,
    runner: async (...args) => { invocation = args; return { code: 0, stdout: receipt(), stderr: '' }; },
  });
  assert.deepEqual(invocation[1], ['queue', '--thread', THREAD, '--message', message]);
  assert.equal(invocation[0], '/fixture path/codex');
  assert.equal(invocation[2].timeoutMs, 91);
  assert.deepEqual({ ...invocation[2].env }, { HOME: '/Users/example' });
  assert.deepEqual(answer, { status: 'queued', receipt: RECEIPT, warning: null, error: null });
});

test('explicit resume retains receipt but reports resume failure without claiming receipt by chat', async () => {
  let argv;
  const answer = await dispatch({ stdout: receipt() }, {
    resume: true,
    runner: async (_file, args) => {
      argv = args;
      return { code: 0, stdout: receipt(), stderr: 'Warning: failed to resume the thread: daemon is not running.\n' };
    },
  });
  assert.equal(argv.at(-1), '--resume');
  assert.equal(answer.status, 'queued');
  assert.equal(answer.receipt, RECEIPT);
  assert.match(answer.warning, /resuming.*failed/);
  assert.match(answer.warning, /unconfirmed/);
});

test('stderr diagnostics are summarized, not copied into durable results', async () => {
  const secret = 'Bearer secret-provider-token';
  const answer = await dispatch({ stdout: receipt(), stderr: `warning: ${secret}` });
  assert.equal(answer.status, 'queued');
  assert.match(answer.warning, /diagnostics/);
  assert.equal(JSON.stringify(answer).includes(secret), false);
});

test('strict receipt parser requires complete UUIDs, one receipt, and the bound chat', () => {
  assert.deepEqual(parseQueueReceipt(receipt(), THREAD), { receipt: RECEIPT, error: null });
  assert.equal(parseQueueReceipt(receipt().toUpperCase(), THREAD).receipt, RECEIPT);
  assert.equal(parseQueueReceipt(`notice\n${receipt()}\n`, THREAD).receipt, RECEIPT);
  for (const stdout of [
    '', 'Queued message fake-id for thread fake-thread.',
    `Queued message ${RECEIPT} for thread ${THREAD}`, // truncated punctuation
    receipt(RECEIPT, OTHER), receipt() + receipt(),
    receipt() + 'Queued message malformed receipt\n',
    `Queued message ${RECEIPT} for thread ${THREAD}. unexpected suffix`,
  ]) assert.equal(parseQueueReceipt(stdout, THREAD).receipt, null, stdout);
});

test('successful exit without a valid matching receipt is uncertain, never accepted', async () => {
  for (const stdout of ['', 'done', 'Queued message broken', receipt(RECEIPT, OTHER), receipt() + receipt()]) {
    const answer = await dispatch({ stdout });
    assert.equal(answer.status, 'uncertain');
    assert.equal(answer.receipt, null);
    assert.ok(answer.error);
  }
});

test('timeouts and signals preserve known receipts and never become definite failure', async () => {
  for (const outcome of [{ timedOut: true }, { signal: 'SIGTERM' }, { transportError: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }]) {
    for (const stdout of ['', receipt()]) {
      const answer = await dispatch({ ...outcome, code: null, stdout });
      assert.equal(answer.status, 'uncertain');
      assert.equal(answer.receipt, stdout ? RECEIPT : null);
      assert.match(answer.error, /Reconcile before retrying/);
    }
  }
});

test('nonzero exit with receipt is uncertain; failure before any receipt is failed', async () => {
  assert.equal((await dispatch({ code: 1, stdout: receipt() })).status, 'uncertain');
  assert.equal((await dispatch({ code: 1, stdout: receipt(RECEIPT, OTHER) })).status, 'uncertain');
  const failed = await dispatch({ code: 2, stderr: 'invalid option' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.receipt, null);
  assert.match(failed.error, /code 2/);
});

test('missing/blocked executable is failed, contradictory receipt remains uncertain', async () => {
  assert.equal((await dispatch({ code: null, spawnError: 'ENOENT' })).status, 'failed');
  assert.equal((await dispatch({ code: null, spawnError: 'ENOENT', stdout: receipt() })).status, 'uncertain');
  const thrown = await dispatch({}, { runner: async () => { throw Object.assign(Error('private path'), { code: 'EACCES' }); } });
  assert.equal(thrown.status, 'failed');
  assert.equal(JSON.stringify(thrown).includes('private path'), false);
});

test('unclassified runner failures or malformed results preserve ambiguity', async () => {
  const thrown = await dispatch({}, { runner: async () => { throw Error('private diagnostic'); } });
  assert.equal(thrown.status, 'uncertain');
  assert.equal(JSON.stringify(thrown).includes('private diagnostic'), false);
  for (const response of [undefined, null, 'invalid', {}]) {
    const answer = await dispatch({}, { runner: async () => response });
    assert.equal(answer.status, 'uncertain');
  }
});

test('invalid routing and options fail before invoking any process', async () => {
  for (const options of [
    { executable: 'codex' }, { executable: '/bad\0path' },
    { threadId: 'friendly-chat-name' }, { threadId: `${THREAD} --remote another-host` },
    { message: '' }, { message: 'bad\0message' }, { timeoutMs: 0 }, { resume: 'true' },
  ]) {
    let called = false;
    const answer = await dispatch({}, { ...options, runner: async () => { called = true; } });
    assert.equal(answer.status, 'failed');
    assert.equal(called, false);
  }
});

test('default execFile runner handles real child argv, filtered env, and partial-receipt timeout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake codex');
  const message = 'literal `text` $(echo should-not-run)\n"quoted"';
  await writeFile(executable, `#!${process.execPath}\n` +
    `if (process.env.MODAL_API_KEY || process.argv[2] !== 'queue' || process.argv[6] !== ${JSON.stringify(message)}) process.exit(9);\n` +
    `process.stdout.write(${JSON.stringify(receipt())});\n` +
    `if (process.argv.includes('--resume')) setTimeout(() => {}, 60000);\n`, { mode: 0o700 });
  const base = { executable, threadId: THREAD, message, env: { PATH: process.env.PATH, HOME: dir, MODAL_API_KEY: 'not-forwarded' } };
  const queued = await dispatchCodex(base);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.receipt, RECEIPT);
  const timedOut = await dispatchCodex({ ...base, resume: true, timeoutMs: 300 });
  assert.equal(timedOut.status, 'uncertain');
  assert.equal(timedOut.receipt, RECEIPT);
  const missing = await dispatchCodex({ ...base, executable: join(dir, 'absent') });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.receipt, null);
});
