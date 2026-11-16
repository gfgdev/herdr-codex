import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Supervision,isHostMessage} from '../src/supervision.mjs';
import {Notifications} from '../src/notifications.mjs';
import {Bridge} from '../src/bridge.mjs';
import {startActivityBus,requestSupervision} from '../src/activity-ipc.mjs';

const THREAD='00000000-0000-4000-8000-000000000001',OTHER='00000000-0000-4000-8000-000000000002';
function fixture(t){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-supervision-'))),stateDir=join(dir,'state');mkdirSync(stateDir);
 const config={stateDir,path:join(dir,'config.json'),packageRoot:dir,hc:'/never-run-hc',node:process.execPath,codex:'/never-run-codex',registryDoc:'fixture-registry'};
 const database=join(stateDir,'manager.sqlite');let store=new Store(database);
 const desks=new Desks({store,config});desks.create({id:'desk',name:'Fixture',purpose:'Supervision contracts'});
 const definitions={};
 function role(id,authority){return definitions[id]=desks.definitionPut({deskId:'desk',id,name:id,harness:'goose',scope:'read-only',instructions:'Deterministic test role',...(authority?{authority}:{})});}
 role('reader');role('lead',{delegateRoles:['reader'],reviewRoles:['reader']});role('director',{delegateRoles:['lead'],reviewRoles:['lead']});
 const terminals=new Map(),calls=[];let loseSend=false;
 const rpc={close(){},request:async(method,params)=>{
  calls.push({method,params:structuredClone(params)});
  const terminal=terminals.get(params.terminal);
  if(method==='terminal.get'){if(!terminal)throw Object.assign(new Error('Missing'),{data:{kind:'not_found'}});return structuredClone(terminal);}
  if(method==='terminal.read')return {text:'Actual fixture terminal evidence.'};
  if(method==='terminal.send'){terminal.status={state:'working'};if(loseSend){loseSend=false;throw new Error('Lost receipt after native send');}return {turn:terminal.turn,started:true};}
  throw new Error('Unexpected native operation '+method);
 }};
 const api=()=>new Supervision({store,config,rpc,pulse:async()=>{}});
 const project=desks.project('desk','home').path;
 function worker(id,definitionId,{supervisorId,threadId=THREAD,deskId='desk',deskProjectId='home',taskId='task-'+id,grant:grantOverride}={}){
  const definition=definitions[definitionId];
  const grant=grantOverride??(definition.authority?{version:1,childDefinitionIds:definition.authority.delegateRoles,reviewDefinitionIds:definition.authority.reviewRoles,projectIds:['home'],resourceIds:[],allowNested:definitionId==='director',definitionVersions:Object.fromEntries([...new Set([...definition.authority.delegateRoles,...definition.authority.reviewRoles])].map(role=>[role,definitions[role].version]))}:undefined);
  if(!store.task(taskId))store.saveTask({id:taskId,name:taskId,project,threadId,status:'active',deskId,deskProjectId});
  let w={id,name:id,taskId,project,deskId,deskProjectId,deskDefinitionId:definitionId,deskDefinitionVersion:definition.version,
   terminalId:'t'+(terminals.size+1),mailbox:'mail-'+id,role:'goose',stateDir:join(stateDir,'workers',id),writePaths:[],startTurn:0,notifyOnDone:true,launchState:'started',launchResult:{pid:1000+terminals.size},...(supervisorId?{supervisorId}:{}),...(grant?{supervisionGrant:grant}:{})};
  api().validateBinding(w);if(grant)w=api().prepareCredential(w);store.reserveWorker(w);
  terminals.set(w.terminalId,{address:w.terminalId,pid:w.launchResult.pid,state:'live',cwd:project,name:id,turn:0,status:{state:'idle'},labels:{'codex.worker':id,'codex.task':taskId,'codex.desk':deskId,'codex.desk-project':deskProjectId}});return w;
 }
 function message(worker,id,extra={}){const value={id,taskId:worker.taskId,workerId:worker.id,terminalId:worker.terminalId,kind:'question',text:'Question with test evidence.',createdAt:new Date().toISOString(),turn:terminals.get(worker.terminalId).turn,...extra};store.ingest(worker,value,{lifecycle:value.kind==='attention'});return value;}
 const request=(actor,command,args={})=>({workerId:actor.id,terminalId:actor.terminalId,token:JSON.parse(readFileSync(actor.supervisionCredential.credentialFile)).token,command,args});
 const host=[];
 const notices=()=>new Notifications({store,config,queue:{list:async()=>[],add:async(thread,{clientId,text})=>{host.push({thread,text});return {id:'queue-'+host.length,clientUserMessageId:clientId,input:[{type:'text',text}]};}}});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,stateDir,config,rpc,api,desks,definitions,project,worker,message,request,terminals,calls,host,notices,
  get store(){return store;},loseSend(){loseSend=true;},reopen(){store.close();store=new Store(database);},finish(w){const native=terminals.get(w.terminalId);native.status={state:'done'};native.turn++;}};
}

