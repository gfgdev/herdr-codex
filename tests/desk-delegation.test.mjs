import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Delegation} from '../src/delegation.mjs';
import {resolveDeskDelegation} from '../src/desk-delegation.mjs';

const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER='01a1d3b4-f77e-7363-b682-5c40fbe482f4';

function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-delegation-'))),stateDir=join(directory,'state'),vault=join(directory,'vault'),extra=join(directory,'extra');
  for(const path of [stateDir,vault,extra])mkdirSync(path);
  writeFileSync(join(vault,'notes.md'),'Unattached private desk notes.\n');
  const config={stateDir,packageRoot:directory,hc:'/fake/hc',app:'/fake/app',node:process.execPath,profileFile:join(directory,'profile.json')};
  const store=new Store(join(stateDir,'manager.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const desks=new Desks({store,config});desks.create({id:'bpm',name:'BPM',purpose:'Original purpose',vaultPath:vault});
  const definition={deskId:'bpm',id:'analyst',name:'Analyst',harness:'goose',scope:'read-only',instructions:'Investigate the assigned desk question.',resourceIds:['vault'],acceptance:['Cite source evidence.'],context:'Original specialist context'};
  desks.definitionPut(definition);
  const calls=[],terminals=new Map();let next=0;
  const rpc={request:async(method,params)=>{
    calls.push({method,params:structuredClone(params)});
    if(method==='terminal.run'){
      const address='t'+(++next),terminal={address,state:'live',status:{state:'idle'},turn:0,pid:100+next,cwd:params.cwd,labels:structuredClone(params.labels),argv:params.argv,keep:params.keep};
      terminals.set(address,terminal);return {address,pid:terminal.pid};
    }
    if(method==='terminal.list')return {terminals:[...terminals.values()].map(x=>structuredClone(x))};
    const native=terminals.get(params.terminal);if(!native)throw new Error('Missing fixture terminal');
    if(method==='terminal.get')return structuredClone(native);
    if(method==='terminal.wait')return {turn:native.turn,status:native.status};
    if(method==='terminal.send'){native.turn++;return {turn:native.turn};}
    if(method==='terminal.interrupt')return {interrupted:true};
    throw new Error('Unexpected native method '+method);
  }};
  const api=new Delegation({store,config,rpc,prepare:async worker=>({argv:['fixture-agent'],cwd:worker.project})});
  const input={id:'bpm-analyst',deskId:'bpm',deskProjectId:'home',deskDefinitionId:'analyst',threadId:THREAD,instruction:'Inspect the current procedure and return cited findings.'};
  return {directory,stateDir,vault,extra,config,store,desks,definition,calls,terminals,api,input};
}
const effects=f=>f.calls.filter(c=>['terminal.run','terminal.send','terminal.interrupt'].includes(c.method));

test('desk delegation freezes registered project, definition, context and native desk labels',async t=>{
  const f=fixture(t),result=await f.api.delegate(f.input),worker=f.store.worker(f.input.id),task=f.store.task(result.taskId);
  assert.equal(worker.project,f.desks.project('bpm','home').path);assert.equal(worker.deskId,'bpm');assert.equal(worker.deskProjectId,'home');
  assert.equal(worker.deskDefinitionVersion,1);assert.equal(task.deskId,'bpm');assert.equal(task.deskProjectId,'home');
  assert.deepEqual(worker.writePaths,[]);assert.ok(worker.readPaths.includes(f.vault));
  assert.match(worker.delegation.spec.context.content,/Original purpose/);assert.match(worker.delegation.spec.context.content,/Original specialist context/);
  assert.doesNotMatch(worker.delegation.spec.context.content,/Unattached private desk notes/);
  const launch=effects(f).find(c=>c.method==='terminal.run');assert.equal(launch.params.labels['codex.desk'],'bpm');assert.equal(launch.params.labels['codex.desk-project'],'home');
  assert.equal(result.request.state,'sent');
});

test('identical desk delegation retries do not launch or send twice',async t=>{
  const f=fixture(t),one=await f.api.delegate(f.input),two=await f.api.delegate(f.input);
  assert.equal(two.reused,true);assert.equal(two.terminalId,one.terminalId);assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);assert.equal(effects(f).filter(c=>c.method==='terminal.send').length,1);
});

