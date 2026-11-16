import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Delegation} from '../src/delegation.mjs';
import {WorkflowRuns,artifactEvidence} from '../src/desk-runs.mjs';
import {DeskCommands,renderInputs} from '../src/desk-commands.mjs';
import {digest} from '../src/config.mjs';
import {Supervision} from '../src/supervision.mjs';
import {RETIREMENT,Retirement,storedRetirement} from '../src/retirement.mjs';

// A test-only explicit fake-complete containment provider. It echoes the
// execution identity it is asked about and reports a well-formed, empty
// descendant array. The trusted-source wiring below is what makes the verdict
// count: copying a `complete` label alone mints nothing.
const completeProvider=({executionId})=>({coverage:'complete',source:'fixture-containment',executionId,descendants:[]});
const retirementFor=store=>new Retirement(store,{provider:completeProvider,trustedSources:['fixture-containment']});

const THREAD='00000000-0000-4000-8000-000000000001';
function fixture(t){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'desk-runs-unit-'))),stateDir=join(dir,'state');mkdirSync(stateDir);
 const config={stateDir,path:join(dir,'config.json'),packageRoot:join(dir,'package'),node:process.execPath,hc:'/never-run-hc',app:'/never-run-app',codex:'/never-run-codex',profileFile:join(dir,'profile.json')};
 writeFileSync(config.profileFile,JSON.stringify({python:'/never-run-python'}));
 const path=join(stateDir,'manager.sqlite');let store=new Store(path),desks=new Desks({store,config});
 desks.create({id:'desk',name:'Fixture Desk',purpose:'Test frozen coding, research and operations procedures'});
 for(const [id,harness] of [['implementer','pi'],['researcher','goose'],['operator','pi']])desks.definitionPut({deskId:'desk',id,name:id,harness,scope:'write',writeMode:'task',instructions:'Original '+id+' role instructions.',resourceIds:[]});
 desks.definitionPut({deskId:'desk',id:'reviewer',name:'Reviewer',harness:'goose',scope:'read-only',instructions:'Verify actual supplied evidence.',authority:{delegateRoles:[],reviewRoles:['implementer','researcher','operator']}});
 const terminals=new Map(),calls=[];let loseRun=false,failPrepare=false;
 const rpc={request:async(method,params)=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='terminal.run'){
   const address='t'+(terminals.size+1),native={address,pid:5000+terminals.size,state:'live',cwd:params.cwd,argv:params.argv,name:params.name,labels:params.labels,keep:params.keep,turn:0,status:{state:'idle'}};terminals.set(address,native);
   if(loseRun){loseRun=false;throw new Error('Native creation accepted but its receipt was lost');}return {address,pid:native.pid};
  }
  if(method==='terminal.list')return {terminals:[...terminals.values()].filter(n=>!params.labels||Object.entries(params.labels).every(([key,value])=>n.labels[key]===value))};
  const native=terminals.get(params.terminal);if(!native)throw Object.assign(new Error('No native terminal'),{data:{kind:'not_found'}});
  if(method==='terminal.get')return structuredClone(native);
  if(method==='terminal.wait')return {turn:native.turn,status:native.status};
  if(method==='terminal.send'){native.status={state:'working'};return {turn:native.turn,started:true};}
  if(method==='terminal.kill'){native.state='finished';native.exit_code=143;return {killed:true};}
  throw new Error('Unexpected native method '+method);
 }};
 const prepare=async worker=>{if(failPrepare){failPrepare=false;throw new Error('Known fixture preparation failure before any launch');}mkdirSync(join(worker.stateDir,'runtime'),{recursive:true});return {argv:['/fake-worker',worker.id],cwd:worker.project};};
 // One shared retirement service per fixture, threaded through every factory so
 // production and test runtimes use the same guarded release point.
 let retirement=retirementFor(store);
 const options=()=>({store,config,rpc,pulse:async()=>{},retirement}),delegation=()=>new Delegation({...options(),prepare});
 const engine=()=>new WorkflowRuns({...options(),delegationFactory:opts=>new Delegation({...opts,prepare}),commandsFactory:opts=>new DeskCommands(opts)});
 function workflow(id,steps){return desks.workflowPut({deskId:'desk',id,name:id,instructions:'Use frozen inputs and return evidence.',steps});}
 function scaffold(){if(!desks.files.registration('desk')?.enabled)desks.files.scaffold('desk');}
 const create=async(id,workflowId,parameters={})=>{scaffold();const result=await engine().create({deskId:'desk',id,workflowId,ownerThread:THREAD,parameters});await engine().pulse();return result;};
 function stepWorker(runId,stepId){return store.worker(engine().get('desk',runId).steps[stepId].workerId);}
 function finish(worker,{exitCode,working=false}={}){const native=terminals.get(worker.terminalId);native.status={state:working?'working':'done'};native.turn++;if(exitCode!==undefined){native.state='finished';native.exit_code=exitCode;}return native;}
 function report(worker,id,{accepted=false,kind='result'}={}){
  const m={id,taskId:worker.taskId,workerId:worker.id,terminalId:worker.terminalId,kind,text:'Observed fixture evidence.',turn:terminals.get(worker.terminalId).turn,createdAt:new Date().toISOString()};store.ingest(worker,m);
  if(accepted){store.recordAction(id,{kind:'accept',text:'Independently checked the fixture output.',requestId:'accept-'+id});store.ack(id);}return m;
 }
 // An intentional stop (retire/cancel) writes ONE durable lifecycle notice on the
 // worker's task. Closing that task is gated on the report being actioned and
 // acknowledged, exactly like any other step message -- it is never silently
 // acknowledged or erased by the runtime.
 function acknowledgeStop(worker,requestId='review-intentional-stop'){
  for(const m of store.messages({taskId:worker.taskId,pending:true}))if(m.id.startsWith('stopped-')){
   store.recordAction(m.id,{kind:'accept',requestId:requestId+'-'+m.id,text:'Reviewed the intentional-stop lifecycle notice for '+worker.id+'.'});store.ack(m.id);
  }
 }
 function receipt(worker,{code=0,signal=null,...extra}={}){
  const result={version:1,workerId:worker.id,taskId:worker.taskId,terminalId:worker.terminalId,pid:worker.launchResult.pid,fingerprint:worker.command?.fingerprint,exitCode:code,signal,logs:{},...extra};
  const dir=join(worker.stateDir,worker.executionReceiptVersion===1?'execution':'runtime');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'command-result.json'),JSON.stringify(result));return result;
 }
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,stateDir,config,rpc,calls,terminals,workflow,create,engine,delegation,stepWorker,finish,report,acknowledgeStop,receipt,scaffold,prepare,
  get store(){return store;},get desks(){return desks;},loseRun(){loseRun=true;},failPrepare(){failPrepare=true;},reopen(){store.close();store=new Store(path);desks=new Desks({store,config});retirement=retirementFor(store);}};
}
const agent=(id,definitionId='implementer',dependsOn=[])=>({id,kind:'agent',definitionId,dependsOn,instructions:'Complete '+id+' using input {{inputs.subject}}.'});

test('coding DAG waits for accepted evidence, verifies authored commands and preserves frozen role/workflow versions',async t=>{
 const f=fixture(t);const workflow=f.workflow('coding',[agent('implement'),{id:'verify',kind:'command',definitionId:'operator',dependsOn:['implement'],command:{argv:['{{node}}','--version']}}]);
 await f.create('coding-run','coding',{subject:'stdin handling'});const initial=f.engine().get('desk','coding-run');assert.equal(initial.steps.implement.status,'running');assert.equal(initial.steps.verify.status,'pending');
 const implementation=f.stepWorker('coding-run','implement');assert.equal(implementation.deskDefinitionVersion,1);assert.match(f.calls.find(c=>c.method==='terminal.send').params.text,/stdin handling/);
 f.desks.definitionPut({deskId:'desk',id:'implementer',name:'implementer',harness:'pi',scope:'write',writeMode:'task',instructions:'Changed future instructions.',resourceIds:[]});
 f.workflow('coding',[agent('different')]);assert.equal(f.desks.job('desk','coding-run').snapshot.workflow.version,workflow.version);assert.equal(f.desks.job('desk','coding-run').snapshot.definitions['implementer@1'].instructions,'Original implementer role instructions.');
 f.finish(implementation);f.report(implementation,'implementation-result');await f.engine().pulse();assert.equal(f.engine().get('desk','coding-run').steps.verify.status,'pending');
 const output=join(implementation.delegation.spec.deskWorkspace.outputs,'result.txt');writeFileSync(output,'Verified change');
 f.store.recordAction('implementation-result',{kind:'accept',requestId:'accept-implementation',text:'Read source and ran actual checks.'});f.store.ack('implementation-result');await f.engine().pulse();
 f.acknowledgeStop(implementation);await f.engine().pulse();
 let run=f.engine().get('desk','coding-run');assert.equal(run.steps.implement.status,'completed');assert.equal(run.steps.verify.status,'running');assert.equal(run.steps.implement.artifacts.find(e=>e.path===output).sha256,digest('Verified change'));
 assert.equal(f.store.task(implementation.taskId).status,'closed');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(implementation.id).n,0);
 const command=f.stepWorker('coding-run','verify');f.receipt(command);f.finish(command,{exitCode:0});await f.engine().workerFinished(command,f.terminals.get(command.terminalId));await f.engine().pulse();
 run=f.engine().get('desk','coding-run');assert.equal(run.status,'completed');assert.equal(f.desks.job('desk','coding-run').status,'completed');assert.equal(f.store.messages({taskId:run.controlTaskId}).filter(m=>m.kind==='result').length,1);
 const launches=f.calls.filter(c=>c.method==='terminal.run').length;f.reopen();await f.engine().pulse();await f.engine().create({deskId:'desk',id:'coding-run',workflowId:'coding',workflowVersion:workflow.version,ownerThread:THREAD,parameters:{subject:'stdin handling'}});assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,launches);
});

test('research and operations branches run independently while review waits for both accepted results',async t=>{
 const f=fixture(t);f.workflow('cross-function',[agent('research','researcher'),agent('operate','operator'),{id:'review',kind:'review',definitionId:'reviewer',dependsOn:['research','operate'],instructions:'Compare the accepted source evidence.'}]);
 await f.create('cross-run','cross-function',{subject:'supplier onboarding'});let run=f.engine().get('desk','cross-run');assert.equal(run.steps.research.status,'running');assert.equal(run.steps.operate.status,'running');assert.equal(run.steps.review.status,'pending');
 for(const id of ['research','operate']){const worker=f.stepWorker('cross-run',id);f.finish(worker);f.report(worker,id+'-result',{accepted:true});await f.engine().pulse();f.acknowledgeStop(worker);await f.engine().pulse();if(id==='research')assert.equal(f.engine().get('desk','cross-run').steps.review.status,'pending');}
 run=f.engine().get('desk','cross-run');assert.equal(run.steps.review.status,'running');const reviewer=f.stepWorker('cross-run','review');assert.equal(reviewer.deskDefinitionId,'reviewer');
 f.finish(reviewer);f.report(reviewer,'review-result',{accepted:true});await f.engine().pulse();f.acknowledgeStop(reviewer);await f.engine().pulse();assert.equal(f.engine().get('desk','cross-run').status,'completed');
});

