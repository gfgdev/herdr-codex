import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMcp, pluginDoctorCommand } from '../src/plugin-doctor.mjs';
import { MCP_SCHEMA_ID, PLUGIN_SCHEMA_ID } from '../src/plugin-manifest.mjs';
import { AGENT_TOOLS } from '../src/agent-tools.mjs';

const TOOL_NAMES = AGENT_TOOLS.map(tool => tool.name);

/** Minimal stdio child: emits canned JSON-RPC lines, then reports a close code. */
function fakeChild(lines, { code = 0, stderr = '' } = {}) {
  const listeners = new Map();
  const child = {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: { write() {} }, kill() {},
    once(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return child; },
  };
  setImmediate(() => {
    for (const line of lines) child.stdout.write(JSON.stringify(line) + '\n');
    if (stderr) child.stderr.write(stderr);
    for (const listener of listeners.get('close') ?? []) listener(code);
  });
  return child;
}

const replies = [
  { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'herdr-agents', version: '0.8.2' } } },
  { jsonrpc: '2.0', id: 2, result: { tools: TOOL_NAMES.map(name => ({ name })) } },
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-doctor-'));
  mkdirSync(join(dir, 'plugin', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name: 'herdr-codex', version: '0.8.2' }));
  writeFileSync(join(dir, 'plugin', 'mcp.json'), JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: { 'herdr-agents': { type: 'stdio', command: './scripts/herdr-agents.sh' } } }));
  writeFileSync(join(dir, 'plugin', 'scripts', 'herdr-agents.sh'), '#!/bin/sh\n');
  chmodSync(join(dir, 'plugin', 'scripts', 'herdr-agents.sh'), 0o755);
  return dir;
}

test('probeMcp proves tool discovery with only the MCP handshake', async () => {
  const result = await probeMcp({ command: '/wrapper', spawnProcess: () => fakeChild(replies) });
  assert.deepEqual(result.tools, TOOL_NAMES);
  assert.equal(result.serverInfo.name, 'herdr-agents');
});

test('probeMcp reports a wrapper that exits before answering instead of hanging', async () => {
  await assert.rejects(
    probeMcp({ command: '/wrapper', spawnProcess: () => fakeChild([], { code: 1, stderr: 'Cannot find module' }) }),
    /exited with code 1.*Cannot find module/s,
  );
});

