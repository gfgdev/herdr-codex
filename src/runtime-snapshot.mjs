import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, lstat, writeFile, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// Source-only, content-addressed runtime snapshots. A snapshot contains exactly
// the shipped program sources (`src/*.mjs`, `src/*.py`) and a manifest. It never
// contains credentials, user state or model/binaries. Snapshots are immutable:
// files are published once as read-only and identity is derived from content, so
// an installed package can be pruned or replaced while workers and the bridge
// keep running from a durable copy.
export const RUNTIME_SNAPSHOT_VERSION = 1;
const SOURCE = /\.(mjs|py)$/;

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a nonempty path`);
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  return resolve(value);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fsyncDir(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Staging directories are sealed read-only before rename. A loser of a
// concurrent publication still owns its staging tree, so restore directory
// write permission before removing it (unlink needs directory write, not file
// write).
async function discardStaging(path) {
  await chmod(path, 0o700).catch(() => {});
  await chmod(join(path, 'src'), 0o700).catch(() => {});
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

/** Read the source-only runtime inputs shipped in src/ (regular .mjs/.py files). */
export async function readRuntimeSources(packageRoot) {
  const root = assertAbsolute(packageRoot, 'packageRoot');
  const src = join(root, 'src');
  let names;
  try { names = await readdir(src); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Runtime package has no src directory: ${root}`); throw error; }
  const selected = names.filter(name => SOURCE.test(name)).sort();
  if (!selected.length) throw new Error(`Runtime package has no src/*.mjs or src/*.py sources: ${root}`);
  const files = [];
  for (const name of selected) {
    const path = join(src, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Runtime source must be a regular file: ${path}`);
    files.push({ path: `src/${name}`, content: await readFile(path) });
  }
  return { root, files };
}

/** Content key over source paths and bytes; identical sources reuse one snapshot. */
export function runtimeSnapshotKey(files) {
  const manifest = files.map(file => ({ path: file.path, sha256: sha256(file.content), bytes: file.content.length }));
  return `v${RUNTIME_SNAPSHOT_VERSION}-${sha256(JSON.stringify([RUNTIME_SNAPSHOT_VERSION, manifest]))}`;
}

async function inspectSnapshot(root, files, key) {
  let info;
  try { info = await lstat(root); }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) return 'mismatch';
  const top = await readdir(root).catch(() => null);
  if (!top || top.length !== 2 || !top.includes('src') || !top.includes('manifest.json')) return 'mismatch';
  const src = join(root, 'src');
  const srcInfo = await lstat(src).catch(() => null);
  if (!srcInfo || srcInfo.isSymbolicLink() || !srcInfo.isDirectory()) return 'mismatch';
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')); }
  catch { return 'mismatch'; }
  if (!manifest || manifest.version !== RUNTIME_SNAPSHOT_VERSION || manifest.key !== key || !Array.isArray(manifest.files)) return 'mismatch';
  const recorded = new Map(manifest.files.map(file => [file.path, file]));
  if (recorded.size !== files.length) return 'mismatch';
  const names = await readdir(src);
  if (names.length !== files.length) return 'mismatch';
  for (const file of files) {
    const name = file.path.slice('src/'.length);
    const record = recorded.get(file.path);
    if (!record || !names.includes(name)) return 'mismatch';
    const path = join(src, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return 'mismatch';
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    if (digest !== record.sha256 || bytes.length !== record.bytes || digest !== sha256(file.content)) return 'mismatch';
  }
  return 'valid';
}

/**
 * Publish, or safely reuse, an immutable source-only runtime snapshot under
 * `<stateDir>/runtime/<content-key>` and return its root. Publication is atomic
 * (staged directory + rename) and every reuse revalidates recorded content, so a
 * tampered or partial snapshot is refused rather than trusted.
 */
export async function publishRuntimeSnapshot({ packageRoot, stateDir }) {
  const state = assertAbsolute(stateDir, 'stateDir');
  const { files } = await readRuntimeSources(packageRoot);
  const key = runtimeSnapshotKey(files);
  const base = join(state, 'runtime');
  const root = join(base, key);
  const current = await inspectSnapshot(root, files, key);
  if (current === 'valid') return { root, key, reused: true };
  if (current === 'mismatch') throw new Error(`Immutable runtime snapshot does not match its recorded content: ${root}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staging = join(base, `.staging-${randomUUID()}`);
  let published = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    await mkdir(join(staging, 'src'), { mode: 0o700 });
    for (const file of files) {
      await writeFile(join(staging, file.path), file.content, { flag: 'wx', mode: 0o400 });
    }
    const manifest = {
      version: RUNTIME_SNAPSHOT_VERSION, key,
      files: files.map(file => ({ path: file.path, sha256: sha256(file.content), bytes: file.content.length })),
    };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
    await chmod(join(staging, 'src'), 0o500);
    await chmod(staging, 0o500);
    await fsyncDir(staging);
    try {
      await rename(staging, root);
      published = true;
    } catch (error) {
      // A concurrent publisher may have won the rename. On APFS a collision with
      // a read-only staging tree surfaces as EACCES rather than ENOTEMPTY, so any
      // rename failure is resolved by re-inspecting the destination: accept iff it
      // is a valid snapshot for exactly this content, otherwise surface the error.
      const state = await inspectSnapshot(root, files, key).catch(() => 'missing');
      if (state === 'valid') return { root, key, reused: true };
      if (state === 'mismatch') {
        throw new Error(`Concurrent runtime snapshot publication produced a different result: ${root}`);
      }
      throw error;
    }
    await fsyncDir(base);
    return { root, key, reused: false };
  } finally {
    if (!published) await discardStaging(staging);
  }
}