test('lost native launch receipt blocks once, survives restart and prevents blind retry',async t=>{
 const f=fixture(t);f.workflow('uncertain',[agent('work')]);f.loseRun();await f.create('uncertain-run','uncertain',{subject:'lease recovery'});
 let run=f.engine().get('desk','uncertain-run');assert.equal(run.status,'blocked');assert.equal(run.steps.work.status,'blocked');const worker=f.stepWorker('uncertain-run','work');assert.equal(worker.launchState,'uncertain');
 const incidents=f.store.messages({taskId:run.controlTaskId});assert.equal(incidents.length,1);assert.equal(incidents[0].origin,'desk-runtime');assert.equal(incidents[0].terminalId,null);
 f.reopen();await f.engine().pulse();await f.engine().pulse();await assert.rejects(()=>f.engine().retry({deskId:'desk',id:'uncertain-run',stepId:'work',requestId:'retry-1',note:'Inspect the uncertain launch first.'}),/uncertainty/);
 assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);
});

test('failed deterministic command preserves failure evidence and issues only one incident',async t=>{
 const f=fixture(t);f.workflow('failure',[{id:'check',kind:'command',definitionId:'operator',command:{argv:['/fake/check']}}]);await f.create('failed-run','failure');
 const worker=f.stepWorker('failed-run','check');f.receipt(worker,{code:7});f.finish(worker,{exitCode:7});await f.engine().workerFinished(worker,f.terminals.get(worker.terminalId));await f.engine().pulse();await f.engine().pulse();
 const run=f.engine().get('desk','failed-run');assert.equal(run.status,'blocked');assert.equal(run.steps.check.status,'failed');assert.equal(run.steps.check.execution.exit.code,7);assert.equal(f.store.messages({taskId:run.controlTaskId}).length,1);
 await assert.rejects(()=>f.engine().decide({deskId:'desk',id:run.id,stepId:'check',action:'accept',requestId:'invalid-accept',note:'Cannot turn an exit failure into success.'}),/unsuccessful/);
});

test('a receipt written before native exit cannot prematurely accept or block a running command',async t=>{
 const f=fixture(t);f.workflow('early',[{id:'check',kind:'command',definitionId:'operator',command:{argv:['/fake/check']}}]);await f.create('early-run','early');
 const worker=f.stepWorker('early-run','check');f.terminals.get(worker.terminalId).status={state:'working'};f.receipt(worker);
 await f.engine().pulse();const run=f.engine().get('desk','early-run');assert.equal(run.status,'running');assert.equal(run.steps.check.status,'running');assert.equal(f.calls.filter(c=>c.method==='terminal.kill').length,0);assert.equal(f.store.messages({taskId:run.controlTaskId}).length,0);
});

test('manual acceptance cannot turn a finished command with missing execution receipt into success',async t=>{
 const f=fixture(t);f.workflow('missing-receipt',[{id:'check',kind:'command',definitionId:'operator',command:{argv:['/fake/check']}}]);await f.create('missing-receipt-run','missing-receipt');
 const worker=f.stepWorker('missing-receipt-run','check');f.finish(worker,{exitCode:7});
 await assert.rejects(()=>f.engine().decide({deskId:'desk',id:'missing-receipt-run',stepId:'check',action:'accept',requestId:'missing-receipt-accept',note:'A controlled command needs actual execution evidence.'}),/receipt|execution|unsuccessful/i);
 f.report(worker,'missing-receipt-result',{accepted:true});
 await f.engine().pulse();await f.engine().pulse();const run=f.engine().get('desk','missing-receipt-run');assert.equal(run.status,'blocked');assert.equal(run.steps.check.status,'blocked');assert.equal(f.store.task(worker.taskId).status,'active');assert.match(run.steps.check.error,/execution ended without/);assert.equal(f.store.messages({taskId:run.controlTaskId}).length,1);
});

test('structured work binds its control task and needs consolidated acceptance before becoming done',async t=>{
 const f=fixture(t);f.workflow('tracked',[agent('work')]);f.desks.workCreate({deskId:'desk',id:'tracked-work',title:'Tracked request',brief:'Keep one authoritative work status.',ownerThread:THREAD});f.scaffold();
 const input={deskId:'desk',id:'tracked-run',workflowId:'tracked',workId:'tracked-work',ownerThread:THREAD,parameters:{subject:'tracked lifecycle'}};
 await f.engine().create(input);await f.engine().pulse();let run=f.engine().get('desk',input.id),work=f.desks.work('desk',input.workId);
 assert.equal(run.workId,input.workId);assert.equal(f.store.task(run.controlTaskId).deskWorkId,input.workId);assert.equal(work.taskId,run.controlTaskId);assert.equal(work.agentId,null);assert.equal(work.status,'running');
 const worker=f.stepWorker(input.id,'work');assert.notEqual(worker.taskId,work.taskId);assert.equal(worker.deskWorkId??null,null);
 f.finish(worker);f.report(worker,'tracked-worker-result');await f.engine().pulse();assert.equal(f.desks.work('desk',input.workId).status,'review');
 f.store.recordAction('tracked-worker-result',{kind:'accept',requestId:'tracked-worker-accept',text:'Verified step evidence.'});f.store.ack('tracked-worker-result');await f.engine().pulse();f.acknowledgeStop(worker);await f.engine().pulse();run=f.engine().get('desk',input.id);assert.equal(run.status,'completed');assert.equal(f.desks.work('desk',input.workId).status,'review');
 const result=f.store.messages({taskId:run.controlTaskId}).find(m=>m.kind==='result');f.store.recordAction(result.id,{kind:'accept',requestId:'tracked-final-accept',text:'Verified the consolidated requested outcome.'});await f.engine().pulse();assert.equal(f.desks.work('desk',input.workId).status,'review');
 f.store.ack(result.id);await f.engine().pulse();work=f.desks.work('desk',input.workId);assert.equal(work.status,'done');assert.match(work.note,/tracked-final-accept/);assert.equal(f.store.task(run.controlTaskId).status,'closed');assert.equal(f.engine().get('desk',input.id).acceptedAt,f.store.message(result.id).acknowledgedAt);
 const launches=f.calls.filter(c=>c.method==='terminal.run').length;f.reopen();await f.engine().pulse();await f.engine().create(input);await f.engine().pulse();assert.deepEqual(f.desks.work('desk',input.workId),work);assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,launches);
});

test('structured work tracks blocked, explicit retry and cancellation only after messages are resolved',async t=>{
 const f=fixture(t);f.workflow('tracked',[agent('work')]);f.desks.workCreate({deskId:'desk',id:'tracked-work',title:'Tracked request',brief:'Exercise repair and cancellation.',ownerThread:THREAD});f.scaffold();f.failPrepare();
 const input={deskId:'desk',id:'tracked-run',workflowId:'tracked',workId:'tracked-work',ownerThread:THREAD,parameters:{subject:'repair lifecycle'}};await f.engine().create(input);await f.engine().pulse();let run=f.engine().get('desk',input.id);assert.equal(f.desks.work('desk',input.workId).status,'blocked');
 for(const message of f.store.messages({taskId:run.controlTaskId,pending:true})){f.store.recordAction(message.id,{kind:'accept',requestId:'inspect-'+message.id,text:'Inspected the known unstarted preparation failure.'});f.store.ack(message.id);}
 await f.engine().retry({deskId:'desk',id:input.id,stepId:'work',requestId:'tracked-retry',note:'Corrected the isolated preparation failure.'});assert.equal(f.desks.work('desk',input.workId).status,'running');await f.engine().pulse();const worker=f.stepWorker(input.id,'work');f.finish(worker);f.report(worker,'tracked-question',{kind:'question'});
 const bound=await f.engine().cancel({deskId:'desk',id:input.id,requestId:'tracked-cancel',note:'The user cancelled the requested work.'});assert.equal(bound.status,'cancelling');assert.equal(f.desks.work('desk',input.workId).status,'running');assert.equal(f.store.task(run.controlTaskId).status,'active');
 f.store.recordAction('tracked-question',{kind:'abort',requestId:'question-abort',text:'The requested work is cancelled.'});f.store.ack('tracked-question');f.acknowledgeStop(worker);await f.engine().cancel({deskId:'desk',id:input.id,requestId:'tracked-cancel',note:'The user cancelled the requested work.'});const work=f.desks.work('desk',input.workId);assert.equal(work.status,'cancelled');assert.equal(f.store.task(run.controlTaskId).status,'closed');
 f.reopen();await f.engine().pulse();assert.deepEqual(f.desks.work('desk',input.workId),work);
});

test('interrupted work registration rolls back control binding and replays once',async t=>{
 const f=fixture(t);f.workflow('tracked',[agent('work')]);f.desks.workCreate({deskId:'desk',id:'tracked-work',title:'Tracked request',brief:'Recover registration atomically.',ownerThread:THREAD});f.scaffold();
 const engine=f.engine(),input={deskId:'desk',id:'tracked-run',workflowId:'tracked',workId:'tracked-work',ownerThread:THREAD,parameters:{subject:'registration'}};const update=engine.desks.workUpdate.bind(engine.desks);let once=true;engine.desks.workUpdate=(...args)=>{const result=update(...args);if(once&&args[2].taskId){once=false;throw new Error('Injected work binding interruption');}return result;};
 await assert.rejects(()=>engine.create(input),/binding interruption/);assert.equal(engine.get('desk',input.id),null);assert.equal(f.desks.work('desk',input.workId).status,'planned');assert.equal(f.desks.work('desk',input.workId).taskId,null);assert.equal(f.store.tasks().length,0);
 const run=await engine.create(input);assert.equal(f.desks.work('desk',input.workId).taskId,run.controlTaskId);assert.equal(f.desks.work('desk',input.workId).status,'running');assert.equal(f.store.tasks().length,1);
});

test('legacy control tasks without work identity remain untouched and expose an inspectable binding warning',async t=>{
 const f=fixture(t);f.workflow('tracked',[agent('work')]);f.desks.workCreate({deskId:'desk',id:'tracked-work',title:'Old request',brief:'Do not silently rewrite legacy identity.',ownerThread:THREAD});f.scaffold();
 const input={deskId:'desk',id:'legacy-run',workflowId:'tracked',workId:'tracked-work',ownerThread:THREAD,parameters:{subject:'legacy binding'}},job=f.desks.jobCreate(input),task={id:'legacy-control',name:'Legacy workflow',project:job.snapshot.project.path,threadId:THREAD,deskId:'desk',deskProjectId:job.projectId,deskRunId:input.id,status:'active'};f.store.saveTask(task);
 f.engine().save({version:1,deskId:'desk',id:input.id,workflowId:'tracked',workflowVersion:job.workflowVersion,ownerThread:THREAD,controlTaskId:task.id,status:'running',steps:{work:{id:'work',attempt:1,status:'pending'}}});await f.engine().create(input);
 assert.deepEqual(f.store.task(task.id),task);assert.equal(f.desks.work('desk',input.workId).taskId,null);assert.equal(f.desks.work('desk',input.workId).status,'planned');assert.equal(f.engine().get('desk',input.id).workBinding.status,'legacy-unbound');assert.equal(f.calls.length,0);
});

