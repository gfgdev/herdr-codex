import { createHash } from 'node:crypto';
import { constants, lstatSync, fstatSync, openSync, closeSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Revision / worker-evidence foundation.
 *
 * Revision v1 binds the exact selected relative scopes, the sorted member paths,
 * each file's byte sha256 and executable mode, and a hash of the scope set
 * itself into a deterministic content hash.
 *
 * Snapshotting is best effort: there is no filesystem transaction. A capture
 * observes a moment in time and concurrent writers can race it. Verification
 * therefore recaptures from disk and compares; it never trusts a claimed hash
 * and it rejects changes it can observe (inode, size, nanosecond mtime/ctime,
 * directory membership). Perfect filesystem atomicity is not claimed.
 *
 * Worker evidence is strictly bounded data. Every value produced by
 * `validateWorkerEvidence` is a WORKER CLAIM. The validator never executes
 * tests, follows referenced paths, grants permissions, or accepts results.
 */

export const LIMITS = Object.freeze({
  maxFiles: 4096,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxPathLength: 1024,
  maxIdLength: 256,
  maxProjectLength: 4096,
  maxArtifacts: 2048,
  maxTests: 512,
  maxChangedPaths: 8192,
  maxArgv: 64,
  maxArgLength: 4096,
  maxNotes: 128,
  maxNoteLength: 4096,
  maxEvidenceBytes: 1024 * 1024,
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be nonempty text without NUL`);
  }
  return value;
}

function boundedText(value, name, max) {
  const parsed = text(value, name);
  if (parsed.length > max) throw new RangeError(`${name} exceeds ${max} characters`);
  return parsed;
}

function fields(value, allowed, name) {
  if (!object(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field: ${key}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSha256(value, name) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${name} must be a lowercase sha256 hex digest`);
  return value;
}

/** Validate a project-relative path and return its normalized form. */
export function normalizeRelativePath(input, name = 'path') {
  const raw = text(input, name);
  if (raw.length > LIMITS.maxPathLength) throw new RangeError(`${name} exceeds ${LIMITS.maxPathLength} characters`);
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\')) throw new TypeError(`${name} must be project-relative, not absolute`);
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new TypeError(`${name} must not contain empty, "." or ".." segments: ${raw}`);
  }
  return segments.join('/');
}

function unsupported(entry, name) {
  const kind = entry.isFIFO() ? 'FIFO' : entry.isSocket() ? 'socket' : entry.isCharacterDevice() ? 'character device'
    : entry.isBlockDevice() ? 'block device' : 'special file';
  return new TypeError(`${name} is an unsupported ${kind}`);
}

function raceError(name) {
  const error = new Error(`detected concurrent modification while capturing ${name}`);
  error.name = 'EvidenceRaceError';
  error.code = 'EVIDENCE_RACE';
  return error;
}

function assertNoSymlinkAncestors(root, rel, name) {
  const segments = rel.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) throw new TypeError(`${name} escapes through a symbolic link: ${segments.slice(0, index + 1).join('/')}`);
    if (index < segments.length - 1 && !entry.isDirectory()) throw new TypeError(`${name} has a non-directory ancestor: ${segments.slice(0, index + 1).join('/')}`);
  }
  return current;
}

