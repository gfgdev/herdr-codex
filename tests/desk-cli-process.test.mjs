import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync,chmodSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {startActivityBus} from '../src/activity-ipc.mjs';

const CLI=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b';

/** The CLI publishes an immutable runtime snapshot (0o400 files, 0o500 dirs)
 * under the fixture state directory. Restore directory write permission before
 * deleting the fixture's own temp tree; production immutability is untouched. */
function writableTree(root){
  if(!existsSync(root))return;
  chmodSync(root,0o700);
  for(const entry of readdirSync(root,{withFileTypes:true})){
    const path=join(root,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory())writableTree(path);
    else chmodSync(path,0o600);
  }
}

/** Real CLI + SQLite + acknowledged IPC, with no native executable or model
 * configured. Each command is a distinct process, as in independent chats. */
async function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-cli-process-'))),stateDir=join(directory,'state'),vault=join(directory,'vault'),project=join(directory,'project'),otherCwd=join(directory,'another-chat');
  for(const path of [stateDir,vault,project,otherCwd])mkdirSync(path);
  const originalNote='Human-authored knowledge stays in its original vault.\n';writeFileSync(join(vault,'note.md'),originalNote);
  const config={version:1,stateDir,hc:'/never/execute',app:'/never/execute',codex:'/never/execute',profileFile:'/never/execute',node:process.execPath};
  const configPath=join(directory,'config.json');writeFileSync(configPath,JSON.stringify(config));
  const store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});
  let acknowledged=0;
  let bus;
  try{bus=await startActivityBus({dbPath:join(stateDir,'manager.sqlite'),onExternalNotify:async()=>{acknowledged++;}});}
  catch(error){store.close();writableTree(directory);rmSync(directory,{recursive:true,force:true});throw error;}
  const run=(args,{cwd=directory,viaEnv=false}={})=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[CLI,...(viaEnv?[]:['--config',configPath]),...args],{cwd,env:{...process.env,HERDR_CODEX_CONFIG:configPath},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('Isolated CLI fixture timed out'));},10000);
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.once('error',error=>finish(error));child.once('close',(code,signal)=>finish(null,{code,signal,stdout,stderr}));
  });
  const json=async(args,options)=>{const result=await run(args,options);assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);return JSON.parse(result.stdout);};
  const payload=value=>{const file=join(directory,'payload-'+Math.random().toString(16).slice(2)+'.json');writeFileSync(file,JSON.stringify(value));return file;};
  const put=(verb,value)=>json(['desk',verb,'--id','bpm','--file',payload(value)]);
  const create=()=>json(['desk','create','--id','bpm','--name','BPM','--purpose','Client operations','--vault',vault]);
  t.after(async()=>{await bus.close();store.close();writableTree(directory);rmSync(directory,{recursive:true,force:true});});
  return {directory,stateDir,vault,project,otherCwd,configPath,store,desks,run,json,payload,put,create,originalNote,get acknowledged(){return acknowledged;}};
}

test('real CLI creates a desk and discovers the same durable desk from a new process and cwd',async t=>{
  const f=await fixture(t),desk=await f.create();
  assert.equal(desk.vaultPath,f.vault);assert.equal(desk.home,join(f.stateDir,'desks/bpm/home'));assert.ok(f.acknowledged>0,'Mutation exits only after actual bridge IPC acknowledgement');
  // An unrelated cwd is not allowed to redefine the selected installation.
  writeFileSync(join(f.otherCwd,'config.json'),JSON.stringify({version:1,stateDir:'/never/use-this-cwd-state'}));
  const list=await f.json(['desk','list'],{cwd:f.otherCwd,viaEnv:true});assert.equal(list.length,1);assert.equal(list[0].id,'bpm');assert.equal(list[0].home,desk.home);
  const show=await f.json(['desk','show','--id','bpm'],{cwd:f.otherCwd,viaEnv:true});assert.equal(show.resources.find(r=>r.id==='vault').path,f.vault);assert.deepEqual(show.resources.find(r=>r.id==='vault').access,['read','write']);
  assert.equal(readFileSync(join(f.vault,'note.md'),'utf8'),f.originalNote);assert.match(readFileSync(join(desk.home,'DESK.md'),'utf8'),/BPM/);
  assert.deepEqual(f.store.workers(),[]);assert.deepEqual(f.store.tasks(),[]);
});