test('completed run without work closes only after consolidated acceptance and every control message acknowledgement',async t=>{
 const f=fixture(t);f.workflow('untracked',[agent('work')]);await f.create('untracked-run','untracked',{subject:'acceptance'});const worker=f.stepWorker('untracked-run','work');f.finish(worker);f.report(worker,'untracked-worker-result',{accepted:true});await f.engine().pulse();f.acknowledgeStop(worker);await f.engine().pulse();let run=f.engine().get('desk','untracked-run');const result=f.store.messages({taskId:run.controlTaskId}).find(m=>m.kind==='result');
 assert.equal(f.store.task(run.controlTaskId).status,'active');f.store.recordAction(result.id,{kind:'accept',requestId:'untracked-final-accept',text:'Verified the whole requested outcome.'});f.store.ack(result.id);
 f.store.ingestSystem(f.store.task(run.controlTaskId),{id:'late-runtime-attention',taskId:run.controlTaskId,workerId:'',terminalId:null,origin:'desk-runtime',kind:'attention',text:'Review the late diagnostic before closure.'});await f.engine().pulse();assert.equal(f.store.task(run.controlTaskId).status,'active');assert.equal(f.engine().get('desk',run.id).acceptedAt,undefined);
 f.store.recordAction('late-runtime-attention',{kind:'accept',requestId:'late-diagnostic-accept',text:'Inspected the late diagnostic.'});f.store.ack('late-runtime-attention');await f.engine().pulse();run=f.engine().get('desk',run.id);assert.equal(f.store.task(run.controlTaskId).status,'closed');assert.equal(run.acceptedAt,f.store.message(result.id).acknowledgedAt);assert.equal(run.acceptance.requestId,'untracked-final-accept');
 const count=f.store.messages().length;f.reopen();await f.engine().pulse();assert.equal(f.store.messages().length,count);assert.equal(f.engine().get('desk',run.id).acceptedAt,run.acceptedAt);
});

test('rejected consolidated result leaves its control task active for an explicit manager decision',async t=>{
 const f=fixture(t);f.workflow('rejected',[agent('work')]);await f.create('rejected-run','rejected',{subject:'rejection'});const worker=f.stepWorker('rejected-run','work');f.finish(worker);f.report(worker,'rejected-worker-result',{accepted:true});await f.engine().pulse();f.acknowledgeStop(worker);await f.engine().pulse();const run=f.engine().get('desk','rejected-run'),result=f.store.messages({taskId:run.controlTaskId}).find(m=>m.kind==='result');
 f.store.recordAction(result.id,{kind:'abort',requestId:'reject-consolidated',text:'The full requested outcome was not accepted.'});f.store.ack(result.id);await f.engine().pulse();assert.equal(f.store.task(run.controlTaskId).status,'active');assert.equal(f.engine().get('desk',run.id).acceptedAt,undefined);
});

test('wrong command receipt identity and evidence symlinks cannot become accepted artifacts',async t=>{
 const f=fixture(t);f.workflow('receipt',[{id:'check',kind:'command',definitionId:'operator',command:{argv:['/fake/check']}}]);await f.create('receipt-run','receipt');const worker=f.stepWorker('receipt-run','check');
 f.receipt(worker,{pid:worker.launchResult.pid+1});f.finish(worker,{exitCode:0});await f.engine().pulse();assert.equal(f.engine().get('desk','receipt-run').status,'blocked');
 const outside=join(f.dir,'outside.txt');writeFileSync(outside,'Not authorized evidence');symlinkSync(outside,join(worker.delegation.spec.deskWorkspace.outputs,'link.txt'));assert.throws(()=>artifactEvidence(worker.delegation.spec.deskWorkspace),/symlinks/);
});

test('finished replacement cannot release the original writer lease during acceptance',async t=>{
 const f=fixture(t);f.workflow('replace',[agent('work')]);await f.create('replacement-run','replace',{subject:'identity'});const worker=f.stepWorker('replacement-run','work');
 f.finish(worker);f.report(worker,'accepted-result',{accepted:true});const native=f.terminals.get(worker.terminalId);native.state='finished';native.pid++;native.labels={'codex.worker':'foreign','codex.task':'foreign'};
 await f.engine().pulse();assert.equal(f.engine().get('desk','replacement-run').status,'blocked');assert.equal(f.store.task(worker.taskId).status,'active');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(worker.id).n,1);
});

test('supervised DAG routes child review locally and requests one final continuation from the same lead',async t=>{
 const f=fixture(t);f.desks.definitionPut({deskId:'desk',id:'lead',name:'Lead',harness:'goose',scope:'read-only',instructions:'Coordinate the assigned implementer and verify its evidence.',authority:{delegateRoles:['implementer'],reviewRoles:['implementer']}});
 f.workflow('supervised',[agent('lead','lead'),{...agent('implement'),supervisorStepId:'lead'}]);await f.create('team-run','supervised',{subject:'reviewed change'});
 const lead=f.stepWorker('team-run','lead'),child=f.stepWorker('team-run','implement'),originalPid=lead.launchResult.pid;
 assert.equal(child.supervisorId,lead.id);assert.equal(child.delegation.spec.parentId,null);assert.ok(lead.supervisionCredential);
 f.finish(child);f.report(child,'child-result');const supervision=new Supervision({store:f.store,config:f.config,rpc:f.rpc});await supervision.reconcile();assert.equal(supervision.route('child-result').state,'delivered');
 const token=JSON.parse(readFileSync(lead.supervisionCredential.credentialFile)).token;
 const request=(command,args)=>({workerId:lead.id,terminalId:lead.terminalId,token,command,args});
 await supervision.handle(request('decision',{id:'child-result',requestId:'verified-child',action:'accept',text:'Inspected the fixture source and test evidence.'}));await supervision.handle(request('ack',{id:'child-result'}));
 await f.engine().pulse();f.acknowledgeStop(child);await f.engine().pulse();assert.equal(f.engine().get('desk','team-run').steps.implement.status,'completed');assert.equal(f.store.task(lead.taskId).status,'active');
 f.finish(lead);await f.engine().pulse();await f.engine().pulse();
 assert.equal(f.calls.filter(c=>c.method==='terminal.send'&&/All assigned child steps/.test(c.params.text)).length,1);assert.equal(f.terminals.get(lead.terminalId).pid,originalPid);
 f.finish(lead);f.report(lead,'consolidated',{accepted:true});await f.engine().pulse();f.acknowledgeStop(lead);await f.engine().pulse();assert.equal(f.engine().get('desk','team-run').status,'completed');
});

test('workflow final acceptance holds dynamic children until reviewed and idle, then retains evidence and retires once',async t=>{
 const f=fixture(t);f.desks.definitionPut({deskId:'desk',id:'lead',name:'Lead',harness:'goose',scope:'read-only',instructions:'Review dynamically delegated work.',authority:{delegateRoles:['implementer'],reviewRoles:['implementer']}});
 f.workflow('dynamic',[agent('lead','lead')]);await f.create('dynamic-run','dynamic',{subject:'dynamic child'});const lead=f.stepWorker('dynamic-run','lead'),supervision=new Supervision({store:f.store,config:f.config,rpc:f.rpc});
 const input=supervision.validateChild(lead.id,{id:'dynamic-child',definitionId:'implementer',text:'Produce the scoped supporting evidence.'});await f.delegation().delegate(input);const child=f.store.worker(input.id);f.finish(lead);f.report(lead,'dynamic-lead-result',{accepted:true});
 await f.engine().pulse();let run=f.engine().get('desk','dynamic-run');assert.equal(run.steps.lead.status,'review');assert.equal(run.steps.lead.waitingForChildren[0].workerId,child.id);assert.equal(f.store.task(lead.taskId).status,'active');assert.equal(f.store.task(child.taskId).status,'active');assert.equal(f.calls.filter(c=>c.method==='terminal.kill').length,0);
 f.finish(child);await f.engine().pulse();assert.equal(f.store.task(child.taskId).status,'active');f.report(child,'dynamic-child-result');f.store.recordAction('dynamic-child-result',{kind:'accept',requestId:'dynamic-child-review',text:'Verified child evidence.',supervisorId:lead.id});await f.engine().pulse();assert.equal(f.store.task(child.taskId).status,'active');
 f.store.ack('dynamic-child-result');const output=join(child.delegation.spec.deskWorkspace.outputs,'answer.txt');writeFileSync(output,'Accepted dynamic child evidence');f.terminals.get(child.terminalId).status={state:'working'};await f.engine().pulse();assert.equal(f.store.task(child.taskId).status,'active');
 f.terminals.get(child.terminalId).status={state:'done'};await f.engine().pulse();f.acknowledgeStop(child);await f.engine().pulse();f.acknowledgeStop(lead);await f.engine().pulse();run=f.engine().get('desk','dynamic-run');assert.equal(run.status,'completed');assert.equal(f.store.task(child.taskId).status,'closed');assert.equal(f.store.task(lead.taskId).status,'closed');assert.equal(run.steps.lead.waitingForChildren,undefined);
 assert.equal(run.steps.lead.childEvidence[child.id].decision,'dynamic-child-result');assert.equal(run.steps.lead.childEvidence[child.id].artifacts.find(a=>a.path===output).sha256,digest('Accepted dynamic child evidence'));assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(child.id).n,0);
 const kills=f.calls.filter(c=>c.method==='terminal.kill').length;f.reopen();await f.engine().pulse();assert.equal(f.calls.filter(c=>c.method==='terminal.kill').length,kills);assert.equal(f.engine().get('desk','dynamic-run').steps.lead.childEvidence[child.id].requestId,'dynamic-child-review');
});

