import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_SCHEMA_ID, PLUGIN_SCHEMA_ID, findPluginRoot, resolveCommand, validateMcpManifest, validatePluginManifest,
} from '../src/plugin-manifest.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const scratch = () => mkdtempSync(join(tmpdir(), 'herdr-manifest-'));
const pluginManifest = (extra = {}) => ({ $schema: PLUGIN_SCHEMA_ID, name: 'herdr-codex', version: '0.8.2', ...extra });

test('accepts this plugin manifest and rejects name/schema/field violations', () => {
  assert.equal(validatePluginManifest(pluginManifest()).ok, true);
  for (const name of ['--bad', 'a..b', 'Upper', 'a-', 'x'.repeat(65), '']) {
    const result = validatePluginManifest(pluginManifest({ name }));
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to be rejected`);
  }
  assert.equal(validatePluginManifest(pluginManifest({ $schema: 'https://example.test/plugin.json' })).ok, false);
  assert.equal(validatePluginManifest(pluginManifest({ version: 8 })).ok, false);
  assert.equal(validatePluginManifest(pluginManifest({ unexpected: true })).ok, false);
  assert.equal(validatePluginManifest(null).ok, false);
});

test('resolveCommand keeps Agent Plugins stdio commands inside the plugin root', () => {
  const root = '/plugin';
  assert.deepEqual(resolveCommand('./scripts/herdr-agents.sh', root), { ok: true, path: '/plugin/scripts/herdr-agents.sh', reason: null });
  assert.equal(resolveCommand('${PLUGIN_ROOT}/scripts/x.sh', root).path, '/plugin/scripts/x.sh');
  assert.equal(resolveCommand('${PLUGIN_DATA}/x.sh', root).path, '/plugin/x.sh');
  // The exact historical failure: an absolute /bin/sh disabled the whole server.
  assert.match(resolveCommand('/bin/sh', root).reason, /absolute path outside the plugin root/);
  assert.match(resolveCommand('herdr-agents', root).reason, /bare token/);
  assert.match(resolveCommand('../outside.sh', root).reason, /resolves outside the plugin root/);
  assert.equal(resolveCommand('./ok.sh', root).ok, true);
});

test('validateMcpManifest resolves the wrapper, checks the executable bit and rejects reserved env', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'herdr-agents.sh'), '#!/bin/sh\n');
    chmodSync(join(dir, 'scripts', 'herdr-agents.sh'), 0o755);
    const manifest = { $schema: MCP_SCHEMA_ID, mcpServers: { 'herdr-agents': { type: 'stdio', command: './scripts/herdr-agents.sh' } } };
    const result = validateMcpManifest(manifest, { pluginRoot: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.servers.map(server => [server.name, server.executable]), [['herdr-agents', true]]);

    const reserved = validateMcpManifest({ ...manifest, mcpServers: { 'herdr-agents': { type: 'stdio', command: './scripts/herdr-agents.sh', env: { PLUGIN_ROOT: '/x' } } } }, { pluginRoot: dir });
    assert.equal(reserved.ok, false);
    assert.match(reserved.problems.join(' '), /env must not override PLUGIN_ROOT/);

    const missing = validateMcpManifest({ ...manifest, mcpServers: { 'herdr-agents': { type: 'stdio', command: './scripts/absent.sh' } } }, { pluginRoot: dir });
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /does not exist/);

    assert.equal(validateMcpManifest({ $schema: MCP_SCHEMA_ID, mcpServers: { x: { type: 'nope' } } }, { pluginRoot: dir }).ok, false);
    assert.equal(validateMcpManifest({ $schema: MCP_SCHEMA_ID, mcpServers: {} }, { pluginRoot: dir }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findPluginRoot locates a repo checkout and a packaged layout', () => {  const dir = scratch();
  try {
    mkdirSync(join(dir, 'plugin'), { recursive: true });
    writeFileSync(join(dir, 'plugin', 'plugin.json'), '{}');
    writeFileSync(join(dir, 'plugin', 'mcp.json'), '{}');
    assert.equal(findPluginRoot(dir), join(dir, 'plugin'));
    assert.equal(findPluginRoot(join(dir, 'plugin')), join(dir, 'plugin'));
    assert.equal(findPluginRoot(join(dir, 'plugin', 'scripts')), join(dir, 'plugin'));
    assert.equal(findPluginRoot('/definitely/not/here'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Regression guard for the reported failure: a spec-violating command in the checked-in
// mcp.json made the host surface zero Herdr tools while the plugin still looked enabled.
test('the checked-in plugin manifests stay spec-valid, plugin-relative and version-matched', () => {
  const root = findPluginRoot(repoRoot);
  assert.equal(root, join(repoRoot, 'plugin'));
  const plugin = validatePluginManifest(JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')));
  assert.equal(plugin.ok, true, plugin.problems.join(' '));
  const mcp = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8'));
  const manifest = validateMcpManifest(mcp, { pluginRoot: root });
  assert.equal(manifest.ok, true, manifest.problems.join(' '));
  assert.deepEqual(manifest.servers.map(server => [server.name, server.command, server.executable]), [['herdr-agents', './scripts/herdr-agents.sh', true]]);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version);
});
