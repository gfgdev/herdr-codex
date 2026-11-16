import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { RevisionReviews } from '../src/revision-reviews.mjs';
import { validateWorkerEvidence } from '../src/evidence.mjs';
import { digest } from '../src/config.mjs';

const THREAD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_THREAD = '11111111-2222-4333-8444-555555555555';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'herdr-revision-reviews-')));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'a.txt'), 'alpha\n');
  await writeFile(join(project, 'b.txt'), 'beta\n');
  await mkdir(join(project, 'sub'));
  await writeFile(join(project, 'sub', 'c.txt'), 'gamma\n');
  const dbPath = join(root, 'manager.sqlite');
  const store = new Store(dbPath);
  const task = { id: 'task-1', name: 'demo', project, threadId: THREAD, status: 'active' };
  const worker = {
    id: 'worker-1', taskId: 'task-1', name: 'pi-one', role: 'pi', project, terminalId: 't7',
    mailbox: 'cx-worker-1', launchState: 'started', launchResult: { pid: 4242 },
    launchIdentity: { created_ms: 1712345678000 }, stateDir: join(root, 'state'),
  };
  store.saveTask(task);
  store.saveWorker(worker);
  store.meta(`activation:${worker.id}`, { id: 'act-1', at: '2024-01-01T00:00:00.000Z', pid: 4242, baselineTurn: 1 });
  store.ingest(worker, {
    id: 'result-1', taskId: task.id, workerId: worker.id, terminalId: worker.terminalId,
    kind: 'result', text: 'work complete', createdAt: '2024-01-01T00:05:00.000Z', turn: 2,
  });
  const reviews = new RevisionReviews(store);
  const cleanup = async () => {
    try { store.close(); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true });
  };
  return { root, project, dbPath, store, task, worker, reviews, cleanup, threadId: THREAD };
}

const capture = (f, overrides = {}) => f.reviews.captureReview({
  threadId: f.threadId, resultId: 'result-1', paths: ['a.txt', 'sub/c.txt'], requestId: 'req-1', ...overrides,
});

const accept = (f, record, overrides = {}) => f.reviews.acceptReview({
  threadId: f.threadId, resultId: 'result-1', reviewId: record.reviewId,
  expectedRevision: record.revisionSha256, requestId: 'accept-1', text: 'Reviewed and accepted.', ...overrides,
});

const acceptedJournalCount = store =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='revision-review.accepted'").get().n;

const capturedJournalCount = store =>
  store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='revision-review.captured'").get().n;

test('captures a bound review and accepts an unchanged revision', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  assert.equal(record.version, 1);
  assert.equal(record.type, 'revision-review');
  assert.equal(record.project, f.project, 'project is the registered worker project, never a caller value');
  assert.equal(record.taskId, 'task-1');
  assert.equal(record.workerId, 'worker-1');
  assert.equal(record.terminalId, 't7');
  assert.equal(record.activation.id, 'act-1');
  assert.deepEqual(record.scopes, ['a.txt', 'sub/c.txt']);
  assert.match(record.reviewId, /^rv-[0-9a-f]{48}$/);
  assert.equal(record.revision.sha256, record.revisionSha256);

  const result = accept(f, record);
  assert.equal(result.accepted, true);
  assert.equal(result.bound, true);
  assert.equal(result.replay, false);
  const stored = f.store.message('result-1').action;
  assert.equal(stored.kind, 'accept');
  assert.equal(stored.review.reviewId, record.reviewId);
  assert.equal(stored.review.revisionSha256, record.revisionSha256);
  assert.equal(stored.review.project, f.project);

  const verification = f.reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-1' });
  assert.equal(verification.accepted, true);
  assert.equal(verification.verified, true);
  assert.equal(verification.stale, false);
});

