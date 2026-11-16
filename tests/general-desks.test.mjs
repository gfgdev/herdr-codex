import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {RecipeLibrary} from '../src/recipes.mjs';
const THREAD='00000000-0000-4000-8000-000000000001';
function fixture(t,{files=false}={}){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-general-desks-'))),stateDir=join(dir,'state'),vault=join(dir,'vault');for(const path of [stateDir,vault])mkdirSync(path);
  const config={stateDir},store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});
  desks.create({id:'desk',name:'Desk',purpose:'General work',vaultPath:vault});
  const role=(id,extra={})=>desks.definitionPut({deskId:'desk',id,name:id,harness:'goose',scope:'read-only',instructions:'Inspect evidence.',...extra});
  role('operator',{harness:'pi',scope:'write'});role('reviewer',{authority:{reviewRoles:['operator']}});role('lead',{authority:{delegateRoles:['operator','reviewer'],reviewRoles:['operator']}});
  if(files)desks.files.scaffold('desk');
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const flow=(extra={})=>desks.workflowPut({deskId:'desk',id:'work',name:'Work',steps:[{id:'write',kind:'agent',definitionId:'operator'},{id:'check',kind:'review',definitionId:'reviewer',dependsOn:['write']}],...extra});
  const job=(extra={})=>desks.jobCreate({deskId:'desk',id:'run',workflowId:'work',ownerThread:THREAD,...extra});
  return {dir,stateDir,vault,config,store,desks,role,flow,job,root:files?desks.files.root('desk'):null};
}
test('authority is optional, strict, same-desk and versioned',t=>{
  const f=fixture(t);assert.equal(f.desks.definition('desk','operator').authority,undefined);
  const prior=f.desks.definition('desk','lead');assert.deepEqual(prior.authority,{delegateRoles:['operator','reviewer'],reviewRoles:['operator']});
  assert.throws(()=>f.role('lead',{authority:{delegateRoles:['missing']}}),/missing desk role/);
  assert.throws(()=>f.role('lead',{authority:{delegateRoles:['operator'],projectIds:['other']}}),/Unknown authority/);
  assert.throws(()=>f.role('lead',{authority:{delegateRoles:['operator','operator']}}),/Duplicate/);
  f.role('lead',{authority:{delegateRoles:['operator']}});assert.equal(f.desks.definition('desk','lead',1).hash,prior.hash);
});
test('teams pin roles and reject cycles, foreign roles and unauthorized reporting',t=>{
  const f=fixture(t),input={deskId:'desk',id:'team',name:'Team',members:[{id:'boss',definitionId:'lead'},{id:'writer',definitionId:'operator',reportsTo:'boss'}]};
  const team=f.desks.teamPut(input);assert.equal(team.members[1].definitionVersion,1);assert.deepEqual(f.desks.teamPut(input),team);
  assert.throws(()=>f.desks.teamPut({...input,members:[{id:'a',definitionId:'lead',reportsTo:'b'},{id:'b',definitionId:'operator',reportsTo:'a'}]}),/cycle/);
  assert.throws(()=>f.desks.teamPut({...input,members:[{id:'a',definitionId:'operator'},{id:'b',definitionId:'lead',reportsTo:'a'}]}),/not authorized/);
  assert.throws(()=>f.desks.teamPut({...input,members:[{id:'a',definitionId:'unknown'}]}),/Unknown desk/);
  assert.throws(()=>f.desks.teamPut({...input,members:[{id:'a',definitionId:'operator',reportsTo:'missing'}]}),/unknown member/);
});
test('structured workflow pins scope and validates dependency and review graphs',t=>{
  const f=fixture(t),flow=f.flow();assert.equal(flow.steps[0].definitionVersion,1);assert.equal(flow.definitionId,undefined);
  assert.throws(()=>f.flow({steps:[{id:'a',kind:'agent',definitionId:'operator',dependsOn:['b']},{id:'b',kind:'agent',definitionId:'operator',dependsOn:['a']}]}),/cycle/);
  assert.throws(()=>f.flow({steps:[{id:'a',kind:'agent',definitionId:'operator',dependsOn:['unknown']}]}),/unknown member/);
  assert.throws(()=>f.flow({steps:[{id:'a',kind:'agent',definitionId:'operator'},{id:'b',kind:'review',definitionId:'operator',dependsOn:['a']}]}),/not authorized/);
  assert.throws(()=>f.flow({steps:[{id:'a',kind:'review',definitionId:'reviewer'}]}),/explicit dependency/);
  assert.throws(()=>f.flow({resourceIds:['vault']}),/outside its definition/);
});
test('supervisor links do not become dependency edges and require role authority',t=>{
  const f=fixture(t),flow=f.flow({steps:[{id:'lead',kind:'agent',definitionId:'lead'},{id:'write',kind:'agent',definitionId:'operator',supervisorStepId:'lead'}]});
  assert.deepEqual(flow.steps[1].dependsOn,[]);assert.equal(flow.steps[1].supervisorStepId,'lead');
  assert.throws(()=>f.flow({steps:[{id:'lead',kind:'agent',definitionId:'operator'},{id:'write',kind:'agent',definitionId:'reviewer',supervisorStepId:'lead'}]}),/not authorized/);
});
test('team member steps resolve pinned roles and reporting without dependency edges',t=>{
  const f=fixture(t);f.desks.teamPut({deskId:'desk',id:'team',name:'Team',members:[{id:'boss',definitionId:'lead'},{id:'writer',definitionId:'operator',reportsTo:'boss'}]});
  const steps=[{id:'manage',kind:'agent',teamMemberId:'boss'},{id:'draft',kind:'agent',teamMemberId:'writer'}],flow=f.flow({teamId:'team',steps});
  assert.throws(()=>f.flow({teamId:'team',steps:[{id:'unassigned',kind:'agent',definitionId:'lead'}]}),/require teamMemberId/);
  assert.equal(flow.steps[1].supervisorStepId,'manage');assert.deepEqual(flow.steps[1].dependsOn,[]);assert.equal(flow.steps[1].definitionId,'operator');
  assert.throws(()=>f.flow({teamId:'team',steps:[{...steps[0],supervisorStepId:'draft'},steps[1]]}),/conflicts with team/);
  assert.throws(()=>f.flow({teamId:'team',steps:[steps[1]]}),/exactly one workflow step/);
  assert.throws(()=>f.flow({teamId:'team',steps:[steps[0],{...steps[0],id:'other'},steps[1]]}),/exactly one workflow step/);
  assert.throws(()=>f.flow({teamId:'team',steps:[steps[0],{...steps[1],definitionId:'reviewer'}]}),/does not match/);
});
test('commands require an explicit or fallback scoped role and preserve argument boundaries',t=>{
  const f=fixture(t);assert.throws(()=>f.flow({steps:[{id:'count',kind:'command',command:{argv:['wc','file with space']}}]}),/definition ID/);
  const flow=f.flow({definitionId:'operator',steps:[{id:'count',kind:'command',command:{argv:['wc','file with space','']}}]});assert.deepEqual(flow.steps[0].command.argv,['wc','file with space','']);
  assert.throws(()=>f.flow({definitionId:'operator',steps:[{id:'count',kind:'command',command:{argv:[]}}]}),/argv/);
  assert.throws(()=>f.flow({steps:[{id:'count',kind:'agent',definitionId:'operator',command:{argv:['sh']}}]}),/Only command/);
});
test('jobs freeze recursive granted role versions and immutable run parameters',t=>{
  const f=fixture(t);f.flow({steps:[{id:'lead',kind:'agent',definitionId:'lead'}]});
  const first=f.job({parameters:{document:'invoice-123',flags:[true,2]}});assert.deepEqual(Object.keys(first.snapshot.definitions).sort(),['lead@1','operator@1','reviewer@1']);
  f.role('operator',{harness:'pi',scope:'write',instructions:'Changed behavior.'});f.flow({steps:[{id:'lead',kind:'agent',definitionId:'lead'}],instructions:'New flow'});
  assert.deepEqual(f.job().snapshot,first.snapshot);assert.throws(()=>f.job({parameters:{document:'other'}}),/different registration/);
  assert.throws(()=>f.job({id:'invalid',parameters:{bad:Infinity}}),/finite JSON/);
  assert.throws(()=>f.job({id:'invalid',parameters:{bad:new Date()}}),/finite JSON/);
  assert.throws(()=>f.job({id:'invalid',parameters:JSON.parse('{"__proto__":{}}')}),/Reserved parameter/);
});
test('jobs freeze native recipe contents and reuse original snapshot after authored edits',t=>{
  const f=fixture(t,{files:true}),library=new RecipeLibrary(f),native='title: Brief\ndescription: Brief task\ninstructions: Inspect source\nactivities: []\n';
  library.put('desk',{id:'brief',content:native});f.flow({steps:[{id:'brief',kind:'recipe',definitionId:'lead',recipeId:'brief',parameters:{topic:'orders'}}]});
  const first=f.job();assert.equal(first.snapshot.workflow.steps[0].recipeVersion,1);assert.match(first.snapshot.recipes['brief@1'].files[0].content,/Inspect source/);
  writeFileSync(join(f.root,'recipes/brief/recipe.yaml'),'malformed: [');assert.deepEqual(f.job().snapshot,first.snapshot);assert.throws(()=>f.job({id:'new'}),/YAML/);
});
test('automation schema defaults disabled and requires explicit chat and typed trigger fields',t=>{
  const f=fixture(t);f.flow();const input={deskId:'desk',id:'daily',type:'interval',workflowId:'work',everySeconds:86400},a=f.desks.automationPut(input);
  assert.equal(a.enabled,false);assert.equal(a.overlap,'skip');assert.equal(a.ownerThread,null);
  assert.throws(()=>f.desks.automationPut({...input,enabled:true}),/ownerThread/);
  assert.throws(()=>f.desks.automationPut({...input,ownerThread:THREAD,eventName:'event'}),/Only event/);
  assert.throws(()=>f.desks.automationPut({...input,everySeconds:0}),/everySeconds/);
  assert.throws(()=>f.desks.automationPut({...input,startAt:'tomorrow'}),/ISO/);
  const enabled=f.desks.automationPut({...input,enabled:true,ownerThread:THREAD,startAt:'2026-11-13T10:00:00-08:00',overlap:'queue'});assert.equal(enabled.startAt,'2026-11-13T18:00:00.000Z');assert.equal(a.enabled,false);
});
test('file authorship roundtrips teams workflows and automations and leaves disabled proposals inert',t=>{
  const f=fixture(t,{files:true});f.desks.teamPut({deskId:'desk',id:'team',name:'Team',members:[{id:'boss',definitionId:'lead'},{id:'writer',definitionId:'operator',reportsTo:'boss'}]});
  f.flow({teamId:'team',steps:[{id:'manage',kind:'agent',teamMemberId:'boss'},{id:'draft',kind:'agent',teamMemberId:'writer'}]});
  f.desks.automationPut({deskId:'desk',id:'manual',type:'manual',workflowId:'work'});
  writeFileSync(join(f.root,'automations/proposal.yaml'),'enabled: false\nfuture: arbitrary proposed connector\n');
  const r=f.desks.files.sync('desk');assert.equal(r.teams.team,1);assert.equal(r.workflows.work,1);assert.equal(r.automations.manual,1);assert.equal(r.proposedAutomations.length,1);assert.equal(f.desks.automations('desk').length,1);
  assert.match(readFileSync(join(f.root,'teams/team/TEAM.md'),'utf8'),/reportsTo: boss/);
  writeFileSync(join(f.root,'automations/manual.yml'),readFileSync(join(f.root,'automations/manual.yaml')));assert.throws(()=>f.desks.files.sync('desk'),/Duplicate automation ID/);rmSync(join(f.root,'automations/manual.yml'));
  const first=f.job();writeFileSync(join(f.root,'AGENTS.md'),'New shared instructions\n');assert.notEqual(f.desks.files.sync('desk').shared,first.snapshot.shared);assert.deepEqual(f.job().snapshot,first.snapshot);
});
test('forward referenced authority compiles atomically and deleted author roles cannot fall back to history',t=>{
  const f=fixture(t,{files:true});assert.equal(f.desks.files.validate('desk').valid,true); // lead sorts before operator/reviewer.
  const lead=join(f.root,'agents/lead/AGENT.md');writeFileSync(lead,readFileSync(lead,'utf8')+'\nNew lead instructions.\n');
  rmSync(join(f.root,'agents/operator'),{recursive:true});assert.equal(f.desks.files.validate('desk').valid,false);assert.throws(()=>f.desks.files.sync('desk'),/missing desk role/);assert.equal(f.desks.definition('desk','lead').version,1);
});
test('additive layout migration preserves human files and rejects symlink additions',t=>{
  const f=fixture(t,{files:true});for(const name of ['teams','recipes','knowledge'])assert.ok(existsSync(join(f.root,name)));
  writeFileSync(join(f.root,'DESK.md'),'Human orientation\n');rmSync(join(f.root,'knowledge'),{recursive:true});f.desks.files.scaffold('desk');assert.equal(readFileSync(join(f.root,'DESK.md'),'utf8'),'Human orientation\n');assert.ok(existsSync(join(f.root,'knowledge')));
  rmSync(join(f.root,'knowledge'),{recursive:true});symlinkSync(f.vault,join(f.root,'knowledge'));assert.throws(()=>f.desks.files.scaffold('desk'),/symbolic links/);
});

