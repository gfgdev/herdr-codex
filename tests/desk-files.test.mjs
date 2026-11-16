import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,symlinkSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Delegation} from '../src/delegation.mjs';
import {digest} from '../src/config.mjs';

const THREAD='00000000-0000-4000-8000-000000000001';
function fixture(t,{migrate=false}={}){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-files-'))),stateDir=join(dir,'state'),vault=join(dir,'vault');for(const p of [stateDir,vault])mkdirSync(p);
  writeFileSync(join(vault,'human.md'),'Original human knowledge.\n');
  const config={stateDir,herdrReadPaths:[],hc:'/fixture/hc',app:'/fixture/app',node:process.execPath,profileFile:'/fixture/profile',packageRoot:'/fixture/package'};
  const store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});
  desks.create({id:'bpm',name:'BPM',purpose:'Client operations',vaultPath:vault});
  if(migrate){desks.definitionPut({deskId:'bpm',id:'operator',name:'Operator',harness:'pi',scope:'write',resourceIds:['vault'],instructions:'Existing instructions.'});desks.workflowPut({deskId:'bpm',id:'existing',name:'Existing',definitionId:'operator',instructions:'Existing procedure.'});}
  desks.files.scaffold('bpm');const root=desks.files.root('bpm');
  let runs=0;const terminals=new Map(),rpc={request:async(method,p)=>{
    if(method==='terminal.run'){const address='t'+(++runs);const native={address,pid:1000+runs,cwd:p.cwd,argv:p.argv,labels:p.labels,state:'live',status:{state:'idle'},turn:0};terminals.set(address,native);return {address,pid:native.pid};}
    const native=terminals.get(p.terminal);
    if(method==='terminal.get')return native;
    if(method==='terminal.wait')return {settled:true};
    if(method==='terminal.send'){native.turn++;native.status={state:'done'};return {started:true,turn:native.turn};}
    throw new Error('Unexpected RPC '+method);
  }};
  const api=new Delegation({config,store,rpc,prepare:async w=>({cwd:w.project,argv:['fixture',w.id]})});
  const input=id=>({id,name:id,deskId:'bpm',deskDefinitionId:'operator',threadId:THREAD,instruction:'Write a source-supported report.'});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,stateDir,vault,config,store,desks,root,api,input,get runs(){return runs;}};
}

test('template is editable, repeatable and preserves preexisting knowledge and role edits',t=>{
  const f=fixture(t);assert.equal(readFileSync(join(f.vault,'human.md'),'utf8'),'Original human knowledge.\n');
  for(const file of ['desk.yaml','DESK.md','AGENTS.md','agents/operator/AGENT.md','automations/README.md'])assert.ok(existsSync(join(f.root,file)),file);
  const path=join(f.root,'agents/operator/AGENT.md');writeFileSync(path,readFileSync(path,'utf8')+'\nUse precise document references.\n');
  const synced=f.desks.files.scaffold('bpm');assert.equal(synced.definitions.operator,2);assert.match(f.desks.definition('bpm','operator').instructions,/precise document/);
  assert.equal(f.desks.files.sync('bpm').definitions.operator,2);assert.match(readFileSync(path,'utf8'),/precise document/);
});

test('migration retains original IDs, versions and workflow pins',t=>{
  const f=fixture(t,{migrate:true});assert.equal(f.desks.definition('bpm','operator').version,1);assert.equal(f.desks.workflow('bpm','existing').version,1);
  assert.equal(f.desks.workflow('bpm','existing').definitionVersion,1);assert.deepEqual(readdirSync(join(f.root,'agents')),['operator']);
  assert.match(readFileSync(join(f.root,'agents/operator/AGENT.md'),'utf8'),/Existing instructions/);
});

test('invalid full snapshot rolls back all imports; deleted role does not fall back to history',async t=>{
  const f=fixture(t,{migrate:true}),path=join(f.root,'agents/operator/AGENT.md'),old=readFileSync(path,'utf8');writeFileSync(path,old+'\nNew role instructions.\n');
  const flow=join(f.root,'workflows/existing/WORKFLOW.md'),flowText=readFileSync(flow,'utf8');writeFileSync(flow,flowText.replace('definitionId: operator','definitionId: absent'));
  assert.equal(f.desks.files.validate('bpm').valid,false);assert.throws(()=>f.desks.files.sync('bpm'),/missing authored agent/);assert.equal(f.desks.definition('bpm','operator').version,1);
  await assert.rejects(f.api.delegate(f.input('alpha')),/missing authored agent/);assert.equal(f.runs,0);assert.equal(f.store.workers().length,0);
  rmSync(join(f.root,'workflows/existing'),{recursive:true});rmSync(join(f.root,'agents/operator'),{recursive:true});
  await assert.rejects(f.api.delegate(f.input('alpha')),/entry is missing/);assert.equal(f.desks.definition('bpm','operator').version,1);
});