test('nested dynamic descendants must settle before their accepted workflow supervisors can retire',async t=>{
 const f=fixture(t);f.desks.definitionPut({deskId:'desk',id:'middle',name:'Middle reviewer',harness:'goose',scope:'read-only',instructions:'Review an implementation child.',authority:{delegateRoles:['implementer'],reviewRoles:['implementer']}});f.desks.definitionPut({deskId:'desk',id:'lead',name:'Lead',harness:'goose',scope:'read-only',instructions:'Review a nested supervisor.',authority:{delegateRoles:['middle'],reviewRoles:['middle']}});
 f.workflow('nested',[agent('lead','lead')]);await f.create('nested-run','nested',{subject:'nested lifecycle'});const lead=f.stepWorker('nested-run','lead'),supervision=new Supervision({store:f.store,config:f.config,rpc:f.rpc});
 await f.delegation().delegate(supervision.validateChild(lead.id,{id:'dynamic-middle',definitionId:'middle',text:'Delegate and review the implementation.'}));const middle=f.store.worker('dynamic-middle');await f.delegation().delegate(supervision.validateChild(middle.id,{id:'dynamic-leaf',definitionId:'implementer',text:'Produce supporting evidence.'}));const leaf=f.store.worker('dynamic-leaf');
 f.finish(lead);f.report(lead,'nested-lead-result',{accepted:true});f.finish(middle);f.report(middle,'nested-middle-result',{accepted:true});await f.engine().pulse();let run=f.engine().get('desk','nested-run');assert.equal(run.status,'running');assert.equal(run.steps.lead.waitingForChildren[0].workerId,leaf.id);for(const worker of [lead,middle,leaf])assert.equal(f.store.task(worker.taskId).status,'active');
 f.finish(leaf);f.report(leaf,'nested-leaf-result',{accepted:true});await f.engine().pulse();f.acknowledgeStop(leaf);await f.engine().pulse();f.acknowledgeStop(middle);await f.engine().pulse();f.acknowledgeStop(lead);await f.engine().pulse();run=f.engine().get('desk','nested-run');assert.equal(run.status,'completed');for(const worker of [lead,middle,leaf])assert.equal(f.store.task(worker.taskId).status,'closed');assert.equal(run.steps.lead.childEvidence[middle.id].supervisorId,lead.id);assert.equal(run.steps.lead.childEvidence[leaf.id].supervisorId,middle.id);
 assert.deepEqual(f.calls.filter(c=>c.method==='terminal.kill').map(c=>c.params.terminal),[leaf.terminalId,middle.terminalId,lead.terminalId]);
});

test('changed native identity during retire retains ownership and leaves the task open',async t=>{
 const f=fixture(t);f.workflow('guarded',[agent('work')]);await f.create('guarded-run','guarded',{subject:'guarded retirement'});
 const worker=f.stepWorker('guarded-run','work');f.finish(worker);f.report(worker,'guarded-result',{accepted:true});
 // The terminal address is unchanged but the underlying process is not the one
 // that was launched for this worker. Ownership must be retained for inspection.
 f.terminals.get(worker.terminalId).pid=worker.launchResult.pid+1;
 await assert.rejects(()=>f.engine().retire(worker),/identity.*changed|retain ownership/i);
 assert.equal(f.store.task(worker.taskId).status,'active');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(worker.id).n,1);
 assert.notEqual(storedRetirement(f.store,worker.id)?.state,RETIREMENT.RELEASED);
 assert.equal(f.calls.filter(c=>c.method==='terminal.kill'&&c.params.terminal===worker.terminalId).length,0);
});

test('a refused or unconfirmed native stop never releases ownership or closes the task',async t=>{
 const f=fixture(t);f.workflow('halt',[agent('work')]);await f.create('halt-run','halt',{subject:'halt retirement'});
 const worker=f.stepWorker('halt-run','work');f.finish(worker);f.report(worker,'halt-result',{accepted:true});
 // The native layer recognises (and refuses) the signal; nothing was dispatched.
 const base=f.rpc.request;f.rpc.request=async(method,params)=>{if(method==='terminal.kill')throw Object.assign(new Error('Native refused the signal'),{data:{kind:'refused'}});return base(method,params);};
 await assert.rejects(()=>f.engine().retire(worker),/refused/i);
 assert.equal(f.store.task(worker.taskId).status,'active');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(worker.id).n,1);
 assert.notEqual(storedRetirement(f.store,worker.id)?.state,RETIREMENT.RELEASED);
 assert.equal(f.store.meta('stop:'+worker.id)?.dispatch,'refused');
});

test('retirement replay emits no duplicate release, stop notice or kill signal',async t=>{
 const f=fixture(t);f.workflow('replay',[agent('work')]);await f.create('replay-run','replay',{subject:'replay retirement'});
 const worker=f.stepWorker('replay-run','work');f.finish(worker);f.report(worker,'replay-result',{accepted:true});await f.engine().pulse();f.acknowledgeStop(worker);await f.engine().pulse();
 assert.equal(f.store.task(worker.taskId).status,'closed');
 const rows=type=>f.store.db.prepare('SELECT data FROM journal WHERE type=?').all(type).map(row=>JSON.parse(row.data));
 const released=()=>rows('retirement.released').filter(r=>r.workerId===worker.id).length;
 const stopped=()=>rows('agent.stopped').filter(r=>r.workerId===worker.id).length;
 const kills=()=>f.calls.filter(c=>c.method==='terminal.kill'&&c.params.terminal===worker.terminalId).length;
 assert.equal(released(),1);assert.equal(stopped(),1);assert.equal(kills(),1);
 const before={released:released(),stopped:stopped(),kills:kills()};
 await f.engine().retire(worker);await f.engine().retire(worker);await f.engine().pulse();
 assert.equal(released(),before.released);assert.equal(stopped(),before.stopped);assert.equal(kills(),before.kills);
 f.reopen();await f.engine().pulse();
 assert.equal(released(),before.released);assert.equal(stopped(),before.stopped);assert.equal(kills(),before.kills);
 assert.equal(f.store.task(worker.taskId).status,'closed');
});

test('standalone hierarchical sessions are not retired by workflow reconciliation',async t=>{
 const f=fixture(t);f.desks.definitionPut({deskId:'desk',id:'lead',name:'Lead',harness:'goose',scope:'read-only',instructions:'Review ordinary child work.',authority:{delegateRoles:['implementer'],reviewRoles:['implementer']}});f.scaffold();await f.delegation().delegate({id:'standalone-lead',deskId:'desk',deskDefinitionId:'lead',threadId:THREAD,instruction:'Coordinate this ongoing session.'});const lead=f.store.worker('standalone-lead'),supervision=new Supervision({store:f.store,config:f.config,rpc:f.rpc});await f.delegation().delegate(supervision.validateChild(lead.id,{id:'standalone-child',definitionId:'implementer',text:'Investigate the current topic.'}));const child=f.store.worker('standalone-child');
 for(const worker of [lead,child]){f.finish(worker);f.report(worker,worker.id+'-accepted',{accepted:true});}await f.engine().pulse();for(const worker of [lead,child])assert.equal(f.store.task(worker.taskId).status,'active');assert.equal(f.calls.filter(c=>c.method==='terminal.kill').length,0);
});

test('workflow retry and cancellation cannot orphan active supervised children',async t=>{
 const f=fixture(t);f.desks.definitionPut({deskId:'desk',id:'lead',name:'Lead',harness:'goose',scope:'read-only',instructions:'Review child work.',authority:{delegateRoles:['implementer'],reviewRoles:['implementer']}});f.workflow('protected',[agent('lead','lead')]);await f.create('protected-run','protected',{subject:'safe recovery'});const lead=f.stepWorker('protected-run','lead'),supervision=new Supervision({store:f.store,config:f.config,rpc:f.rpc});await f.delegation().delegate(supervision.validateChild(lead.id,{id:'protected-child',definitionId:'implementer',text:'Investigate the outstanding issue.'}));const child=f.store.worker('protected-child');
 f.finish(lead);f.report(lead,'lead-rejected');f.store.recordAction('lead-rejected',{kind:'abort',requestId:'lead-reject',text:'The current supervisor outcome needs revision.'});f.store.ack('lead-rejected');await f.engine().pulse();assert.equal(f.engine().get('desk','protected-run').status,'blocked');
 await assert.rejects(()=>f.engine().retry({deskId:'desk',id:'protected-run',stepId:'lead',requestId:'retry-with-child',note:'Inspect active child work before retrying.'}),/protected-child.*Inspect and settle/);
 await assert.rejects(()=>f.engine().cancel({deskId:'desk',id:'protected-run',requestId:'cancel-with-child',note:'Inspect active child work before cancellation.'}),/protected-child.*Inspect and settle/);
 for(const worker of [lead,child])assert.equal(f.store.task(worker.taskId).status,'active');assert.equal(f.calls.filter(c=>c.method==='terminal.kill').length,0);assert.equal(f.engine().get('desk','protected-run').steps.lead.attempt,1);
});

test('explicit command retry retires only its prior attempt and keeps a flat idempotent history',async t=>{
 const f=fixture(t);f.workflow('retryable',[{id:'check',kind:'command',definitionId:'operator',command:{argv:['/fake/check']}}]);await f.create('retry-run','retryable');
 for(let attempt=1;attempt<=3;attempt++){
  const worker=f.stepWorker('retry-run','check');f.receipt(worker,{code:9});f.finish(worker,{exitCode:9});await f.engine().workerFinished(worker,f.terminals.get(worker.terminalId));await f.engine().pulse();
  const run=f.engine().get('desk','retry-run');for(const message of f.store.messages({taskId:run.controlTaskId,pending:true})){f.store.recordAction(message.id,{kind:'accept',requestId:'inspect-'+message.id,text:'Reviewed failed command evidence before the explicit retry.'});f.store.ack(message.id);}
  const input={deskId:'desk',id:'retry-run',stepId:'check',requestId:'retry-'+attempt,note:'Inspected the failed attempt; rerun the same frozen check.'};
  await f.engine().retry(input);await f.engine().retry(input);await f.engine().pulse();
  assert.equal(f.store.task(worker.taskId).status,'closed');assert.equal(f.engine().get('desk','retry-run').steps.check.attempt,attempt+1);assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,attempt+1);
 }
 const history=f.engine().get('desk','retry-run').steps.check.history;assert.equal(history.length,3);assert.ok(history.every(attempt=>!Object.hasOwn(attempt,'history')),'Attempt history must not recursively duplicate previous histories');
});

test('interrupted completion repairs job state and emits the final result exactly once after reopening',async t=>{
 const f=fixture(t);f.workflow('finalize',[agent('work')]);await f.create('finalize-run','finalize',{subject:'atomic completion'});const worker=f.stepWorker('finalize-run','work');f.finish(worker);f.report(worker,'ready',{accepted:true});
 const engine=f.engine(),update=engine.desks.jobUpdate.bind(engine.desks);let failed=false;
 engine.desks.jobUpdate=(desk,id,patch)=>{if(patch.status==='completed'&&!failed){failed=true;throw new Error('Injected completion interruption');}return update(desk,id,patch);};
 await engine.pulse();f.acknowledgeStop(worker);await assert.rejects(()=>engine.pulse(),/completion interruption/);f.reopen();await f.engine().pulse();await f.engine().pulse();
 const run=f.engine().get('desk','finalize-run');assert.equal(run.status,'completed');assert.equal(f.desks.job('desk','finalize-run').status,'completed');assert.equal(f.store.messages({taskId:run.controlTaskId}).filter(m=>m.kind==='result').length,1);
});

