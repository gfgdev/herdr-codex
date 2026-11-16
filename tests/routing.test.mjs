import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {showWorker} from '../src/desktop.mjs';
import {Store} from '../src/store.mjs';
import {Delegation} from '../src/delegation.mjs';
const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER='01a1d317-b5d9-7530-8623-f60c0df12d38';

function fixture(t) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-routing-proposal-')));
  const project=join(dir,'project'),other=join(dir,'unrelated-project'),stateDir=join(dir,'state');
  for(const path of [project,other,stateDir])mkdirSync(path);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const task={id:'project-task',name:'Scope test',project,threadId:THREAD,status:'active'};
  const worker={id:'project-agent',taskId:task.id,project,terminalId:'t15',mailbox:'cx-project',launchResult:{pid:1500}};
  const native={address:'t15',state:'live',cwd:project,pid:1500,status:{state:'idle'},turn:0,labels:{'codex.worker':worker.id,'codex.task':task.id}};
  const state={spaces:[{id:'unrelated',folder:other,active:true,tabs:[]},{id:'project',folder:project,active:false,tabs:[]}]};
  const calls=[];let inventoryReads=0;
  const hooks={};
  const appCall=async(method,args)=>{
    calls.push({method,args:structuredClone(args)});
    if(method==='ls') { inventoryReads++;hooks.inventory?.(inventoryReads,state);return structuredClone(state); }
    if(method==='space.select'){for(const space of state.spaces)space.active=space.id===args.id;hooks.selected?.(state);return {id:args.id};}
    if(method==='terminal.keep'){
      hooks.keep?.(state);
      state.spaces.find(s=>s.active).tabs.push({id:'new-tab',active:true,terminals:[{terminal:args.terminal}]});
      return {terminal:args.terminal};
    }
    throw new Error('Unexpected app operation '+method);
  };
  let nativeReads=0;
  const getTerminal=async id=>{nativeReads++;hooks.native?.(nativeReads,id,state,native);return structuredClone(id===worker.terminalId?native:{state:'live',cwd:project});};
  return {dir,project,other,stateDir,task,worker,native,state,calls,hooks,appCall,getTerminal};
}

test('local project selection ignores a remote space with the same folder spelling and terminal address',async t=>{
  const f=fixture(t);f.state.spaces.unshift({id:'remote',folder:f.project,machine:'build-server',tabs:[{id:'remote-tab',terminals:[{terminal:'t15'}]}]});
  const result=await showWorker(f);
  assert.equal(result.spaceId,'project');assert.equal(result.status,'shown');
  assert.equal(f.state.spaces[0].tabs[0].id,'remote-tab');
  assert.equal(f.state.spaces[1].tabs.length,0);
});

test('explicit remote space is rejected without selecting or placing anything',async t=>{
  const f=fixture(t);f.state.spaces[1].machine='build-server';
  await assert.rejects(showWorker({...f,spaceId:'project'}),/local desktop space/);
  assert.equal(f.calls.some(c=>c.method!=='ls'),false);
});

test('desktop project match does not excuse a worker terminal executing another checkout',async t=>{
  const f=fixture(t);f.native.cwd=f.other;
  await assert.rejects(showWorker(f),/identity|project/i);
  assert.equal(f.calls.some(c=>c.method!=='ls'),false);
});

test('already-visible terminal still requires the original worker/task/process identity',async t=>{
  const f=fixture(t);f.state.spaces[1].tabs.push({id:'old-tab',terminals:[{terminal:'t15'}]});
  f.native.labels['codex.task']='unrelated-task';
  await assert.rejects(showWorker(f),/identity|task/i);
  assert.equal(f.state.spaces[1].tabs.length,1);assert.equal(f.calls.some(c=>c.method!=='ls'),false);
});

test('tab placement refuses a replaced process before changing the desktop',async t=>{
  const f=fixture(t);f.native.pid++;
  await assert.rejects(showWorker(f),/identity|process/i);
  assert.equal(f.calls.some(c=>c.method!=='ls'),false);
});

test('a local target becoming remote after selection is rejected before keep',async t=>{
  const f=fixture(t);f.hooks.selected=state=>state.spaces[1].machine='remote-now';
  await assert.rejects(showWorker(f),/focus changed|local/i);
  assert.equal(f.calls.some(c=>c.method==='terminal.keep'),false);
});

test('worker identity changing during desktop selection is caught before keep',async t=>{
  const f=fixture(t);f.hooks.selected=()=>f.native.cwd=f.other;
  await assert.rejects(showWorker(f),/identity|project/i);
  assert.equal(f.calls.some(c=>c.method==='terminal.keep'),false);
});

test('split tab change during final worker verification is caught before keep',async t=>{
  const f=fixture(t);f.state.spaces[1].tabs.push({id:'anchor',active:true,terminals:[{terminal:'t2'}]});
  f.hooks.native=(count,id,state)=>{if(id==='t15'&&count>1)state.spaces[1].tabs[0].id='changed';};
  await assert.rejects(showWorker({...f,place:'right'}),/active tab changed/);
  assert.equal(f.calls.some(c=>c.method==='terminal.keep'),false);
});