test('real CLI JSON authoring persists projects, resources, specialists, workflow pins and work items',async t=>{
  const f=await fixture(t);await f.create();
  const project=await f.put('project-add',{id:'client-site',name:'Client site',path:f.project});assert.equal(project.path,f.project);
  const resource=await f.put('resource-add',{id:'source-note',name:'Source note',kind:'file',path:join(f.vault,'note.md'),access:['read']});assert.equal(resource.connected,true);
  const spec={id:'client-researcher',name:'Client researcher',harness:'goose',scope:'read-only',instructions:'Read the registered source and cite evidence.',resourceIds:['source-note'],context:'Client-specific context.',acceptance:['Cite the source note.']};
  const first=await f.put('definition-put',spec);assert.equal(first.version,1);
  const workflow=await f.put('workflow-put',{id:'research',name:'Manual research',definitionId:'client-researcher',definitionVersion:1,projectId:'client-site',instructions:'Answer the supplied research question.'});assert.equal(workflow.definitionVersion,1);assert.equal(workflow.trigger,'manual');
  const work=await f.put('work-create',{id:'research-item',title:'Research question',brief:'Inspect the note and explain the result.',projectId:'client-site',ownerThread:THREAD});assert.equal(work.status,'planned');
  const second=await f.put('definition-put',{...spec,instructions:'Read the source and cite precise passages.'});assert.equal(second.version,2);
  const reopened=await f.json(['desk','show','--id','bpm'],{cwd:f.otherCwd,viaEnv:true});
  assert.deepEqual(reopened.definitions.filter(d=>d.id==='client-researcher').map(d=>d.version),[1,2]);assert.equal(reopened.workflows[0].definitionVersion,1);
  assert.equal(reopened.work[0].ownerThread,THREAD);assert.equal(reopened.projects.find(p=>p.id==='client-site').path,f.project);
  const job=await f.put('job-create',{id:'manual-job',workflowId:'research',ownerThread:THREAD,workId:'research-item'});assert.equal(job.snapshot.definition.version,1);assert.equal(job.status,'pending');
  assert.deepEqual(f.store.workers(),[]);assert.deepEqual(f.store.tasks(),[]);assert.ok(f.acknowledged>=7);
});

test('actual CLI help exposes desk and delegation controls without invoking native tools',async t=>{
  const f=await fixture(t),result=await f.run(['help']);assert.equal(result.code,0,result.stderr);
  for(const text of ['desk create','--vault','desk run','--workflow','--desk-project','--definition','desk list','resource-update','agent followup'])assert.ok(result.stdout.includes(text),text);
  assert.deepEqual(f.desks.list(),[]);assert.equal(f.acknowledged,0);
});

test('actual CLI rejects foreign identities and malformed input without changing desk state',async t=>{
  const f=await fixture(t);await f.create();const before=f.desks.show('bpm'),journalBefore=f.store.db.prepare('SELECT COUNT(*) AS count FROM journal').get().count;
  const foreign=await f.run(['desk','resource-add','--id','bpm','--file',f.payload({deskId:'other',id:'mail',name:'Foreign',kind:'mailbox',ref:'mailbox-id'})]);assert.equal(foreign.code,1);assert.match(foreign.stderr,/Payload desk differs/);
  const malformed=join(f.directory,'malformed.json');writeFileSync(malformed,'{not valid json');const broken=await f.run(['desk','definition-put','--id','bpm','--file',malformed]);assert.equal(broken.code,1);assert.match(broken.stderr,/JSON|property/);
  const absent=await f.run(['desk','show','--id','missing']);assert.equal(absent.code,1);assert.match(absent.stderr,/Unknown desk/);
  const unexpected=await f.run(['desk','update','--id','bpm','--file',f.payload({home:f.project})]);assert.equal(unexpected.code,1);assert.match(unexpected.stderr,/Unknown desk update field/);
  assert.deepEqual(f.desks.show('bpm'),before);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM journal').get().count,journalBefore);
});

