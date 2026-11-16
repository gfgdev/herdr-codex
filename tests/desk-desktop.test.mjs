import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {showWorker} from '../src/desktop.mjs';

function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-display-')));
  const home=join(root,'desk-home'),project=join(root,'checkout-a'),second=join(root,'checkout-b'),game=join(root,'game');
  for(const path of [home,project,second,game])mkdirSync(path);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const desk={id:'bpm',home,projects:[{id:'a',path:project},{id:'b',path:second}]};
  const worker={id:'worker-a',taskId:'task-a',terminalId:'t1',project,deskId:'bpm',deskProjectId:'a',launchResult:{pid:101}};
  const peer={id:'worker-b',taskId:'task-b',terminalId:'t2',project:second,deskId:'bpm',deskProjectId:'b',launchResult:{pid:102}};
  const native=w=>({state:'live',address:w.terminalId,cwd:w.project,pid:w.launchResult.pid,labels:{'codex.worker':w.id,'codex.task':w.taskId,'codex.desk':w.deskId,'codex.desk-project':w.deskProjectId}});
  const terminals=new Map([[worker.terminalId,native(worker)],[peer.terminalId,native(peer)]]),workers=new Map([[worker.terminalId,worker],[peer.terminalId,peer]]);
  const state={spaces:[{id:'game',name:'Game',folder:game,active:true,tabs:[]},{id:'project',folder:project,active:false,tabs:[]},{id:'desk',name:'BPM',folder:home,active:false,tabs:[]}]};
  const calls=[],hooks={};let reads=0;
  const appCall=async(method,args)=>{
    calls.push({method,args:structuredClone(args)});
    if(method==='ls'){hooks.inventory?.(++reads,state);return structuredClone(state);}
    if(method==='space.select'){for(const s of state.spaces)s.active=s.id===args.id;hooks.selected?.(state);return {id:args.id};}
    if(method==='terminal.keep'){
      hooks.keep?.(state);
      if(!hooks.pending)state.spaces.find(s=>s.active).tabs.push({id:'added',active:true,terminals:[{terminal:args.terminal}]});
      return hooks.pending?{pending:true}:{terminal:args.terminal};
    }
    throw new Error('Unexpected native operation '+method);
  };
  const getTerminal=async id=>{hooks.native?.(id,terminals,state);return structuredClone(terminals.get(id));};
  const getRegisteredWorker=async id=>{hooks.lookup?.(id,workers);return structuredClone(workers.get(id)??null);};
  return {root,home,project,second,game,desk,worker,peer,state,calls,hooks,terminals,workers,appCall,getTerminal,getRegisteredWorker};
}
const effects=f=>f.calls.filter(c=>c.method!=='ls');

test('file-managed display uses actual Desk files while native worker retains execution project',async t=>{
  for(const legacy of [false,true]){
    const f=fixture(t),files=join(f.root,'Desk');mkdirSync(files);f.desk.fileTemplate={enabled:true,root:files};
    if(!legacy)f.state.spaces[2].folder=files;
    const result=await showWorker(f);
    assert.equal(result.spaceId,'desk');assert.equal(result.displayFolder,files);assert.equal(result.project,f.project);
    assert.equal(f.terminals.get('t1').cwd,f.project);assert.equal(f.state.spaces[0].tabs.length,0);
  }
});

test('file-managed display rejects ambiguous new and legacy desk spaces',async t=>{
  const f=fixture(t),files=join(f.root,'Desk');mkdirSync(files);f.desk.fileTemplate={enabled:true,root:files};
  f.state.spaces.push({id:'new-desk',folder:files,tabs:[]});
  await assert.rejects(showWorker(f),/explicit space ID/);assert.deepEqual(effects(f),[]);
});

test('registered desk routes its agent to desk home while preserving actual execution project',async t=>{
  const f=fixture(t),result=await showWorker(f);
  assert.equal(result.spaceId,'desk');assert.equal(result.status,'shown');assert.equal(result.verified,true);
  assert.equal(result.project,f.project);assert.equal(result.displayFolder,f.home);assert.equal(result.deskId,'bpm');assert.equal(result.deskProjectId,'a');
  assert.deepEqual(effects(f).map(c=>c.method),['space.select','terminal.keep']);
  assert.equal(f.state.spaces[0].tabs.length,0);assert.equal(f.state.spaces[1].tabs.length,0);
  assert.equal(f.terminals.get('t1').cwd,f.project);
});

test('same worker without a desk display request retains ordinary project placement',async t=>{
  const f=fixture(t),result=await showWorker({...f,desk:undefined});
  assert.equal(result.spaceId,'project');assert.equal(result.project,f.project);assert.equal(result.deskId,undefined);
});

test('a general worker cannot use a desk home as an arbitrary folder override',async t=>{
  const f=fixture(t);delete f.worker.deskId;delete f.worker.deskProjectId;
  await assert.rejects(showWorker(f),/matching registered worker desk/);assert.deepEqual(f.calls,[]);
});