/** Compare identity, mode and high-resolution timestamps that a read depends on. */
function sameStat(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function readMember(root, rel, name, state, hooks) {
  const absolute = assertNoSymlinkAncestors(root, rel, name);
  const pathBefore = lstatSync(absolute, { bigint: true });
  if (pathBefore.isSymbolicLink()) throw new TypeError(`${name} is a symbolic link`);
  if (!pathBefore.isFile()) throw unsupported(pathBefore, name);
  if (pathBefore.size > BigInt(LIMITS.maxFileBytes)) throw new RangeError(`${name} exceeds the ${LIMITS.maxFileBytes}-byte file limit`);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes, mode;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw unsupported(before, name);
    if (!sameStat(pathBefore, before)) throw raceError(name);
    if (before.size > BigInt(LIMITS.maxFileBytes)) throw new RangeError(`${name} exceeds the ${LIMITS.maxFileBytes}-byte file limit`);
    const chunks = [];
    let offset = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, LIMITS.maxFileBytes - offset + 1));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      offset += count;
      if (offset > LIMITS.maxFileBytes) throw new RangeError(`${name} exceeds the ${LIMITS.maxFileBytes}-byte file limit`);
    }
    bytes = Buffer.concat(chunks, offset);
    hooks?.onRead?.({ path: rel, absolute });
    const after = fstatSync(fd, { bigint: true });
    if (!sameStat(before, after)) throw raceError(name);
    const current = assertNoSymlinkAncestors(root, rel, name);
    const pathAfter = lstatSync(current, { bigint: true });
    if (!sameStat(after, pathAfter)) throw raceError(name);
    mode = Number(before.mode & 0o777n);
  } finally {
    closeSync(fd);
  }
  state.bytes += bytes.length;
  if (state.bytes > LIMITS.maxTotalBytes) throw new RangeError(`capture exceeds the ${LIMITS.maxTotalBytes}-byte total limit`);
  return { path: rel, type: 'file', mode, size: bytes.length, sha256: sha256(bytes) };
}

function walkDirectory(root, rel, name, state, depth, hooks) {
  if (depth > LIMITS.maxDepth) throw new RangeError(`${name} exceeds the recursion depth limit of ${LIMITS.maxDepth}`);
  const absolute = assertNoSymlinkAncestors(root, rel, name);
  const entry = lstatSync(absolute, { bigint: true });
  if (!entry.isDirectory()) throw new TypeError(`${name} must be a directory`);
  const members = [];
  const names = readdirSync(absolute).sort();
  hooks?.onDirectory?.({ path: rel, absolute });
  for (const child of names) {
    const childRel = `${rel}/${child}`;
    state.count += 1;
    if (state.count > LIMITS.maxFiles) throw new RangeError(`capture exceeds the ${LIMITS.maxFiles}-file limit`);
    const childAbsolute = join(absolute, child);
    const childEntry = lstatSync(childAbsolute, { bigint: true });
    if (childEntry.isSymbolicLink()) throw new TypeError(`symbolic link is not allowed in a selected scope: ${childRel}`);
    if (childEntry.isDirectory()) {
      members.push({ path: childRel, type: 'directory' });
      members.push(...walkDirectory(root, childRel, childRel, state, depth + 1, hooks));
    } else if (childEntry.isFile()) {
      members.push(readMember(root, childRel, childRel, state, hooks));
    } else {
      throw unsupported(childEntry, childRel);
    }
  }
  const after = lstatSync(absolute, { bigint: true });
  if (!sameStat(entry, after)) throw raceError(name);
  members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return members;
}

function scopeHash(scope) {
  return sha256(JSON.stringify({ path: scope.path, type: scope.type, members: scope.members }));
}

function revisionHash(project, scopes) {
  return sha256(JSON.stringify({ version: 1, project, scopes: scopes.map(scope => ({ path: scope.path, type: scope.type, sha256: scope.sha256 })) }));
}

