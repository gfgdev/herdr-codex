import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {showWorker} from '../src/desktop.mjs';

async function fixture(t){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'herdr-desktop-routing-'))),project=join(dir,'project'),other=join(dir,'game');
  await mkdir(project);await mkdir(other);t.after(()=>rm(dir,{recursive:true,force:true}));
  const worker={id:'test-worker',taskId:'test-task',terminalId:'t15',project,launchResult:{pid:1500}};
  const getTerminal=async id=>{
    assert.equal(id,worker.terminalId,'Unexpected native identity lookup');
    return {address:id,state:'live',cwd:project,pid:1500,labels:{'codex.worker':worker.id,'codex.task':worker.taskId}};
  };
  const state={spaces:[{id:'game',name:'Lanternfall',folder:other,active:true,tabs:[]},{id:'test',name:'Test project',folder:project,active:false,tabs:[]}]};
  const calls=[];let pending=false,raceBeforeKeep=false,raceAfterSelect=false;
  const appCall=async(method,args)=>{
    calls.push({method,args:structuredClone(args)});
    if(method==='ls')return structuredClone(state);
    if(method==='space.select'){
      for(const space of state.spaces)space.active=space.id===args.id;
      if(raceAfterSelect)for(const space of state.spaces)space.active=space.id==='game';
      return {id:args.id};
    }
    if(method==='terminal.keep'){
      if(raceBeforeKeep)for(const space of state.spaces)space.active=space.id==='game';
      if(!pending)state.spaces.find(space=>space.active).tabs.push({id:'added-tab',active:true,terminals:[{terminal:args.terminal,pane:'pane1'}]});
      return pending?{pending:true}:{terminal:args.terminal};
    }
    throw new Error('Unexpected method '+method);
  };
  return {dir,project,other,worker,state,calls,appCall,getTerminal,setPending:()=>pending=true,setRaceBeforeKeep:()=>raceBeforeKeep=true,setRaceAfterSelect:()=>raceAfterSelect=true};
}

test('wrong current workspace selects the unique matching project before keep',async t=>{
  const f=await fixture(t),result=await showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal});
  assert.equal(result.status,'shown');assert.equal(result.spaceId,'test');assert.equal(result.verified,true);
  assert.deepEqual(f.calls.filter(x=>x.method!=='ls').map(x=>[x.method,x.args]),[['space.select',{id:'test'}],['terminal.keep',{terminal:'t15',place:'tab'}]]);
  assert.equal(f.state.spaces[0].tabs.length,0);
});

test('missing project space fails with create-space instructions and no mutation',async t=>{
  const f=await fixture(t);f.state.spaces.pop();
  await assert.rejects(showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal}),/space\.new/);
  assert.deepEqual(f.calls.map(x=>x.method),['ls']);
});

test('wrong explicitly selected space fails without changing the desktop',async t=>{
  const f=await fixture(t);
  await assert.rejects(showWorker({worker:f.worker,spaceId:'game',appCall:f.appCall,getTerminal:f.getTerminal}),/does not match/);
  assert.deepEqual(f.calls.map(x=>x.method),['ls']);
});

test('terminal already displayed in the wrong space is rejected without closing or moving it',async t=>{
  const f=await fixture(t);f.state.spaces[0].tabs.push({id:'foreign-tab',terminals:[{terminal:'t15'}]});
  await assert.rejects(showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal}),/already visible.*game/);
  assert.deepEqual(f.calls.map(x=>x.method),['ls']);assert.equal(f.state.spaces[0].tabs[0].id,'foreign-tab');
});

test('terminal already in matching space returns the verified location',async t=>{
  const f=await fixture(t);f.state.spaces[1].tabs.push({id:'existing',terminals:[{terminal:'t15'}]});
  const result=await showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal});
  assert.equal(result.status,'already-visible');assert.equal(result.tabId,'existing');assert.equal(result.verified,true);
  assert.deepEqual(f.calls.map(x=>x.method),['ls']);
});

test('multiple matching project spaces require an explicit ID',async t=>{
  const f=await fixture(t);f.state.spaces.push({id:'test2',folder:f.project,tabs:[]});
  await assert.rejects(showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal}),/explicit space ID/);
  assert.deepEqual(f.calls.map(x=>x.method),['ls']);
  const result=await showWorker({worker:f.worker,spaceId:'test2',appCall:f.appCall,getTerminal:f.getTerminal});assert.equal(result.spaceId,'test2');
});

test('matching uses canonical folder paths',async t=>{
  const f=await fixture(t);const link=join(f.dir,'project-link');await symlink(f.project,link);f.state.spaces[1].folder=link;
  const result=await showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal});assert.equal(result.spaceId,'test');
});

test('pending native receipt does not claim completed visibility',async t=>{
  const f=await fixture(t);f.setPending();const result=await showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal});
  assert.equal(result.status,'pending');assert.equal(result.verified,false);assert.equal(result.spaceId,'test');
});

test('focus changes during selection prevent keep from executing',async t=>{
  const f=await fixture(t);f.setRaceAfterSelect();
  await assert.rejects(showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal}),/focus changed/);
  assert.equal(f.calls.filter(x=>x.method==='terminal.keep').length,0);
});

test('focus race during keep is surfaced and never closes unrelated tabs',async t=>{
  const f=await fixture(t);f.setRaceBeforeKeep();
  await assert.rejects(showWorker({worker:f.worker,appCall:f.appCall,getTerminal:f.getTerminal}),/already visible.*game/);
  assert.equal(f.calls.some(x=>/close|remove/.test(x.method)),false);
});

test('unverified split anchors fail before any desktop change',async t=>{
  const f=await fixture(t);
  await assert.rejects(showWorker({worker:f.worker,place:'right',appCall:f.appCall}),/native identity verification/);
  assert.deepEqual(f.calls,[]);
});

test('split verifies every live anchor against the actual canonical project',async t=>{
  const f=await fixture(t);f.state.spaces[1].tabs.push({id:'existing',active:true,terminals:[{terminal:'t1'},{terminal:'t2'}]});
  const checked=[];
  const result=await showWorker({worker:f.worker,place:'right',appCall:f.appCall,getTerminal:async id=>{if(id===f.worker.terminalId)return f.getTerminal(id);checked.push(id);return {state:'live',cwd:f.project};}});
  assert.equal(result.status,'shown');assert.deepEqual(checked,['t1','t2']);
  assert.equal(f.calls.find(x=>x.method==='terminal.keep').args.place,'right');
});

test('mixed-project split anchors are rejected before keep',async t=>{
  const f=await fixture(t);f.state.spaces[1].tabs.push({id:'mixed',active:true,terminals:[{terminal:'t1'},{terminal:'game-terminal'}]});
  await assert.rejects(showWorker({worker:f.worker,place:'down',appCall:f.appCall,getTerminal:async id=>id===f.worker.terminalId?f.getTerminal(id):({state:'live',cwd:id==='t1'?f.project:f.other})}),/Split anchor game-terminal/);
  assert.equal(f.calls.some(x=>x.method==='terminal.keep'),false);
});

test('split tab changes while checking native anchors prevent keep',async t=>{
  const f=await fixture(t);f.state.spaces[1].tabs.push({id:'existing',active:true,terminals:[{terminal:'t1'}]});
  await assert.rejects(showWorker({worker:f.worker,place:'right',appCall:f.appCall,getTerminal:async id=>{if(id===f.worker.terminalId)return f.getTerminal(id);f.state.spaces[1].tabs[0].id='changed';return {state:'live',cwd:f.project};}}),/active tab changed/);
  assert.equal(f.calls.some(x=>x.method==='terminal.keep'),false);
});
