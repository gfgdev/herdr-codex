import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HerdrClient } from '../src/native.mjs';

const hc = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
function connection(t, options = {}) {
  const client = new HerdrClient({ hc, timeoutMs: 2000, ...options });
  t.after(() => client.close());
  return client;
}

test('native requests preserve argv text and correlate out-of-order replies', async t => {
  const client = connection(t);
  const params = { text: '`echo wrong` $(touch nope) "quoted"\n🪿', data: { a: 1 } };
  const slow = client.request('slow', params);
  assert.deepEqual(await client.request('fast', { value: 2 }), { value: 2 });
  assert.deepEqual(await slow, params);
});

test('native RPC errors keep stable error kind without closing healthy connection', async t => {
  const client = connection(t);
  await assert.rejects(client.request('error'), error => error.code === -32000 && error.data.kind === 'conflict');
  assert.deepEqual(await client.request('echo', { okay: true }), { okay: true });
});

test('subscription handles split UTF8, immediate notifications, missed and close once', async t => {
  const messages = [];
  let closes = 0;
  let notifyClose;
  const closed = new Promise(resolve => { notifyClose = resolve; });
  const client = connection(t, { env: { HERDR_TEST_CLOSE: '1' }, onClose: error => { closes++; notifyClose(error); } });
  const snapshot = await client.subscribe(message => messages.push(message));
  assert.deepEqual(snapshot, { seq: 9, terminals: [] });
  await closed;
  assert.deepEqual(messages.map(m => m.method), ['event', 'event', 'missed']);
  assert.equal(messages[1].params.data.title, '🪿 π');
  assert.equal(closes, 1);
  client.close();
  assert.equal(closes, 1);
});

test('subscription dedicates the connection and cannot race pending RPCs', async t => {
  const client = connection(t);
  const slow = client.request('slow');
  await assert.rejects(client.subscribe(() => {}), { code: 'HERDR_CONNECTION_BUSY' });
  await slow;
  await client.subscribe(() => {});
  await assert.rejects(client.request('echo'), { code: 'HERDR_SUBSCRIPTION_ONLY' });
});

for (const [method, code] of [
  ['malformed', 'HERDR_PROTOCOL'], ['bad-error', 'HERDR_PROTOCOL'],
  ['unknown-id', 'HERDR_PROTOCOL'], ['partial', 'HERDR_DISCONNECTED'],
  ['exit', 'HERDR_DISCONNECTED'], ['oversized', 'HERDR_LIMIT'], ['oversized-line', 'HERDR_LIMIT'],
]) {
  test(`${method} fails all pending calls and signals connection closure`, async t => {
    let closes = 0;
    const client = connection(t, { maxLineBytes: 1024, onClose: () => closes++ });
    const pending = client.request('silent');
    const failed = client.request(method);
    const results = await Promise.allSettled([pending, failed]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === code));
    assert.equal(closes, 1);
    assert.equal(client.closed, true);
  });
}

test('timeout is an uncertain outcome, closes its child and does not retry the call', async t => {
  const client = connection(t, { timeoutMs: 80 });
  await assert.rejects(client.request('silent'), error => error.code === 'HERDR_TIMEOUT' && error.uncertain);
  assert.equal(client.closed, true);
  if (client.child.exitCode === null && client.child.signalCode === null) await once(client.child, 'exit');
  assert.equal(client.child.killed, true);
});

test('spawn failure and deliberate close settle pending requests', async t => {
  const missing = connection(t, { hc: '/not/a/herdr/executable' });
  await assert.rejects(missing.request('echo'), error => ['HERDR_SPAWN_FAILED', 'HERDR_DISCONNECTED'].includes(error.code));
  const client = connection(t);
  const pending = client.request('silent');
  client.close();
  await assert.rejects(pending, { code: 'CLIENT_CLOSED' });
});

test('oversized outgoing request is rejected before sending without closing client', async t => {
  const client = connection(t, { maxLineBytes: 128 });
  await assert.rejects(client.request('echo', { text: 'x'.repeat(200) }), { code: 'HERDR_LIMIT' });
  assert.deepEqual(await client.request('echo', {}), {});
});
