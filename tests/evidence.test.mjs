import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRevision, verifyRevision, validateWorkerEvidence, LIMITS, normalizeRelativePath } from '../src/evidence.mjs';
import { statSync } from 'node:fs';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'herdr-evidence-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, contents) => {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };
  return { dir, put };
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('capture is deterministic and binds bytes, mode, scope and sorted members', t => {
  const f = fixture(t);
  f.put('src/b.mjs', 'export const b = 2;\n');
  f.put('src/a.mjs', 'export const a = 1;\n');
  mkdirSync(join(f.dir, 'empty'), { recursive: true });
  const first = captureRevision(f.dir, { paths: ['src/a.mjs', 'src', 'empty'] });
  const second = captureRevision(f.dir, { paths: ['empty', 'src', 'src/a.mjs'] });
  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  const scope = first.scopes.find(s => s.path === 'src');
  assert.deepEqual(scope.members.map(m => m.path), ['src/a.mjs', 'src/b.mjs']);
  assert.ok(scope.members.every(m => /^[0-9a-f]{64}$/.test(m.sha256)));
  const empty = first.scopes.find(s => s.path === 'empty');
  assert.equal(empty.type, 'directory');
  assert.deepEqual(empty.members, []);
  assert.notEqual(empty.sha256, scope.sha256);
});

test('changed bytes or executable mode produce different revision hashes', t => {
  const f = fixture(t);
  const file = f.put('run.sh', '#!/bin/sh\necho one\n');
  const before = captureRevision(f.dir, { paths: ['run.sh'] });
  writeFileSync(file, '#!/bin/sh\necho two\n');
  const bytes = captureRevision(f.dir, { paths: ['run.sh'] });
  assert.notEqual(bytes.sha256, before.sha256);
  chmodSync(file, 0o755);
  const mode = captureRevision(f.dir, { paths: ['run.sh'] });
  assert.notEqual(mode.sha256, bytes.sha256);
  assert.equal(mode.scopes[0].members[0].mode, 0o755);
});

test('directory scopes detect added and deleted members on verification', t => {
  const f = fixture(t);
  f.put('pkg/keep.txt', 'keep');
  const revision = captureRevision(f.dir, { paths: ['pkg'] });
  assert.equal(verifyRevision(f.dir, revision).match, true);
  f.put('pkg/added.txt', 'added');
  const added = verifyRevision(f.dir, revision);
  assert.equal(added.match, false);
  assert.ok(added.changed_paths.includes('pkg/added.txt'));
  rmSync(join(f.dir, 'pkg/added.txt'));
  rmSync(join(f.dir, 'pkg/keep.txt'));
  const deleted = verifyRevision(f.dir, revision);
  assert.equal(deleted.match, false);
  assert.ok(deleted.changed_paths.includes('pkg/keep.txt'));
});

test('verification recaptures and reports a missing selected file as a clear mismatch', t => {
  const f = fixture(t);
  f.put('gone.txt', 'payload');
  const revision = captureRevision(f.dir, { paths: ['gone.txt'] });
  rmSync(join(f.dir, 'gone.txt'));
  const result = verifyRevision(f.dir, revision);
  assert.equal(result.match, false);
  assert.ok(result.changed_paths.includes('gone.txt'));
  assert.notEqual(result.actual_sha256, result.expected_sha256);
  assert.throws(() => captureRevision(f.dir, { paths: ['gone.txt'] }), /ENOENT/);
});

test('scope tampering and stale expected hashes never verify as a match', t => {
  const f = fixture(t);
  f.put('data.txt', 'original');
  const revision = captureRevision(f.dir, { paths: ['data.txt'] });
  const tampered = structuredClone(revision);
  tampered.scopes[0].members[0].sha256 = '0'.repeat(64);
  tampered.scopes[0].sha256 = '0'.repeat(64);
  assert.equal(verifyRevision(f.dir, tampered).match, false);
  const stale = structuredClone(revision);
  stale.sha256 = 'f'.repeat(64);
  const staleResult = verifyRevision(f.dir, stale);
  assert.equal(staleResult.match, false);
  assert.equal(staleResult.expected_sha256, 'f'.repeat(64));
  assert.equal(staleResult.actual_sha256, revision.sha256);
});