function capture(project, paths, { allowMissing, hooks } = {}) {
  if (typeof project !== 'string' || project.length === 0) throw new TypeError('project must be a nonempty path');
  const root = realpathSync(project);
  if (!lstatSync(root).isDirectory()) throw new TypeError('project must be a directory');
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('paths must be a nonempty array of project-relative paths');
  const seen = new Set();
  const normalized = paths.map((value, index) => {
    const rel = normalizeRelativePath(value, `paths[${index}]`);
    if (seen.has(rel)) throw new TypeError(`duplicate selected path: ${rel}`);
    seen.add(rel);
    return rel;
  });
  const state = { count: 0, bytes: 0 };
  const scopes = [];
  for (const rel of normalized.sort()) {
    state.count += 1;
    if (state.count > LIMITS.maxFiles) throw new RangeError(`capture exceeds the ${LIMITS.maxFiles}-file limit`);
    let absolute;
    try {
      absolute = assertNoSymlinkAncestors(root, rel, rel);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') { scopes.push({ path: rel, type: 'missing', members: [], sha256: null }); continue; }
      throw error;
    }
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new TypeError(`${rel} is a symbolic link`);
    if (entry.isDirectory()) {
      const members = walkDirectory(root, rel, rel, state, 1, hooks);
      const scope = { path: rel, type: 'directory', members };
      scopes.push({ ...scope, sha256: scopeHash(scope) });
    } else if (entry.isFile()) {
      const member = readMember(root, rel, rel, state, hooks);
      const scope = { path: rel, type: 'file', members: [member] };
      scopes.push({ ...scope, sha256: scopeHash(scope) });
    } else {
      throw unsupported(entry, rel);
    }
  }
  return { version: 1, project: root, scopes, sha256: revisionHash(root, scopes) };
}

/**
 * Capture a deterministic revision of the exact selected project-relative scopes.
 * Missing default paths are rejected; unsupported files, bounded limits and
 * observed concurrent modification fail explicitly rather than producing a
 * partial snapshot. `hooks` is an optional test-only instrumentation point
 * (`onRead`, `onDirectory`) that never alters hashing.
 */
export function captureRevision(project, { paths, hooks } = {}) {
  return capture(project, paths, { allowMissing: false, hooks });
}

/**
 * Structurally validate a revision and recompute its canonical manifest so the
 * claimed per-scope and top-level hashes can be checked against their members.
 */
function normalizeRevision(revision) {
  fields(revision, ['version', 'project', 'scopes', 'sha256'], 'revision');
  if (revision.version !== 1) throw new TypeError('revision.version must be 1');
  boundedText(revision.project, 'revision.project', LIMITS.maxProjectLength);
  isSha256(revision.sha256, 'revision.sha256');
  if (!Array.isArray(revision.scopes) || revision.scopes.length === 0) throw new TypeError('revision.scopes must be a nonempty array');
  if (revision.scopes.length > LIMITS.maxFiles) throw new RangeError('revision.scopes exceeds the file limit');
  const seenScopes = new Set();
  let memberCount = 0;
  const scopes = revision.scopes.map((scope, index) => {
    const name = `revision.scopes[${index}]`;
    fields(scope, ['path', 'type', 'members', 'sha256'], name);
    const scopePath = normalizeRelativePath(scope.path, `${name}.path`);
    if (seenScopes.has(scopePath)) throw new TypeError(`revision.scopes contains a duplicate scope: ${scopePath}`);
    seenScopes.add(scopePath);
    if (!['file', 'directory'].includes(scope.type)) throw new TypeError(`${name}.type must be file or directory`);
    isSha256(scope.sha256, `${name}.sha256`);
    if (!Array.isArray(scope.members)) throw new TypeError(`${name}.members must be an array`);
    if (scope.members.length > LIMITS.maxFiles) throw new RangeError(`${name}.members exceeds the file limit`);
    memberCount += scope.members.length;
    if (memberCount > LIMITS.maxFiles) throw new RangeError('revision contains too many members');
    const seenMembers = new Set();
    let previous = null;
    const members = scope.members.map((member, position) => {
      const memberName = `${name}.members[${position}]`;
      if (!object(member)) throw new TypeError(`${memberName} must be an object`);
      if (member.type === 'directory') {
        fields(member, ['path', 'type'], memberName);
        return { path: normalizeRelativePath(member.path, `${memberName}.path`), type: 'directory' };
      }
      if (member.type !== 'file') throw new TypeError(`${memberName}.type must be file or directory`);
      fields(member, ['path', 'type', 'mode', 'size', 'sha256'], memberName);
      const memberPath = normalizeRelativePath(member.path, `${memberName}.path`);
      const contained = scope.type === 'file' ? memberPath === scopePath : memberPath === scopePath || memberPath.startsWith(`${scopePath}/`);
      if (!contained) throw new TypeError(`${memberName}.path is not contained in its scope`);
      if (seenMembers.has(memberPath)) throw new TypeError(`duplicate member path in ${name}: ${memberPath}`);
      seenMembers.add(memberPath);
      if (previous !== null && memberPath < previous) throw new TypeError(`${name}.members must be sorted by path`);
      previous = memberPath;
      isSha256(member.sha256, `${memberName}.sha256`);
      if (!Number.isInteger(member.mode) || member.mode < 0 || member.mode > 0o777) throw new TypeError(`${memberName}.mode must be permission bits`);
      if (!Number.isInteger(member.size) || member.size < 0 || member.size > LIMITS.maxFileBytes) throw new TypeError(`${memberName}.size must be within the file limit`);
      return { path: memberPath, type: 'file', mode: member.mode, size: member.size, sha256: member.sha256 };
    });
    if (scope.type === 'file' && members.length !== 1) throw new TypeError(`${name} must contain exactly one file member`);
    return { path: scopePath, type: scope.type, members, sha256: scopeHash({ path: scopePath, type: scope.type, members }), claimed_sha256: scope.sha256 };
  });
  scopes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let index = 1; index < scopes.length; index += 1) {
    if (scopes[index].path === scopes[index - 1].path) throw new TypeError(`revision.scopes contains a duplicate scope: ${scopes[index].path}`);
  }
  const consistent = scopes.every(scope => scope.sha256 === scope.claimed_sha256)
    && revisionHash(revision.project, scopes) === revision.sha256;
  return { project: revision.project, scopes, sha256: revisionHash(revision.project, scopes), consistent };
}