test('frozen worker retries and follow-ups survive subsequent malformed authored files',async t=>{
  const f=fixture(t),input=f.input('alpha'),first=await f.api.delegate(input),worker=f.store.worker('alpha');
  writeFileSync(join(f.root,'agents/operator/AGENT.md'),'not frontmatter');
  const retry=await f.api.delegate(input);assert.equal(retry.terminalId,first.terminalId);assert.equal(f.runs,1);assert.deepEqual(f.store.worker('alpha').delegation,worker.delegation);
  const follow=await f.api.followup('alpha','follow-1',{instruction:'Continue the same report.'});assert.equal(follow.state,'sent');
  await assert.rejects(f.api.delegate(f.input('beta')),/frontmatter/);assert.equal(f.runs,1);
});

test('next agent receives edited role and shared conventions; original agent remains pinned',async t=>{
  const f=fixture(t);await f.api.delegate(f.input('alpha'));const first=f.store.worker('alpha');
  const path=join(f.root,'agents/operator/AGENT.md');writeFileSync(path,readFileSync(path,'utf8')+'\nNew requirement: explain currency assumptions.\n');
  writeFileSync(join(f.root,'AGENTS.md'),readFileSync(join(f.root,'AGENTS.md'),'utf8')+'\nDesk convention: include an evidence index.\n');
  await f.api.delegate(f.input('beta'));const next=f.store.worker('beta');
  assert.equal(next.deskDefinitionVersion,2);assert.equal(first.deskDefinitionVersion,1);assert.match(next.delegation.spec.template.instructions,/currency assumptions/);
  assert.match(next.delegation.spec.context.content,/evidence index/);assert.doesNotMatch(first.delegation.spec.context.content,/evidence index/);
});

test('two task writers share a read-only cwd and hold disjoint output leases; checkout writers still conflict',async t=>{
  const f=fixture(t);await Promise.all([f.api.delegate(f.input('alpha')),f.api.delegate(f.input('beta'))]);
  const [a,b]=['alpha','beta'].map(id=>f.store.worker(id));assert.equal(a.project,b.project);assert.equal(f.runs,2);
  for(const w of [a,b]){assert.equal(w.writePaths.length,2);assert.ok(w.writePaths.every(p=>p.startsWith(f.root+'/work/')));assert.ok(!w.writePaths.includes(w.project));assert.ok(!w.writePaths.includes(f.vault));}
  assert.ok(a.writePaths.every(p=>!b.writePaths.includes(p)));
  const leaseCount=f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n;assert.equal(leaseCount,2);
  f.desks.definitionPut({deskId:'bpm',id:'coder',name:'Coder',harness:'pi',scope:'write',writeMode:'project',instructions:'Change the explicitly selected coding project.',resourceIds:['vault']});
  await f.api.delegate({...f.input('gamma'),deskDefinitionId:'coder'});
  await assert.rejects(f.api.delegate({...f.input('delta'),deskDefinitionId:'coder'}),/Checkout is already owned/);assert.equal(f.runs,3);
});

test('file-backed API authoring writes the same source and does not create independent definitions',t=>{
  const f=fixture(t);const result=f.desks.definitionPut({deskId:'bpm',id:'custom',name:'Custom',harness:'goose',scope:'write',instructions:'Maintain useful knowledge.',resourceIds:['vault']});
  assert.equal(result.version,1);assert.match(readFileSync(join(f.root,'agents/custom/AGENT.md'),'utf8'),/Maintain useful knowledge/);
  f.desks.update('bpm',{purpose:'New business purpose'});assert.match(readFileSync(join(f.root,'desk.yaml'),'utf8'),/New business purpose/);
  assert.equal(f.desks.files.sync('bpm').definitions.custom,1);
  if(process.platform==='darwin'){
    const original=readFileSync(join(f.root,'agents/operator/AGENT.md'),'utf8');
    assert.throws(()=>f.desks.definitionPut({deskId:'bpm',id:'OPERATOR',name:'Wrong alias',harness:'pi',scope:'write',instructions:'Must not overwrite.'}),/alias collision/);
    assert.equal(readFileSync(join(f.root,'agents/operator/AGENT.md'),'utf8'),original);assert.equal(f.desks.files.validate('bpm').valid,true);
  }
});

