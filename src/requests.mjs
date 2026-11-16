import { digest, safeId } from './config.mjs';
import { Retirement } from './retirement.mjs';

const now = () => new Date().toISOString();
const decode = row => row ? JSON.parse(row.data) : null;
// Receipt truthfulness: a `sent` request only proves the native transport
// accepted the input. Consumption stays unconfirmed until an operator records
// observed evidence (`reconcile`). `queued` is durable-only and `refused` is a
// terminal non-delivery. This mapping is deliberately conservative.
const DELIVERY = { sent: 'native-injected', queued: 'queued', failed: 'refused', uncertain: 'uncertain' };
// Explicit, durable intentional-stop dispatch state. A recorded intent alone is
// never proof that a signal reached the native process:
//   `not-dispatched` -- intent bound, no `terminal.kill` attempted (or the
//                       original was already finished before any signal)
//   `dispatching`    -- a kill was issued and its receipt is still outstanding
//   `accepted`       -- the native layer acknowledged a signal for this identity
//   `refused`        -- the native layer explicitly declined to signal it
//   `uncertain`      -- the kill failed without a recognised refusal (transport)
// `signalled` is the pre-R2-3 flag and is still read for records written by an
// older process, where `true` meant an accepted kill acknowledgement.
export const KILL_REFUSAL_KINDS = ['blocked','status_mismatch','invalid_params','config','denied','refused','finished'];
export const stopDispatch = stop => stop?.dispatch ?? (stop?.signalled === true ? 'accepted' : 'not-dispatched');
// Attribution of an OBSERVED same-identity exit. Only a signal the native layer
// actually ACKNOWLEDGED makes the exit our intentional stop; a stop whose intent
// never dispatched, but whose original was already finished, is truthfully
// `already-exited`; a refused or ambiguous dispatch is `unattributed` and must
// never be reported as a deliberate stop. A dispatch that is still in flight is
// NOT acceptance: the receipt has not arrived, so it can never irrevocably
// attribute the exit; a caller that observes such an exit reports it
// conservatively as unattributed on the first observation.
export const stopAttribution = (stop, reason = null) => {
  if(!stop) return 'unattributed';
  // A durable attribution is recorded evidence, not a derived value: a replay
  // must never rewrite an already-exited stop into an intentional one (or vice
  // versa) just because the record is re-observed.
  if(stop.attribution) return stop.attribution;
  const dispatch = stopDispatch(stop);
  if(dispatch === 'accepted') return 'intentional';
  if(dispatch === 'not-dispatched' && stop.alreadyExited === true && reason === 'process_finished') return 'already-exited';
  // Records confirmed before the `dispatch` field existed were deliberate stops.
  if(stop.state === 'confirmed') return 'intentional';
  return 'unattributed';
};