test('run parameters canonicalize nested keys while preserving array order',t=>{
  const f=fixture(t);f.flow();const first=f.job({parameters:{z:1,a:{second:2,first:1},list:[{y:2,x:1},3]}});
  const replay=f.job({parameters:{list:[{x:1,y:2},3],a:{first:1,second:2},z:1}});assert.deepEqual(replay,first);
  f.desks._save('job',{...first,parameters:{z:1,list:[{y:2,x:1},3],a:{second:2,first:1}}});assert.equal(f.job({parameters:{a:{first:1,second:2},list:[{x:1,y:2},3],z:1}}).id,first.id);
  assert.throws(()=>f.job({parameters:{list:[3,{x:1,y:2}],a:{first:1,second:2},z:1}}),/different registration/);
});

test('run snapshots retain exact resource descriptors and resource access cannot change during unsettled work',t=>{
  const f=fixture(t);f.role('operator',{harness:'pi',scope:'write',resourceIds:['vault']});f.flow();const first=f.job();assert.deepEqual(first.snapshot.resources.vault,f.desks.resource('desk','vault'));
  assert.throws(()=>f.desks.resourceUpdate('desk','vault',{access:['read']}),/unsettled/);assert.deepEqual(f.job().snapshot.resources,first.snapshot.resources);
});
