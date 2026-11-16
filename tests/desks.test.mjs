import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,symlinkSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Desks } from '../src/desks.mjs';

const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b',OTHER='01a1d317-b5d9-7530-8623-f60c0df12d38';
function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desks-'))),stateDir=join(directory,'state'),vault=join(directory,'vault'),project=join(directory,'project');
  for(const p of [stateDir,vault,project])mkdirSync(p);
  writeFileSync(join(vault,'existing.md'),'Existing human knowledge.\n');
  const dbPath=join(stateDir,'manager.sqlite');let store=new Store(dbPath),desks=new Desks({store,config:{stateDir}});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const create=(id='bpm',extra={})=>desks.create({id,name:id.toUpperCase(),purpose:'Client work',...extra});
  return {directory,stateDir,vault,project,dbPath,create,get store(){return store;},get desks(){return desks;},reopen(){store.close();store=new Store(dbPath);desks=new Desks({store,config:{stateDir}});}};
}
function definition(f,extra={}){return f.desks.definitionPut({deskId:'bpm',id:'analyst',name:'Analyst',harness:'goose',scope:'read-only',instructions:'Read the authorized source and return evidence.',...extra});}
function workflow(f,extra={}){return f.desks.workflowPut({deskId:'bpm',id:'intake',name:'Manual intake',definitionId:'analyst',instructions:'Inspect supplied source documents.',...extra});}

