# Revision and worker-evidence foundation (v1)

`src/evidence.mjs` provides three exports:

- `captureRevision(project, { paths })`
- `verifyRevision(project, revision)`
- `validateWorkerEvidence(value)`

This module is standalone: it does not read or mutate `Store`, tasks, workers or
any private state. It performs no network access and executes nothing from the
data it validates. Plain-text worker reports remain compatible in later
integration and are intentionally not handled here.

## Revision v1

`captureRevision` returns a deterministic snapshot of the exact selected
project-relative scopes:

```js
{
  version: 1,
  project: '/real/absolute/project',        // realpath of the project root
  scopes: [
    { path: 'src/evidence.mjs', type: 'file',
      members: [{ path: 'src/evidence.mjs', type: 'file', mode: 420, size: 9, sha256: '…' }],
      sha256: '…' },                        // hash of this scope
    { path: 'src', type: 'directory',
      members: [ /* sorted descendants: files and directories */ ],
      sha256: '…' }
  ],
  sha256: '…'                               // hash binding version, project and all scope hashes
}
```

Properties:

- **Exact scopes.** `paths` is a nonempty array of project-relative paths. Each
  scope is captured as selected; selecting `src/evidence.mjs` does not pull in
  its siblings, and selecting `src` captures the whole subtree.
- **Sorted members.** Directory members are emitted in codepoint-sorted order
  by full relative path (not directory-entry/DFS order), and scopes are sorted,
  so member order is not caller-dependent and prefix, punctuation and Unicode
  siblings order deterministically.
- **Bytes and mode.** Every file member records its byte `sha256`, its
  permission `mode`, and its `size`. Mode is read from the validated open
  descriptor (not the pre-open `lstat`), so a mode change racing the open is
  detected as `EVIDENCE_RACE`; mode is part of the content hash, so flipping
  the executable bit changes the revision.
- **Addition/deletion detection.** Directory scopes list files *and*
  intermediate directories, including empty directories. A file or directory
  added or removed anywhere under a selected directory changes the scope hash
  and the revision hash.
- **The scope set is hashed.** `revision.sha256` binds the version, the project
  root and every scope hash, so reordering, adding or removing scopes changes
  the revision even when member data is unchanged.
- **Canonical manifest integrity.** `verifyRevision` recomputes every scope hash
  from that scope's actual members and recomputes the top-level hash from those
  scope hashes. A revision whose claimed hashes do not match this recomputation
  is reported as `revision_consistent: false` and can never match, even if the
  top-level hash field was copied from a genuine capture. Member types are
  validated strictly: a `directory` member may only carry `path` and `type`, so
  type-inapplicable `mode`/`size`/`sha256` fields are rejected rather than
  silently dropped. Overlapping scopes
  (for example `['src', 'src/a.mjs']`) are allowed as long as each scope is
  internally consistent.

### Path and file safety

- Paths must be nonempty, `\0`-free, project-relative strings with no absolute
  prefix, no `..` or `.` segments and no empty segments. Duplicates are
  rejected.
- Every ancestor of a selected path is checked with `lstat`; symbolic links are
  rejected outright, so a scope cannot escape the project through a link.
  Symlinks found inside a selected directory are rejected as well.
- Files are opened with `O_RDONLY | O_NOFOLLOW` and re-checked with `fstat`
  before reading. FIFOs, sockets, devices and other special files are rejected.
- Only the selected scopes are read. Nothing outside them is inspected.

### Bounds and explicit failure

Missing default paths are rejected (`captureRevision` fails with `ENOENT`),
never silently omitted. Unsupported files and exceeded limits throw instead of
producing a partial snapshot. Limits are exported as `LIMITS`:

| Limit | Value |
| --- | --- |
| files per capture | 4096 |
| total bytes per capture | 64 MiB |
| single file bytes | 16 MiB |
| directory depth | 32 |
| path length | 1024 |
| worker evidence id/project text | 256 / 4096 |
| serialized worker evidence | 1 MiB |

## Verification

