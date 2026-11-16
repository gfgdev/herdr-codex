import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {digest,safeId} from './config.mjs';
import {resolveDeskDelegation,deskWorkerKeys,deskIdentityKeys} from './desk-delegation.mjs';
import {assertNativeWorker} from './routing.mjs';
import {Supervision} from './supervision.mjs';
import {Retirement,noCoverage} from './retirement.mjs';

const now=()=>new Date().toISOString();
export function renderInputs(value,variables){
  if(typeof value==='string')return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,(_,key)=>{
    let v=variables;for(const part of key.split('.'))v=v?.[part];
    if(v===undefined)throw new Error('Unknown workflow input: '+key);
    return typeof v==='string'?v:JSON.stringify(v);
  });
  if(Array.isArray(value))return value.map(v=>renderInputs(v,variables));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,renderInputs(v,variables)]));
  return value;
}
function immutable(path,value){
  const bytes=JSON.stringify(value,null,2)+'\n';
  try{writeFileSync(path,bytes,{flag:'wx',mode:0o400});}
  catch(error){if(error.code!=='EEXIST')throw error;if(readFileSync(path,'utf8')!==bytes)throw new Error('Frozen command file differs: '+path);}
}

/** Launch one explicitly authored argv under the same direct-process file policy. */
export class DeskCommands {
  constructor({store,config,rpc,pulse=async()=>{},retirement=null}){
    Object.assign(this,{store,config,rpc,pulse});
    // Resolve ONE retirement/ownership service, mirroring Delegation. An injected
    // trusted provider wins; otherwise the configured containment provider is
    // consulted (default: claim no OS containment). Omission at construction can
    // therefore never fall back to a raw `releaseWriter` on the failure path.
    this.retirement=retirement??new Retirement(store,{provider:config.containmentProvider??noCoverage,trustedSources:config.trustedContainmentSources??null});
  }
  async start(input){
    const resolved=resolveDeskDelegation({store:this.store,config:this.config,input});
    const id=safeId(input.id),taskId='dc-'+digest(id+':'+input.threadId).slice(0,28);
    const variables={...input.variables,project:resolved.project,outputs:resolved.deskWorkspace?.outputs,evidence:resolved.deskWorkspace?.evidence,node:this.config.node};
    const argv=renderInputs(input.argv,variables);
    if(!Array.isArray(argv)||!argv.length||argv.some(a=>typeof a!=='string'||a.includes('\0')))throw new Error('Command requires nonempty explicit argv');
    const command={argv,fingerprint:digest(JSON.stringify({argv,project:resolved.project,readPaths:resolved.readPaths,writePaths:resolved.writePaths}))};
    const fields=Object.fromEntries(deskWorkerKeys.filter(k=>resolved[k]!=null).map(k=>[k,resolved[k]]));
    const expected={...fields,id,taskId,project:resolved.project,command,supervisorId:input.supervisorId??null};
    const fingerprint=digest(JSON.stringify(expected));let created=false;
    const worker=this.store.transaction(()=>{
      const old=this.store.worker(id);if(old){if(old.commandRegistration!==fingerprint)throw new Error('Command ID already has another frozen binding');return old;}
      this.store.saveTask({...Object.fromEntries(deskIdentityKeys.filter(k=>fields[k]!=null).map(k=>[k,fields[k]])),id:taskId,name:id,project:resolved.project,threadId:input.threadId,status:'active',brief:input.instruction,createdAt:now()});
      const w={version:1,...expected,name:id,role:'command',executionKind:'command',executionReceiptVersion:1,stateDir:join(this.config.stateDir,'workers',id),
        hc:this.config.hc,node:this.config.node,profileFile:this.config.profileFile,packageRoot:this.config.packageRoot,
        mailbox:'cx-'+digest(id).slice(0,26),readPaths:resolved.readPaths,writePaths:resolved.writePaths,
        commandRegistration:fingerprint,notifyOnDone:false,terminalId:null,launchState:'preparing',createdAt:now(),
        delegation:{spec:{deskWorkspace:resolved.deskWorkspace,readPaths:resolved.readPaths,writePaths:resolved.writePaths,deskInputContext:input.context??null,context:resolved.context}}};
      new Supervision({store:this.store,config:this.config,rpc:this.rpc}).validateBinding(w);
      this.store.reserveWorker(w);created=true;return w;
    });
    if(this.store.task(taskId)?.status!=='active')return {agentId:id,taskId,reused:true,actionable:false};
    if(created){
      let argv;
      try{
        mkdirSync(worker.stateDir,{recursive:true,mode:0o700});mkdirSync(join(worker.stateDir,'runtime'),{mode:0o700});
        immutable(join(worker.stateDir,'worker.json'),worker);
        const profile=JSON.parse(readFileSync(this.config.profileFile,'utf8'));
        argv=[profile.python??'/usr/bin/python3',join(this.config.packageRoot,'src/command-worker.py'),join(worker.stateDir,'worker.json')];
      }catch(error){
        // No native request has been attempted. Preserve the failed preparation
        // record but release only this proven-unstarted writer reservation.
        this.store.transaction(()=>{
          this.store.saveWorker({...this.store.worker(id),launchState:'preparation_failed',launchError:error.message});
          // Proven never-launched rollback: no native request was issued, so the
          // reservation is released through the shared retirement point, which
          // recognizes `never-launched` as an explicit non-holding release case.
          this.retirement.settle({worker:this.store.worker(id),observedExit:{confirmed:false,reason:'never-launched'},reason:'never-launched'});
        });
        throw error;
      }
      this.store.saveWorker({...this.store.worker(id),launchState:'launching',launchArgv:argv});
      try{
        const result=await this.rpc.request('terminal.run',{argv,cwd:worker.project,name:id,no_parent:true,keep:false,wait:false,
          labels:{'codex.worker':id,'codex.task':taskId,'codex.desk':worker.deskId,'codex.desk-project':worker.deskProjectId}});
        const terminalId=result.address??result.terminal?.address??result.terminal;
        this.store.saveWorker({...this.store.worker(id),terminalId,launchState:'verifying',launchResult:result});
        const native=await this.rpc.request('terminal.get',{terminal:terminalId});assertNativeWorker({...worker,terminalId},native);
        this.store.saveWorker({...this.store.worker(id),launchState:'started',launchResult:{...result,pid:native.pid},launchIdentity:{created_ms:native.created_ms}});
      }catch(error){this.store.saveWorker({...this.store.worker(id),launchState:'uncertain',launchError:error.message});throw error;}
    }
    const current=this.store.worker(id);if(!current.terminalId||current.launchState!=='started')throw new Error('Command launch uncertain; inspect original native labels, never repeat blindly');
    const gate=join(current.stateDir,'command-start.json');
    if(!existsSync(gate)){assertNativeWorker(current,await this.rpc.request('terminal.get',{terminal:current.terminalId}));await this.pulse();immutable(gate,{fingerprint:command.fingerprint});this.store.journal('desk.command.started',{deskId:current.deskId,workerId:id,taskId});}
    return {agentId:id,taskId,terminalId:current.terminalId,workspace:current.delegation.spec.deskWorkspace,reused:!created};
  }
}