test('two supervisor layers handle child reports while only the consolidated root report reaches Codex',async t=>{
 const f=fixture(t),director=f.worker('director','director'),lead=f.worker('lead','lead',{supervisorId:director.id}),reader=f.worker('reader','reader',{supervisorId:lead.id});
 f.message(reader,'child-question');await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,0);
 assert.equal(f.calls.filter(c=>c.method==='terminal.send')[0].params.terminal,lead.terminalId);
 await f.api().handle(f.request(lead,'receive',{id:'child-question'}));assert.equal(f.store.message('child-question').receivedAt,null,'Supervisor receipt must not prevent later host escalation');
 await f.api().handle(f.request(lead,'decision',{id:'child-question',requestId:'review-1',action:'accept',text:'Inspected fixture evidence.'}));
 await f.api().handle(f.request(lead,'ack',{id:'child-question'}));
 f.message(lead,'lead-result',{kind:'result'});await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,0);
 await f.api().handle(f.request(director,'decision',{id:'lead-result',requestId:'review-2',action:'accept',text:'Verified the child review.'}));await f.api().handle(f.request(director,'ack',{id:'lead-result'}));
 f.message(director,'final-result',{kind:'result'});await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,1);assert.match(f.host[0].text,/final-result/);assert.doesNotMatch(f.host[0].text,/child-question|lead-result/);
});

test('hierarchy rejects different chats/Desks, unauthorized roles, cycles and nested authority',t=>{
 const f=fixture(t),lead=f.worker('lead','lead');
 assert.throws(()=>f.worker('wrong-chat','reader',{supervisorId:lead.id,threadId:OTHER}),/same active Desk and manager chat/);
 assert.throws(()=>f.worker('wrong-desk','reader',{supervisorId:lead.id,deskId:'foreign'}),/same active Desk and manager chat/);
 assert.throws(()=>f.worker('wrong-role','director',{supervisorId:lead.id}),/pinned role/);
 const reader=f.worker('reader','reader',{supervisorId:lead.id});
 assert.throws(()=>f.api().validateBinding({...reader,supervisorId:reader.id}),/itself/);
 assert.throws(()=>f.api().bind({workerId:reader.id,supervisorId:'someone-else'}),/frozen/);
 assert.throws(()=>f.api().grant({...lead,supervisionGrant:{...lead.supervisionGrant,childDefinitionIds:['director']}}),/exceeds/);
 assert.throws(()=>f.api().grant({...lead,supervisionGrant:{...lead.supervisionGrant,definitionVersions:{}}}),/pinned definition/);
});

test('duplicate reconciliation and reopened storage never resend supervisor delivery',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'once');
 await f.api().reconcile();f.reopen();await f.api().reconcile();await f.api().reconcile();
 assert.equal(f.calls.filter(c=>c.method==='terminal.send').length,1);assert.equal(f.api().route('once').state,'delivered');assert.equal(isHostMessage(f.store,f.store.message('once')),false);
});

test('lost supervisor send receipt escalates once without blindly resending after restart',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'uncertain');f.loseSend();
 await f.api().reconcile();f.reopen();await f.api().reconcile();await f.notices().reconcile();await f.notices().reconcile();
 assert.equal(f.calls.filter(c=>c.method==='terminal.send').length,1);assert.equal(f.host.length,1);assert.match(f.host[0].text,/uncertain/i);assert.equal(f.api().route('uncertain').state,'escalated');
});

test('supervisor crash and unresolved completed turn fall back to Codex with original message IDs',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'crashed');await f.api().reconcile();
 f.terminals.get(lead.terminalId).state='finished';await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,1);assert.match(f.host[0].text,/crashed/);
 const second=f.worker('second','lead'),child=f.worker('child','reader',{supervisorId:second.id});f.message(child,'forgotten');await f.api().reconcile();
 await f.api().handle(f.request(second,'receive',{id:'forgotten'}));f.finish(second);await f.api().reconcile();await f.notices().reconcile();
 assert.equal(f.api().route('forgotten').state,'escalated');assert.match(f.api().route('forgotten').reason,/without resolving/);assert.equal(f.host.length,2);
});

