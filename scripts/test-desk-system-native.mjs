#!/usr/bin/env node
/** Portable task fixtures and independent acceptance checks for the Desk system.
 * Native integration is added below once the workflow engine contract is ready.
 * No model starts merely by importing this module or preparing fixture copies.
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir,stat,mkdtemp} from 'node:fs/promises';
import {existsSync,watch,openSync,closeSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {Bridge} from '../src/bridge.mjs';
import {Desks} from '../src/desks.mjs';
import {RecipeLibrary} from '../src/recipes.mjs';
import {WorkflowRuns} from '../src/desk-runs.mjs';
import {HerdrClient} from '../src/native.mjs';
import {inspectCoreBinary} from '../src/runtime-checks.mjs';
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const fixtureRoot=join(packageRoot,'tests/fixtures/desk-system');
export async function sourceHashes(root){
 const files={};async function walk(rel){for(const name of (await readdir(join(root,rel))).sort()){const path=join(rel,name);if((await stat(join(root,path))).isDirectory())await walk(path);else files[path]=createHash('sha256').update(await readFile(join(root,path))).digest('hex');}}await walk('');return files;
}
export async function prepareFixtures(out){
 if(!isAbsolute(out))throw new Error('Absolute output directory required');await mkdir(out,{recursive:false,mode:0o700});
 const projects={};for(const name of ['coding','research','operations']){projects[name]=join(out,name);await cp(join(fixtureRoot,name),projects[name],{recursive:true,errorOnExist:true});}
 const result={version:1,projects,noModels:true,sourceHashes:Object.fromEntries(await Promise.all(Object.entries(projects).map(async([name,path])=>[name,await sourceHashes(path)])))};
 await writeFile(join(out,'fixtures.json'),JSON.stringify(result,null,2)+'\n');return result;
}
export async function verifyCoding(project){
 // Separate process observes real public API behavior; it does not import worker tests.
 const checks=String.raw`
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {parseManifest:p,allocate:a}=await import(pathToFileURL(process.argv[1]).href);
const expected=[{id:'A, East',units:2,priority:3},{id:'B "quoted"',units:4,priority:0},{id:'C\nline',units:1,priority:2}];
assert.deepEqual(p('"id",units,priority\r\n"A, East",2,3\r\n"B ""quoted""",4,0\r\n"C\nline",1,2\r\n'),expected);
assert.deepEqual(p('id,units,priority\n" A ",1,0'),[{id:' A ',units:1,priority:0}]);
assert.deepEqual(p('id,units,priority'),[]);
assert.deepEqual(p('id,units,priority\r\n'),[]);
assert.deepEqual(p('id,units,priority\n"A\r\nB",1,0\n'),[{id:'A\r\nB',units:1,priority:0}]);
let rejected=0;
for(const input of ['id,units,priority\nA,1,0\nA,2,1','id,units,priority\n,1,0','id,units,priority\nA,1,0,extra','id,units,priority\nA,1','id,units,priority\nA,1,0\n\n','id,units,priority\n"A,1,0','id,units,priority\nA"B,1,0','id,units,priority\n"A"tail,1,0','id,units,priority\nA,1,0\n\nB,1,0','id,priority,units\nA,1,0']){assert.throws(()=>p(input),Error,input);rejected++;}
for(const value of ['0','-1','+1','1.0','1e2','01',' 1','1 ','9007199254740992']){assert.throws(()=>p('id,units,priority\nA,'+value+',0'),Error);rejected++;}
for(const value of ['-1','+1','1.0','1e2','00',' 1','1 ','9007199254740992']){assert.throws(()=>p('id,units,priority\nA,1,'+value),Error);rejected++;}
assert.deepEqual(p('id,units,priority\nA,9007199254740991,9007199254740991'),[{id:'A',units:9007199254740991,priority:9007199254740991}]);
assert.deepEqual(a([{id:'A',units:2,priority:1},{id:'B',units:3,priority:2},{id:'C',units:1,priority:1}],5),{selected:['B','A'],remaining:0});
console.log(JSON.stringify({passed:true,validCases:6,rejectedCases:rejected,allocationPolicyPreserved:true}));
`;
 const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME};
 const api=spawnSync(process.execPath,['--input-type=module','-e',checks,join(project,'src/manifest.mjs')],{cwd:project,env,encoding:'utf8',timeout:30000});assert.equal(api.status,0,api.stderr||api.stdout);
 const suite=spawnSync(process.execPath,['--test'],{cwd:project,env,encoding:'utf8',timeout:30000});assert.equal(suite.status,0,suite.stderr||suite.stdout);
 return {api:JSON.parse(api.stdout.trim()),suite:{code:suite.status,stdout:suite.stdout,stderr:suite.stderr}};
}
async function citations(project,sources){
 assert.ok(Array.isArray(sources)&&sources.length,'Citations required');
 for(const source of sources){assert.equal(typeof source,'string');assert.match(source,/^sources\/[\w.-]+\.md#[\w-]+$/);const [file,anchor]=source.split('#'),text=await readFile(join(project,file),'utf8');const headings=[...text.matchAll(/^#{1,6} (.+)$/gm)].map(m=>m[1].toLowerCase().replace(/[^a-z0-9 -]/g,'').trim().replace(/ +/g,'-'));assert.ok(headings.includes(anchor),'Missing cited section '+source);}
}
export async function verifyResearch(project,outputs){
 const r=JSON.parse(await readFile(join(outputs,'briefing.json'),'utf8')),md=await readFile(join(outputs,'briefing.md'),'utf8');
 const expected={retentionDays:14,approvalRequired:true,releaseWindowUtc:{start:'09:00',end:'11:00'},minRollbackVersions:2};
 for(const [key,value]of Object.entries(expected)){assert.deepEqual(r.facts?.[key]?.value,value,key);await citations(project,r.facts[key].sources);}
 assert.ok(r.facts.retentionDays.sources.includes('sources/02-amendment.md#retention'));
 assert.ok(r.facts.approvalRequired.sources.includes('sources/01-policy.md#approvals'));
 const conflict=r.conflicts?.find(x=>x.field==='retentionDays');assert.ok(conflict,'Retention conflict must be explicit');assert.equal(conflict.oldValue,30);assert.equal(conflict.currentValue,14);assert.match(conflict.resolution,/amend|supersed|replac/i);await citations(project,conflict.sources);
 assert.ok(conflict.sources.includes('sources/01-policy.md#retention'));assert.ok(conflict.sources.includes('sources/02-amendment.md#retention'));
 const unresolved=r.unresolved?.find(x=>/on.?call|owner/i.test(x.question));assert.ok(unresolved,'Unassigned release owner must remain unresolved');await citations(project,unresolved.sources);
 assert.equal(r.recommendation.enableAutomaticRelease,false);assert.match(r.recommendation.rationale,/approv|human/i);await citations(project,r.recommendation.sources);assert.ok(md.length>200);assert.match(md,/14/);assert.match(md,/30/);assert.match(md,/02-amendment/);
 return {passed:true,factsChecked:4,sourceAnchorsChecked:true,conflictResolved:true,missingOwnerPreserved:true,automaticReleaseNotAuthorized:true};
}
export async function verifyOperations(project,outputs){
 const ledger=JSON.parse(await readFile(join(outputs,'ledger.json'),'utf8')),audit=JSON.parse(await readFile(join(outputs,'audit.json'),'utf8')),md=await readFile(join(outputs,'reconciliation.md'),'utf8');
 assert.deepEqual(ledger,[{poId:'PO-101',revision:2,vendor:'Acorn Supply',amountCents:12500,currency:'USD',sourceId:'mail-2'},{poId:'PO-102',revision:2,vendor:'Blue Harbor',amountCents:20000,currency:'USD',sourceId:'old-102'},{poId:'PO-103',revision:1,vendor:'Cedar Works',amountCents:3500,currency:'USD',sourceId:'mail-1'},{poId:'PO-105',revision:1,vendor:'Elder Fabrication',amountCents:725,currency:'USD',sourceId:'mail-6'}]);
 const incoming=(await readFile(join(project,'input/incoming.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const actions=['insert','duplicate','update','stale','quarantine','quarantine','insert','quarantine','quarantine','quarantine'];assert.equal(audit.decisions.length,incoming.length);
 audit.decisions.forEach((d,i)=>{assert.equal(d.sourceId,incoming[i].sourceId);assert.equal(d.poId,incoming[i].poId);assert.equal(d.action,actions[i]);assert.ok(typeof d.reason==='string'&&d.reason.trim().length>=8,'Meaningful audit reason required');});
 assert.deepEqual(audit.totals,{count:4,amountCents:36725,currency:'USD'});assert.ok(md.length>200);assert.match(md,/quarantin/i);assert.match(md,/line/i);
 assert.match(md,/(?:\b(?:five|5)\s+(?:(?:incoming|input|individual|quarantined)\s+)*(?:records|rows|lines|quarantines)\b|quarantines\s*(?:\(\s*5\s*\)|\|\s*5\b))/i,'Narrative or summary table must account for five individual quarantined records');
 assert.doesNotMatch(md,/\b(?:four|4)\s+records\s+(?:remain|are)\s+quarantined/i,'Do not confuse grouped bullet points with individual records');
 assert.doesNotMatch(md,/all\s+(?:fixtures|(?:fixture|input|incoming)\s+records)\s+(?:are|use)\s+USD/i,'Only accepted ledger records are all USD; input includes EUR');
 return {passed:true,finalPurchaseOrders:4,amountCents:36725,rowsAccountedFor:10,duplicates:1,stale:1,quarantines:5};
}


export async function runNative({coreBinary,profileFile,out,task='all'}){
 const candidate=inspectCoreBinary(coreBinary);if(!isAbsolute(profileFile))throw new Error('Absolute selected profile required');
 const selected=JSON.parse(await readFile(profileFile,'utf8'));
 assert.ok(selected.model&&selected.goose&&selected.piCli&&selected.credentialFile&&selected.endpoint,'Selected worker profile is incomplete');
 if(!['all','coding','research','operations'].includes(task))throw new Error('Unknown task selection');
 const tasks=task==='all'?['coding','research','operations']:[task],prepared=await prepareFixtures(out),paths={};
 for(const name of ['config','state','manager','vaults']){paths[name]=join(out,name);await mkdir(paths[name],{mode:0o700});}
 await mkdir(join(paths.config,'herdr-core'));await writeFile(join(paths.config,'herdr-core/config.toml'),'notes = false\ndraft_wait = 0\nshell = ["/bin/sh"]\n');
 const runtime=await mkdtemp('/private/tmp/herdr-desk-system-'),socket=join(runtime,'core.sock'),session='desk-system-'+randomUUID().slice(0,12);
 const env={HOME:process.env.HOME,USER:process.env.USER??'test',LOGNAME:process.env.LOGNAME??'test',PATH:`${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,SHELL:'/bin/sh',TERM:'xterm-256color',XDG_CONFIG_HOME:paths.config,XDG_STATE_HOME:paths.state,XDG_RUNTIME_DIR:runtime,HC_SESSION:session,HC_SOCKET:socket};
 const quote=x=>`'${String(x).replaceAll("'","'\\''")}'`,wrapper=join(out,'hc');
 await writeFile(wrapper,`#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(env).map(([k,v])=>quote(k+'='+v)).join(' ')} ${quote(candidate.path)} "$@"\n`,{mode:0o700});
 const piModels=selected.piModelsFile??join(dirname(profileFile),'pi-models.json');
 const isolatedProfile=join(out,'selected-profile.json');await writeFile(isolatedProfile,JSON.stringify({...selected,...(existsSync(piModels)?{piModelsFile:piModels}:{})},null,2)+'\n',{mode:0o600});
 const config={version:1,path:join(out,'integration-config.json'),stateDir:paths.manager,packageRoot,hc:wrapper,app:'/never-launch-production-app',codex:'/never-dispatch-codex',node:process.execPath,profileFile:isolatedProfile,registryDoc:'cx-desk-system',autoNotifySettleMs:250};await writeFile(config.path,JSON.stringify(config,null,2)+'\n');
 const THREAD='00000000-0000-4000-8000-000000000001',evidence={version:1,startedAt:new Date().toISOString(),out,session,binary:candidate,selectedModel:selected.model,selectedEndpoint:selected.endpoint,productionUnchanged:true,noCodexDispatch:true,noRequestQuota:true,tasks:[],notifications:[],cleanup:[],usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,note:'No provider usage was inferred from terminal text. Agent launch count and elapsed time are measured; authoritative usage export is separate.'}};
 let core,coreExit,rpc,observer,bridge,engine,failure,epoch=0,interrupted=null;const listeners=new Set();
 const change=()=>{epoch++;for(const resolve of [...listeners])resolve();listeners.clear();};
 const changed=since=>since!==epoch?Promise.resolve():new Promise(resolve=>listeners.add(resolve));
 const onSignal=signal=>{interrupted=signal;change();},onInterrupt=()=>onSignal('SIGINT'),onTerminate=()=>onSignal('SIGTERM');process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
 const ready=()=>existsSync(socket)?Promise.resolve():new Promise((res,rej)=>{const watcher=watch(runtime,()=>{if(existsSync(socket))finish();});const timer=setTimeout(()=>finish(new Error('Isolated core socket did not appear')),15000);const finish=error=>{clearTimeout(timer);watcher.close();error?rej(error):res();};watcher.on('error',finish);});
 try{
  const log=openSync(join(out,'core.log'),'a',0o600);core=spawn(candidate.path,['serve'],{env:{...env,HC_LAUNCHD_DIRECT:String(process.pid)},stdio:['ignore',log,log]});closeSync(log);coreExit=new Promise(res=>{core.once('exit',(code,signal)=>{res({code,signal});change();});core.once('error',error=>{res({error:error.message});change();});});await ready();
  rpc=new HerdrClient({hc:wrapper,timeoutMs:90000});evidence.core=await rpc.request('server.status');assert.equal(evidence.core.pid,core.pid,'Isolated core ownership mismatch');
  observer=new HerdrClient({hc:wrapper,timeoutMs:90000});await observer.subscribe(note=>{if(note.method==='missed'||note.method==='event'&&['status','finished','turn','lost','restarted','removed','doc'].includes(note.params?.type))change();});
  const queue={async list(thread){assert.equal(thread,THREAD);return [];},async add(thread,{clientId,text}){assert.equal(thread,THREAD);const id=/^Herdr inbox notification: (hn-[^\n]+)/.exec(text)?.[1];assert.ok(id);const envelope=bridge.notifications.get(id);evidence.notifications.push({id,clientId,members:envelope.members,at:new Date().toISOString()});change();return {id:'fake:'+id,clientUserMessageId:clientId,input:[{type:'text',text}]};},async update(){throw new Error('Fake host consumes messages immediately');},async delete(){throw new Error('Fake host has no pending rows');},close(){}};
  bridge=new Bridge(config,{queue});const pulse=async()=>{const doc=await rpc.request('doc.get',{name:config.registryDoc});await rpc.request('doc.set',{name:config.registryDoc,version:doc.version,value:{nonce:randomUUID()}});change();};
  engine=new WorkflowRuns({store:bridge.store,config,rpc,pulse,onError:error=>{evidence.runtimeError=error.message;change();}});bridge.deskRuntime=engine;await bridge.start();await bridge.chain;
  const desks=new Desks({store:bridge.store,config}),recipes=new RecipeLibrary({store:bridge.store,config,desks});
  for(const name of tasks){
   const project=prepared.projects[name],vault=join(paths.vaults,name);await mkdir(vault);desks.create({id:name,name:'Acceptance '+name,purpose:'Isolated realistic '+name+' acceptance task',vaultPath:vault});desks.files.scaffold(name);desks.projectAdd({deskId:name,id:'task',name:'Task checkout',path:project});
   const definition=(id,harness,extra={})=>({deskId:name,id,name:id,harness,scope:'write',writeMode:'task',instructions:'Complete the assigned README task within granted resources. Preserve source material unless implementation is explicitly assigned. Report actual evidence and remaining issues. Derive narrative counts and totals from final artifact arrays, counting individual records rather than grouped bullet points. Distinguish incoming records from accepted records. Check prose for contradictions against the data before reporting.',resourceIds:['vault'],acceptance:['Task-specific independent acceptance checks pass'],...extra});
   let steps;
   if(name==='coding'){
    desks.definitionPut(definition('implementer','pi',{writeMode:'project'}));
    desks.definitionPut(definition('lead','goose',{authority:{delegateRoles:['implementer'],reviewRoles:['implementer']},instructions:'You supervise the workflow implementer. A child step is already assigned by the workflow; do not create duplicate children. Inspect README and source, then end your initial turn without a final report while the implementer works. Its question/result reaches you through herdr-supervise. Independently review actual files and tests, request corrections if needed, then record and acknowledge the accepted child result. Send one consolidated result only after the child work is accepted. Do not implement the code yourself.'}));
    steps=[{id:'lead',kind:'agent',definitionId:'lead',instructions:'Supervise the CSV manifest parser task in README.md. The implementation child is started by the workflow. Do not ask Codex for routine implementation decisions; the contract is in README.md.'},{id:'implement',kind:'agent',definitionId:'implementer',supervisorStepId:'lead',instructions:'Implement the complete README.md request now, add meaningful tests, run them and report the actual changed files and results through herdr-message. The assigned Goose lead handles review. Do not change the allocation policy or install dependencies.'}];
   }else{
    desks.definitionPut(definition('specialist','goose'));
    const native=`title: ${name} acceptance\ndescription: Complete the synthetic ${name} desk task\ninstructions: Follow the assigned resources and task-specific output paths. Preserve input sources. Cite actual evidence and do not invent approvals.\nprompt: |\n  Read README.md and the source files in the current project. Complete every requested deliverable.\n  Write deliverables in {{ outputs }}. Write supporting checks in {{ evidence }}.\n  Verify your files and send a substantive result using herdr-message.\nparameters:\n  - key: outputs\n    input_type: string\n    requirement: required\n    description: Assigned output directory\n  - key: evidence\n    input_type: string\n    requirement: required\n    description: Assigned evidence directory\n`;
    const recipe=recipes.put(name,{id:'task-recipe',content:native});const validation=await recipes.validateNative(recipes.snapshot(name,recipe.id));assert.ok(validation.passed,JSON.stringify(validation));
    steps=[{id:'deliver',kind:'recipe',definitionId:'specialist',recipeId:'task-recipe',parameters:{outputs:'{{outputs}}',evidence:'{{evidence}}'},instructions:'Complete README.md using the native recipe and the explicit output/evidence paths. No input source edits, no external communications.'}];
    if(name==='operations'){
     desks.definitionPut(definition('lead','goose',{authority:{delegateRoles:['specialist'],reviewRoles:['specialist']},instructions:'Supervise the finite native Goose recipe already assigned by this workflow. Do not create duplicate children or do the reconciliation yourself. Read README.md and policy.md, then end your initial turn while the recipe runs. When its report reaches you through herdr-supervise, inspect its actual output files and independently check every input decision and integer total. Request or escalate a supported defect; otherwise record and acknowledge the accepted result. Send one consolidated final report after acceptance. A native recipe is finite and does not accept ordinary terminal follow-ups after exit.'}));
     steps[0].supervisorStepId='lead';steps.unshift({id:'lead',kind:'agent',definitionId:'lead',instructions:'Review the assigned reconciliation recipe under the explicit policy in README.md and policy.md. Its child is already assigned by the workflow. Use herdr-supervise for its report; do not send premature completion or create more agents.'});
    }
   }
   desks.workflowPut({deskId:name,id:'acceptance',name:'Realistic '+name,projectId:'task',steps});
   const started=Date.now();await engine.create({deskId:name,id:'trial',workflowId:'acceptance',ownerThread:THREAD,parameters:{}});await engine.pulse();
   const accepted=new Set();let checked=null;
   console.log('START '+name+' '+JSON.stringify(engine.get(name,'trial').steps));
   while(true){
    const cursor=epoch;if(interrupted)throw new Error('Test interrupted by '+interrupted);if(core.exitCode!==null||core.signalCode!==null)throw new Error('Isolated native core exited before task completion');await bridge.chain;await engine.pulse();
    const run=engine.get(name,'trial');if(run.status==='blocked')throw new Error(name+' workflow blocked: '+JSON.stringify(run.steps));
    const workers=bridge.store.workers().filter(w=>w.deskId===name&&w.deskRunId==='trial');
    const escalated=bridge.store.messages({pending:true}).find(m=>workers.some(w=>w.id===m.workerId)&&bridge.supervision.route(m.id)?.state==='escalated');
    if(escalated)throw new Error(name+' required manager intervention: '+JSON.stringify({messageId:escalated.id,route:bridge.supervision.route(escalated.id),text:escalated.text.slice(0,800)}));
    for(const worker of workers.filter(w=>!w.supervisorId)){
     const messages=bridge.store.messages({taskId:worker.taskId,pending:true});if(messages.some(m=>m.kind==='question'))throw new Error(name+' requested manager input: '+messages.find(m=>m.kind==='question').text);
     const native=await rpc.request('terminal.get',{terminal:worker.terminalId});
     if(native.state==='finished'&&worker.executionKind==='recipe'&&!engine.executionReceipt(worker))throw new Error(name+' recipe ended without execution evidence: '+JSON.stringify({terminal:worker.terminalId,exit:native.exit_code,signal:native.signal}));
     if(!messages.some(m=>m.kind==='result')||accepted.has(worker.id))continue;
     if(worker.executionKind==='recipe'&&native.state!=='finished')continue;
     if(native.state==='live'&&!['done','idle'].includes(native.status?.state))continue;
     const childStep=name==='coding'?'implement':name==='operations'?'deliver':null;
     if(childStep&&run.steps[childStep]?.status!=='completed')continue;
     const workspace=childStep?run.steps[childStep].workspace:worker.delegation.spec.deskWorkspace;
     checked=await ({coding:verifyCoding,research:verifyResearch,operations:verifyOperations}[name])(project,workspace.outputs);
     if(name!=='coding')assert.deepEqual(await sourceHashes(project),prepared.sourceHashes[name],'Input source files changed');
     else for(const file of ['README.md','package.json'])assert.equal((await sourceHashes(project))[file],prepared.sourceHashes[name][file],'Task contract changed');
     for(const message of messages){bridge.store.receive(message.id);bridge.store.recordAction(message.id,{kind:'accept',requestId:'fixture-'+message.id,text:'Independent fixture checks passed; actual outputs and source preservation verified.'});bridge.store.ack(message.id);}
     accepted.add(worker.id);await pulse();console.log('VERIFIED '+name+' '+worker.id);
    }
    await engine.pulse();const after=engine.get(name,'trial');if(after.status==='completed'){
     evidence.tasks.push({name,passed:true,elapsedMs:Date.now()-started,checks:checked,run:after,agentLaunches:workers.length,workers:workers.map(w=>({id:w.id,terminalId:w.terminalId,role:w.role,supervisorId:w.supervisorId??null,executionKind:w.executionKind??'agent',workspace:w.delegation.spec.deskWorkspace}))});console.log('PASS '+name);break;
    }
    await changed(cursor);
   }
  }
 }catch(error){failure=error;evidence.error={message:error.message,stack:error.stack};}
 finally{
  process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);
  if(bridge){evidence.workers=bridge.store.workers().map(w=>({id:w.id,deskId:w.deskId,terminalId:w.terminalId,role:w.role,stateDir:w.stateDir,supervisorId:w.supervisorId??null}));evidence.messages=bridge.store.messages().map(m=>({id:m.id,workerId:m.workerId,kind:m.kind,text:m.text,acknowledgedAt:m.acknowledgedAt,action:m.action}));
   for(const w of evidence.workers)if(w.terminalId)try{await writeFile(join(out,w.id+'-terminal.json'),JSON.stringify(await rpc.request('terminal.read',{terminal:w.terminalId,lines:2000}),null,2)+'\n');}catch{}
   try{await bridge.stop();await bridge.chain;bridge.store.close();evidence.cleanup.push('isolated bridge stopped');}catch(error){evidence.cleanup.push('bridge cleanup: '+error.message);}
  }
  observer?.close();if(rpc){for(const w of evidence.workers??[])if(w.terminalId)try{await rpc.request('terminal.kill',{terminal:w.terminalId});}catch{}try{await rpc.request('server.stop');evidence.cleanup.push('isolated core stop requested');}catch(error){evidence.cleanup.push('core cleanup: '+error.message);}rpc.close();}
  if(core&&core.exitCode===null&&core.signalCode===null){const soft=setTimeout(()=>core.kill('SIGTERM'),3000),hard=setTimeout(()=>core.kill('SIGKILL'),5000);evidence.coreExit=await coreExit;clearTimeout(soft);clearTimeout(hard);}else if(coreExit)evidence.coreExit=await coreExit;
  evidence.finishedAt=new Date().toISOString();evidence.passed=!failure&&evidence.coreExit?.code===0&&!evidence.coreExit?.signal;
  await writeFile(join(out,'desk-system-report.json'),JSON.stringify(evidence,null,2)+'\n');
 }
 if(failure)throw failure;if(!evidence.passed)throw new Error('Native cleanup did not finish cleanly');return evidence;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{out:{type:'string'},'prepare-only':{type:'boolean'},check:{type:'string'},project:{type:'string'},outputs:{type:'string'},run:{type:'boolean'},'core-binary':{type:'string'},profile:{type:'string'},task:{type:'string',default:'all'},help:{type:'boolean'}}});
 if(values.help)console.log('Prepare isolated tasks: --prepare-only --out /absolute/new-directory\nCheck completed work: --check coding|research|operations --project /absolute/project [--outputs /absolute/outputs]\nRun approved Modal trials: --run --core-binary /absolute/raw/herdr-core --profile /absolute/selected-profile.json --out /absolute/new-directory [--task coding|research|operations|all]');
 else if(values['prepare-only'])console.log(JSON.stringify(await prepareFixtures(values.out),null,2));
 else if(values.check){const checks={coding:verifyCoding,research:verifyResearch,operations:verifyOperations};if(!checks[values.check])throw new Error('Unknown task');for(const key of values.check==='coding'?['project']:['project','outputs'])if(!isAbsolute(values[key]??''))throw new Error('Absolute --'+key+' required');console.log(JSON.stringify(await checks[values.check](values.project,values.outputs),null,2));}
 else if(values.run)console.log(JSON.stringify(await runNative({coreBinary:values['core-binary'],profileFile:values.profile,out:values.out,task:values.task}),null,2));
 else throw new Error('Select --prepare-only, --check or --run');
}
