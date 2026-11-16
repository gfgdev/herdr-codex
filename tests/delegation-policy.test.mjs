import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Delegation} from '../src/delegation.mjs';
import {Supervision} from '../src/supervision.mjs';
const THREAD='00000000-0000-4000-8000-000000000001';
function fixture(t){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-recursive-policy-'))),stateDir=join(dir,'state');mkdirSync(stateDir);
 const config={stateDir,node:process.execPath,packageRoot:dir,hc:'/never-run-hc',profileFile:'/never-read-profile'},database=join(stateDir,'manager.sqlite');let store=new Store(database),desks=new Desks({store,config});
 desks.create({id:'desk',name:'Research Desk',purpose:'Nested team policy tests'});
 const role=(id,authority,instructions='Original '+id+' instructions')=>desks.definitionPut({deskId:'desk',id,name:id,harness:'goose',scope:'read-only',instructions,...(authority?{authority}:{})});
 role('analyst');role('team-lead',{delegateRoles:['analyst'],reviewRoles:['analyst']});role('director',{delegateRoles:['team-lead'],reviewRoles:['team-lead']});
 desks.workflowPut({deskId:'desk',id:'research',name:'Research',steps:[{id:'manage',kind:'agent',definitionId:'director'}]});desks.files.scaffold('desk');
 const calls=[],terminals=new Map();const rpc={request:async(method,params)=>{calls.push({method,params});if(method==='terminal.run'){const address='t'+(terminals.size+1),native={address,pid:1000+terminals.size,state:'live',cwd:params.cwd,argv:params.argv,name:params.name,labels:params.labels,keep:params.keep,turn:0,status:{state:'idle'}};terminals.set(address,native);return {address,pid:native.pid};}const native=terminals.get(params.terminal);if(!native)throw new Error('Missing fixture terminal');if(method==='terminal.get')return structuredClone(native);if(method==='terminal.wait')return {turn:native.turn,status:native.status};if(method==='terminal.send'){native.status={state:'working'};return {turn:native.turn,started:true};}throw new Error('Unexpected native method '+method);}};
 const api=()=>new Delegation({store,config,rpc,prepare:async worker=>({cwd:worker.project,argv:['/fixture-only',worker.id]})});
 const supervision=()=>new Supervision({store,config,rpc,delegate:input=>api().delegate(input)});
 const input=(id='director-worker')=>({id,name:id,deskId:'desk',deskDefinitionId:'director',threadId:THREAD,instruction:'Coordinate the local research task.'});
 async function child(actor,id,definitionId){const token=JSON.parse(readFileSync(actor.supervisionCredential.credentialFile,'utf8')).token;return supervision().handle({workerId:actor.id,terminalId:actor.terminalId,token,command:'delegate',args:{id,definitionId,requestId:'delegate-'+id,text:'Perform the scoped task and return actual evidence.'}});}
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return {config,api,supervision,input,role,child,calls,get store(){return store;},get desks(){return desks;},reopen(){store.close();store=new Store(database);desks=new Desks({store,config});}};
}

test('dynamic nested team keeps original grandchild policy after authored role changes and manager restart',async t=>{
 const f=fixture(t);f.desks.jobCreate({deskId:'desk',id:'frozen-run',workflowId:'research',ownerThread:THREAD});
 await f.api().delegate({...f.input(),deskRunId:'frozen-run',deskStepId:'manage'});const parent=f.store.worker('director-worker');
 assert.deepEqual(parent.supervisionGrant.definitionVersions,{'team-lead':1});assert.deepEqual(parent.supervisionGrant.policyVersions,{analyst:1,director:1,'team-lead':1});
 f.role('analyst',undefined,'Future analyst version must not enter this running hierarchy');assert.equal(f.desks.definition('desk','analyst').version,2);f.reopen();
 await f.child(f.store.worker(parent.id),'dynamic-lead','team-lead');const lead=f.store.worker('dynamic-lead');assert.equal(lead.deskRunId,undefined);assert.equal(lead.supervisionGrant.definitionVersions.analyst,1);assert.deepEqual(lead.supervisionGrant.policyVersions,parent.supervisionGrant.policyVersions);
 await f.child(lead,'dynamic-analyst','analyst');const analyst=f.store.worker('dynamic-analyst');assert.equal(analyst.deskDefinitionVersion,1);assert.equal(analyst.delegation.spec.template.instructions,'Original analyst instructions');assert.equal(analyst.supervisorId,lead.id);
 await f.child(lead,'dynamic-analyst','analyst');assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,3);
});

test('ad hoc root delegation snapshots the validated recursive role graph once',async t=>{
 const f=fixture(t);await f.api().delegate(f.input());const parent=f.store.worker('director-worker');f.role('analyst',undefined,'Future analyst policy');
 await f.child(parent,'ad-hoc-lead','team-lead');assert.equal(f.store.worker('ad-hoc-lead').supervisionGrant.definitionVersions.analyst,1);
 const replay=await f.api().delegate(f.input());assert.equal(replay.agentId,parent.id);assert.deepEqual(f.store.worker(parent.id).supervisionGrant,parent.supervisionGrant);
});

test('root refuses missing or ambiguous recursive versions in its frozen job',async t=>{
 for(const kind of ['missing','ambiguous']){
  const f=fixture(t),job=f.desks.jobCreate({deskId:'desk',id:'frozen-run',workflowId:'research',ownerThread:THREAD});
  if(kind==='missing')delete job.snapshot.definitions['analyst@1'];else{const next=f.role('analyst',undefined,'New policy');job.snapshot.definitions['analyst@2']=next;}
  f.desks._save('job',job);await assert.rejects(f.api().delegate({...f.input(),deskRunId:'frozen-run',deskStepId:'manage'}),kind==='missing'?/Missing frozen recursive role/:/Ambiguous authorized role/);assert.equal(f.calls.length,0);assert.equal(f.store.workers().length,0);
 }
});

test('legacy supervisors remain inspectable but cannot silently derive new nested authority',async t=>{
 const f=fixture(t);await f.api().delegate(f.input());const parent=f.store.worker('director-worker'),legacy=structuredClone(parent);delete legacy.supervisionGrant.policyVersions;delete legacy.delegation.spec.supervisionGrant.policyVersions;
 f.store.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify(legacy),legacy.id);assert.ok(f.supervision().grant(legacy));
 await assert.rejects(f.child(legacy,'new-lead','team-lead'),/requires a frozen recursive policyVersions/);assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);
});

test('recursive policy validation rejects altered pins and a child that changes the inherited map',async t=>{
 const f=fixture(t);await f.api().delegate(f.input());const parent=f.store.worker('director-worker');await f.child(parent,'lead','team-lead');const lead=f.store.worker('lead');f.role('analyst',undefined,'Future policy');
 const altered=structuredClone(lead);altered.supervisionGrant.policyVersions.analyst=2;assert.throws(()=>f.supervision().grant(altered),/differs from recursive/);
 altered.supervisionGrant.definitionVersions.analyst=2;assert.throws(()=>f.supervision().validateBinding(altered),/inherit the exact frozen parent/);
 const missing=structuredClone(parent);delete missing.supervisionGrant.policyVersions['team-lead'];assert.throws(()=>f.supervision().grant(missing),/differs from recursive/);
});