test('absolute, traversal, duplicate and symlinked scopes are rejected', t => {
  const f = fixture(t);
  f.put('inside.txt', 'inside');
  const outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'herdr-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  assert.throws(() => captureRevision(f.dir, { paths: ['../outside.txt'] }), /must not contain/);
  assert.throws(() => captureRevision(f.dir, { paths: ['/etc/hosts'] }), /project-relative/);
  assert.throws(() => captureRevision(f.dir, { paths: ['inside.txt', 'inside.txt'] }), /duplicate/);
  symlinkSync(join(outside, 'secret.txt'), join(f.dir, 'escape.txt'));
  assert.throws(() => captureRevision(f.dir, { paths: ['escape.txt'] }), /symbolic link/);
  symlinkSync(outside, join(f.dir, 'escape-dir'));
  assert.throws(() => captureRevision(f.dir, { paths: ['escape-dir'] }), /symbolic link|unsupported/);
  assert.throws(() => captureRevision(f.dir, { paths: ['escape-dir/secret.txt'] }), /symbolic link/);
  assert.throws(() => normalizeRelativePath('a//b'), /empty/);
});

test('unreadable files and invalid inputs fail explicitly instead of a partial capture', { skip: isRoot }, t => {
  const f = fixture(t);
  const file = f.put('locked.txt', 'locked');
  chmodSync(file, 0o000);
  assert.throws(() => captureRevision(f.dir, { paths: ['locked.txt'] }), error => error.code === 'EACCES' || error.code === 'EPERM');
  chmodSync(file, 0o600);
  assert.throws(() => captureRevision(f.dir, { paths: [] }), /nonempty array/);
  assert.throws(() => captureRevision(join(f.dir, 'missing-dir'), { paths: ['x'] }), /ENOENT/);
  assert.throws(() => captureRevision(f.dir, { paths: [42] }), /nonempty text/);
});

test('bounded evidence rejects oversized or unknown fields and forged verification claims', t => {
  const base = {
    version: 1, worker_id: 'w1', task_id: 't1', session_generation_id: 'g1',
    baseline_revision: null, final_revision: null, changed_paths: ['src/a.mjs'],
    artifacts: [{ path: 'out/report.txt', sha256: 'a'.repeat(64) }],
    tests: [{ argv: ['node', '--test'], cwd: '.', exit_code: 1, output_path: 'out/test.log', truncated: false }],
    limitations: ['No network checks.'], unresolved_requests: [],
  };
  const normalized = validateWorkerEvidence(base);
  assert.equal(normalized.authority, 'worker-claims');
  assert.throws(() => validateWorkerEvidence({ ...base, verified: true }), /Unknown worker evidence field: verified/);
  assert.throws(() => validateWorkerEvidence({ ...base, authority: 'manager-verified' }), /Unknown worker evidence field: authority/);
  assert.throws(() => validateWorkerEvidence({ ...base, artifacts: [{ path: 'x', sha256: 'nope' }] }), /lowercase sha256/);
  assert.throws(() => validateWorkerEvidence({ ...base, tests: [{ argv: ['n'], cwd: '.', exit_code: 1.5, output_path: 'o', truncated: false }] }), /exit_code/);
  assert.throws(() => validateWorkerEvidence({ ...base, changed_paths: ['../escape'] }), /must not contain/);
  assert.throws(() => validateWorkerEvidence({ ...base, changed_paths: Array(LIMITS.maxChangedPaths + 1).fill('a') }), /limit/);
  assert.throws(() => validateWorkerEvidence({ ...base, limitations: ['x'.repeat(LIMITS.maxNoteLength + 1)] }), /exceeds/);
  assert.throws(() => validateWorkerEvidence({ ...base, artifacts: Array(LIMITS.maxArtifacts + 1).fill({ path: 'a', sha256: 'a'.repeat(64) }) }), /limit/);
});