/**
 * Recapture the revision's selected scopes and compare. Returns an explicit
 * match/mismatch and the changed paths. The claimed hashes are never trusted:
 * the canonical manifest is recomputed from the actual members and from a fresh
 * capture. An inconsistent manifest, an unreadable capture or an observed race
 * can never report a match.
 */
export function verifyRevision(project, revision, { hooks } = {}) {
  const expected = normalizeRevision(revision);
  let actual;
  try {
    actual = capture(project, expected.scopes.map(scope => scope.path), { allowMissing: true, hooks });
  } catch (error) {
    return { match: false, changed_paths: [], expected_sha256: revision.sha256, actual_sha256: null,
      revision_consistent: expected.consistent,
      error: { name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code ?? null } };
  }
  const changed = new Set();
  const actualByScope = new Map(actual.scopes.map(scope => [scope.path, scope]));
  for (const scope of expected.scopes) {
    const opposite = actualByScope.get(scope.path);
    if (!opposite || opposite.type !== scope.type || opposite.sha256 !== scope.sha256) changed.add(scope.path);
    const oppositeMembers = new Map((opposite?.members ?? []).map(member => [member.path, JSON.stringify(member)]));
    for (const member of scope.members) if (oppositeMembers.get(member.path) !== JSON.stringify(member)) changed.add(member.path);
    const expectedMembers = new Set(scope.members.map(member => member.path));
    for (const member of opposite?.members ?? []) if (!expectedMembers.has(member.path)) changed.add(member.path);
    if (!expected.consistent && scope.sha256 !== scope.claimed_sha256) changed.add(scope.path);
  }
  for (const scope of actual.scopes) if (!expected.scopes.some(item => item.path === scope.path)) changed.add(scope.path);
  const changed_paths = [...changed].sort();
  return {
    match: expected.consistent && actual.sha256 === expected.sha256 && changed_paths.length === 0,
    changed_paths,
    expected_sha256: revision.sha256,
    actual_sha256: actual.sha256,
    revision_consistent: expected.consistent,
  };
}

function boundedArray(value, name, max) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > max) throw new RangeError(`${name} exceeds the ${max}-item limit`);
  return value;
}

function note(value, name) {
  return boundedText(value, name, LIMITS.maxNoteLength);
}

