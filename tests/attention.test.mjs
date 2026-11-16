import test from 'node:test';
import assert from 'node:assert/strict';
import { observe, coveredByMessage, consume } from '../src/attention.mjs';

const at = n => `2026-11-13T04:00:${String(n).padStart(2, '0')}.000Z`;
const terminal = (state, turn, extra = {}) => ({ address: 't7', pid: 1234, state: 'live', status: { state }, turn, ...extra });
const edge = state => ({ type: 'status', data: { status: { state } } });
const message = (kind, turn, extra = {}) => ({ id: 'explicit-1', workerId: 'worker-1', kind, turn, createdAt: at(2), ...extra });

test('initial idle or done snapshots create no completion episode', () => {
  for (const state of ['idle', 'done']) {
    let observed = observe(null, terminal(state, 7), { now: at(0) });
    assert.equal(observed.episode, 0);
    assert.equal(observed.pending ?? null, null);
    observed = observe(observed, terminal(state, 7), { event: edge(state), now: at(1) });
    assert.equal(observed.episode, 0);
    assert.equal(observed.pending ?? null, null);
  }
});

test('working to done at the same turn records one episode and tolerates the later increment', () => {
  let observed = observe(null, terminal('idle', 3), { now: at(0) });
  observed = observe(observed, terminal('working', 3), { event: edge('working'), now: at(1) });
  observed = observe(observed, terminal('done', 3), { event: edge('done'), now: at(2) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending.episode, 1);
  assert.equal(observed.pending.startTurn, 3);
  assert.equal(observed.endNeedsIncrement, true);
  observed = observe(observed, terminal('done', 4), { event: { type: 'turn', data: { state: 'done' } }, now: at(3) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending.episode, 1);
  assert.equal(observed.pending.turn, 4);
  assert.equal(observed.endNeedsIncrement, false);
});

test('consuming before a delayed turn increment does not reopen the same episode', () => {
  let observed = observe(null, terminal('working', 0), { now: at(0) });
  observed = observe(observed, terminal('done', 0), { now: at(1) });
  observed = consume(observed, 'explicit result');
  assert.equal(observed.handledEpisode, 1);
  observed = observe(observed, terminal('done', 1), { now: at(2) });
  observed = observe(observed, terminal('done', 1), { event: edge('done'), now: at(3) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending, null);
  assert.equal(observed.handledReason, 'explicit result');
});

test('fast working edge is preserved even when authoritative state already says done', () => {
  let observed = observe(null, terminal('idle', 5), { now: at(0) });
  observed = observe(observed, terminal('done', 6), { event: edge('working'), now: at(2) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending.startTurn, 5);
  assert.equal(observed.pending.turn, 6);
  observed = consume(observed, 'automatic handoff');
  observed = observe(observed, terminal('done', 6), { event: edge('done'), now: at(3) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending, null);
});

test('a delayed working edge cannot reopen completion already observed by a snapshot', () => {
  let observed = observe(null, terminal('idle', 4, { status_ms: Date.parse(at(0)) }), { now: at(0) });
  const completed = terminal('done', 5, { status_ms: Date.parse(at(2)) });
  observed = observe(observed, completed, { now: at(3) });
  assert.equal(observed.episode, 1);
  observed = consume(observed, 'notice:already-queued');
  // A registry/reconnect snapshot can run ahead of a queued status notification.
  observed = observe(observed, completed, { event: edge('working'), now: at(4) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending, null);
  observed = observe(observed, terminal('working', 5, { status_ms: Date.parse(at(5)) }), { event: edge('working'), now: at(5) });
  observed = observe(observed, terminal('done', 6, { status_ms: Date.parse(at(6)) }), { now: at(6) });
  assert.equal(observed.episode, 2);
  assert.equal(observed.pending.episode, 2);
});

test('multiple working observations remain one episode; a later working cycle is distinct', () => {
  let observed = observe(null, terminal('working', 1), { now: at(0) });
  observed = observe(observed, terminal('working', 1), { now: at(1) });
  observed = observe(observed, terminal('working', 2), { now: at(2) });
  assert.equal(observed.episode, 1);
  observed = observe(observed, terminal('done', 2), { now: at(3) });
  observed = consume(observed, 'reviewed');
  observed = observe(observed, terminal('working', 2), { now: at(4) });
  assert.equal(observed.episode, 2);
  assert.equal(observed.pending, null);
  observed = observe(observed, terminal('done', 3), { now: at(5) });
  assert.equal(observed.pending.episode, 2);
});

test('a new delivered activation recovers completion when working was missed', () => {
  const activation = { id: 'send-1', baselineTurn: 8, at: at(1) };
  let observed = observe(null, terminal('idle', 8), { now: at(0) });
  observed = observe(observed, terminal('idle', 8), { activation, now: at(1) });
  assert.equal(observed.pending ?? null, null, 'delivery alone is not completion');
  observed = observe(observed, terminal('done', 9), { activation, now: at(3) });
  assert.equal(observed.pending.episode, 1);
  assert.equal(observed.pending.startTurn, 8);
  assert.equal(observed.activationId, activation.id);
  observed = consume(observed, 'manager handoff');
  observed = observe(observed, terminal('done', 9), { activation, now: at(4) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending, null);
});

test('a new activation does not reinterpret the previous episode delayed increment as new completion', () => {
  let observed = observe(null, terminal('working', 4), { activation: { id: 'send-1', baselineTurn: 4 }, now: at(0) });
  observed = observe(observed, terminal('done', 4), { now: at(1) });
  observed = consume(observed, 'old explicit result');
  const activation = { id: 'send-2', baselineTurn: 4, at: at(2) };
  observed = observe(observed, terminal('done', 5), { activation, now: at(3) });
  assert.equal(observed.episode, 1, 'the pending old counter increment must be consumed first');
  assert.equal(observed.pending, null);
  observed = observe(observed, terminal('done', 5), { activation, now: at(3) });
  assert.equal(observed.episode, 1, 're-reading the delayed increment must stay quiet');
  observed = observe(observed, terminal('working', 5), { activation, event: edge('working'), now: at(4) });
  observed = observe(observed, terminal('done', 6), { activation, now: at(5) });
  assert.equal(observed.pending.episode, 2);
});

test('only explicit messages from this worker and completion turn range cover pending work', () => {
  let observed = observe(null, terminal('working', 2), { now: at(0) });
  observed = observe(observed, terminal('done', 3), { now: at(3) });
  for (const kind of ['question', 'result']) {
    assert.equal(coveredByMessage(observed, message(kind, 2), 'worker-1'), true);
    assert.equal(coveredByMessage(observed, message(kind, 3), 'worker-1'), true);
  }
  for (const candidate of [
    message('progress', 2), message('attention', 2), message('result', 1), message('result', 4),
    message('result', 2, { workerId: 'worker-2' }), message('result', 2.5),
  ]) assert.equal(coveredByMessage(observed, candidate, 'worker-1'), false);
  assert.equal(coveredByMessage(consume(observed, 'covered'), message('result', 2), 'worker-1'), false);
});

test('a prior episode message cannot cover a new activation that shares the delayed counter', () => {
  let observed = observe(null, terminal('working', 4), { activation: { id: 'send-1', baselineTurn: 4 }, now: at(0) });
  observed = observe(observed, terminal('done', 4), { now: at(2) });
  const oldResult = message('result', 4, { createdAt: at(1) });
  assert.equal(coveredByMessage(observed, oldResult, 'worker-1'), true);
  observed = consume(observed, 'explicit old result');
  observed = observe(observed, terminal('working', 4), { activation: { id: 'send-2', baselineTurn: 4, at: at(3) }, now: at(3) });
  observed = observe(observed, terminal('done', 5), { now: at(5) });
  assert.equal(observed.pending.episode, 2);
  assert.equal(coveredByMessage(observed, oldResult, 'worker-1'), false, 'old acknowledged evidence is not a result for the new turn');
  assert.equal(coveredByMessage(observed, message('result', 4, { id: 'new-result', createdAt: at(4) }), 'worker-1'), true);
});

for (const withStatusTime of [false, true]) {
  test(`a native peer turn cannot reuse the previous result${withStatusTime ? ' with native status time' : ' without native status time'}`, () => {
    let observed = observe(null, terminal('working', 4), { now: at(0) });
    observed = observe(observed, terminal('done', 4), { now: at(2) });
    const oldResult = message('result', 4, { id: 'old-peer-result', createdAt: at(1) });
    assert.equal(coveredByMessage(observed, oldResult, 'worker-1'), true);
    observed = consume(observed, `report:${oldResult.id}`);
    // Native hc send from a colleague does not create Codex activation metadata.
    // It can arrive before the preceding turn's delayed counter increment.
    observed = JSON.parse(JSON.stringify(observed));
    observed = observe(observed, terminal('working', 4,
      withStatusTime ? { status_ms: Date.parse(at(3)) } : {}), { event: edge('working'), now: at(3) });
    observed = observe(observed, terminal('done', 5), { now: at(5) });
    assert.equal(observed.pending.episode, 2);
    assert.equal(coveredByMessage(observed, oldResult, 'worker-1'), false);
    assert.equal(coveredByMessage(observed, message('result', 4, {
      id: 'new-peer-result', createdAt: at(4),
    }), 'worker-1'), true);
  });
}

test('blocked and error states clear routine completion candidates for separate fault handling', () => {
  for (const state of ['blocked', 'error']) {
    let observed = observe(null, terminal('working', 0), { now: at(0) });
    observed = observe(observed, terminal('done', 1), { now: at(1) });
    assert.ok(observed.pending);
    observed = observe(observed, terminal(state, 1), { now: at(2) });
    assert.equal(observed.pending, null);
    assert.equal(observed.state, state);
  }
});

test('serialized working observation recovers one completion across bridge restart', () => {
  let observed = observe(null, terminal('working', 6), { activation: { id: 'send-1', baselineTurn: 6 }, now: at(0) });
  observed = JSON.parse(JSON.stringify(observed));
  observed = observe(observed, terminal('done', 7), { now: at(2) });
  assert.equal(observed.episode, 1);
  assert.equal(observed.pending.episode, 1);
  observed = JSON.parse(JSON.stringify(consume(observed, 'received')));
  observed = observe(observed, terminal('done', 7), { now: at(3) });
  assert.equal(observed.pending, null);
  assert.equal(observed.episode, 1);
});

test('an unseen completed turn after a persisted idle baseline is recoverable', () => {
  let observed = observe(null, terminal('idle', 2), { now: at(0) });
  observed = JSON.parse(JSON.stringify(observed));
  observed = observe(observed, terminal('done', 3), { now: at(2) });
  assert.equal(observed.pending.episode, 1);
  assert.equal(observed.pending.startTurn, 2);
  observed = consume(observed, 'recovered after reconnect');
  observed = observe(observed, terminal('done', 3), { now: at(3) });
  assert.equal(observed.pending, null);
});