test('interrupted registration can be replayed without leaving its job pending or creating another run',async t=>{
 const f=fixture(t);f.workflow('register',[agent('work')]);f.scaffold();const input={deskId:'desk',id:'register-run',workflowId:'register',ownerThread:THREAD,parameters:{subject:'registration recovery'}};
 const engine=f.engine();engine.desks.jobUpdate=()=>{throw new Error('Injected registration interruption');};
 await assert.rejects(()=>engine.create(input),/registration interruption/);f.reopen();await f.engine().create(input);
 assert.equal(f.desks.job('desk','register-run').status,'running');assert.equal(f.engine().list('desk').length,1);assert.equal(f.store.tasks().filter(task=>task.deskRunId==='register-run').length,1);
 await f.engine().pulse();assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);
});

test('known unstarted preparation failure can be explicitly retried without pretending a native process exists',async t=>{
 const f=fixture(t);f.workflow('preparation',[agent('work')]);f.failPrepare();await f.create('preparation-run','preparation',{subject:'setup recovery'});
 const old=f.stepWorker('preparation-run','work');assert.equal(old.launchState,'preparation_failed');assert.equal(old.terminalId,null);assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(old.id).n,0);
 await f.engine().retry({deskId:'desk',id:'preparation-run',stepId:'work',requestId:'retry-prepared',note:'Corrected preparation; no native launch occurred.'});await f.engine().pulse();
 assert.equal(f.engine().get('desk','preparation-run').steps.work.status,'running');assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);assert.equal(f.store.task(old.taskId).status,'closed');assert.equal(f.calls.some(c=>c.method==='terminal.get'&&c.params.terminal===null),false);
});

test('command preparation failure is known unstarted and releases its actual reservation through shared never-launched retirement',async t=>{
 const f=fixture(t);f.workflow('command-setup',[{id:'check',kind:'command',definitionId:'operator',command:{argv:['/fake/check']}}]);writeFileSync(f.config.profileFile,'invalid fixture profile');await f.create('command-setup-run','command-setup');
 const worker=f.stepWorker('command-setup-run','check');
 // The command role is a write scope, so a writer lease was genuinely reserved
 // before preparation failed; this assertion guards that the release below is a
 // real release, not a case that never held ownership.
 assert.ok(worker.writePaths.length>0,'fixture must actually reserve writer ownership');
 assert.equal(worker.launchState,'preparation_failed');assert.equal(worker.terminalId,null);
 assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,0,'no native launch may have been attempted');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases WHERE worker_id=?').get(worker.id).n,0);
 const record=storedRetirement(f.store,worker.id);
 assert.equal(record.state,RETIREMENT.RELEASED);
 assert.equal(record.reason,'never-launched');
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM journal WHERE type='retirement.released'").get().n,1,'release must flow through the shared retirement point');
});

test('a manual trigger can execute an existing single-role workflow without creating a second manager',async t=>{
 const f=fixture(t);f.desks.workflowPut({deskId:'desk',id:'legacy',name:'Legacy research',definitionId:'researcher',instructions:'Research {{inputs.payload.topic}} and return evidence.'});f.scaffold();
 f.desks.automationPut({deskId:'desk',id:'on-demand',type:'manual',workflowId:'legacy',ownerThread:THREAD,enabled:true});
 const engine=f.engine(),event={deskId:'desk',id:'manual-event',automationId:'on-demand',payload:{topic:'vendor credentials'}};
 const receipt=await engine.triggers.emit(event);await engine.pulse();assert.equal(receipt.occurrences.length,1);
 const run=engine.get('desk',receipt.occurrences[0]);assert.equal(run.ownerThread,THREAD);assert.equal(run.steps.main.status,'running');assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);
 await engine.triggers.emit(event);await engine.pulse();assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);assert.match(f.calls.find(c=>c.method==='terminal.send').params.text,/vendor credentials/);
});

test('identical nested parameters remain idempotent when object key order differs',async t=>{
 const f=fixture(t);f.workflow('parameters',[agent('work')]);f.scaffold();
 const input={deskId:'desk',id:'parameter-run',workflowId:'parameters',ownerThread:THREAD};
 await f.engine().create({...input,parameters:{subject:'same task',nested:{a:1,b:2},list:[{x:1,y:2}]}});
 const replay=await f.engine().create({...input,parameters:{list:[{y:2,x:1}],nested:{b:2,a:1},subject:'same task'}});assert.equal(replay.reused,true);assert.equal(f.engine().list('desk').length,1);
});

test('pre-worker trigger incidents are durable, deduplicated and addressed to the trusted current owner',async t=>{
 const f=fixture(t);f.workflow('triggered',[agent('work')]);const oldOwner='00000000-0000-4000-8000-000000000002';
 f.desks.automationPut({deskId:'desk',id:'event',type:'event',eventName:'updated',workflowId:'triggered',enabled:true,ownerThread:oldOwner});
 f.desks.automationPut({deskId:'desk',id:'event',type:'event',eventName:'updated',workflowId:'triggered',enabled:true,ownerThread:THREAD});
 const engine=f.engine(),error=new Error('Invalid authored trigger configuration');
 engine.triggerError(error,{deskId:'desk',phase:'configuration'});engine.triggerError(error,{deskId:'desk',phase:'configuration'});
 const messages=f.store.messages();assert.equal(messages.length,1);assert.equal(messages[0].origin,'desk-runtime');assert.equal(messages[0].terminalId,null);assert.equal(f.store.task(messages[0].taskId).threadId,THREAD);assert.equal(f.store.workers().length,0);
});

test('trigger errors without a Desk and disabled historical owners do not invent a wake recipient',t=>{
 const f=fixture(t),engine=f.engine();assert.doesNotThrow(()=>engine.triggerError(new Error('Timer transport failure'),{phase:'timer'}));assert.equal(f.store.messages().length,0);
 f.workflow('triggered',[agent('work')]);f.desks.automationPut({deskId:'desk',id:'disabled',type:'manual',workflowId:'triggered',enabled:true,ownerThread:THREAD});f.desks.automationPut({deskId:'desk',id:'disabled',type:'manual',workflowId:'triggered',enabled:false,ownerThread:THREAD});
 engine.triggerError(new Error('Invalid authored configuration'),{deskId:'desk',phase:'configuration'});assert.equal(f.store.messages().length,0);
});

test('trigger recovery supersedes stale attention, survives restart and opens a fresh later failure episode',async t=>{
 const f=fixture(t);f.workflow('triggered',[agent('work')]);f.scaffold();f.desks.automationPut({deskId:'desk',id:'event',type:'manual',workflowId:'triggered',enabled:true,ownerThread:THREAD});
 const path=join(f.desks.files.root('desk'),'automations/event.yaml'),valid=readFileSync(path,'utf8');writeFileSync(path,'{invalid');
 await f.engine().pulse();await f.engine().pulse();let messages=f.store.messages();assert.equal(messages.length,1);const first=messages[0];assert.equal(first.delivery,'pending');assert.equal(first.triggerIncident.episode,1);
 f.store.finishDispatch(first.id,{status:'queued',receipt:'already-host-queued'});f.reopen();writeFileSync(path,valid);await f.engine().pulse();
 const resolved=f.store.message(first.id);assert.equal(resolved.delivery,'superseded');assert.equal(resolved.action.kind,'superseded');assert.ok(resolved.acknowledgedAt);assert.equal(f.store.pendingDispatch().length,0);
 const incident=f.store.meta('desk.triggerIncident:'+first.triggerIncident.scope);assert.equal(incident.status,'resolved');assert.match(incident.resolution.reason,/validated/);
 writeFileSync(path,'{invalid');await f.engine().pulse();messages=f.store.messages();assert.equal(messages.length,2);const second=messages.find(m=>m.id!==first.id);assert.equal(second.triggerIncident.episode,2);assert.equal(second.delivery,'pending');assert.equal(f.store.task(second.taskId).threadId,THREAD);
 const disabled=valid.replace(/^enabled: true$/m,'enabled: false');assert.notEqual(disabled,valid);writeFileSync(path,disabled);await f.engine().pulse();assert.equal(f.store.message(second.id).delivery,'superseded');assert.equal(f.store.pendingDispatch().length,0);assert.equal(f.store.workers().length,0);
});

test('trigger resolution preserves recorded user actions and invalid authored files do not count as repair',async t=>{
 const f=fixture(t);f.workflow('triggered',[agent('work')]);f.scaffold();f.desks.automationPut({deskId:'desk',id:'event',type:'manual',workflowId:'triggered',enabled:true,ownerThread:THREAD});
 const path=join(f.desks.files.root('desk'),'automations/event.yaml'),valid=readFileSync(path,'utf8');writeFileSync(path,'{invalid');await f.engine().pulse();const message=f.store.messages()[0];
 f.store.recordAction(message.id,{kind:'accept',requestId:'user-recorded',text:'Reviewed the trigger error; preserve this decision.'});const action=f.store.message(message.id).action;
 // A previous valid registration is insufficient while the authored files fail.
 await f.engine().pulse();assert.equal(f.store.meta('desk.triggerIncident:'+message.triggerIncident.scope).status,'active');
 writeFileSync(path,valid);await f.engine().pulse();assert.deepEqual(f.store.message(message.id).action,action);assert.equal(f.store.message(message.id).acknowledgedAt,null);assert.equal(f.store.meta('desk.triggerIncident:'+message.triggerIncident.scope).status,'resolved');
});

test('removed authored automations do not wake their historical owners on a later configuration failure',async t=>{
 const f=fixture(t);f.workflow('triggered',[agent('work')]);f.scaffold();f.desks.automationPut({deskId:'desk',id:'event',type:'manual',workflowId:'triggered',enabled:true,ownerThread:THREAD});
 const root=f.desks.files.root('desk');rmSync(join(root,'automations/event.yaml'));await f.engine().pulse();assert.deepEqual(f.desks.files.registration('desk').automations,{});
 writeFileSync(join(root,'automations/untrusted.yaml'),'{invalid');await f.engine().pulse();assert.equal(f.store.messages().length,0);assert.equal(f.store.workers().length,0);
});

test('dispatch incidents retain the occurrence owner and resolve only after accepted dispatch or validated disable',async t=>{
 const f=fixture(t);f.workflow('triggered',[agent('work')]);f.scaffold();f.desks.automationPut({deskId:'desk',id:'event',type:'manual',workflowId:'triggered',enabled:true,ownerThread:THREAD});
 const engine=f.engine();engine.triggers.createRun=async()=>{throw new Error('Isolated registration unavailable');};const event=await engine.triggers.emit({deskId:'desk',id:'failed-dispatch',automationId:'event'});const id=event.occurrences[0],message=f.store.messages()[0];
 assert.equal(message.triggerIncident.occurrenceId,id);assert.equal(f.store.task(message.taskId).threadId,THREAD);
 const other='00000000-0000-4000-8000-000000000002';f.desks.automationPut({deskId:'desk',id:'event',type:'manual',workflowId:'triggered',enabled:true,ownerThread:other});engine.triggerError(new Error('Isolated registration unavailable'),{deskId:'desk',id,phase:'dispatch'});assert.equal(f.store.messages().length,1);
 const occurrence=engine.triggers._get(id);engine.triggers._save({...occurrence,nextAttemptAt:0});await engine.pulse();assert.equal(engine.triggers._get(id).status,'disabled');assert.equal(f.store.message(message.id).delivery,'superseded');
});

