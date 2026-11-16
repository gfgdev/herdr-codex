import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Delegation} from '../src/delegation.mjs';
import {WorkflowRuns} from '../src/desk-runs.mjs';
import {DeskCommands} from '../src/desk-commands.mjs';
import {Retirement} from '../src/retirement.mjs';
import {captureRevision} from '../src/evidence.mjs';
import {VerificationAssessment,ASSESSMENT_VERDICT} from '../src/verification-assessment.mjs';

// A test-only explicit fake-complete containment provider, wired with a trusted
// source so the conservative retirement service has a guarded release point.
const completeProvider=({executionId})=>({coverage:'complete',source:'fixture-containment',executionId,descendants:[]});
const retirementFor=store=>new Retirement(store,{provider:completeProvider,trustedSources:['fixture-containment']});
const THREAD='00000000-0000-4000-8000-000000000001';
const OTHER_THREAD='00000000-0000-4000-8000-000000000002';

const commandStep=()=>({id:'check',kind:'command',definitionId:'operator',dependsOn:[],command:{argv:['/fake/check','--flag']}});

// Real Store + real WorkflowRuns + fake native RPC. Nothing here launches a
// process; the fake native terminal is the sole, deterministic observation
// surface the assessment is allowed to read.
function fixture(t){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'verification-assessment-')));
  const stateDir=join(dir,'state');mkdirSync(stateDir);
  const config={stateDir,path:join(dir,'config.json'),packageRoot:join(dir,'package'),node:process.execPath,hc:'/never-run-hc',app:'/never-run-app',codex:'/never-run-codex',profileFile:join(dir,'profile.json')};
  writeFileSync(config.profileFile,JSON.stringify({python:'/never-run-python'}));
  const path=join(stateDir,'manager.sqlite');const store=new Store(path),desks=new Desks({store,config});
  desks.create({id:'desk',name:'Fixture Desk',purpose:'Test frozen coding, research and operations procedures'});
  desks.definitionPut({deskId:'desk',id:'operator',name:'operator',harness:'pi',scope:'write',writeMode:'task',instructions:'Original operator role instructions.',resourceIds:[]});
  const terminals=new Map(),calls=[];
  const rpc={request:async(method,params)=>{
    calls.push({method,params:structuredClone(params)});
    if(method==='terminal.run'){
      const address='t'+(terminals.size+1),native={address,pid:5000+terminals.size,state:'live',cwd:params.cwd,argv:params.argv,name:params.name,labels:params.labels,keep:params.keep,turn:0,status:{state:'idle'}};terminals.set(address,native);
      return {address,pid:native.pid};
    }
    if(method==='terminal.list')return {terminals:[...terminals.values()].filter(n=>!params.labels||Object.entries(params.labels).every(([key,value])=>n.labels[key]===value))};
    const native=terminals.get(params.terminal);if(!native)throw Object.assign(new Error('No native terminal'),{data:{kind:'not_found'}});
    if(method==='terminal.get')return structuredClone(native);
    if(method==='terminal.wait')return {turn:native.turn,status:native.status};
    if(method==='terminal.send'){native.status={state:'working'};return {turn:native.turn,started:true};}
    if(method==='terminal.kill'){native.state='finished';native.exit_code=143;return {killed:true};}
    throw new Error('Unexpected native method '+method);
  }};
  const prepare=async worker=>{mkdirSync(join(worker.stateDir,'runtime'),{recursive:true});return {argv:['/fake-worker',worker.id],cwd:worker.project};};
  const retirement=retirementFor(store);
  const options=()=>({store,config,rpc,pulse:async()=>{},retirement}),delegation=()=>new Delegation({...options(),prepare});
  const engine=()=>new WorkflowRuns({...options(),delegationFactory:opts=>new Delegation({...opts,prepare}),commandsFactory:opts=>new DeskCommands(opts)});
  function workflow(id,steps){return desks.workflowPut({deskId:'desk',id,name:id,instructions:'Use frozen inputs and return evidence.',steps});}
  function scaffold(){if(!desks.files.registration('desk')?.enabled)desks.files.scaffold('desk');}
  const create=async(id,workflowId)=>{scaffold();const result=await engine().create({deskId:'desk',id,workflowId,ownerThread:THREAD,parameters:{}});await engine().pulse();return result;};
  function stepWorker(runId,stepId){return store.worker(engine().get('desk',runId).steps[stepId].workerId);}
  function finish(worker,{exitCode,working=false}={}){const native=terminals.get(worker.terminalId);native.status={state:working?'working':'done'};native.turn++;if(exitCode!==undefined){native.state='finished';native.exit_code=exitCode;}return native;}
  function receipt(worker,{code=0,signal=null,...extra}={}){const result={version:1,workerId:worker.id,taskId:worker.taskId,terminalId:worker.terminalId,pid:worker.launchResult.pid,fingerprint:worker.command?.fingerprint,exitCode:code,signal,logs:{},...extra};const dir=join(worker.stateDir,worker.executionReceiptVersion===1?'execution':'runtime');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'command-result.json'),JSON.stringify(result));return result;}
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,stateDir,config,rpc,calls,terminals,workflow,create,engine,delegation,stepWorker,finish,receipt,scaffold,prepare,get store(){return store;},get desks(){return desks;}};
}