/** Durable manager-to-agent operations. Claims are transactional across CLI processes. */
export class Requests {
  constructor(store, { retirement } = {}) {
    this.store = store;
    // Retirement/ownership service. Releasing writer ownership ALWAYS funnels
    // through `Retirement.settle` so native exit, descendant clearance and
    // writer ownership stay separate facts; omission at construction can never
    // invoke a raw `releaseWriter`. A bare `new Requests(store)` therefore gets
    // a conservative default (`noCoverage`), which retains the lease as
    // `pending_retirement` until explicit complete clearance is recorded. A
    // caller that resolved a trusted containment provider may share that ONE
    // instance here (Delegation/Bridge do).
    this.retirement = retirement ?? new Retirement(store);
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_requests(
      worker_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(worker_id,request_id));`);
  }
  get(workerId, requestId) {
    return decode(this.db.prepare('SELECT data FROM agent_requests WHERE worker_id=? AND request_id=?').get(workerId,requestId));
  }
  list(workerId) {
    return this.db.prepare('SELECT data FROM agent_requests WHERE worker_id=? ORDER BY rowid').all(workerId).map(decode);
  }
  save(record) {
    this.db.prepare('UPDATE agent_requests SET data=? WHERE worker_id=? AND request_id=?')
      .run(JSON.stringify(record),record.workerId,record.requestId);
    return record;
  }
  reserve(worker, requestId, kind, payload) {
    safeId(requestId,'request ID');
    const fingerprint = digest(JSON.stringify({kind,payload}));
    return this.store.transaction(()=>{
      const old = this.get(worker.id,requestId);
      if(old) {
        if(old.fingerprint !== fingerprint) throw new Error('Request ID already binds different content');
        return old;
      }
      const record = {workerId:worker.id,taskId:worker.taskId,requestId,kind,payload,fingerprint,
        state:kind==='message'?'queued':'prepared',...(kind==='message'?{delivery:'queued'}:{}),createdAt:now()};
      this.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)').run(worker.id,requestId,fingerprint,JSON.stringify(record));
      this.store.journal('agent.request.'+record.state,{workerId:worker.id,taskId:worker.taskId,requestId,kind});
      return record;
    });
  }
  claim(workerId, requestId, render) {
    return this.store.transaction(()=>{
      const request = this.get(workerId,requestId);
      if(!request || !['prepared','queued'].includes(request.state)) return null;
      // A closed task normally forbids delivery, but an intentional stop is a
      // cleanup control: it must remain able to end the ORIGINAL verified agent
      // even after its task was closed, without reopening the task. Ordinary
      // messages and follow-ups (and interrupt) stay refused after close; only
      // the stop request that records the intentional end is exempt.
      if(request.kind!=='stop' && this.store.task(request.taskId)?.status!=='active')
        throw new Error('Task was closed before delivery');
      const all = this.list(workerId);
      // Re-check the intentional-stop barrier at the atomic claim so a stop
      // recorded after the caller's pre-check cannot be overtaken by delivery.
      // `stop` itself is exempt because it is the operation recording the stop.
      if(request.kind!=='stop' && this.store.meta('stop:'+workerId))
        throw new Error('Agent was intentionally stopped; input is refused before delivery');
      // `interrupt` and `stop` are lifecycle controls; unlike delivery they must
      // remain available even while the worker has an unresolved assignment.
      const control = request.kind==='interrupt'||request.kind==='stop';
      const initial=all.find(r=>r.kind==='initial');
      if(initial && initial.requestId!==requestId && !control && initial.state!=='sent')
        throw new Error('Initial assignment is not delivered; finish or reconcile it before continuation');
      // Durable per-agent ordering has two independent parts.
      //
      // 1. In-flight barrier (order-independent): any OTHER `sending` or
      //    `uncertain` operation blocks ordinary delivery regardless of when it
      //    was reserved. A later-reserved interrupt whose turn is still running
      //    must not be overtaken, and an inline `message` whose receipt was lost
      //    must be resolved first. Durable notes stay in `queued` until claimed,
      //    so they never trip this barrier; they are attached to the next
      //    delivery instead.
      //
      // 2. Prepared predecessor ordering (order-dependent): an ordinary
      //    assignment must wait for an EARLIER reserved (`prepared`) operation,
      //    but a LATER prepared request must never deadlock an earlier one (for
      //    example a follow-up that was refused while the initial was still
      //    awaiting readiness).
      //
      // Lifecycle exceptions: `stop` bypasses everything because an intentional
      // stop is exactly how a wedged turn is ended. `interrupt` bypasses
      // unresolved normal input but never another unresolved interrupt. A
      // confirmed stop then unblocks ordinary delivery.
      const position=all.findIndex(r=>r.requestId===requestId);
      const earlier=position>0?all.slice(0,position):[];
      const inFlight=all.filter(r=>r.requestId!==requestId&&(r.state==='sending'||r.state==='uncertain'));
      let blocking=null;
      if(request.kind!=='stop') {
        blocking = request.kind==='interrupt'
          ? (inFlight.find(r=>r.kind==='interrupt') ?? earlier.find(r=>r.kind==='interrupt'&&r.state==='prepared'))
          : (inFlight[0] ?? earlier.find(r=>r.state==='prepared'&&r.kind!=='message'));
      }
      if(blocking) throw new Error('Resolve request '+blocking.requestId+' before sending another operation');
      const notes = request.kind==='followup' || request.kind==='initial'
        ? all.filter(r=>r.kind==='message' && r.state==='queued' && !r.claimedBy) : [];
      const sent = {...request,state:'sending',claimedAt:now(),queuedIds:notes.map(n=>n.requestId),
        ...(render?{wireText:render(request,notes)}:{})};
      for(const note of notes) this.save({...note,state:'attached',claimedBy:requestId});
      return this.save(sent);
    });
  }
  finish(workerId, requestId, state, details={}) {
    if(!['sent','queued','failed','uncertain'].includes(state)) throw new Error('Invalid delivery state');
    return this.store.transaction(()=>{
      const request = this.get(workerId,requestId);
      if(!request || !['sending','uncertain'].includes(request.state)) throw new Error('Operation is not claimed');
      const saved = this.save({...request,delivery:DELIVERY[state],...details,state,updatedAt:now()});
      for(const id of request.queuedIds??[]) {
        const note=this.get(workerId,id);
        // A note carried on a native-accepted follow-up is `attached`, a
        // delivery value distinct from both durable `queued` and inline
        // `native-injected`, so receipts stay truthful about how it reached the
        // agent.
        if(state==='sent') this.save({...note,state:'delivered',delivery:'attached',deliveredBy:requestId,updatedAt:now()});
        else if(state==='failed') this.save({...note,state:'queued',delivery:'queued',claimedBy:null});
      }
      this.store.journal('agent.request.'+state,{workerId,taskId:request.taskId,requestId,kind:request.kind});
      return saved;
    });
  }
  // Shared, idempotent settling for an intentional stop. Both the CLI stop path
  // and the event-driven bridge call this with their identity/exit observation,
  // so a delayed native exit after the manager yielded is settled exactly once
  // and the two paths cannot diverge. The whole confirmed transition -- worker
  // stopped state, writer lease release, stop metadata, the durable request
  // receipt, the single `agent.stopped` audit row and the durable lifecycle
  // inbox notice -- commits in ONE transaction, so a crash at any point cannot
  // leave a half-stopped worker or silently lose the wake. An already-confirmed
  // stop is never downgraded and never notifies twice.
  // `confirmed` is only ever set from an observed `finished` state for the
  // recorded identity; a vanished terminal (`gone`) is never proof of exit and
  // never yields `confirmed-stopped`.
  settleStop(workerId, requestId, {confirmed=false, reason=null, observedReason=null, observedBy=null, gone=null, receipt=null, error=null, turn=0, attribution=null}={}) {
    return this.store.transaction(()=>{
      const request = requestId ? this.get(workerId, requestId) : null;
      const worker = this.store.worker(workerId);
      const prior = this.store.meta('stop:'+workerId) ?? {};
      const alreadyConfirmed = prior.state === 'confirmed';
      const isConfirmed = Boolean(confirmed) || alreadyConfirmed;
      const stopId = prior.requestId ?? requestId ?? null;
      const confirmedAt = isConfirmed ? (prior.confirmedAt ?? now()) : null;
      // Raw exit evidence is retained SEPARATELY from both the verdict and the
      // attribution: the fact that the original process was observed finished is
      // durable even when the stop cannot be causally attributed to it.
      // `observedReason` carries the raw observation (for example
      // `process_finished`); the classified `reason` used for the receipt and
      // notice never overwrites it. Attribution (below) tells the manager whether
      // that exit was ours; observedExit records what was actually seen.
      const observedExit = confirmed
        ? {reason: observedReason ?? reason ?? prior.observedExit?.reason ?? null,
           observedBy: observedBy ?? prior.observedExit?.observedBy ?? null,
           turn: Number.isSafeInteger(turn) ? turn : (prior.observedExit?.turn ?? null),
           at: prior.observedExit?.at ?? now()}
        : (prior.observedExit ?? null);
      // The observed-exit attribution is frozen on the first confirming
      // settlement so a replay can never re-derive a different story. It comes
      // only from the durable dispatch record, never from a bare re-observation.
      const outcome = prior.attribution ?? attribution ?? stopAttribution(prior, reason);
      const stop = {...prior, requestId: stopId,
        state: isConfirmed ? 'confirmed' : 'unconfirmed',
        reason: reason ?? prior.reason ?? null, observedBy: observedBy ?? prior.observedBy ?? null,
        ...(observedExit ? {observedExit} : {}),
        ...(isConfirmed ? {confirmedAt, attribution: outcome} : {lastCheckedAt: now()})};
      if(isConfirmed){
        if(worker && worker.launchState !== 'stopped')
          this.store.saveWorker({...worker,launchState:'stopped',stoppedAt:worker.stoppedAt ?? confirmedAt});
        this.retirement.settle({ worker, requestId: stopId, attribution: outcome,
          observedExit: {...observedExit, confirmed: true}, reason: 'stop-confirmed' });
        // Exactly one `agent.stopped` audit row per worker. A query (rather than
        // a metadata marker) keeps this idempotent even for a stop whose
        // metadata was confirmed by an older process that predates the row.
        const journaled = Boolean(this.db.prepare(
          "SELECT 1 FROM journal WHERE type='agent.stopped' AND json_extract(data,'$.workerId')=? LIMIT 1").get(workerId));
        if(!journaled)
          this.store.journal('agent.stopped',{workerId,taskId:worker?.taskId??request?.taskId??null,requestId:stopId,
            confirmed:true,reason:stop.reason??null,observedBy:observedBy??prior.observedBy??null});
        // One durable lifecycle notice, written on the confirming transition
        // with a stable stop/request identity. It is stored even when the caller
        // also answers synchronously, so a lost caller response cannot lose the
        // wake. An already-confirmed stop (a replay) never notifies again.
        if(worker && worker.terminalId && !alreadyConfirmed && !prior.noticeId &&
           this.store.task(worker.taskId)?.status === 'active'){
          const id = `stopped-${digest(`${workerId}:${stopId ?? 'direct'}`).slice(0,32)}`;
          const text = outcome === 'already-exited'
            ? `Herdr stop resolved for ${worker.name} (${worker.terminalId}): the original native process was already finished before any signal was dispatched, so this exit is reported as already-exited, not as a deliberate stop. Terminal history is preserved (read it with the native read tool) and later input is refused. This is not a runtime fault and not an acceptance result; do not restart the agent automatically.`
            : outcome === 'unattributed'
            ? `Herdr stop for ${worker.name} (${worker.terminalId}): the original native process was observed exited, but no signal dispatch was proven (the stop was refused or its outcome was uncertain). Causation is not attributed to the stop. Terminal history is preserved (read it with the native read tool) and later input is refused. Inspect the terminal and task before recovering; do not restart the agent automatically.`
            : `Herdr intentional stop confirmed for ${worker.name} (${worker.terminalId}). The original native process exited after a deliberate stop. Terminal history is preserved (read it with the native read tool) and later input is refused. This is not a runtime fault and not an acceptance result; do not restart the agent automatically.`;
          this.store.ingest(worker,{id,taskId:worker.taskId,workerId,terminalId:worker.terminalId,
            kind:'attention',turn:Number.isSafeInteger(turn)?turn:0,createdAt:confirmedAt,
            attention:{reason:outcome==='already-exited'?'already_exited':outcome==='unattributed'?'unattributed_exit':'intentional_stop',
              workerId,terminalId:worker.terminalId,attribution:outcome,confirmed:true},
            text},{lifecycle:true});
          stop.noticeId = id;
        }
      }
      this.store.meta('stop:'+workerId, stop);
      if(!request) return null;
      if(['sent','failed','queued','delivered'].includes(request.state))
        return {...request, retirement: this.retirementOutcome(workerId)};
      const details = {
        delivery: !confirmed ? 'stop-requested'
          : outcome === 'intentional' ? 'confirmed-stopped'
          : outcome === 'already-exited' ? 'already-exited' : 'unattributed-exit',
        stop: {confirmed, gone: Boolean(gone && !confirmed), reason: reason ?? null, observedBy: observedBy ?? null,
          attribution: confirmed ? outcome : null, note: prior.note ?? null},
        ...(receipt != null ? {nativeReceipt: receipt} : {}),
        ...(error ? {error: String(error.message ?? error).slice(0, 500)} : {}),
        note: !confirmed
          ? 'Stop intent recorded but the original process exit is not yet confirmed'
            + (gone ? ' (the terminal is no longer visible, which is not proof of exit)' : '')
            + '. Retry the same request ID to confirm before any later input.'
          : outcome === 'already-exited'
          ? 'Stop resolved: the original native process was already finished before any signal was dispatched, so this exit is reported as already-exited, not as a deliberate stop. Terminal history is preserved and later input is refused.'
          : outcome === 'unattributed'
          ? 'Stop request could not be attributed: the original process exited, but no signal dispatch was proven. Terminal history is preserved; inspect before recovering.'
          : 'Intentional stop confirmed; the original native process exited. Terminal history is preserved and later input is refused.'};
      // A bridge observation may arrive before the stop request is claimed; keep
      // it claimable so the CLI path can still confirm the exit. A claimed but
      // unconfirmed stop stays `uncertain` so it blocks later input.
      const state = confirmed ? 'sent' : (request.state === 'prepared' ? 'prepared' : 'uncertain');
      const saved = this.save({...request, ...details, state, updatedAt: now()});
      // The retirement outcome is DERIVED, never persisted onto the request row:
      // a later replay recomputes it from the current durable retirement record
      // and writer-lease table, so it can never go stale.
      return {...saved, retirement: this.retirementOutcome(workerId)};
    });
  }
  // Compact, additive retirement outcome attached to a stop receipt. It is
  // DERIVED from the current durable retirement record and the live writer-lease
  // table on every call, so a same-key replay reports the up-to-date facts (for
  // example a later manager clearance that released ownership) without
  // re-signalling or re-settling anything. `writerLeaseHeld` is the actual lease
  // table, not an inferred value, and `coverage` is only ever the coverage the
  // stored record holds -- it never fabricates complete descendant coverage.
  retirementOutcome(workerId) {
    const record = this.retirement?.record?.(workerId) ?? null;
    const writerLeaseHeld = this.store.writerLeases().some(lease => lease.workerId === workerId);
    const coverage = record?.clearance?.coverage ?? record?.coverage ?? null;
    return { state: record?.state ?? null, reason: record?.reason ?? null, writerLeaseHeld,
      ...(coverage ? { coverage } : {}) };
  }
  // Local, durable cancellation of an UNCLAIMED outbound operation.
  //
  // This is bookkeeping only: it never signals, kills, re-parents or otherwise
  // touches a native process, never releases writer ownership and never closes a
  // task. It retires exactly the operations that have NOT yet reached a
  // carrier:
  //   * a `prepared` ordinary request no worker has claimed, and
  //   * a `queued` durable note no carrier has claimed (`!claimedBy`).
  // Anything already handed to a carrier (`sending`, `uncertain`, `attached`,
  // `sent`, `delivered`) is refused, because the carrier may still act on it.
  // The lifecycle controls (`stop`/`interrupt`) are refused BEFORE any other
  // check: their truth is re-observed against the original native identity and
  // can never be cleared by a local edit.
  //
  // The transition preserves the original payload and every receipt and changes
  // only `state`, `disposition{dispositionId,reason,by,at}` and `updatedAt`. The
  // target request is bound by `(workerId, requestId)`; the disposition is a
  // SEPARATE idempotency identity. One disposition identity retires one row
  // exactly once; an exact replay returns the recorded row and any other
  // disposition conflicts. `expectedState` is the atomic compare-and-set the
  // caller observed and must still hold inside this transaction.
  cancel(workerId, requestId, {reason, expectedState, dispositionId = null, by = null} = {}) {
    if(typeof reason!=='string'||!reason.trim()) throw new Error('Cancellation requires a non-empty reason');
    if(typeof expectedState!=='string'||!expectedState) throw new Error('Cancellation requires the caller-observed expected state');
    // `by` is the EXACT owner manager chat. It is mandatory so the public
    // surface can never record an unattributed disposition, and it is
    // re-checked below against the worker's CURRENT task thread inside the
    // transaction (not merely trusted from the caller).
    if(typeof by!=='string'||!by.trim()) throw new Error('Cancellation requires the exact owner manager chat');
    if(dispositionId !== null) safeId(dispositionId,'disposition ID');
    return this.store.transaction(()=>{
      // Ownership and worker/task binding are re-read inside the SAME
      // transaction as the CAS. The caller's precheck is therefore only an
      // early refusal: a task rebound to another chat between the precheck and
      // this commit still cannot authorize the mutation, because the worker's
      // current task thread must equal the caller's chat and the request must
      // still belong to that same task.
      const worker=this.store.worker(workerId);
      if(!worker) throw new Error('Unknown agent');
      const task=this.store.task(worker.taskId);
      if(!task||task.threadId!==by) throw new Error('Not your request');
      const request=this.get(workerId,requestId);
      if(!request) throw new Error('Unknown request');
      if(request.taskId!==worker.taskId) throw new Error('Not your request');
      // Lifecycle exclusion FIRST and unconditionally: a stop/interrupt is only
      // ever resolved by re-observing the original terminal, never by a local
      // state edit.
      if(request.kind==='stop'||request.kind==='interrupt')
        throw new Error('Lifecycle controls are resolved by re-observing the original terminal; they cannot be cancelled');
      // Stable replay/conflict. A cancelled row is inert; only the SAME
      // disposition identity with the SAME reason is an idempotent replay.
      if(request.state==='cancelled') {
        const prior=request.disposition;
        if(prior&&dispositionId!==null&&prior.dispositionId===dispositionId&&prior.reason===reason) return request;
        throw new Error('Request is already cancelled; inspect the recorded disposition instead of repeating the cancel');
      }
      // Atomic compare-and-set: the caller's observation must still hold here.
      if(request.state!==expectedState)
        throw new Error(`Request state changed; expected ${expectedState} but found ${request.state}`);
      // Eligibility truth table. Only an unclaimed prepared ordinary request or
      // an unclaimed queued note can be retired locally.
      const eligible = request.state==='prepared' ||
        (request.state==='queued' && request.kind==='message' && !request.claimedBy);
      if(!eligible) {
        // `claimedBy` persists after a carrier finishes, so only treat it as a
        // LIVE carrier while the claim is genuinely in flight/attached. A
        // delivered or sent row must not be misreported as a live claim.
        const claimedInFlight = Boolean(request.claimedBy) && ['sending','uncertain','attached'].includes(request.state);
        if(claimedInFlight)
          throw new Error('Request is already claimed by a live carrier; cancellation is refused');
        throw new Error(`Request in state ${request.state} cannot be cancelled locally; it has reached or is being handed to the carrier`);
      }
      const at=now();
      const saved=this.save({...request,state:'cancelled',
        disposition:{dispositionId,reason,by,at},updatedAt:at});
      this.store.journal('agent.request.cancelled',{workerId,taskId:request.taskId,requestId,kind:request.kind,
        from:request.state,dispositionId,reason,by});
      return saved;
    });
  }
  reconcile(workerId, requestId, evidence) {
    if(typeof evidence!=='string'||!evidence.trim()) throw new Error('Reconciliation requires actual delivery evidence');
    const request=this.get(workerId,requestId);
    if(!request) throw new Error('Unknown request');
    // Lifecycle controls must be re-observed against the original native
    // identity, not cleared by free-text evidence. Otherwise a still-working
    // turn could have its unresolved barrier lifted without proof it stopped.
    // Retry the same request_id with `interrupt`/`stop` to re-observe.
    if(request.kind==='interrupt'||request.kind==='stop')
      throw new Error('Lifecycle controls are resolved by re-observing the original terminal; retry the same request ID instead of reconciling by text');
    // A normal `sent` record only claimed native injection. Explicit operator
    // evidence can upgrade it to `confirmed` without a new native send.
    if(request.state==='sent') return this.store.transaction(()=>{
      const saved=this.save({...request,delivery:'confirmed',reconciliation:evidence,updatedAt:now()});
      this.store.journal('agent.request.confirmed',{workerId,taskId:request.taskId,requestId,kind:request.kind});
      return saved;
    });
    return this.finish(workerId,requestId,'sent',{reconciliation:evidence,delivery:'confirmed'});
  }
}
