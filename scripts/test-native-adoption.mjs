#!/usr/bin/env node
/** Native existing-terminal adoption acceptance matrix. No model calls or real Codex dispatches.
 * Usage: node scripts/test-native-adoption.mjs --hc-binary /absolute/herdr-core --out /absolute/new-directory
 * Uses its own core/session, XDG paths, database and terminal programs.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import { existsSync, watch, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Bridge } from '../src/bridge.mjs';
import { HerdrClient } from '../src/native.mjs';
import { Adoption } from '../src/adoption.mjs';
import { Desks } from '../src/desks.mjs';
import { Delegation } from '../src/delegation.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = join(packageRoot, 'tests/fixtures/native-adoption-agent.mjs');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const THREAD = '00000000-0000-4000-8000-000000000001'; // fake sink only
const SETTLE_MS = 120;

class Tape {
  rows = [];
  listeners = new Set();
  push(value) {
    const row = { index: this.rows.length, at: new Date().toISOString(), ...value };
    this.rows.push(row);
    for (const listener of [...this.listeners]) listener(row);
    return row;
  }
  wait(predicate, { after = 0, timeoutMs = 15000, label = 'event' } = {}) {
    const existing = this.rows.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const finish = (error, value) => { clearTimeout(timer); this.listeners.delete(onRow); error ? reject(error) : resolvePromise(value); };
      const onRow = row => { if (row.index >= after && predicate(row)) finish(null, row); };
      const timer = setTimeout(() => finish(new Error(`Timed out awaiting ${label}`)), timeoutMs);
      this.listeners.add(onRow);
    });
  }
  quiet(after, durationMs = SETTLE_MS * 2 + 250) {
    assert.equal(this.rows.length, after, 'Unexpected dispatch before quiet interval');
    return new Promise((resolvePromise, reject) => {
      const onRow = row => { clearTimeout(timer); this.listeners.delete(onRow); reject(new Error(`Unexpected dispatch: ${row.messageId}`)); };
      const timer = setTimeout(() => { this.listeners.delete(onRow); resolvePromise(); }, durationMs);
      this.listeners.add(onRow);
    });
  }
}

function waitForPath(path, timeoutMs = 15000) {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const finish = error => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolvePromise(); };
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    const timer = setTimeout(() => finish(new Error(`Native core did not create ${path}`)), timeoutMs);
    watcher.on('error', finish);
    if (existsSync(path)) finish();
  });
}

const { values } = parseArgs({ options: { 'hc-binary': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/test-native-adoption.mjs --hc-binary /absolute/herdr-core --out /absolute/new-directory\nStarts an isolated core and deterministic OSC7501 terminals. Never dispatches to Codex or calls models.');
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('This acceptance harness is qualified on macOS only');
for (const key of ['hc-binary', 'out']) if (!isAbsolute(values[key] ?? '')) throw new Error(`Expected absolute --${key}`);
const binary = await realpath(values['hc-binary']);
if (!(await stat(binary)).isFile()) throw new Error('Expected the native executable, not a directory');
const out = resolve(values.out);
await mkdir(out, { recursive: false, mode: 0o700 });
const paths = Object.fromEntries(['config', 'state', 'runtime', 'manager', 'project'].map(name => [name, join(out, name)]));
for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
await mkdir(join(paths.config, 'herdr-core'), { mode: 0o700 });
await writeFile(join(paths.config, 'herdr-core/config.toml'), 'notes = false\ndraft_wait = 0\nshell = ["/bin/sh"]\n');
const session = `adopt-test-${randomUUID().slice(0, 12)}`;
// Keep the Unix socket short even when the evidence output path is long.
const runtime = await import('node:fs/promises').then(fs => fs.mkdtemp('/private/tmp/herdr-adopt-native-'));
const socket = join(runtime, 'core.sock');
const cleanEnv = { HOME: process.env.HOME, USER: process.env.USER ?? 'test', LOGNAME: process.env.LOGNAME ?? 'test',
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', TERM: 'xterm-256color',
  XDG_CONFIG_HOME: paths.config, XDG_STATE_HOME: paths.state, XDG_RUNTIME_DIR: runtime,
  HC_SESSION: session, HC_SOCKET: socket };
const wrapper = join(out, 'hc');
await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(cleanEnv).map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ${quote(binary)} "$@"\n`, { mode: 0o700 });
const config = { version: 1, stateDir: paths.manager, path: join(out, 'config.json'), packageRoot,
  hc: wrapper, app: '/never-execute-herdr-app', node: process.execPath, profileFile: '/never-read-model-profile',
  codex: '/never-execute-codex', registryDoc: 'cx-reg-native-adoption-test', autoNotifySettleMs: SETTLE_MS };
await writeFile(config.path, JSON.stringify(config, null, 2) + '\n');
const events = new Tape(), bridgeEvents = new Tape(), bridgeCalls = new Tape(), dispatches = new Tape(), subscriptions = new Tape(), queueNotifications = new Tape();
const evidence = { version: 1, startedAt: new Date().toISOString(), session, binary, socket, out,
  noModels: true, noCodexDispatch: true, checks: [], cleanup: [] };
let core, coreExit, bridge, rpc, observer, failure;
const terminals = [];

function newBridge() {
  return new Bridge(config, {
    clientFactory: options => {
      const client = new HerdrClient(options);
      const request = client.request.bind(client);
      client.request = (method, params) => {
        bridgeCalls.push({ method, ...(params?.terminal ? { terminal: params.terminal } : {}) });
        return request(method, params);
      };
      const subscribe = client.subscribe.bind(client);
      client.subscribe = async callback => {
        const snapshot = await subscribe(note => {
          const result = callback(note);
          bridgeEvents.push({ note });
          return result;
        });
        subscriptions.push({ kind: 'subscribed', seq: snapshot.seq });
        return snapshot;
      };
      return client;
    },
    queue: {
      // Model a host that consumes each accepted envelope immediately. These
      // native lifecycle scenarios do not test persistent host queue editing.
      async list(threadId) {assert.equal(threadId,THREAD);return [];},
      async add(threadId,{clientId,text}) {
        assert.equal(threadId,THREAD);
        const notificationId=/^Herdr inbox notification: (hn-[^\n]+)\n/.exec(text)?.[1];
        assert.ok(notificationId,'Expected the new inbox envelope header');
        const envelope=bridge.notifications.get(notificationId);
        assert.ok(envelope,'Envelope must be durable before host add');
        assert.equal(envelope.threadId,threadId);assert.equal(envelope.clientId,clientId);
        assert.ok(envelope.members.length>0);
        queueNotifications.push({notificationId,threadId,members:[...envelope.members]});
        for(const messageId of envelope.members){
          const stored=bridge.store.message(messageId);
          assert.ok(stored,'Message must be durable before host add');
          assert.equal(bridge.store.task(stored.taskId).threadId,threadId);
          assert.ok(text.includes('- '+stored.kind+' '+messageId+' — '),'Envelope must identify each member');
          dispatches.push({notificationId,messageId,taskId:stored.taskId,kind:stored.kind,attention:stored.attention??null,text:stored.text});
        }
        return {id:'fake-sink:'+notificationId,clientUserMessageId:clientId,input:[{type:'text',text}]};
      },
      async update(){throw new Error('Immediately consumed fake host rows cannot be updated');},
      async delete(){throw new Error('Immediately consumed fake host rows cannot be deleted');},
      close(){},
    },
  });
}

async function pulse() {
  const cursor = bridgeEvents.rows.length;
  const current = await rpc.request('doc.get', { name: config.registryDoc });
  await rpc.request('doc.set', { name: config.registryDoc, version: current.version, value: { nonce: randomUUID() } });
  await bridgeEvents.wait(r => r.note?.method === 'event' && r.note.params.type === 'doc' && r.note.params.data.name === config.registryDoc,
    { after: cursor, label: 'bridge registration pulse' });
  await bridge.chain;
}

function makeTask(id, { project = paths.project, threadId = THREAD, deskId = 'fixture-desk', deskProjectId = 'project' } = {}) {
  const value = { id, name: id, project, threadId, deskId, deskProjectId, status: 'active', createdAt: new Date().toISOString() };
  bridge.store.saveTask(value); return value;
}
function adopter() { return new Adoption({ config, store: bridge.store, rpc, pulse }); }
async function launchNative(name, { cwd = paths.project, labels = {} } = {}) {
  const result = await rpc.request('terminal.run', { argv: [process.execPath, fixtureFile, wrapper],
    cwd, name, no_parent: true, wait: false, keep: false, labels, size: { cols: 100, rows: 30 } });
  const terminalId = result.address ?? result.terminal?.address ?? result.terminal;
  assert.equal(typeof terminalId, 'string'); terminals.push(terminalId);
  await events.wait(r => r.note?.method === 'event' && r.note.params.terminal === terminalId &&
    r.note.params.type === 'status' && r.note.params.data.status?.state === 'idle', { label: name + ' startup' });
  return { terminalId, native: await rpc.request('terminal.get', { terminal: terminalId }) };
}
async function sendTo(terminalId, command, predicate) {
  const cursor = events.rows.length;
  const waiting = predicate && events.wait(r => r.note?.method === 'event' && r.note.params.terminal === terminalId && predicate(r.note.params),
    { after: cursor, label: terminalId + ' ' + command.cmd });
  if (waiting) void waiting.catch(() => {});
  await rpc.request('terminal.send', { terminal: terminalId, text: JSON.stringify(command), wait: false });
  if (waiting) await waiting;
  // An independent observer can outrun the bridge callback: use its registry
  // event as a synchronization barrier, not a repeated status check.
  await pulse();
}
const work = (t, text = 'Working on the existing terminal.') => sendTo(t, { cmd: 'working', text }, e => e.type === 'status' && e.data.status?.state === 'working');
const done = (t, text = 'ADOPTED FORGOTTEN RESULT: no report helper was installed or called.') => sendTo(t, { cmd: 'done', text }, e => e.type === 'turn');
function input(owner, id, terminalId, extra = {}) {
  return { id, terminalId, project: owner.project, threadId: owner.threadId, taskId: owner.id,
    deskId: owner.deskId, deskProjectId: owner.deskProjectId, scope: 'read-only', ...extra };
}
async function resolveMessage(notice) {
  const message = bridge.store.message(notice.messageId);
  const envelope = bridge.notifications.get(notice.notificationId);
  if (envelope && !envelope.receivedAt) bridge.notifications.receive(envelope.id);
  if (!message.action) bridge.store.recordAction(message.id, { kind: 'accept', text: 'Isolated native adoption fixture verified.', requestId: 'accept-' + message.id });
  bridge.store.ack(message.id);
  await bridge.pump({ strict: true });
}
async function closeTask(owner) {
  for (const message of bridge.store.messages({ taskId: owner.id, pending: true })) {
    bridge.store.receive(message.id);
    if (!message.action) bridge.store.recordAction(message.id, { kind: 'accept', text: 'Isolated fixture cleanup.', requestId: 'close-' + message.id });
    bridge.store.ack(message.id);
  }
  bridge.store.saveTask({ ...owner, status: 'closed' }); await bridge.pump({ strict: true });
}
async function check(name, fn) {
  const started = Date.now();
  try { const details = await fn(); evidence.checks.push({ name, passed: true, elapsedMs: Date.now() - started, ...details }); console.log('PASS ' + name); }
  catch (error) { evidence.checks.push({ name, passed: false, error: error.message }); throw error; }
}

try {
  const log = openSync(join(out, 'core.log'), 'a', 0o600), ready = waitForPath(socket);
  core = spawn(binary, ['serve'], { env: { ...cleanEnv, HC_LAUNCHD_DIRECT: String(process.pid) }, stdio: ['ignore', log, log] });
  closeSync(log);
  coreExit = new Promise(resolvePromise => { core.once('exit', (code, signal) => resolvePromise({ code, signal })); core.once('error', error => resolvePromise({ error: error.message })); });
  await ready;
  rpc = new HerdrClient({ hc: wrapper, timeoutMs: 30000 });
  evidence.core = await rpc.request('server.status');
  assert.equal(evidence.core.pid, core.pid, 'Only an exact test-owned direct child core may be used');
  observer = new HerdrClient({ hc: wrapper, timeoutMs: 15000 });
  evidence.initialSnapshot = await observer.subscribe(note => { events.push({ note }); });
  bridge = newBridge(); await bridge.start(); await bridge.chain;
  const desks = new Desks({ store: bridge.store, config });
  desks.create({ id: 'fixture-desk', name: 'Isolated adoption desk', purpose: 'Native lifecycle tests only.' });
  desks.projectAdd({ deskId: 'fixture-desk', id: 'project', name: 'Fixture project', path: paths.project });
  const foreignProject = join(out, 'foreign-project'); await mkdir(foreignProject);
  desks.projectAdd({ deskId: 'fixture-desk', id: 'foreign', name: 'Foreign fixture', path: foreignProject });

  await check('foreign unregistered terminals remain untouched and do not wake', async () => {
    const foreign = await launchNative('foreign-unclaimed', { cwd: foreignProject, labels: { 'test.owner': 'unrelated-fixture' } });
    const cursor = dispatches.rows.length;
    await work(foreign.terminalId); await done(foreign.terminalId);
    await dispatches.quiet(cursor);
    assert.equal(bridge.store.workers().some(w => w.terminalId === foreign.terminalId), false);
    const owner = makeTask('wrong-project');
    await assert.rejects(() => adopter().adopt(input(owner, 'wrong-project-agent', foreign.terminalId)));
    assert.deepEqual((await rpc.request('terminal.get', { terminal: foreign.terminalId })).labels, foreign.native.labels);
    await closeTask(owner);
    return { terminalId: foreign.terminalId, implicitlyAdopted: false, labelsUnchanged: true };
  });

  await check('adopt working terminal without relaunch/input; forgotten result routes to exact Desk/task/chat', async () => {
    const owner = makeTask('adopt-working'), existing = await launchNative('existing-working');
    await work(existing.terminalId);
    const before = await rpc.request('terminal.get', { terminal: existing.terminalId });
    const cursor = dispatches.rows.length, request = input(owner, 'adopted-working', existing.terminalId);
    const adopted = await adopter().adopt(request);
    assert.equal(adopted.registrationState, 'attached'); assert.equal(adopted.sandboxEnforced, false);
    assert.equal(adopted.notifications, 'native-lifecycle');
    const after = await rpc.request('terminal.get', { terminal: existing.terminalId });
    assert.equal(after.pid, before.pid); assert.deepEqual(after.argv, before.argv); assert.equal(after.turn, before.turn);
    assert.equal(after.status?.state, 'working');
    const repeated = await adopter().adopt(request); assert.equal(repeated.reused, true);
    await assert.rejects(() => adopter().adopt({ ...request, id: 'duplicate-owner' }));
    await assert.rejects(() => adopter().adopt({ ...request, threadId: '00000000-0000-4000-8000-000000000002' }));
    const saved = bridge.store.worker(request.id);
    assert.equal(saved.taskId, owner.id); assert.equal(saved.deskId, owner.deskId);
    await done(existing.terminalId);
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'turn_ended', { after: cursor, label: 'adopted terminal wake' });
    assert.match(notice.text, /ADOPTED FORGOTTEN RESULT/);
    assert.equal(bridge.store.task(notice.taskId).threadId, THREAD);
    assert.equal(bridge.store.task(notice.taskId).deskId, 'fixture-desk');
    await resolveMessage(notice);
    const event = events.rows.findLast(r => r.note?.method === 'event' && r.note.params.type === 'turn' && r.note.params.terminal === existing.terminalId);
    await bridge.onNotification(structuredClone(event.note)); await bridge.onNotification(structuredClone(event.note));
    await bridge.stop(); await bridge.chain; bridge.store.close();
    bridge = newBridge(); await bridge.start(); await bridge.chain;
    await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await closeTask(owner);
    return { terminalId: existing.terminalId, originalPid: before.pid, messageId: notice.messageId,
      registrationRepeated: true, duplicateEventReplayed: true, bridgeRestarted: true };
  });

  await check('adopted terminal crash creates independent attention and remains deduplicated', async () => {
    const owner = makeTask('adopt-crash'), existing = await launchNative('existing-crash');
    await adopter().adopt(input(owner, 'adopted-crash', existing.terminalId));
    const cursor = dispatches.rows.length;
    await work(existing.terminalId);
    await sendTo(existing.terminalId, { cmd: 'crash', text: 'ADOPTED CRASH EXIT 23' }, e => e.type === 'finished');
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'process_finished', { after: cursor, label: 'adopted crash wake' });
    assert.equal((await rpc.request('terminal.get', { terminal: existing.terminalId })).state, 'finished');
    await resolveMessage(notice); await pulse(); await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await closeTask(owner);
    return { terminalId: existing.terminalId, messageId: notice.messageId };
  });

  await check('a real native child requires explicit adoption and retains parent lifetime and routing', async () => {
    const owner = makeTask('adopt-child'), parent = await launchNative('existing-parent');
    const parentRequest = input(owner, 'adopted-parent', parent.terminalId, { scope: 'write' });
    await adopter().adopt(parentRequest);
    const otherWriter = await launchNative('existing-other-writer');
    await assert.rejects(() => adopter().adopt(input(owner, 'conflicting-writer', otherWriter.terminalId, { scope: 'write' })));
    assert.deepEqual((await rpc.request('terminal.get', { terminal: otherWriter.terminalId })).labels, otherWriter.native.labels,
      'A rejected writer adoption must not claim native labels');
    const cursor = events.rows.length;
    await sendTo(parent.terminalId, { cmd: 'spawn', name: 'existing-child' });
    const created = await events.wait(r => r.note?.method === 'event' && r.note.params.type === 'created' && r.note.params.data.parent === parent.terminalId,
      { after: cursor, label: 'real native child' });
    const childId = created.note.params.terminal; terminals.push(childId);
    await events.wait(r => r.note?.method === 'event' && r.note.params.terminal === childId && r.note.params.type === 'status' && r.note.params.data.status?.state === 'idle', { after: cursor, label: 'child startup' });
    const before = await rpc.request('terminal.get', { terminal: childId });
    assert.equal(before.parent, parent.terminalId);
    assert.equal(bridge.store.workers().some(w => w.terminalId === childId), false);
    const discovery = await adopter().children(parentRequest.id);
    assert.equal(discovery.children.find(c => c.terminalId === childId)?.adoptionRequired, true);
    assert.equal(bridge.store.workers().some(w => w.terminalId === childId), false, 'Discovery must not adopt');
    const quietCursor = dispatches.rows.length;
    await work(childId); await done(childId, 'UNADOPTED CHILD RESULT'); await dispatches.quiet(quietCursor);
    const request = input(owner, 'adopted-child', childId, { parentId: parentRequest.id });
    await adopter().adopt(request);
    const after = await rpc.request('terminal.get', { terminal: childId });
    assert.equal(after.pid, before.pid); assert.equal(after.parent, parent.terminalId); assert.deepEqual(after.argv, before.argv);
    assert.equal(bridge.store.worker(request.id).taskId, owner.id);
    assert.equal((await adopter().children(parentRequest.id)).children.find(c => c.terminalId === childId)?.registeredAgentId, request.id);
    const beforeHandoff = dispatches.rows.length;
    await work(parent.terminalId); await work(childId); await done(parent.terminalId, 'Parent awaiting child outcome.');
    await dispatches.quiet(beforeHandoff);
    await done(childId, 'ADOPTED CHILD RESULT: ready for manager inspection.');
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'turn_ended', { after: beforeHandoff, label: 'adopted child team wake' });
    assert.deepEqual(notice.attention.workers.map(w => w.workerId).sort(), [parentRequest.id, request.id].sort());
    await resolveMessage(notice);
    await closeTask(owner);
    return { parentTerminal: parent.terminalId, childTerminal: childId, childPid: before.pid, messageId: notice.messageId,
      childWasNotAutomaticallyRegistered: true, parentPreserved: true, writerConflictRejectedWithoutRelabeling: true };
  });

  await check('adopted child explicit reports use its own binding, deduplicate and continue the same process', async () => {
    const owner = makeTask('adopt-reports'), parent = await launchNative('report-parent');
    const parentRequest = input(owner, 'report-parent', parent.terminalId);
    const parentBinding = await adopter().adopt(parentRequest);
    const childCursor = events.rows.length;
    await sendTo(parent.terminalId, { cmd: 'spawn', name: 'report-child' });
    const created = await events.wait(r => r.note?.method === 'event' && r.note.params.type === 'created' && r.note.params.data.parent === parent.terminalId,
      { after: childCursor, label: 'reporting native child' });
    const childId = created.note.params.terminal; terminals.push(childId);
    await events.wait(r => r.note?.method === 'event' && r.note.params.terminal === childId && r.note.params.type === 'status' && r.note.params.data.status?.state === 'idle',
      { after: childCursor, label: 'reporting child startup' });
    const childRequest = input(owner, 'report-child', childId, { parentId: parentRequest.id });
    const childBinding = await adopter().adopt(childRequest);
    const nativeBefore = await rpc.request('terminal.get', { terminal: childId });
    const resultOf = async (receiptDoc, cursor) => {
      await events.wait(r => r.note?.method === 'event' && r.note.params.type === 'doc' && r.note.params.data.name === receiptDoc,
        { after: cursor, label: receiptDoc });
      return (await rpc.request('doc.get', { name: receiptDoc })).value;
    };

    const wrongCursor = events.rows.length, dispatchCursor = dispatches.rows.length;
    await sendTo(childId, { cmd: 'report', workerConfig: parentBinding.workerConfig, text: 'A child must not report as its parent.',
      key: 'wrong-parent', receiptDoc: 'adopt-wrong-helper', expectFailure: true });
    const rejected = await resultOf('adopt-wrong-helper', wrongCursor);
    assert.equal(rejected.receipts[0].exitCode, 1);
    assert.match(rejected.receipts[0].error, /identity|match|binding|terminal/i);
    assert.equal(bridge.store.messages({ taskId: owner.id }).length, 0);
    await dispatches.quiet(dispatchCursor);

    const questionCursor = events.rows.length;
    await sendTo(childId, { cmd: 'report', workerConfig: childBinding.workerConfig, kind: 'question',
      text: 'ADOPTED CHILD QUESTION: please confirm the next fixture step.', key: 'child-question', repeat: 2,
      receiptDoc: 'adopt-child-question' }, e => e.type === 'turn');
    const questionReceipt = await resultOf('adopt-child-question', questionCursor);
    assert.equal(questionReceipt.receipts.length, 2);
    assert.equal(questionReceipt.receipts[0].id, questionReceipt.receipts[1].id);
    const question = await dispatches.wait(r => r.taskId === owner.id && r.kind === 'question',
      { after: dispatchCursor, label: 'adopted child explicit question' });
    assert.equal(question.messageId, questionReceipt.receipts[0].id);
    const saved = bridge.store.message(question.messageId);
    assert.equal(saved.workerId, childRequest.id); assert.equal(saved.terminalId, childId);
    assert.equal(bridge.store.task(saved.taskId).threadId, THREAD);
    assert.equal(bridge.store.task(saved.taskId).deskId, 'fixture-desk');
    await resolveMessage(question); await pulse(); await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);

    const followCursor = events.rows.length, followDispatchCursor = dispatches.rows.length;
    const response = { cmd: 'report', workerConfig: childBinding.workerConfig, kind: 'result',
      text: 'ADOPTED CHILD RESULT: continued the existing process using the manager answer.',
      key: 'child-result', receiptDoc: 'adopt-child-result' };
    const instruction = 'Continue this existing session and report the outcome. ADOPTED_REPORT_CONTINUATION ' + Buffer.from(JSON.stringify(response)).toString('base64url');
    const delegation = new Delegation({ config, store: bridge.store, rpc, pulse });
    const followup = await delegation.followup(childRequest.id, 'adopted-child-followup', { instruction });
    assert.equal(followup.state, 'sent');
    const resultReceipt = await resultOf('adopt-child-result', followCursor);
    await events.wait(r => r.note?.method === 'event' && r.note.params.terminal === childId && r.note.params.type === 'turn',
      { after: followCursor, label: 'adopted child followup completion' });
    await pulse();
    const result = await dispatches.wait(r => r.taskId === owner.id && r.kind === 'result',
      { after: followDispatchCursor, label: 'adopted child followup result' });
    assert.equal(result.messageId, resultReceipt.receipts[0].id);
    assert.equal(bridge.store.message(result.messageId).workerId, childRequest.id);
    assert.equal(resultReceipt.pid, nativeBefore.pid);
    const nativeAfter = await rpc.request('terminal.get', { terminal: childId });
    assert.equal(nativeAfter.pid, nativeBefore.pid); assert.equal(nativeAfter.parent, parent.terminalId);
    assert.deepEqual(nativeAfter.argv, nativeBefore.argv);
    const turnBeforeRetry = nativeAfter.turn;
    assert.equal((await delegation.followup(childRequest.id, 'adopted-child-followup', { instruction })).state, 'sent');
    assert.equal((await rpc.request('terminal.get', { terminal: childId })).turn, turnBeforeRetry);
    await resolveMessage(result); await pulse(); await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 2);
    assert.equal(bridge.store.messages({ taskId: owner.id }).filter(m => m.workerId === parentRequest.id).length, 0);
    await closeTask(owner);
    return { parentTerminal: parent.terminalId, childTerminal: childId, originalPid: nativeBefore.pid,
      wrongParentBindingRejected: true, questionId: question.messageId, duplicateHelperCalls: 2,
      resultId: result.messageId, sameProcessFollowup: true, duplicateFollowupReused: true };
  });
} catch (error) { failure = error; evidence.error = { message: error.message, stack: error.stack }; }
finally {
  // No command here can reach another core: the wrapper hardcodes this unique
  // session/socket, starts from an empty environment, and terminal IDs are ours.
  if (bridge) { try { await bridge.stop(); await bridge.chain; bridge.store.close(); evidence.cleanup.push('bridge stopped'); } catch (e) { evidence.cleanup.push(`bridge cleanup: ${e.message}`); } }
  observer?.close();
  if (rpc && !rpc.closed) {
    for (const terminal of terminals) {
      try { await rpc.request('terminal.kill', { terminal }); } catch (e) { if (!['not_found', 'finished'].includes(e.data?.kind)) evidence.cleanup.push(`kill ${terminal}: ${e.message}`); }
    }
    try { await rpc.request('server.stop'); evidence.cleanup.push('isolated core stop requested'); } catch (e) { evidence.cleanup.push(`core stop: ${e.message}`); }
    rpc.close();
  }
  if (core && core.exitCode === null && core.signalCode === null) {
    // Bound cleanup of our own direct child only; never locate/kill other cores.
    const deadline = setTimeout(() => core.kill('SIGTERM'), 3000);
    const hardDeadline = setTimeout(() => core.kill('SIGKILL'), 5000);
    evidence.coreExit = await coreExit;
    clearTimeout(deadline); clearTimeout(hardDeadline);
  } else if (coreExit) evidence.coreExit = await coreExit;
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = !failure;
  evidence.dispatches = dispatches.rows;
  evidence.queueNotifications = queueNotifications.rows;
  evidence.events = events.rows;
  evidence.subscriptions = subscriptions.rows;
  evidence.bridgeCalls = bridgeCalls.rows;
  const fullReport = JSON.stringify(evidence, null, 2) + '\n';
  const fullPath = join(out, 'native-adoption.json');
  await writeFile(fullPath, fullReport);
  const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(v => v === value).length]));
  const summary = { version: 1, passed: evidence.passed, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
    session, core: { version: evidence.core?.version ?? null, pid: evidence.core?.pid ?? null, exit: evidence.coreExit ?? null },
    noModels: true, noCodexDispatch: true, checks: evidence.checks, cleanup: evidence.cleanup,
    eventCount: events.rows.length, eventCounts: counts(events.rows.map(r => r.note?.method === 'event' ? r.note.params.type : r.note?.method ?? 'unknown')),
    dispatchCount: dispatches.rows.length, notificationCount: queueNotifications.rows.length,
    dispatches: dispatches.rows.map(({ messageId, taskId, kind, attention }) => ({ messageId, taskId, kind, reason: attention?.reason ?? null })),
    bridgeRpcCounts: counts(bridgeCalls.rows.map(r => r.method)), subscriptionCount: subscriptions.rows.length,
    fullEvidence: { path: fullPath, sha256: createHash('sha256').update(fullReport).digest('hex') },
    ...(failure ? { error: failure.message } : {}) };
  await writeFile(join(out, 'native-adoption-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, summary: join(out, 'native-adoption-summary.json'), evidence: join(out, 'native-adoption.json') }));
if (failure) { console.error(failure.stack); process.exitCode = 1; }