test('future definition changes cannot silently expand an existing delegation',async t=>{
  const f=fixture(t);await f.api.delegate(f.input);const before=f.store.worker(f.input.id);
  f.desks.definitionPut({...f.definition,scope:'write',instructions:'A different future definition.'});
  const replay=await f.api.delegate(f.input);assert.equal(replay.reused,true);
  assert.equal(f.store.worker(f.input.id).deskDefinitionVersion,1);assert.deepEqual(f.store.worker(f.input.id).writePaths,before.writePaths);
  await assert.rejects(f.api.delegate({...f.input,deskDefinitionVersion:2}),/different frozen delegation/);
  assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);
});

test('desk-purpose edits preserve the already-frozen context on an identical retry',async t=>{
  const f=fixture(t);await f.api.delegate(f.input);const hash=f.store.worker(f.input.id).delegation.spec.context.sha256;
  f.desks.update('bpm',{purpose:'New purpose for future assignments'});
  const replay=await f.api.delegate(f.input);assert.equal(replay.reused,true);assert.equal(f.store.worker(f.input.id).delegation.spec.context.sha256,hash);
  assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);
});

test('explicit path, harness, scope and path-grant overrides fail before native effects',async t=>{
  const f=fixture(t);
  for(const patch of [{project:f.extra},{harness:'pi'},{scope:'write'},{readPaths:[f.extra]},{writePaths:[f.extra]}])await assert.rejects(f.api.delegate({...f.input,...patch}),/match|override|registered/);
  assert.deepEqual(effects(f),[]);assert.equal(f.store.worker(f.input.id),null);
});

test('external resource metadata cannot be mistaken for an authenticated connector',async t=>{
  const f=fixture(t);f.desks.resourceAdd({deskId:'bpm',id:'mail',name:'Mailbox',kind:'mailbox',ref:'provider-account-id',access:['read']});
  f.desks.definitionPut({...f.definition,resourceIds:['mail']});
  await assert.rejects(f.api.delegate(f.input),/no executable connector/);assert.deepEqual(effects(f),[]);
});

test('workflow resource narrowing excludes broader local and unavailable definition resources',async t=>{
  const f=fixture(t);
  f.desks.resourceAdd({deskId:'bpm',id:'extra',name:'Extra',kind:'directory',path:f.extra,access:['read']});
  f.desks.resourceAdd({deskId:'bpm',id:'mail',name:'Mailbox',kind:'mailbox',ref:'provider-account-id',access:['read']});
  const def=f.desks.definitionPut({...f.definition,resourceIds:['vault','extra','mail']});
  f.desks.workflowPut({deskId:'bpm',id:'narrow',name:'Narrow review',definitionId:'analyst',instructions:'Review only vault notes.',resourceIds:['vault']});
  f.desks.jobCreate({deskId:'bpm',id:'job-a',workflowId:'narrow',ownerThread:THREAD});
  await f.api.delegate({...f.input,deskJobId:'job-a',deskDefinitionVersion:def.version});
  const worker=f.store.worker(f.input.id);assert.ok(worker.readPaths.includes(f.vault));assert.equal(worker.readPaths.includes(f.extra),false);assert.equal(worker.deskJobId,'job-a');
  assert.doesNotMatch(worker.delegation.spec.context.content,/provider-account-id/);
});

test('jobs enforce pinned specialist version before launching work',async t=>{
  const f=fixture(t);f.desks.workflowPut({deskId:'bpm',id:'review',name:'Review',definitionId:'analyst',instructions:'Review the procedure.'});
  f.desks.jobCreate({deskId:'bpm',id:'job-a',workflowId:'review',ownerThread:THREAD});
  f.desks.definitionPut({...f.definition,instructions:'Updated instructions for future jobs.'});
  await assert.rejects(f.api.delegate({...f.input,deskJobId:'job-a'}),/pinned agent definition/);assert.deepEqual(effects(f),[]);
  await f.api.delegate({...f.input,deskJobId:'job-a',deskDefinitionVersion:1});assert.equal(f.store.worker(f.input.id).deskDefinitionVersion,1);
});

