import test from 'node:test';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {DeskTriggers} from '../src/desk-triggers.mjs';
const THREAD='00000000-0000-4000-8000-000000000001',BASE=Date.parse('2026-11-13T00:00:00Z');
function fixture(t,{files=false,callback}={}){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-triggers-'))),stateDir=join(dir,'state'),vault=join(dir,'vault');for(const p of [stateDir,vault])mkdirSync(p);
  const config={stateDir},store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});desks.create({id:'desk',name:'Desk',purpose:'Test triggers',vaultPath:vault});
  desks.definitionPut({deskId:'desk',id:'operator',name:'Operator',harness:'pi',scope:'write',instructions:'Work on supplied input.'});desks.workflowPut({deskId:'desk',id:'work',name:'Work',definitionId:'operator',instructions:'Do work.'});if(files)desks.files.scaffold('desk');
  let at=BASE;const calls=[],errors=[],instances=[];
  const make=()=>{const triggers=new DeskTriggers({store,config,clock:()=>at,onError:(e,c)=>errors.push({message:e.message,...c}),createRun:async input=>{calls.push(input);if(callback)return callback(input,{desks,calls});return desks.jobCreate(input);}});instances.push(triggers);return triggers;};
  const triggers=make(),put=(extra={})=>desks.automationPut({deskId:'desk',id:'trigger',type:'event',workflowId:'work',eventName:'document.received',enabled:true,ownerThread:THREAD,...extra});
  const complete=id=>{desks.jobUpdate('desk',id,{status:'running'});desks.jobUpdate('desk',id,{status:'completed',note:'Verified fixture work.'});};
  t.after(async()=>{for(const x of instances)x.stop();await Promise.all(instances.map(x=>x.running?.catch(()=>{})));store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,stateDir,vault,config,store,desks,triggers,make,put,calls,errors,complete,setTime:value=>{at=value;},root:files?desks.files.root('desk'):null};
}
test('events have durable identity and duplicate delivery never creates a new run',async t=>{
  const f=fixture(t);f.put();const input={deskId:'desk',id:'event-1',eventName:'document.received',payload:{reference:'PO-123',amount:25}};
  const first=await f.triggers.emit(input);assert.equal(f.calls.length,1);assert.equal(first.occurrences[0],f.calls[0].id);assert.equal(f.calls[0].ownerThread,THREAD);assert.equal(f.calls[0].workflowVersion,1);
  assert.deepEqual(await f.make().emit({...input,payload:{amount:25,reference:'PO-123'}}),first);assert.equal(f.calls.length,1);
  await assert.rejects(f.triggers.emit({...input,payload:{amount:26}}),/different payload/);assert.equal(f.calls.length,1);
});
test('manual triggers require an explicit automation ID and never run just from pulse',async t=>{
  const f=fixture(t);f.put({id:'manual',type:'manual',eventName:undefined});await f.triggers.pulse();assert.equal(f.calls.length,0);
  await f.triggers.emit({deskId:'desk',id:'manual-request',automationId:'manual',payload:{document:'supplied'}});assert.equal(f.calls.length,1);assert.equal(f.calls[0].parameters.trigger.kind,'manual');
  await assert.rejects(f.triggers.emit({deskId:'desk',id:'wrong',automationId:'manual',eventName:'manual'}),/not both/);
});
test('disabled automation and unmatched events remain inert and cannot later replay into new triggers',async t=>{
  const f=fixture(t);f.put({enabled:false});const input={deskId:'desk',id:'event',eventName:'document.received'};
  assert.deepEqual((await f.triggers.emit(input)).occurrences,[]);f.put();await f.triggers.emit(input);assert.equal(f.calls.length,0);
  await f.triggers.emit({...input,id:'new-event'});assert.equal(f.calls.length,1);
});
test('intervals coalesce downtime into latest slot with missed count and survive restart',async t=>{
  const f=fixture(t);f.put({type:'interval',eventName:undefined,everySeconds:10,startAt:new Date(BASE).toISOString()});await f.triggers.pulse();assert.equal(f.calls.length,1);assert.equal(f.calls[0].parameters.trigger.slot,0);
  f.complete(f.calls[0].id);f.setTime(BASE+105000);await f.make().pulse();assert.equal(f.calls.length,2);assert.equal(f.calls[1].parameters.trigger.slot,10);assert.equal(f.calls[1].parameters.trigger.missedCount,9);
  await f.make().pulse();assert.equal(f.calls.length,2);assert.equal(f.triggers.status('desk').occurrences.length,2);
});
test('future interval start stays dormant and initial late start does not flood jobs',async t=>{
  const f=fixture(t);f.put({type:'interval',eventName:undefined,everySeconds:10,startAt:new Date(BASE+10000).toISOString()});await f.triggers.pulse();assert.equal(f.calls.length,0);
  f.setTime(BASE+1000010);await f.triggers.pulse();assert.equal(f.calls.length,1);assert.equal(f.calls[0].parameters.trigger.missedCount,99);
});
test('overlap skip persists a useful receipt; queue runs only when unsettled work clears',async t=>{
  const f=fixture(t);f.put();await f.triggers.emit({deskId:'desk',id:'one',eventName:'document.received'});await f.triggers.emit({deskId:'desk',id:'two',eventName:'document.received'});assert.equal(f.calls.length,1);assert.equal(f.triggers.status('desk').counts.skipped,1);
  f.put({overlap:'queue'});await f.triggers.emit({deskId:'desk',id:'three',eventName:'document.received'});assert.equal(f.triggers.status('desk').counts.queued,1);assert.equal(f.calls.length,1);
  f.complete(f.calls[0].id);await f.make().pulse();assert.equal(f.calls.length,2);assert.equal(f.calls[1].parameters.trigger.eventId,'three');assert.equal(f.triggers.status('desk').counts.skipped,1);
});
test('concurrent instances claim dispatch intent before callback inserts the job',async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{callback:async(input,{desks})=>{entered();await gate;return desks.jobCreate(input);}});f.put({type:'interval',eventName:undefined,everySeconds:10,startAt:new Date(BASE).toISOString()});
  const first=f.triggers.pulse();await started;await f.make().pulse();assert.equal(f.calls.length,1);release();await first;assert.equal(f.desks.jobs('desk').length,1);
});
test('uncertain callback retries exact occurrence and job ID without duplicating accepted work',async t=>{
  const f=fixture(t,{callback:async(input,{desks,calls})=>{const job=desks.jobCreate(input);if(calls.length===1)throw new Error('Simulated lost acknowledgement');return job;}});f.put();await f.triggers.emit({deskId:'desk',id:'event',eventName:'document.received'});
  assert.equal(f.desks.jobs('desk').length,1);assert.equal(f.triggers.status('desk').counts.pending,1);await f.triggers.pulse();assert.equal(f.calls.length,1);
  f.setTime(BASE+1001);await f.make().pulse();assert.equal(f.calls.length,2);assert.equal(f.calls[0].id,f.calls[1].id);assert.equal(f.desks.jobs('desk').length,1);assert.equal(f.triggers.status('desk').counts.dispatched,1);
});
test('abandoned dispatch intent is reclaimed after process death using the same ID',async t=>{
  const f=fixture(t,{callback:async()=>{throw new Error('Before job creation');}});f.put();const receipt=await f.triggers.emit({deskId:'desk',id:'event',eventName:'document.received'}),id=receipt.occurrences[0],prior=f.triggers._get(id);
  f.triggers._save({...prior,status:'dispatching',claim:{pid:99999999,token:'dead-process'},nextAttemptAt:0});const restarted=f.make();restarted.createRun=async input=>{f.calls.push(input);return f.desks.jobCreate(input);};await restarted.pulse();assert.equal(f.calls.length,2);assert.equal(f.calls[1].id,id);assert.equal(f.desks.jobs('desk').length,1);
});
test('edited disabled or removed authored triggers do not execute queued stale versions',async t=>{
  const f=fixture(t,{files:true});f.put({overlap:'queue'});await f.triggers.emit({deskId:'desk',id:'one',eventName:'document.received'});await f.triggers.emit({deskId:'desk',id:'two',eventName:'document.received'});assert.equal(f.triggers.status('desk').counts.queued,1);
  rmSync(join(f.root,'automations/trigger.yaml'));f.complete(f.calls[0].id);await f.triggers.pulse();assert.equal(f.calls.length,1);assert.equal(f.triggers.status('desk').counts.disabled,1);
});
test('invalid authored definitions block dispatch instead of using historical enabled configuration',async t=>{
  const f=fixture(t,{files:true});f.put({type:'interval',eventName:undefined,everySeconds:10,startAt:new Date(BASE).toISOString()});const path=join(f.root,'workflows/work/WORKFLOW.md'),before=readFileSync(path,'utf8');writeFileSync(path,'invalid frontmatter');
  await f.triggers.pulse();assert.equal(f.calls.length,0);assert.match(f.triggers.status('desk').health.error,/frontmatter/);assert.ok(f.errors.some(e=>e.phase==='configuration'));await f.triggers.pulse();assert.equal(f.errors.filter(e=>e.phase==='configuration').length,1);
  writeFileSync(path,before);await f.triggers.pulse();assert.equal(f.calls.length,1);
});
test('events cannot smuggle unbounded or non-JSON input into run parameters',async t=>{
  const f=fixture(t);f.put();for(const bad of [{amount:Infinity},JSON.parse('{"__proto__":{}}'),{value:'x'.repeat(270000)}])await assert.rejects(f.triggers.emit({deskId:'desk',id:'bad',eventName:'document.received',payload:bad}));assert.equal(f.calls.length,0);
});
test('authored edit notifications enable triggers and stop closes the injected watcher and timer',async t=>{
  const f=fixture(t,{files:true});let notify,closed=0;f.triggers.watchFactory=(path,callback)=>{notify=callback;const watcher=new EventEmitter();watcher.close=()=>{closed++;};return watcher;};f.put({type:'interval',eventName:undefined,everySeconds:10,startAt:new Date(BASE).toISOString(),enabled:false});await f.triggers.start();assert.equal(f.triggers.status('desk').watchedAutomationDirectories,1);assert.equal(f.calls.length,0);
  let resolve;const observed=new Promise(done=>{resolve=done;});const original=f.triggers.createRun;f.triggers.createRun=async input=>{const result=await original(input);resolve();return result;};
  const path=join(f.root,'automations/trigger.yaml');writeFileSync(path,readFileSync(path,'utf8').replace('enabled: false','enabled: true'));notify('change','trigger.yaml');
  let timeout;try{await Promise.race([observed,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Automation file watcher did not run')),2000);})]);}finally{clearTimeout(timeout);}assert.equal(f.calls.length,1);
  f.triggers.stop();assert.equal(closed,1);assert.equal(f.triggers.status('desk').watchedAutomationDirectories,0);assert.equal(f.triggers.status('desk').timerScheduled,false);
});

test('watcher failures are visible and do not pretend authored changes are observed',async t=>{
  const f=fixture(t,{files:true});let watcher;f.triggers.watchFactory=()=>{watcher=new EventEmitter();watcher.close=()=>{};return watcher;};await f.triggers.start();watcher.emit('error',new Error('Fixture watcher unavailable'));
  assert.equal(f.triggers.status('desk').watchedAutomationDirectories,0);assert.match(Object.values(f.triggers.status('desk').watchErrors)[0],/watcher unavailable/);assert.ok(f.errors.some(e=>e.phase==='watch'));
});

test('lost acknowledgement reconciliation is not skipped because unrelated work started meanwhile',async t=>{
  const f=fixture(t,{callback:async(input,{desks,calls})=>{const job=desks.jobCreate(input);if(calls.length===1)throw new Error('Lost acknowledgement');return job;}});f.put();await f.triggers.emit({deskId:'desk',id:'event',eventName:'document.received'});
  f.desks.jobCreate({deskId:'desk',id:'independent',workflowId:'work',ownerThread:THREAD});f.setTime(BASE+1001);await f.make().pulse();assert.equal(f.calls.length,2);assert.equal(f.calls[0].id,f.calls[1].id);assert.equal(f.triggers.status('desk').counts.dispatched,1);assert.equal(f.triggers.status('desk').counts.skipped,undefined);
});
