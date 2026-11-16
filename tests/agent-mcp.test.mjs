import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serveAgentMcp, MCP_INSTRUCTIONS } from '../src/agent-mcp.mjs';

async function fixture(t, adapter) {
  const input = new PassThrough(), output = new PassThrough(), responses = [], waiters = new Map();
  let buffer = '', calls = 0, closed = false;
  output.setEncoding('utf8'); output.on('data', data => {
    buffer += data; let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); responses.push(message); waiters.get(message.id)?.(message); waiters.delete(message.id); }
  });
  const serving = serveAgentMcp({ input, output, runtimeFactory: async () => { calls++; return { adapter, close: async () => { closed = true; } }; } });
  let id = 0;
  const request = (method, params) => { const next = ++id; const reply = new Promise(resolve => waiters.set(next, resolve)); input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n'); return { id: next, reply }; };
  const notify = (method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  t.after(async () => { input.end(); await serving; });
  return { input, output, responses, request, notify, serving, calls: () => calls, closed: () => closed };
}

test('initialize and tool discovery work before Herdr setup; strict JSON framing and structured errors', async t => {
  const f = await fixture(t, { call: async () => { throw new Error('Configure Herdr first'); } });
  assert.equal((await f.request('tools/list').reply).error.code, -32000);
  const init = await f.request('initialize', { protocolVersion: '2025-06-18' }).reply;
  assert.equal(init.result.serverInfo.name, 'herdr-agents');
  assert.equal((await f.request('tools/list').reply).result.tools.length, 16); assert.equal(f.calls(), 0);
  assert.ok((await f.request('tools/list').reply).result.tools.some(tool => tool.name === 'stop_agent'));
  assert.ok((await f.request('tools/list').reply).result.tools.some(tool => tool.name === 'cancel_request'));
  assert.ok((await f.request('tools/list').reply).result.tools.some(tool => tool.name === 'read_review_packet'));
  assert.ok((await f.request('tools/list').reply).result.tools.some(tool => tool.name === 'capture_review'));
  assert.ok((await f.request('tools/list').reply).result.tools.some(tool => tool.name === 'verify_review'));
  assert.match(MCP_INSTRUCTIONS, /read_review_packet/);
  assert.match(MCP_INSTRUCTIONS, /capture_review/);
  assert.match(MCP_INSTRUCTIONS, /verify_review/);
  assert.equal((await f.request('tools/call', { name: 'unknown' }).reply).error.code, -32602);
  const failed = await f.request('tools/call', { name: 'list_agents', arguments: {} }).reply;
  assert.equal(failed.result.isError, true); assert.match(failed.result.structuredContent.error, /Configure/);
  f.input.write('not json\n');
  assert.equal(f.responses.at(-1).error.code, -32700);
});

test('a waiting tool does not block messages; cancellation aborts only the wait', async t => {
  let waitStarted; const ready = new Promise(resolve => { waitStarted = resolve; });
  const calls = [];
  const f = await fixture(t, { call: async (name, args, { signal }) => {
    calls.push(name);
    if (name === 'wait_agent') return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); waitStarted(); });
    return { agent_id: 'agent-a', state: 'queued' };
  } });
  await f.request('initialize', { protocolVersion: '2025-06-18' }).reply;
  const wait = f.request('tools/call', { name: 'wait_agent' }); await ready;
  const note = await f.request('tools/call', { name: 'send_message' }).reply;
  assert.equal(note.result.structuredContent.state, 'queued');
  f.notify('notifications/cancelled', { requestId: wait.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.responses.some(r => r.id === wait.id));
  assert.deepEqual(calls, ['wait_agent', 'send_message']);
  f.input.end(); await f.serving; assert.equal(f.closed(), true);
});

test('transport EOF aborts waiting requests and closes resources', async t => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { call: async (_, __, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); began(); }) });
  await f.request('initialize', {}).reply;
  f.request('tools/call', { name: 'wait_agent' }); await started;
  f.input.end(); await f.serving; assert.equal(f.closed(), true);
});

test('cancellation preserves JSON-RPC ID types and ignores unknown IDs', async t => {
  let began, aborted = false; const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { call: async (_, __, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); began();
  }) });
  await f.request('initialize', {}).reply;
  const waiting = f.request('tools/call', { name: 'wait_agent' }); await started;
  f.notify('notifications/cancelled', { requestId: String(waiting.id) });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(aborted, false);
  f.notify('notifications/cancelled', { requestId: waiting.id });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(aborted, true);
});

test('cancellation cannot roll back dispatched mutations; completion remains inspectable on retry', async t => {
  let began, finish, effects = 0; const started = new Promise(resolve => { began = resolve; });
  const completed = new Promise(resolve => { finish = resolve; });
  let saved;
  const f = await fixture(t, { call: async () => {
    if (saved) return saved;
    effects++; began(); await completed; saved = { state: 'sent', request_id: 'stable' }; return saved;
  } });
  await f.request('initialize', {}).reply;
  const mutation = f.request('tools/call', { name: 'send_message' }); await started;
  f.notify('notifications/cancelled', { requestId: mutation.id }); finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.responses.some(r => r.id === mutation.id));
  const retry = await f.request('tools/call', { name: 'send_message' }).reply;
  assert.equal(retry.result.structuredContent.state, 'sent'); assert.equal(effects, 1);
});