test('stable capture and acceptance replays are byte-identical and idempotent', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const first = capture(f, { requestId: 'req-replay' });
  const replay = capture(f, { requestId: 'req-replay' });
  assert.deepEqual(replay, first);

  const one = accept(f, first, { requestId: 'accept-replay' });
  assert.equal(one.replay, false);
  const two = accept(f, first, { requestId: 'accept-replay' });
  assert.equal(two.replay, true);
  assert.equal(two.reviewId, one.reviewId);
  assert.equal(two.revisionSha256, one.revisionSha256);
  assert.equal(acceptedJournalCount(f.store), 1, 'replay records no second acceptance');
});

test('a reused requestId with different capture arguments conflicts', async t => {
  const f = await fixture(); t.after(f.cleanup);
  capture(f, { requestId: 'req-dup', paths: ['a.txt'] });
  assert.throws(() => capture(f, { requestId: 'req-dup', paths: ['b.txt'] }), /already captured a different review/);
  assert.throws(() => capture(f, { requestId: 'req-dup', paths: ['a.txt', 'b.txt'] }), /already captured a different review/);
});

test('a result demonstrably older than a newer activation is refused before capture side effects', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.meta('activation:worker-1', { id: 'act-2', at: '2024-01-02T00:00:00.000Z', pid: 4242, baselineTurn: 10 });
  assert.throws(() => capture(f, { requestId: 'req-stale' }), /predates the current worker activation/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(capturedJournalCount(f.store), 0);
  assert.equal(f.store.meta(`revision-review-request:${f.threadId}:result-1:req-stale`), null);
});

test('an activation identity change with the same id is detected', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  f.store.meta('activation:worker-1', { id: 'act-1', at: '2024-01-01T00:04:00.000Z', pid: 4242, baselineTurn: 1 });
  assert.throws(() => accept(f, record), /binding changed \(activation\)/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(acceptedJournalCount(f.store), 0);
});

test('a same-id activation mutated past the result is refused as stale', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  f.store.meta('activation:worker-1', { id: 'act-1', at: '2024-01-02T00:00:00.000Z', pid: 4242, baselineTurn: 10 });
  assert.throws(() => accept(f, record), /predates the current worker activation/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(acceptedJournalCount(f.store), 0);
});

test('a result with no comparable timestamp records explicit unknown provenance', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.ingest(f.worker, {
    id: 'result-unknown', taskId: 'task-1', workerId: 'worker-1', terminalId: 't7',
    kind: 'result', text: 'no timestamps',
  });
  const record = f.reviews.captureReview({
    threadId: f.threadId, resultId: 'result-unknown', paths: ['a.txt'], requestId: 'req-unknown',
  });
  assert.equal(record.provenance, 'unknown', 'unprovable currency stays explicit, never silently trusted');
  assert.equal(accept(f, record, { resultId: 'result-unknown' }).accepted, true);
});

test('capture idempotency is namespaced per chat and result', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const first = capture(f, { requestId: 'shared' });
  const w2 = { ...f.worker, id: 'worker-2', terminalId: 't8', mailbox: 'cx-worker-2' };
  f.store.saveWorker(w2);
  f.store.ingest(w2, {
    id: 'result-2', taskId: 'task-1', workerId: 'worker-2', terminalId: 't8',
    kind: 'result', text: 'other result', createdAt: '2024-01-01T00:05:00.000Z', turn: 2,
  });
  const second = f.reviews.captureReview({
    threadId: f.threadId, resultId: 'result-2', paths: ['a.txt', 'sub/c.txt'], requestId: 'shared',
  });
  assert.notEqual(second.reviewId, first.reviewId, 'an unrelated result in the same chat must not collide');
  assert.throws(
    () => capture(f, { requestId: 'shared', paths: ['b.txt'] }),
    /already captured a different review/,
    'changed arguments in the same scope still conflict',
  );
});

test('acceptance text is bounded in UTF-8 bytes, not characters', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  assert.throws(() => accept(f, record, { text: '\u00e9'.repeat(65536) }), /UTF-8 bytes/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(acceptedJournalCount(f.store), 0);
  const exact = accept(f, record, { text: '\u00e9'.repeat(32768) });
  assert.equal(exact.accepted, true, 'exactly 65536 UTF-8 bytes is allowed');
});

