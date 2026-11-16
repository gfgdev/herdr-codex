import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTemplates, getTemplate, installTemplate } from '../src/templates.mjs';

const custom = { version: 1, name: 'api-review', description: 'Check public API compatibility.', harness: 'goose', scope: 'read-only', instructions: 'Compare public call shapes and report concrete breaks.' };

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'herdr-templates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const templateDir = join(dir, 'private', 'templates');
  const put = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  return { dir, templateDir, put };
}

test('built-ins expose useful instruction/scope defaults without model or executable settings', () => {
  const all = listTemplates();
  assert.deepEqual(all.map(t => t.name), ['explorer', 'implementer', 'investigator', 'reviewer', 'tester']);
  assert.equal(getTemplate('implementer').scope, 'write');
  for (const t of all) {
    assert.ok(t.instructions.length > 40);
    assert.deepEqual(Object.keys(t), ['version', 'name', 'description', 'harness', 'scope', 'instructions']);
    assert.equal(t.harness, ['reviewer', 'investigator'].includes(t.name) ? 'goose' : 'pi');
    if (t.name !== 'implementer') assert.equal(t.scope, 'read-only');
  }
  const changed = getTemplate('explorer'); changed.instructions = 'mutated';
  assert.notEqual(getTemplate('explorer').instructions, 'mutated');
});

test('listing an absent custom directory is read-only and does not create state', t => {
  const f = fixture(t);
  assert.equal(listTemplates({ templateDir: f.templateDir }).length, 5);
  assert.equal(existsSync(f.templateDir), false);
  assert.throws(() => getTemplate('absent', { templateDir: f.templateDir }), /Unknown template/);
  assert.equal(existsSync(f.templateDir), false);
});

test('custom install is private, stable across rereads, and idempotent without overwriting', t => {
  const f = fixture(t), source = f.put('custom.json', custom);
  const first = installTemplate(source, { templateDir: f.templateDir });
  assert.equal(first.created, true);
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.templateDir).mode & 0o777, 0o700);
  assert.deepEqual(getTemplate(custom.name, { templateDir: f.templateDir }), custom);
  assert.equal(installTemplate(source, { templateDir: f.templateDir }).created, false);
  const before = readFileSync(first.path, 'utf8');
  writeFileSync(source, JSON.stringify({ ...custom, instructions: 'Changed instructions' }));
  assert.throws(() => installTemplate(source, { templateDir: f.templateDir }), /different template/);
  assert.equal(readFileSync(first.path, 'utf8'), before);
  assert.equal(listTemplates({ templateDir: f.templateDir }).length, 6);
});

test('names, unknown fields, provider overrides and malformed templates fail before creating state', t => {
  const f = fixture(t);
  for (const [index, extra] of [
    { name: '../escape' }, { name: 'Upper' }, { name: '/tmp/escape' }, { name: 'a/b' },
    { model: 'another-model' }, { provider: 'elsewhere' }, { command: 'sh' },
    { credentials: 'nope' }, { harness: 'unknown' }, { scope: 'all' },
    { instructions: '' }, { instructions: 'x\0' }, { version: 2 }, { description: ' ' },
  ].entries()) {
    assert.throws(() => installTemplate(f.put(`bad${index}.json`, { ...custom, ...extra }), { templateDir: f.templateDir }));
  }
  assert.equal(existsSync(f.templateDir), false);
  assert.throws(() => getTemplate('../escape', { templateDir: f.templateDir }), /Template name/);
  assert.throws(() => installTemplate(f.put('no-dir.json', custom)), /requires templateDir/);
  assert.throws(() => listTemplates({ templateDir: 'relative' }), /absolute/);
});

test('custom files cannot replace built-ins or impersonate a different filename', t => {
  const f = fixture(t);
  assert.throws(() => installTemplate(f.put('builtin.json', getTemplate('explorer')), { templateDir: f.templateDir }), /built-in/);
  assert.equal(existsSync(f.templateDir), false);
  mkdirSync(f.templateDir, { recursive: true });
  writeFileSync(join(f.templateDir, 'other-name.json'), JSON.stringify(custom));
  assert.throws(() => getTemplate('other-name', { templateDir: f.templateDir }), /filename and declared name/);
  rmSync(join(f.templateDir, 'other-name.json'));
  writeFileSync(join(f.templateDir, 'explorer.json'), JSON.stringify(getTemplate('explorer')));
  assert.throws(() => listTemplates({ templateDir: f.templateDir }), /shadow built-in/);
});

test('symlinked source, custom entry and directory are refused without overwriting targets', t => {
  const f = fixture(t), source = f.put('source.json', custom);
  const sourceLink = join(f.dir, 'source-link.json'); symlinkSync(source, sourceLink);
  assert.throws(() => installTemplate(sourceLink, { templateDir: f.templateDir }), /symbolic links/);
  mkdirSync(f.templateDir, { recursive: true });
  const linked = join(f.templateDir, 'api-review.json'); symlinkSync(source, linked);
  assert.throws(() => getTemplate('api-review', { templateDir: f.templateDir }), /symbolic links/);
  assert.throws(() => installTemplate(source, { templateDir: f.templateDir }), /symbolic links/);
  assert.throws(() => listTemplates({ templateDir: f.templateDir }), /regular file/);
  const directoryLink = join(f.dir, 'linked-templates'); symlinkSync(f.templateDir, directoryLink);
  assert.throws(() => listTemplates({ templateDir: directoryLink }), /symbolic links/);
  assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')), custom);
});
