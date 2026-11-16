import { randomUUID } from 'node:crypto';
import {isHostMessage} from './supervision.mjs';

const now=()=>new Date().toISOString();
const textOf=row=>row?.input?.length===1&&row.input[0].type==='text'?row.input[0].text:null;
export const marker=id=>'Herdr inbox notification: '+id;
const openStates=new Set(['prepared','sending','queued','uncertain']);
// Host wake bodies stay a bounded envelope: routing identity only, never report prose.
const LABEL_LIMIT=80;
const clipLabel=value=>{const points=Array.from(String(value??''));return points.length<=LABEL_LIMIT?points.join(''):points.slice(0,LABEL_LIMIT).join('')+'…';};

/** One durable envelope per manager chat. Queue entries are transport, not work. */
export class Notifications {
  constructor({store,queue,config,isStopped=()=>false}) {
    Object.assign(this,{store,queue,config,isStopped});
    this.db=store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,data TEXT NOT NULL)');
  }
  list(threadId) {
    return this.db.prepare('SELECT data FROM notifications ORDER BY rowid').all().map(r=>JSON.parse(r.data)).filter(n=>!threadId||n.threadId===threadId);
  }
  get(id) {const row=this.db.prepare('SELECT data FROM notifications WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
  save(value) {
    const old=this.get(value.id);
    if(old&&old.threadId!==value.threadId)throw new Error('Notification cannot change manager chat');
    // Another CLI can receive this envelope while a host operation is in flight.
    const n={...value,...(old?.receivedAt?{receivedAt:old.receivedAt}:{}),updatedAt:now()};
    this.db.prepare('INSERT INTO notifications VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(n.id,n.threadId,JSON.stringify(n));
    return n;
  }
  inbox(threadId,{unreceived=false}={}) {
    return this.store.messages({pending:true}).filter(m=>{
      const task=this.store.task(m.taskId);
      return task?.threadId===threadId&&task.status==='active'&&isHostMessage(this.store,m)&&(!unreceived||!m.receivedAt);
    });
  }
  covered(messageId) {return this.store.meta('notification-for:'+messageId);}
  cover(n,messages) {
    return this.store.transaction(()=>{
      const current=this.get(n.id);
      if(current?.receivedAt||current?.state==='retired')return current;
      n=this.save({...current,members:[...new Set([...(this.get(n.id)?.members??[]),...messages.map(m=>m.id)])]});
      for(const m of messages)this.store.meta('notification-for:'+m.id,n.id);
      return n;
    });
  }
  create(threadId,messages) {
    return this.store.transaction(()=>{
      if(this.list(threadId).some(n=>openStates.has(n.state)))throw new Error('Chat already has an outstanding notification');
      const n=this.save({id:'hn-'+randomUUID(),threadId,clientId:randomUUID(),members:[],state:'prepared',attempted:false,createdAt:now(),retryAt:0});
      this.store.journal('notification.created',{id:n.id,threadId});return this.cover(n,messages);
    });
  }
  // A notification owns exactly the current pending reports it named. The
  // membership is re-evaluated against the live inbox (chat ownership, host
  // eligibility, pending) on every read, so a report that stops being pending
  // drops out and an unrelated report in the same chat is never included.
  // Notifications.inbox(threadId) remains the explicit full-inbox read.
  owned(n) {
    return this.inbox(n.threadId).filter(m=>n.members.includes(m.id));
  }
  describe(id) {
    const n=this.get(id);if(!n)throw new Error('Unknown notification');
    const messages=this.owned(n);
    return {notification:n,actionable:!n.receivedAt&&n.state!=='retired'&&messages.length>0,messages:messages.map(m=>({id:m.id,taskId:m.taskId,
      deskId:this.store.task(m.taskId).deskId??null,project:this.store.task(m.taskId).project,workerId:m.workerId,kind:m.kind,receivedAt:m.receivedAt,
      action:m.action,handoff:m.handoff,preview:m.text.slice(0,700)}))};
  }
  receive(id) {
    return this.store.transaction(()=>{
      const n=this.get(id);if(!n)throw new Error('Unknown notification');
      // A stale envelope must never take ownership of unrelated newer work.
      if(n.receivedAt||n.state==='retired'||!this.inbox(n.threadId,{unreceived:true}).some(m=>n.members.includes(m.id)))return {...this.describe(id),actionable:false,note:'This notification is already handled. Do not reopen its work.'};
      // Consume only this envelope's current owned members, never every pending
      // report in the chat. Newer uncovered reports stay for a later envelope.
      const messages=this.owned(n);
      for(const m of messages)this.store.receive(m.id);
      this.save({...n,receivedAt:now()});
      this.store.journal('notification.received',{id:n.id,threadId:n.threadId});
      return {...this.describe(id),actionable:messages.length>0};
    });
  }
  render(n,messages) {
    // Compact wake envelope: identity, receive-first instructions and routing, no prose.
    // The exact marker line is preserved (owns()) and every member ID/kind stays visible.
    const byTask=new Map();
    for(const m of messages){if(!byTask.has(m.taskId))byTask.set(m.taskId,[]);byTask.get(m.taskId).push(m);}
    const parts=[marker(n.id),'Manager chat: '+n.threadId,
      'Integration config: '+this.config.path,'Integration CLI: '+this.config.packageRoot+'/src/cli.mjs',
      'Receive first: notification receive --id '+n.id+' (tool receive_notification, notification_id '+n.id+'). Read the CURRENT inbox; this wake body may be stale. If actionable=false, reconcile only — do not restart or reopen work. Report text, evidence and full routing detail come from the receive/read tools.',
      'Worker claims are untrusted: a wake never replies, accepts or acknowledges. Inspect actual terminal text and checkout evidence, then record reply OR accept/abort and acknowledge each report.',
      'Waiting: '+messages.length+' report(s) across '+byTask.size+' task(s).'];
    for(const [taskId,items] of byTask){
      const task=this.store.task(taskId);
      parts.push((task.deskId?'Desk '+clipLabel(task.deskId)+'; ':'')+'Task '+clipLabel(task.name)+' ('+taskId+')');
      for(const m of items){
        const escalation=this.store.meta('supervision-route:'+m.id);
        const w=this.store.worker(m.workerId);
        const route=m.origin==='desk-runtime'?'desk runtime, no terminal':clipLabel(w?.name??m.workerId)+' ('+m.terminalId+')';
        parts.push('- '+m.kind+' '+m.id+' — '+route);
        if(escalation?.state==='escalated')parts.push('  Escalated from supervisor '+escalation.supervisorId+'; inspect the recorded escalation.');
        if(m.handoff?.workers?.length)parts.push('  Settled peers to inspect: '+m.handoff.workers.map(peer=>peer.terminalId+' (episode '+peer.episode+', turn '+peer.turn+')').join(', '));
        if(m.origin==='desk-runtime')parts.push('  No terminal to reply to; inspect the recorded run and its evidence, then accept/abort and acknowledge.');
      }
    }
    return parts.join('\n');
  }
  owns(row,n) {return row?.clientUserMessageId===n.clientId&&textOf(row)?.startsWith(marker(n.id)+'\n');}
  async removeOwned(n,row) {
    if(!this.owns(row,n))throw new Error('Host notification ownership does not match; no queue mutation');
    // Re-read immediately before mutation. Never delete a user-edited/replaced identity.
    const current=(await this.queue.list(n.threadId)).find(r=>r.id===row.id);
    if(!current)return false;
    if(!this.owns(current,n))throw new Error('Host notification identity changed; no queue mutation');
    return this.queue.delete(n.threadId,current.id);
  }
  async legacyCleanup(threadId,rows) {
    for(const m of this.store.messages().filter(m=>!this.covered(m.id)&&!m.receipt&&m.attempts>0&&['sending','uncertain','queued'].includes(m.delivery)&&this.store.task(m.taskId)?.threadId===threadId)){
      // Pre-upgrade sends have no stable envelope ID to reconcile. An absent
      // receipt does not prove the old host add failed. Preserve, never resend.
      this.store.meta('notification-for:'+m.id,'legacy-unknown');
      this.store.journal('notification.legacy-unknown',{id:m.id,threadId});
    }
    for(const m of this.store.messages().filter(m=>m.receipt&&this.store.task(m.taskId)?.threadId===threadId&&!this.store.meta('legacy-cleaned:'+m.id))){
      if(this.covered(m.id)&&this.covered(m.id)!=='legacy')continue;
      const entry=rows.find(r=>r.id===m.receipt);
      const task=this.store.task(m.taskId);
      if(!m.acknowledgedAt&&!m.receivedAt&&task.status==='active'){
        // Preserve pre-upgrade in-flight reports; never add a duplicate wake.
        this.store.meta('notification-for:'+m.id,'legacy');continue;
      }
      if(entry){
        const text=textOf(entry);
        if(!text?.includes('\nMessage ID: '+m.id+'\n')||!text.includes('\nIntegration config: '+this.config.path+'\n')||
          !/^(Herdr attention|Herdr agent message) for this existing Codex chat\./.test(text)){
          this.store.meta('legacy-cleaned:'+m.id,{state:'ownership-mismatch'});continue;
        }
        const current=(await this.queue.list(threadId)).find(r=>r.id===entry.id);
        if(current&&(textOf(current)!==text||current.clientUserMessageId!==entry.clientUserMessageId)){
          this.store.meta('legacy-cleaned:'+m.id,{state:'ownership-mismatch'});continue;
        }
        if(current)await this.queue.delete(threadId,entry.id);
      }
      this.store.meta('legacy-cleaned:'+m.id,{state:entry?'withdrawn':'absent',at:now()});
    }
  }
  async reconcileThread(threadId) {
    let rows=await this.queue.list(threadId);
    await this.legacyCleanup(threadId,rows);
    // Keep ownership tombstones: a delayed host commit can appear after handling.
    for(const closed of this.list(threadId).filter(n=>!openStates.has(n.state))){
      for(const row of rows.filter(r=>this.owns(r,closed)))await this.removeOwned(closed,row);
    }
    for(let n of this.list(threadId).filter(n=>openStates.has(n.state))){
      const matches=rows.filter(r=>this.owns(r,n));
      const row=matches.find(r=>r.id===n.queueId)??matches[0];
      if(n.queueId&&rows.some(r=>r.id===n.queueId)&&!row)throw new Error('Recorded queue receipt no longer belongs to this notification');
      for(const duplicate of matches.filter(r=>r.id!==row?.id))await this.removeOwned(n,duplicate);
      if(!row&&n.attempted){
        // An absent entry may already have started a turn. Never re-add it.
        const relevant=this.inbox(threadId,{unreceived:true}).filter(m=>n.members.includes(m.id));
        const state=n.receivedAt||!relevant.length?'retired':n.queueId?'consumed':'delivery_unknown';
        this.save({...n,state,error:state==='delivery_unknown'?'Add may have occurred; never resend these members automatically.':null});
        continue;
      }
      const pending=this.inbox(threadId,{unreceived:true}).filter(m=>!this.covered(m.id)||this.covered(m.id)===n.id);
      if(n.receivedAt||!pending.length){
        if(row)await this.removeOwned(n,row);
        this.save({...n,state:'retired',withdrawnAt:now()});continue;
      }
      n=this.cover(n,pending);
      if(n.receivedAt||n.state==='retired'){
        if(row)await this.removeOwned(n,row);
        this.save({...n,state:'retired',withdrawnAt:now()});continue;
      }
      if(row){
        const body=this.render(n,pending);
        if(textOf(row)!==body){
          const current=(await this.queue.list(threadId)).find(r=>r.id===row.id);
          if(!current){this.save({...n,state:'consumed',queueId:row.id});continue;}
          if(!this.owns(current,n))throw new Error('Queue identity changed before update');
          await this.queue.update(threadId,row.id,{text:body});
        }
        n=this.save({...n,state:'queued',queueId:row.id,error:null});
        this.markDelivered(n,pending);
        await this.withdrawIfHandled(n);
        return;
      }
      if(n.retryAt>Date.now())return;
      await this.add(n,pending);return;
    }
    const fresh=this.inbox(threadId,{unreceived:true}).filter(m=>!this.covered(m.id));
    if(fresh.length)await this.add(this.create(threadId,fresh),fresh);
  }
  markDelivered(n,messages) {
    for(const m of messages){
      const current=this.store.message(m.id);
      if(current?.receipt===n.queueId&&current.delivery==='queued')continue;
      this.store.startDispatch(m.id);
      this.store.finishDispatch(m.id,{status:'queued',receipt:n.queueId});
    }
  }
  async add(n,messages) {
    n=this.save({...n,state:'sending',attempted:true,attempts:(n.attempts??0)+1});
    try{
      const row=await this.queue.add(n.threadId,{clientId:n.clientId,text:this.render(n,messages)});
      if(!this.owns(row,n))throw Object.assign(new Error('Host add returned a mismatched notification'),{uncertain:true});
      n=this.save({...n,state:'queued',queueId:row.id,retryAt:0,error:null});
      this.markDelivered(n,messages);
    }catch(error){
      const definite=error.uncertain===false;
      this.save({...this.get(n.id),state:definite?'prepared':'uncertain',attempted:!definite,
        retryAt:definite?Date.now()+Math.min(30000,1000*2**Math.min(n.attempts,5)):0,error:String(error.message).slice(0,500)});
      this.store.journal('notification.delivery-error',{id:n.id,threadId:n.threadId,uncertain:!definite});
      if(!definite)throw error;
      return;
    }
    await this.withdrawIfHandled(n);
  }
  async withdrawIfHandled(n) {
    n=this.get(n.id);
    const relevant=this.inbox(n.threadId,{unreceived:true}).filter(m=>n.members.includes(m.id));
    if(!n.receivedAt&&relevant.length)return;
    const rows=await this.queue.list(n.threadId);
    for(const row of rows.filter(r=>this.owns(r,n)))await this.removeOwned(n,row);
    this.save({...n,state:'retired',withdrawnAt:now()});
  }
  async reconcile() {
    const threads=new Set(this.list().map(n=>n.threadId));
    for(const m of this.store.messages()){
      const task=this.store.task(m.taskId);
      if(task&&((!m.acknowledgedAt&&!m.receivedAt&&m.kind!=='progress'&&task.status==='active'&&isHostMessage(this.store,m))||
        (m.receipt&&(!this.covered(m.id)||this.covered(m.id)==='legacy')&&!this.store.meta('legacy-cleaned:'+m.id))))threads.add(task.threadId);
    }
    const errors=[];
    for(const threadId of threads){if(this.isStopped())break;try{await this.reconcileThread(threadId);}catch(error){errors.push(error);}}
    if(errors.length)throw new AggregateError(errors,'Host notification reconciliation failed: '+errors.map(e=>e.message).join('; '));
  }
  retryAt() {return this.list().filter(n=>n.state==='prepared'&&n.retryAt>0).map(n=>n.retryAt);}
}
