import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,openSync,readSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Desks} from './desks.mjs';
import {Delegation} from './delegation.mjs';
import {DeskCommands,renderInputs} from './desk-commands.mjs';
import {DeskTriggers} from './desk-triggers.mjs';
import {digest,safeId} from './config.mjs';
import {assertNativeWorker} from './routing.mjs';
import {recipeParameters} from './recipes.mjs';
import {Retirement,noCoverage,RETIREMENT,storedRetirement} from './retirement.mjs';

const now=()=>new Date().toISOString(),terminal=new Set(['completed','cancelled']);
// Canonical durable request states that are not yet terminally delivered or
// refused. `prepared`/`queued` are reserved durable-only rows, `sending` and
// `uncertain` are claimed-and-outstanding, and an `attached` note rides an
// in-flight delivery. None of these may be silently discarded by closing a task
// or completing a run; `sent`, `delivered` and `failed` are terminal.
const UNRESOLVED_REQUEST_STATES=new Set(['prepared','queued','sending','attached','uncertain']);
const key=(desk,id)=>'desk.run:'+desk+':'+id;
export function workflowSteps(job){return job.snapshot.workflow.steps??[{id:'main',kind:'agent',definitionId:job.snapshot.definition.id,definitionVersion:job.snapshot.definition.version,dependsOn:[],instructions:job.snapshot.workflow.instructions,acceptance:job.snapshot.workflow.acceptance}];}
export function artifactEvidence(workspace){
  const files=[];
  for(const root of [workspace?.outputs,workspace?.evidence].filter(Boolean)){
    const visit=path=>{if(!existsSync(path))return;const stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error('Evidence cannot follow symlinks');
      if(stat.isDirectory()){for(const name of readdirSync(path).sort())visit(join(path,name));return;}
      if(!stat.isFile())throw new Error('Unexpected evidence file');if(files.length>=1000)throw new Error('Evidence manifest exceeds 1000 files');
      const fd=openSync(path,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);try{for(let count;(count=readSync(fd,buffer,0,buffer.length,null));)hash.update(buffer.subarray(0,count));}finally{closeSync(fd);}
      files.push({path,bytes:stat.size,sha256:hash.digest('hex')});};visit(root);
  }return files;
}

