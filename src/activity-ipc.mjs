import { createServer, createConnection } from 'node:net';
import { mkdirSync, lstatSync, chmodSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const activeBuses = new Map();
const FRAME_LIMIT = 131_072;
const errorText = error => new Error(`Herdr activity notifications unavailable: ${error.message}. Start the updated bridge for this installation; no polling fallback was used.`, { cause: error });
const keyFor = dbPath => realpathSync(resolve(dbPath));
const frame = value => JSON.stringify(value) + '\n';

/** Private, short Unix socket location. Never follow an untrusted socket-parent symlink. */
export function activitySocketPath(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') throw new TypeError('A file-backed database path is required');
  const uid = process.getuid();
  const directory = join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `herdr-activity-${uid}`);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o077)) {
    throw new Error('Activity socket directory must be owned by this user with mode 0700 and cannot be a symlink');
  }
  return join(directory, createHash('sha256').update(keyFor(dbPath)).digest('hex').slice(0, 32) + '.sock');
}

function readFrames(socket, onFrame, fail) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > FRAME_LIMIT) { fail(new Error('Activity protocol frame is too large')); return; }
      try { onFrame(JSON.parse(line)); } catch (error) { fail(error); return; }
    }
    if (Buffer.byteLength(buffer) > FRAME_LIMIT) fail(new Error('Activity protocol frame is too large'));
  });
}

async function removeStaleSocket(path) {
  let entry;
  try { entry = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entry.isSocket() || entry.uid !== process.getuid()) throw new Error('Refusing to replace a foreign or non-socket activity path');
  const live = await new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Existing activity socket did not respond')); }, 1_000);
    const finish = (error, result) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(result); };
    socket.once('connect', () => finish(null, true));
    socket.once('error', error => ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? finish(null, false) : finish(error));
  });
  if (live) throw new Error('An activity bus already owns this installation');
  let current;
  try { current = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (current.ino !== entry.ino || current.dev !== entry.dev) throw new Error('Activity socket identity changed during recovery');
  unlinkSync(path);
}

