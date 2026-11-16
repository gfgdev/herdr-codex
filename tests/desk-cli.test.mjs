import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {deskCommand,openDeskSpace} from '../src/desk-cli.mjs';
import {resolveDeskDelegation} from '../src/desk-delegation.mjs';

const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b',OTHER='01a1d317-b5d9-7530-8623-f60c0df12d38';
function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-cli-'))),stateDir=join(directory,'state');mkdirSync(stateDir);
  const config={stateDir,herdrReadPaths:[]},store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});
  const desk=desks.create({id:'bpm',name:'BPM',purpose:'Test client operations'}),calls={launches:0,attempts:0,native:0};
  desks.definitionPut({deskId:'bpm',id:'analyst',name:'Analyst',harness:'goose',scope:'read-only',instructions:'Inspect evidence.'});
  desks.workflowPut({deskId:'bpm',id:'intake',name:'Intake',definitionId:'analyst',instructions:'Read source documents and report.'});
  desks.workCreate({deskId:'bpm',id:'work',title:'Intake work',brief:'Read source documents.',ownerThread:THREAD});
  const rpc={request:async()=>{calls.native++;throw new Error('Unexpected native operation in isolated command test');}};
  const delegationFactory=()=>({
    async delegate(input){
      calls.attempts++;
      const resolved=resolveDeskDelegation({store,config,input});
      const id=resolved.id,existing=store.worker(id),taskId=existing?.taskId??'task-'+id;
      if(!existing){
        calls.launches++;
        const fields=Object.fromEntries(['deskId','deskProjectId','deskWorkId','deskJobId'].map(k=>[k,resolved[k]??null]));
        store.saveTask({id:taskId,name:id,project:resolved.project,threadId:resolved.threadId,status:'active',...fields});
        store.saveWorker({id,taskId,name:id,project:resolved.project,role:resolved.harness,terminalId:'fixture-'+id,mailbox:'mail-'+id,...fields,deskDefinitionId:resolved.deskDefinitionId,deskDefinitionVersion:resolved.deskDefinitionVersion});
      }
      return {agentId:id,taskId,request:{state:'sent'}};
    },
    list({deskId,threadId}){return store.workers().filter(w=>w.deskId===deskId&&(!threadId||store.task(w.taskId).threadId===threadId));},
  });
  const command=(action,values={})=>deskCommand({action,values:{id:'bpm',...values},store,config,rpc,pulse:async()=>{},appCall:async()=>{throw new Error('Unexpected desktop operation');},delegationFactory});
  const payload=value=>{const file=join(directory,'payload-'+Math.random().toString(16).slice(2)+'.json');writeFileSync(file,JSON.stringify(value));return file;};
  const run=(extra={})=>command('run',{job:'run-1',workflow:'intake',thread:THREAD,work:'work',...extra});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,stateDir,config,store,desks,desk,calls,rpc,delegationFactory,command,payload,run};
}