function revisionReference(value, name) {
  if (value === null) return null;
  fields(value, ['sha256', 'project'], name);
  return { sha256: isSha256(value.sha256, `${name}.sha256`), project: boundedText(value.project, `${name}.project`, LIMITS.maxProjectLength) };
}

/**
 * Validate worker evidence v1. Returns a normalized copy tagged as worker
 * claims. Unknown fields (including any self-declared verification authority)
 * are rejected. Strings, arrays and the serialized payload are bounded. This
 * function performs no filesystem access and no execution.
 */
export function validateWorkerEvidence(value) {
  fields(value, ['version', 'worker_id', 'task_id', 'session_generation_id', 'baseline_revision', 'final_revision',
    'changed_paths', 'artifacts', 'tests', 'limitations', 'unresolved_requests'], 'worker evidence');
  if (value.version !== 1) throw new TypeError('worker evidence version must be 1');
  const changed_paths = boundedArray(value.changed_paths ?? [], 'worker evidence.changed_paths', LIMITS.maxChangedPaths)
    .map((item, index) => normalizeRelativePath(item, `worker evidence.changed_paths[${index}]`));
  if (new Set(changed_paths).size !== changed_paths.length) throw new TypeError('worker evidence.changed_paths contains duplicates');
  const artifacts = boundedArray(value.artifacts ?? [], 'worker evidence.artifacts', LIMITS.maxArtifacts).map((artifact, index) => {
    fields(artifact, ['path', 'sha256'], `worker evidence.artifacts[${index}]`);
    return { path: normalizeRelativePath(artifact.path, `worker evidence.artifacts[${index}].path`),
      sha256: isSha256(artifact.sha256, `worker evidence.artifacts[${index}].sha256`) };
  });
  const tests = boundedArray(value.tests ?? [], 'worker evidence.tests', LIMITS.maxTests).map((entry, index) => {
    const name = `worker evidence.tests[${index}]`;
    fields(entry, ['argv', 'cwd', 'exit_code', 'output_path', 'truncated'], name);
    const argv = boundedArray(entry.argv, `${name}.argv`, LIMITS.maxArgv)
      .map((arg, position) => boundedText(arg, `${name}.argv[${position}]`, LIMITS.maxArgLength));
    if (argv.length === 0) throw new TypeError(`${name}.argv must not be empty`);
    if (!Number.isSafeInteger(entry.exit_code)) throw new TypeError(`${name}.exit_code must be a safe integer`);
    if (typeof entry.truncated !== 'boolean') throw new TypeError(`${name}.truncated must be a boolean`);
    return { argv, cwd: entry.cwd === '.' ? '.' : normalizeRelativePath(entry.cwd, `${name}.cwd`), exit_code: entry.exit_code,
      output_path: normalizeRelativePath(entry.output_path, `${name}.output_path`), truncated: entry.truncated };
  });
  const notes = (key) => boundedArray(value[key] ?? [], `worker evidence.${key}`, LIMITS.maxNotes)
    .map((item, index) => note(item, `worker evidence.${key}[${index}]`));
  const normalized = {
    version: 1,
    authority: 'worker-claims',
    worker_id: boundedText(value.worker_id, 'worker evidence.worker_id', LIMITS.maxIdLength),
    task_id: boundedText(value.task_id, 'worker evidence.task_id', LIMITS.maxIdLength),
    session_generation_id: boundedText(value.session_generation_id, 'worker evidence.session_generation_id', LIMITS.maxIdLength),
    baseline_revision: revisionReference(value.baseline_revision ?? null, 'worker evidence.baseline_revision'),
    final_revision: revisionReference(value.final_revision ?? null, 'worker evidence.final_revision'),
    changed_paths,
    artifacts,
    tests,
    limitations: notes('limitations'),
    unresolved_requests: notes('unresolved_requests'),
  };
  if (Buffer.byteLength(JSON.stringify(normalized)) > LIMITS.maxEvidenceBytes) {
    throw new RangeError(`worker evidence exceeds the ${LIMITS.maxEvidenceBytes}-byte serialized limit`);
  }
  return normalized;
}