test('binds the full report payload including supported evidence v1 across the legacy Store', async t => {
  const f = await fixture(); t.after(f.cleanup);
  // Accepted evidence v1: only supported fields, and no self-declared authority.
  const rawEvidence = {
    version: 1,
    worker_id: 'worker-1',
    task_id: 'task-1',
    session_generation_id: 'test-generation',
    tests: [{ argv: ['node', '--test'], cwd: '.', exit_code: 0, output_path: 'out/log.txt', truncated: false }],
    limitations: ['caf\u00e9'],
    unresolved_requests: [],
  };
  assert.equal(Object.hasOwn(rawEvidence, 'authority'), false, 'raw fixture carries no authority field');
  const normalizedEvidence = validateWorkerEvidence(rawEvidence);
  assert.equal(normalizedEvidence.authority, 'worker-claims', 'fixture satisfies the accepted evidence v1 validator');

  f.store.ingest(f.worker, {
    id: 'result-ev', taskId: 'task-1', workerId: 'worker-1', terminalId: 't7',
    kind: 'result', text: 'with evidence', createdAt: '2024-01-01T00:05:00.000Z', turn: 2, evidence: rawEvidence,
  });
  const stored = JSON.parse(f.store.db.prepare('SELECT data FROM messages WHERE id=?').get('result-ev').data);
  assert.equal(stored.evidence.version, 1, 'Store retains supported evidence v1');
  assert.deepEqual(stored.evidence.tests, rawEvidence.tests);
  assert.deepEqual(stored.evidence.limitations, ['caf\u00e9']);

  const record = f.reviews.captureReview({
    threadId: f.threadId, resultId: 'result-ev', paths: ['a.txt', 'sub/c.txt'], requestId: 'req-ev',
  });
  const legacy = digest(JSON.stringify(['result-ev', 'task-1', 'worker-1', 't7', 'result', 'with evidence', null]));
  assert.notEqual(record.reportFingerprint, legacy, 'binding must not reuse the legacy 7-field report formula');
  assert.equal(accept(f, record, { resultId: 'result-ev' }).accepted, true);

  // Mutate a supported evidence field; the report binding must detect the drift.
  f.store.db.prepare('UPDATE messages SET data=? WHERE id=?')
    .run(JSON.stringify({ ...stored, evidence: { ...stored.evidence, limitations: ['changed'] } }), 'result-ev');

  const verification = f.reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-ev' });
  assert.equal(verification.accepted, true);
  assert.equal(verification.verified, false);
  assert.equal(verification.stale, true);
  assert.equal(verification.reason, 'binding-changed');
  assert.deepEqual(verification.changed, ['report']);
});

test('namespaced capture replay and conflicts survive a restart', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { requestId: 'req-ns' });
  f.store.close();

  const reopened = new Store(f.dbPath);
  t.after(() => reopened.close());
  const reviews = new RevisionReviews(reopened);
  const replay = reviews.captureReview({
    threadId: f.threadId, resultId: 'result-1', paths: ['a.txt', 'sub/c.txt'], requestId: 'req-ns',
  });
  assert.deepEqual(replay, record, 'namespaced request ledger survives a restart');
  assert.throws(() => reviews.captureReview({
    threadId: f.threadId, resultId: 'result-1', paths: ['b.txt'], requestId: 'req-ns',
  }), /already captured a different review/);
});

test('a modified selected file refuses acceptance before any action is recorded', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { paths: ['a.txt', 'b.txt'] });
  await writeFile(join(f.project, 'a.txt'), 'tampered\n');
  assert.throws(() => accept(f, record), /refusing acceptance/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(f.store.meta(`revision-accept:${record.reviewId}`), null);
  assert.equal(acceptedJournalCount(f.store), 0);
});