test('scoped helper authentication rejects impersonation, wrong terminal and other supervisor messages',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),other=f.worker('other','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'protected');await f.api().reconcile();
 await assert.rejects(()=>f.api().handle({...f.request(lead,'inbox'),token:'0'.repeat(64)}),/authentication/);
 await assert.rejects(()=>f.api().handle({...f.request(lead,'inbox'),terminalId:reader.terminalId}),/different terminal/);
 await assert.rejects(()=>f.api().handle(f.request(other,'receive',{id:'protected'})),/not assigned/);
 assert.equal(f.store.message('protected').action,null);assert.equal(f.store.message('protected').acknowledgedAt,null);
 assert.equal(f.store.worker(lead.id).supervisionCredential.token,undefined);
 assert.equal(f.store.meta('supervision-auth:'+lead.id).token,undefined);
});

test('supervisor reply is persisted before send and retries cannot duplicate child input',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'reply-once');await f.api().reconcile();
 const args={id:'reply-once',requestId:'answer',text:'Use the verified existing policy.'};
 await f.api().handle(f.request(lead,'reply',args));await f.api().handle(f.request(lead,'reply',args));await f.api().handle(f.request(lead,'ack',{id:'reply-once'}));await f.api().handle(f.request(lead,'ack',{id:'reply-once'}));
 assert.equal(f.calls.filter(c=>c.method==='terminal.send'&&c.params.terminal===reader.terminalId).length,1);assert.equal(f.store.message('reply-once').action.state,'sent');assert.ok(f.store.message('reply-once').acknowledgedAt);
});

test('supervisor delegation pins identity, owner chat, Desk, role version and request content',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead');let calls=0,input;
 const api=new Supervision({store:f.store,config:f.config,rpc:f.rpc,delegate:async value=>{calls++;input=value;return {agentId:value.id,accepted:true};}});
 const args={id:'new-reader',requestId:'delegate-1',definitionId:'reader',text:'Inspect the supplied evidence.'};
 const request=f.request(lead,'delegate',args);assert.equal((await api.handle(request)).accepted,true);await api.handle(request);assert.equal(calls,1);
 assert.equal(input.supervisorId,lead.id);assert.equal(input.threadId,THREAD);assert.equal(input.deskId,'desk');assert.equal(input.deskDefinitionVersion,1);assert.equal(input.parentId,undefined,'Reporting does not change process lifetime');
 await assert.rejects(()=>api.handle(f.request(lead,'delegate',{...args,text:'Different work'})),/different content/);
 await assert.rejects(()=>api.handle(f.request(lead,'delegate',{...args,requestId:'unauthorized',definitionId:'director'})),/outside/);
});

test('explicit escalation is idempotent and cannot be altered into a second request',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'escalate');await f.api().reconcile();
 const request=f.request(lead,'escalate',{id:'escalate',requestId:'policy',text:'The task requires a product decision outside my authority.'});
 await f.api().handle(request);assert.equal((await f.api().handle(request)).reused,true);
 await assert.rejects(()=>f.api().handle(f.request(lead,'escalate',{id:'escalate',requestId:'policy',text:'Changed explanation'})),/different recorded/);
 await f.notices().reconcile();await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,1);assert.match(f.host[0].text,/- question escalate — reader \(t2\)/);assert.match(f.host[0].text,/Escalated from supervisor lead/);assert.doesNotMatch(f.host[0].text,/product decision/);
});

test('routine supervised reports do not contact the host queue before escalation',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'local-only');
 const notices=new Notifications({store:f.store,config:f.config,queue:{list:async()=>{throw new Error('Host should remain uninvolved');}}});
 await notices.reconcile();await f.api().reconcile();await notices.reconcile();assert.equal(f.api().route('local-only').state,'delivered');
});

test('lost child reply receipt escalates with its uncertain action and cannot be resent',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'lost-reply');await f.api().reconcile();f.loseSend();
 const request=f.request(lead,'reply',{id:'lost-reply',requestId:'answer',text:'Continue the existing checked behavior.'});
 await assert.rejects(()=>f.api().handle(request),/Lost receipt/);assert.equal(f.store.message('lost-reply').action.state,'uncertain');
 f.reopen();await assert.rejects(()=>f.api().handle(request),/not assigned/);await f.api().reconcile();await f.notices().reconcile();
 assert.equal(f.calls.filter(c=>c.method==='terminal.send'&&c.params.terminal===reader.terminalId).length,1);assert.equal(f.host.length,1);
});