test('pluginDoctorCommand passes on a valid packaged plugin and reports host surfacing', async () => {
  const dir = fixture();
  try {
    const report = await pluginDoctorCommand({
      packageRoot: dir, probe: true, codex: '/fake/codex', timeoutMs: 2000,
      spawnProcess: () => fakeChild(replies),
      run: async () => JSON.stringify({ servers: [{ name: 'herdr-agents', enabled: true }] }),
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.tools, TOOL_NAMES);
    assert.equal(report.plugin.version, '0.8.2');
    assert.equal(report.servers[0].resolved, join(dir, 'plugin', 'scripts', 'herdr-agents.sh'));
    const checks = Object.fromEntries(report.checks.map(check => [check.name, check.ok]));
    assert.deepEqual(checks, { 'plugin-manifest': true, 'mcp-manifest': true, 'executable-bit': true, 'mcp-tools': true, 'host-mcp-surface': true });
    assert.deepEqual(report.remediation, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pluginDoctorCommand flags a non-surfaced server and a spec-violating command with remediation', async () => {
  const dir = fixture();
  try {
    const report = await pluginDoctorCommand({
      packageRoot: dir, probe: false, codex: '/fake/codex', run: async () => '[]',
    });
    assert.equal(report.ok, false);
    const names = report.checks.map(check => check.name);
    assert.ok(names.includes('host-mcp-surface'));
    assert.match(report.remediation.join('\n'), /codex mcp add herdr-agents -- /);

    writeFileSync(join(dir, 'plugin', 'mcp.json'), JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: { 'herdr-agents': { type: 'stdio', command: '/bin/sh', args: ['./scripts/herdr-agents.sh'] } } }));
    const broken = await pluginDoctorCommand({ packageRoot: dir, probe: false });
    assert.equal(broken.ok, false);
    assert.match(broken.checks.find(check => check.name === 'mcp-manifest').detail, /absolute path outside the plugin root/);
    assert.match(broken.remediation.join('\n'), /plugin-relative/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeMcp tolerates JSON-RPC frames split across stdout chunks', async () => {
  const spawnProcess = () => {
    const listeners = new Map();
    const stdout = new PassThrough(), stderr = new PassThrough();
    const child = { stdout, stderr, stdin: { write() {} }, kill() {}, once(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return child; } };
    const frames = replies.map(reply => JSON.stringify(reply) + '\n');
    setImmediate(() => { stdout.write(frames[0] + frames[1].slice(0, 25)); stdout.write(frames[1].slice(25)); });
    return child;
  };
  const result = await probeMcp({ command: '/wrapper', spawnProcess });
  assert.deepEqual(result.tools, TOOL_NAMES);
});

test('probeMcp surfaces a stdin failure instead of hanging', async () => {
  const spawnProcess = () => {
    const child = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: { write() { throw new Error('EPIPE'); } }, kill() {}, once() { return child; } };
    return child;
  };
  await assert.rejects(probeMcp({ command: '/wrapper', spawnProcess }), /stdin failed/);
});

test('pluginDoctorCommand requires an enabled host entry in object and array form', async () => {
  const dir = fixture();
  try {
    const check = async payload => (await pluginDoctorCommand({ packageRoot: dir, probe: false, codex: '/fake/codex', run: async () => payload })).checks.find(c => c.name === 'host-mcp-surface');
    assert.equal((await check(JSON.stringify({ servers: [{ name: 'herdr-agents', enabled: false }] }))).ok, false);
    assert.equal((await check(JSON.stringify([{ name: 'herdr-agents', enabled: false }]))).ok, false);
    assert.equal((await check(JSON.stringify([{ name: 'herdr-agents', enabled: true }]))).ok, true);
    assert.equal((await check(JSON.stringify({ servers: [{ name: 'other' }] }))).ok, false);
    assert.equal((await check('not json')).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remediation is a valid, correctly quoted /bin/sh command even when the path contains spaces', async () => {
  const base = mkdtempSync(join(tmpdir(), 'herdr-doctor space-'));
  const bin = join(base, 'bin'); mkdirSync(bin, { recursive: true });
  const capture = join(base, 'args.txt'), codexStub = join(bin, 'codex');
  writeFileSync(codexStub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\n`);
  chmodSync(codexStub, 0o755);
  mkdirSync(join(base, 'plugin', 'scripts'), { recursive: true });
  writeFileSync(join(base, 'plugin', 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name: 'herdr-codex', version: '0.8.2' }));
  writeFileSync(join(base, 'plugin', 'mcp.json'), JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: { 'herdr-agents': { type: 'stdio', command: './scripts/herdr-agents.sh' } } }));
  writeFileSync(join(base, 'plugin', 'scripts', 'herdr-agents.sh'), '#!/bin/sh\n');
  chmodSync(join(base, 'plugin', 'scripts', 'herdr-agents.sh'), 0o755);
  try {
    const report = await pluginDoctorCommand({ packageRoot: base, probe: false, codex: '/fake/codex', run: async () => '[]' });
    assert.equal(report.ok, false);
    const command = report.remediation.find(line => line.startsWith('codex mcp add'));
    assert.ok(command, 'remediation includes a codex mcp add command');
    execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const argv = readFileSync(capture, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(argv, ['mcp', 'add', 'herdr-agents', '--', '/bin/sh', join(base, 'plugin', 'scripts', 'herdr-agents.sh')]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('pluginDoctorCommand reports a missing plugin root without writing anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-empty-'));
  try {
    const report = await pluginDoctorCommand({ packageRoot: dir, probe: false });
    assert.equal(report.ok, false);
    assert.equal(report.pluginRoot, null);
    assert.match(report.remediation.join(' '), /build-plugin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