test('a deleted selected file refuses acceptance', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { paths: ['a.txt', 'b.txt'] });
  await unlink(join(f.project, 'b.txt'));
  assert.throws(() => accept(f, record), /refusing acceptance/);
  assert.equal(f.store.message('result-1').action, null);
});

test('an added file inside a selected directory refuses acceptance', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { paths: ['sub'] });
  await writeFile(join(f.project, 'sub', 'new.txt'), 'delta\n');
  assert.throws(() => accept(f, record), /refusing acceptance/);
  assert.equal(f.store.message('result-1').action, null);
});

test('an executable-mode change refuses acceptance', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { paths: ['a.txt'] });
  await chmod(join(f.project, 'a.txt'), 0o755);
  assert.throws(() => accept(f, record), /refusing acceptance/);
  assert.equal(f.store.message('result-1').action, null);
});

test('a newer activation invalidates an earlier review', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  f.store.meta('activation:worker-1', { id: 'act-2', at: '2024-01-02T00:00:00.000Z', pid: 4242, baselineTurn: 9 });
  assert.throws(() => accept(f, record), /predates the current worker activation/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(f.store.meta(`revision-accept:${record.reviewId}`), null);
  assert.equal(acceptedJournalCount(f.store), 0);
});

test('a replaced native process binding invalidates an earlier review', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  const worker = f.store.worker('worker-1');
  f.store.saveWorker({ ...worker, launchResult: { pid: 9999 } });
  assert.throws(() => accept(f, record), /binding changed \(launch\.pid\)/);
  assert.equal(f.store.message('result-1').action, null);
});

test('a newer result supersedes the reviewed result and reuse is refused', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  f.store.ingest(f.worker, {
    id: 'result-2', taskId: 'task-1', workerId: 'worker-1', terminalId: 't7',
    kind: 'result', text: 'second result', createdAt: '2024-01-01T00:10:00.000Z', turn: 3,
  });
  assert.throws(() => accept(f, record), /supersedes/);
  assert.throws(() => accept(f, record, { resultId: 'result-2' }), /captured for a different result/);
  assert.equal(f.store.message('result-1').action, null);
  assert.equal(f.store.message('result-2').action, null);
});

test('a review cannot be used from a different manager chat', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  assert.throws(() => accept(f, record, { threadId: OTHER_THREAD }), /different manager chat/);
  assert.throws(() => capture(f, { requestId: 'req-x', threadId: OTHER_THREAD }), /does not belong to this manager chat/);
  assert.equal(f.store.message('result-1').action, null);
});

test('an unknown or forged review id is refused', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const forged = `rv-${'0'.repeat(48)}`;
  assert.throws(() => accept(f, { reviewId: forged, revisionSha256: 'a'.repeat(64) }), /Unknown review/);
  assert.throws(() => f.reviews.acceptReview({
    threadId: f.threadId, resultId: 'result-1', reviewId: 'not-a-review', expectedRevision: 'a'.repeat(64),
    requestId: 'accept-1', text: 'x',
  }), /reviewId is not a valid/);
});

test('a legacy unbound acceptance is never silently upgraded', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  f.store.recordAction('result-1', { kind: 'accept', text: 'legacy approval', requestId: 'legacy-1' });
  assert.throws(() => accept(f, record), /legacy unbound acceptance/);
  const verification = f.reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-1' });
  assert.equal(verification.accepted, true);
  assert.equal(verification.bound, false);
  assert.equal(verification.verified, null);
  assert.equal(verification.reason, 'legacy-unbound-acceptance');
});

test('an already-accepted result refuses conflicting request, text and review', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  accept(f, record, { requestId: 'accept-once' });
  assert.throws(() => accept(f, record, { requestId: 'accept-twice' }), /different requestId/);
  assert.throws(() => accept(f, record, { requestId: 'accept-once', text: 'different text' }), /Different acceptance text/);
  const other = `rv-${'c'.repeat(48)}`;
  assert.throws(() => accept(f, { ...record, reviewId: other }, { requestId: 'accept-once' }), /A different review is already recorded/);
  assert.equal(acceptedJournalCount(f.store), 1);
});