test('another desk identity is rejected before reading or mutating desktop',async t=>{
  const f=fixture(t);f.worker.deskId='other-client';
  await assert.rejects(showWorker(f),/matching registered worker desk/);assert.deepEqual(f.calls,[]);
});

test('worker project must equal its specific registered desk project',async t=>{
  const f=fixture(t);f.worker.deskProjectId='b';
  await assert.rejects(showWorker(f),/registered execution project/);assert.deepEqual(f.calls,[]);
});

test('missing desk project and noncanonical home are rejected without native effects',async t=>{
  const f=fixture(t);f.desk.projects=[];
  await assert.rejects(showWorker(f),/registered execution project/);
  f.desk.projects=[{id:'a',path:f.project}];const alias=join(f.root,'alias');symlinkSync(f.home,alias);f.desk.home=alias;
  await assert.rejects(showWorker(f),/desk home must be canonical/);assert.deepEqual(f.calls,[]);
});

test('desk display does not bypass native process, cwd or task identity checks',async t=>{
  const f=fixture(t);f.terminals.get('t1').cwd=f.game;
  await assert.rejects(showWorker(f),/native identity/);assert.deepEqual(f.calls,[]);
  f.terminals.get('t1').cwd=f.project;f.terminals.get('t1').labels['codex.task']='foreign-task';
  await assert.rejects(showWorker(f),/native identity/);assert.deepEqual(f.calls,[]);
});

test('desk display refuses an explicit checkout space and a remote same-folder space',async t=>{
  const f=fixture(t);
  await assert.rejects(showWorker({...f,spaceId:'project'}),/registered desk home/);
  f.state.spaces[2].machine='remote-host';
  await assert.rejects(showWorker({...f,spaceId:'desk'}),/local desktop space/);assert.deepEqual(effects(f),[]);
});

test('missing desk space explains exact home creation and never uses selected game',async t=>{
  const f=fixture(t);f.state.spaces.pop();
  await assert.rejects(showWorker(f),error=>/space.new/.test(error.message)&&error.message.includes(f.home));
  assert.deepEqual(effects(f),[]);
});

test('multiple local spaces for the same desk require explicit selection',async t=>{
  const f=fixture(t);f.state.spaces.push({id:'desk-copy',folder:f.home,tabs:[]});
  await assert.rejects(showWorker(f),/explicit space ID/);assert.deepEqual(effects(f),[]);
  const result=await showWorker({...f,spaceId:'desk-copy'});assert.equal(result.spaceId,'desk-copy');
});

test('desk split permits another project only through registered same-desk native identity',async t=>{
  const f=fixture(t);f.state.spaces[2].tabs.push({id:'peer-tab',active:true,terminals:[{terminal:'t2'}]});
  const result=await showWorker({...f,place:'right'});assert.equal(result.status,'shown');assert.equal(result.spaceId,'desk');
  assert.equal(effects(f).at(-1).args.place,'right');assert.equal(f.terminals.get('t2').cwd,f.second);
});

test('desk split rejects unregistered and foreign-desk anchors before keep',async t=>{
  const f=fixture(t);f.state.spaces[2].tabs.push({id:'peer-tab',active:true,terminals:[{terminal:'t2'}]});
  f.workers.delete('t2');await assert.rejects(showWorker({...f,place:'right'}),/does not match this desk/);
  f.workers.set('t2',{...f.peer,deskId:'other-client'});
  await assert.rejects(showWorker({...f,place:'right'}),/does not match this desk/);
  assert.equal(effects(f).some(c=>c.method==='terminal.keep'),false);
});

test('desk split cannot rely on cwd alone and requires registry lookup',async t=>{
  const f=fixture(t);f.state.spaces[2].tabs.push({id:'peer-tab',active:true,terminals:[{terminal:'t2'}]});
  await assert.rejects(showWorker({...f,place:'right',getRegisteredWorker:undefined}),/registered-worker lookup/);
  f.terminals.get('t2').pid=500;
  await assert.rejects(showWorker({...f,place:'right'}),/native identity/);assert.equal(effects(f).some(c=>c.method==='terminal.keep'),false);
});

test('desk focus change during selection prevents keep and never moves a game tab',async t=>{
  const f=fixture(t);f.hooks.selected=state=>{for(const s of state.spaces)s.active=s.id==='game';};
  await assert.rejects(showWorker(f),/focus changed/);assert.equal(effects(f).some(c=>c.method==='terminal.keep'),false);
  assert.equal(f.state.spaces[0].tabs.length,0);
});

test('last-moment native desk placement race is reported without repairing unrelated tabs',async t=>{
  const f=fixture(t);f.hooks.keep=state=>{for(const s of state.spaces)s.active=s.id==='game';};
  await assert.rejects(showWorker(f),/already visible.*game/);
  assert.equal(effects(f).some(c=>/close|move|remove/.test(c.method)),false);
});

test('pending desk placement retains actual project and does not claim visibility',async t=>{
  const f=fixture(t);f.hooks.pending=true;const result=await showWorker(f);
  assert.equal(result.status,'pending');assert.equal(result.verified,false);assert.equal(result.deskId,'bpm');assert.equal(result.project,f.project);
});