/** Start only inside the existing bridge's exclusive lifecycle/lock. No new daemon. */
export async function startActivityBus({ dbPath, onError = () => {}, onExternalNotify = async () => {}, onSupervisorRequest }) {
  const key = keyFor(dbPath), path = activitySocketPath(dbPath);
  if (activeBuses.has(key)) throw new Error('An activity bus already owns this installation');
  await removeStaleSocket(path);
  const sockets = new Set(), subscribers = new Set();
  let closing = false, queued = false, ownedEntry;
  const notify = () => {
    if (closing || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closing) return;
      for (const socket of subscribers) {
        if (!socket.write(frame({ type: 'activity', version: 1 }))) socket.destroy(new Error('Slow activity subscriber'));
      }
    });
  };
  const server = createServer(socket => {
    if (closing || sockets.size >= 128) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); subscribers.delete(socket); });
    let subscribed = false, notifying = false;
    readFrames(socket, value => {
      if (value?.version !== 1) throw new Error('Unsupported activity protocol version');
      if (value.type === 'subscribe' && !subscribed) {
        subscribed = true;
        // Install subscriber BEFORE acknowledging. Durable snapshot starts only
        // after the client receives this acknowledgement.
        subscribers.add(socket);
        socket.write(frame({ type: 'ready', version: 1 }));
      } else if (value.type === 'notify' && !subscribed && !notifying) {
        notifying = true;
        Promise.resolve().then(onExternalNotify).then(() => {
          notify(); socket.end(frame({ type: 'notified', version: 1 }));
        }, error => {
          onError(error); socket.end(frame({ type: 'error', version: 1, message: String(error.message).slice(0,500) }));
        });
      } else if(value.type==='supervisor'&&!subscribed&&!notifying&&typeof onSupervisorRequest==='function'){
        notifying=true;
        Promise.resolve().then(()=>onSupervisorRequest(value.request)).then(result=>{
          const response=frame({type:'supervisor-result',version:1,result});
          if(Buffer.byteLength(response)>FRAME_LIMIT)throw new Error('Supervisor response exceeds the bounded protocol; request one message at a time');
          socket.end(response);
        }).catch(error=>{
          onError(error);socket.end(frame({type:'error',version:1,message:String(error.message).slice(0,500)}));
        });
      } else throw new Error('Invalid activity protocol request');
    }, () => socket.destroy());
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.removeListener('error', reject); resolvePromise(); });
  });
  try { chmodSync(path, 0o600); ownedEntry = lstatSync(path); }
  catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolvePromise => server.close(resolvePromise));
    throw error;
  }
  const bus = {
    path, notify,
    async close() {
      if (closing) return;
      closing = true; activeBuses.delete(key);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
      try {
        const current = lstatSync(path);
        if (current.ino === ownedEntry.ino && current.dev === ownedEntry.dev) unlinkSync(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
  server.on('error', error => { for (const socket of sockets) socket.destroy(); onError(error); });
  activeBuses.set(key, bus);
  return bus;
}

/** Resolves only after the bridge installed this subscription. */
export function subscribeJournalActivity({ dbPath, onActivity, onError, timeoutMs = 5_000, signal }) {
  if (typeof onActivity !== 'function' || typeof onError !== 'function') throw new TypeError('Activity and error callbacks are required');
  return new Promise((resolvePromise, reject) => {
    let socket, timer, ready = false, closed = false;
    const fail = error => {
      if (closed) return;
      closed = true; clearTimeout(timer); socket?.destroy();
      signal?.removeEventListener('abort', aborted);
      if (ready) onError(errorText(error)); else reject(errorText(error));
    };
    const aborted = () => fail(signal.reason ?? new Error('Activity subscription aborted'));
    try {
      if (signal?.aborted) { aborted(); return; }
      signal?.addEventListener('abort', aborted, { once: true });
      socket = createConnection(activitySocketPath(dbPath));
      timer = setTimeout(() => fail(new Error('Bridge subscription acknowledgement timed out')), timeoutMs);
      socket.once('connect', () => socket.write(frame({ type: 'subscribe', version: 1 })));
      socket.on('error', fail);
      socket.once('end', () => fail(new Error('The bridge closed its activity channel')));
      socket.once('close', () => fail(new Error('The bridge activity channel disconnected')));
      readFrames(socket, value => {
        if (value?.version !== 1) throw new Error('Unsupported activity protocol version');
        if (value.type === 'ready' && !ready) {
          ready = true; clearTimeout(timer);
          resolvePromise({ close() { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); socket.destroy(); } });
        } else if (value.type === 'activity' && ready) onActivity();
        else throw new Error('Invalid activity notification');
      }, fail);
    } catch (error) { fail(error); }
  });
}

/** Publish only after the journal transaction commits. Await for delivery acknowledgement. */
export function publishJournalActivity(dbPath, { timeoutMs = 60_000 } = {}) {
  const local = activeBuses.get(keyFor(dbPath));
  if (local) { local.notify(); return Promise.resolve(); }
  return new Promise((resolvePromise, reject) => {
    let socket, timer, done = false;
    const finish = error => {
      if (done) return;
      done = true; clearTimeout(timer); socket?.destroy();
      error ? reject(errorText(error)) : resolvePromise();
    };
    try {
      socket = createConnection(activitySocketPath(dbPath));
      timer = setTimeout(() => finish(new Error('Bridge notification acknowledgement timed out')), timeoutMs);
      socket.once('connect', () => socket.write(frame({ type: 'notify', version: 1 })));
      socket.on('error', finish);
      socket.once('end', () => finish(new Error('Bridge closed before acknowledging journal notification')));
      readFrames(socket, value => {
        if(value?.type==='error')throw new Error(value.message);
        if (value?.version !== 1 || value.type !== 'notified') throw new Error('Invalid journal notification acknowledgement');
        finish();
      }, finish);
    } catch (error) { finish(error); }
  });
}

/** Worker-facing transport: only the private socket and a scoped credential are
 * required. No manager config, database access or arbitrary RPC is exposed. */
export function requestSupervision({socketPath,request,timeoutMs=60000}){
 if(typeof socketPath!=='string'||!socketPath.startsWith('/')||socketPath.includes('\0'))return Promise.reject(new Error('Expected private supervisor socket path'));
 const payload=frame({version:1,type:'supervisor',request});
 if(Buffer.byteLength(payload)>FRAME_LIMIT)return Promise.reject(new Error('Supervisor request exceeds the protocol limit'));
 return new Promise((resolvePromise,reject)=>{
  const socket=createConnection(socketPath);let complete=false;
  const finish=(error,value)=>{if(complete)return;complete=true;clearTimeout(timer);socket.destroy();error?reject(error):resolvePromise(value);};
  const timer=setTimeout(()=>finish(new Error('Supervisor operation outcome is uncertain; inspect its request/message ID before repeating')),timeoutMs);
  socket.once('connect',()=>socket.write(payload));socket.on('error',error=>finish(error));socket.once('end',()=>{if(!complete)finish(new Error('Supervisor bridge closed before confirming the operation'));});
  readFrames(socket,value=>{if(value?.version!==1)throw new Error('Unsupported supervisor protocol');if(value.type==='error')throw new Error(value.message);if(value.type!=='supervisor-result')throw new Error('Invalid supervisor response');finish(null,value.result);},error=>finish(error));
 });
}

/** Store.journal calls publisher() after INSERT. The queued microtask runs after
 * its synchronous outer transaction commits/rolls back. Rollback hints are safe:
 * subscribers read committed journal rows rather than trusting these hints.
 * CLI callers MUST await flush() before successful exit; failures remain visible.
 */
export function createJournalPublisher(dbPath, { onError = () => {} } = {}) {
  let pending = null, again = false, lastError = null;
  const publish = () => {
    again = true;
    if (pending) return;
    pending = Promise.resolve().then(async () => {
      while (again) {
        again = false;
        await publishJournalActivity(dbPath);
      }
    }).catch(error => { lastError = error; onError(error); }).finally(() => { pending = null; if (again) publish(); });
  };
  publish.flush = async () => { while (pending) await pending; if (lastError) throw lastError; };
  return publish;
}
