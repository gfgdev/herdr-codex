#!/usr/bin/env node
/** Native deterministic Desk commands and event/interval/watcher recovery. No models. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rename,mkdtemp,realpath} from 'node:fs/promises';
import {existsSync,watch,openSync,closeSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {Bridge} from '../src/bridge.mjs';
import {HerdrClient} from '../src/native.mjs';
import {WorkflowRuns} from '../src/desk-runs.mjs';
import {Desks} from '../src/desks.mjs';
import {inspectCoreBinary} from '../src/runtime-checks.mjs';
import {load,JSON_SCHEMA} from '../src/vendor-js-yaml.mjs';
const {values}=parseArgs({options:{'core-binary':{type:'string'},out:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('node scripts/test-desk-runtime-native.mjs --core-binary /absolute/raw/herdr-core --out /absolute/new-directory\nIsolated native command/trigger tests. No models or real Codex dispatch.');process.exit(0);}
if(!isAbsolute(values.out??''))throw new Error('Absolute new --out required');
const binary=inspectCoreBinary(values['core-binary']),out=resolve(values.out),packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(out,{recursive:false,mode:0o700});
const paths=Object.fromEntries(['config','state','manager','project','vault'].map(name=>[name,join(out,name)]));for(const path of Object.values(paths))await mkdir(path,{mode:0o700});
await mkdir(join(paths.config,'herdr-core'));await writeFile(join(paths.config,'herdr-core/config.toml'),'notes = false\ndraft_wait = 0\nshell = ["/bin/sh"]\n');
await writeFile(join(paths.project,'input.txt'),'approved-input\n');await writeFile(join(paths.vault,'human.md'),'preserve human note\n');
const runtime=await mkdtemp('/private/tmp/herdr-runtime-test-'),socket=join(runtime,'core.sock'),session='runtime-'+randomUUID().slice(0,12);
const env={HOME:process.env.HOME,USER:process.env.USER??'test',LOGNAME:process.env.LOGNAME??'test',PATH:`${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,SHELL:'/bin/sh',TERM:'xterm-256color',XDG_CONFIG_HOME:paths.config,XDG_STATE_HOME:paths.state,XDG_RUNTIME_DIR:runtime,HC_SESSION:session,HC_SOCKET:socket};
const quote=x=>`'${String(x).replaceAll("'","'\\''")}'`,hc=join(out,'hc');await writeFile(hc,`#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(env).map(([k,v])=>quote(k+'='+v)).join(' ')} ${quote(binary.path)} "$@"\n`,{mode:0o700});
const profileFile=join(out,'unused-model-profile.json');await writeFile(profileFile,JSON.stringify({model:'no-model-used',credentialFile:join(out,'credential-does-not-exist')}));
const config={version:1,path:join(out,'integration-config.json'),stateDir:paths.manager,packageRoot,hc,node:process.execPath,profileFile,app:'/never-open-app',codex:'/never-contact-codex',registryDoc:'cx-runtime-test',autoNotifySettleMs:100};await writeFile(config.path,JSON.stringify(config,null,2)+'\n');
const THREAD='00000000-0000-4000-8000-000000000001';
const evidence={version:1,out,session,binary,startedAt:new Date().toISOString(),noModels:true,noCodexDispatch:true,checks:[],cleanup:[],notifications:[],events:[]};
let core,coreExit,rpc,observer,bridge,engine,desks,failure,epoch=0,aborted=null;const listeners=new Set();
const notify=value=>{epoch++;if(value)evidence.events.push(value);for(const callback of [...listeners])callback();listeners.clear();};
async function until(predicate,label,timeoutMs=15000){
 const deadline=Date.now()+timeoutMs;
 while(true){const cursor=epoch;if(aborted)throw new Error('Interrupted: '+aborted);const value=await predicate();if(value)return value;const remaining=deadline-Date.now();if(remaining<=0)throw new Error('Timed out waiting for '+label);
 await new Promise((res,rej)=>{if(epoch!==cursor)return res();const on=()=>{clearTimeout(timer);listeners.delete(on);res();};const timer=setTimeout(()=>{listeners.delete(on);rej(new Error('Timed out waiting for '+label));},remaining);listeners.add(on);});}
}
async function fileReady(path){if(existsSync(path))return;const watcher=watch(dirname(path),()=>notify());try{await until(()=>existsSync(path),'file '+path);}finally{watcher.close();}}
const onInt=()=>{aborted='SIGINT';notify();},onTerm=()=>{aborted='SIGTERM';notify();};process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
async function check(name,fn){const start=Date.now();try{const detail=await fn();evidence.checks.push({name,passed:true,elapsedMs:Date.now()-start,...detail});console.log('PASS '+name);}catch(error){evidence.checks.push({name,passed:false,error:error.message});throw error;}}
const pulse=async()=>{const current=await rpc.request('doc.get',{name:config.registryDoc});await rpc.request('doc.set',{name:config.registryDoc,version:current.version,value:{nonce:randomUUID()}});notify();};
async function startBridge(){
 const queue={async list(thread){assert.equal(thread,THREAD);return [];},async add(thread,{clientId,text}){assert.equal(thread,THREAD);const id=/^Herdr inbox notification: (hn-[^\n]+)/.exec(text)?.[1];assert.ok(id);evidence.notifications.push({id,clientId,members:bridge.notifications.get(id).members});notify();return{id:'fake:'+id,clientUserMessageId:clientId,input:[{type:'text',text}]};},async update(){throw new Error('Fake host consumed row');},async delete(){throw new Error('Fake host consumed row');},close(){}};
 bridge=new Bridge(config,{queue});const journal=bridge.store.journal.bind(bridge.store);bridge.store.journal=(type,data)=>{const result=journal(type,data);notify({journal:type,data});return result;};
 engine=new WorkflowRuns({store:bridge.store,config,rpc,pulse,onError:error=>notify({runtimeError:error.message})});bridge.deskRuntime=engine;desks=new Desks({store:bridge.store,config});await bridge.start();await bridge.chain;
}
async function stopBridge(){await bridge.stop();await bridge.chain;bridge.store.close();bridge=null;engine=null;desks=null;}
async function completed(id){await until(async()=>{await bridge.chain;const run=engine.get('runtime',id);if(run?.status==='blocked')throw new Error('Run blocked: '+JSON.stringify(run.steps));return run?.status==='completed'?run:null;},'completed workflow '+id);return engine.get('runtime',id);}
async function editAutomation(id,changes){const path=join(paths.vault,'Desk/automations',id+'.yaml'),value=load(await readFile(path,'utf8'),{schema:JSON_SCHEMA});Object.assign(value,changes);const temporary=join(dirname(path),'.'+id+'-'+randomUUID()+'.tmp');await writeFile(temporary,JSON.stringify(value,null,2)+'\n');await rename(temporary,path);}
const commandProgram=`
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [outputs,evidence,project,vault,mode,upstream]=process.argv.slice(1);
assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.HERDR_MODAL_API_KEY,undefined);
assert.equal(process.cwd(),project);assert.equal(fs.readFileSync(path.join(project,'input.txt'),'utf8'),'approved-input\\n');
for(const denied of [path.join(project,'forbidden.txt'),path.join(vault,'human.md'),path.join(vault,'Desk/desk.yaml'),path.join(path.dirname(path.dirname(process.env.TMPDIR)),'execution/command-result.json'),path.join(path.dirname(path.dirname(process.env.TMPDIR)),'execution/command-stdout.log')])assert.throws(()=>fs.writeFileSync(denied,'forbidden'),e=>['EPERM','EACCES'].includes(e.code));
const finish=()=>{if(upstream)assert.equal(JSON.parse(fs.readFileSync(upstream,'utf8')).mode,'first');const result={mode,pid:process.pid,cwd:process.cwd(),deniedWrites:5,modelCredentialsAbsent:true};fs.writeFileSync(path.join(outputs,'result.json'),JSON.stringify(result));fs.writeFileSync(path.join(evidence,'check.txt'),'actual checks passed\\n');process.stdout.write('native '+mode+' stdout\\n');process.stderr.write('native '+mode+' stderr\\n');};
fs.writeFileSync(path.join(outputs,'started.json'),JSON.stringify({mode,pid:process.pid}));
if(mode==='first'){const release=path.join(project,'release');if(fs.existsSync(release))finish();else{const watcher=fs.watch(project,()=>{if(fs.existsSync(release)){watcher.close();finish();}});if(fs.existsSync(release)){watcher.close();finish();}}}else finish();
`;
const argv=(mode,upstream='')=>[process.execPath,'-e',commandProgram,'{{outputs}}','{{evidence}}',paths.project,paths.vault,mode,upstream];
try{
 const coreLog=openSync(join(out,'core.log'),'a',0o600);core=spawn(binary.path,['serve'],{env:{...env,HC_LAUNCHD_DIRECT:String(process.pid)},stdio:['ignore',coreLog,coreLog]});closeSync(coreLog);coreExit=new Promise(res=>{core.once('exit',(code,signal)=>{res({code,signal});notify();});core.once('error',error=>{res({error:error.message});notify();});});await fileReady(socket);
 rpc=new HerdrClient({hc,timeoutMs:90000});evidence.core=await rpc.request('server.status');assert.equal(evidence.core.pid,core.pid);
 observer=new HerdrClient({hc,timeoutMs:90000});await observer.subscribe(note=>{if(note.method==='event'||note.method==='missed')notify({native:note});});await startBridge();
 desks.create({id:'runtime',name:'Deterministic runtime fixture',purpose:'Native deterministic checks only',vaultPath:paths.vault});desks.files.scaffold('runtime');desks.projectAdd({deskId:'runtime',id:'code',name:'Project',path:paths.project});
 desks.definitionPut({deskId:'runtime',id:'command-role',name:'Command runner',harness:'pi',scope:'write',writeMode:'task',instructions:'Execute the frozen command only.',resourceIds:['vault'],acceptance:['Actual command exit and output verified.']});
 desks.workflowPut({deskId:'runtime',id:'chain',name:'Persistent command chain',projectId:'code',steps:[{id:'first',kind:'command',definitionId:'command-role',command:{argv:argv('first')}},{id:'second',kind:'command',definitionId:'command-role',dependsOn:['first'],command:{argv:argv('second','{{steps.first.outputs}}/result.json')}}]});
 desks.workflowPut({deskId:'runtime',id:'event-work',name:'One event command',projectId:'code',steps:[{id:'execute',kind:'command',definitionId:'command-role',command:{argv:argv('event')}}]});
 desks.workflowPut({deskId:'runtime',id:'timer-work',name:'One timer command',projectId:'code',steps:[{id:'execute',kind:'command',definitionId:'command-role',command:{argv:argv('timer')}}]});
 await check('native command survives bridge restart and pending dependency runs once',async()=>{
  await engine.create({deskId:'runtime',id:'restart-chain',workflowId:'chain',ownerThread:THREAD});await engine.pulse();const before=engine.get('runtime','restart-chain'),first=bridge.store.worker(before.steps.first.workerId);assert.equal(before.steps.second.status,'pending');
  await fileReady(join(before.steps.first.workspace.outputs,'started.json'));const nativeBefore=await rpc.request('terminal.get',{terminal:first.terminalId});assert.equal(nativeBefore.state,'live');
  await stopBridge();await writeFile(join(paths.project,'release'),'resume after persisted bridge stop\n');
  await until(async()=>{const native=await rpc.request('terminal.get',{terminal:first.terminalId});return native.state==='finished'?native:null;},'first command native exit while bridge stopped');
  assert.equal((await rpc.request('terminal.list',{all:true})).terminals.length,1,'Dependency must not launch without service');
  await startBridge();const after=await completed('restart-chain');assert.equal(after.steps.first.workerId,first.id);assert.equal(bridge.store.workers().length,2);
  const results=[];for(const step of Object.values(after.steps)){const worker=bridge.store.worker(step.workerId),native=await rpc.request('terminal.get',{terminal:worker.terminalId}),receipt=engine.executionReceipt(worker);assert.equal(native.state,'finished');assert.equal(native.exit_code,0);assert.equal(receipt.receipt.pid,worker.launchResult.pid);assert.equal(receipt.receipt.terminalId,worker.terminalId);assert.equal(receipt.success,true);assert.equal(receipt.receipt.modelCalls,0);const result=JSON.parse(await readFile(join(step.workspace.outputs,'result.json'),'utf8'));assert.equal(result.deniedWrites,5);assert.equal(result.modelCredentialsAbsent,true);assert.equal(result.cwd,paths.project);for(const stream of ['stdout','stderr']){const log=receipt.receipt.logs[stream],bytes=await readFile(log.path);assert.equal(log.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(log.bytes,bytes.length);assert.match(bytes.toString(),new RegExp('native '+result.mode+' '+stream));}results.push({workerId:worker.id,terminal:worker.terminalId,pid:worker.launchResult.pid,result,receiptPath:receipt.path});}
  return {results,secondLaunchedOnlyAfterRestart:true};
 });
 await check('new automation is disabled by default and event replay cannot create another command',async()=>{
  const definition=desks.automationPut({deskId:'runtime',id:'event-auto',name:'Fixture event',type:'event',workflowId:'event-work',eventName:'fixture.received'});assert.equal(definition.enabled,false);await engine.triggers.pulse();assert.equal(engine.triggers.status('runtime').watchedAutomationDirectories,1);
  const before=bridge.store.workers().length,disabled=await engine.triggers.emit({deskId:'runtime',id:'disabled-event',eventName:'fixture.received',payload:{value:'disabled'}});assert.deepEqual(disabled.occurrences,[]);assert.equal(bridge.store.workers().length,before);
  // Direct edit; no explicit sync/pulse between the write and observed new version.
  await editAutomation('event-auto',{enabled:true,ownerThread:THREAD});await until(()=>engine.triggers.status('runtime').health?.automations.some(a=>a.id==='event-auto'&&a.enabled),'authored event automation watcher');
  const input={deskId:'runtime',id:'event-one',eventName:'fixture.received',payload:{value:'accepted'}},one=await engine.triggers.emit(input),duplicate=await engine.triggers.emit(input);assert.deepEqual(duplicate,one);assert.equal(one.occurrences.length,1);await completed(one.occurrences[0]);
  await assert.rejects(engine.triggers.emit({...input,payload:{value:'different'}}),/different payload/);assert.equal(bridge.store.workers().length,before+1);assert.equal(engine.triggers.status('runtime').occurrences.filter(x=>x.eventId==='event-one').length,1);
  await editAutomation('event-auto',{enabled:false});await until(()=>engine.triggers.status('runtime').health?.automations.some(a=>a.id==='event-auto'&&!a.enabled),'authored disable watcher');
  const off=await engine.triggers.emit({deskId:'runtime',id:'disabled-again',eventName:'fixture.received'});assert.deepEqual(off.occurrences,[]);assert.equal(bridge.store.workers().length,before+1);
  return {occurrence:one.occurrences[0],workerCount:before+1,defaultDisabled:true,realFilesystemUpdateObserved:true};
 });
 await check('authored interval uses a real service timer and disabling survives restart',async()=>{
  desks.automationPut({deskId:'runtime',id:'timer-auto',name:'Fixture timer',type:'interval',workflowId:'timer-work',everySeconds:60,startAt:new Date(Date.now()+400).toISOString()});await engine.triggers.pulse();
  const before=bridge.store.workers().length;await editAutomation('timer-auto',{enabled:true,ownerThread:THREAD,startAt:new Date(Date.now()+350).toISOString()});
  await until(()=>engine.triggers.status('runtime').occurrences.find(x=>x.automationId==='timer-auto'),'real interval occurrence');const occurrence=engine.triggers.status('runtime').occurrences.find(x=>x.automationId==='timer-auto');await completed(occurrence.jobId);assert.equal(bridge.store.workers().length,before+1);
  await editAutomation('timer-auto',{enabled:false});await until(()=>engine.triggers.status('runtime').health?.automations.some(a=>a.id==='timer-auto'&&!a.enabled),'timer disable watcher');assert.equal(engine.triggers.status('runtime').timerScheduled,false);
  await stopBridge();await startBridge();assert.equal(engine.triggers.status('runtime').timerScheduled,false);assert.equal(bridge.store.workers().length,before+1);assert.equal(engine.triggers.status('runtime').occurrences.filter(x=>x.automationId==='timer-auto').length,1);
  return {occurrence:occurrence.id,workerCount:before+1,realTimer:true,restartDidNotReplay:true};
 });
 assert.equal(await readFile(join(paths.vault,'human.md'),'utf8'),'preserve human note\n');assert.equal(await readFile(join(paths.project,'input.txt'),'utf8'),'approved-input\n');assert.equal(existsSync(profileFile.replace('unused-model-profile.json','credential-does-not-exist')),false);
}catch(error){failure=error;evidence.error={message:error.message,stack:error.stack};}
finally{
 process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);
 if(bridge){
  evidence.workers=bridge.store.workers().map(w=>({id:w.id,terminalId:w.terminalId,launchResult:w.launchResult,executionKind:w.executionKind}));
  try{if(desks.get('runtime')){evidence.runs=engine.list('runtime');evidence.triggers=engine.triggers.status('runtime');}}catch(error){evidence.cleanup.push('evidence snapshot: '+error.message);}
  try{await stopBridge();evidence.cleanup.push('isolated bridge stopped');}catch(error){evidence.cleanup.push('bridge cleanup: '+error.message);}
 }
 observer?.close();if(rpc){for(const worker of evidence.workers??[])if(worker.terminalId)try{await rpc.request('terminal.kill',{terminal:worker.terminalId});}catch{}try{await rpc.request('server.stop');evidence.cleanup.push('isolated core stop requested');}catch(error){evidence.cleanup.push('core cleanup: '+error.message);}rpc.close();}
 if(core&&core.exitCode===null&&core.signalCode===null){const soft=setTimeout(()=>core.kill('SIGTERM'),3000),hard=setTimeout(()=>core.kill('SIGKILL'),5000);evidence.coreExit=await coreExit;clearTimeout(soft);clearTimeout(hard);}else if(coreExit)evidence.coreExit=await coreExit;
 evidence.finishedAt=new Date().toISOString();evidence.passed=!failure&&evidence.coreExit?.code===0&&!evidence.coreExit?.signal;await writeFile(join(out,'desk-runtime-native-report.json'),JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks,coreExit:evidence.coreExit,report:join(out,'desk-runtime-native-report.json')}));
if(failure)throw failure;if(!evidence.passed)throw new Error('Cleanup was not a clean native exit');
