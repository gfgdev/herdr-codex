import {randomUUID} from 'node:crypto';
import {watch,existsSync} from 'node:fs';
import {join} from 'node:path';
import {plainPath} from './desk-files.mjs';
import {Desks} from './desks.mjs';
import {digest,safeId} from './config.mjs';

const activeClaims=new Set();
const unsettled=new Set(['pending','running','blocked','review']);
const terminal=new Set(['dispatched','skipped','disabled']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
function payload(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Trigger payload must be a JSON object');
  const seen=new Set();const visit=(v,depth=0)=>{if(depth>24)throw new Error('Trigger payload is too deeply nested');if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;if(typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw new Error('Trigger payload must contain finite JSON values');seen.add(v);for(const [key,item]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('Reserved trigger payload field');visit(item,depth+1);}};
  visit(value);const json=JSON.stringify(canonical(value));if(Buffer.byteLength(json)>262144)throw new Error('Trigger payload exceeds 256 KiB');return JSON.parse(json);
}
function liveClaim(claim){
  if(!claim)return false;if(claim.pid===process.pid)return activeClaims.has(claim.token);
  try{process.kill(claim.pid,0);return true;}catch(error){return error.code==='EPERM';}
}
const identity=a=>`${a.deskId}/${a.id}@${a.version}`;

/** Deterministic service-side triggers. No Codex polling and no model calls. */
export class DeskTriggers{
  constructor({store,config,createRun,clock=()=>Date.now(),onError=()=>{},watchFactory=watch}){
    if(typeof createRun!=='function')throw new Error('DeskTriggers requires createRun');
    this.store=store;this.config=config;this.db=store.db;this.desks=new Desks({store,config});this.createRun=createRun;this.clock=clock;this.onError=onError;this.instanceId=randomUUID();this.started=false;this.timer=null;this.running=null;this.generation=0;this.watchers=new Map();this.watchErrors=new Map();this.watchFactory=watchFactory;this.requestedPulseAt=null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS desk_trigger_occurrences(id TEXT PRIMARY KEY,desk_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_trigger_events(desk_id TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(desk_id,id));
      CREATE TABLE IF NOT EXISTS desk_trigger_cursors(identity TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_trigger_health(desk_id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  }
  _now(){const value=this.clock();if(!Number.isFinite(value))throw new Error('Trigger clock must return finite epoch milliseconds');return value;}
  _get(id){const row=this.db.prepare('SELECT data FROM desk_trigger_occurrences WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
  _save(value){this.db.prepare('INSERT INTO desk_trigger_occurrences VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,value.deskId,JSON.stringify(value));return value;}
  _all(deskId){return (deskId?this.db.prepare('SELECT data FROM desk_trigger_occurrences WHERE desk_id=? ORDER BY rowid').all(deskId):this.db.prepare('SELECT data FROM desk_trigger_occurrences ORDER BY rowid').all()).map(row=>JSON.parse(row.data));}
  _error(error,context){try{this.onError(error,context);}catch{};}
  _catalog(){
    const catalog=new Map();
    for(const desk of this.desks.list()){
      let definitions=[],error=null;
      try{
        if(desk.status==='active'){
          const files=this.desks.files.registration(desk.id)?.enabled?this.desks.files.sync(desk.id):null;
          definitions=files?Object.entries(files.automations??{}).map(([id,version])=>this.desks.automation(desk.id,id,version)):[...new Map(this.desks.automations(desk.id).map(a=>[a.id,a])).values()];
          for(const a of definitions)if(a.enabled){if(!a.ownerThread)throw new Error('Enabled trigger is missing ownerThread');catalog.set(identity(a),a);}
        }
      }catch(e){error=e.message;const prior=this.db.prepare('SELECT data FROM desk_trigger_health WHERE desk_id=?').get(desk.id);if(!prior||JSON.parse(prior.data).error!==error)this._error(e,{deskId:desk.id,phase:'configuration'});}
      const health={deskId:desk.id,at:this._now(),error,automations:error?[]:definitions.map(a=>({id:a.id,version:a.version,type:a.type,enabled:a.enabled})),active:desk.status==='active'};
      this.db.prepare('INSERT INTO desk_trigger_health VALUES(?,?) ON CONFLICT(desk_id) DO UPDATE SET data=excluded.data').run(desk.id,JSON.stringify(health));
    }
    return catalog;
  }
  _occurrence(automation,{kind,eventId=null,slot=null,missedCount=0,data={}}){
    const key=JSON.stringify([identity(automation),kind,eventId??slot]),id='dt-'+digest(key).slice(0,40),old=this._get(id);if(old)return old;
    const value={id,jobId:id,deskId:automation.deskId,automationId:automation.id,automationVersion:automation.version,workflowId:automation.workflowId,workflowVersion:automation.workflowVersion,ownerThread:automation.ownerThread,kind,eventId,slot,missedCount,overlap:automation.overlap,status:'pending',attempts:0,createdAt:this._now(),updatedAt:this._now(),nextAttemptAt:0,parameters:{payload:data,trigger:{automationId:automation.id,automationVersion:automation.version,kind,eventId,slot,missedCount}}};
    this._save(value);this.store.journal('desk.trigger.occurrence',{deskId:value.deskId,id,automationId:value.automationId,kind,missedCount});return value;
  }
  _intervals(catalog){
    const at=this._now();this.store.transaction(()=>{
      for(const automation of catalog.values())if(automation.type==='interval'){
        const base=Date.parse(automation.startAt??automation.createdAt),duration=automation.everySeconds*1000,slot=Math.floor((at-base)/duration);if(slot<0)continue;
        const key=identity(automation),row=this.db.prepare('SELECT data FROM desk_trigger_cursors WHERE identity=?').get(key),prior=row?JSON.parse(row.data):null;
        if(prior&&slot<=prior.slot)continue;
        const missedCount=slot-(prior?.slot??-1)-1;
        // An interval is a current-state procedure. Downtime creates one latest
        // occurrence, never an unbounded burst of historical runs.
        this._occurrence(automation,{kind:'interval',slot,missedCount});
        this.db.prepare('INSERT INTO desk_trigger_cursors VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data').run(key,JSON.stringify({slot,at,missedCount}));
      }
    });
  }
  _claim(occurrence,catalog){
    return this.store.transaction(()=>{
      const current=this._get(occurrence.id);if(!current||terminal.has(current.status)||current.nextAttemptAt>this._now()||liveClaim(current.claim))return null;
      const automation=catalog.get(`${current.deskId}/${current.automationId}@${current.automationVersion}`);
      const health=this.db.prepare('SELECT data FROM desk_trigger_health WHERE desk_id=?').get(current.deskId);
      // Invalid authored files block dispatch without discarding the intent.
      if(health&&JSON.parse(health.data).error)return null;
      if(!automation){
        const job=this.desks.job(current.deskId,current.jobId);current.status=job?'dispatched':'disabled';current.note=job?'Existing job retained after trigger configuration changed.':'Trigger is disabled, removed or superseded.';current.updatedAt=this._now();delete current.claim;this._save(current);return null;
      }
      const ownJob=this.desks.job(current.deskId,current.jobId);
      const active=this.desks.jobs(current.deskId).filter(job=>job.workflowId===current.workflowId&&job.id!==current.jobId&&unsettled.has(job.status));
      // Also serialize accepted trigger intents across simultaneous service
      // instances before createRun has inserted its job record.
      const earlier=this._all(current.deskId).some(other=>other.id!==current.id&&other.workflowId===current.workflowId&&(other.status==='dispatching'&&liveClaim(other.claim)));
      if(!ownJob&&(active.length||earlier)){current.status=current.overlap==='skip'?'skipped':'queued';current.note=current.overlap==='skip'?'Skipped because this workflow already has unsettled work.':'Queued behind unsettled workflow work.';current.updatedAt=this._now();delete current.claim;this._save(current);return null;}
      const token=randomUUID();activeClaims.add(token);current.status='dispatching';current.attempts++;current.updatedAt=this._now();current.claim={token,pid:process.pid,instanceId:this.instanceId,at:this._now()};this._save(current);return current;
    });
  }
  async _dispatch(occurrence,catalog){
    const claimed=this._claim(occurrence,catalog);if(!claimed)return;
    try{
      const result=await this.createRun({deskId:claimed.deskId,id:claimed.jobId,workflowId:claimed.workflowId,workflowVersion:claimed.workflowVersion,ownerThread:claimed.ownerThread,parameters:claimed.parameters});
      this.store.transaction(()=>{const current=this._get(claimed.id);if(current?.claim?.token!==claimed.claim.token)return;current.status='dispatched';current.updatedAt=this._now();current.note='Run accepted with its stable occurrence ID.';current.result={id:result?.id??claimed.jobId,status:result?.status??null};delete current.claim;delete current.error;this._save(current);this.store.journal('desk.trigger.dispatched',{deskId:current.deskId,id:current.id,jobId:current.jobId,attempt:current.attempts});});
    }catch(error){
      this.store.transaction(()=>{const current=this._get(claimed.id);if(current?.claim?.token!==claimed.claim.token)return;current.status='pending';current.updatedAt=this._now();current.nextAttemptAt=this._now()+1000;current.error=String(error.message??error).slice(0,8192);delete current.claim;this._save(current);});if(claimed.error!==String(error.message??error).slice(0,8192))this._error(error,{deskId:claimed.deskId,id:claimed.id,phase:'dispatch'});
    }finally{activeClaims.delete(claimed.claim.token);}
  }
  _refreshWatchers(){
    if(!this.started)return;const wanted=new Set();
    for(const desk of this.desks.list()){const registration=this.desks.files.registration(desk.id);if(desk.status!=='active'||!registration?.enabled)continue;const path=join(registration.root,'automations');
      try{plainPath(path);if(!existsSync(path))continue;wanted.add(path);if(this.watchers.has(path))continue;const watcher=this.watchFactory(path,()=>{if(!this.started)return;this.requestedPulseAt=this._now()+25;this._schedule();});this.watchErrors.delete(path);watcher.on('error',error=>{this.watchErrors.set(path,error.message);this._error(error,{deskId:desk.id,phase:'watch'});watcher.close();this.watchers.delete(path);});watcher.unref?.();this.watchers.set(path,watcher);}catch(error){this.watchErrors.set(path,error.message);this._error(error,{deskId:desk.id,phase:'watch'});}
    }
    for(const [path,watcher] of this.watchers)if(!wanted.has(path)){watcher.close();this.watchers.delete(path);}
  }
  async pulse(){
    if(this.running)return this.running;
    this.requestedPulseAt=null;this._refreshWatchers();
    const generation=this.generation;
    this.running=(async()=>{const catalog=this._catalog();this._intervals(catalog);for(const occurrence of this._all()){if(generation!==this.generation)break;if(!terminal.has(occurrence.status))await this._dispatch(occurrence,catalog);}return {occurrences:this._all().length,enabled:catalog.size};})();
    try{return await this.running;}finally{this.running=null;if(this.started)this._schedule();}
  }
  async emit(input){
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['deskId','id','eventName','payload','automationId'].includes(key)))throw new Error('Unknown Desk event field');
    const deskId=safeId(input.deskId,'desk ID'),id=safeId(input.id,'event ID');this.desks.require(deskId,{active:true});
    const automationId=input.automationId===undefined?null:safeId(input.automationId,'automation ID');
    if(!automationId&&(typeof input.eventName!=='string'||!input.eventName.trim()||input.eventName.includes('\0')||input.eventName.length>256))throw new Error('Event needs eventName, or automationId for a manual trigger');
    if(automationId&&input.eventName!==undefined)throw new Error('Use automationId for manual invocation or eventName for an event, not both');
    const data=payload(input.payload),eventName=input.eventName??null,fingerprint=digest(JSON.stringify({eventName,automationId,payload:data}));
    const catalog=this._catalog();
    const result=this.store.transaction(()=>{
      const old=this.db.prepare('SELECT fingerprint,data FROM desk_trigger_events WHERE desk_id=? AND id=?').get(deskId,id);
      if(old){if(old.fingerprint!==fingerprint)throw new Error('Event ID already has different payload or routing');return JSON.parse(old.data);}
      const health=JSON.parse(this.db.prepare('SELECT data FROM desk_trigger_health WHERE desk_id=?').get(deskId).data);if(health.error)throw new Error('Desk trigger configuration is invalid: '+health.error);
      const matches=[...catalog.values()].filter(a=>a.deskId===deskId&&(automationId?a.type==='manual'&&a.id===automationId:a.type==='event'&&a.eventName===eventName));
      if(automationId&&!matches.length)throw new Error('Unknown or disabled manual automation');
      const occurrences=matches.map(a=>this._occurrence(a,{kind:automationId?'manual':'event',eventId:id,data}).id),receipt={deskId,id,eventName,automationId,payload:data,occurrences,createdAt:this._now()};
      this.db.prepare('INSERT INTO desk_trigger_events VALUES(?,?,?,?)').run(deskId,id,fingerprint,JSON.stringify(receipt));return receipt;
    });
    // If another pulse already runs it may have taken its occurrence snapshot.
    // Finish it, then explicitly dispatch this event's newly persisted intent.
    if(this.running)await this.running;await this.pulse();return result;
  }
  _schedule(){
    if(this.timer)clearTimeout(this.timer);this.timer=null;if(!this.started)return;
    const at=this._now(),due=this.requestedPulseAt===null?[]:[this.requestedPulseAt];
    for(const desk of this.desks.list()){
      const row=this.db.prepare('SELECT data FROM desk_trigger_health WHERE desk_id=?').get(desk.id);if(!row)continue;const health=JSON.parse(row.data);
      if(health.error){due.push(at+1000);continue;}
      for(const summary of health.automations)if(summary.enabled&&summary.type==='interval'){
        const a=this.desks.automation(desk.id,summary.id,summary.version),base=Date.parse(a.startAt??a.createdAt),duration=a.everySeconds*1000;due.push(base>at?base:base+(Math.floor((at-base)/duration)+1)*duration);
      }
    }
    for(const occurrence of this._all())if(!terminal.has(occurrence.status))due.push(Math.max(at+1000,occurrence.nextAttemptAt??0));
    if(!due.length)return;const delay=Math.max(1,Math.min(2147483647,Math.min(...due)-at));
    this.timer=setTimeout(()=>{this.timer=null;this.pulse().catch(error=>{this._error(error,{phase:'timer'});if(this.started)this._schedule();});},delay);this.timer.unref?.();
  }
  start(){if(this.started)return this.running??Promise.resolve();this.started=true;return this.pulse();}
  stop(){this.started=false;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=null;this.requestedPulseAt=null;for(const watcher of this.watchers.values())watcher.close();this.watchers.clear();}
  status(deskId){
    this.desks.require(deskId);const row=this.db.prepare('SELECT data FROM desk_trigger_health WHERE desk_id=?').get(deskId),all=this._all(deskId),counts={};for(const occurrence of all)counts[occurrence.status]=(counts[occurrence.status]??0)+1;
    const directory=this.desks.files.registration(deskId)?.root;const watchPath=directory?join(directory,'automations'):null;
    return {deskId,started:this.started,timerScheduled:Boolean(this.timer),watchedAutomationDirectories:watchPath&&this.watchers.has(watchPath)?1:0,watchErrors:Object.fromEntries([...this.watchErrors].filter(([path])=>path===watchPath)),health:row?JSON.parse(row.data):null,counts,occurrences:all.slice(-200),note:'Service timers do deterministic scheduling only. Agent work and Codex wake delivery use their existing event channels.'};
  }
}
