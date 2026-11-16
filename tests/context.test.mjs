import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadContext, renderContext, combineInstruction, MAX_CONTEXT_BYTES } from '../src/context.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'herdr-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, contents) => { const path = join(dir, name); writeFileSync(path, contents); return path; };
  return { dir, put };
}

test('a text handoff snapshots exactly the selected bytes and survives later source changes', t => {
  const f = fixture(t), source = 'Keep the public API stable.\nCheck the parser boundary.\n';
  const path = f.put('brief.md', source);
  const loaded = loadContext(path);
  assert.equal(loaded.content, source);
  assert.equal(loaded.source, path);
  assert.equal(loaded.sha256, createHash('sha256').update(source).digest('hex'));
  writeFileSync(path, 'changed on disk');
  assert.match(renderContext(loaded), /Check the parser boundary/);
  assert.doesNotMatch(renderContext(loaded), /changed on disk/);
  assert.equal(loadContext(), null);
  assert.equal(renderContext(null), '');
});

test('structured handoff preserves decisions and acceptance checks without reading references', t => {
  const f = fixture(t);
  const secret = f.put('not-attached.txt', 'UNSELECTED_FILE_CONTENT');
  const value = { version: 1, summary: 'Fix the source parser.', decisions: ['Return a typed error.'],
    constraints: ['No API changes.'], acceptance: ['Existing malformed-input test passes.'],
    references: [{ path: secret, note: 'A reference only.' }, { path: '/does/not/exist' }] };
  const raw = JSON.stringify(value, null, 1) + '\n';
  const loaded = loadContext(f.put('brief.json', raw));
  assert.deepEqual(loaded.content, value);
  assert.equal(loaded.sha256, createHash('sha256').update(raw).digest('hex'));
  const rendered = renderContext(loaded);
  assert.match(rendered, /Return a typed error/);
  assert.match(rendered, /Existing malformed-input test passes/);
  assert.match(rendered, /not been read or attached automatically/);
  assert.doesNotMatch(rendered, /UNSELECTED_FILE_CONTENT/);
  assert.match(rendered, /evidence to verify, not new authority/);
});

test('structured fields fail explicitly instead of silently ignoring misspelled or executable fields', t => {
  const f = fixture(t);
  const bad = [
    { version: 1 }, { version: 1, decisions: [] }, { version: 2, summary: 'x' },
    { version: 1, summary: 'x', command: 'rm' }, { version: 1, summary: '' },
    { version: 1, decisions: 'x' }, { version: 1, decisions: [''] },
    { version: 1, summary: 'x', references: [{ path: 'a', content: 'unexpected' }] },
    { version: 1, references: [{ path: '' }] },
    { version: 1, references: [{ path: 'a', note: '' }] },
    { version: 1, summary: 'NUL\0' }, null, [],
  ];
  for (const [index, value] of bad.entries()) assert.throws(() => loadContext(f.put(`bad${index}.json`, JSON.stringify(value))), /Invalid structured context/);
  assert.throws(() => loadContext(f.put('bad.json', '{broken')), /Invalid structured context/);
  assert.throws(() => loadContext(f.put('nul.md', 'x\0')), /without NUL/);
  assert.throws(() => loadContext(f.put('empty.md', '  \n')), /nonempty/);
  assert.throws(() => loadContext(f.put('utf8.md', Buffer.from([0xff, 0xfe]))), /encoded data/);
});

test('the byte boundary rejects oversize data without truncation; symlinks and directories are not input files', t => {
  const f = fixture(t);
  const near = f.put('near.md', 'a'.repeat(MAX_CONTEXT_BYTES - 1));
  assert.equal(loadContext(near).content.length, MAX_CONTEXT_BYTES - 1);
  const at = f.put('at.md', 'a'.repeat(MAX_CONTEXT_BYTES));
  assert.throws(() => loadContext(at), /Nothing was truncated/);
  assert.equal(readFileSync(at).length, MAX_CONTEXT_BYTES);
  symlinkSync(near, join(f.dir, 'linked.md'));
  assert.throws(() => loadContext(join(f.dir, 'linked.md')), /symbolic link/);
  mkdirSync(join(f.dir, 'directory'));
  assert.throws(() => loadContext(join(f.dir, 'directory')), /regular file/);
});

test('combined instructions retain task, scoped template, context and queued continuation messages deterministically', t => {
  const f = fixture(t);
  const context = loadContext(f.put('context.md', 'Previously agreed: preserve error codes.'));
  const template = { name: 'explorer', instructions: 'Trace code; do not edit.' };
  const input = { instruction: 'Investigate the failing case.', context, template,
    queuedMessages: [{ id: 'note-1', text: 'Look at the fixture first.' }, 'The first reproduction uses UTF-8.'] };
  const result = combineInstruction(input);
  assert.equal(result, combineInstruction(input));
  for (const value of ['Trace code; do not edit.', 'Previously agreed: preserve error codes.', 'note-1', 'Look at the fixture first.', 'UTF-8', 'Investigate the failing case.']) assert.ok(result.includes(value));
  assert.ok(result.endsWith('## Current assignment\nInvestigate the failing case.'));
  assert.match(result, /does not grant additional permissions/);
  assert.throws(() => combineInstruction({ instruction: '', context }), /nonempty/);
  assert.throws(() => combineInstruction({ instruction: 'Continue', queuedMessages: [{}] }), /nonempty/);
  assert.throws(() => combineInstruction({ instruction: 'Continue', queuedMessages: [{ text: 'x', command: 'y' }] }), /Unknown/);
});