test('healthy configuration alone cannot resolve a watcher fault; restored directory observation can',async t=>{
 const f=fixture(t);f.workflow('triggered',[agent('work')]);f.scaffold();f.desks.automationPut({deskId:'desk',id:'event',type:'manual',workflowId:'triggered',enabled:true,ownerThread:THREAD});
 const engine=f.engine();let fail=true;engine.triggers.watchFactory=()=>{if(fail)throw new Error('Isolated watcher unavailable');return {on(){},unref(){},close(){}};};t.after(()=>engine.stop());
 await engine.start();await engine.pulse();const message=f.store.messages()[0];assert.equal(f.store.messages().length,1);assert.equal(message.triggerIncident.phase,'watch');assert.equal(message.delivery,'pending');assert.equal(engine.triggers.status('desk').health.error,null);
 fail=false;await engine.pulse();assert.equal(f.store.message(message.id).delivery,'superseded');assert.match(f.store.meta('desk.triggerIncident:'+message.triggerIncident.scope).resolution.reason,/watch recovered/);
});

test('structured input rendering is literal argv substitution and rejects missing placeholders',()=>{
 assert.deepEqual(renderInputs(['printf','{{inputs.value}}'],{inputs:{value:'$(do-not-execute); *'}}),['printf','$(do-not-execute); *']);assert.throws(()=>renderInputs('{{inputs.missing}}',{inputs:{}}),/Unknown workflow input/);
});

test('default conservative retirement holds a pending intentional-stop notice instead of closing the task',async t=>{
 const f=fixture(t);
 // A WorkflowRuns built without an injected retirement uses the conservative
 // default. It can request the stop but cannot confirm the OS containment
 // claim, so ownership must be retained and the durable lifecycle notice
 // surfaced for a recorded manager action and acknowledgement.
 const dir=mkdtempSync(join(f.dir,'default-'));const store=new Store(join(dir,'manager.sqlite'));
 const task={id:'default-task',name:'fixture',threadId:THREAD,project:dir,status:'active'};
 const worker={id:'default-worker',taskId:task.id,name:'fixture',project:dir,terminalId:'default-terminal',launchState:'started',writePaths:[dir],launchResult:{pid:4242},launchIdentity:{created_ms:1000}};
 store.saveTask(task);store.reserveWorker(worker);
 const native={state:'finished',address:worker.terminalId,cwd:dir,pid:4242,created_ms:1000,exit_code:0,labels:{'codex.worker':worker.id,'codex.task':task.id}};
 const calls=[];const rpc={async request(method){calls.push(method);if(method!=='terminal.get')throw new Error('Unexpected native action');return native;}};
 const flows=new WorkflowRuns({store,config:{stateDir:dir},rpc,pulse:async()=>{}});
 const held=await flows.retire(worker);
 assert.equal(held.retained,true);assert.equal(held.reason,'pending-retirement');assert.equal(held.retirement,RETIREMENT.PENDING);assert.deepEqual(held.obligations.retirement,RETIREMENT.PENDING);
 assert.ok(held.pending.length===1&&/^stopped-/.test(held.pending[0]),'the lifecycle stop notice is surfaced as an outstanding obligation');
 assert.equal(store.task(task.id).status,'active');
 assert.equal(store.writerLeases().length,1);
 const notice=store.messages({taskId:task.id,pending:true});
 assert.equal(notice.length,1);assert.equal(notice[0].kind,'attention');assert.match(notice[0].id,/^stopped-/);
 assert.equal(storedRetirement(store,worker.id)?.state,RETIREMENT.PENDING);
 assert.deepEqual(calls,['terminal.get','terminal.get','terminal.get']);
 store.close();
});

test('cancellation binds intent before any signal and never settles while a stop notice is outstanding',async t=>{
 const f=fixture(t);f.workflow('cancel-gate',[agent('work')]);await f.create('cancel-gate-run','cancel-gate',{subject:'cancellation gate'});const worker=f.stepWorker('cancel-gate-run','work');
 const kills=()=>f.calls.filter(c=>c.method==='terminal.kill'&&c.params?.terminal===worker.terminalId).length,runs=()=>f.calls.filter(c=>c.method==='terminal.run').length;
 assert.equal(runs(),1);
 const bound=await f.engine().cancel({deskId:'desk',id:'cancel-gate-run',requestId:'cancel-gate',note:'Stop the request.'});
 assert.equal(bound.status,'cancelling');assert.equal(f.desks.job('desk','cancel-gate-run').status,'running');assert.equal(f.store.task(worker.taskId).status,'active');
 assert.equal(kills(),1);assert.equal(runs(),1,'cancellation must not launch downstream work');
 const notice=f.store.messages({taskId:worker.taskId,pending:true});assert.equal(notice.length,1);assert.match(notice[0].id,/^stopped-/);
 const replay=await f.engine().cancel({deskId:'desk',id:'cancel-gate-run',requestId:'cancel-gate',note:'Stop the request.'});assert.equal(replay.status,'cancelling');assert.equal(kills(),1);
 await assert.rejects(()=>f.engine().cancel({deskId:'desk',id:'cancel-gate-run',requestId:'other-cancel',note:'Overwrite the first cancellation.'}),/already has a cancellation/);
 f.reopen();await f.engine().pulse();assert.equal(f.engine().get('desk','cancel-gate-run').status,'cancelling');assert.equal(f.store.task(worker.taskId).status,'active');
 f.acknowledgeStop(worker);await f.engine().pulse();
 assert.equal(f.engine().get('desk','cancel-gate-run').status,'cancelled');assert.equal(f.store.task(worker.taskId).status,'closed');assert.equal(kills(),1);assert.equal(runs(),1);
 const reused=await f.engine().cancel({deskId:'desk',id:'cancel-gate-run',requestId:'cancel-gate',note:'Stop the request.'});assert.equal(reused.reused,true);
});

test('retry retains the original attempt until the prior task is closed, then the same request advances',async t=>{
 const f=fixture(t);f.workflow('retry-gate',[agent('work')]);await f.create('retry-gate-run','retry-gate',{subject:'retry gate'});const old=f.stepWorker('retry-gate-run','work');
 f.finish(old);await f.engine().decide({deskId:'desk',id:'retry-gate-run',stepId:'work',action:'abort',requestId:'retry-gate-abort',note:'The returned evidence is wrong.'});
 assert.equal(f.engine().get('desk','retry-gate-run').steps.work.status,'failed');
 const runs=()=>f.calls.filter(c=>c.method==='terminal.run').length;assert.equal(runs(),1);
 const held=await f.engine().retry({deskId:'desk',id:'retry-gate-run',stepId:'work',requestId:'retry-gate',note:'Inspect and rerun the failed step.'});
 assert.equal(held.steps.work.attempt,1);assert.equal(held.steps.work.status,'failed');assert.equal(held.steps.work.retryPending.requestId,'retry-gate');assert.equal(f.store.task(old.taskId).status,'active');assert.equal(runs(),1);
 await assert.rejects(()=>f.engine().retry({deskId:'desk',id:'retry-gate-run',stepId:'work',requestId:'other-retry',note:'Different payload.'}),/retry in progress/);
 f.acknowledgeStop(old);
 const advanced=await f.engine().retry({deskId:'desk',id:'retry-gate-run',stepId:'work',requestId:'retry-gate',note:'Inspect and rerun the failed step.'});
 assert.equal(advanced.steps.work.attempt,2);assert.equal(advanced.steps.work.status,'pending');assert.equal(f.store.task(old.taskId).status,'closed');
 await f.engine().pulse();assert.equal(runs(),2);assert.notEqual(f.stepWorker('retry-gate-run','work').id,old.id);
});

test('a conservative retirement holds a retry until clearance is reconciled, then the same request advances',async t=>{
 const f=fixture(t);f.workflow('clearance',[agent('work')]);await f.create('clearance-run','clearance',{subject:'clearance gate'});const old=f.stepWorker('clearance-run','work');
 f.finish(old);await f.engine().decide({deskId:'desk',id:'clearance-run',stepId:'work',action:'abort',requestId:'clearance-abort',note:'The returned evidence is wrong.'});
 let grant=false;const provider=({executionId})=>({coverage:grant?'complete':'partial',source:'fixture-containment',executionId,descendants:[]});
 const service=new Retirement(f.store,{provider,trustedSources:['fixture-containment']});
 const prepare=async worker=>{mkdirSync(join(worker.stateDir,'runtime'),{recursive:true});return {argv:['/fake-worker',worker.id],cwd:worker.project};};
 const engine=new WorkflowRuns({store:f.store,config:f.config,rpc:f.rpc,pulse:async()=>{},retirement:service,delegationFactory:opts=>new Delegation({...opts,prepare})});
 const held=await engine.retry({deskId:'desk',id:'clearance-run',stepId:'work',requestId:'clearance-retry',note:'Rerun after inspection.'});
 assert.equal(held.steps.work.attempt,1);assert.equal(held.steps.work.status,'failed');assert.equal(held.steps.work.retryPending.requestId,'clearance-retry');
 assert.equal(f.store.task(old.taskId).status,'active');assert.equal(storedRetirement(f.store,old.id)?.state,RETIREMENT.PENDING);
 f.acknowledgeStop(old);grant=true;
 const worker=f.store.worker(old.id),executionId=service.executionId(worker);
 service.reconcile({threadId:THREAD,workerId:worker.id,executionId,requestId:f.store.meta('stop:'+worker.id)?.requestId??null,
  evidence:{coverage:'complete',source:'fixture-containment',reference:'fixture-descendant-clearance',executionId,descendants:[]}});
 assert.equal(storedRetirement(f.store,old.id)?.state,RETIREMENT.RELEASED);assert.equal(f.store.task(old.taskId).status,'active');
 const advanced=await engine.retry({deskId:'desk',id:'clearance-run',stepId:'work',requestId:'clearance-retry',note:'Rerun after inspection.'});
 assert.equal(advanced.steps.work.attempt,2);assert.equal(f.store.task(old.taskId).status,'closed');
});