// Launch one frozen command workflow and return its worker plus a baseline
// captured from the command's registered project before the fake exit.
async function launchCommand(f,runId='check-run'){
  f.workflow(runId,[commandStep()]);await f.create(runId,runId);
  const worker=f.stepWorker(runId,'check');
  const project=worker.project;
  writeFileSync(join(project,'assessed.txt'),'baseline-v1\n');
  const baseline=captureRevision(project,{paths:['assessed.txt']});
  return {runId,worker,project,baseline};
}

function assessor(f,{rpc=f.rpc}={}){return new VerificationAssessment({store:f.store,config:f.config,rpc});}
function call(f,runId,worker,baseline,{ownerThread=THREAD}={}){
  return assessor(f).assess({deskId:'desk',runId,stepId:'check',workerId:worker.id,ownerThread,baseline});
}

test('passes a finished zero-exit command whose caller baseline still verifies',async t=>{
  const f=fixture(t);const {runId,worker,baseline,project}=await launchCommand(f);
  assert.equal(baseline.project,project);
  f.receipt(worker,{code:0});f.finish(worker,{exitCode:0});
  let observations=0;
  const rpc={request:async(method,params)=>{if(method==='terminal.get')observations+=1;return f.rpc.request(method,params);}};
  const result=await assessor(f,{rpc}).assess({deskId:'desk',runId,stepId:'check',workerId:worker.id,ownerThread:THREAD,baseline});
  assert.equal(result.verdict,ASSESSMENT_VERDICT.PASSED);
  assert.equal(result.reason,'declared-command-check-passed-and-baseline-unchanged');
  assert.equal(result.execution.success,true);
  assert.equal(result.execution.exit.code,0);
  assert.equal(result.revision.match,true);
  assert.equal(result.observation.state,'finished');
  assert.equal(observations,1,'assessment must issue exactly one bounded native observation');
});

test('fails a nonzero-exit command even though the selected bytes are unchanged',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'nonzero-run');
  f.receipt(worker,{code:7});f.finish(worker,{exitCode:7});
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.FAILED);
  assert.equal(result.reason,'command-exit-nonzero');
  assert.equal(result.execution.success,false);
  assert.equal(result.execution.exit.code,7);
  assert.equal(result.revision.match,true,'a matching revision must not rescue a failed command');
});

test('reports pending while the frozen command is still live',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'live-run');
  f.finish(worker,{working:true});
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.PENDING);
  assert.equal(result.reason,'command-still-running');
  assert.equal(result.observation.state,'live');
  assert.equal(result.execution,null);
});

test('cannot pass a finished command that has no execution receipt',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'missing-run');
  f.finish(worker,{exitCode:0});
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'execution-receipt-missing');
  assert.equal(result.execution,null);
});

