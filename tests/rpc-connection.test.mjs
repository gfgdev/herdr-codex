import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpcConnection } from '../src/rpc-connection.mjs';

const hc = fileURLToPath(new URL('./fixtures/reconnecting-hc.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-rpc-reconnect-'));
  const log = join(root, 'events.log');
  const previous = process.env.HERDR_RECONNECT_LOG;
  process.env.HERDR_RECONNECT_LOG = log;
  t.after(() => {
    if (previous === undefined) delete process.env.HERDR_RECONNECT_LOG;
    else process.env.HERDR_RECONNECT_LOG = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const events = () => {
    try { return readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  };
  const count = token => events().filter(event => event === token).length;
  return { log, events, count };
}

test('a lost reply is not retried and the next explicit request reconnects', async t => {
  const f = fixture(t);
  const rpc = createRpcConnection({ hc, timeoutMs: 2000 });
  t.after(() => rpc.close());

  assert.deepEqual(await rpc.request('echo', { step: 'established' }), { step: 'established' });
  const first = rpc.client;

  await assert.rejects(rpc.request('mutate', { step: 'lost' }),
    error => error.code === 'HERDR_DISCONNECTED' && error.uncertain === true);
  assert.equal(first.closed, true, 'failed client is closed');
  assert.equal(f.count('mutate'), 1, 'the mutation was attempted exactly once');

  // The replacement is created by the NEXT explicit request, not by the loss.
  assert.deepEqual(await rpc.request('echo', { step: 'later' }), { step: 'later' });
  assert.notEqual(rpc.client, first);
  assert.equal(rpc.client.closed, false);
  assert.equal(f.count('spawn'), 2, 'exactly one replacement connection');
  assert.equal(f.count('mutate'), 1, 'the failed mutation was never replayed');
});

test('concurrent calls after closure share one replacement connection', async t => {
  const f = fixture(t);
  const rpc = createRpcConnection({ hc, timeoutMs: 2000 });
  t.after(() => rpc.close());

  await rpc.request('echo', {});
  await assert.rejects(rpc.request('die'), { code: 'HERDR_DISCONNECTED' });
  const before = f.count('spawn');

  const replies = await Promise.all([1, 2, 3, 4, 5].map(index => rpc.request('echo', { index })));
  assert.deepEqual(replies, [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }]);
  assert.equal(f.count('spawn') - before, 1, 'all concurrent callers shared one replacement');
});

test('runtime close rejects later requests and opens no new connection', async t => {
  const f = fixture(t);
  const rpc = createRpcConnection({ hc, timeoutMs: 2000 });

  await rpc.request('echo', {});
  const spawns = f.count('spawn');
  rpc.close();
  assert.equal(rpc.closed, true);
  assert.equal(rpc.client, null);

  await assert.rejects(rpc.request('echo', {}), { code: 'CLIENT_CLOSED' });
  assert.equal(f.count('spawn'), spawns, 'a closed runtime never resurrects a connection');
});

test('a stale close from a replaced client cannot discard the newer client', async () => {
  const created = [];
  const rpc = createRpcConnection({
    createClient: ({ onClose }) => {
      const fake = {
        closed: false,
        request: (method, params) => Promise.resolve({ method, params }),
        close() { this.closed = true; },
        onClose,
      };
      created.push(fake);
      return fake;
    },
  });

  await rpc.request('first');
  created[0].closed = true; // first connection dies
  await rpc.request('second');
  const current = rpc.client;
  assert.equal(created.length, 2);

  created[0].onClose(); // late close event delivered after replacement
  assert.equal(rpc.client, current, 'the replacement was retained');
});
