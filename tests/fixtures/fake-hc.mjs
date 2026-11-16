#!/usr/bin/env node
import { createInterface } from 'node:readline';

if (process.argv[2] !== 'connect') process.exit(2);
const input = createInterface({ input: process.stdin });
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function result(id, value) { emit({ jsonrpc: '2.0', id, result: value }); }
input.on('line', line => {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  if (method === 'error') return emit({ jsonrpc: '2.0', id, error: { code: -32000, message: 'version changed', data: { kind: 'conflict' } } });
  if (method === 'malformed') return process.stdout.write('this is not JSON\n');
  if (method === 'oversized') return process.stdout.write('x'.repeat(10_000));
  if (method === 'oversized-line') return process.stdout.write('x'.repeat(10_000) + '\n');
  if (method === 'partial') { process.stdout.write('{"jsonrpc":'); process.exit(0); }
  if (method === 'silent') return;
  if (method === 'exit') return process.exit(7);
  if (method === 'bad-error') return emit({ jsonrpc: '2.0', id, error: 'not an error object' });
  if (method === 'unknown-id') return result(id + 100, {});
  if (method === 'slow') return setTimeout(() => result(id, params), 30);
  if (method === 'events.subscribe') {
    const bytes = Buffer.from([
      { jsonrpc: '2.0', id, result: { seq: 9, terminals: [] } },
      { jsonrpc: '2.0', method: 'event', params: { seq: 10, type: 'doc', data: { name: 'inbox', version: 1 } } },
      { jsonrpc: '2.0', method: 'event', params: { seq: 11, type: 'title', terminal: 't7', data: { title: '🪿 π' } } },
      { jsonrpc: '2.0', method: 'missed', params: { seq: 12, terminals: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    let cursor = 0;
    function write() {
      if (cursor >= bytes.length) {
        if (process.env.HERDR_TEST_CLOSE === '1') process.exit(0);
        return;
      }
      process.stdout.write(bytes.subarray(cursor, cursor + 3));
      cursor += 3;
      setImmediate(write);
    }
    write();
    return;
  }
  result(id, params);
});