test('cannot pass a receipt whose native identity does not match',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'mismatch-run');
  f.receipt(worker,{code:0,pid:worker.launchResult.pid+1});f.finish(worker,{exitCode:0});
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'execution-receipt-mismatch');
  assert.equal(result.execution,null);
});

test('cannot pass when the project drifted from the caller baseline',async t=>{
  const f=fixture(t);const {runId,worker,baseline,project}=await launchCommand(f,'drift-run');
  f.receipt(worker,{code:0});f.finish(worker,{exitCode:0});
  writeFileSync(join(project,'assessed.txt'),'drifted-v2\n');
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'revision-drift');
  assert.equal(result.execution.success,true);
  assert.equal(result.revision.match,false);
  assert.ok(result.revision.changedPaths.includes('assessed.txt'));
});

test('refuses a caller that is not the exact owning manager chat',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'wrong-owner-run');
  f.receipt(worker,{code:0});f.finish(worker,{exitCode:0});
  await assert.rejects(()=>call(f,runId,worker,baseline,{ownerThread:OTHER_THREAD}),/owning manager chat/);
});

// Regression: the revision must be read AFTER the awaited native observation.
// A host that mutates the project while the observation is in flight must not
// be certified against a baseline match captured before the await.
test('cannot pass when the project changes while the observation is in flight',async t=>{
  const f=fixture(t);const {runId,worker,baseline,project}=await launchCommand(f,'mutate-during-observe');
  f.receipt(worker,{code:0});f.finish(worker,{exitCode:0});
  const rpc={request:async(method,params)=>{
    if(method==='terminal.get')writeFileSync(join(project,'assessed.txt'),'mutated-during-observation\n');
    return f.rpc.request(method,params);
  }};
  const result=await assessor(f,{rpc}).assess({deskId:'desk',runId,stepId:'check',workerId:worker.id,ownerThread:THREAD,baseline});
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'revision-drift');
  assert.equal(result.observation.state,'finished');
  assert.equal(result.revision.match,false,'revision must be re-read after the observation await');
});

// Regression: a successful receipt alone is not a pass. The host must have
// explicitly observed a zero native exit.
test('cannot pass when the host never reports a native exit code',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'no-host-exit');
  f.receipt(worker,{code:0});
  const native=f.terminals.get(worker.terminalId);
  native.state='finished';native.status={state:'done'};native.turn++;delete native.exit_code;
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'native-exit-unobserved');
  assert.equal(result.execution.success,true,'the receipt may claim success');
  assert.equal(result.observation.exitCode,null);
});

test('cannot pass when the host reports a non-integer native exit code',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'bad-host-exit');
  f.receipt(worker,{code:0});
  const native=f.terminals.get(worker.terminalId);
  native.state='finished';native.status={state:'done'};native.turn++;native.exit_code='zero';
  const result=await call(f,runId,worker,baseline);
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'native-exit-unobserved');
  assert.equal(result.observation.exitCode,null);
});

// Regression: ownership and the frozen run/step/worker binding are re-read
// after the observation await, so a concurrent rebind cannot pass stale
// authority resolved before the await.
test('cannot pass under stale authority when run ownership is rebound during observation',async t=>{
  const f=fixture(t);const {runId,worker,baseline}=await launchCommand(f,'rebind-run');
  f.receipt(worker,{code:0});f.finish(worker,{exitCode:0});
  const run=f.engine().get('desk',runId);
  const rpc={request:async(method,params)=>{
    if(method==='terminal.get')f.engine().save({...run,ownerThread:OTHER_THREAD});
    return f.rpc.request(method,params);
  }};
  const result=await assessor(f,{rpc}).assess({deskId:'desk',runId,stepId:'check',workerId:worker.id,ownerThread:THREAD,baseline});
  assert.equal(result.verdict,ASSESSMENT_VERDICT.UNCERTAIN);
  assert.equal(result.reason,'ownership-changed');
});