test('overlapping scopes verify only while the canonical manifest is internally consistent', t => {
  const f = fixture(t);
  f.put('src/a.mjs', 'export const a = 1;\n');
  const revision = captureRevision(f.dir, { paths: ['src', 'src/a.mjs'] });
  assert.equal(verifyRevision(f.dir, revision).match, true);
  const tampered = structuredClone(revision);
  const dirScope = tampered.scopes.find(scope => scope.path === 'src');
  const fileScope = tampered.scopes.find(scope => scope.path === 'src/a.mjs');
  assert.equal(dirScope.members[0].sha256, fileScope.members[0].sha256);
  dirScope.members[0].sha256 = 'f'.repeat(64);
  const result = verifyRevision(f.dir, tampered);
  assert.equal(result.match, false);
  assert.equal(result.revision_consistent, false);
  assert.ok(result.changed_paths.includes('src/a.mjs'));
});

test('worker evidence bounds ids, projects, argv, exit codes and serialized payload', t => {
  const base = {
    version: 1, worker_id: 'w1', task_id: 't1', session_generation_id: 'g1',
    baseline_revision: null, final_revision: null, changed_paths: [], artifacts: [], tests: [], limitations: [], unresolved_requests: [],
  };
  assert.throws(() => validateWorkerEvidence({ ...base, worker_id: 'x'.repeat(1024 * 1024) }), /exceeds/);
  assert.throws(() => validateWorkerEvidence({ ...base, task_id: 'x'.repeat(LIMITS.maxIdLength + 1) }), /exceeds/);
  assert.throws(() => validateWorkerEvidence({ ...base, session_generation_id: '' }), /nonempty/);
  assert.throws(() => validateWorkerEvidence({ ...base, final_revision: { sha256: 'a'.repeat(64), project: 'p'.repeat(LIMITS.maxProjectLength + 1) } }), /exceeds/);
  assert.throws(() => validateWorkerEvidence({ ...base, tests: [{ argv: [], cwd: '.', exit_code: 0, output_path: 'o', truncated: false }] }), /must not be empty/);
  assert.throws(() => validateWorkerEvidence({ ...base, tests: [{ argv: ['n'], cwd: '.', exit_code: Number.MAX_SAFE_INTEGER + 2, output_path: 'o', truncated: false }] }), /safe integer/);
  const many = Array.from({ length: LIMITS.maxChangedPaths }, (_, index) => `${'d'.repeat(200)}${index}`);
  assert.throws(() => validateWorkerEvidence({ ...base, changed_paths: many }), /serialized limit/);
});

test('injected timing hooks expose observable concurrent modification', t => {
  const f = fixture(t);
  f.put('race.txt', 'old');
  assert.throws(() => captureRevision(f.dir, { paths: ['race.txt'], hooks: { onRead: ({ absolute }) => writeFileSync(absolute, 'new') } }), error => error.code === 'EVIDENCE_RACE');
  writeFileSync(join(f.dir, 'race.txt'), 'old');
  const revision = captureRevision(f.dir, { paths: ['race.txt'] });
  assert.equal(verifyRevision(f.dir, revision).match, true);
  const raced = verifyRevision(f.dir, revision, { hooks: { onRead: ({ absolute }) => writeFileSync(absolute, 'new') } });
  assert.equal(raced.match, false);
  assert.equal(raced.error.code, 'EVIDENCE_RACE');
  assert.equal(raced.actual_sha256, null);
  f.put('pkg/one.txt', 'one');
  const dirRevision = captureRevision(f.dir, { paths: ['pkg'] });
  assert.throws(() => captureRevision(f.dir, { paths: ['pkg'], hooks: { onDirectory: () => writeFileSync(join(f.dir, 'pkg/two.txt'), 'two') } }), error => error.code === 'EVIDENCE_RACE');
  rmSync(join(f.dir, 'pkg/two.txt'));
  assert.equal(verifyRevision(f.dir, dirRevision).match, true);
});

