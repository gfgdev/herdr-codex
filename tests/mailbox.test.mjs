import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, readMailbox, pruneMailbox } from '../src/mailbox.mjs';

const worker = { id: 'worker-1', taskId: 'task-1', mailbox: 'cm-inbox-t7' };
const message = (id = 'm1') => ({ id, taskId: worker.taskId, workerId: worker.id, terminalId: 't7',
  kind: 'question', text: 'What is the intended behavior?', createdAt: '2026-11-13T00:00:00.000Z', turn: 2 });

function store() {
  let state = { value: null, version: 0 };
  let beforeSet;
  const calls = [];
  return {
    calls,
    state: () => structuredClone(state),
    replace: value => { state = { value, version: state.version + 1 }; },
    beforeSet: callback => { beforeSet = callback; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'doc.get') return structuredClone(state);
      assert.equal(method, 'doc.set');
      if (beforeSet) { const cb = beforeSet; beforeSet = undefined; cb(); }
      if (params.version !== state.version) throw Object.assign(new Error('stale'), { code: -32000, data: { kind: 'conflict' } });
      state = { version: state.version + 1, value: structuredClone(params.value) };
      return { version: state.version };
    },
  };
}

test('unwritten mailbox reads empty; stable duplicate is not written twice', async () => {
  const client = store();
  assert.deepEqual(await readMailbox(client, worker.mailbox), { version: 0, messages: [] });
  const first = await appendMessage(client, worker, message());
  const second = await appendMessage(client, worker, Object.fromEntries(Object.entries(message()).reverse()));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(client.calls.filter(c => c.method === 'doc.set').length, 1);
  await assert.rejects(appendMessage(client, worker, { ...message(), text: 'Different question' }), { code: 'MAILBOX_ID_CONFLICT' });
});

test('append retries native CAS conflict and keeps concurrent messages', async () => {
  const client = store();
  client.beforeSet(() => client.replace({ version: 1, messages: [message('other')] }));
  const result = await appendMessage(client, worker, message());
  assert.deepEqual(result.messages.map(m => m.id), ['other', 'm1']);
  assert.equal(result.version, 2);
});

test('concurrent appends preserve both writers', async () => {
  const client = store();
  await Promise.all([appendMessage(client, worker, message('a')), appendMessage(client, worker, message('b'))]);
  assert.deepEqual(client.state().value.messages.map(m => m.id).sort(), ['a', 'b']);
});

test('prune only removes ingested IDs and preserves a concurrent append', async () => {
  const client = store();
  await appendMessage(client, worker, message());
  client.beforeSet(() => client.replace({ version: 1, messages: [message(), message('new')] }));
  const result = await pruneMailbox(client, worker.mailbox, ['m1']);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.messages.map(m => m.id), ['new']);
  const again = await pruneMailbox(client, worker.mailbox, ['m1']);
  assert.equal(again.removed, 0);
});

test('routing mismatch and invalid mailbox do not read or write native state', async () => {
  const client = store();
  await assert.rejects(appendMessage(client, worker, { ...message(), taskId: 'different' }), { code: 'MAILBOX_ROUTE' });
  await assert.rejects(readMailbox(client, '../invalid'), { code: 'MAILBOX_INVALID' });
  assert.equal(client.calls.length, 0);
});

test('malformed existing document is never overwritten', async () => {
  const client = store();
  client.replace({ version: 2, messages: [] });
  await assert.rejects(appendMessage(client, worker, message()), { code: 'MAILBOX_INVALID' });
  assert.equal(client.calls.filter(c => c.method === 'doc.set').length, 0);
});

test('native transport uncertainty is surfaced without resending mutation', async () => {
  const client = store();
  const original = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'doc.set') throw Object.assign(new Error('connection lost after write'), { code: 'HERDR_DISCONNECTED', uncertain: true });
    return result;
  };
  await assert.rejects(appendMessage(client, worker, message()), { code: 'HERDR_DISCONNECTED' });
  assert.equal(client.calls.filter(c => c.method === 'doc.set').length, 1);
  client.request = original;
  assert.equal((await appendMessage(client, worker, message())).duplicate, true);
});

test('full inbox does not discard older pending messages', async () => {
  const client = store();
  // Each message is within the text admission budget; the document budget is
  // reached by accumulation, so the rejected append must leave the earlier
  // pending message intact rather than dropping it.
  await appendMessage(client, worker, { ...message(), text: 'x'.repeat(65_000) });
  let full = false;
  for (let i = 0; i < 40 && !full; i++) {
    try { await appendMessage(client, worker, { ...message(`fill-${i}`), text: 'y'.repeat(65_000) }); }
    catch (error) { full = error.code === 'MAILBOX_FULL'; }
  }
  assert.equal(full, true, 'expected the mailbox document budget to be reached');
  assert.equal(client.state().value.messages[0].id, 'm1');
});