test('verified peer handoff waits for child work and routes its new answer before abandoned-turn checks',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'initial-question');await f.api().reconcile();
 f.finish(lead);f.terminals.get(reader.terminalId).status={state:'working'};
 await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,0);assert.equal(f.api().route('initial-question').state,'delivered');
 f.finish(reader);f.message(reader,'peer-answer',{kind:'result',text:'Actual new evidence from the requested peer investigation.'});
 await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,0);assert.equal(f.api().route('peer-answer').state,'delivered');assert.equal(f.api().route('initial-question').state,'delivered');
 f.finish(lead);await f.api().reconcile();await f.notices().reconcile();assert.equal(f.host.length,1);assert.match(f.host[0].text,/initial-question/);assert.match(f.host[0].text,/peer-answer/);
});

test('nested grants and corrupt multi-agent cycles are rejected',t=>{
 const f=fixture(t),director=f.worker('director','director');
 const stored={...director,supervisionGrant:{...director.supervisionGrant,allowNested:false}};
 f.store.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify(stored),director.id);
 assert.throws(()=>f.worker('disallowed-lead','lead',{supervisorId:director.id}),/Nested/);
 f.store.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify(director),director.id);
 const lead=f.worker('lead','lead',{supervisorId:director.id});
 // Simulate corrupt persisted topology. Runtime validation must fail closed.
 f.store.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify({...director,supervisorId:lead.id}),director.id);
 assert.throws(()=>f.api().validateBinding(lead),/cycle/);
});

test('working supervisor does not suppress its child forgotten-report attention',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id,taskId:lead.taskId});
 const bridge=new Bridge(f.config,{queue:{list:async()=>[],add:async()=>{throw new Error('Child must not wake host');}}});
 bridge.rpc=f.rpc;bridge.connected=true;bridge.supervision.rpc=f.rpc;
 bridge.store.meta('observation:'+lead.id,{working:true,state:'working',episode:1});f.terminals.get(lead.terminalId).status={state:'working'};
 const pending={episode:1,startTurn:0,turn:1,endedAt:new Date().toISOString()};f.terminals.get(reader.terminalId).status={state:'done'};f.terminals.get(reader.terminalId).turn=1;
 bridge.store.meta('observation:'+reader.id,{working:false,state:'done',episode:1,turn:1,pending});
 // This test exercises grouping and routing directly without starting sockets.
 bridge.syncWorker=async()=>{};bridge.checkWorker=async()=>{};
 await bridge.settledNotice(lead.taskId,lead.id);
 assert.equal(f.store.messages({pending:true}).length,1);assert.equal(f.store.messages({pending:true})[0].workerId,reader.id);
 assert.equal(f.calls.filter(c=>c.method==='terminal.send').at(-1).params.terminal,lead.terminalId);
 await bridge.stop();bridge.store.close();
});

test('existing bridge IPC authenticates supervisor operations without manager DB access in the request',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'ipc-question');await f.api().reconcile();
 const bus=await startActivityBus({dbPath:join(f.stateDir,'manager.sqlite'),onSupervisorRequest:request=>f.api().handle(request)});
 try{
  const result=await requestSupervision({socketPath:lead.supervisionCredential.socketPath,request:f.request(lead,'inbox')});assert.equal(result.messages[0].id,'ipc-question');
  await assert.rejects(()=>requestSupervision({socketPath:lead.supervisionCredential.socketPath,request:{...f.request(lead,'inbox'),token:'0'.repeat(64)}}),/authentication/);
 }finally{await bus.close();}
});

test('supervisor CLI uses its private binding through real IPC and rejects a child reusing the parent config',async t=>{
 const f=fixture(t),lead=f.worker('lead','lead'),reader=f.worker('reader','reader',{supervisorId:lead.id});f.message(reader,'helper-inbox');await f.api().reconcile();
 const configFile=join(lead.stateDir,'worker.json');writeFileSync(configFile,JSON.stringify(lead));
 const bus=await startActivityBus({dbPath:join(f.stateDir,'manager.sqlite'),onSupervisorRequest:request=>f.api().handle(request)});
 const executable=fileURLToPath(new URL('../src/supervisor-cli.mjs',import.meta.url));
 try{
  const env={...process.env,HERDR_CODEX_WORKER_CONFIG:configFile,HC_TERMINAL_ID:lead.terminalId};
  const result=await promisify(execFile)(process.execPath,[executable,'inbox'],{env,encoding:'utf8'});assert.equal(JSON.parse(result.stdout).messages[0].id,'helper-inbox');
  await assert.rejects(()=>promisify(execFile)(process.execPath,[executable,'inbox'],{env:{...env,HC_TERMINAL_ID:reader.terminalId},encoding:'utf8'}),error=>error.code===1&&/different terminal/.test(error.stderr));
 }finally{await bus.close();}
});