test('unavoidable native focus race is surfaced without moving or closing unrelated tabs',async t=>{
  const f=fixture(t);f.hooks.keep=state=>{for(const space of state.spaces)space.active=space.id==='unrelated';};
  await assert.rejects(showWorker(f),/already visible.*unrelated/);
  assert.equal(f.calls.some(c=>/close|remove|move/.test(c.method)),false);
  // Native keep offers no target-space fence: detect honestly rather than claim prevention.
  assert.equal(f.state.spaces[0].tabs.length,1);
});

test('store refuses mismatched worker project before reservation and keeps task route immutable',t=>{
  const f=fixture(t),store=new Store(':memory:');t.after(()=>store.close());store.saveTask(f.task);
  assert.throws(()=>store.reserveWorker({...f.worker,project:f.other,writePaths:[f.other]}),/project.*task/);
  assert.equal(store.worker(f.worker.id),null);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,0);
  store.reserveWorker({...f.worker,writePaths:[f.project]});
  assert.throws(()=>store.saveWorker({...f.worker,project:f.other}),/project|reassigned/);
  assert.throws(()=>store.saveTask({...f.task,threadId:OTHER}),/reroute/);
  assert.equal(store.worker(f.worker.id).project,f.project);assert.equal(store.task(f.task.id).threadId,THREAD);
});

function delegationFixture(t, options={}) {
  const f=fixture(t),store=new Store(':memory:');t.after(()=>store.close());
  const terminals=new Map(),calls=[];
  const rpc={request:async(method,params)=>{
    calls.push({method,params:structuredClone(params)});
    if(method==='terminal.run'){
      const terminal={address:'t1',state:'live',status:{state:'idle'},turn:0,pid:101,cwd:params.cwd,labels:structuredClone(params.labels),argv:params.argv,keep:params.keep};
      if(options.mutateLaunch)options.mutateLaunch(terminal);
      terminals.set('t1',terminal);return {address:'t1',pid:101};
    }
    if(method==='terminal.list')return {terminals:[...terminals.values()].map(structuredClone)};
    const native=terminals.get(params.terminal);if(!native)throw new Error('Unknown terminal');
    if(method==='terminal.get')return structuredClone(native);
    if(method==='terminal.wait')return {status:native.status,turn:native.turn};
    if(method==='terminal.send'){native.turn++;return {turn:native.turn};}
    throw new Error('Unexpected RPC '+method);
  }};
  const config={stateDir:f.stateDir,packageRoot:f.dir,hc:'/fake/hc',app:'/fake/app',node:process.execPath,profileFile:join(f.dir,'profile.json')};
  const api=new Delegation({config,store,rpc,prepare:async worker=>({argv:['fake-agent'],cwd:options.preparedCwd??worker.project})});
  const input={id:'agent-a',name:'agent-a',project:f.project,threadId:THREAD,instruction:'Perform a scoped test task.'};
  return {...f,store,terminals,calls,api,input};
}

test('relative project input is rejected before creating a task or launching a process',async t=>{
  const f=delegationFixture(t);
  await assert.rejects(f.api.delegate({...f.input,project:'.'}),/absolute/);
  assert.equal(f.store.tasks().length,0);assert.equal(f.calls.length,0);
});

test('project must be a directory before registration, not just a resolvable file',async t=>{
  const f=delegationFixture(t),file=join(f.dir,'source.txt');writeFileSync(file,'test');
  await assert.rejects(f.api.delegate({...f.input,project:file}),/directory/);
  assert.equal(f.store.tasks().length,0);assert.equal(f.calls.length,0);
});

test('prepared launch cannot override its frozen project; no wrong-cwd process is created',async t=>{
  const f=delegationFixture(t,{preparedCwd:'/private/wrong-project'});
  await assert.rejects(f.api.delegate({...f.input,scope:'write'}),/cwd.*project/);
  assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,0);
});

test('explicit existing task with another project or chat fails before native effects',async t=>{
  const f=delegationFixture(t);f.store.saveTask(f.task);
  for(const extra of [{project:f.other},{threadId:OTHER}])await assert.rejects(f.api.delegate({...f.input,...extra,taskId:f.task.id}),/different project\/chat/);
  assert.equal(f.calls.length,0);assert.equal(f.store.workers().length,0);
});

test('wrong native task label is rejected before the initial task instruction is sent',async t=>{
  const f=delegationFixture(t,{mutateLaunch:native=>native.labels['codex.task']='other-task'});
  await assert.rejects(f.api.delegate(f.input),/identity|task/i);
  assert.equal(f.calls.filter(c=>c.method==='terminal.send').length,0);
  assert.equal(f.store.worker('agent-a').launchState,'uncertain');
});

test('task label changing after launch prevents continuation to the wrong task',async t=>{
  const f=delegationFixture(t);await f.api.delegate(f.input);
  f.terminals.get('t1').labels['codex.task']='other-task';
  await assert.rejects(f.api.followup('agent-a','follow-1',{instruction:'Continue the original task.'}),/identity|task/i);
  assert.equal(f.calls.filter(c=>c.method==='terminal.send').length,1);
});