test('accepted history is distinct from currently-matching content', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { paths: ['a.txt'] });
  accept(f, record);
  await writeFile(join(f.project, 'a.txt'), 'moved on\n');
  const verification = f.reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-1' });
  assert.equal(verification.accepted, true);
  assert.equal(verification.verified, false);
  assert.equal(verification.stale, true);
  assert.deepEqual(verification.changedPaths, ['a.txt']);
  assert.equal(verification.expectedSha256, record.revisionSha256);
});

test('changing the activation after acceptance makes verification stale', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  accept(f, record);
  f.store.meta('activation:worker-1', { id: 'act-2', at: '2024-01-01T00:04:00.000Z', pid: 4242, baselineTurn: 1 });
  const verification = f.reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-1' });
  assert.equal(verification.accepted, true);
  assert.equal(verification.verified, false);
  assert.equal(verification.stale, true);
  assert.equal(verification.reason, 'binding-changed');
  assert.deepEqual(verification.changed, ['activation']);
});

test('verification with a mismatched review id reports stale', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f);
  accept(f, record);
  const verification = f.reviews.verifyAcceptedRevision({
    threadId: f.threadId, resultId: 'result-1', reviewId: `rv-${'d'.repeat(48)}`,
  });
  assert.equal(verification.accepted, true);
  assert.equal(verification.verified, false);
  assert.equal(verification.stale, true);
  assert.equal(verification.reason, 'review-id-mismatch');
});

test('verification without acceptance reports no-acceptance, and cross-chat is rejected', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const none = f.reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-1' });
  assert.equal(none.accepted, false);
  assert.equal(none.reason, 'no-acceptance');
  const foreign = f.reviews.verifyAcceptedRevision({ threadId: OTHER_THREAD, resultId: 'result-1' });
  assert.equal(foreign.accepted, false);
  assert.equal(foreign.reason, 'result-does-not-belong-to-chat');
});

test('capture and acceptance replay after a restart without trusting raw worker evidence', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const record = capture(f, { paths: ['a.txt', 'sub'] });
  accept(f, record, { requestId: 'accept-restart' });
  f.store.close();

  const reopened = new Store(f.dbPath);
  t.after(() => reopened.close());
  const reviews = new RevisionReviews(reopened);
  const verification = reviews.verifyAcceptedRevision({ threadId: f.threadId, resultId: 'result-1' });
  assert.equal(verification.accepted, true);
  assert.equal(verification.verified, true);
  assert.equal(verification.stale, false);
  assert.equal(verification.reviewId, record.reviewId);
  const replay = reviews.acceptReview({
    threadId: f.threadId, resultId: 'result-1', reviewId: record.reviewId,
    expectedRevision: record.revisionSha256, requestId: 'accept-restart', text: 'Reviewed and accepted.',
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.reviewId, record.reviewId);
});

test('capture rejects non-result messages, absolute paths and duplicates', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.store.ingest(f.worker, {
    id: 'progress-1', taskId: 'task-1', workerId: 'worker-1', terminalId: 't7',
    kind: 'progress', text: 'still working', createdAt: '2024-01-01T00:06:00.000Z', turn: 2,
  });
  assert.throws(() => capture(f, { resultId: 'progress-1', requestId: 'req-p' }), /Only a result message/);
  assert.throws(() => capture(f, { requestId: 'req-abs', paths: ['/etc/passwd'] }), /project-relative/);
  assert.throws(() => capture(f, { requestId: 'req-dup-path', paths: ['a.txt', 'a.txt'] }), /duplicate selected path/);
  assert.throws(() => capture(f, { requestId: 'req-empty', paths: [] }), /nonempty array/);
});