test('a retry is refused for a run already bound for cancellation and no replacement is launched',async t=>{
 const f=fixture(t);f.workflow('bound-cancel',[agent('work')]);await f.create('bound-cancel-run','bound-cancel',{subject:'bound cancellation'});
 const worker=f.stepWorker('bound-cancel-run','work');f.finish(worker);
 await f.engine().decide({deskId:'desk',id:'bound-cancel-run',stepId:'work',action:'abort',requestId:'bound-cancel-abort',note:'The returned evidence is wrong.'});
 const runs=()=>f.calls.filter(c=>c.method==='terminal.run').length;assert.equal(runs(),1);
 const bound=await f.engine().cancel({deskId:'desk',id:'bound-cancel-run',requestId:'bound-cancel',note:'Stop the workflow.'});
 assert.equal(bound.status,'cancelling');assert.equal(bound.cancellation.requestId,'bound-cancel');
 await f.engine().pulse();
 await assert.rejects(()=>f.engine().retry({deskId:'desk',id:'bound-cancel-run',stepId:'work',requestId:'bound-cancel-retry',note:'Try to rerun during cancellation.'}),/cancellation|refused/i);
 assert.equal(f.engine().get('desk','bound-cancel-run').steps.work.attempt,1);assert.equal(runs(),1,'a retry during cancellation must not launch a replacement');
 // The cancellation freeze is durable: re-reading the store after a restart must
 // not resurrect the refused retry or advance the attempt.
 f.reopen();await f.engine().pulse();
 const after=f.engine().get('desk','bound-cancel-run');assert.equal(after.cancellation.requestId,'bound-cancel');assert.equal(after.steps.work.attempt,1);assert.equal(runs(),1);
});

test('replaying a committed retry with the same request id but different evidence is refused',async t=>{
 const f=fixture(t);f.workflow('retry-evidence',[agent('work')]);await f.create('retry-evidence-run','retry-evidence',{subject:'retry evidence'});
 const old=f.stepWorker('retry-evidence-run','work');f.finish(old);
 await f.engine().decide({deskId:'desk',id:'retry-evidence-run',stepId:'work',action:'abort',requestId:'retry-evidence-abort',note:'The returned evidence is wrong.'});
 const input={deskId:'desk',id:'retry-evidence-run',stepId:'work',requestId:'retry-evidence-key',note:'Original inspection note.'};
 const held=await f.engine().retry(input);assert.equal(held.steps.work.attempt,1);assert.equal(held.steps.work.retryPending.requestId,'retry-evidence-key');
 f.acknowledgeStop(old);
 const advanced=await f.engine().retry(input);assert.equal(advanced.steps.work.attempt,2);assert.equal(advanced.steps.work.retryEvidence,'Original inspection note.');
 const replay=await f.engine().retry(input);assert.equal(replay.steps.work.attempt,2,'an identical replay is idempotent');
 await assert.rejects(()=>f.engine().retry({...input,note:'A different note hidden under the same request id.'}),/different evidence|already committed/i);
});

test('a cancellation bound while a retry awaits retirement dominates and launches no replacement',async t=>{
 const f=fixture(t);f.workflow('race',[agent('work')]);await f.create('race-run','race',{subject:'concurrent cancellation'});
 const worker=f.stepWorker('race-run','work');f.finish(worker);
 await f.engine().decide({deskId:'desk',id:'race-run',stepId:'work',action:'abort',requestId:'race-abort',note:'The returned evidence is wrong.'});
 const runs=()=>f.calls.filter(c=>c.method==='terminal.run').length;
 // Latch retire's identity read so the retry is provably suspended mid-flight
 // when the cancellation is bound by a separate caller over the same store.
 let release;const gate=new Promise(resolve=>{release=resolve;});let reachedResolve;const reached=new Promise(resolve=>{reachedResolve=resolve;});
 const original=f.rpc.request;let gated=false;
 f.rpc.request=async(method,params)=>{if(method==='terminal.get'&&!gated){gated=true;reachedResolve();await gate;}return original(method,params);};
 const retryOutcome=f.engine().retry({deskId:'desk',id:'race-run',stepId:'work',requestId:'race-retry',note:'Rerun after inspection.'}).then(()=>({ok:true}),error=>({ok:false,error:error.message}));
 await reached;
 const cancelOutcome=await f.engine().cancel({deskId:'desk',id:'race-run',requestId:'race-cancel',note:'Concurrent user cancellation.'}).then(()=>({ok:true}),error=>({ok:false,error:error.message}));
 release();
 const result=await retryOutcome,run=f.engine().get('desk','race-run');
 assert.equal(result.ok,false,'the retry must not commit over a bound cancellation');
 assert.ok(['cancelling','cancelled'].includes(run.status),'cancellation dominates, got '+run.status);
 assert.equal(run.cancellation.requestId,'race-cancel');assert.equal(run.steps.work.attempt,1,'the original attempt is not advanced');
 assert.equal(runs(),1,'no replacement worker is launched');assert.equal(cancelOutcome.ok,true);
});

// A provider whose coverage is only granted after the manager has explicitly
// reviewed the stop notice and reconciled the containment claim. Until then the
// retirement service must report a structured, re-drivable hold -- never a
// terminal fault and never a silent close.
function gradedEngine(f,granted){
 const provider=({executionId})=>({coverage:granted.has(executionId)?'complete':'partial',source:'fixture-containment',executionId,descendants:[]});
 const retirement=new Retirement(f.store,{provider,trustedSources:['fixture-containment']});
 const engine=()=>new WorkflowRuns({store:f.store,config:f.config,rpc:f.rpc,pulse:async()=>{},retirement,delegationFactory:opts=>new Delegation({...opts,prepare:f.prepare}),commandsFactory:opts=>new DeskCommands(opts)});
 return {engine,retirement};
}
function conservativeEngine(f){
 return ()=>new WorkflowRuns({store:f.store,config:f.config,rpc:f.rpc,pulse:async()=>{},delegationFactory:opts=>new Delegation({...opts,prepare:f.prepare}),commandsFactory:opts=>new DeskCommands(opts)});
}
function reconcileWorker(f,retirement,worker,reference){
 const executionId=retirement.executionId(f.store.worker(worker.id));
 return retirement.reconcile({threadId:THREAD,workerId:worker.id,executionId,requestId:f.store.meta('stop:'+worker.id).requestId,evidence:{coverage:'complete',source:'fixture-containment',reference,executionId,descendants:[]}});
}

test('an accepted step held for containment clearance re-drives the same attempt and launches downstream exactly once',async t=>{
 const f=fixture(t);f.workflow('clear',[agent('work'),agent('after','implementer',['work'])]);
 const granted=new Set(),{engine,retirement}=gradedEngine(f,granted);
 f.scaffold();await engine().create({deskId:'desk',id:'clear-run',workflowId:'clear',ownerThread:THREAD,parameters:{subject:'accepted clearance hold'}});await engine().pulse();
 const work=f.stepWorker('clear-run','work');f.finish(work);f.report(work,'clear-result',{accepted:true});
 const launches=()=>f.calls.filter(c=>c.method==='terminal.run').length;
 await engine().pulse();
 let run=engine().get('desk','clear-run');
 // Expected clearance hold: the accepted step waits in review, not blocked, and
 // nothing downstream is launched or rerun.
 assert.equal(run.status,'running');assert.equal(run.steps.work.status,'review');
 assert.equal(storedRetirement(f.store,work.id)?.state,RETIREMENT.PENDING);
 assert.equal(f.store.task(work.taskId).status,'active');assert.equal(run.steps.after.status,'pending');assert.equal(launches(),1);
 f.acknowledgeStop(work);granted.add(retirement.executionId(f.store.worker(work.id)));
 await reconcileWorker(f,retirement,work,'fixture-clearance');
 await engine().pulse();
 run=engine().get('desk','clear-run');
 assert.equal(run.steps.work.status,'completed');assert.equal(run.steps.work.attempt,1,'the same accepted attempt completes without a rerun');
 assert.equal(f.store.task(work.taskId).status,'closed');assert.equal(storedRetirement(f.store,work.id)?.state,RETIREMENT.RELEASED);
 assert.equal(run.steps.after.status,'running');assert.equal(launches(),2,'downstream launches exactly once after clearance');
 await engine().pulse();assert.equal(launches(),2,'re-pulsing never relaunches an accepted downstream step');
});

test('a conservative no-coverage retirement stays held across restart and never closes the task',async t=>{
 const f=fixture(t);f.workflow('conservative',[agent('work')]);const engine=conservativeEngine(f);
 f.scaffold();await engine().create({deskId:'desk',id:'conservative-run',workflowId:'conservative',ownerThread:THREAD,parameters:{subject:'conservative hold'}});await engine().pulse();
 const work=f.stepWorker('conservative-run','work');f.finish(work);f.report(work,'conservative-result',{accepted:true});
 await engine().pulse();
 let run=engine().get('desk','conservative-run');
 assert.equal(run.status,'running');assert.equal(run.steps.work.status,'review');
 assert.equal(storedRetirement(f.store,work.id)?.state,RETIREMENT.PENDING);assert.equal(f.store.task(work.taskId).status,'active');
 f.acknowledgeStop(work);f.reopen();
 await engine().pulse();
 run=engine().get('desk','conservative-run');
 assert.equal(run.status,'running','the hold is re-evaluated rather than lost across restart');
 assert.equal(run.steps.work.status,'review');assert.equal(storedRetirement(f.store,work.id)?.state,RETIREMENT.PENDING);
 assert.equal(f.store.task(work.taskId).status,'active','conservative coverage never closes the task on its own');
 assert.equal(f.calls.filter(c=>c.method==='terminal.kill'&&c.params.terminal===work.terminalId).length,1,'the stop signal is not re-dispatched on replay');
});

test('a dynamic child retirement hold blocks its supervisor and dependents until the child is cleared and acknowledged',async t=>{
 const f=fixture(t);f.desks.definitionPut({deskId:'desk',id:'lead',name:'Lead',harness:'goose',scope:'read-only',instructions:'Review dynamically delegated work.',authority:{delegateRoles:['implementer'],reviewRoles:['implementer']}});
 f.workflow('dynhold',[agent('lead','lead'),agent('after','implementer',['lead'])]);
 const granted=new Set(),{engine,retirement}=gradedEngine(f,granted);
 f.scaffold();await engine().create({deskId:'desk',id:'dynhold-run',workflowId:'dynhold',ownerThread:THREAD,parameters:{subject:'dynamic child hold'}});await engine().pulse();
 const lead=f.stepWorker('dynhold-run','lead'),supervision=new Supervision({store:f.store,config:f.config,rpc:f.rpc});
 const input=supervision.validateChild(lead.id,{id:'dynhold-child',definitionId:'implementer',text:'Produce the scoped supporting evidence.'});
 await f.delegation().delegate(input);const child=f.store.worker(input.id);
 const launches=()=>f.calls.filter(c=>c.method==='terminal.run').length;
 f.finish(lead);f.report(lead,'dynhold-lead-result',{accepted:true});
 f.finish(child);f.report(child,'dynhold-child-result',{accepted:true});
 await engine().pulse();
 let run=engine().get('desk','dynhold-run');
 assert.equal(run.status,'running');assert.equal(run.steps.lead.status,'review');
 assert.equal(run.steps.lead.waitingForChildren?.[0]?.workerId,child.id,'the held child is recorded on the supervisor step');
 assert.equal(f.store.task(child.taskId).status,'active');assert.equal(f.store.task(lead.taskId).status,'active');
 assert.equal(run.steps.after.status,'pending');assert.equal(launches(),2,'only the supervisor and its child have launched');
 // Clear the CHILD only: its notice is actioned and its containment released.
 f.acknowledgeStop(child);granted.add(retirement.executionId(f.store.worker(child.id)));
 await reconcileWorker(f,retirement,child,'fixture-child-clearance');
 await engine().pulse();
 run=engine().get('desk','dynhold-run');
 assert.equal(f.store.task(child.taskId).status,'closed','the cleared child closes');
 assert.equal(run.steps.lead.status,'review','the supervisor is still held by its own uncleared retirement');
 assert.equal(run.steps.after.status,'pending');assert.equal(launches(),2,'dependents wait for the supervisor');
 // Now clear the supervisor.
 f.acknowledgeStop(lead);granted.add(retirement.executionId(f.store.worker(lead.id)));
 await reconcileWorker(f,retirement,lead,'fixture-lead-clearance');
 await engine().pulse();
 run=engine().get('desk','dynhold-run');
 assert.equal(run.steps.lead.status,'completed');assert.equal(f.store.task(lead.taskId).status,'closed');
 assert.equal(run.steps.after.status,'running');assert.equal(launches(),3,'the dependent launches exactly once after every retirement clears');
});

