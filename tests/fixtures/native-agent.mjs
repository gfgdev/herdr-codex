#!/usr/bin/env node
// Deterministic native-terminal fixture: no model, shell evaluation or host wake.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { HerdrClient } from '../../src/native.mjs';
import { appendMessage } from '../../src/mailbox.mjs';

const configFile = process.argv[2];
if (!configFile || !process.env.HC_TERMINAL_ID) throw new Error('Run this fixture in its isolated Herdr terminal');
const status = state => process.stdout.write(`\x1b]7501;state=${state}:app=native-wake-fixture\x1b\\`);
const configuration = () => JSON.parse(readFileSync(configFile, 'utf8'));
const readline = createInterface({ input: process.stdin });
let chain = Promise.resolve();

async function handle(line) {
  const envelope = /^<hc\b[^>]*>([\s\S]*)<\/hc>$/.exec(line.trim());
  const command = JSON.parse(envelope ? envelope[1] : line);
  if (command.text) process.stdout.write(`${command.text}\n`);
  if (command.cmd === 'work') { status('working'); return; }
  if (command.cmd === 'done') { status('done'); return; }
  if (command.cmd === 'idle') { status('idle'); return; }
  if (command.cmd === 'crash') { process.exit(23); }
  if (command.cmd === 'signal') { process.kill(process.pid, 'SIGKILL'); return; }
  const { hc, worker } = configuration();
  const client = new HerdrClient({ hc, timeoutMs: 15000 });
  try {
    if (command.cmd === 'handoff') {
      // A real peer send, through the native core, with actual caller identity.
      await client.request('terminal.send', { terminal: command.to, caller: process.env.HC_TERMINAL_ID,
        text: JSON.stringify({ cmd: 'work', text: command.peerText ?? 'Peer review started.' }), wait: false });
      process.stdout.write('Review requested directly; waiting for colleague.\n');
      status('done');
      return;
    }
    if (command.cmd === 'result') {
      const terminal = await client.request('terminal.get', { terminal: process.env.HC_TERMINAL_ID });
      const message = { id: command.id, taskId: worker.taskId, workerId: worker.id,
        terminalId: process.env.HC_TERMINAL_ID, kind: 'result', text: command.message,
        createdAt: new Date().toISOString(), turn: terminal.turn };
      const receipt = await appendMessage(client, worker, message);
      process.stdout.write(`Recorded explicit result ${message.id}: ${JSON.stringify(receipt)}\n`);
      status('done');
      return;
    }
    throw new Error(`Unsupported fixture command: ${command.cmd}`);
  } finally { client.close(); }
}

readline.on('line', line => {
  chain = chain.then(() => handle(line)).catch(error => {
    process.stderr.write(`FIXTURE ERROR: ${error.message}\n`);
    status('error');
  });
});
process.stdout.write('Native wake fixture ready; no assigned work has started.\n');
status('idle');