/** Durable DAG execution. Only authored commands and recorded decisions settle steps. */
export class WorkflowRuns{
  constructor({store,config,rpc,pulse=async()=>{},delegationFactory=opts=>new Delegation(opts),commandsFactory=opts=>new DeskCommands(opts),onError=()=>{},retirement=null}){
    // ONE shared, conservative retirement service per runtime. The same instance
    // is threaded through every factory (see `launch`), so no caller can bypass
    // the guarded release point. When no service is injected the default is the
    // conservative `noCoverage` provider, never a raw writer release: a verified
    // exit alone cannot drop ownership without explicit descendant clearance.
    const service=retirement??new Retirement(store,{provider:config.containmentProvider??noCoverage,trustedSources:config.trustedContainmentSources??null});
    Object.assign(this,{store,config,rpc,notify:pulse,delegationFactory,commandsFactory,onError,retirement:service});
    this.desks=new Desks({store,config});this.stopped=false;this.chain=Promise.resolve();
    this.triggers=new DeskTriggers({store,config,createRun:input=>this.create(input),onError:(error,context)=>this.triggerError(error,context)});
  }
  // The single release funnel. Every verified exit funnels through the shared
  // retirement service, which retains writer ownership as `pending_retirement`
  // until descendant clearance is explicitly complete. There is deliberately no
  // raw-release fallback: a bare runtime still holds rather than dropping
  // ownership on parent-terminal-only evidence. `closeTask` composes the task
  // close into the same atomic release transaction.
  releaseOwnership(worker,observedExit,reason,closeTask=false){
    return this.retirement.settle({worker,observedExit,reason,closeTask});
  }
  // Every actionable report (question/result and, importantly, the lifecycle
  // `stopped-*` attention notice an intentional stop writes) must be surfaced
  // to the manager and cleared by a recorded action+ack. Nothing here is ever
  // silently acknowledged, erased or downgraded just to let a task close.
  actionableInbox(worker){return this.store.messages({taskId:worker.taskId,pending:true});}
  // Whether this database has the durable request table at all. A legacy
  // command-only database genuinely predates `agent_requests`; that exact
  // supported schema state means "no durable requests", and nothing else is
  // inferred from it. Every other query/read failure is surfaced below.
  requestTablePresent(){
    const row=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_requests'").get();
    return Boolean(row);
  }
  // Read the durable input requests bound to exactly this worker. WorkflowRuns
  // is a read-only observer of the shared Requests service: it never claims,
  // delivers, refuses or acknowledges anything, it only refuses to close over an
  // unresolved row. A missing table is the one supported "no requests" state; an
  // unexpected query/read/parse failure is returned as an explicit failure and is
  // NEVER downgraded to "no obligations".
  readRequests(workerId){
    let rows;
    try{
      if(!this.requestTablePresent())return {ok:true,records:[]};
      rows=this.store.db.prepare('SELECT data FROM agent_requests WHERE worker_id=? ORDER BY rowid').all(workerId);
    }catch(error){return {ok:false,error:'Could not read request records for worker '+workerId+': '+error.message};}
    const records=[];
    for(const [index,row] of rows.entries()){
      try{records.push(JSON.parse(row.data));}
      catch(error){return {ok:false,error:'Malformed request record for worker '+workerId+' at row '+(index+1)+': '+error.message};}
    }
    return {ok:true,records};
  }
  // Every outstanding, non-retirement obligation bound to this worker/task,
  // re-read from durable state: actionable lifecycle/report notices, registered
  // live descendants, unresolved input requests and an in-flight stop dispatch.
  // A bare `prepared` reservation is an obligation only once the worker actually
  // launched: a proven never-launched preparation failure abandons the
  // reservation (it was reserved but never claimed for delivery), which is the
  // accepted retryable-preparation-failure behavior.
  requestBlocks(worker,record){
    if(!UNRESOLVED_REQUEST_STATES.has(record.state))return false;
    if(record.state==='prepared')return Boolean(worker.terminalId);
    return true;
  }
  openObligations(worker){
    const notices=this.actionableInbox(worker).map(m=>m.id);
    const descendants=this.activeDescendants(worker).map(w=>w.id);
    const read=this.readRequests(worker.id);
    const requests=read.ok?read.records.filter(r=>this.requestBlocks(worker,r)).map(r=>({requestId:r.requestId,state:r.state,kind:r.kind})):[];
    const stop=this.store.meta('stop:'+worker.id);
    return {notices,descendants,requests,dispatching:stop?.dispatch==='dispatching',failure:read.ok?null:read.error};
  }
  holds(obligations){return Boolean(obligations.failure||obligations.notices.length||obligations.descendants.length||obligations.requests.length||obligations.dispatching);}
  // The one closure gate. Re-reads retirement release AND every outstanding
  // obligation and returns a structured, re-drivable hold instead of closing.
  // Returns null only when the task may legitimately close. `requireReleased`
  // is false only for the never-launched rollback, which composes its own
  // release immediately before asking whether the task may also close.
  closureHold(worker,{requireReleased=true}={}){
    const state=storedRetirement(this.store,worker.id)?.state??RETIREMENT.PENDING;
    const obligations={...this.openObligations(worker),retirement:state===RETIREMENT.RELEASED?null:state};
    if(requireReleased&&state!==RETIREMENT.RELEASED)return {retained:true,reason:'pending-retirement',retirement:state,pending:obligations.notices,obligations};
    if(!this.holds(obligations))return null;
    const reason=obligations.failure?'request-read-failed':obligations.notices.length?'pending-notices':obligations.requests.length?'pending-requests':obligations.descendants.length?'pending-descendants':'pending-stop';
    return {retained:true,reason,retirement:state,pending:obligations.notices,obligations};
  }
  // Close a task only through the gate, inside the transaction that writes the
  // close, so no late notice, descendant or undelivered request can slip past a
  // stale pre-check. Callers must honor the retained result and re-drive it.
  closeTask(worker){
    return this.store.transaction(()=>{
      // Re-read the exact worker/task binding inside the transaction that writes
      // the close. A caller-supplied worker may be missing, stale or foreign;
      // never report success and never close a task on an unverified binding.
      const current=worker?.id?this.store.worker(worker.id):null;
      if(!current)throw new Error('Cannot close task: no durable worker '+(worker?.id??'<unknown>'));
      if(!worker.taskId||current.taskId!==worker.taskId)throw new Error('Cannot close task: worker '+current.id+' is durably bound to task '+(current.taskId??'<none>')+', not '+(worker.taskId??'<none>'));
      const task=this.store.task(current.taskId);
      if(!task)throw new Error('Cannot close task: no durable task '+current.taskId+' for worker '+current.id);
      if(task.status==='closed')return {closed:true,workerId:current.id,taskId:current.taskId};
      const hold=this.closureHold(current);if(hold)return hold;
      const fresh=this.store.task(current.taskId);
      if(fresh&&fresh.status!=='closed')this.store.saveTask({...fresh,status:'closed',closedAt:now()});
      return {closed:true,workerId:current.id,taskId:current.taskId};
    });
  }
  // A cancellation is a run-level freeze. Once it is bound (or the run has
  // moved to a cancelling/cancelled status) no retry may overwrite it, no matter
  // what else has settled. Returns a short human reference or null.
  cancellationBound(run){
    if(!run)return null;
    if(run.cancellation)return 'cancellation '+run.cancellation.requestId;
    if(run.status==='cancelling'||run.status==='cancelled')return 'status '+run.status;
    return null;
  }
  get(deskId,id){this.desks.require(deskId);return this.store.meta(key(deskId,safeId(id)));}
  list(deskId){this.desks.require(deskId);return this.store.db.prepare('SELECT data FROM metadata WHERE key LIKE ? ORDER BY key').all('desk.run:'+deskId+':%').map(row=>JSON.parse(row.data));}
  save(run){const value={...run,updatedAt:now()};this.store.meta(key(run.deskId,run.id),value);this.store.journal('desk.run.updated',{deskId:run.deskId,id:run.id,status:run.status});return value;}
  async create({deskId,id,workflowId,workflowVersion,ownerThread,parameters={},projectId,workId}){
    if(!this.desks.files.registration(deskId)?.enabled)throw new Error('Structured workflows require a Desk template; run desk scaffold before starting work');
    const job=this.desks.jobCreate({deskId,id,workflowId,workflowVersion,ownerThread,parameters,projectId,workId});
    const old=this.get(deskId,id);if(old){this.store.transaction(()=>{if(job.status==='pending'&&!terminal.has(old.status))this.desks.jobUpdate(deskId,id,{status:old.status==='blocked'?'blocked':'running',note:'Recovered registered workflow after an interrupted registration.'});this.reconcileWork(old);});await this.notify();return {...old,reused:true};}
    const record=this.store.transaction(()=>{
      const concurrent=this.get(deskId,id);if(concurrent)return concurrent;
      const controlTaskId='dr-'+digest(deskId+':'+id).slice(0,28);
      this.store.saveTask({id:controlTaskId,name:'Workflow '+job.id,project:job.snapshot.project.path,threadId:job.ownerThread,deskId,deskProjectId:job.projectId,deskRunId:id,...(job.workId?{deskWorkId:job.workId}:{}),status:'active',createdAt:now()});
      const run=this.save({version:1,deskId,id,workflowId:job.workflowId,workflowVersion:job.workflowVersion,ownerThread:job.ownerThread,controlTaskId,workId:job.workId??null,status:'running',createdAt:now(),
        steps:Object.fromEntries(workflowSteps(job).map(step=>[step.id,{id:step.id,attempt:1,status:'pending'}]))});
      if(job.status==='pending')this.desks.jobUpdate(deskId,id,{status:'running',note:'Structured workflow registered; steps have not yet been accepted.'});
      if(job.workId)this.desks.workUpdate(deskId,job.workId,{ownerThread:job.ownerThread,taskId:controlTaskId,status:'running',note:'Workflow '+id+' is running; inspect its step state.'});
      return run;
    });
    await this.notify();return record;
  }
  reconcileWork(run){
    return this.store.transaction(()=>{
      const job=this.desks.job(run.deskId,run.id);if(!job?.workId)return;
      const work=this.desks.work(run.deskId,job.workId),task=this.store.task(run.controlTaskId);
      if(!work||task?.deskWorkId!==job.workId||work.taskId&&work.taskId!==run.controlTaskId||work.agentId){
        // Existing task identities are immutable. Earlier runs may have omitted
        // --work when creating their control task; never steal a legacy binding.
        const status=task?.deskWorkId!==job.workId?'legacy-unbound':'binding-conflict';
        if(run.workBinding?.status!==status){run.workBinding={status,workId:job.workId,note:'Work registration was not changed. Inspect the existing work and control-task identities before any explicit recovery.'};this.save(run);}
        return;
      }
      if(['done','cancelled'].includes(work.status))return;
      let status='running',note='Workflow '+run.id+' is running; inspect its step state.';
      if(run.status==='cancelled'){status='cancelled';note='Workflow '+run.id+' cancelled: '+run.cancellation.note;}
      else if(run.status==='blocked'){status='blocked';note='Workflow '+run.id+' is blocked; inspect step incidents and recorded evidence.';}
      else if(run.status==='completed'){
        const resultId='desk-result-'+digest(run.deskId+':'+run.id).slice(0,28),result=this.store.message(resultId),pending=this.store.messages({taskId:run.controlTaskId,pending:true});
        if(result?.action?.kind==='accept'&&result.acknowledgedAt&&!pending.length){status='done';note='Accepted consolidated workflow result '+resultId+' with recorded decision '+result.action.requestId+'.';}
        else if(result?.action?.kind==='abort'&&result.acknowledgedAt){status='blocked';note='Consolidated workflow result '+resultId+' was rejected; inspect decision '+result.action.requestId+' before planning further work.';}
        else{status='review';note='Workflow '+run.id+' executed all steps; consolidated result '+resultId+' awaits acceptance and acknowledgement.';}
      }else if(Object.values(run.steps).some(step=>step.status==='review')){status='review';note='Workflow '+run.id+' has step results awaiting accepted evidence.';}
      const patch={ownerThread:job.ownerThread,taskId:run.controlTaskId,status,note};
      this.desks.workUpdate(run.deskId,job.workId,patch);
    });
  }
  triggerError(error,context={}){
    this.onError(error,context);
    if(!context.deskId)return;
    const occurrence=context.id?this.triggers._get(context.id):null;
    const desk=this.desks.require(context.deskId),registration=this.desks.files.registration(desk.id),latest=new Map();
    if(registration?.enabled){
      // Invalid edits must not invent recipients, and removed authored entries
      // must not retain owners merely because old versions remain in history.
      for(const [id,version] of Object.entries(registration.automations??{})){const a=this.desks.automation(desk.id,id,version);if(a)latest.set(id,a);}
    }else for(const a of this.desks.automations(desk.id)){const prior=latest.get(a.id);if(!prior||a.version>prior.version)latest.set(a.id,a);}
    const owners=occurrence?.ownerThread?[occurrence.ownerThread]:[...new Set([...latest.values()].filter(a=>a.enabled&&a.ownerThread).map(a=>a.ownerThread))];
    const phase=context.phase??'runtime',scope=digest(JSON.stringify([desk.id,context.id??null,phase])).slice(0,32),metaKey='desk.triggerIncident:'+scope;
    this.store.transaction(()=>{
      const old=this.store.meta(metaKey),incident=old?.status==='active'?old:{version:1,scope,deskId:desk.id,occurrenceId:context.id??null,phase,episode:(old?.episode??0)+1,status:'active',openedAt:now(),messageIds:[]};
      incident.lastError=String(error.message??error).slice(0,4000);incident.lastObservedAt=now();
      for(const threadId of owners){
        const id='dt-error-'+digest(JSON.stringify([scope,incident.episode,threadId])).slice(0,28),taskId='dt-control-'+digest(desk.id+threadId).slice(0,26);
        if(this.store.message(id))continue;
        let task=this.store.task(taskId);if(!task){task={id:taskId,name:'Desk trigger attention',project:desk.home,threadId,deskId:desk.id,status:'active',createdAt:now()};this.store.saveTask(task);}
        this.store.ingestSystem(task,{id,taskId,workerId:'',terminalId:null,origin:'desk-runtime',kind:'attention',createdAt:now(),triggerIncident:{scope,episode:incident.episode,deskId:desk.id,occurrenceId:incident.occurrenceId,phase},text:'Desk '+desk.id+' trigger '+phase+' needs attention: '+incident.lastError+'. Inspect desk trigger-status and authored automation files. No agent is required to report this failure.'});
        incident.messageIds.push(id);
      }
      this.store.meta(metaKey,incident);
    });
  }
  resolveTriggerIncidents(){
    // Called only after a successful trigger pulse, whose health comes from
    // validated authored state. Old registry entries alone do not prove repair.
    const incidents=this.store.db.prepare("SELECT key,data FROM metadata WHERE key LIKE 'desk.triggerIncident:%'").all();
    for(const row of incidents){
      const incident=JSON.parse(row.data);if(incident.status!=='active')continue;
      const status=this.triggers.status(incident.deskId),health=status.health;if(!health||health.error)continue;
      const disabled=!health.active||!health.automations.some(a=>a.enabled);let reason=null;
      if(incident.occurrenceId){
        const occurrence=this.triggers._get(incident.occurrenceId);
        if(occurrence&&['dispatched','skipped','disabled'].includes(occurrence.status))reason='Trigger occurrence is '+occurrence.status+'.';
        else if(occurrence&&(!health.active||!health.automations.some(a=>a.id===occurrence.automationId&&a.version===occurrence.automationVersion&&a.enabled)))reason='Frozen trigger occurrence is disabled or superseded by validated configuration.';
      }else if(disabled)reason='Validated Desk trigger configuration has no enabled automation.';
      else if(incident.phase==='configuration')reason='Authored Desk trigger configuration validated successfully.';
      else if(incident.phase==='watch'&&status.watchedAutomationDirectories>0&&!Object.keys(status.watchErrors).length)reason='Authored automation directory watch recovered.';
      if(!reason)continue;
      this.store.transaction(()=>{
        const current=this.store.meta(row.key);if(current?.status!=='active'||current.episode!==incident.episode)return;
        const resolvedAt=now(),resolution={at:resolvedAt,reason,healthAt:health.at};
        this.store.meta(row.key,{...current,status:'resolved',resolution});
        for(const id of current.messageIds){
          const message=this.store.message(id);if(!message||message.action||message.acknowledgedAt)continue;
          // A queued wake cannot be retracted from the host; its receipt will
          // instead see the durable superseded action and reconcile only.
          this.store.recordAction(id,{kind:'superseded',requestId:'trigger-resolved:'+current.scope+':'+current.episode,text:reason});
          this.store.ack(id);this.store.db.prepare("UPDATE messages SET delivery='superseded' WHERE id=?").run(id);
        }
        this.store.journal('desk.trigger.resolved',{deskId:current.deskId,scope:current.scope,episode:current.episode,...resolution});
      });
    }
  }
  incident(run,stepId,error){
    const reason=String(error.message??error).slice(0,4000),id='desk-incident-'+digest([run.deskId,run.id,stepId,reason].join(':')).slice(0,28);
    const task=this.store.task(run.controlTaskId);
    this.store.ingestSystem(task,{id,taskId:task.id,workerId:'',terminalId:null,origin:'desk-runtime',kind:'attention',createdAt:now(),
      text:'Desk workflow '+run.id+' needs attention at '+stepId+'. '+reason+'\nInspect desk run-show and the frozen job. No worker was restarted automatically.'});
    return id;
  }
  variables(run,job){return {inputs:job.snapshot.parameters??job.parameters??{},project:job.snapshot.project.path,node:this.config.node,
    steps:Object.fromEntries(Object.values(run.steps).map(step=>[step.id,{agentId:step.workerId??null,...(step.workspace??{})}]))};}
  async launch(run,job,spec){
    const state=run.steps[spec.id],workerId=state.workerId??'ds-'+digest(run.deskId+':'+run.id+':'+spec.id+':'+state.attempt).slice(0,26);
    state.workerId=workerId;state.status='starting';this.save(run);
    const supervisorId=spec.supervisorStepId?run.steps[spec.supervisorStepId]?.workerId:null;
    const variables=this.variables(run,job),input={id:workerId,name:workerId,deskId:run.deskId,deskProjectId:job.projectId,deskRunId:run.id,deskStepId:spec.id,
      deskDefinitionId:spec.definitionId,deskDefinitionVersion:spec.definitionVersion,threadId:run.ownerThread,supervisorId,
      instruction:renderInputs(spec.instructions||job.snapshot.workflow.instructions||'Perform the registered workflow step and report evidence.',variables),
      context:{version:1,format:'text',content:JSON.stringify({runId:run.id,stepId:spec.id,inputs:variables.inputs,upstream:spec.dependsOn.map(id=>run.steps[id]),acceptance:spec.acceptance,team:job.snapshot.team??null}),source:'workflow:'+run.id},
    };
    input.context.sha256=digest(input.context.content);
    const options={config:this.config,store:this.store,rpc:this.rpc,pulse:this.notify,retirement:this.retirement};let result;
    if(spec.kind==='command')result=await this.commandsFactory(options).start({...input,argv:spec.command.argv,variables});
    else{
      if(spec.kind==='recipe'){
        input.recipe=job.snapshot.recipes[spec.recipeId+'@'+spec.recipeVersion];if(!input.recipe)throw new Error('Frozen recipe is unavailable');
        const workspace=this.desks.files.workspace(run.deskId,{agentId:workerId,instruction:input.instruction});
        input.recipeParameters=renderInputs(spec.parameters??{}, {...variables,outputs:workspace.outputs,evidence:workspace.evidence});
      }
      result=await this.delegationFactory(options).delegate(input);
    }
    state.workspace=result.workspace??this.store.worker(workerId)?.delegation?.spec.deskWorkspace??null;
    state.status='running';state.startedAt=state.startedAt??now();state.taskId=result.taskId;this.save(run);
  }
  executionReceipt(worker){
    if(!['command','recipe'].includes(worker.executionKind))return null;
    const path=join(worker.stateDir,worker.executionReceiptVersion===1?'execution':'runtime',worker.executionKind+'-result.json');if(!existsSync(path))return null;
    const receipt=JSON.parse(readFileSync(path,'utf8'));
    if(receipt.workerId!==worker.id||receipt.taskId!==worker.taskId)throw new Error('Execution receipt identity differs');
    if(worker.executionKind==='command'&&(receipt.fingerprint!==worker.command.fingerprint||receipt.terminalId!==worker.terminalId||receipt.pid!==worker.launchResult?.pid))throw new Error('Command receipt does not match native execution');
    if(worker.executionKind==='recipe'){
      const params=Object.fromEntries(Object.entries(recipeParameters(worker.recipeParameters??{})).sort(([a],[b])=>a<b?-1:a>b?1:0));
      if(receipt.recipeSha256!==worker.recipe.sha256||receipt.terminalId!==worker.terminalId||receipt.pid!==worker.launchResult?.pid||receipt.parametersSha256!==digest(JSON.stringify(params)))throw new Error('Recipe source, parameters or native identity differs from frozen run');
    }
    const exit=receipt.exit??{code:receipt.exitCode,signal:receipt.signal};
    return {path,sha256:digest(readFileSync(path)),receipt,exit,success:exit.code===0&&!exit.signal};
  }
  async workerFinished(worker,native){
    if(!worker.deskRunId||!worker.deskStepId||!['command','recipe'].includes(worker.executionKind))return false;
    const run=this.get(worker.deskId,worker.deskRunId);if(!run||run.steps[worker.deskStepId]?.workerId!==worker.id)return false;
    this.verifyFinished(worker,native);
    const evidence=this.executionReceipt(worker);if(!evidence)return false;
    if(evidence.success&&native.exit_code!==0)throw new Error('Successful receipt disagrees with native process exit');
    this.releaseOwnership(worker,{confirmed:true,reason:'process_finished',observedBy:'desk-runs'},'execution-finished');
    if(worker.executionKind==='recipe'&&!this.store.messages({taskId:worker.taskId}).some(m=>m.kind==='result')){
      const id='execution-'+digest(worker.id).slice(0,28);
      this.store.ingest(worker,{id,taskId:worker.taskId,workerId:worker.id,terminalId:worker.terminalId,kind:'result',createdAt:now(),
        text:'Native recipe execution ended; inspect evidence before acceptance. '+JSON.stringify({path:evidence.path,exit:evidence.exit,workspace:worker.delegation.spec.deskWorkspace})});
    }
    await this.pulse();return true;
  }
  verifyFinished(worker,native){
    if(native.state!=='finished'||native.address!==worker.terminalId||native.cwd!==worker.project||native.labels?.['codex.worker']!==worker.id||native.labels?.['codex.task']!==worker.taskId||
      native.labels?.['codex.desk']!==worker.deskId||native.labels?.['codex.desk-project']!==worker.deskProjectId||
      worker.launchArgv&&JSON.stringify(native.argv)!==JSON.stringify(worker.launchArgv)||
      worker.launchIdentity?.created_ms!==undefined&&native.created_ms!==worker.launchIdentity.created_ms)throw new Error('Finished native process identity changed; retain ownership for inspection');
  }
  activeDescendants(worker){
    const found=new Map(),visited=new Set(),visit=parent=>{
      if(visited.has(parent.id))return;visited.add(parent.id);
      for(const child of this.store.workers().filter(w=>w.supervisorId===parent.id)){if(this.store.task(child.taskId)?.status==='active')found.set(child.id,child);visit(child);}
    };visit(worker);return [...found.values()];
  }
  // Releases writer ownership and closes the task only when nothing actionable
  // remains. Returns `{retained:true,pending}` while a report still needs a
  // recorded manager action+ack, so callers keep the step re-drivable instead
  // of blocking or silently acknowledging the notice. The post-stop recheck is
  // the part the earlier pre-stop guard missed: the intentional-stop transaction
  // writes one durable lifecycle notice, and the task must not close over it.
  async retire(worker){
    if(this.store.task(worker.taskId)?.status==='closed')return this.closeTask(worker);
    const children=this.activeDescendants(worker);if(children.length)throw new Error('Cannot retire supervisor '+worker.id+' while child work is active: '+children.map(w=>w.id).join(', ')+'. Inspect and settle those children first.');
    // Ownership may already be gone: a prior verified execution-finished release
    // or a never-launched rollback deliberately left the task open so a retry
    // could re-drive it. Closing that task is an explicit, separate transition,
    // never a re-settlement of an already-released worker -- and it never closes
    // over a report that is still pending acknowledgement (for example the
    // lifecycle `stopped-*` notice the release itself just wrote).
    if(storedRetirement(this.store,worker.id)?.state===RETIREMENT.RELEASED)return this.closeTask(worker);
    const waiting=this.actionableInbox(worker);
    // Outstanding step messages are an expected, re-drivable hold, not a fault:
    // report structured obligations so the caller keeps the step in review and
    // pulse re-evaluates once the manager has actioned and acknowledged them.
    if(waiting.length)return {retained:true,reason:'pending-messages',retirement:null,pending:waiting.map(m=>m.id),obligations:{retirement:null,notices:waiting.map(m=>m.id),descendants:[],requests:[],dispatching:false}};
    if(!worker.terminalId&&worker.launchState==='preparation_failed'){
      // Never-launched rollback: no native request was ever issued, so there is
      // no process to clear. Release the reservation WITHOUT closing, then ask
      // the gate whether the task may also close in the same transaction; a
      // pre-bound queued request keeps the never-launched task re-drivable.
      this.releaseOwnership(worker,{confirmed:false,reason:'never-launched',observedBy:'desk-runs'},'never-launched',false);return this.closeTask(worker);
    }
    // Preserve the pre-flight turn guard: an accepted-but-still-working worker
    // is refused rather than signalled. `stop` then re-verifies the original
    // immutable identity before any signal and is idempotent under replay.
    const native=await this.rpc.request('terminal.get',{terminal:worker.terminalId});
    if(native.state==='live'){assertNativeWorker(worker,native);if(!['done','idle'].includes(native.status?.state))throw new Error('Accepted worker is still working; finish its turn before retiring');}
    else this.verifyFinished(worker,native);
    // The durable Delegation.stop/Requests path owns kill dispatch, identity
    // verification and the shared retirement call. Retire never launches its
    // own kill/get loop. Ownership is released only when the shared service
    // proves complete clearance; the task is closed only AFTER that release.
    const api=this.delegationFactory({store:this.store,config:this.config,rpc:this.rpc,pulse:this.notify,retirement:this.retirement});
    await api.stop(worker.id,'retire-'+digest(worker.id).slice(0,28),{note:'Workflow step accepted; retire this worker through the shared retirement service.'});
    // A stop that is durably requested but not yet *cleared* is an expected,
    // re-drivable hold rather than a terminal fault: the manager still has to
    // resolve and acknowledge the lifecycle notice and, for conservative or
    // partial coverage, reconcile the containment claim. Surface structured
    // obligations so callers keep the step in review and pulse re-evaluates
    // after clearance instead of declaring the run permanently blocked. A
    // genuine identity/native inconsistency still throws above and faults.
    const state=storedRetirement(this.store,worker.id)?.state??RETIREMENT.PENDING;
    if(state!==RETIREMENT.RELEASED)return {retained:true,reason:'pending-retirement',retirement:state,pending:this.actionableInbox(worker).map(m=>m.id),obligations:{...this.openObligations(worker),retirement:state}};
    return this.closeTask(worker);
  }
  async settleDynamicChildren(run,step,parent){
    const frozen=new Map(Object.values(run.steps).filter(s=>s.workerId).map(s=>[s.workerId,s])),waiting=[],evidence={...(step.childEvidence??{})},visiting=new Set();
    const hold=(worker,reason)=>{waiting.push({workerId:worker.id,taskId:worker.taskId,supervisorId:worker.supervisorId,reason});};
    const visit=async supervisor=>{
      if(visiting.has(supervisor.id))throw new Error('Supervised child graph contains a cycle; inspect bindings before retirement');visiting.add(supervisor.id);
      for(const child of this.store.workers().filter(w=>w.supervisorId===supervisor.id)){
        const task=this.store.task(child.taskId);
        if(!task||task.threadId!==run.ownerThread||child.deskId!==run.deskId||task.deskId!==run.deskId)throw new Error('Supervised child ownership differs from its workflow; inspect '+child.id);
        // Authored DAG steps retain their own acceptance/retirement state machine.
        const authored=frozen.get(child.id);if(authored){if(authored.status!=='completed'||task.status!=='closed')hold(child,'Authored child step has not completed.');continue;}
        if(task.status==='closed'&&evidence[child.id]){await visit(child);continue;}
        const messages=this.store.messages({taskId:child.taskId});
        if(messages.some(m=>m.kind!=='progress'&&!m.acknowledgedAt)){hold(child,'Child messages still need decisions and acknowledgements.');continue;}
        const activation=this.store.meta('activation:'+child.id),observation=this.store.meta('observation:'+child.id);
        const lowerBounds=[activation?.at,observation?.notBefore].map(v=>Date.parse(v)).filter(Number.isFinite),notBefore=lowerBounds.length?Math.max(...lowerBounds):null;
        const accepted=[...messages].reverse().find(m=>m.kind==='result'&&m.action?.kind==='accept'&&m.acknowledgedAt&&(notBefore===null||Date.parse(m.createdAt)>=notBefore));
        if(!accepted){hold(child,'Child needs an accepted and acknowledged result for its current work.');continue;}
        if(!child.terminalId){hold(child,'Child launch has no verified native identity.');continue;}
        const native=await this.rpc.request('terminal.get',{terminal:child.terminalId});
        if(native.state==='live'){
          assertNativeWorker(child,native);
          if(!['idle','done'].includes(native.status?.state)){hold(child,'Child is still working.');continue;}
        }else this.verifyFinished(child,native);
        const execution=this.executionReceipt(child);
        if(['command','recipe'].includes(child.executionKind)&&(!execution?.success||native.state!=='finished'||native.exit_code!==0)){hold(child,'Controlled child needs matching successful termination evidence.');continue;}
        const before=waiting.length;await visit(child);if(waiting.length>before)continue;
        const retirement=await this.retire(child);
        if(retirement.retained){hold(child,retirement.obligations?.retirement?'Child retirement is retained until its containment clearance is reconciled.':retirement.obligations?.requests?.length?'Child has an unresolved input request that must be sent or refused before the child closes.':'Child stop notice must be actioned and acknowledged before the child closes.');continue;}
        evidence[child.id]={workerId:child.id,taskId:child.taskId,supervisorId:child.supervisorId,terminalId:child.terminalId,decision:accepted.id,requestId:accepted.action.requestId,closedAt:this.store.task(child.taskId).closedAt,
          workspace:child.delegation?.spec.deskWorkspace??null,artifacts:artifactEvidence(child.delegation?.spec.deskWorkspace),...(execution?{execution}:{})};
      }
      visiting.delete(supervisor.id);
    };
    await visit(parent);
    const changed=JSON.stringify(step.childEvidence??{})!==JSON.stringify(evidence)||JSON.stringify(step.waitingForChildren??[])!==JSON.stringify(waiting);
    if(changed){if(Object.keys(evidence).length)step.childEvidence=evidence;if(waiting.length)step.waitingForChildren=waiting;else delete step.waitingForChildren;this.save(run);}
    return waiting.length===0;
  }
  async observe(run,job,spec){
    const step=run.steps[spec.id],worker=this.store.worker(step.workerId);if(!worker)return;
    const evidence=this.executionReceipt(worker),messages=this.store.messages({taskId:worker.taskId});
    if(!evidence&&['command','recipe'].includes(worker.executionKind)){
      const native=await this.rpc.request('terminal.get',{terminal:worker.terminalId});
      if(native.state==='live'){assertNativeWorker(worker,native);return;}
      this.verifyFinished(worker,native);
      throw new Error('Controlled '+worker.executionKind+' execution ended without its matching execution receipt. Inspect the native terminal and launch/preflight evidence before an explicit retry.');
    }
    if(evidence){const native=await this.rpc.request('terminal.get',{terminal:worker.terminalId});if(native.state==='live'){assertNativeWorker(worker,native);return;}this.verifyFinished(worker,native);if(evidence.success&&native.exit_code!==0)throw new Error('Receipt and native exit disagree');}
    if(evidence&&!evidence.success){if(step.status!=='failed'){step.status='failed';step.execution=evidence;run.status='blocked';this.save(run);this.incident(run,spec.id,'Native step exited unsuccessfully; inspect '+evidence.path+' before an explicit retry.');}return;}
    const accepted=messages.find(m=>m.kind==='result'&&m.action?.kind==='accept'&&m.acknowledgedAt);
    const aborted=messages.find(m=>m.action?.kind==='abort'&&m.acknowledgedAt);
    if(aborted){step.status='failed';step.decision=aborted.id;run.status='blocked';this.save(run);return;}
    const children=workflowSteps(job).filter(s=>s.supervisorStepId===spec.id);
    const childrenDone=children.every(s=>run.steps[s.id].status==='completed');
    if(['command','recipe'].includes(worker.executionKind)&&!evidence)return;
    if((accepted||spec.kind==='command'&&evidence?.success||step.manualDecision?.action==='accept')&&childrenDone){
      if(messages.some(m=>m.kind!=='progress'&&!m.acknowledgedAt))return;
      // Final acceptance asks to retire this workflow supervisor, not to abandon
      // children it delegated dynamically through its existing scoped helper.
      const native=await this.rpc.request('terminal.get',{terminal:worker.terminalId});
      if(native.state==='live'){assertNativeWorker(worker,native);if(!['idle','done'].includes(native.status?.state))return;}else this.verifyFinished(worker,native);
      if(!await this.settleDynamicChildren(run,step,worker)){if(step.status!=='review'){step.status='review';this.save(run);}return;}
      const retirement=await this.retire(worker);
      if(retirement.retained){if(step.status!=='review'){step.status='review';this.save(run);}return;}
      step.status='completed';step.completedAt=now();step.decision=accepted?.id??step.manualDecision?.requestId??'authored-command-exit-zero';
      step.execution=evidence??undefined;step.artifacts=artifactEvidence(step.workspace);this.save(run);return;
    }
    if(children.length&&childrenDone&&!step.finalRequested&&!messages.some(m=>m.kind==='result')){
      const api=this.delegationFactory({store:this.store,config:this.config,rpc:this.rpc,pulse:this.notify,retirement:this.retirement});
      const native=await api.verify(worker);
      if(['done','idle'].includes(native.status?.state)){
        await api.followup(worker.id,'workflow-final-'+digest(run.id).slice(0,15),{instruction:'All assigned child steps in workflow '+run.id+' have recorded accepted outcomes. Inspect their evidence and send one final herdr-message result with the consolidated outcome and unresolved issues. Do not restart any step.'});
        step.finalRequested=true;this.save(run);
      }
    }
    if(messages.some(m=>m.kind==='result'&&!m.acknowledgedAt)&&step.status!=='review'){step.status='review';this.save(run);}
  }
  async advance(run){
    if(run.status==='cancelled'){this.reconcileCancelledWork(run);this.reconcileWork(run);return;}
    // A bound cancellation is not a normal launch/observe path: it re-checks
    // outstanding stop obligations on every pulse and settles terminally only
    // after every worker retirement is released, every task is closed and no
    // actionable message remains. Normal downstream launching stays frozen.
    if(run.status==='cancelling'){await this.reconcileCancelling(run);return;}
    const job=this.desks.job(run.deskId,run.id);if(!job)return;
    if(run.status==='completed'){this.finalize(run);return;}
    for(const spec of workflowSteps(job)){const step=run.steps[spec.id];
      try{
        if(['running','review'].includes(step.status))await this.observe(run,job,spec);
        if(run.status!=='running'||!['pending','starting'].includes(step.status))continue;
        if(!spec.dependsOn.every(id=>run.steps[id].status==='completed'))continue;
        if(spec.supervisorStepId&&!this.store.worker(run.steps[spec.supervisorStepId]?.workerId)?.terminalId)continue;
        await this.launch(run,job,spec);
      }catch(error){step.status='blocked';step.error=String(error.message);run.status='blocked';this.save(run);this.incident(run,spec.id,error);}
    }
    if(Object.values(run.steps).every(step=>step.status==='completed')){
      this.finalize(run);
    }else if(run.status==='blocked'&&job.status!=='blocked')this.desks.jobUpdate(run.deskId,run.id,{status:'blocked',note:'Inspect step state and recorded incident; no uncertain work is blindly repeated.'});
    this.reconcileWork(run);
  }
  finalize(run){
    const resultId='desk-result-'+digest(run.deskId+':'+run.id).slice(0,28);
    if(run.status==='completed'&&this.desks.job(run.deskId,run.id)?.status==='completed'&&this.store.message(resultId)){this.reconcileAcceptance(run);return;}
    this.store.transaction(()=>{
      // A fresh gate: never declare the workflow complete while any launched step
      // worker still carries an unresolved notice, registered descendant or
      // undelivered input request. The step's own closed flag is not trusted on
      // its own; the obligations are re-read from durable state here.
      const held=Object.values(run.steps).map(step=>step.workerId&&this.store.worker(step.workerId)).filter(Boolean)
        .map(worker=>this.closureHold(worker,{requireReleased:false})).find(Boolean);
      if(held){run.status='running';this.save(run);return;}
      run.status='completed';run.completedAt=run.completedAt??now();this.save(run);
      const note='Every frozen step has command-exit verification or a recorded accepted result. Evidence is in desk run-show for '+run.id;
      if(this.desks.job(run.deskId,run.id).status!=='completed')this.desks.jobUpdate(run.deskId,run.id,{status:'completed',note});
      const task=this.store.task(run.controlTaskId);if(!this.store.message(resultId))this.store.ingestSystem(task,{id:resultId,taskId:task.id,workerId:'',terminalId:null,origin:'desk-runtime',kind:'result',createdAt:run.completedAt,text:'Workflow '+run.id+' completed. '+note});
      this.reconcileWork(run);
    });
  }
  reconcileAcceptance(run){
    this.store.transaction(()=>{
      const resultId='desk-result-'+digest(run.deskId+':'+run.id).slice(0,28),result=this.store.message(resultId);
      if(run.status==='completed'&&result?.action?.kind==='accept'&&result.acknowledgedAt&&!this.store.messages({taskId:run.controlTaskId,pending:true}).length){
        if(!run.acceptedAt){run.acceptedAt=result.acknowledgedAt;run.acceptance={messageId:resultId,requestId:result.action.requestId};this.save(run);}
        const task=this.store.task(run.controlTaskId);if(task.status!=='closed')this.store.saveTask({...task,status:'closed',closedAt:run.acceptedAt});
      }
      this.reconcileWork(run);
    });
  }
  async pulse(){
    if(this.stopped)return;
    if(this.processing){this.again=true;return;}
    this.processing=true;
    try{do{this.again=false;for(const desk of this.desks.list())for(const run of this.list(desk.id))await this.advance(run);}while(this.again&&!this.stopped);
      await this.triggers.pulse();this.resolveTriggerIncidents();
    }finally{this.processing=false;}
  }
  async decide({deskId,id,stepId,action,requestId,note}){
    safeId(requestId);if(!note?.trim()||!['accept','abort'].includes(action))throw new Error('Step decision requires accept/abort and evidence');
    const run=this.get(deskId,id),step=run?.steps[stepId];if(!step)throw new Error('Unknown workflow step');
    if(step.manualDecision){if(JSON.stringify(step.manualDecision)!==JSON.stringify({action,requestId,note}))throw new Error('Step already has another decision');return run;}
    const worker=this.store.worker(step.workerId);if(!worker)throw new Error('Step has no execution evidence');
    const receipt=this.executionReceipt(worker);if(action==='accept'&&receipt&&!receipt.success)throw new Error('Cannot accept an unsuccessful native execution');
    if(action==='accept'&&['command','recipe'].includes(worker.executionKind)){
      if(!receipt)throw new Error('Cannot accept controlled execution without a matching successful receipt');
      const native=await this.rpc.request('terminal.get',{terminal:worker.terminalId});this.verifyFinished(worker,native);if(native.exit_code!==0)throw new Error('Cannot accept an unsuccessful native exit');
    }
    if(this.store.messages({taskId:worker.taskId,pending:true}).length)throw new Error('Record message decisions and acknowledgements before step acceptance');
    step.manualDecision={action,requestId,note};if(action==='abort'){step.status='failed';run.status='blocked';}this.store.transaction(()=>{this.save(run);this.reconcileWork(run);});await this.notify();return run;
  }
  async retry({deskId,id,stepId,requestId,note}){
    safeId(requestId);if(!note?.trim())throw new Error('Retry requires inspection evidence');
    const run=this.get(deskId,id),step=run?.steps[stepId];if(!step)throw new Error('Unknown workflow step');
    // Cancellation dominates retry. Refuse before any retirement side effect so
    // a bound/cancelling/cancelled run can never be flipped back to running by a
    // stale operator retry, including after a process restart.
    const bound=this.cancellationBound(run);
    if(bound)throw new Error('Retry is refused while workflow run '+id+' has a '+bound+' bound; resolve that cancellation instead');
    // An already-committed retry is idempotent only for the exact same payload.
    // A same-key replay with different evidence is a conflict, never a silent
    // no-op that hides the change.
    if(step.retryRequest!==undefined&&step.retryRequest===requestId){
      if(step.retryEvidence!==note)throw new Error('Retry request '+requestId+' is already committed with different evidence; inspect it instead of replaying');
      return run;
    }
    if(!['failed','blocked'].includes(step.status))throw new Error('Only a failed/blocked step can be explicitly retried');
    if(step.retryPending&&(step.retryPending.requestId!==requestId||step.retryPending.note!==note))throw new Error('Step already has a retry in progress ('+step.retryPending.requestId+'); retry that request ID instead');
    // Bind the exact retry request durably BEFORE any retirement effect, so a
    // throw or hold after side effects cannot lose the binding and a different
    // payload can never overwrite it.
    if(!step.retryPending){step.retryPending={requestId,note,at:now()};this.save(run);}
    const worker=step.workerId&&this.store.worker(step.workerId);
    if(worker){
      if(['uncertain','launching','verifying'].includes(worker.launchState))throw new Error('Reconcile native launch uncertainty before retry; do not duplicate work');
      // A retry becomes an explicit NEW attempt only once the previous attempt's
      // writer ownership is released AND its task is actually closed. While a
      // durable stop notice is still pending, the original attempt is retained
      // and never replaced; re-issuing the same request ID proceeds after the
      // notice is actioned and acknowledged.
      const retirement=await this.retire(worker);
      if(retirement.retained||this.store.task(worker.taskId)?.status!=='closed'){
        const current=this.get(deskId,id);this.reconcileWork(current);return current;
      }
    }
    // Commit the new attempt only inside a fresh transaction that re-reads the
    // run and re-checks for a cancellation bound while we awaited retirement. A
    // concurrent cancellation that arrived first always wins; the attempt is
    // never advanced over it and no replacement is launched.
    const committed=this.store.transaction(()=>{
      const latest=this.get(deskId,id),lateBound=this.cancellationBound(latest);
      if(lateBound)throw new Error('Retry is refused: workflow run '+id+' acquired a '+lateBound+' while retirement was in progress; the attempt was not advanced');
      // Fresh obligation gate: even though the old task reports closed, refuse to
      // advance the attempt while any notice/descendant/undelivered request is
      // still outstanding on it.
      const workerNow=latest.steps[stepId].workerId&&this.store.worker(latest.steps[stepId].workerId);
      if(workerNow&&this.closureHold(workerNow,{requireReleased:false}))return latest;
      const latestStep=latest.steps[stepId];
      if(latestStep.retryRequest===requestId)return latest;
      const {history=[],retryPending,retryRequest,retryEvidence,...priorAttempt}=latestStep;
      latest.steps[stepId]={id:stepId,status:'pending',attempt:latestStep.attempt+1,retryRequest:requestId,retryEvidence:note,history:[...history,priorAttempt]};latest.status='running';
      this.save(latest);this.desks.jobUpdate(deskId,id,{status:'running',note:'Explicit retry: '+note});this.reconcileWork(latest);
      return latest;
    });
    await this.notify();return committed;
  }
  // Every worker that a run's steps launched, de-duplicated by worker id.
  cancelWorkers(run){return [...new Map(Object.values(run.steps).filter(step=>step.workerId).map(step=>[step.workerId,this.store.worker(step.workerId)])).values()].filter(Boolean);}
  // Resolve a cancellation that has already been bound. It is idempotent: it
  // re-uses the durable stop identity, re-checks outstanding obligations and
  // settles the run terminally only once every worker task is closed and no
  // actionable message remains on the control task. It never signals twice and
  // never overwrites a conflicting cancellation.
  async reconcileCancelling(run){
    const current=this.get(run.deskId,run.id);if(!current)return run;run=current;
    if(run.status!=='cancelling'||!run.cancellation)return run;
    const note=run.cancellation.note??'',workers=this.cancelWorkers(run);
    const api=this.delegationFactory({store:this.store,config:this.config,rpc:this.rpc,pulse:this.notify,retirement:this.retirement});
    for(const worker of workers){
      if(this.store.task(worker.taskId)?.status==='closed')continue;
      if(storedRetirement(this.store,worker.id)?.state===RETIREMENT.RELEASED){if(!this.actionableInbox(worker).length)this.closeTask(worker);continue;}
      if(!worker.terminalId){if(worker.launchState==='preparation_failed')await this.retire(worker);continue;}
      // Re-use the stop identity already recorded for this worker (a retire, or
      // an earlier cancellation) so a same-key replay sends no second signal.
      const prior=this.store.meta('stop:'+worker.id);
      const stopId=prior?.requestId??('cancel-'+digest(run.deskId+':'+run.id+':'+worker.id).slice(0,28));
      await api.stop(worker.id,stopId,{note:'Workflow '+run.id+' cancellation: '+note});
      if(storedRetirement(this.store,worker.id)?.state===RETIREMENT.RELEASED&&!this.actionableInbox(worker).length)this.closeTask(worker);
    }
    const unfinished=workers.filter(worker=>this.store.task(worker.taskId)?.status!=='closed'),pending=this.store.messages({taskId:run.controlTaskId,pending:true});
    if(unfinished.length||pending.length){
      run.waitingForCancellation={tasks:unfinished.map(w=>w.taskId),messages:pending.map(m=>m.id)};this.save(run);this.reconcileWork(run);return run;
    }
    this.store.transaction(()=>{
      run.status='cancelled';run.cancelledAt=run.cancelledAt??now();delete run.waitingForCancellation;
      for(const step of Object.values(run.steps))if(step.status!=='completed')step.status='cancelled';this.save(run);
      this.desks.jobUpdate(run.deskId,run.id,{status:'cancelled',note});this.reconcileWork(run);
      const task=this.store.task(run.controlTaskId);if(task&&task.status!=='closed')this.store.saveTask({...task,status:'closed',closedAt:now()});
    });
    return this.get(run.deskId,run.id);
  }
  async cancel({deskId,id,requestId,note}){
    safeId(requestId);if(!note?.trim())throw new Error('Cancellation needs an explanation');
    const run=this.get(deskId,id);if(!run)throw new Error('Unknown workflow run');if(terminal.has(run.status))return {...run,reused:true};
    if(run.cancellation){
      // A cancellation is already bound: the same request ID/payload is a
      // replay (no extra signal); any other payload must not overwrite it.
      if(run.cancellation.requestId!==requestId||run.cancellation.note!==note)throw new Error('Workflow run already has a cancellation in progress ('+run.cancellation.requestId+'); retry that request ID instead');
    }else{
      const workers=this.cancelWorkers(run);
      const children=[...new Set(workers.flatMap(worker=>this.activeDescendants(worker).map(child=>child.id)))];if(children.length)throw new Error('Cannot cancel the workflow while supervised child work is active: '+children.join(', ')+'. Inspect and settle those children first; cancellation will not abandon or automatically stop them.');
      const uncertain=workers.filter(worker=>!worker.terminalId&&worker.launchState!=='preparation_failed');if(uncertain.length)throw new Error('Reconcile uncertain native launch before cancelling the run: '+uncertain.map(w=>w.id).join(', '));
      // Bind durable cancellation intent/identity BEFORE the first signal, then
      // freeze normal downstream launching by moving the run to a non-terminal
      // `cancelling` state. Pending run messages do NOT block this: they are
      // retired as obligations before the run may settle.
      run.status='cancelling';run.cancellation={requestId,note,at:now()};
      this.store.transaction(()=>{this.save(run);this.desks.jobUpdate(deskId,id,{status:'running',note:'Cancellation requested: '+note});this.reconcileWork(run);});
    }
    await this.reconcileCancelling(run);
    await this.notify();
    return this.get(deskId,id);
  }
  // A cancelled run is terminal, but each stopped worker still owns an open
  // task until its own lifecycle notice is actioned and acknowledged. Re-check
  // on every pulse so the tasks close once that obligation is met and never
  // close over an unacknowledged report.
  reconcileCancelledWork(run){
    for(const step of Object.values(run.steps)){
      const worker=step.workerId&&this.store.worker(step.workerId);
      if(!worker||this.store.task(worker.taskId)?.status==='closed')continue;
      if(storedRetirement(this.store,worker.id)?.state!==RETIREMENT.RELEASED)continue;
      if(this.actionableInbox(worker).length)continue;
      this.closeTask(worker);
    }
  }
  async start(){this.stopped=false;await this.triggers.start();await this.pulse();}
  async stop(){this.stopped=true;await this.triggers.stop();}
}
