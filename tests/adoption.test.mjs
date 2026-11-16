import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Adoption} from '../src/adoption.mjs';
import {Delegation} from '../src/delegation.mjs';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {observe} from '../src/attention.mjs';
import {Retirement,COVERAGE,RETIREMENT,storedRetirement} from '../src/retirement.mjs';

const THREAD='00000000-0000-4000-8000-000000000001';
const OTHER='00000000-0000-4000-8000-000000000002';
function fixture(t){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-adoption-unit-'))),project=join(dir,'project'),other=join(dir,'other'),stateDir=join(dir,'state');
  for(const p of [project,other,stateDir])mkdirSync(p);
  writeFileSync(join(project,'source.txt'),'unchanged project');
  const config={version:1,stateDir,packageRoot:dir,node:process.execPath,hc:'/never-execute-hc',codex:'/never-execute-codex',path:join(dir,'config.json')};
  let store=new Store(join(stateDir,'manager.sqlite'));
  const terminals=new Map(),calls=[],hooks={};
  function native(address='t7',extra={}){
    const value={address,pid:700,state:'live',cwd:project,name:'existing-agent',argv:['existing-agent','--selected-model'],
      created_ms:1794550000000,status:{state:'idle'},status_ms:1794550000000,turn:4,parent:null,keep:false,labels:{'user.note':'preserve'},...extra};
    terminals.set(address,value);return value;
  }
  const rpc={request:async(method,params)=>{
    calls.push({method,params:structuredClone(params)});
    if(method==='terminal.list')return {terminals:[...terminals.values()].map(v=>structuredClone(v))};
    const terminal=terminals.get(params.terminal);
    if(!terminal)throw Object.assign(new Error('Missing terminal'),{data:{kind:'not_found'}});
    if(method==='terminal.get'){
      hooks.get?.(terminal,calls.filter(c=>c.method==='terminal.get').length);
      return structuredClone(terminal);
    }
    if(method==='terminal.label'){
      hooks.beforeLabel?.(terminal,params);
      terminal.labels={...terminal.labels,...params.labels};
      if(hooks.failAfterLabel){hooks.failAfterLabel=false;throw new Error('Lost label response after mutation');}
      return structuredClone(terminal);
    }
    throw new Error('Forbidden adoption side effect: '+method);
  }};
  const api=(retirement)=>new Adoption({config,store,rpc,pulse:async()=>{calls.push({method:'registry.pulse'});},retirement});
  const input={id:'adopted-agent',terminalId:'t7',project,threadId:THREAD};
  native();
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,project,other,stateDir,config,terminals,calls,hooks,native,api,input,
    get store(){return store;},reopen(){store.close();store=new Store(join(stateDir,'manager.sqlite'));},
    mutations(){return calls.filter(c=>!['terminal.get','terminal.list','registry.pulse'].includes(c.method));}};
}

test('adoption pins the existing process without prompt, launch, model, permission or project changes',async t=>{
  const f=fixture(t),before=structuredClone(f.terminals.get('t7'));
  const result=await f.api().adopt(f.input),saved=f.store.worker(f.input.id),after=f.terminals.get('t7');
  assert.equal(result.adopted,true);assert.equal(result.registrationState,'attached');assert.equal(result.sandboxEnforced,false);
  assert.equal(result.scope,'write','unknown existing permissions reserve a writer by default');
  assert.equal(result.notifications,'native-lifecycle');
  assert.deepEqual({...after,labels:before.labels},before);
  assert.deepEqual(f.mutations().map(c=>c.method),['terminal.label']);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
  assert.equal(f.store.meta('activation:'+saved.id),null);
  assert.equal(f.store.meta('observation:'+saved.id).pending??null,null,'old idle is not completed work');
  assert.equal(JSON.parse(readFileSync(result.workerConfig)).id,saved.id);
  assert.equal(readFileSync(join(f.project,'source.txt'),'utf8'),'unchanged project');
});

test('explicit read-only adoption is declared rather than sandboxed and creates no writer lease',async t=>{
  const f=fixture(t),result=await f.api().adopt({...f.input,scope:'read-only'});
  assert.equal(result.scope,'read-only');assert.equal(result.sandboxEnforced,false);
  assert.deepEqual(f.store.worker(f.input.id).writePaths,[]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,0);
});

test('documented local alphanumeric terminal addresses are usable while remote aliases are rejected',async t=>{
  const f=fixture(t);f.native('t1b',{pid:701});
  assert.equal((await f.api().adopt({...f.input,terminalId:'t1b'})).terminalId,'t1b');
  for(const terminalId of ['machine/t1b','existing-agent'])await assert.rejects(()=>f.api().adopt({...f.input,id:'reject-'+terminalId.replaceAll('/','-'),terminalId}));
});

