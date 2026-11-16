#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,mkdtemp,realpath,stat } from 'node:fs/promises';
import { watch,existsSync,openSync,closeSync } from 'node:fs';
import { dirname,join,resolve,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { HerdrClient } from '../src/native.mjs';
import { Delegation } from '../src/delegation.mjs';
import { Desks } from '../src/desks.mjs';
import { deskCommand } from '../src/desk-cli.mjs';
import { Store } from '../src/store.mjs';

const {values}=parseArgs({options:{'hc-binary':{type:'string'},out:{type:'string'},desks:{type:'boolean'}}});
for(const key of ['hc-binary','out'])if(!isAbsolute(values[key]??''))throw new Error('Absolute --'+key+' required');
const binary=await realpath(values['hc-binary']),out=resolve(values.out);
assert.ok((await stat(binary)).isFile());
await mkdir(out,{recursive:false,mode:0o700});
const paths=Object.fromEntries(['config','state','manager','project'].map(k=>[k,join(out,k)]));
for(const p of Object.values(paths))await mkdir(p,{mode:0o700});
await mkdir(join(paths.config,'herdr-core'));
await writeFile(join(paths.config,'herdr-core/config.toml'),'notes = false\ndraft_wait = 0\nshell = ["/bin/sh"]\n');
const runtime=await mkdtemp('/private/tmp/herdr-delegate-native-'),socket=join(runtime,'core.sock'),session='delegate-'+randomUUID().slice(0,12);
const env={HOME:process.env.HOME,USER:process.env.USER??'test',LOGNAME:process.env.LOGNAME??'test',PATH:`${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,SHELL:'/bin/sh',TERM:'xterm-256color',XDG_CONFIG_HOME:paths.config,XDG_STATE_HOME:paths.state,XDG_RUNTIME_DIR:runtime,HC_SESSION:session,HC_SOCKET:socket};
const quote=x=>`'${String(x).replaceAll("'","'\\''")}'`,wrapper=join(out,'hc');
await writeFile(wrapper,`#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(env).map(([k,v])=>quote(k+'='+v)).join(' ')} ${quote(binary)} "$@"\n`,{mode:0o700});
const fixture=resolve(dirname(fileURLToPath(import.meta.url)),'../tests/fixtures/native-delegate-agent.mjs');
const config={stateDir:paths.manager,packageRoot:dirname(fixture),hc:wrapper,node:process.execPath,profileFile:join(out,'unused-profile.json')};
const THREAD='00000000-0000-4000-8000-000000000001';
const evidence={version:1,out,session,socket,binary,noModels:true,noCodexDispatch:true,startedAt:new Date().toISOString(),checks:[],cleanup:[],events:[]};
let core,coreExit,rpc,observer,store,failure;
const waiters=new Set();
function notify(note){const row={at:new Date().toISOString(),note};evidence.events.push(row);for(const fn of [...waiters])fn(row);}
function waitEvent(predicate,{after=0,timeoutMs=15000,label='event'}={}){
  const found=evidence.events.slice(after).find(predicate);if(found)return Promise.resolve(found);
  return new Promise((res,rej)=>{const finish=(error,value)=>{clearTimeout(timer);waiters.delete(on);error?rej(error):res(value)};
    const on=row=>{if(predicate(row))finish(null,row)};const timer=setTimeout(()=>finish(new Error('Timed out: '+label)),timeoutMs);waiters.add(on);});
}
function pathReady(path){if(existsSync(path))return Promise.resolve();return new Promise((res,rej)=>{
  const done=error=>{clearTimeout(timer);watcher.close();error?rej(error):res()};const watcher=watch(dirname(path),()=>{if(existsSync(path))done()});
  const timer=setTimeout(()=>done(new Error('Core socket did not appear')),15000);watcher.on('error',done);if(existsSync(path))done();});}
const ledger=id=>join(out,id+'.jsonl');
const rows=async id=>(await readFile(ledger(id),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const prompts=async id=>(await rows(id)).filter(r=>r.kind==='prompt');
async function waitState(terminal,state,after=0){return waitEvent(r=>r.note?.method==='event'&&r.note.params.terminal===terminal&&r.note.params.type==='status'&&r.note.params.data.status?.state===state,{after,label:terminal+' '+state});}
async function check(name,fn){const start=Date.now();try{const detail=await fn();evidence.checks.push({name,passed:true,elapsedMs:Date.now()-start,...detail});console.log('PASS '+name)}catch(error){evidence.checks.push({name,passed:false,error:error.message});throw error}}

try{
  const log=openSync(join(out,'core.log'),'a',0o600),ready=pathReady(socket);
  core=spawn(binary,['serve'],{env:{...env,HC_LAUNCHD_DIRECT:String(process.pid)},stdio:['ignore',log,log]});closeSync(log);
  coreExit=new Promise(res=>{core.once('exit',(code,signal)=>res({code,signal}));core.once('error',e=>res({error:e.message}));});
  await ready;rpc=new HerdrClient({hc:wrapper,timeoutMs:30000});
  evidence.core=await rpc.request('server.status');assert.equal(evidence.core.pid,core.pid,'Must own this core');
  observer=new HerdrClient({hc:wrapper,timeoutMs:30000});evidence.snapshot=await observer.subscribe(notify);
  store=new Store(join(paths.manager,'manager.sqlite'));
  const api=new Delegation({config,store,rpc,prepare:async worker=>({argv:[process.execPath,fixture,ledger(worker.id),...(worker.delegation?.spec.deskWorkspace?[worker.delegation.spec.deskWorkspace.outputs]:[])],cwd:worker.project})});
  const input=id=>({id,name:id,threadId:THREAD,project:paths.project,scope:'read-only',instruction:`MULTILINE_INITIAL_${id}\nSecond line of selected task context.\nThird line must stay in the same prompt.`});
  let a,b;
  await check('two concurrent read-only delegates receive intact multiline assignments',async()=>{
    [a,b]=await Promise.all([api.delegate(input('native-a')),api.delegate(input('native-b'))]);
    assert.equal(a.request.state,'sent');assert.equal(b.request.state,'sent');assert.notEqual(a.terminalId,b.terminalId);
    await Promise.all([waitState(a.terminalId,'done'),waitState(b.terminalId,'done')]);
    for(const id of ['native-a','native-b']){const received=await prompts(id);assert.equal(received.length,1);assert.match(received[0].text,/Second line/);assert.match(received[0].text,/Third line/);}
    return {terminals:[a.terminalId,b.terminalId],pids:[store.worker('native-a').launchResult.pid,store.worker('native-b').launchResult.pid]};
  });
  await check('duplicate delegation reuses the original process and does not submit again',async()=>{
    const repeated=await api.delegate(input('native-a'));assert.equal(repeated.terminalId,a.terminalId);assert.equal(repeated.reused,true);
    assert.equal((await prompts('native-a')).length,1);assert.equal((await rpc.request('terminal.list',{all:true})).terminals.length,2);
    return {terminal:a.terminalId,submissions:1};
  });
  await check('idle messages queue without activation; follow-up consumes them in the same process',async()=>{
    const before=await rpc.request('terminal.get',{terminal:a.terminalId});
    const note=await api.message('native-a','queued-note',{instruction:'QUEUED_NOTE_NATIVE_TEST'});assert.equal(note.state,'queued');
    const unchanged=await rpc.request('terminal.get',{terminal:a.terminalId});assert.equal(unchanged.turn,before.turn);assert.equal(unchanged.status.state,'done');assert.equal((await prompts('native-a')).length,1);
    const cursor=evidence.events.length;const follow=await api.followup('native-a','continue-1',{instruction:'RELATED_FOLLOWUP_NATIVE_TEST'});assert.equal(follow.state,'sent');
    await waitState(a.terminalId,'done',cursor);const after=await rpc.request('terminal.get',{terminal:a.terminalId});assert.equal(after.pid,before.pid);
    const received=await prompts('native-a');assert.equal(received.length,2);assert.match(received[1].text,/QUEUED_NOTE_NATIVE_TEST/);assert.match(received[1].text,/RELATED_FOLLOWUP_NATIVE_TEST/);
    assert.equal(api.requests.get('native-a','queued-note').state,'delivered');
    return {pid:after.pid,turnBefore:before.turn,turnAfter:after.turn,submissions:received.length};
  });
  await check('active message is delivered conditionally without a new worker',async()=>{
    let cursor=evidence.events.length;
    await api.followup('native-a','hold-1',{instruction:'HOLD_NATIVE_DELEGATION phase one'});await waitState(a.terminalId,'working',cursor);
    const before=await rpc.request('terminal.get',{terminal:a.terminalId});
    const reply=await api.message('native-a','active-note',{instruction:'ACTIVE_NOTE_NATIVE_TEST HOLD_NATIVE_DELEGATION'});assert.equal(reply.state,'sent');
    const after=await rpc.request('terminal.get',{terminal:a.terminalId});assert.equal(after.pid,before.pid);assert.equal(after.status.state,'working');
    const received=await prompts('native-a');assert.equal(received.length,4);assert.match(received.at(-1).text,/ACTIVE_NOTE_NATIVE_TEST/);
    return {pid:after.pid,nativeReceipt:reply.nativeReceipt,submissions:received.length};
  });
  await check('interrupt retains process and session; later continuation still works',async()=>{
    const before=await rpc.request('terminal.get',{terminal:a.terminalId});let cursor=evidence.events.length;
    const interrupted=await api.interrupt('native-a','interrupt-1');assert.equal(interrupted.state,'sent');await waitState(a.terminalId,'done',cursor);
    const after=await rpc.request('terminal.get',{terminal:a.terminalId});assert.equal(after.pid,before.pid);assert.equal(after.state,'live');
    assert.ok((await rows('native-a')).some(r=>r.kind==='interrupt'));
    cursor=evidence.events.length;await api.followup('native-a','after-interrupt',{instruction:'AFTER_INTERRUPT_NATIVE_TEST'});await waitState(a.terminalId,'done',cursor);
    const received=await prompts('native-a');assert.equal(received.length,5);assert.match(received.at(-1).text,/AFTER_INTERRUPT_NATIVE_TEST/);assert.doesNotMatch(received.at(-1).text,/QUEUED_NOTE_NATIVE_TEST/);
    return {pid:after.pid,receipt:interrupted.nativeReceipt,submissions:received.length};
  });
  await check('native text read exposes actual agent terminal text',async()=>{
    const read=await api.read('native-a');await writeFile(join(out,'native-a-read.json'),JSON.stringify(read,null,2)+'\n');
    const text=JSON.stringify(read.screen);assert.match(text,/AFTER_INTERRUPT_NATIVE_TEST/);assert.match(text,/INTERRUPTED_NATIVE_DELEGATION/);
    assert.equal(api.list({threadId:THREAD}).length,2);return {screenPath:join(out,'native-a-read.json'),terminal:a.terminalId};
  });
  if(values.desks){
    const desks=new Desks({store,config});
    const vault=join(out,'desk-fixture-vault');await mkdir(vault);await writeFile(join(vault,'procedure.md'),'Synthetic desk source. Preserve references and report missing information.\n');
    const sourceBefore=await readFile(join(vault,'procedure.md'),'utf8');
    desks.create({id:'desk-a',name:'Synthetic Desk A',purpose:'Native desk integration test',vaultPath:vault});
    desks.create({id:'desk-b',name:'Synthetic Desk B',purpose:'Separate desk routing test'});
    const specialist={deskId:'desk-a',id:'analyst',name:'Analyst',harness:'pi',scope:'read-only',instructions:'Inspect assigned source references and report evidence.',resourceIds:['vault'],acceptance:['Preserve source files']};
    desks.definitionPut(specialist);desks.definitionPut({...specialist,id:'reviewer',name:'Reviewer',harness:'goose'});
    desks.workflowPut({deskId:'desk-a',id:'inspect',name:'Inspect source procedure',definitionId:'analyst',instructions:'DESK_NATIVE_JOB inspect the registered source references.'});
    desks.workCreate({deskId:'desk-a',id:'review-procedure',title:'Review procedure',brief:'Inspect and report the documented procedure.',ownerThread:THREAD});
    const args={action:'run',values:{id:'desk-a',workflow:'inspect',job:'job-one',thread:THREAD,work:'review-procedure'},store,config,rpc,pulse:async()=>{},delegationFactory:()=>api};
    let jobAgent,reviewer;
    await check('desk manual workflow and reviewer launch with frozen context and exact native desk identities',async()=>{
      const cursor=evidence.events.length;
      const [job,review]=await Promise.all([deskCommand(args),api.delegate({id:'desk-reviewer',threadId:THREAD,deskId:'desk-a',deskDefinitionId:'reviewer',instruction:'DESK_NATIVE_REVIEW inspect the assigned procedure.'})]);
      jobAgent=job.agent;reviewer=review;
      await Promise.all([waitState(jobAgent.terminalId,'done',cursor),waitState(reviewer.terminalId,'done',cursor)]);
      for(const worker of [store.worker(jobAgent.agentId),store.worker(reviewer.agentId)]){
        const terminal=await rpc.request('terminal.get',{terminal:worker.terminalId});
        assert.equal(terminal.cwd,desks.project('desk-a','home').path);assert.equal(terminal.labels['codex.desk'],'desk-a');assert.equal(terminal.labels['codex.desk-project'],'home');
        assert.deepEqual(worker.writePaths,[]);assert.ok(worker.readPaths.includes(vault));
        assert.match((await prompts(worker.id))[0].text,/Synthetic Desk A/);
      }
      assert.equal(desks.job('desk-a','job-one').status,'running','Native done is not a verified business outcome');
      return {terminals:[jobAgent.terminalId,reviewer.terminalId],job:desks.job('desk-a','job-one')};
    });
    await check('desk replay and registry edits retain the original native process and do not regress review state',async()=>{
      desks.jobUpdate('desk-a','job-one',{status:'review',note:'Fixture native output observed; awaiting evidence review.'});
      desks.update('desk-a',{purpose:'Updated desk purpose for future assignments'});
      const result=await deskCommand(args);assert.equal(result.agent.terminalId,jobAgent.terminalId);assert.equal(result.job.status,'review');
      assert.equal((await prompts(jobAgent.agentId)).length,1);
      const other=new Store(join(paths.manager,'manager.sqlite'));try{assert.equal(new Desks({store:other,config}).job('desk-a','job-one').agentId,jobAgent.agentId);}finally{other.close();}
      return {jobState:result.job.status,terminal:result.agent.terminalId};
    });
    await check('cross-desk delegation fails before launch and settled jobs do not restart',async()=>{
      desks.projectAdd({deskId:'desk-b',id:'shared',name:'Explicit shared path',path:desks.project('desk-a','home').path});
      desks.definitionPut({...specialist,deskId:'desk-b',resourceIds:[]});
      const before=(await rpc.request('terminal.list',{all:true})).terminals.length;
      await assert.rejects(api.delegate({id:'wrong-desk',threadId:THREAD,deskId:'desk-b',deskProjectId:'shared',deskDefinitionId:'analyst',taskId:jobAgent.taskId,deskJobId:'job-one',instruction:'Must not launch.'}));
      assert.equal((await rpc.request('terminal.list',{all:true})).terminals.length,before);
      desks.jobUpdate('desk-a','job-one',{status:'completed',note:'Actual native receipts, text, identity and preserved source verified by harness.'});
      const result=await deskCommand(args);assert.equal(result.actionable,false);assert.equal((await prompts(jobAgent.agentId)).length,1);
      await assert.rejects(api.followup(jobAgent.agentId,'after-settlement',{instruction:'Must not restart.'}),/settled/);
      assert.equal(await readFile(join(vault,'procedure.md'),'utf8'),sourceBefore);
      return {noExtraTerminals:true,sourcePreserved:true,job:result.job};
    });
    await check('file-authored desk launches concurrent native writers with independent vault outputs',async()=>{
      const sourceVault=join(out,'template-vault');await mkdir(sourceVault);await writeFile(join(sourceVault,'human.md'),'Human source must survive.\n');
      desks.create({id:'desk-files',name:'Files',purpose:'File role native test',vaultPath:sourceVault});desks.files.scaffold('desk-files');
      const input=id=>({id,threadId:THREAD,deskId:'desk-files',deskDefinitionId:'operator',instruction:'WRITE_DESK_FILE write the assigned task result.'});
      const cursor=evidence.events.length;
      const agents=await Promise.all(['file-alpha','file-beta'].map(id=>api.delegate(input(id))));
      await Promise.all(agents.map(a=>waitState(a.terminalId,'done',cursor)));
      for(const a of agents){const w=store.worker(a.agentId);assert.equal(w.writePaths.length,2);assert.ok(!w.writePaths.includes(w.project));assert.equal(await readFile(join(w.delegation.spec.deskWorkspace.outputs,'native-1.md'),'utf8'),'Native task output 1\n');}
      const role=join(sourceVault,'Desk/agents/operator/AGENT.md');await writeFile(role,(await readFile(role,'utf8'))+'\nEDITED_ROLE_NATIVE_MARKER\n');
      const next=await api.delegate(input('file-gamma'));assert.equal(store.worker(next.agentId).deskDefinitionVersion,2);assert.match((await prompts(next.agentId))[0].text,/EDITED_ROLE_NATIVE_MARKER/);
      await writeFile(role,'invalid authored file');await api.followup('file-alpha','frozen-file-followup',{instruction:'WRITE_DESK_FILE continue the same task.'});
      await assert.rejects(api.delegate(input('file-delta')),/frontmatter/);
      assert.equal(store.worker('file-alpha').deskDefinitionVersion,1);assert.equal(await readFile(join(sourceVault,'human.md'),'utf8'),'Human source must survive.\n');
      return {terminals:agents.map(a=>a.terminalId),newVersion:2,originalVersion:1,sourcePreserved:true};
    });

  }
}catch(error){failure=error;evidence.error={message:error.message,stack:error.stack};}
finally{
  observer?.close();
  if(rpc&&!rpc.closed){
    for(const worker of store?.workers()??[])if(worker.terminalId){try{await rpc.request('terminal.kill',{terminal:worker.terminalId});}catch(error){evidence.cleanup.push({terminal:worker.terminalId,error:error.message});}}
    try{await rpc.request('server.stop');evidence.cleanup.push('isolated core stop requested');}catch(error){evidence.cleanup.push(error.message)}rpc.close();
  }
  if(core&&core.exitCode===null&&core.signalCode===null){const soft=setTimeout(()=>core.kill('SIGTERM'),3000),hard=setTimeout(()=>core.kill('SIGKILL'),5000);evidence.coreExit=await coreExit;clearTimeout(soft);clearTimeout(hard);}else if(coreExit)evidence.coreExit=await coreExit;
  if(store){evidence.workers=store.workers();store.close();}
  evidence.passed=!failure;evidence.finishedAt=new Date().toISOString();await writeFile(join(out,'native-delegation.json'),JSON.stringify(evidence,null,2)+'\n');
  const {events,workers,...summary}=evidence;await writeFile(join(out,'summary.json'),JSON.stringify({...summary,eventCount:events.length},null,2)+'\n');
}
console.log(JSON.stringify({passed:evidence.passed,summary:join(out,'summary.json')}));if(failure){console.error(failure.stack);process.exitCode=1;}
