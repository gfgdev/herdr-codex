#!/usr/bin/env node
/** Native event acceptance matrix. No model calls or real Codex dispatches.
 * Usage: node scripts/test-native-wakes.mjs --hc-binary /absolute/herdr-core --out /absolute/new-directory
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
import { appendMessage } from '../src/mailbox.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = join(packageRoot, 'tests/fixtures/native-agent.mjs');
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
  console.log('node scripts/test-native-wakes.mjs --hc-binary /absolute/herdr-core --out /absolute/new-directory\nStarts an isolated core and deterministic OSC7501 terminals. Never dispatches to Codex or calls models.');
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
const session = `wake-test-${randomUUID().slice(0, 12)}`;
// Keep the Unix socket short even when the evidence output path is long.
const runtime = await import('node:fs/promises').then(fs => fs.mkdtemp('/private/tmp/herdr-wake-native-'));
const socket = join(runtime, 'core.sock');
const cleanEnv = { HOME: process.env.HOME, USER: process.env.USER ?? 'test', LOGNAME: process.env.LOGNAME ?? 'test',
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', TERM: 'xterm-256color',
  XDG_CONFIG_HOME: paths.config, XDG_STATE_HOME: paths.state, XDG_RUNTIME_DIR: runtime,
  HC_SESSION: session, HC_SOCKET: socket };
const wrapper = join(out, 'hc');
await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(cleanEnv).map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ${quote(binary)} "$@"\n`, { mode: 0o700 });
const config = { version: 1, stateDir: paths.manager, path: join(out, 'config.json'), packageRoot,
  hc: wrapper, codex: '/never-execute-codex', registryDoc: 'cx-reg-native-test', autoNotifySettleMs: SETTLE_MS };
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
function task(id) {
  const value = { id, name: id, project: paths.project, threadId: THREAD, status: 'active', createdAt: new Date().toISOString() };
  bridge.store.saveTask(value);
  return value;
}
async function launch(owner, id, { keep = false } = {}) {
  const fixtureConfig = join(out, `${id}.fixture.json`);
  const worker = { id, taskId: owner.id, name: id, role: 'pi', project: paths.project,
    mailbox: `cx-${id}`, startTurn: 0, notifyOnDone: true, writePaths: [], terminalId: null };
  await writeFile(fixtureConfig, JSON.stringify({ hc: wrapper, worker }));
  const result = await rpc.request('terminal.run', { argv: [process.execPath, fixtureFile, fixtureConfig],
    cwd: paths.project, name: id, no_parent: true, wait: false, keep, labels: { 'codex.worker': id, 'codex.task': owner.id }, size: { cols: 100, rows: 30 } });
  worker.terminalId = result.address ?? result.terminal?.address ?? result.terminal;
  assert.equal(typeof worker.terminalId, 'string');
  terminals.push(worker.terminalId);
  const terminal = await rpc.request('terminal.get', { terminal: worker.terminalId });
  worker.launchResult = { ...result, pid: terminal.pid };
  worker.launchState = 'started';
  bridge.store.saveWorker(worker);
  await writeFile(fixtureConfig, JSON.stringify({ hc: wrapper, worker }));
  await events.wait(row => row.note?.method === 'event' && row.note.params.terminal === worker.terminalId &&
    row.note.params.type === 'status' && row.note.params.data.status?.state === 'idle', { label: `${id} startup idle` });
  await pulse();
  await bridge.chain;
  return worker;
}
async function send(worker, command, expected) {
  const after = events.rows.length;
  const wait = expected && events.wait(row => row.note?.method === 'event' && row.note.params.terminal === worker.terminalId && expected(row.note.params),
    { after, label: `${worker.id} ${command.cmd}` });
  // A send can fail before its expected event. Preserve the original failure
  // without leaving the bounded event wait as an unhandled rejection.
  if (wait) void wait.catch(() => {});
  await rpc.request('terminal.send', { terminal: worker.terminalId, text: JSON.stringify(command), wait: false });
  if (wait) await wait;
  await bridge.chain;
}
const work = (worker, text = 'Working on a deterministic fixture task.') => send(worker, { cmd: 'work', text }, e => e.type === 'status' && e.data.status?.state === 'working');
const done = (worker, text = 'Finished the requested fixture step without a manager message.') => send(worker, { cmd: 'done', text }, e => e.type === 'turn');
async function closeTask(owner) {
  for (const message of bridge.store.messages({ taskId: owner.id, pending: true })) {
    bridge.store.recordAction(message.id, { kind: 'accept', text: 'Native test observed this notification.', requestId: `test-${message.id}` });
    bridge.store.ack(message.id);
  }
  bridge.store.saveTask({ ...owner, status: 'closed' });
}
async function check(name, fn) {
  const start = Date.now();
  try { const details = await fn(); evidence.checks.push({ name, passed: true, elapsedMs: Date.now() - start, ...details }); console.log(`PASS ${name}`); }
  catch (error) { evidence.checks.push({ name, passed: false, elapsedMs: Date.now() - start, error: error.message }); throw error; }
}

try {
  const log = openSync(join(out, 'core.log'), 'a', 0o600);
  // Direct startup is scoped by upstream to this immediate parent PID. Tests
  // must not install a login service or disturb the user's running core.
  const ready = waitForPath(socket);
  core = spawn(binary, ['serve'], { env: { ...cleanEnv, HC_LAUNCHD_DIRECT: String(process.pid) }, stdio: ['ignore', log, log] });
  closeSync(log);
  coreExit = new Promise(resolvePromise => { core.once('exit', (code, signal) => resolvePromise({ code, signal })); core.once('error', error => resolvePromise({ error: error.message })); });
  await ready;
  rpc = new HerdrClient({ hc: wrapper, timeoutMs: 30000 });
  evidence.core = await rpc.request('server.status');
  assert.equal(evidence.core.pid, core.pid, 'Test must own the exact direct child core');
  observer = new HerdrClient({ hc: wrapper, timeoutMs: 15000 });
  evidence.initialSnapshot = await observer.subscribe(note => { events.push({ note }); });
  bridge = newBridge(); await bridge.start(); await bridge.chain;

  await check('startup idle stays quiet; forgotten result wakes with readable text', async () => {
    const owner = task('forgotten-report'), worker = await launch(owner, 'forgotten-pi');
    const before = dispatches.rows.length;
    const idleCallCursor = bridgeCalls.rows.length;
    await dispatches.quiet(before);
    assert.equal(bridgeCalls.rows.length, idleCallCursor, 'Dormant startup must not poll native RPCs');
    assert.equal(bridgeCalls.rows.filter(r => r.method === 'terminal.read').length, 0, 'Startup idle must not read terminal output');
    const heartbeatCursor = bridgeEvents.rows.length;
    const heartbeat = await bridgeEvents.wait(r => r.note?.method === 'heartbeat',
      { after: heartbeatCursor, timeoutMs: 25000, label: 'actual idle native heartbeat' });
    await bridge.chain;
    assert.equal(bridgeCalls.rows.length, idleCallCursor, 'Idle native heartbeat must not cause RPC reads');
    assert.equal(dispatches.rows.length, before, 'Idle native heartbeat must not wake Codex');
    const dormantEvidence = { actualHeartbeatAt: heartbeat.at, heartbeatSequence: heartbeat.note.params.seq,
      nativeRpcCallsWhileDormant: bridgeCalls.rows.length - idleCallCursor, terminalReadsBeforeWork: 0, wakeCountBeforeWork: 0 };
    await work(worker);
    await done(worker, 'VISIBLE FORGOTTEN RESULT: deterministic fixture output is ready for inspection.');
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'turn_ended', { after: before, label: 'forgotten-result wake' });
    assert.match(notice.text, /VISIBLE FORGOTTEN RESULT/);
    assert.match(notice.text, /inspect|review/i);
    assert.deepEqual(notice.attention.workers.map(w => w.workerId), [worker.id]);
    const actualTurn = events.rows.findLast(r => r.note?.method === 'event' && r.note.params.terminal === worker.terminalId && r.note.params.type === 'turn');
    assert.ok(actualTurn);
    // Replay the exact envelope captured from the real core, simulating an
    // at-least-once event transport without inventing a terminal state.
    await bridge.onNotification(structuredClone(actualTurn.note));
    await bridge.onNotification(structuredClone(actualTurn.note));
    await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await closeTask(owner);
    return { messageId: notice.messageId, terminal: worker.terminalId, duplicateNativeEnvelopeReplayed: true, dormantEvidence };
  });

  await check('direct peer handoff stays quiet while colleague works, then aggregates', async () => {
    const owner = task('peer-handoff'), pi = await launch(owner, 'handoff-pi'), goose = await launch(owner, 'handoff-goose');
    const before = dispatches.rows.length;
    await work(pi);
    const cursor = events.rows.length;
    await send(pi, { cmd: 'handoff', to: goose.terminalId, peerText: 'DIRECT PEER REVIEW: received from fixture Pi.' }, e => e.type === 'turn');
    await events.wait(r => r.index >= cursor && r.note?.method === 'event' && r.note.params.terminal === goose.terminalId &&
      r.note.params.type === 'status' && r.note.params.data.status?.state === 'working', { after: cursor, label: 'peer working' });
    await dispatches.quiet(before);
    await done(goose, 'DIRECT PEER REVIEW COMPLETE: ready for inspection.');
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'turn_ended', { after: before, label: 'aggregate wake' });
    assert.deepEqual(notice.attention.workers.map(w => w.workerId).sort(), [pi.id, goose.id].sort());
    await dispatches.quiet(dispatches.rows.length);
    await closeTask(owner);
    return { messageId: notice.messageId, terminals: [pi.terminalId, goose.terminalId] };
  });

  await check('explicit result suppresses fallback; repeated mailbox and reconnect do not duplicate', async () => {
    const owner = task('explicit-result'), worker = await launch(owner, 'explicit-pi');
    const before = dispatches.rows.length;
    await work(worker);
    await send(worker, { cmd: 'result', id: 'native-explicit-result', message: 'Explicit native fixture result; inspect its evidence.' }, e => e.type === 'turn');
    const notice = await dispatches.wait(r => r.messageId === 'native-explicit-result', { after: before, label: 'explicit result' });
    assert.equal(notice.kind, 'result');
    await dispatches.quiet(dispatches.rows.length);
    const stored = bridge.store.message(notice.messageId);
    const replay = Object.fromEntries(['id', 'taskId', 'workerId', 'terminalId', 'kind', 'text', 'createdAt', 'turn'].map(k => [k, stored[k]]));
    await appendMessage(rpc, worker, replay);
    const subscriptionCursor = subscriptions.rows.length;
    bridge.events.child.kill('SIGTERM'); // actual transport disconnect, not synthetic bridge events
    await subscriptions.wait(() => true, { after: subscriptionCursor, label: 'native reconnect subscription' });
    await bridge.chain;
    await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await closeTask(owner);
    return { messageId: notice.messageId, replayed: true, reconnected: true };
  });

  await check('crash after an explicit result still raises independent attention', async () => {
    const owner = task('result-then-crash'), worker = await launch(owner, 'crash-pi');
    await work(worker);
    await send(worker, { cmd: 'result', id: 'before-native-crash', message: 'Reported before process exit.' }, e => e.type === 'turn');
    await dispatches.wait(r => r.messageId === 'before-native-crash', { label: 'pre-crash explicit result' });
    const before = dispatches.rows.length;
    await send(worker, { cmd: 'crash', text: 'FIXTURE CRASH AFTER RESULT' }, e => e.type === 'finished');
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'process_finished', { after: before, label: 'crash wake' });
    await closeTask(owner);
    return { messageId: notice.messageId, terminal: worker.terminalId };
  });

  await check('kept-program loss and shell replacement coalesce without repeating after restart', async () => {
    const owner = task('loss-replacement'), worker = await launch(owner, 'kept-pi', { keep: true });
    await work(worker);
    const before = dispatches.rows.length, eventCursor = events.rows.length;
    await send(worker, { cmd: 'signal', text: 'FIXTURE SIGNAL LOSS' }, e => e.type === 'lost');
    const notice = await dispatches.wait(r => r.taskId === owner.id && ['process_lost', 'process_replaced'].includes(r.attention?.reason),
      { after: before, label: 'program loss wake' });
    const replacement = await events.wait(r => r.note?.method === 'event' && r.note.params.terminal === worker.terminalId && r.note.params.type === 'restarted',
      { after: eventCursor, timeoutMs: 20000, label: 'native shell replacement' });
    await bridge.chain;
    await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await bridge.stop(); await bridge.chain; bridge.store.close();
    bridge = newBridge(); await bridge.start(); await bridge.chain;
    await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await closeTask(owner);
    return { messageId: notice.messageId, replacementPid: replacement.note.params.data.pid, bridgeRestarted: true };
  });

  await check('a silent turn ending while the bridge is stopped is recovered once', async () => {
    const owner = task('offline-completion'), worker = await launch(owner, 'offline-pi');
    const before = dispatches.rows.length, bridgeCursor = bridgeEvents.rows.length;
    await work(worker);
    // Wait for the real bridge subscription to enqueue this working observation,
    // not merely for our independent native observer to see it.
    await bridgeEvents.wait(r => r.note?.method === 'event' && r.note.params.terminal === worker.terminalId &&
      r.note.params.type === 'status' && r.note.params.data.status?.state === 'working',
    { after: bridgeCursor, label: 'durable working observation before bridge stop' });
    await bridge.chain;
    await bridge.stop(); await bridge.chain; bridge.store.close();
    await done(worker, 'OFFLINE FINISH: this turn ended while the bridge was stopped.');
    bridge = newBridge(); await bridge.start(); await bridge.chain;
    const notice = await dispatches.wait(r => r.taskId === owner.id && r.attention?.reason === 'turn_ended',
      { after: before, label: 'offline completion wake' });
    assert.match(notice.text, /OFFLINE FINISH/);
    await dispatches.quiet(dispatches.rows.length);
    assert.equal(dispatches.rows.filter(r => r.taskId === owner.id).length, 1);
    await closeTask(owner);
    return { messageId: notice.messageId, bridgeStoppedDuringTurnEnd: true };
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
  const fullPath = join(out, 'native-wakes.json');
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
  await writeFile(join(out, 'native-wakes-summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, summary: join(out, 'native-wakes-summary.json'), evidence: join(out, 'native-wakes.json') }));
if (failure) { console.error(failure.stack); process.exitCode = 1; }