test('a same-size in-place write during the real read is detected by stat checks', t => {
  const f = fixture(t);
  const file = f.put('probe.txt', 'old');
  const revision = captureRevision(f.dir, { paths: ['probe.txt'] });
  const originalReadSync = fs.readSync;
  let mutated = false;
  fs.readSync = function patched(...args) {
    const count = originalReadSync.apply(this, args);
    if (count > 0 && !mutated) { mutated = true; writeFileSync(file, 'new'); }
    return count;
  };
  syncBuiltinESMExports();
  try {
    const result = verifyRevision(f.dir, revision);
    assert.equal(result.match, false);
    assert.equal(result.error.code, 'EVIDENCE_RACE');
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(file, 'utf8'), 'new');
});

test('evidence validation never reads or follows referenced paths and needs no files', t => {
  const f = fixture(t);
  const locked = f.put('locked.bin', 'content');
  chmodSync(locked, 0o000);
  const value = {
    version: 1, worker_id: 'w1', task_id: 't1', session_generation_id: 'g2',
    baseline_revision: { sha256: 'b'.repeat(64), project: '/nope/baseline' },
    final_revision: { sha256: 'c'.repeat(64), project: '/nope/final' },
    changed_paths: ['does/not/exist.mjs'],
    artifacts: [{ path: 'deleted/output.bin', sha256: 'd'.repeat(64) }, { path: 'locked.bin', sha256: 'e'.repeat(64) }],
    tests: [{ argv: ['false'], cwd: 'deleted', exit_code: 1, output_path: 'deleted/test.log', truncated: false }],
    limitations: [], unresolved_requests: ['Need manager decision.'],
  };
  assert.deepEqual(validateWorkerEvidence(value).artifacts.map(a => a.path), ['deleted/output.bin', 'locked.bin']);
});

test('members are canonically ordered across prefix, punctuation and Unicode siblings', t => {
  const f = fixture(t);
  f.put('src/a/z', 'z');
  f.put('src/a.txt', 'a');
  f.put('src/a0', '0');
  f.put('src/a-é', 'e');
  const revision = captureRevision(f.dir, { paths: ['src'] });
  const paths = revision.scopes[0].members.map(m => m.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(paths.indexOf('src/a.txt') < paths.indexOf('src/a/z'));
  const roundtrip = verifyRevision(f.dir, revision);
  assert.equal(roundtrip.match, true);
  assert.deepEqual(roundtrip.changed_paths, []);
  const overlapping = captureRevision(f.dir, { paths: ['src', 'src/a', 'src/a/z'] });
  assert.equal(verifyRevision(f.dir, overlapping).match, true);
});

test('a mode change before the actual open is rejected instead of silently matched', t => {
  const f = fixture(t);
  const file = f.put('run.sh', 'same');
  chmodSync(file, 0o644);
  const revision = captureRevision(f.dir, { paths: ['run.sh'] });
  assert.equal(revision.scopes[0].members[0].mode, 0o644);
  const originalOpenSync = fs.openSync;
  let changed = false;
  fs.openSync = function patched(...args) {
    if (args[0] === file && !changed) { changed = true; chmodSync(file, 0o755); }
    return originalOpenSync.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    const result = verifyRevision(f.dir, revision);
    assert.equal(result.match, false);
    assert.equal(result.error.code, 'EVIDENCE_RACE');
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }
  assert.equal(statSync(file).mode & 0o777, 0o755);
  assert.equal(captureRevision(f.dir, { paths: ['run.sh'] }).scopes[0].members[0].mode, 0o755);
});

test('directory members reject type-inapplicable fields instead of normalizing them away', t => {
  const f = fixture(t);
  f.put('pkg/sub/one.txt', 'one');
  const revision = captureRevision(f.dir, { paths: ['pkg'] });
  assert.deepEqual(revision.scopes[0].members.find(m => m.type === 'directory'), { path: 'pkg/sub', type: 'directory' });
  for (const extra of [{ mode: 0o644 }, { size: 3 }, { sha256: 'a'.repeat(64) }]) {
    const tampered = structuredClone(revision);
    Object.assign(tampered.scopes[0].members.find(m => m.type === 'directory'), extra);
    assert.throws(() => verifyRevision(f.dir, tampered), /Unknown .* field/);
  }
});
