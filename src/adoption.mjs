import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,safeId,uuid} from './config.mjs';
import {canonicalProject,localSpace,assertNativeWorker} from './routing.mjs';
import {Desks} from './desks.mjs';
import {assertDeskTask} from './desk-delegation.mjs';
import {observe} from './attention.mjs';
import {Retirement,noCoverage} from './retirement.mjs';

const now=()=>new Date().toISOString();
const identity=t=>({address:t.address,pid:t.pid,cwd:t.cwd,created_ms:t.created_ms??null,
  argv:t.argv??[],parent:t.parent??null});
const sameIdentity=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Bind an existing process. No launch, prompt, model switch or permission change. */
export class Adoption {
  constructor({config,store,rpc,pulse=async()=>{},retirement=null}){
    Object.assign(this,{config,store,rpc,pulse});
    // Resolve ONE retirement/ownership service, mirroring Delegation so omission
    // at construction can never invoke a raw `releaseWriter`. An injected trusted
    // provider wins; otherwise the configured containment provider is consulted
    // (default: claim no OS containment), which retains the writer lease as
    // `pending_retirement` until explicit complete clearance is recorded.
    this.retirement=retirement??new Retirement(store,{provider:config.containmentProvider??noCoverage,trustedSources:config.trustedContainmentSources??null});
  }
  summary(w,reused){return {agentId:w.id,taskId:w.taskId,terminalId:w.terminalId,name:w.name,project:w.project,
    ...(w.deskId?{deskId:w.deskId,deskProjectId:w.deskProjectId}:{}),parentId:w.adoption.spec.parentId,
    adopted:true,reused,registrationState:w.adoption.state,scope:w.adoption.spec.scope,
    sandboxEnforced:false,notifications:'native-lifecycle',workerConfig:join(w.stateDir,'worker.json'),
    note:'Existing permissions and native parent lifetime are unchanged. Scope is a declared coordination policy, not a retroactive sandbox. Explicit reports require using this worker binding; no prompt was sent.'};}
  async adopt(input){
    const id=safeId(input.id,'agent ID'),terminalId=input.terminalId;
    if(typeof terminalId!=='string'||!terminalId||terminalId.length>128||/[\s/\0]/.test(terminalId))throw new Error('Adopt an explicit local native address such as t7; names and remote addresses are not identity bindings. Remote commands remain available through native.');
    if(!uuid.test(input.threadId??''))throw new Error('Use the exact existing manager chat UUID');
    const project=canonicalProject(input.project),scope=input.scope??'write';
    if(!['read-only','write'].includes(scope))throw new Error('Adoption scope must be read-only or write (declared, not sandboxed)');
    const taskId=input.taskId??'ha-'+digest(id+':'+input.threadId).slice(0,28);
    safeId(taskId,'task ID');
    const old=this.store.worker(id),deskId=input.deskId??null,deskProjectId=input.deskProjectId??null;
    if(Boolean(deskId)!==Boolean(deskProjectId))throw new Error('Desk adoption requires both --desk and --desk-project');
    if(deskId){
      const desks=new Desks({store:this.store,config:this.config});desks.require(deskId,{active:true});
      if(desks.project(deskId,deskProjectId)?.path!==project)throw new Error('Adoption project must equal the registered Desk project');
    }
    const parentId=input.parentId??null,parent=parentId?this.store.worker(safeId(parentId,'parent ID')):null;
    if(parentId&&(!parent||this.store.task(parent.taskId)?.status!=='active'||this.store.task(parent.taskId)?.threadId!==input.threadId||
      (parent.deskId??null)!==deskId||parent.id===id))throw new Error('Parent must be an active registered agent in this chat and Desk');
    const spec={terminalId,project,threadId:input.threadId,taskId,scope,deskId,deskProjectId,parentId,name:input.name??null};
    const fingerprint=digest(JSON.stringify(spec));
    if(old&&old.adoption?.fingerprint!==fingerprint)throw new Error('Agent ID already belongs to a different binding; no worker was adopted');
    if(old&&this.store.task(old.taskId)?.status!=='active')return {...this.summary(old,true),actionable:false,note:'Task is closed; adoption retry does not resume it.'};
    if(old?.adoption.state==='finished')return {...this.summary(old,true),actionable:false,note:'The original process finished during adoption. Inspect its recorded runtime attention; no process was restarted.'};
    const native=await this.rpc.request('terminal.get',{terminal:terminalId});
    if(native.state!=='live'||!localSpace(native)||native.address!==terminalId||native.cwd!==project||!Number.isSafeInteger(native.pid)||native.pid<=0)
      throw new Error('Native process must be live in the exact selected local project');
    if(parent){
      assertNativeWorker(parent,await this.rpc.request('terminal.get',{terminal:parent.terminalId}));
      if(native.parent!==parent.terminalId)throw new Error('Native child does not belong to the selected parent');
    }else if(native.parent)throw new Error('Native child adoption requires its explicit registered --parent');
    const snapshot=identity(native);
    if(old&&!sameIdentity(old.adoption.nativeIdentity,snapshot))throw new Error('Original adopted process changed; retry will not take over a replacement');
    const labels={'codex.worker':id,'codex.task':taskId,'codex.owner':digest(this.config.stateDir).slice(0,24),
      ...(deskId?{'codex.desk':deskId,'codex.desk-project':deskProjectId}:{})};
    for(const [key,value] of Object.entries(native.labels??{}))if(key.startsWith('codex.')&&(!old||labels[key]!==value))
      throw new Error('Native terminal already carries another ownership binding; inspect it before adoption');
    const fields=deskId?{deskId,deskProjectId}:{};
    if(!old)this.store.transaction(()=>{
      if(this.store.workers().some(w=>w.terminalId===terminalId))throw new Error('Native terminal is already registered to another worker');
      const task=this.store.task(taskId);
      if(task&&(task.status!=='active'||task.threadId!==input.threadId||task.project!==project))throw new Error('Task is closed or belongs to a different project/chat');
      if(input.taskId&&!task)throw new Error('Unknown selected task');
      if(task)assertDeskTask(task,fields);
      if(!task)this.store.saveTask({id:taskId,name:input.name??native.name??id,project,threadId:input.threadId,
        ...fields,brief:'Explicit adoption of an existing native process; no new assignment submitted.',status:'active',createdAt:now()});
      this.store.reserveWorker({version:1,id,taskId,name:native.name??id,role:'native',project,...fields,
        terminalId,stateDir:join(this.config.stateDir,'workers',id),hc:this.config.hc,node:this.config.node,
        packageRoot:this.config.packageRoot,mailbox:'cx-'+digest(this.config.stateDir+':'+id).slice(0,26),
        readPaths:[],writePaths:scope==='write'?[project]:[],notifyOnDone:true,startTurn:native.turn??0,
        createdAt:now(),launchState:'adopting',launchResult:{pid:native.pid},
        adoption:{version:1,state:'prepared',fingerprint,spec,nativeIdentity:snapshot,labels,sandboxEnforced:false,
          originalLifecycle:{keep:native.keep??false,dieWithParent:native.die_with_parent??false}}});
      // Preserve an already-working turn even if it ends during registration.
      this.store.meta('observation:'+id,{...observe(null,native,{}),originalPid:native.pid});
      this.store.journal('agent.adoption.prepared',{workerId:id,taskId,terminalId,...fields});
    });
    let worker=this.store.worker(id);
    if(worker.adoption.state==='attached'){
      assertNativeWorker(worker,native);await this.pulse();return this.summary(worker,true);
    }
    try{
      // Recheck the process after the durable reservation and before labels.
      const current=await this.rpc.request('terminal.get',{terminal:terminalId});
      if(!sameIdentity(snapshot,identity(current))||current.state!=='live')throw new Error('Native identity changed during adoption');
      for(const [key,value] of Object.entries(current.labels??{}))if(key.startsWith('codex.')&&labels[key]!==value)throw new Error('Native ownership changed during adoption');
      if(!Object.entries(labels).every(([key,value])=>current.labels?.[key]===value))
        await this.rpc.request('terminal.label',{terminal:terminalId,labels});
      const verified=await this.rpc.request('terminal.get',{terminal:terminalId});
      assertNativeWorker(worker,verified);
      if(!sameIdentity(snapshot,identity(verified)))throw new Error('Native process changed while labeling');
      mkdirSync(worker.stateDir,{recursive:true,mode:0o700});
      worker={...worker,launchState:'started',adoption:{...worker.adoption,state:'attached',attachedAt:now()}};
      const file=join(worker.stateDir,'worker.json'),temporary=file+'.'+randomUUID()+'.tmp';
      writeFileSync(temporary,JSON.stringify(worker,null,2)+'\n',{mode:0o600});renameSync(temporary,file);
      this.store.saveWorker(worker);this.store.journal('agent.adopted',{workerId:id,taskId,terminalId,...fields});
      await this.pulse();return this.summary(worker,!!old);
    }catch(error){
      // A known exit is terminal evidence, not an uncertain launch. Preserve its
      // binding so the listener can raise one fault, and route writer ownership
      // through the shared retirement point -- which retains the lease as
      // `pending_retirement` unless the configured provider proves complete
      // descendant clearance for this exact execution. It never releases via a
      // raw fallback here.
      try{
        const finished=await this.rpc.request('terminal.get',{terminal:terminalId});
        if(finished.state==='finished'&&sameIdentity(snapshot,identity(finished))){
          this.store.transaction(()=>{
            const saved=this.store.worker(id);
            this.store.saveWorker({...saved,launchState:'finished',adoption:{...saved.adoption,state:'finished'}});
            // A known matching exit is terminal, but writer ownership stays a
            // SEPARATE fact: it is released only through the shared retirement
            // point. With no trusted containment provider the lease is retained
            // as `pending_retirement` until explicit complete clearance exists.
            this.retirement.settle({worker:saved,observedExit:{confirmed:true,reason:'process_finished',observedBy:'adoption'},reason:'adoption-finished'});
          });
          await this.pulse();
        }
      }catch{/* Unknown outcome retains the process binding and writer reservation. */}
      this.store.journal('agent.adoption.incomplete',{workerId:id,taskId,error:String(error.message).slice(0,500)});
      throw error;
    }
  }
  async children(parentId){
    const parent=this.store.worker(safeId(parentId,'parent ID'));
    if(!parent||this.store.task(parent.taskId)?.status!=='active')throw new Error('Unknown or inactive parent');
    assertNativeWorker(parent,await this.rpc.request('terminal.get',{terminal:parent.terminalId}));
    const result=await this.rpc.request('terminal.list',{all:true});
    return {parentId,children:result.terminals.filter(t=>localSpace(t)&&t.parent===parent.terminalId).map(t=>({
      terminalId:t.address,name:t.name,project:t.cwd,state:t.state,status:t.status,pid:t.pid,
      registeredAgentId:this.store.workers().find(w=>w.terminalId===t.address)?.id??null,
      adoptionRequired:!this.store.workers().some(w=>w.terminalId===t.address),
    })),note:'Discovery only; children are never automatically adopted or assigned.'};
  }
}