test('actual CLI refuses an unavailable mailbox connector before native launch or agent registration',async t=>{
  const f=await fixture(t);await f.create();
  await f.put('resource-add',{id:'mail',name:'Intake mailbox',kind:'mailbox',ref:'test-mailbox-id',access:['read']});
  await f.put('definition-put',{id:'po-specialist',name:'PO specialist',harness:'goose',scope:'read-only',instructions:'Read new purchase orders.',resourceIds:['mail']});
  const result=await f.run(['delegate','--desk','bpm','--definition','po-specialist','--id','po-fixture','--thread',THREAD,'--text','Inspect the registered mailbox.']);
  assert.equal(result.code,1);assert.match(result.stderr,/no executable connector: mail/);assert.doesNotMatch(result.stderr,/ENOENT|spawn|never\/execute/);
  assert.deepEqual(f.store.workers(),[]);assert.deepEqual(f.store.tasks(),[]);assert.deepEqual(f.desks.jobs('bpm'),[]);
});

test('actual CLI updates resource access durably while keeping path identity and source files',async t=>{
  const f=await fixture(t);await f.create();
  const readOnly=await f.put('resource-update',{id:'vault',access:['read']});assert.deepEqual(readOnly.access,['read']);
  const before=f.acknowledged;
  const writable=await f.put('resource-update',{id:'vault',access:['read','write']});assert.equal(writable.path,f.vault);assert.deepEqual(writable.access,['read','write']);assert.ok(f.acknowledged>before);
  const reopened=await f.json(['desk','resources','--id','bpm'],{cwd:f.otherCwd,viaEnv:true});assert.deepEqual(reopened.find(r=>r.id==='vault').access,['read','write']);
  const rejected=await f.run(['desk','resource-update','--id','bpm','--file',f.payload({id:'vault',path:f.project,access:['read']})]);assert.equal(rejected.code,1);assert.match(rejected.stderr,/Unknown resource update field/);
  assert.deepEqual(f.desks.resource('bpm','vault'),writable);assert.equal(readFileSync(join(f.vault,'note.md'),'utf8'),f.originalNote);
  assert.deepEqual(f.store.workers(),[]);assert.deepEqual(f.store.tasks(),[]);
});

test('fresh CLI processes load edited YAML and Markdown and reject invalid files without partial import',async t=>{
  const f=await fixture(t);await f.create();const root=join(f.vault,'Desk'),role=join(root,'agents/operator/AGENT.md');
  const original=readFileSync(role,'utf8');writeFileSync(role,original+'\nSave a source index with every deliverable.\n');
  const synced=await f.json(['desk','sync','--id','bpm'],{cwd:f.otherCwd,viaEnv:true});assert.equal(synced.definitions.operator,2);
  const show=await f.json(['desk','show','--id','bpm']);assert.match(show.definitions.find(d=>d.id==='operator'&&d.version===2).instructions,/source index/);
  writeFileSync(role,'---\nid: operator\nharness: invalid\n---\nInvalid role\n');
  const validation=await f.json(['desk','validate','--id','bpm']);assert.equal(validation.valid,false);
  const broken=await f.run(['desk','sync','--id','bpm']);assert.equal(broken.code,1);
  assert.equal(f.desks.definition('bpm','operator').version,2);assert.equal(f.store.workers().length,0);
});
