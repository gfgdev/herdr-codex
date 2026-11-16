import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishRuntimeSnapshot, readRuntimeSources, runtimeSnapshotKey } from '../src/runtime-snapshot.mjs';
import { prepareWorker } from '../src/workers.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr runtime snapshot '));
  t.after(() => { writableTree(dir); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** Snapshot sources are read-only; restore write permission before mutating or removing. */
function writableTree(root) {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    // Never chmod through a symlink: chmod follows the link and would strip
    // permissions from an unrelated target.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) writableTree(path);
    else chmodSync(path, 0o600);
  }
}

/** A fake installed package: real-looking sources plus files a snapshot must never copy. */
function installedPackage(dir, { extra = false, a = 'export const a = 1;\n' } = {}) {
  const pkg = join(dir, 'plugin-cache-0.8.1');
  mkdirSync(join(pkg, 'src', 'nested'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'a.mjs'), a);
  writeFileSync(join(pkg, 'src', 'b.py'), 'print("b")\n');
  writeFileSync(join(pkg, 'src', 'notes.md'), '# docs\n');
  writeFileSync(join(pkg, 'src', 'model.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(pkg, 'src', '.env'), 'SECRET=do-not-copy\n');
  writeFileSync(join(pkg, 'src', 'nested', 'c.mjs'), 'ignored\n');
  if (extra) writeFileSync(join(pkg, 'src', 'extra.mjs'), 'export const extra = 1;\n');
  return pkg;
}

function configFixture(dir) {
  const stateDir = join(dir, 'state');
  const configPath = join(dir, 'config.json');
  const hc = join(dir, 'hc');
  writeFileSync(hc, '#!/bin/sh\n');
  writeFileSync(configPath, JSON.stringify({
    version: 1, stateDir, hc, app: hc, codex: hc, node: process.execPath,
    profileFile: join(dir, 'profile.json'),
  }));
  return { stateDir, configPath };
}

test('publishes a source-only, content-addressed, immutable snapshot and reuses it', async t => {
  const dir = scratch(t);
  const stateDir = join(dir, 'state');
  const pkg = installedPackage(dir);
  const first = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
  assert.equal(first.reused, false);
  assert.equal(first.root, join(stateDir, 'runtime', first.key));

  // Only .mjs/.py sources plus the manifest are copied. No secrets, docs, binaries
  // or nested directories travel with the runtime.
  assert.deepEqual(readdirSync(first.root).sort(), ['manifest.json', 'src']);
  assert.deepEqual(readdirSync(join(first.root, 'src')), ['a.mjs', 'b.py']);
  assert.ok(!existsSync(join(first.root, 'src', 'notes.md')));
  assert.ok(!existsSync(join(first.root, 'src', 'model.bin')));
  assert.ok(!existsSync(join(first.root, 'src', '.env')));
  assert.ok(!existsSync(join(first.root, 'src', 'nested')));

  // Immutable publication: files read-only, directories read+execute only.
  for (const path of ['src/a.mjs', 'src/b.py', 'manifest.json']) {
    assert.equal(statSync(join(first.root, path)).mode & 0o777, 0o400, path);
  }
  for (const path of ['', 'src']) assert.equal(statSync(join(first.root, path)).mode & 0o777, 0o500, path || '.');

  const manifest = JSON.parse(readFileSync(join(first.root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.key, first.key);
  assert.deepEqual(manifest.files.map(f => f.path), ['src/a.mjs', 'src/b.py']);

  // Publishing identical content reuses the same immutable directory.
  const again = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
  assert.deepEqual(again, { root: first.root, key: first.key, reused: true });

  // New content yields a new key and leaves the earlier snapshot intact.
  writeFileSync(join(pkg, 'src', 'extra.mjs'), 'export const extra = 1;\n');
  const widened = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
  assert.notEqual(widened.key, first.key);
  assert.equal(widened.reused, false);
  assert.equal(readFileSync(join(first.root, 'src', 'a.mjs'), 'utf8'), 'export const a = 1;\n');
  assert.deepEqual(readdirSync(join(stateDir, 'runtime')).sort(), [first.key, widened.key].sort());

  // Changing an existing source also changes the key.
  writeFileSync(join(pkg, 'src', 'a.mjs'), 'export const a = 2;\n');
  const changed = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
  assert.notEqual(changed.key, widened.key);
});

test('key derivation is stable and independent of directory layout', async t => {
  const dir = scratch(t);
  const pkgA = installedPackage(join(dir, 'a'));
  const pkgB = installedPackage(join(dir, 'b'));
  const filesA = (await readRuntimeSources(pkgA)).files;
  const filesB = (await readRuntimeSources(pkgB)).files;
  assert.equal(runtimeSnapshotKey(filesA), runtimeSnapshotKey(filesB));
  assert.notEqual(runtimeSnapshotKey(filesA), runtimeSnapshotKey((await readRuntimeSources(installedPackage(join(dir, 'c'), { extra: true }))).files));
  await assert.rejects(readRuntimeSources(join(dir, 'missing')), /no src directory/);
});

test('concurrent publication converges on exactly one validated snapshot', async t => {
  const dir = scratch(t);
  const stateDir = join(dir, 'state');
  const pkg = installedPackage(dir);
  const results = await Promise.all(Array.from({ length: 8 }, () => publishRuntimeSnapshot({ packageRoot: pkg, stateDir })));
  const root = results[0].root;
  assert.ok(results.every(r => r.root === root && r.key === results[0].key));
  assert.equal(results.filter(r => r.reused === false).length, 1);
  assert.deepEqual(readdirSync(join(stateDir, 'runtime')), [results[0].key]);
  assert.deepEqual(readdirSync(join(root, 'src')), ['a.mjs', 'b.py']);
});

test('a tampered, extended or substituted snapshot is refused rather than trusted', async t => {
  const dir = scratch(t);

  // Modified recorded file.
  {
    const stateDir = join(dir, 'tampered');
    const pkg = installedPackage(join(dir, 'p1'));
    const { root } = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
    writableTree(root);
    writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 999;\n');
    await assert.rejects(publishRuntimeSnapshot({ packageRoot: pkg, stateDir }), /does not match its recorded content/);
  }

  // Injected extra executable file.
  {
    const stateDir = join(dir, 'extended');
    const pkg = installedPackage(join(dir, 'p2'));
    const { root } = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
    writableTree(root);
    writeFileSync(join(root, 'src', 'evil.mjs'), 'export const evil = 1;\n');
    await assert.rejects(publishRuntimeSnapshot({ packageRoot: pkg, stateDir }), /does not match its recorded content/);
  }

  // Corrupt manifest.
  {
    const stateDir = join(dir, 'manifest');
    const pkg = installedPackage(join(dir, 'p3'));
    const { root } = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
    writableTree(root);
    writeFileSync(join(root, 'manifest.json'), '{not json');
    await assert.rejects(publishRuntimeSnapshot({ packageRoot: pkg, stateDir }), /does not match its recorded content/);
  }

  // Substituted directory (symlink escape).
  {
    const stateDir = join(dir, 'substituted');
    const pkg = installedPackage(join(dir, 'p4'));
    const { root } = await publishRuntimeSnapshot({ packageRoot: pkg, stateDir });
    writableTree(root);
    rmSync(root, { recursive: true, force: true });
    symlinkSync(pkg, root);
    await assert.rejects(publishRuntimeSnapshot({ packageRoot: pkg, stateDir }), /does not match its recorded content/);
  }
});

test('worker helper, launch hook and bridge CLI stay runnable after the installed runtime is removed', async t => {
  const dir = scratch(t);
  const stateDir = join(dir, 'state');
  const installed = join(dir, 'plugin-cache');
  mkdirSync(installed, { recursive: true });
  cpSync(join(repoRoot, 'src'), join(installed, 'src'), { recursive: true });

  const { root: snapshotRoot } = await publishRuntimeSnapshot({ packageRoot: installed, stateDir });

  const project = join(dir, 'project'); mkdirSync(project);
  const profileFile = join(dir, 'profile.json');
  writeFileSync(profileFile, JSON.stringify({
    model: 'selected-model', endpoint: 'https://model.example.invalid/v1',
    credentialFile: join(dir, 'credential-does-not-exist'), python: '/usr/bin/python3',
  }));
  const prepared = await prepareWorker({
    version: 1, id: 'worker-1', taskId: 'task-1', name: 'native Pi', role: 'pi',
    project, stateDir: join(dir, 'worker'), hc: join(dir, 'hc'), node: process.execPath,
    profileFile, packageRoot: snapshotRoot, mailbox: 'task-1', readPaths: [],
  });
  const saved = JSON.parse(readFileSync(prepared.configFile, 'utf8'));
  assert.equal(saved.packageRoot, snapshotRoot);
  assert.equal(prepared.argv[1], join(snapshotRoot, 'src', 'worker-launch.py'));

  // The plugin cache is pruned exactly as a reinstall would prune it.
  rmSync(installed, { recursive: true, force: true });
  assert.ok(!existsSync(installed));
  for (const file of ['cli.mjs', 'message-cli.mjs', 'worker-launch.py', 'goose-status.py', 'recipes.mjs', 'command-worker.py', 'agent-mcp.mjs']) {
    assert.ok(existsSync(join(snapshotRoot, 'src', file)), file);
  }

  // Helper installed by prepareWorker still runs.
  const helper = spawnSync(join(prepared.stateDir, 'bin', 'herdr-message'), ['--help'], { encoding: 'utf8' });
  assert.equal(helper.status, 0, helper.stderr);
  assert.match(helper.stdout, /herdr-message/);

  // Launch hook runs from the snapshot and reaches its native-runtime gate.
  const hook = spawnSync('/usr/bin/python3', [join(snapshotRoot, 'src', 'worker-launch.py'), prepared.configFile], {
    cwd: project, encoding: 'utf8', env: { ...process.env, HC_TERMINAL_ID: '' },
  });
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, /Herdr worker launch failed/);
  assert.match(hook.stderr, /Start this native worker through Herdr/);

  // The same CLI entrypoint the bridge spawns still answers from the snapshot.
  const { configPath } = configFixture(dir);
  const bridge = spawnSync(process.execPath, [join(snapshotRoot, 'src', 'cli.mjs'), '--config', configPath, 'bridge', 'status'], { encoding: 'utf8' });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(JSON.parse(bridge.stdout).status, 'not-started');

  // A bridge launched from the snapshot pins itself to the same immutable copy.
  assert.equal(await (async () => (await publishRuntimeSnapshot({ packageRoot: snapshotRoot, stateDir })).reused)(), true);
});
