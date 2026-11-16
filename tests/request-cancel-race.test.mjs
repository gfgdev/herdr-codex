// A TRUE overlapping separate-process race between delivery `claim` and the new
// local `cancel`. Two independent OS processes open the same SQLite store and
// contend for the same prepared request; SQLite `BEGIN IMMEDIATE` serializes
// them, so exactly one transition may commit and the other must observe the
// committed state and refuse. No UNIX socket is involved, so this runs in the
// hardened sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Requests } from '../src/requests.mjs';

const THREAD = '00000000-0000-4000-8000-000000000002';
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const WORKER = { id: 'ha-race', taskId: 'hd-race' };

// Runs in its own process. `waitMs` lets the claimer hold the write lock open
// (after signalling `markerPath`) so the cancel process provably overlaps it.
const RACER = [
  "import { writeFileSync } from 'node:fs';",
  "import { pathToFileURL } from 'node:url';",
  "import { join } from 'node:path';",
  "const [role, storePath, workerId, requestId, outPath, markerPath, waitMs, thread] = process.argv.slice(2);",
  "const src = process.env.HERDR_CANCEL_SRC;",
  "const { Store } = await import(pathToFileURL(join(src, 'store.mjs')).href);",
  "const { Requests } = await import(pathToFileURL(join(src, 'requests.mjs')).href);",
  "const store = new Store(storePath);",
  "const requests = new Requests(store);",
  "const startedAt = Date.now();",
  "let ok = false, state = null, error = null;",
  "try {",
  "  if (role === 'claim') {",
  "    const saved = requests.claim(workerId, requestId, () => {",
  "      writeFileSync(markerPath, 'locked');",
  "      const end = Date.now() + Number(waitMs || 0);",
  "      while (Date.now() < end) {}",
  "      return 'wire';",
  "    });",
  "    ok = Boolean(saved); state = saved ? saved.state : null;",
  "  } else {",
  "    const saved = requests.cancel(workerId, requestId, { reason: 'race withdrawal', expectedState: 'prepared', dispositionId: 'race-disp', by: thread });",
  "    ok = Boolean(saved); state = saved ? saved.state : null;",
  "  }",
  "} catch (e) { error = String((e && e.message) || e); }",
  "writeFileSync(outPath, JSON.stringify({ role, startedAt, finishedAt: Date.now(), ok, state, error }));",
  "store.close();",
].join('\n');

function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, HERDR_CANCEL_SRC: SRC }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

function raceFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-cancel-race-')));
  const storePath = join(dir, 'manager.sqlite');
  const script = join(dir, 'racer.mjs');
  writeFileSync(script, RACER);
  const store = new Store(storePath);
  store.saveTask({ id: WORKER.taskId, threadId: THREAD, project: join(dir, 'project'), status: 'active' });
  store.saveWorker({ id: WORKER.id, taskId: WORKER.taskId, project: join(dir, 'project') });
  const requests = new Requests(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const cancelled = () => store.db.prepare("SELECT count(*) AS c FROM journal WHERE type='agent.request.cancelled'").get().c;
  return { dir, storePath, script, store, requests, cancelled };
}

test('overlapping separate-process claim blocks cancel: the lock-holder wins and cancel observes the committed state', async t => {
  const f = raceFixture(t);
  f.requests.reserve(WORKER, 'race-a', 'followup', { instruction: 'race', context: null });
  const marker = join(f.dir, 'claim-locked'), claimOut = join(f.dir, 'claim.json'), cancelOut = join(f.dir, 'cancel.json');

  // Start the claimer, which enters BEGIN IMMEDIATE and then busy-waits 500ms
  // while holding the write lock, signalling `marker` from inside the txn.
  const claimer = runChild(f.script, ['claim', f.storePath, WORKER.id, 'race-a', claimOut, marker, '500', THREAD]);
  assert.ok(await waitForFile(marker), 'claimer entered its write transaction');
  // The canceller starts strictly after the lock is held, so it is a genuine
  // overlap: it must block on BEGIN IMMEDIATE until the claim commits.
  const canceller = runChild(f.script, ['cancel', f.storePath, WORKER.id, 'race-a', cancelOut, marker, '0', THREAD]);
  const [claimExit, cancelExit] = await Promise.all([claimer, canceller]);
  assert.equal(claimExit.code, 0, claimExit.stderr);
  assert.equal(cancelExit.code, 0, cancelExit.stderr);

  const claim = JSON.parse(readFileSync(claimOut, 'utf8'));
  const cancel = JSON.parse(readFileSync(cancelOut, 'utf8'));
  assert.equal(claim.ok, true, 'the lock-holder wins');
  assert.equal(claim.state, 'sending');
  assert.equal(cancel.ok, false, 'the overlapped cancel is refused, not silently applied');
  assert.match(cancel.error, /state changed; expected prepared but found sending/);
  // Genuine overlap: the canceller began while the claimer still held the lock.
  assert.ok(cancel.startedAt >= claim.startedAt, 'cancel started after claim began');
  assert.ok(cancel.startedAt < claim.finishedAt, 'cancel overlapped the in-flight claim');
  assert.ok(claim.finishedAt - claim.startedAt >= 400, 'claim actually held the write lock open');
  assert.equal(f.requests.get(WORKER.id, 'race-a').state, 'sending');
  assert.equal(f.cancelled(), 0, 'no cancellation was journalled');
});

test('simultaneous separate-process claim vs cancel commits exactly one winner per round', async t => {
  const f = raceFixture(t);
  for (let round = 0; round < 10; round++) {
    const requestId = 'race-b' + round;
    f.requests.reserve(WORKER, requestId, 'followup', { instruction: 'race ' + round, context: null });
    const claimOut = join(f.dir, `claim-${round}.json`), cancelOut = join(f.dir, `cancel-${round}.json`);
    const marker = join(f.dir, `unused-${round}`);
    // Launch both as close together as the OS allows; neither holds the lock
    // open, so the winner is decided purely by who acquires BEGIN IMMEDIATE.
    const [claimExit, cancelExit] = await Promise.all([
      runChild(f.script, ['claim', f.storePath, WORKER.id, requestId, claimOut, marker, '0', THREAD]),
      runChild(f.script, ['cancel', f.storePath, WORKER.id, requestId, cancelOut, marker, '0', THREAD])]);
    assert.equal(claimExit.code, 0, claimExit.stderr);
    assert.equal(cancelExit.code, 0, cancelExit.stderr);
    const claim = JSON.parse(readFileSync(claimOut, 'utf8'));
    const cancel = JSON.parse(readFileSync(cancelOut, 'utf8'));
    const winners = [claim, cancel].filter(r => r.ok);
    assert.equal(winners.length, 1, `round ${round}: exactly one transition committed (${JSON.stringify({ claim, cancel })})`);
    const final = f.requests.get(WORKER.id, requestId);
    if (claim.ok) { assert.equal(final.state, 'sending'); assert.match(cancel.error, /state changed/); }
    else { assert.equal(final.state, 'cancelled'); assert.equal(cancel.ok, true); }
  }
});
