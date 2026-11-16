// Host queue connector. Uses only the official generated app-server protocol.
// No thread start/resume, queue start/reorder, arbitrary RPC, or database writes.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set(['thread/read', 'thread/queue/list', 'thread/queue/add', 'thread/queue/update', 'thread/queue/delete']);
const MUTATIONS = new Set(['thread/queue/add', 'thread/queue/update', 'thread/queue/delete']);
const ENV_KEYS = ['PATH','HOME','CODEX_HOME','LANG','LC_ALL','LC_CTYPE','TMPDIR','TZ','SystemRoot','USERPROFILE'];

export class HostQueueError extends Error {
  constructor(code, message, uncertain = false) { super(message); this.name = 'HostQueueError'; this.code = code; this.uncertain = uncertain; }
}
function nonempty(value) { return typeof value === 'string' && value.trim() && !value.includes('\0'); }
function validateThread(threadId) { if (!UUID.test(threadId ?? '')) throw new HostQueueError('INVALID_THREAD', 'An existing chat UUID is required.'); }
function validateOwnership({threadId, receipt, clientUserMessageId}) {
  validateThread(threadId);
  if (!nonempty(receipt) || !nonempty(clientUserMessageId)) throw new HostQueueError('INVALID_OWNERSHIP', 'Exact recorded receipt and client message identity are required.');
}
function input(text) {
  if (!nonempty(text)) throw new HostQueueError('INVALID_TEXT', 'Nonempty text without NUL is required.');
  return [{type:'text',text,text_elements:[]}];
}
function validRow(row) {
  return row && nonempty(row.id) && nonempty(row.clientUserMessageId) && Array.isArray(row.input);
}

/** One short-lived official app-server connection. An explicit socket uses the
 * existing shared server. An absent socket uses stdio metadata/queue transport;
 * its thread runtime status is local to that process, not desktop liveness. */
