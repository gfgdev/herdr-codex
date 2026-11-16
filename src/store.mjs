import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { digest, uuid } from './config.mjs';
import { assertWorkerTask } from './routing.mjs';
import { canonicalize, validateMessageEvidence, MAX_TEXT_BYTES } from './evidence-transport.mjs';
const pathKey=p=>process.platform==='darwin'?p.normalize('NFC').toLowerCase():p;
const pathOverlap=(a,b)=>{a=pathKey(a);b=pathKey(b);return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');};

// A rejection carries an explicit classification so callers never have to parse
// prose or fall back to a broad catch-and-prune. Transient faults (SQLite busy,
// I/O) throw without a REPORT_ code and must retain the mailbox message.
const reject=(message,code)=>Object.assign(new Error(message),{code});
const QUARANTINE_LIMIT = 1024 * 1024;

const now = () => new Date().toISOString();
const decode = row => row ? JSON.parse(row.data) : null;
// Evidence is folded into the fingerprint only when present, so historical
// evidence-absent messages keep their original identity across upgrades.
const messageFingerprint = m => m.evidence === undefined
  ? digest(JSON.stringify([m.id,m.taskId,m.workerId,m.terminalId,m.kind,m.text,m.idempotencyKey ?? null]))
  : digest(JSON.stringify([m.id,m.taskId,m.workerId,m.terminalId,m.kind,m.text,m.idempotencyKey ?? null,canonicalize(m.evidence)]));

export class Store {
  constructor(path, {onJournal}={}) {
    this.onJournal=onJournal;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        task_id TEXT NOT NULL, worker_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
        delivery TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        receipt TEXT, warning TEXT, error TEXT, received_at TEXT, ack_at TEXT, action TEXT);
      CREATE TABLE IF NOT EXISTS writer_leases(worker_id TEXT PRIMARY KEY, paths TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quarantine(id TEXT PRIMARY KEY, report_id TEXT NOT NULL, task_id TEXT NOT NULL,
        worker_id TEXT NOT NULL, reason_code TEXT NOT NULL, reason TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS quarantine_task ON quarantine(task_id, worker_id);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        type TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  transaction(fn) {
    const depth=this.transactionDepth??0, savepoint=`herdr_nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth=depth+1;
    try { const result = fn(); this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch(error) {
      this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error;
    } finally { this.transactionDepth=depth; }
  }
  journal(type, data) { this.db.prepare('INSERT INTO journal(at,type,data) VALUES(?,?,?)').run(now(),type,JSON.stringify(data)); this.onJournal?.(); }
  tasks() { return this.db.prepare('SELECT data FROM tasks').all().map(decode); }
  task(id) { return decode(this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id)); }
  saveTask(task) {
    if (!uuid.test(task.threadId)) throw new Error('Task requires the exact manager chat UUID');
    const old = this.task(task.id);
    for(const key of ['deskId','deskProjectId','deskWorkId','deskJobId','deskRunId','deskStepId'])if(old&&(old[key]??null)!==(task[key]??null))throw new Error('Cannot silently reroute a desk task');
    if (old && (old.threadId !== task.threadId || old.project !== task.project)) throw new Error('Cannot silently reroute a task');
    this.db.prepare('INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id,JSON.stringify(task));
  }
  workers(taskId) { const all = this.db.prepare('SELECT data FROM workers').all().map(decode); return taskId ? all.filter(w=>w.taskId===taskId) : all; }
  worker(id) { return decode(this.db.prepare('SELECT data FROM workers WHERE id=?').get(id)); }
  saveWorker(worker) {
    assertWorkerTask(worker, this.task(worker.taskId));
    const old = this.worker(worker.id);
    if(worker.terminalId&&this.workers().some(w=>w.id!==worker.id&&w.terminalId===worker.terminalId))throw new Error('Native terminal is already registered to another worker');
    for(const key of ['deskId','deskProjectId','deskDefinitionId','deskDefinitionVersion','deskWorkId','deskJobId','deskRunId','deskStepId','supervisorId'])if(old&&(old[key]??null)!==(worker[key]??null))throw new Error('Desk worker binding cannot be reassigned');
    if(old&&JSON.stringify(old.supervisionGrant??null)!==JSON.stringify(worker.supervisionGrant??null))throw new Error('Frozen supervisor authority cannot change');
    if (old && (old.taskId !== worker.taskId || old.project !== worker.project || old.mailbox !== worker.mailbox || (old.terminalId && old.terminalId !== worker.terminalId))) throw new Error('Worker identity cannot be reassigned');
    this.db.prepare('INSERT INTO workers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(worker.id,JSON.stringify(worker));
  }
  reserveWorker(worker) {
    return this.transaction(()=>{
      if(this.worker(worker.id))throw new Error('Worker is already registered; inspect it before proceeding');
      for(const lease of this.db.prepare('SELECT * FROM writer_leases').all()){
        const owner=this.worker(lease.worker_id);
        // Output-only desk tasks keep the checkout read-only. The same-checkout
        // writer rule still covers every path inside/above that checkout.
        const touches=(paths,root)=>(paths??[]).some(p=>pathOverlap(p,root));
        if(owner&&pathKey(owner.project)===pathKey(worker.project) && touches(worker.writePaths,worker.project) && touches(owner.writePaths,owner.project))throw new Error(`Checkout is already owned by writer ${lease.worker_id}; reconcile that worker first`);
        const overlaps=(worker.writePaths??[]).some(p=>JSON.parse(lease.paths).some(q=>pathOverlap(p,q)));
        if(overlaps)throw new Error(`Writable paths already owned by ${lease.worker_id}; reconcile that worker first`);
      }
      this.saveWorker(worker);
      if(worker.writePaths?.length)this.db.prepare('INSERT INTO writer_leases VALUES(?,?)').run(worker.id,JSON.stringify(worker.writePaths));
    });
  }
  releaseWriter(workerId){this.db.prepare('DELETE FROM writer_leases WHERE worker_id=?').run(workerId);}
  writerLeases(){return this.db.prepare('SELECT worker_id, paths FROM writer_leases').all().map(row=>({workerId:row.worker_id, paths:JSON.parse(row.paths)}));}
  meta(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,JSON.stringify(value));
    return decode(this.db.prepare('SELECT data FROM metadata WHERE key=?').get(key));
  }
  ingest(worker, message, { lifecycle = false } = {}) {
    const task = this.task(worker.taskId);
    if (!task || task.status !== 'active') throw reject('Task is not active', 'REPORT_INACTIVE');
    if (!worker.terminalId || message.taskId !== task.id || message.workerId !== worker.id || message.terminalId !== worker.terminalId) throw reject('Message does not match registered worker/task/terminal', 'REPORT_ROUTE');
    const kinds = lifecycle ? ['question','result','progress','attention'] : ['question','result','progress'];
    if (!kinds.includes(message.kind) || typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text)>MAX_TEXT_BYTES) throw reject('Invalid message kind/text', 'REPORT_INVALID');
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(message.id ?? '')) throw reject('Invalid message ID', 'REPORT_INVALID');
    try { validateMessageEvidence(message.evidence, { workerId: worker.id, taskId: task.id }); }
    catch (error) { throw reject(error.message, 'REPORT_INVALID'); }
    const fingerprint = messageFingerprint(message);
    const old = this.db.prepare('SELECT fingerprint FROM messages WHERE id=?').get(message.id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw reject('Message ID reused with different contents', 'REPORT_CONFLICT');
      return false;
    }
    this.db.prepare('INSERT INTO messages(id,fingerprint,task_id,worker_id,kind,data,delivery) VALUES(?,?,?,?,?,?,?)')
      .run(message.id,fingerprint,task.id,worker.id,message.kind,JSON.stringify(message),message.kind==='progress'?'informational':'pending');
    this.journal('message.recorded', {id:message.id, taskId:task.id,workerId:worker.id,kind:message.kind});
    return true;
  }
  message(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) return null;
    return { ...JSON.parse(row.data), handoff:this.meta(`handoff:${id}`)??null, delivery:row.delivery, attempts:row.attempts, retryAt:row.retry_at,
      receipt:row.receipt, warning:row.warning, error:row.error, receivedAt:row.received_at,
      acknowledgedAt:row.ack_at, action:row.action ? JSON.parse(row.action) : null };
  }
  ingestSystem(task,message) {
    if(this.task(task.id)?.status!=='active'||message.taskId!==task.id||message.origin!=='desk-runtime'||message.workerId!==''||message.terminalId!==null||!['attention','result'].includes(message.kind)||typeof message.text!=='string'||!message.text.trim()||Buffer.byteLength(message.text)>65536||!/^[a-zA-Z0-9._-]{1,128}$/.test(message.id??''))throw new Error('Invalid Desk runtime incident');
    const fingerprint=messageFingerprint(message),old=this.db.prepare('SELECT fingerprint FROM messages WHERE id=?').get(message.id);
    if(old){if(old.fingerprint!==fingerprint)throw new Error('Runtime incident ID reused with changed contents');return false;}
    this.db.prepare('INSERT INTO messages(id,fingerprint,task_id,worker_id,kind,data,delivery) VALUES(?,?,?,?,?,?,?)').run(message.id,fingerprint,task.id,'',message.kind,JSON.stringify(message),'pending');
    this.journal('desk.runtime.incident',{id:message.id,taskId:task.id,deskId:task.deskId});return true;
  }
  /**
   * Durably archive a message that deterministic validation (or a content
   * conflict) rejected, before its mailbox copy may be pruned. Idempotent by
   * worker + report id + exact payload + reason code, so a replay after a crash
   * never duplicates and identical IDs with different payloads stay distinct.
   * Throws (never silently discards) when the archive cannot be committed.
   */
  quarantine(worker, message, { code, reason }) {
    const raw = JSON.stringify(message);
    const payload = Buffer.from(raw, 'utf8');
    const payloadSha256 = digest(raw);
    const reportId = typeof message?.id === 'string' && message.id ? message.id : payloadSha256.slice(0, 32);
    const id = `q-${digest(`${worker.id}\u0000${reportId}\u0000${payloadSha256}\u0000${code}`).slice(0, 40)}`;
    if (payload.length > QUARANTINE_LIMIT) throw new Error('Rejected message exceeds the quarantine archive budget');
    const boundedReason = String(reason ?? '').slice(0, 1000);
    // The archive row and its journal entry commit together. A journal failure
    // rolls the row back, so the caller retains the mailbox message and retries
    // cleanly instead of leaving a half-recorded archive.
    // A replay (same worker/report/payload/code) must return the ORIGINAL
    // persisted facts, never the caller's new reason, and must not re-journal or
    // re-insert. The archive id is reason-independent, so selecting the row is
    // the only way to return an immutable fact.
    const existing = this.db.prepare('SELECT reason_code, reason, payload_sha256, bytes FROM quarantine WHERE id=?').get(id);
    if (existing) return { id, reportId, code: existing.reason_code, reason: existing.reason, bytes: existing.bytes, payloadSha256: existing.payload_sha256, duplicate: true };
    this.transaction(() => {
      this.db.prepare('INSERT INTO quarantine(id,report_id,task_id,worker_id,reason_code,reason,payload_sha256,bytes,data,at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, reportId, worker.taskId, worker.id, code, boundedReason, payloadSha256, payload.length, raw, now());
      this.journal('message.quarantined', { id, reportId, taskId: worker.taskId, workerId: worker.id, code, sha256: payloadSha256, bytes: payload.length });
    });
    const entry = { id, reportId, code, reason: boundedReason, bytes: payload.length, payloadSha256 };
    return { ...entry, duplicate: false };
  }
  quarantines({ taskId, workerId } = {}) {
    return this.db.prepare('SELECT id,report_id,task_id,worker_id,reason_code,reason,payload_sha256,bytes,at FROM quarantine ORDER BY rowid').all()
      .filter(r => (!taskId || r.task_id === taskId) && (!workerId || r.worker_id === workerId))
      .map(r => ({ id: r.id, reportId: r.report_id, taskId: r.task_id, workerId: r.worker_id, code: r.reason_code,
        reason: r.reason, sha256: r.payload_sha256, bytes: r.bytes, at: r.at }));
  }
  quarantineEntry(id) {
    const row = this.db.prepare('SELECT * FROM quarantine WHERE id=?').get(id);
    if (!row) return null;
    return { id: row.id, reportId: row.report_id, taskId: row.task_id, workerId: row.worker_id, code: row.reason_code,
      reason: row.reason, sha256: row.payload_sha256, bytes: row.bytes, at: row.at, message: JSON.parse(row.data) };
  }
  messages({taskId, pending=false}={}) {
    return this.db.prepare('SELECT id FROM messages ORDER BY rowid').all().map(r=>this.message(r.id))
      .filter(m=>(!taskId || m.taskId===taskId) && (!pending || (!m.acknowledgedAt && m.kind!=='progress')));
  }
  pendingDispatch() { return this.messages({pending:true}).filter(m=>!m.receivedAt&&['pending','failed','uncertain'].includes(m.delivery) && m.retryAt<=Date.now()); }
  supersedeAttention(id, byMessageId) {
    return this.transaction(()=>{
      const m=this.message(id);
      const report=this.message(byMessageId);
      if(!report || report.taskId!==m?.taskId || !['question','result'].includes(report.kind))return false;
      if(!m || m.attention?.reason!=='turn_ended' || m.delivery!=='pending' || m.attempts!==0 || m.receivedAt || m.acknowledgedAt)return false;
      const action={kind:'superseded',state:'recorded',requestId:`covered-by:${byMessageId}`,at:now(),
        text:`Explicit manager message ${byMessageId} covers this unsent automatic attention notice.`};
      this.db.prepare("UPDATE messages SET delivery='superseded', action=?, ack_at=? WHERE id=?")
        .run(JSON.stringify(action),now(),id);
      this.journal('attention.superseded',{id,byMessageId});return true;
    });
  }
  startDispatch(id) {
    return this.transaction(()=>{
      const m=this.message(id);
      if (!m || m.acknowledgedAt || m.receivedAt || !['pending','failed','uncertain'].includes(m.delivery)) return false;
      this.db.prepare("UPDATE messages SET delivery='sending',attempts=attempts+1 WHERE id=?").run(id);
      return true;
    });
  }
  finishDispatch(id,result) {
    const m=this.message(id); if(!m)return;
    const retryAt=result.status==='queued'?0:Date.now()+Math.min(300000,1000*2**Math.min(m.attempts,8));
    this.db.prepare('UPDATE messages SET delivery=?,receipt=?,warning=?,error=?,retry_at=? WHERE id=?')
      .run(result.status,result.receipt??null,result.warning??null,result.error??null,retryAt,id);
    this.journal('message.delivery',{id,...result,retryAt});
  }
  recoverDispatches() {
    this.db.prepare("UPDATE messages SET delivery='uncertain',error='Bridge stopped during dispatch; delivery may have occurred',retry_at=0 WHERE delivery='sending' AND ack_at IS NULL").run();
  }
  receive(id) {
    const old=this.message(id);if(!old)throw new Error('Unknown message');
    this.db.prepare('UPDATE messages SET received_at=COALESCE(received_at,?) WHERE id=?').run(now(),id);
    if(!old.receivedAt)this.journal('message.received',{id,taskId:old.taskId,workerId:old.workerId});
    return this.message(id);
  }
  recordAction(id,action) {
    return this.transaction(()=>{
      const m=this.message(id); if(!m)throw new Error('Unknown message');
      if(m.action) {
        if(m.action.requestId!==action.requestId || m.action.kind!==action.kind || m.action.text!==action.text) throw new Error('An action is already recorded; inspect it instead of repeating work');
        return m.action;
      }
      if(!action.requestId || !action.text?.trim())throw new Error('Action needs requestId and explanation/reply');
      const saved={...action,at:now(),state:action.kind==='reply'?'prepared':'recorded'};
      this.db.prepare('UPDATE messages SET action=? WHERE id=?').run(JSON.stringify(saved),id);
      this.journal('message.action',{id,requestId:action.requestId,kind:action.kind});
      return saved;
    });
  }
  claimReply(id) {
    return this.transaction(()=>{
      const m=this.message(id); if(m?.action?.kind!=='reply'||m.action.state!=='prepared')return false;
      this.setActionState(id,'sending');return true;
    });
  }
  setActionState(id,state,details={}) {
    const m=this.message(id);if(!m?.action)throw new Error('No action');
    this.db.prepare('UPDATE messages SET action=? WHERE id=?').run(JSON.stringify({...m.action,state,...details}),id);
  }
  ack(id) {
    const m=this.message(id);
    if(!m?.action || !['recorded','sent'].includes(m.action.state))throw new Error('Record a completed decision or verified reply before acknowledging');
    this.db.prepare('UPDATE messages SET ack_at=COALESCE(ack_at,?) WHERE id=?').run(now(),id);
    if(!m.acknowledgedAt)this.journal('message.acknowledged',{id,taskId:m.taskId,workerId:m.workerId});
    return this.message(id);
  }
  close(){this.db.close();}
}