test('a genuine native identity failure during retirement still blocks the run instead of becoming a re-drivable hold',async t=>{
 const f=fixture(t);f.workflow('identity',[agent('work'),agent('after','implementer',['work'])]);
 await f.create('identity-run','identity',{subject:'identity guard'});
 const work=f.stepWorker('identity-run','work');f.finish(work);f.report(work,'identity-result',{accepted:true});
 f.terminals.get(work.terminalId).pid=work.launchResult.pid+1;
 await f.engine().pulse();
 const run=f.engine().get('desk','identity-run');
 assert.equal(run.status,'blocked');assert.equal(run.steps.work.status,'blocked');assert.match(run.steps.work.error,/identity/i);
 assert.equal(f.store.task(work.taskId).status,'active');
 assert.equal(run.steps.after.status,'pending','dependents never launch past a genuine fault');
 assert.equal(f.calls.filter(c=>c.method==='terminal.run').length,1);
});

// A durable queued input (Delegation.message mode:'queue') is a real obligation:
// even after the worker's own retirement is RELEASED, the task/step must stay
// open until that request is actually sent or refused. The request is never
// silently marked delivered/consumed just to finish the run.
test('a queued input request holds the accepted task and step open and re-drives across restart',async t=>{
 const f=fixture(t);f.workflow('queued',[agent('work')]);
 await f.create('queued-run','queued',{subject:'queued input hold'});
 const work=f.stepWorker('queued-run','work');
 const queued=await f.delegation().message(work.id,'queued-unresolved',{instruction:'Additional scoped input for the still-open step.',mode:'queue'});
 assert.equal(queued.state,'queued');
 f.finish(work);f.report(work,'queued-result',{accepted:true});
 await f.engine().pulse();
 f.acknowledgeStop(work);await f.engine().pulse();
 let run=f.engine().get('desk','queued-run');
 assert.equal(storedRetirement(f.store,work.id)?.state,RETIREMENT.RELEASED,'the worker itself is released');
 assert.equal(f.store.task(work.taskId).status,'active','the undelivered queued request keeps the task open');
 assert.equal(run.steps.work.status,'review');assert.equal(run.status,'running');
 f.reopen();await f.engine().pulse();
 run=f.engine().get('desk','queued-run');
 assert.equal(run.status,'running','the hold is re-evaluated rather than lost across restart');
 assert.equal(run.steps.work.status,'review');assert.equal(f.store.task(work.taskId).status,'active');
 const record=JSON.parse(f.store.db.prepare('SELECT data FROM agent_requests WHERE worker_id=? AND request_id=?').get(work.id,'queued-unresolved').data);
 assert.equal(record.state,'queued','the request is never silently marked delivered or consumed to close the task');
});

// An in-flight request whose delivery cannot be confirmed stays visibly
// uncertain and blocks closure rather than being treated as delivered.
test('an uncertain in-flight request retains the task and step across restart',async t=>{
 const f=fixture(t);f.workflow('inflight',[agent('work')]);
 await f.create('inflight-run','inflight',{subject:'in-flight hold'});
 const work=f.stepWorker('inflight-run','work');
 const original=f.rpc.request;
 f.rpc.request=async(method,params)=>{const native=f.terminals.get(params.terminal);if(method==='terminal.interrupt'){native.status={state:'working'};return {outcome:'still_working'};}return original(method,params);};
 f.terminals.get(work.terminalId).status={state:'working'};
 const interrupted=await f.delegation().interrupt(work.id,'in-flight-interrupt');
 assert.equal(interrupted.state,'uncertain');assert.equal(interrupted.delivery,'uncertain');
 f.finish(work);f.report(work,'inflight-result',{accepted:true});
 f.acknowledgeStop(work);await f.engine().pulse();
 let run=f.engine().get('desk','inflight-run');
 assert.equal(f.store.task(work.taskId).status,'active','an unconfirmed request is not treated as delivered');
 assert.equal(run.steps.work.status,'review');assert.equal(run.status,'running');
 f.reopen();await f.engine().pulse();
 run=f.engine().get('desk','inflight-run');
 assert.equal(run.status,'running');assert.equal(run.steps.work.status,'review');assert.equal(f.store.task(work.taskId).status,'active');
});

// The cancellation closure path funnels through the same common gate: a bound
// cancellation must not settle the run while a released worker still carries an
// undelivered queued request.
test('cancellation does not settle the run while a released worker still has an undelivered queued request',async t=>{
 const f=fixture(t);f.workflow('cancelqueued',[agent('work')]);
 await f.create('cancel-queued-run','cancelqueued',{subject:'cancel with queued input'});
 const work=f.stepWorker('cancel-queued-run','work');
 await f.delegation().message(work.id,'cancel-queued-input',{instruction:'Late scoped input that was never delivered.',mode:'queue'});
 f.finish(work);
 const bound=await f.engine().cancel({deskId:'desk',id:'cancel-queued-run',requestId:'cancel-queued',note:'User cancelled the request.'});
 assert.equal(bound.status,'cancelling');
 f.acknowledgeStop(work);
 const after=await f.engine().cancel({deskId:'desk',id:'cancel-queued-run',requestId:'cancel-queued',note:'User cancelled the request.'});
 assert.equal(after.status,'cancelling','the run cannot settle while the queued request is unresolved');
 assert.equal(f.store.task(work.taskId).status,'active');
 assert.ok(after.waitingForCancellation.tasks.includes(work.taskId),'the unresolved task is recorded as a cancellation obligation');
});

// An unexpected durable read/parse failure must never be downgraded to "no
// obligations". Mirrors the manager request-read-failure probe: a real queued
// note exists, the result is accepted and the stop notice acknowledged, yet an
// unreadable request-record query must hold the task open rather than let the
// gate close over a queued request it could not read.
test('an unreadable request-record read failure holds the task instead of silently completing',async t=>{
 const f=fixture(t);f.workflow('readfail',[agent('work')]);
 await f.create('readfail-run','readfail',{subject:'unreadable request hold'});
 const work=f.stepWorker('readfail-run','work');
 f.finish(work);
 await f.delegation().message(work.id,'queued-unresolved',{instruction:'Manager steering still awaiting delivery',mode:'queue'});
 f.report(work,'accepted',{accepted:true});await f.engine().pulse();f.acknowledgeStop(work);
 const original=f.store.db.prepare.bind(f.store.db);let injected=0;
 f.store.db.prepare=function(sql){if(sql==='SELECT data FROM agent_requests WHERE worker_id=? ORDER BY rowid'){injected++;throw new Error('Injected request-record read failure');}return original(sql);};
 await f.engine().pulse();
 assert.equal(f.engine().closureHold(work)?.reason,'request-read-failed','the unreadable read is surfaced as an explicit hold reason');
 f.store.db.prepare=original;
 assert.ok(injected>=1,'the closure gate actually re-read the durable request records');
 const run=f.engine().get('desk','readfail-run');
 assert.equal(run.status,'running','an unreadable request read is an explicit hold, never a false completion');
 assert.equal(run.steps.work.status,'review');
 assert.equal(f.store.task(work.taskId).status,'active');
 assert.equal(storedRetirement(f.store,work.id)?.state,RETIREMENT.RELEASED);
 assert.equal(f.engine().closureHold(work)?.reason,'pending-requests','once readable the real queued obligation still holds');
 const record=JSON.parse(f.store.db.prepare('SELECT data FROM agent_requests WHERE worker_id=? AND request_id=?').get(work.id,'queued-unresolved').data);
 assert.equal(record.state,'queued','the request is never silently marked delivered or consumed');
});

// A malformed durable row fails the same way: it is surfaced as an explicit
// hold, and once the corrupt row is removed the very same run re-drives to
// closure. A missing legacy table is the only supported "no requests" state.
test('a malformed request record is an explicit hold that re-drives to closure once repaired',async t=>{
 const f=fixture(t);f.workflow('malformed',[agent('work')]);
 await f.create('malformed-run','malformed',{subject:'malformed request hold'});
 const work=f.stepWorker('malformed-run','work');
 f.finish(work);f.report(work,'accepted',{accepted:true});
 await f.engine().pulse();f.acknowledgeStop(work);
 f.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)').run(work.id,'malformed','fingerprint','{not valid json');
 await f.engine().pulse();
 let run=f.engine().get('desk','malformed-run');
 assert.equal(run.status,'running','a malformed durable row is an explicit hold, never a false completion');
 assert.equal(run.steps.work.status,'review');
 assert.equal(f.store.task(work.taskId).status,'active');
 assert.equal(f.engine().closureHold(work)?.reason,'request-read-failed','a malformed row is never treated as no obligations');
 f.store.db.prepare('DELETE FROM agent_requests WHERE worker_id=? AND request_id=?').run(work.id,'malformed');
 await f.engine().pulse();
 run=f.engine().get('desk','malformed-run');
 assert.equal(run.status,'completed','the hold is re-drivable once the corrupt row is gone');
 assert.equal(f.store.task(work.taskId).status,'closed');
});

// The closing transaction must re-read and validate the durable worker/task
// binding. A missing, foreign or stale caller-supplied worker is refused rather
// than reported as a successful close of the wrong task.
test('closing a task validates the durable worker/task binding instead of trusting the caller',async t=>{
 const f=fixture(t);f.workflow('binding',[agent('work')]);
 await f.create('binding-run','binding',{subject:'binding validation'});
 const work=f.stepWorker('binding-run','work');
 const foreign={...work,taskId:'00000000-0000-4000-8000-00000000dead'};
 assert.throws(()=>f.engine().closeTask(foreign),/durably bound to task/,'a mismatched task binding is refused');
 assert.throws(()=>f.engine().closeTask({id:'no-such-worker',taskId:work.taskId}),/no durable worker/,'a missing worker is refused');
 assert.throws(()=>f.engine().closeTask({id:work.id}),/durably bound to task/,'a worker with no claimed task is refused');
 assert.equal(f.store.task(work.taskId).status,'active','a refused close never mutates the real task');
});