test('wrong native project, task chat and Desk bindings fail without native mutation or reservation',async t=>{
  const f=fixture(t);
  await assert.rejects(()=>f.api().adopt({...f.input,project:f.other}),/project/i);
  f.store.saveTask({id:'foreign-task',name:'Other owner',project:f.project,threadId:OTHER,status:'active'});
  await assert.rejects(()=>f.api().adopt({...f.input,taskId:'foreign-task'}),/chat/i);
  const desks=new Desks({store:f.store,config:f.config});
  for(const id of ['desk-a','desk-b']){desks.create({id,name:id,purpose:'Test routing'});desks.projectAdd({deskId:id,id:'project',name:'Project',path:f.project});}
  f.store.saveTask({id:'desk-task',name:'Desk A task',project:f.project,threadId:THREAD,status:'active',deskId:'desk-a',deskProjectId:'project'});
  await assert.rejects(()=>f.api().adopt({...f.input,taskId:'desk-task',deskId:'desk-b',deskProjectId:'project'}),/desk/i);
  await assert.rejects(()=>f.api().adopt({...f.input,deskId:'desk-a',deskProjectId:'home'}),/project/i);
  assert.equal(f.store.workers().length,0);assert.equal(f.mutations().length,0);
});

test('a terminal already registered to any worker or carrying foreign ownership cannot be claimed',async t=>{
  const f=fixture(t);
  f.store.saveTask({id:'owned-task',name:'Owned',project:f.project,threadId:THREAD,status:'active'});
  f.store.reserveWorker({id:'owner',taskId:'owned-task',project:f.project,terminalId:'t7',mailbox:'owner-mailbox',writePaths:[]});
  await assert.rejects(()=>f.api().adopt({...f.input,scope:'read-only'}),/already registered/i);
  f.native('t8',{pid:800,labels:{'codex.worker':'foreign-worker','codex.task':'foreign-task'}});
  await assert.rejects(()=>f.api().adopt({...f.input,terminalId:'t8'}),/ownership/i);
  assert.equal(f.mutations().length,0);assert.equal(f.store.worker(f.input.id),null);
});

test('uncertain label response recovers the same reservation without another label, launch or activation',async t=>{
  const f=fixture(t);f.hooks.failAfterLabel=true;
  await assert.rejects(()=>f.api().adopt(f.input),/Lost label response/);
  const saved=f.store.worker(f.input.id);assert.equal(saved.adoption.state,'prepared');
  const delegation=new Delegation({config:f.config,store:f.store,rpc:{request:async()=>{throw new Error('Must not send before adoption completes');}}});
  await assert.rejects(()=>delegation.followup(f.input.id,'premature',{instruction:'Do work'}),/not attached/);
  const taskCount=f.store.tasks().length;f.reopen();
  const result=await f.api().adopt(f.input);
  assert.equal(result.reused,true);assert.equal(result.registrationState,'attached');
  assert.equal(f.store.tasks().length,taskCount);assert.equal(f.store.workers().length,1);
  assert.deepEqual(f.mutations().map(c=>c.method),['terminal.label']);
  assert.equal(f.store.meta('activation:'+saved.id),null);
  await assert.rejects(()=>f.api().adopt({...f.input,scope:'read-only'}),/different binding/);
});

test('closed identical adoption retry does not touch the terminal or reopen work',async t=>{
  const f=fixture(t),first=await f.api().adopt(f.input);
  const task=f.store.task(first.taskId);f.store.saveTask({...task,status:'closed'});
  const cursor=f.calls.length,result=await f.api().adopt(f.input);
  assert.equal(result.reused,true);assert.equal(result.actionable,false);
  assert.equal(f.calls.length,cursor);assert.equal(f.store.task(first.taskId).status,'closed');
});

test('showing an adopted terminal can change native keep without invalidating its process binding',async t=>{
  const f=fixture(t);await f.api().adopt(f.input);f.terminals.get('t7').keep=true;
  const result=await f.api().adopt(f.input);assert.equal(result.reused,true);assert.equal(result.registrationState,'attached');
  assert.equal(f.terminals.get('t7').keep,true);assert.equal(f.mutations().filter(c=>c.method==='terminal.label').length,1);
});

test('replacement PID or parent identity cannot inherit an adoption reservation',async t=>{
  const f=fixture(t);await f.api().adopt(f.input);
  const terminal=f.terminals.get('t7');terminal.pid++;
  const cursor=f.mutations().length;
  await assert.rejects(()=>f.api().adopt(f.input),/process changed/);
  terminal.pid--;terminal.parent='t9';
  await assert.rejects(()=>f.api().adopt(f.input),/parent/i);
  assert.equal(f.mutations().length,cursor);
});