export async function withHostQueueRpc({ executable, socketPath, env = process.env, timeoutMs = 15_000, spawnImpl = spawn }, body) {
  if (!isAbsolute(executable ?? '') || executable.includes('\0') ||
      (socketPath !== undefined && (!isAbsolute(socketPath) || socketPath.includes('\0'))) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof body !== 'function') {
    throw new HostQueueError('INVALID_TRANSPORT', 'Invalid host queue transport options.');
  }
  const safeEnv = Object.fromEntries(ENV_KEYS.filter(k => nonempty(env[k])).map(k=>[k,env[k]]));
  const args = socketPath ? ['app-server','proxy','--sock',socketPath] : ['app-server','--listen','stdio://'];
  let child;
  try { child = spawnImpl(executable,args,{env:safeEnv,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true}); }
  catch { throw new HostQueueError('NOT_STARTED','Could not start the host queue transport.'); }
  let seq = 0, exited = false;
  const pending = new Map();
  const fail = (code,message) => {
    for (const [id,p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(new HostQueueError(code,message,p.mutation)); }
  };
  child.on('error',()=>fail('TRANSPORT_ERROR','Host queue transport failed.'));
  child.on('exit',()=>{exited=true;fail('TRANSPORT_CLOSED','Host queue transport closed before confirmation.');});
  child.stdin.on('error',()=>fail('TRANSPORT_ERROR','Host queue input transport failed.'));
  child.stderr.resume(); // Never publish process diagnostics containing host configuration.
  const lines = createInterface({input:child.stdout});
  lines.on('line', line=>{
    if (Buffer.byteLength(line) > 16*1024*1024) {fail('INVALID_RESPONSE','Host queue response exceeded the transport limit.'); child.kill('SIGTERM'); return;}
    let message; try {message=JSON.parse(line);} catch {fail('INVALID_RESPONSE','Host queue returned malformed JSON.');return;}
    const p = pending.get(message.id);
    if (!p) return; // Notifications are not delivery receipts.
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new HostQueueError(`RPC_${message.error.code}`, 'Host queue request was rejected.',p.mutation && ![-32600,-32601,-32602].includes(message.error.code)));
    else if (!Object.hasOwn(message,'result')) p.reject(new HostQueueError('INVALID_RESPONSE','Host queue returned no result.',p.mutation));
    else p.resolve(message.result);
  });
  const request = (method, params) => {
    if (method !== 'initialize' && !METHODS.has(method)) throw new HostQueueError('DISALLOWED_METHOD','Host queue method is not allowed.');
    if (exited) return Promise.reject(new HostQueueError('NOT_STARTED','Host queue transport is not running.'));
    return new Promise((resolve,reject)=>{
      const id=++seq, mutation=MUTATIONS.has(method);
      const timer=setTimeout(()=>{pending.delete(id);reject(new HostQueueError('TIMEOUT','Host queue response timed out; reconcile before repeating mutations.',mutation));},timeoutMs);
      pending.set(id,{resolve,reject,timer,mutation});
      child.stdin.write(JSON.stringify({id,method,params})+'\n', error=>{
        if (error && pending.has(id)) {pending.delete(id);clearTimeout(timer);reject(new HostQueueError('TRANSPORT_ERROR','Host queue request could not be confirmed.',mutation));}
      });
    });
  };
  try {
    await request('initialize',{clientInfo:{name:'herdr_codex_notifications',version:'0.1.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    return await body((method,params)=>{
      if (!METHODS.has(method)) throw new HostQueueError('DISALLOWED_METHOD','Host queue method is not allowed.');
      return request(method,params);
    });
  } finally {
    fail('TRANSPORT_CLOSED','Host queue transport closed.');
    child.stdin.end(); lines.close();
    if (!exited) await new Promise(resolve=>{
      const timer=setTimeout(()=>{child.kill('SIGTERM');resolve();},1000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
    });
  }
}

/** `rpc` is injectable. Caller must persist each stable clientUserMessageId
 * before add, serialize operations per thread/envelope, and never blindly retry
 * a timed-out add. List reconciliation does not prove that an absent add wasn't
 * consumed already; keep uncertain delivery conservative. */
export function createHostQueueClient(rpc) {
  if (typeof rpc !== 'function') throw new TypeError('rpc is required');
  async function list(threadId) {
    validateThread(threadId);
    const rows=[],seenIds=new Set(),seenCursors=new Set(); let cursor;
    do {
      const page=await rpc('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});
      if (!page || !Array.isArray(page.data) || (page.nextCursor != null && !nonempty(page.nextCursor))) throw new HostQueueError('INVALID_RESPONSE','Host queue returned an invalid page.');
      for (const row of page.data) {
        if (!validRow(row) || seenIds.has(row.id)) throw new HostQueueError('INVALID_RESPONSE','Host queue returned invalid or duplicate message identities.');
        seenIds.add(row.id);rows.push(row);
      }
      cursor=page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new HostQueueError('INVALID_RESPONSE','Host queue pagination repeated a cursor.');
      if (cursor) seenCursors.add(cursor);
    } while(cursor);
    return rows;
  }
  async function owned(options) {
    validateOwnership(options);
    const rows=await list(options.threadId), match=rows.find(x=>x.id===options.receipt);
    if (!match) return null;
    if (match.clientUserMessageId !== options.clientUserMessageId) throw new HostQueueError('OWNERSHIP_MISMATCH','Queue receipt belongs to a different client message; no mutation performed.');
    return match;
  }
  return {
    list,
    async readThread(threadId) { validateThread(threadId);return rpc('thread/read',{threadId,includeTurns:false}); },
    async add({threadId,clientUserMessageId,text}) {
      validateThread(threadId);
      if (!nonempty(clientUserMessageId)) throw new HostQueueError('INVALID_OWNERSHIP','A persisted client message identity is required.');
      const requested=input(text);
      const result=await rpc('thread/queue/add',{threadId,clientUserMessageId,input:requested});
      if (!validRow(result?.queuedSubmission) || result.queuedSubmission.clientUserMessageId !== clientUserMessageId || JSON.stringify(result.queuedSubmission.input)!==JSON.stringify(requested)) throw new HostQueueError('INVALID_RECEIPT','Host queue add receipt did not match the request.',true);
      return result.queuedSubmission;
    },
    async update(options) {
      const requested=input(options.text);
      if (!await owned(options)) return {status:'absent'};
      const result=await rpc('thread/queue/update',{threadId:options.threadId,queuedSubmissionId:options.receipt,input:requested});
      const row=result?.queuedSubmission;
      if (!validRow(row) || row.id !== options.receipt || row.clientUserMessageId !== options.clientUserMessageId || JSON.stringify(row.input)!==JSON.stringify(requested)) throw new HostQueueError('INVALID_RECEIPT','Host queue update receipt did not match the owned message.',true);
      return {status:'updated',queuedSubmission:row};
    },
    async remove(options) {
      if (!await owned(options)) return {status:'absent'};
      const result=await rpc('thread/queue/delete',{threadId:options.threadId,queuedSubmissionId:options.receipt});
      if (typeof result?.deleted !== 'boolean') throw new HostQueueError('INVALID_RECEIPT','Host queue delete returned an invalid receipt.',true);
      return {status:result.deleted?'deleted':'absent'};
    },
  };
}

/** Lower-level connector for a durable notification engine which separately
 * verifies thread + owned client ID + envelope marker before update/delete. */
export class CodexQueue {
  constructor({executable,env=process.env,timeoutMs=15_000,socketPath,spawnImpl}={}) {
    const home=env.CODEX_HOME || (env.HOME && join(env.HOME,'.codex'));
    const defaultSocket=home && join(home,'app-server-control','app-server-control.sock');
    const selectedSocket=socketPath ?? (defaultSocket && existsSync(defaultSocket) ? defaultSocket : undefined);
    this.transport=selectedSocket?'shared-proxy':'stdio';
    let resolveReady,rejectReady;
    this.ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    this.ready.catch(()=>{}); // Closing an unused failed transport must not leak an unhandled rejection.
    this.closed=new Promise(resolve=>{this.finish=resolve;});
    this.done=withHostQueueRpc({executable,env,timeoutMs,socketPath:selectedSocket,...(spawnImpl?{spawnImpl}:{})},async rpc=>{
      resolveReady(rpc); await this.closed;
    }).catch(error=>{rejectReady(error);this.error=error;});
  }
  async request(method,params) { if(this.isClosed) throw new HostQueueError('CLOSED','Queue connection is closed.'); return (await this.ready)(method,params); }
  async list(threadId) { return createHostQueueClient((m,p)=>this.request(m,p)).list(threadId); }
  async readThread(threadId) { validateThread(threadId);return this.request('thread/read',{threadId,includeTurns:false}); }
  async add(threadId,{clientId,text}) {return createHostQueueClient((m,p)=>this.request(m,p)).add({threadId,clientUserMessageId:clientId,text});}
  async update(threadId,id,{text}) {
    validateThread(threadId); if(!nonempty(id)) throw new HostQueueError('INVALID_RECEIPT','An exact queue receipt is required.');
    const requested=input(text), result=await this.request('thread/queue/update',{threadId,queuedSubmissionId:id,input:requested});
    if(!validRow(result?.queuedSubmission) || result.queuedSubmission.id!==id || JSON.stringify(result.queuedSubmission.input)!==JSON.stringify(requested)) throw new HostQueueError('INVALID_RECEIPT','Update response did not match the exact queue item.',true);
    return result.queuedSubmission;
  }
  async delete(threadId,id) {
    validateThread(threadId); if(!nonempty(id)) throw new HostQueueError('INVALID_RECEIPT','An exact queue receipt is required.');
    const result=await this.request('thread/queue/delete',{threadId,queuedSubmissionId:id});
    if(typeof result?.deleted!=='boolean') throw new HostQueueError('INVALID_RECEIPT','Delete response was invalid.',true);
    return result.deleted;
  }
  async close() {this.isClosed=true;this.finish();await this.done;}
}