```js
const revision = captureRevision(project, { paths: ['src', 'package.json'] });
// later, on disk:
const result = verifyRevision(project, revision);
// { match, changed_paths, expected_sha256, actual_sha256, revision_consistent, error? }
```

`verifyRevision` re-reads the same selected scopes and compares the recaptured
data against the supplied revision. It **never trusts `revision.sha256`**: a
match requires the canonical manifest to be internally consistent, the fresh
capture's hash to equal the recomputed expected hash *and* no member or scope to
differ. `changed_paths` is the sorted union of added, removed and modified paths
derived from that diff; scopes whose claimed hash fails recomputation are also
listed.

- A deleted selected file or directory is reported as a clear mismatch (the
  member is marked missing in the fresh capture) rather than throwing, because
  verifying a deletion is a legitimate check.
- If the capture itself fails (permissions, special file, limit, a racing
  writer, an invalid revision argument), the result is an explicit
  `match: false` with an `error` object and no changed paths. An unreadable or
  racing capture can never report `match: true`.
- An invalid revision argument throws a `TypeError`.

### Observable race detection

`captureRevision` and `verifyRevision` accept an optional test-only `hooks`
object (`onRead`, `onDirectory`) that runs after a real read or directory listing
without changing hashing. Internally, each file read records the pre-open path
identity and the open descriptor identity before and after the read —
including `mode`, `size`, `dev`, `ino`, nanosecond `mtimeNs`/`ctimeNs` —
re-checks the path and its ancestors, and rejects a mismatch with
`code: 'EVIDENCE_RACE'`. The emitted mode comes from the validated descriptor.
Directory listing captures the stat before and after walking children. Actual
bytes read are counted against the total limit rather than trusting the
pre-read size.

### Snapshot race limits

There is no filesystem transaction. A capture observes a moment in time and
concurrent writers can change bytes, modes or directory membership between
individual `lstat`/`open`/`read` calls. Verification narrows this window by
re-checking identity and high-resolution timestamps, recapturing and diffing,
and rejecting any change it can observe. This is best effort: a writer that
mutates and restores a file, including its timestamps, between the read and the
comparison can still evade detection, and filesystems with coarse timestamp
granularity widen the window. Treat a `match: true` as "the selected scopes were
consistent at capture time", not as proof that nothing else changed.

## Worker evidence v1

`validateWorkerEvidence(value)` strictly validates and normalizes a worker
report:

```js
{
  version: 1,
  worker_id, task_id, session_generation_id,      // nonempty text
  baseline_revision, final_revision,               // null or { sha256, project }
  changed_paths: ['src/a.mjs'],                    // relative, unique, bounded
  artifacts: [{ path, sha256 }],                   // path relative, sha256 lowercase hex
  tests: [{ argv, cwd, exit_code, output_path, truncated }],
  limitations: [ '…' ],
  unresolved_requests: [ '…' ]
}
```

Rules and guarantees:

- Unknown fields are rejected at every level, including any attempt to
  self-declare authority such as `verified`, `authority` or
  `manager_verified`.
- Counts and lengths are bounded (`LIMITS.maxArtifacts`, `maxTests`,
  `maxChangedPaths`, `maxArgv`, `maxNotes`, `maxIdLength`, `maxProjectLength`,
  and the corresponding length caps). Arrays are length-checked before they are
  traversed, `argv` must be nonempty, and `exit_code` must be a safe integer.
- The total serialized payload is limited to `LIMITS.maxEvidenceBytes` (1 MiB);
  a report that fits the per-field caps but serializes larger is rejected.
- The normalized result is tagged `authority: 'worker-claims'`. Every value in a
  worker report is a **worker claim**; the worker must not self-assert runtime
  or manager verification authority.
- Validation is pure data checking. It does not execute `tests`, does not
  `stat`/`read`/follow `changed_paths`, `artifacts`, `output_path`, `cwd` or
  revision references, does not grant permissions, and does not accept results.
  Referenced paths may be missing or unreadable and validation still succeeds.
- `cwd` may be `'.'` for the project root; all other referenced paths use the
  same relative-path rules as revisions.