test('native child discovery is read-only and adoption requires its actual registered parent',async t=>{
  const f=fixture(t),parent=await f.api().adopt(f.input);
  f.native('t8',{pid:800,parent:'t7',name:'child-agent',status:{state:'working'},turn:8,status_ms:1794550010000});
  const cursor=f.mutations().length,children=await f.api().children(f.input.id);
  assert.equal(children.children.length,1);assert.equal(children.children[0].adoptionRequired,true);
  assert.equal(f.store.workers().length,1);assert.equal(f.mutations().length,cursor);
  const child={...f.input,id:'adopted-child',terminalId:'t8',scope:'read-only',taskId:parent.taskId};
  await assert.rejects(()=>f.api().adopt(child),/parent/i);
  await assert.rejects(()=>f.api().adopt({...child,parentId:'absent-parent'}),/parent/i);
  f.native('t9',{pid:900,name:'unrelated-parent'});
  const wrong=await f.api().adopt({...f.input,id:'other-parent',terminalId:'t9',scope:'read-only'});
  await assert.rejects(()=>f.api().adopt({...child,parentId:wrong.agentId}),/does not belong/);
  const result=await f.api().adopt({...child,parentId:f.input.id});
  assert.equal(result.parentId,f.input.id);assert.equal(result.taskId,parent.taskId);
  assert.equal(f.terminals.get('t8').parent,'t7');assert.equal(f.terminals.get('t8').pid,800);
  const observed=f.store.meta('observation:'+child.id);
  assert.equal(observed.working,true);assert.equal(observed.pending??null,null);
  const finished=observe(observed,{...f.terminals.get('t8'),status:{state:'done'},turn:9});
  assert.equal(finished.pending.episode,1);assert.equal(finished.pending.startTurn,8);
  assert.equal((await f.api().children(f.input.id)).children[0].registeredAgentId,child.id);
});

test('ownership changing during native registration is refused without overwriting labels',async t=>{
  const f=fixture(t);
  f.hooks.get=(terminal,count)=>{if(count===2)terminal.labels['codex.worker']='concurrent-owner';};
  await assert.rejects(()=>f.api().adopt(f.input),/ownership changed/i);
  assert.equal(f.mutations().length,0);assert.equal(f.terminals.get('t7').labels['codex.worker'],'concurrent-owner');
  assert.equal(f.store.worker(f.input.id).adoption.state,'prepared');
});

test('default finished adoption retains the reserved lease as pending_retirement without restarting or hiding the binding',async t=>{
  const f=fixture(t);
  f.hooks.get=(terminal,count)=>{if(count===2)terminal.state='finished';};
  await assert.rejects(()=>f.api().adopt(f.input),/identity changed/i);
  const saved=f.store.worker(f.input.id);
  assert.equal(saved.adoption.state,'finished');assert.equal(saved.launchState,'finished');
  // Conservative default: a known matching exit is terminal evidence, but with
  // no trusted containment provider the writer reservation is RETAINED as
  // pending_retirement rather than silently released. The binding is durably
  // preserved so the listener can report one known exit.
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
  const held=storedRetirement(f.store,saved.id);
  assert.equal(held.state,RETIREMENT.PENDING);
  assert.equal(held.reason,'descendant-coverage-unknown');
  assert.equal(held.clearance?.coverage,COVERAGE.UNKNOWN);
  assert.equal(held.binding.workerId,saved.id);
  assert.equal(typeof held.executionId,'string');assert.ok(held.executionId.length>0);
  assert.equal(f.mutations().length,0);assert.equal(f.store.task(saved.taskId).status,'active');
  assert.ok(f.calls.some(c=>c.method==='registry.pulse'),'the listener can report the known exit');
  const cursor=f.calls.length,repeated=await f.api().adopt(f.input);
  assert.equal(repeated.actionable,false);assert.equal(repeated.registrationState,'finished');
  assert.equal(f.calls.length,cursor,'retry does not touch or restart a finished process');
});

test('an explicitly injected complete containment provider releases the finished adoption lease (test double, not a production claim)',async t=>{
  const f=fixture(t);
  f.hooks.get=(terminal,count)=>{if(count===2)terminal.state='finished';};
  // This provider is the trust anchor, not a text label: it is injected at
  // construction, allowlisted, and returns a complete verdict bound to whatever
  // exact execution it is asked about. This test is the ONLY place completeness
  // is manufactured; the default path stays conservative.
  const fakeComplete=({executionId})=>({coverage:COVERAGE.COMPLETE,executionId,source:'test-containment',descendants:[]});
  fakeComplete.source='test-containment';
  const retirement=new Retirement(f.store,{provider:fakeComplete,trustedSources:['test-containment']});
  await assert.rejects(()=>f.api(retirement).adopt(f.input),/identity changed/i);
  const saved=f.store.worker(f.input.id);
  assert.equal(saved.adoption.state,'finished');assert.equal(saved.launchState,'finished');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,0,'injected complete clearance releases the reservation');
  const record=storedRetirement(f.store,saved.id);
  assert.equal(record.state,RETIREMENT.RELEASED);
  assert.equal(record.reason,'adoption-finished');
  assert.equal(record.clearance?.coverage,COVERAGE.COMPLETE);
  assert.equal(record.clearance?.source,'test-containment');
  assert.equal(f.mutations().length,0);
});

test('a finished replacement process cannot release an uncertain original writer reservation',async t=>{
  const f=fixture(t);
  f.hooks.get=(terminal,count)=>{if(count===2){terminal.state='finished';terminal.pid++;}};
  await assert.rejects(()=>f.api().adopt(f.input),/identity changed/i);
  assert.equal(f.store.worker(f.input.id).adoption.state,'prepared');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
  assert.equal(f.mutations().length,0);
});