test('manual run creates one durable job and one agent; duplicate invocation reuses both',async t=>{
  const f=fixture(t),first=await f.run(),again=await f.run();
  assert.equal(first.job.status,'running');assert.equal(again.agent.agentId,first.agent.agentId);
  assert.equal(f.calls.launches,1);assert.equal(f.desks.jobs('bpm').length,1);assert.equal(f.calls.native,0);
  assert.equal(f.desks.work('bpm','work').agentId,first.agent.agentId);
  await assert.rejects(f.run({thread:OTHER}),/different registration|does not match/);
  assert.equal(f.calls.launches,1);
});
for(const status of ['review','blocked'])test(`replaying a ${status} job preserves job and work states without a new launch`,async t=>{
  const f=fixture(t);await f.run();f.desks.jobUpdate('bpm','run-1',{status,note:'An explicit manager state.'});f.desks.workUpdate('bpm','work',{status,note:'An explicit manager state.'});
  const replay=await f.run();assert.equal(replay.job.status,status);assert.equal(f.desks.work('bpm','work').status,status);assert.equal(f.calls.launches,1);
});
test('settled job replay does not enter delegation or native RPC',async t=>{
  const f=fixture(t);await f.run();f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Verified actual output.'});f.desks.workUpdate('bpm','work',{status:'done',note:'Verified actual output.'});
  const before=f.calls.attempts,result=await f.run();assert.equal(result.actionable,false);assert.equal(result.job.status,'completed');assert.equal(f.calls.attempts,before);assert.equal(f.calls.native,0);
});
test('unavailable external resource fails before a worker or native process is created',async t=>{
  const f=fixture(t);f.desks.resourceAdd({deskId:'bpm',id:'mail',name:'Intake mailbox',kind:'mailbox',ref:'mailbox-id',access:['read']});
  f.desks.definitionPut({deskId:'bpm',id:'mail-analyst',name:'Mail analyst',harness:'goose',scope:'read-only',instructions:'Inspect mail.',resourceIds:['mail']});
  f.desks.workflowPut({deskId:'bpm',id:'mail-intake',name:'Mail intake',definitionId:'mail-analyst',instructions:'Read new orders.'});
  await assert.rejects(f.run({workflow:'mail-intake'}),/no executable connector/);
  assert.equal(f.calls.launches,0);assert.equal(f.store.workers().length,0);assert.equal(f.calls.native,0);
  assert.equal(f.desks.job('bpm','run-1').status,'pending');
  assert.ok(f.desks.events('bpm').some(e=>e.type==='desk.job.dispatch-error'));
});
test('JSON payload cannot redirect a selected desk or disguise a different desk create ID',async t=>{
  const f=fixture(t);f.desks.create({id:'other',name:'Other',purpose:'Unrelated desk'});
  await assert.rejects(f.command('resource-add',{file:f.payload({deskId:'other',id:'bad',name:'Bad',kind:'service',ref:'service-id'})}),/Payload desk differs/);
  await assert.rejects(f.command('create',{id:'new',file:f.payload({id:'different',name:'Different',purpose:'Wrong identity'})}),/Payload ID differs/);
  assert.equal(f.desks.resources('other').length,0);assert.equal(f.desks.get('new'),null);assert.equal(f.desks.get('different'),null);
});
test('manual command rejects malformed or oversized JSON without mutation',async t=>{
  const f=fixture(t),file=join(f.directory,'bad.json');writeFileSync(file,'{invalid');
  await assert.rejects(f.command('resource-add',{file}),/JSON|property/);
  writeFileSync(file,' '.repeat(262145));await assert.rejects(f.command('resource-add',{file}),/too large/);
  assert.deepEqual(f.desks.resources('bpm'),[]);
});
test('work and job cannot complete until exact bound-task messages are resolved and acknowledged',async t=>{
  const f=fixture(t),run=await f.run(),worker=f.store.worker(run.agent.agentId);
  f.store.ingest(worker,{id:'report',taskId:worker.taskId,workerId:worker.id,terminalId:worker.terminalId,kind:'result',text:'Proposed result awaiting verification.',createdAt:new Date().toISOString()});
  assert.throws(()=>f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Claimed complete.'}),/acknowledge/);
  assert.throws(()=>f.desks.workUpdate('bpm','work',{status:'done',note:'Claimed done.'}),/acknowledge/);
  f.store.receive('report');assert.throws(()=>f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Received only.'}),/acknowledge/);
  f.store.recordAction('report',{kind:'accept',requestId:'verified-report',text:'Inspected actual evidence; accepted.'});f.store.ack('report');
  f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Accepted verified report.'});f.desks.workUpdate('bpm','work',{status:'done',note:'Accepted verified report.'});
  assert.equal(f.desks.job('bpm','run-1').status,'completed');assert.equal(f.desks.work('bpm','work').status,'done');
});
test('unrelated task attention does not block settlement of this exact job',async t=>{
  const f=fixture(t);await f.run();const project=f.desks.get('bpm').home;
  f.store.saveTask({id:'unrelated-task',name:'Other work',project,threadId:THREAD,status:'active'});
  const w={id:'other-worker',taskId:'unrelated-task',project,terminalId:'t-other',mailbox:'other-mail'};f.store.saveWorker(w);
  f.store.ingest(w,{id:'unrelated-message',taskId:w.taskId,workerId:w.id,terminalId:w.terminalId,kind:'question',text:'Other task question.',createdAt:new Date().toISOString()});
  f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Verified this task.'});f.desks.workUpdate('bpm','work',{status:'done',note:'Verified this task.'});
  assert.equal(f.store.message('unrelated-message').acknowledgedAt,null);
});

function appFixture(desk,extraSpaces=[]){
  let spaces=structuredClone(extraSpaces),calls=[];
  return {calls,get spaces(){return spaces;},async call(method,params){
    calls.push({method,params:structuredClone(params)});
    if(method==='ls')return {spaces:structuredClone(spaces)};
    if(method==='space.new'){spaces.push({id:'new-desk-space',name:params.name,folder:params.folder,machine:null,active:false,tabs:[]});return {id:'new-desk-space'};}
    if(method==='space.select'){spaces=spaces.map(s=>({...s,active:s.id===params.id}));return {};}
    throw new Error('Unexpected desktop mutation '+method);
  }};
}
test('opening a desk creates an explicit matching space without adopting or moving agent terminals',async t=>{
  const f=fixture(t),game={id:'game',name:'Game',folder:f.directory,machine:null,active:true,tabs:[{id:'game-tab',terminals:[{terminal:'t13'}]}]},app=appFixture(f.desk,[game]);
  const result=await openDeskSpace({desk:f.desk,appCall:app.call.bind(app)});
  assert.equal(result.verified,true);assert.equal(result.spaceId,'new-desk-space');assert.equal(app.spaces.find(s=>s.id==='game').tabs[0].terminals[0].terminal,'t13');
  assert.deepEqual(app.calls.filter(c=>c.method!=='ls').map(c=>c.method),['space.new','space.select']);
  assert.equal(app.spaces.find(s=>s.id==='new-desk-space').folder,f.desk.home);
});
test('opening a desk reuses its matching local space and ignores same-path remote spaces',async t=>{
  const f=fixture(t),app=appFixture(f.desk,[{id:'remote',folder:f.desk.home,machine:'another-host',active:true,tabs:[]},{id:'local',folder:f.desk.home,machine:null,active:false,tabs:[]}]);
  const first=await openDeskSpace({desk:f.desk,appCall:app.call.bind(app)});const second=await openDeskSpace({desk:f.desk,appCall:app.call.bind(app)});
  assert.equal(first.spaceId,'local');assert.equal(second.spaceId,'local');assert.equal(app.calls.some(c=>c.method==='space.new'),false);
});
test('opening a desk rejects ambiguous or explicit foreign spaces without desktop mutations',async t=>{
  const f=fixture(t),a=appFixture(f.desk,[{id:'one',folder:f.desk.home,machine:null,active:true},{id:'two',folder:f.desk.home,machine:null,active:false}]);
  await assert.rejects(openDeskSpace({desk:f.desk,appCall:a.call.bind(a)}),/Several native spaces/);assert.ok(a.calls.every(c=>c.method==='ls'));
  const b=appFixture(f.desk,[{id:'game',folder:f.directory,machine:null,active:true}]);
  await assert.rejects(openDeskSpace({desk:f.desk,spaceId:'game',appCall:b.call.bind(b)}),/does not match/);assert.ok(b.calls.every(c=>c.method==='ls'));
});
test('desktop selection race is reported rather than falsely confirming a desk view',async t=>{
  const f=fixture(t),app=appFixture(f.desk,[{id:'local',folder:f.desk.home,machine:null,active:false},{id:'game',folder:f.directory,machine:null,active:true}]);
  const call=async(method,params)=>{if(method==='space.select'){app.calls.push({method,params});return {};}return app.call(method,params);};
  await assert.rejects(openDeskSpace({desk:f.desk,appCall:call}),/selection changed/);assert.equal(app.spaces.find(s=>s.id==='game').active,true);
});

test('resource-update CLI selects the existing resource without allowing identity changes',async t=>{
  const f=fixture(t);f.desks.resourceAdd({deskId:'bpm',id:'notes',name:'Notes',kind:'directory',path:f.directory,access:['read']});
  const updated=await f.command('resource-update',{file:f.payload({id:'notes',access:['read','write']})});
  assert.deepEqual(updated.access,['read','write']);assert.equal(updated.path,f.directory);
  await assert.rejects(f.command('resource-update',{file:f.payload({id:'notes',path:f.stateDir})}),/Unknown resource update field/);
  await assert.rejects(f.command('resource-update',{file:f.payload({deskId:'other',id:'notes',access:['read']})}),/Payload desk differs/);
  assert.deepEqual(f.desks.resource('bpm','notes'),updated);assert.equal(f.calls.native,0);
});
