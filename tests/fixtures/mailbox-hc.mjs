#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv[2] !== 'connect') process.exit(2);
const path = process.env.HERDR_TEST_MAILBOX_STATE;
const log = process.env.HERDR_TEST_MAILBOX_LOG;
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify(request) + '\n');
  const { id, method, params } = request;
  const state = JSON.parse(readFileSync(path, 'utf8'));
  let result;
  if (method === 'terminal.get') result = state.terminal;
  else if (method === 'doc.get') result = state.doc;
  else if (method === 'doc.set') {
    if (params.version !== state.doc.version) return emit({ jsonrpc: '2.0', id,
      error: { code: -32000, message: 'Document version changed', data: { kind: 'conflict' } } });
    state.doc = { version: state.doc.version + 1, value: params.value };
    const fail = state.failAfterSet;
    state.failAfterSet = false;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, path);
    if (fail) return process.exit(1);
    result = { version: state.doc.version };
  } else throw new Error(`Unexpected method ${method}`);
  emit({ jsonrpc: '2.0', id, result });
});