test('failed jobs cannot launch another agent or implicitly restart',async t=>{
  const f=fixture(t);f.desks.workflowPut({deskId:'bpm',id:'review',name:'Review',definitionId:'analyst',instructions:'Review the procedure.'});
  f.desks.jobCreate({deskId:'bpm',id:'job-a',workflowId:'review',ownerThread:THREAD});
  f.desks.jobUpdate('bpm','job-a',{status:'failed',note:'Fixture prerequisite unavailable; no work started.'});
  await assert.rejects(f.api.delegate({...f.input,deskJobId:'job-a'}),/settled/);assert.deepEqual(effects(f),[]);
});

test('work and job ownership route only to their registered manager chat',async t=>{
  const f=fixture(t);f.desks.workCreate({deskId:'bpm',id:'work-a',title:'Work',brief:'Specific scope.',ownerThread:OTHER});
  await assert.rejects(f.api.delegate({...f.input,deskWorkId:'work-a'}),/another project or manager chat/);
  f.desks.workflowPut({deskId:'bpm',id:'review',name:'Review',definitionId:'analyst',instructions:'Review.'});
  f.desks.jobCreate({deskId:'bpm',id:'job-a',workflowId:'review',ownerThread:OTHER});
  await assert.rejects(f.api.delegate({...f.input,deskJobId:'job-a'}),/another project or manager chat/);assert.deepEqual(effects(f),[]);
});

test('desk task cannot accept an agent from a different desk even at the same project path',async t=>{
  const f=fixture(t),one=await f.api.delegate(f.input);
  f.desks.create({id:'other',name:'Other',purpose:'Separate client'});
  f.desks.projectAdd({deskId:'other',id:'shared-path',name:'Explicit shared directory',path:f.desks.project('bpm','home').path});
  f.desks.definitionPut({...f.definition,deskId:'other',resourceIds:[]});
  await assert.rejects(f.api.delegate({...f.input,id:'other-agent',deskId:'other',deskProjectId:'shared-path',taskId:one.taskId}),/different desk/);
  assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);
});

test('native desk-label changes block followups to the wrong desk',async t=>{
  const f=fixture(t),one=await f.api.delegate(f.input);f.terminals.get(one.terminalId).labels['codex.desk']='other';
  await assert.rejects(f.api.followup(f.input.id,'followup-1',{instruction:'Continue inspection.'}),/native identity/);
  assert.equal(effects(f).filter(c=>c.method==='terminal.send').length,1);
});

test('desk fields cannot be supplied to a legacy delegation without desk selection',t=>{
  const f=fixture(t);
  assert.throws(()=>resolveDeskDelegation({store:f.store,config:f.config,input:{...f.input,deskId:undefined}}),/explicit desk/);
});

test('parent relationships do not silently cross desk boundaries',async t=>{
  const f=fixture(t);await f.api.delegate(f.input);
  f.desks.create({id:'other',name:'Other',purpose:'Separate client'});f.desks.definitionPut({...f.definition,deskId:'other',resourceIds:[]});
  await assert.rejects(f.api.delegate({...f.input,id:'other-agent',deskId:'other',parentId:f.input.id}),/Parent belongs to another desk/);
  assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);
});

test('a linked job cannot silently acquire a second independent agent and task',async t=>{
  const f=fixture(t);f.desks.workflowPut({deskId:'bpm',id:'review',name:'Review',definitionId:'analyst',instructions:'Review the procedure.'});
  f.desks.jobCreate({deskId:'bpm',id:'job-a',workflowId:'review',ownerThread:THREAD});
  const one=await f.api.delegate({...f.input,deskJobId:'job-a'});
  f.desks.jobUpdate('bpm','job-a',{status:'running',taskId:one.taskId,agentId:one.agentId,note:'First owner registered.'});
  await assert.rejects(f.api.delegate({...f.input,id:'second-agent',deskJobId:'job-a'}),/bound|binding|assigned|owner|different|another/i);
  assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);
});

test('a linked work item cannot silently acquire a separate task',async t=>{
  const f=fixture(t);f.desks.workCreate({deskId:'bpm',id:'work-a',title:'Review',brief:'Review the procedure.',ownerThread:THREAD});
  const one=await f.api.delegate({...f.input,deskWorkId:'work-a'});
  f.desks.workUpdate('bpm','work-a',{status:'assigned',taskId:one.taskId,agentId:one.agentId});
  await assert.rejects(f.api.delegate({...f.input,id:'second-agent',deskWorkId:'work-a'}),/bound|binding|assigned|owner|different|another/i);
  assert.equal(effects(f).filter(c=>c.method==='terminal.run').length,1);
});