test('YAML conflicts, aliases, foreign identities and symlink substitution are rejected',t=>{
  const f=fixture(t),path=join(f.root,'agents/operator/AGENT.md'),original=readFileSync(path,'utf8');
  for(const changed of [original.replace('id: operator','id: foreign'),original.replace('id: operator','id: operator\nid: duplicate'),original.replace('id: operator','id: &x [*x]')]){writeFileSync(path,changed);assert.equal(f.desks.files.validate('bpm').valid,false);}
  writeFileSync(path,original);writeFileSync(join(f.root,'agents/operator/AGENT (conflicted copy).md'),'conflict');assert.equal(f.desks.files.validate('bpm').valid,false);rmSync(join(f.root,'agents/operator/AGENT (conflicted copy).md'));
  rmSync(path);symlinkSync(join(f.vault,'human.md'),path);assert.equal(f.desks.files.validate('bpm').valid,false);
});

test('template refuses existing unrelated Desk folders and resumes an interrupted scaffold without overwrites',t=>{
  const f=fixture(t),second=join(f.dir,'other-vault');mkdirSync(second);mkdirSync(join(second,'Desk'));writeFileSync(join(second,'Desk','mine.md'),'Preserve');
  f.desks.create({id:'other',name:'Other',purpose:'Other',vaultPath:second});assert.throws(()=>f.desks.files.scaffold('other'),/already contains files/);assert.equal(readFileSync(join(second,'Desk/mine.md'),'utf8'),'Preserve');
});

test('enabled automations are rejected rather than advertised as executing',t=>{
  const f=fixture(t),path=join(f.root,'automations/daily.yaml');writeFileSync(path,'enabled: true\nworkflow: anything\n');assert.equal(f.desks.files.validate('bpm').valid,false);
  writeFileSync(path,'enabled: false\nworkflow: proposed\n');assert.equal(f.desks.files.validate('bpm').valid,true);assert.equal(f.store.workers().length,0);
});

test('publication checks exact source/target content, persists idempotent receipt, and preserves controls',async t=>{
  const f=fixture(t);await f.api.delegate(f.input('alpha'));const w=f.store.worker('alpha'),source=join(w.delegation.spec.deskWorkspace.outputs,'finding.md');writeFileSync(source,'Verified finding.\n');
  const input={requestId:'publish-1',agentId:'alpha',source,sourceSha256:digest(readFileSync(source)),resourceId:'vault',target:'new-finding.md',expectedSha256:null};
  const first=f.desks.files.publish('bpm',input);assert.equal(first.status,'published');assert.equal(readFileSync(join(f.vault,'new-finding.md'),'utf8'),'Verified finding.\n');
  writeFileSync(join(f.vault,'new-finding.md'),'Later human edit.\n');assert.deepEqual(f.desks.files.publish('bpm',input),first);assert.equal(readFileSync(join(f.vault,'new-finding.md'),'utf8'),'Later human edit.\n');
  assert.throws(()=>f.desks.files.publish('bpm',{...input,requestId:'publish-2'}),/Target changed/);
  assert.throws(()=>f.desks.files.publish('bpm',{...input,requestId:'controls',target:'Desk/AGENTS.md'}),/controls/);
  if(process.platform==='darwin')assert.throws(()=>f.desks.files.publish('bpm',{...input,requestId:'case-controls',target:'desk/AGENTS.md'}),/controls/);
  assert.throws(()=>f.desks.files.publish('bpm',{...input,requestId:'obsidian-controls',target:'.OBSIDIAN/app.json'}),/relative knowledge/);
  assert.throws(()=>f.desks.files.publish('bpm',{...input,requestId:'source-changed',sourceSha256:'0'.repeat(64)}),/Source changed/);
  assert.throws(()=>f.desks.files.publish('bpm',{...input,requestId:'escape',target:'../outside.md'}),/relative knowledge/);
  const expected=digest(readFileSync(join(f.vault,'new-finding.md')));const update=f.desks.files.publish('bpm',{...input,requestId:'publish-3',expectedSha256:expected});assert.equal(update.status,'published');
  const badCas={...input,requestId:'false-cas',expectedSha256:'0'.repeat(64)};
  for(let i=0;i<2;i++)assert.throws(()=>f.desks.files.publish('bpm',badCas),/Target changed/);
  assert.equal(f.store.meta('desk.publish:bpm:false-cas'),null);
});

test('task workspace retries preserve authored briefs and reject symlinked output paths',async t=>{
  const f=fixture(t);await f.api.delegate(f.input('alpha'));const workspace=f.store.worker('alpha').delegation.spec.deskWorkspace;
  writeFileSync(workspace.brief,'User-edited brief.\n');await f.api.delegate(f.input('alpha'));assert.equal(readFileSync(workspace.brief,'utf8'),'User-edited brief.\n');
  const bad=join(f.root,'work/agent-beta');mkdirSync(bad);mkdirSync(join(bad,'agents'));symlinkSync(f.vault,join(bad,'agents/beta'));
  await assert.rejects(f.api.delegate(f.input('beta')),/symbolic link/);assert.equal(f.runs,1);
});
