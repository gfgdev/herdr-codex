#!/usr/bin/env node
import {
  readFileSync, mkdirSync, lstatSync, openSync, closeSync, writeFileSync,
  fsyncSync, linkSync, unlinkSync, constants,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { HerdrClient } from './native.mjs';
import { appendMessage, MAILBOX_DOC_LIMIT } from './mailbox.mjs';
import { canonicalize, validateMessageEvidence, MAX_TEXT_BYTES } from './evidence-transport.mjs';
import { digest } from './config.mjs';
import {assertNativeWorker} from './routing.mjs';

function semantic(message) {
  return JSON.stringify({ id: message.id, taskId: message.taskId, workerId: message.workerId,
    terminalId: message.terminalId, kind: message.kind, text: message.text,
    idempotencyKey: message.idempotencyKey,
    evidence: message.evidence === undefined ? null : canonicalize(message.evidence) });
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readPrepared(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const record = JSON.parse(readFileSync(fd, 'utf8'));
    if (record.version !== 1 || !record.message || typeof record.message !== 'object') {
      throw new Error('Invalid prepared message receipt; preserve it for recovery.');
    }
    return record.message;
  } finally { closeSync(fd); }
}

/** Publish complete, synced bytes without replacing another invocation's receipt. */
function prepareMessage(worker, proposed) {
  if (!isAbsolute(worker.stateDir ?? '')) throw new Error('Worker stateDir must be absolute.');
  const outbox = join(worker.stateDir, 'runtime', 'message-outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const stat = lstatSync(outbox);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Message outbox must be a private directory.');
  const path = join(outbox, `${proposed.id}.json`);
  const temporary = join(outbox, `.${proposed.id}-${randomUUID()}.tmp`);
  // An envelope that can never fit the durable mailbox must fail here, loudly,
  // rather than leave a receipt or a hidden/truncated message behind.
  if (Buffer.byteLength(JSON.stringify({ version: 1, messages: [proposed] })) > MAILBOX_DOC_LIMIT) {
    throw new Error('Message envelope exceeds the mailbox size budget; nothing was written. Shorten the text or evidence.');
  }
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, message: proposed }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Every caller syncs the directory, including a concurrent reader of a
    // just-published receipt, before any message can be written to Herdr.
    syncDirectory(outbox);
    const prepared = readPrepared(path);
    if (semantic(prepared) !== semantic(proposed)) throw new Error(
      'This idempotency key already belongs to a different message; use the original payload or a new key.',
    );
    return { message: prepared, path };
  } finally { unlinkSync(temporary); }
}

const clientOptions={timeoutMs:15000};
let client;
let prepared;
try{
  const {values}=parseArgs({options:{kind:{type:'string',default:'question'},text:{type:'string'},file:{type:'string'},'evidence-file':{type:'string'},'idempotency-key':{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.log('herdr-message --kind question|result|progress --text "message to Codex" [--file PATH] [--evidence-file PATH] [--idempotency-key stable-key]\nWorker evidence is an optional bounded JSON object (worker claims, never verified authority).\nAfter a question, finish your turn. Codex replies to this same native terminal.');}
  else{
    if(!process.env.HERDR_CODEX_WORKER_CONFIG||!process.env.HC_TERMINAL_ID)throw new Error('Run this from a registered Herdr worker.');
    const worker=JSON.parse(readFileSync(process.env.HERDR_CODEX_WORKER_CONFIG,'utf8'));
    if(values.file && values.text !== undefined)throw new Error('Supply only one of --text or --file');
    const text=values.file?readFileSync(values.file,'utf8'):values.text;
    if(!text?.trim())throw new Error('Supply --text or --file');
    // Admission budget is measured in UTF-8 bytes and enforced here, before any
    // outbox receipt or native write, so an oversized report is never reported
    // as recorded. Evidence keeps its own separate 1 MiB envelope.
    if(Buffer.byteLength(text)>MAX_TEXT_BYTES)throw new Error(`Message text exceeds the ${MAX_TEXT_BYTES}-byte wire budget; nothing was written. Shorten it or attach a bounded evidence file.`);
    if(!['question','result','progress'].includes(values.kind))throw new Error('Kind must be question, result, or progress');
    if(values['idempotency-key'] === '')throw new Error('Idempotency key must not be empty');
    let evidence;
    if(values['evidence-file']!==undefined){
      evidence=JSON.parse(readFileSync(values['evidence-file'],'utf8'));
      // Validate and bind the raw claim to this worker/task before any durable
      // outbox preparation or native write.
      validateMessageEvidence(evidence,{workerId:worker.id,taskId:worker.taskId});
    }
    client=new HerdrClient({...clientOptions,hc:worker.hc});
    const terminal=await client.request('terminal.get',{terminal:process.env.HC_TERMINAL_ID});
    if(worker.adoption)assertNativeWorker(worker,terminal);
    else if(terminal.name!==worker.name||terminal.cwd!==worker.project||
      terminal.labels?.['codex.worker']!==worker.id||terminal.labels?.['codex.task']!==worker.taskId)
      throw new Error('The current terminal does not match the worker binding. A native child needs its own adopted binding.');
    const key=values['idempotency-key'];
    const proposed={id:key?`hm-${digest(`${worker.id}:${key}`).slice(0,32)}`:`hm-${randomUUID()}`,
      taskId:worker.taskId,workerId:worker.id,terminalId:process.env.HC_TERMINAL_ID,
      kind:values.kind,text,createdAt:new Date().toISOString(),turn:terminal.turn,...(key?{idempotencyKey:key}:{}),
      ...(evidence!==undefined?{evidence}:{})};
    prepared=prepareMessage(worker,proposed);
    const {message}=prepared;
    const result=await appendMessage(client,worker,message);
    console.log(JSON.stringify({id:message.id,status:'recorded',duplicate:result.duplicate??false,note:'Durably stored in Herdr. Delivery to Codex and its reply are separate.'}));
  }
}catch(error){console.error(JSON.stringify({error:error.message,...(prepared?{id:prepared.message.id,outboxFile:prepared.path}:{})}));process.exitCode=1;}
finally{client?.close();}
