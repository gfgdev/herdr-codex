#!/usr/bin/env node
// Minimal `hc connect` stand-in for reconnection tests. It appends one line to
// $HERDR_RECONNECT_LOG per process start ("spawn") and per received mutation,
// then can drop the connection without answering so callers observe uncertainty.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv[2] !== 'connect') process.exit(2);
const log = process.env.HERDR_RECONNECT_LOG;
const note = line => { if (log) appendFileSync(log, line + '\n'); };
note('spawn');

const input = createInterface({ input: process.stdin });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', line => {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  // A mutation is recorded, then the connection dies before any reply: the
  // caller saw uncertainty and must not have it retried behind its back.
  if (method === 'mutate') { note('mutate'); process.exit(9); }
  if (method === 'die') process.exit(7);
  if (method === 'echo') return emit({ jsonrpc: '2.0', id, result: params });
  emit({ jsonrpc: '2.0', id, result: null });
});
