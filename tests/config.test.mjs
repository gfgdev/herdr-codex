import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultConfigPath, resolveConfigPath, readConfig, installConfigReference } from '../src/config.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr config with spaces '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'user home');
  const options = { home, env: {} };
  function config(name = 'selected') {
    const path = join(dir, `${name}.json`);
    const value = { version: 1, stateDir: join(dir, `${name} state`),
      hc: join(dir, `${name} hc`), app: join(dir, `${name} app`), codex: join(dir, `${name} codex`),
      node: process.execPath, profileFile: join(dir, 'profile-never-read.json') };
    writeFileSync(path, JSON.stringify(value));
    return { path, value };
  }
  function putDefault(value) {
    const path = defaultConfigPath(home);
    mkdirSync(join(home, '.config/herdr-codex'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  return { dir, home, options, config, putDefault };
}

test('explicit, environment and fixed user config have strict precedence', t => {
  const f = fixture(t), first = f.config('explicit'), second = f.config('environment'), third = f.config('default');
  const defaultPath = f.putDefault(third.value);
  const options = { home: f.home, env: { HERDR_CODEX_CONFIG: second.path, XDG_CONFIG_HOME: '/ignored' } };
  assert.equal(readConfig(first.path, options).path, first.path);
  assert.equal(readConfig(undefined, options).path, second.path);
  assert.equal(readConfig(undefined, f.options).path, defaultPath);
  assert.equal(resolveConfigPath(undefined, f.options), defaultPath);
  assert.equal(defaultPath, join(f.home, '.config/herdr-codex/config.json'));
});

test('a missing selected configuration fails rather than selecting a different installation', t => {
  const f = fixture(t), selected = f.config();
  f.putDefault(selected.value);
  const missing = join(f.dir, 'missing.json');
  assert.throws(() => readConfig(missing, { home: f.home, env: { HERDR_CODEX_CONFIG: selected.path } }), /No Herdr–Codex configuration/);
  assert.throws(() => readConfig(undefined, { home: f.home, env: { HERDR_CODEX_CONFIG: missing } }), /No Herdr–Codex configuration/);
  assert.equal(existsSync(selected.value.stateDir), false);
});

test('one private reference selects the exact existing config and detached-process path', t => {
  const f = fixture(t), selected = f.config();
  const pointer = f.putDefault({ version: 1, configFile: selected.path });
  const loaded = readConfig(undefined, f.options);
  assert.equal(loaded.path, selected.path);
  assert.equal(loaded.configReference, pointer);
  assert.equal(loaded.hc, selected.value.hc);
  assert.equal(loaded.stateDir, selected.value.stateDir);
  assert.equal(readConfig(selected.path, f.options).registryDoc, loaded.registryDoc);
  assert.equal(existsSync(selected.value.profileFile), false, 'discovery must not read or create model credentials/profile');
  assert.equal(statSync(selected.value.stateDir).mode & 0o777, 0o700);
});

test('pointer chains, cycles and mixed pointer/config files fail closed', t => {
  const f = fixture(t), selected = f.config();
  const nested = join(f.dir, 'nested.json');
  writeFileSync(nested, JSON.stringify({ version: 1, configFile: selected.path }));
  f.putDefault({ version: 1, configFile: nested });
  assert.throws(() => readConfig(undefined, f.options), /reference chains/);
  f.putDefault({ version: 1, configFile: defaultConfigPath(f.home) });
  assert.throws(() => readConfig(undefined, f.options), /reference chains/);
  f.putDefault({ ...selected.value, configFile: selected.path });
  assert.throws(() => readConfig(undefined, f.options), /only version and configFile/);
  assert.equal(existsSync(selected.value.stateDir), false);
});

test('relative, empty, malformed and unsupported selected configs do not fall back', t => {
  const f = fixture(t), selected = f.config();
  f.putDefault(selected.value);
  for (const path of ['', 'config.json', '/absolute/with\0nul']) {
    assert.throws(() => readConfig(path, f.options), /absolute config path/);
  }
  assert.throws(() => readConfig(undefined, { home: f.home, env: { HERDR_CODEX_CONFIG: '' } }), /absolute config path/);
  for (const value of [null, [], { version: 2 }, { version: 1, configFile: 'relative.json' }]) {
    writeFileSync(selected.path, JSON.stringify(value));
    assert.throws(() => readConfig(selected.path, f.options));
  }
  writeFileSync(selected.path, 'not json');
  assert.throws(() => readConfig(selected.path, f.options), SyntaxError);
  assert.equal(existsSync(selected.value.stateDir), false);
});

test('discovery ignores cwd-local configuration in different projects', t => {
  const f = fixture(t), selected = f.config();
  f.putDefault({ version: 1, configFile: selected.path });
  const moduleUrl = new URL('../src/config.mjs', import.meta.url).href;
  for (const name of ['project one', 'project two']) {
    const cwd = join(f.dir, name);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'config.json'), 'not trusted configuration');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {readConfig} from ${JSON.stringify(moduleUrl)}; console.log(readConfig(undefined,${JSON.stringify(f.options)}).path);`],
    { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), selected.path);
  }
});

test('reference installation is private, idempotent, and copies no profile or state', t => {
  const f = fixture(t), selected = f.config();
  const first = installConfigReference(selected.path, { home: f.home });
  assert.deepEqual(first, { path: defaultConfigPath(f.home), configFile: selected.path, created: true });
  assert.deepEqual(JSON.parse(readFileSync(first.path, 'utf8')), { version: 1, configFile: selected.path });
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(existsSync(selected.value.stateDir), false, 'installing a pointer does not start or alter runtime state');
  assert.deepEqual(installConfigReference(selected.path, { home: f.home }), { ...first, created: false });
});

test('reference installation preserves another default and rejects invalid or chained targets', t => {
  const f = fixture(t), selected = f.config(), other = f.config('other');
  const installed = installConfigReference(selected.path, { home: f.home });
  const original = readFileSync(installed.path, 'utf8');
  assert.throws(() => installConfigReference(other.path, { home: f.home }), /different configuration already exists/);
  assert.equal(readFileSync(installed.path, 'utf8'), original);
  assert.throws(() => installConfigReference(installed.path, { home: join(f.dir, 'another user') }), /directly to the installation/);
  assert.throws(() => installConfigReference(join(f.dir, 'missing.json'), { home: f.home }), /No Herdr–Codex configuration/);
  f.putDefault(other.value);
  const full = readFileSync(installed.path, 'utf8');
  assert.throws(() => installConfigReference(selected.path, { home: f.home }), /different configuration already exists/);
  assert.equal(readFileSync(installed.path, 'utf8'), full);
  assert.deepEqual(installConfigReference(installed.path, { home: f.home }), {
    path: installed.path, configFile: installed.path, created: false,
  });
});
