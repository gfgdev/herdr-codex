#!/usr/bin/env node
// A real terminal program with deterministic lifecycle reports. No model calls.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { HerdrClient } from '../../src/native.mjs';

const hc = process.argv[2];
if (!hc || !process.env.HC_TERMINAL_ID || !process.stdin.isTTY) throw new Error('Run in the isolated native adoption core');
const status = state => process.stdout.write(`\x1b]7501;state=${state}:app=adoption-fixture\x1b\\`);
let chain = Promise.resolve();
async function handle(line) {
  const envelope = /^<hc\b[^>]*>([\s\S]*)<\/hc>$/.exec(line.trim());
  const text = envelope ? envelope[1] : line;
  // Delegation sends its actual prose envelope. The deterministic program
  // recognizes only our fixture marker; it does not emulate model judgment.
  if (!text.trim() || text.trim() === '## Current assignment') return;
  const continuation = /ADOPTED_REPORT_CONTINUATION ([A-Za-z0-9_-]+)/.exec(text);
  const command = continuation ? JSON.parse(Buffer.from(continuation[1], 'base64url').toString()) : JSON.parse(text);
  if (command.text) process.stdout.write(command.text + '\n');
  if (['idle', 'working', 'done', 'blocked', 'error'].includes(command.cmd)) { status(command.cmd); return; }
  if (command.cmd === 'crash') process.exit(23);
  if (command.cmd === 'report') {
    if (!command.expectFailure) status('working');
    const receipts = [];
    for (let attempt = 0; attempt < (command.repeat ?? 1); attempt++) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../src/message-cli.mjs', import.meta.url)),
        '--kind', command.kind ?? 'question', '--text', command.text, '--idempotency-key', command.key], {
        env: { ...process.env, HERDR_CODEX_WORKER_CONFIG: command.workerConfig },
        encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, command.expectFailure ? 1 : 0, result.stderr);
      const receipt = JSON.parse(command.expectFailure ? result.stderr : result.stdout);
      receipts.push({ exitCode: result.status, ...receipt });
    }
    const rpc = new HerdrClient({ hc, timeoutMs: 15000 });
    try {
      const current = await rpc.request('doc.get', { name: command.receiptDoc });
      await rpc.request('doc.set', { name: command.receiptDoc, version: current.version,
        value: { terminalId: process.env.HC_TERMINAL_ID, pid: process.pid, receipts } });
    } finally { rpc.close(); }
    process.stdout.write('REPORT_RECEIPTS ' + JSON.stringify(receipts) + '\n');
    if (!command.expectFailure) status('done');
    return;
  }
  if (command.cmd === 'spawn') {
    const rpc = new HerdrClient({ hc, timeoutMs: 15000 });
    try {
      // This API call originates inside the parent terminal. Preserve native
      // child lifetime: no reparenting or outlive-parent permission is added.
      const child = await rpc.request('terminal.run', {
        argv: [process.execPath, fileURLToPath(import.meta.url), hc],
        caller: process.env.HC_TERMINAL_ID, cwd: process.cwd(), name: command.name,
        wait: false, no_parent: false, keep: false,
      });
      process.stdout.write('CHILD_CREATED ' + JSON.stringify(child) + '\n');
    } finally { rpc.close(); }
    return;
  }
  throw new Error('Unknown fixture command: ' + command.cmd);
}
// Use the same real multiline input framing as the native delegation fixture.
// Herdr sees bracketed-paste support and sends one complete prompt before Enter.
let stream = '', prompt = '', pasting = false, escapeTimer;
function submit() {
  const text = prompt; prompt = '';
  if (text.trim()) chain = chain.then(() => handle(text)).catch(error => { process.stderr.write(error.message + '\n'); status('error'); });
}
function drain() {
  clearTimeout(escapeTimer);
  while (stream.length) {
    if (pasting) {
      const end = stream.indexOf('\x1b[201~');
      if (end < 0) { if (stream.length > 5) { prompt += stream.slice(0, -5); stream = stream.slice(-5); } return; }
      prompt += stream.slice(0, end); stream = stream.slice(end + 6); pasting = false; continue;
    }
    if (stream.startsWith('\x1b[200~')) { stream = stream.slice(6); pasting = true; continue; }
    if ('\x1b[200~'.startsWith(stream) && stream[0] === '\x1b') {
      escapeTimer = setTimeout(() => { stream = ''; prompt = ''; status('done'); }, 35); return;
    }
    const c = stream[0]; stream = stream.slice(1);
    if (c === '\x1b' || c === '\x03') { prompt = ''; status('done'); continue; }
    if (c === '\r') { submit(); continue; }
    prompt += c;
  }
}
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
process.stdin.on('data', data => { stream += data; drain(); });
process.stdout.write('\x1b[?2004hExisting native terminal ready; adoption must not relaunch or send input.\r\n');
status('idle');