test('desk home is durable independent of a referenced vault and creates landing page once',t=>{
  const f=fixture(t),desk=f.create('bpm',{vaultPath:f.vault});
  assert.equal(desk.home,join(f.stateDir,'desks/bpm/home'));
  assert.equal(statSync(desk.home).mode&0o777,0o700);
  assert.equal(f.desks.project('bpm','home').path,desk.home);
  assert.deepEqual(f.desks.resource('bpm','vault').access,['read','write']);
  assert.equal(readFileSync(join(f.vault,'existing.md'),'utf8'),'Existing human knowledge.\n');
  writeFileSync(join(desk.home,'DESK.md'),'User additions must survive.\n');
  f.reopen();assert.equal(f.desks.get('bpm').home,desk.home);
  f.create('bpm',{vaultPath:f.vault});f.desks.update('bpm',{purpose:'Updated purpose'});
  assert.equal(readFileSync(join(desk.home,'DESK.md'),'utf8'),'User additions must survive.\n');
});
test('desk identities reject path traversal, incompatible recreation and unknown fields',t=>{
  const f=fixture(t);f.create();
  assert.throws(()=>f.create('../other'),/Invalid desk ID/);
  assert.throws(()=>f.create('bpm',{purpose:'Changed implicitly'}),/different registration/);
  assert.throws(()=>f.create('other',{model:'another-model'}),/Unknown desk field/);
  assert.throws(()=>f.desks.update('bpm',{home:f.project}),/Unknown desk update field/);
});
test('desk state cannot be created through a symlink or inside the linked vault',t=>{
  const f=fixture(t);symlinkSync(f.project,join(f.stateDir,'desks'));
  assert.throws(()=>f.create(),/symbolic links/);
  assert.equal(f.desks.get('bpm'),null);
  rmSync(join(f.stateDir,'desks'));
  assert.throws(()=>f.create('bpm',{vaultPath:f.directory}),/outside the linked vault/);
});
test('later vault registration is explicit, read/write and cannot reroute its identity',t=>{
  const f=fixture(t);f.create();f.desks.update('bpm',{vaultPath:f.vault});
  assert.equal(f.desks.resource('bpm','vault').path,f.vault);assert.deepEqual(f.desks.resource('bpm','vault').access,['read','write']);
  assert.throws(()=>f.desks.update('bpm',{vaultPath:f.project}),/vault identity/);
});
test('project references remain canonical and immutable without modifying the checkout',t=>{
  const f=fixture(t);f.create();
  const p={deskId:'bpm',id:'website',name:'Website',path:f.project};
  const first=f.desks.projectAdd(p);assert.deepEqual(f.desks.projectAdd(p),first);
  assert.throws(()=>f.desks.projectAdd({...p,path:f.vault}),/different registration/);
  assert.throws(()=>f.desks.projectAdd({...p,id:'relative',path:'.'}),/absolute path/);
  assert.throws(()=>f.desks.projectAdd({...p,id:'file',path:join(f.vault,'existing.md')}),/directory/);
});
test('external resources are explicit metadata only and reject embedded URL credentials',t=>{
  const f=fixture(t);f.create();
  const r=f.desks.resourceAdd({deskId:'bpm',id:'orders',name:'Order register',kind:'spreadsheet',ref:'spreadsheet-id',access:['read','write']});
  assert.equal(r.connected,false);assert.equal(r.path,undefined);
  for(const ref of ['https://user:secret@example.test/sheet','https://example.test/sheet?token=secret','file:///tmp/file'])assert.throws(()=>f.desks.resourceAdd({deskId:'bpm',id:'bad',name:'Bad',kind:'url',ref}),/URLs/);
  assert.throws(()=>f.desks.resourceAdd({deskId:'bpm',id:'bad',name:'Bad',kind:'directory',path:f.project,ref:'foreign'}),/Use path/);
  assert.throws(()=>f.desks.resourceAdd({deskId:'bpm',id:'bad',name:'Bad',kind:'directory',path:f.project,access:['admin']}),/access/);
});
test('definitions are immutable versions, idempotent on same content and scoped to one desk',t=>{
  const f=fixture(t);f.create();f.create('other');
  f.desks.resourceAdd({deskId:'bpm',id:'notes',name:'Notes',kind:'vault',path:f.vault});
  const first=definition(f,{resourceIds:['notes'],context:'Client context',acceptance:['Cite source evidence.']});
  assert.equal(first.version,1);assert.deepEqual(definition(f,{resourceIds:['notes'],context:'Client context',acceptance:['Cite source evidence.']}),first);
  const second=definition(f,{resourceIds:['notes'],instructions:'Changed instructions with review.'});assert.equal(second.version,2);
  assert.equal(f.desks.definition('bpm','analyst',1).instructions,first.instructions);
  assert.equal(f.desks.definition('other','analyst'),null);
  assert.throws(()=>f.desks.definitionPut({...first,deskId:'other'}),/Unknown definition field/);
  assert.throws(()=>definition(f,{resourceIds:['missing']}),/Unknown resource/);
  assert.throws(()=>definition(f,{harness:'arbitrary-shell'}),/harness/);
});
test('read-only specialist never gains write paths from writable resources',t=>{
  const f=fixture(t);f.create();
  f.desks.resourceAdd({deskId:'bpm',id:'notes',name:'Notes',kind:'vault',path:f.vault,access:['read','write']});definition(f,{resourceIds:['notes']});
  const result=f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'});
  assert.ok(result.readPaths.includes(f.vault));assert.deepEqual(result.writePaths,[]);
});
test('assignment scope cannot add undeclared resources or use another desk project',t=>{
  const f=fixture(t);f.create();f.create('other');
  for(const id of ['notes','extra'])f.desks.resourceAdd({deskId:'bpm',id,name:id,kind:'directory',path:id==='notes'?f.vault:f.project,access:['read','write']});
  f.desks.projectAdd({deskId:'other',id:'foreign',name:'Foreign',path:f.project});
  definition(f,{scope:'write',resourceIds:['notes']});
  assert.throws(()=>f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst',resourceIds:['extra']}),/outside its definition/);
  assert.throws(()=>f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst',projectId:'foreign'}),/Unknown desk project/);
  const noResources=f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst',resourceIds:[]});
  assert.deepEqual(noResources.writePaths,[f.desks.get('bpm').home]);assert.equal(noResources.resources.length,0);
});
test('unconnected resource declarations do not turn into file grants or hidden connectors',t=>{
  const f=fixture(t);f.create();f.desks.resourceAdd({deskId:'bpm',id:'mail',name:'Intake mail',kind:'mailbox',ref:'BPM inbox',access:['read']});
  definition(f,{resourceIds:['mail']});const a=f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'});
  assert.deepEqual(a.unavailableResources.map(r=>r.id),['mail']);assert.deepEqual(a.readPaths,[f.desks.get('bpm').home]);assert.deepEqual(a.writePaths,[]);
});
test('replaced resource directory is detected before resolving worker access',t=>{
  const f=fixture(t);f.create();f.desks.resourceAdd({deskId:'bpm',id:'notes',name:'Notes',kind:'directory',path:f.project});definition(f,{resourceIds:['notes']});
  rmSync(f.project,{recursive:true});symlinkSync(f.vault,f.project);
  assert.throws(()=>f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'}),/identity changed/);
});
test('workflows pin definition versions and cannot enable schedules or broader resources',t=>{
  const f=fixture(t);f.create();definition(f);const first=workflow(f);definition(f,{instructions:'New definition instructions.'});
  assert.equal(first.definitionVersion,1);assert.equal(f.desks.workflow('bpm','intake').definitionVersion,1);
  assert.throws(()=>workflow(f,{trigger:'daily'}),/Only manual/);
  assert.throws(()=>workflow(f,{resourceIds:['foreign']}),/outside its definition/);
  const second=workflow(f);assert.equal(second.version,2);assert.equal(second.definitionVersion,2);
});
test('work register has explicit immutable chat ownership and evidence-based settlement',t=>{
  const f=fixture(t);f.create();
  const input={deskId:'bpm',id:'investigate',title:'Investigate',brief:'Inspect a source.'};f.desks.workCreate(input);
  assert.throws(()=>f.desks.workUpdate('bpm','investigate',{status:'done'}),/requires explicit evidence/);
  f.desks.workUpdate('bpm','investigate',{ownerThread:THREAD,status:'assigned',note:'Assigned for investigation.'});
  assert.equal(f.desks.workCreate(input).ownerThread,THREAD);
  assert.throws(()=>f.desks.workUpdate('bpm','investigate',{ownerThread:OTHER}),/cannot silently change/);
  f.desks.workUpdate('bpm','investigate',{status:'done',note:'Verified the source and recorded the answer.'});
  f.reopen();assert.equal(f.desks.work('bpm','investigate').status,'done');
  assert.throws(()=>f.desks.workUpdate('bpm','investigate',{status:'running',note:'Restart'}),/implicitly reopened/);
});
test('jobs freeze workflow and definition and preserve idempotency after progress and definition changes',t=>{
  const f=fixture(t);f.create();definition(f);workflow(f);
  const input={deskId:'bpm',id:'run-1',workflowId:'intake',ownerThread:THREAD};const original=f.desks.jobCreate(input);
  f.desks.jobUpdate('bpm','run-1',{status:'running',note:'Started approved manual run.'});
  definition(f,{instructions:'Changed for later runs.'});workflow(f);
  const replay=f.desks.jobCreate(input);assert.equal(replay.status,'running');assert.equal(replay.workflowVersion,1);assert.deepEqual(replay.snapshot,original.snapshot);
  assert.throws(()=>f.desks.jobCreate({...input,ownerThread:OTHER}),/different registration/);
  assert.throws(()=>f.desks.jobCreate({...input,workflowVersion:2}),/different registration/);
});
test('job lifecycle requires actual start and an explicit settlement note',t=>{
  const f=fixture(t);f.create();definition(f);workflow(f);f.desks.jobCreate({deskId:'bpm',id:'run-1',workflowId:'intake',ownerThread:THREAD});
  assert.throws(()=>f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Pretend complete'}),/Invalid job transition/);
  f.desks.jobUpdate('bpm','run-1',{status:'running'});assert.throws(()=>f.desks.jobUpdate('bpm','run-1',{status:'completed'}),/explicit evidence/);
  f.desks.jobUpdate('bpm','run-1',{status:'review',note:'Agent report awaits verification.'});f.desks.jobUpdate('bpm','run-1',{status:'completed',note:'Verified actual output and checks.'});
  assert.throws(()=>f.desks.jobUpdate('bpm','run-1',{status:'running'}),/implicitly restarted/);
});
test('work and job bindings verify the registered desk, project, chat and agent identity',t=>{
  const f=fixture(t);f.create();definition(f);workflow(f);f.desks.workCreate({deskId:'bpm',id:'work',title:'Work',brief:'Do work',ownerThread:THREAD});f.desks.jobCreate({deskId:'bpm',id:'job',workflowId:'intake',ownerThread:THREAD,workId:'work'});
  const task={id:'task',name:'Actual task',project:f.desks.get('bpm').home,threadId:THREAD,status:'active',deskId:'bpm',deskProjectId:'home',deskWorkId:'work',deskJobId:'job'};f.store.saveTask(task);
  const agent={id:'agent',taskId:task.id,project:task.project,deskId:'bpm',deskProjectId:'home',deskWorkId:'work',deskJobId:'job',terminalId:'t1',mailbox:'m1'};f.store.saveWorker(agent);
  f.desks.workUpdate('bpm','work',{status:'assigned',taskId:'task',agentId:'agent'});f.desks.jobUpdate('bpm','job',{status:'running',taskId:'task',agentId:'agent'});
  f.store.saveTask({...task,id:'foreign',threadId:OTHER});
  assert.throws(()=>f.desks.jobUpdate('bpm','job',{taskId:'foreign'}),/does not match/);
  assert.throws(()=>f.desks.update('bpm',{status:'archived'}),/Resolve active desk tasks/);
});
test('archived desks retain history but reject fresh assignments and registrations',t=>{
  const f=fixture(t);f.create();definition(f);f.desks.update('bpm',{status:'archived'});
  assert.equal(f.desks.show('bpm').definitions.length,1);
  assert.throws(()=>f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'}),/archived/);
  assert.throws(()=>f.desks.projectAdd({deskId:'bpm',id:'new',name:'New',path:f.project}),/archived/);
  f.desks.update('bpm',{status:'active'});assert.equal(f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'}).desk.status,'active');
});
test('desk activity is scoped, paginated and remains separate from old task records',t=>{
  const f=fixture(t);f.store.saveTask({id:'legacy',name:'Legacy',project:f.project,threadId:THREAD,status:'closed'});const before=f.store.tasks();
  f.create();f.create('other');definition(f);const events=f.desks.events('bpm',{limit:2});
  assert.equal(events.length,2);assert.ok(events.every(e=>e.data.deskId==='bpm'));
  const later=f.desks.events('bpm',{after:events.at(-1).seq});assert.ok(later.every(e=>e.seq>events.at(-1).seq));
  assert.deepEqual(f.store.tasks(),before);assert.deepEqual(f.desks.show('bpm').tasks,[]);
});
test('same desk/project/chat cannot substitute a different work item or job binding',t=>{
  const f=fixture(t);f.create();definition(f);workflow(f);
  f.desks.workCreate({deskId:'bpm',id:'work',title:'Work',brief:'Do work',ownerThread:THREAD});
  f.desks.jobCreate({deskId:'bpm',id:'job',workflowId:'intake',ownerThread:THREAD,workId:'work'});
  const task={id:'wrong-task',name:'Different assignment',project:f.desks.get('bpm').home,threadId:THREAD,status:'active',deskId:'bpm',deskProjectId:'home',deskWorkId:'different-work',deskJobId:'different-job'};f.store.saveTask(task);
  assert.throws(()=>f.desks.workUpdate('bpm','work',{taskId:task.id}),/does not match/);
  assert.throws(()=>f.desks.jobUpdate('bpm','job',{taskId:task.id}),/does not match/);
});
test('job creation claims unowned work to its chat and rejects a second chat',t=>{
  const f=fixture(t);f.create();definition(f);workflow(f);f.desks.workCreate({deskId:'bpm',id:'work',title:'Work',brief:'Do work'});
  f.desks.jobCreate({deskId:'bpm',id:'job',workflowId:'intake',ownerThread:THREAD,workId:'work'});
  assert.equal(f.desks.work('bpm','work').ownerThread,THREAD);
  assert.throws(()=>f.desks.jobCreate({deskId:'bpm',id:'job-2',workflowId:'intake',ownerThread:OTHER,workId:'work'}),/does not match/);
  assert.equal(f.desks.job('bpm','job-2'),null);
});
test('desk activity includes legacy-shaped agent and message journal entries by verified task ownership',t=>{
  const f=fixture(t);f.create();f.create('other');
  const a={id:'ta',name:'A',project:f.desks.get('bpm').home,threadId:THREAD,status:'active',deskId:'bpm',deskProjectId:'home'};
  const b={id:'tb',name:'B',project:f.desks.get('other').home,threadId:OTHER,status:'active',deskId:'other',deskProjectId:'home'};
  for(const task of [a,b]){
    f.store.saveTask(task);const worker={id:'w'+task.id,taskId:task.id,project:task.project,deskId:task.deskId,deskProjectId:task.deskProjectId,terminalId:'t'+task.id,mailbox:'m'+task.id};f.store.saveWorker(worker);
    f.store.ingest(worker,{id:'msg'+task.id,taskId:task.id,workerId:worker.id,terminalId:worker.terminalId,kind:'result',text:'Actual report',createdAt:new Date().toISOString()});
    f.store.journal('agent.request.sent',{workerId:worker.id});f.store.journal('message.delivery',{id:'msg'+task.id});
  }
  const events=f.desks.events('bpm');
  assert.ok(events.some(e=>e.type==='agent.request.sent'&&e.data.workerId==='wta'));
  assert.ok(events.some(e=>e.type==='message.delivery'&&e.data.id==='msgta'));
  assert.ok(events.every(e=>!JSON.stringify(e.data).includes('msgtb')&&e.data.workerId!=='wtb'));
});

test('vault access updates are explicit, durable, idempotent and journal old and new grants',t=>{
  const f=fixture(t);f.create('bpm',{vaultPath:f.vault});
  const original=f.desks.resource('bpm','vault');
  const readOnly=f.desks.resourceUpdate('bpm','vault',{access:['read']});
  assert.equal(readOnly.path,original.path);assert.deepEqual(readOnly.access,['read']);
  const count=()=>f.desks.events('bpm').filter(e=>e.type==='desk.resource.updated').length;
  assert.equal(count(),1);assert.deepEqual(f.desks.resourceUpdate('bpm','vault',{access:['read']}),readOnly);assert.equal(count(),1);
  f.desks.resourceUpdate('bpm','vault',{access:['write','read']});f.reopen();
  assert.deepEqual(f.desks.resource('bpm','vault').access,['read','write']);
  const updates=f.desks.events('bpm').filter(e=>e.type==='desk.resource.updated');
  assert.deepEqual(updates.map(e=>[e.data.beforeAccess,e.data.access]),[[['read','write'],['read']],[['read'],['read','write']]]);
  assert.equal(readFileSync(join(f.vault,'existing.md'),'utf8'),'Existing human knowledge.\n');
});
test('resource updates cannot alter identity or accept invalid grants and do not partially mutate',t=>{
  const f=fixture(t);f.create('bpm',{vaultPath:f.vault});const before=f.desks.resource('bpm','vault'),events=f.desks.events('bpm');
  for(const patch of [{path:f.project},{kind:'directory'},{ref:'other'},{connected:false},{access:[]},{access:['admin']},{access:['read','read']},{access:['read'],path:f.project}])assert.throws(()=>f.desks.resourceUpdate('bpm','vault',patch));
  assert.throws(()=>f.desks.resourceUpdate('bpm','missing',{access:['write']}),/Unknown desk resource/);
  assert.deepEqual(f.desks.resource('bpm','vault'),before);assert.deepEqual(f.desks.events('bpm'),events);
});
test('active resource users block access changes without altering frozen worker grants',t=>{
  const f=fixture(t);f.create('bpm',{vaultPath:f.vault});
  definition(f,{scope:'write',resourceIds:['vault']});const grant=f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'});
  const task={id:'live-task',name:'Live task',project:grant.project.path,threadId:THREAD,status:'active',deskId:'bpm',deskProjectId:'home'};f.store.saveTask(task);
  const worker={id:'live-worker',taskId:task.id,project:task.project,deskId:'bpm',deskProjectId:'home',deskDefinitionId:'analyst',deskDefinitionVersion:1,terminalId:'t1',mailbox:'m1',readPaths:grant.readPaths,writePaths:grant.writePaths};f.store.saveWorker(worker);
  const saved=f.store.worker(worker.id),before=f.desks.resource('bpm','vault');
  assert.throws(()=>f.desks.resourceUpdate('bpm','vault',{access:['read']}),/Resolve active desk agents/);
  assert.deepEqual(f.desks.resource('bpm','vault'),before);assert.deepEqual(f.store.worker(worker.id),saved);
  // An unchanged access request is a harmless retry, even while the worker runs.
  assert.deepEqual(f.desks.resourceUpdate('bpm','vault',{access:['read','write']}),before);
  f.store.saveTask({...task,status:'closed'});f.desks.resourceUpdate('bpm','vault',{access:['read']});
  assert.deepEqual(f.store.worker(worker.id),saved,'Historical worker scope is never rewritten');
});
test('resource access changes allow unrelated active assignments and preserve role-specific write grants',t=>{
  const f=fixture(t);f.create('bpm',{vaultPath:f.vault});
  definition(f,{resourceIds:['vault']});f.desks.definitionPut({deskId:'bpm',id:'operator',name:'Operator',harness:'pi',scope:'write',instructions:'Save useful findings.',resourceIds:['vault']});
  const read=f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'}),write=f.desks.resolveAssignment({deskId:'bpm',definitionId:'operator'});
  assert.deepEqual(read.writePaths,[]);assert.ok(read.readPaths.includes(f.vault));assert.ok(write.writePaths.includes(f.vault));
  const project=f.desks.get('bpm').home;f.store.saveTask({id:'unrelated',name:'Unrelated',project,threadId:THREAD,status:'active',deskId:'bpm',deskProjectId:'home'});
  f.store.saveWorker({id:'unrelated-worker',taskId:'unrelated',project,deskId:'bpm',deskProjectId:'home',terminalId:'t2',mailbox:'m2',readPaths:[project],writePaths:[project]});
  f.desks.resourceUpdate('bpm','vault',{access:['read']});
  assert.deepEqual(f.desks.resolveAssignment({deskId:'bpm',definitionId:'operator'}).writePaths,[project]);
  assert.deepEqual(f.desks.resolveAssignment({deskId:'bpm',definitionId:'analyst'}).writePaths,[]);
});

test('unsettled jobs retain their resource authority until explicitly settled, even before an agent starts',t=>{
  const f=fixture(t);f.create('bpm',{vaultPath:f.vault});definition(f,{scope:'write',resourceIds:['vault']});workflow(f);
  const job=f.desks.jobCreate({deskId:'bpm',id:'planned-run',workflowId:'intake',ownerThread:THREAD});
  assert.equal(job.status,'pending');assert.equal(f.store.workers().length,0);
  assert.throws(()=>f.desks.resourceUpdate('bpm','vault',{access:['read']}),/Resolve unsettled desk jobs/);
  assert.deepEqual(f.desks.resource('bpm','vault').access,['read','write']);
  f.desks.jobUpdate('bpm','planned-run',{status:'cancelled',note:'Recreate with the new intended resource authority.'});
  f.desks.resourceUpdate('bpm','vault',{access:['read']});assert.deepEqual(f.desks.resource('bpm','vault').access,['read']);
});
