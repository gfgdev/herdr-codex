import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {installExample} from '../examples/desks/install.mjs';
const THREAD='00000000-0000-4000-8000-000000000001';
function fixture(t){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-examples-'))),stateDir=join(dir,'state'),vault=join(dir,'vault'),project=join(dir,'project');for(const path of [stateDir,vault,project])mkdirSync(path);
  const store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config:{stateDir}});desks.create({id:'trial',name:'Trial',purpose:'Portable examples',vaultPath:vault});desks.projectAdd({deskId:'trial',id:'working',name:'Explicit trial project',path:project});desks.files.scaffold('trial');
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,desks,root:desks.files.root('trial')};
}
for(const [kit,workflow]of [['coding','coding-change'],['research','research-brief'],['operations','operations-batch']])test(kit+' example compiles into a frozen scoped team without launching or enabling schedules',t=>{
  const f=fixture(t),before=readFileSync(join(f.root,'DESK.md'),'utf8'),installed=installExample({kit,deskRoot:f.root});assert.ok(installed.created>0);assert.equal(installed.enabledAutomations,0);
  assert.equal(f.desks.files.validate('trial').valid,true);f.desks.files.sync('trial');const job=f.desks.jobCreate({deskId:'trial',id:'example',workflowId:workflow,ownerThread:THREAD,parameters:{task:'Representative supplied task'}});
  assert.equal(job.projectId,'working');assert.equal(job.snapshot.team.members.length,3);assert.ok(Object.keys(job.snapshot.recipes).length);assert.ok(job.snapshot.workflow.steps.every(step=>step.teamMemberId));assert.ok(f.desks.automations('trial').every(a=>a.enabled===false));assert.deepEqual(f.store.workers(),[]);
  assert.equal(readFileSync(join(f.root,'DESK.md'),'utf8'),before);assert.equal(installExample({kit,deskRoot:f.root}).created,0);
});
test('example copy refuses conflicting human edits before creating any other starter files',t=>{
  const f=fixture(t),role=join(f.root,'agents/coding-reviewer');mkdirSync(role);writeFileSync(join(role,'AGENT.md'),'Human-authored instructions\n');
  assert.throws(()=>installExample({kit:'coding',deskRoot:f.root}),/Refusing to overwrite/);assert.equal(readFileSync(join(role,'AGENT.md'),'utf8'),'Human-authored instructions\n');assert.equal(existsSync(join(f.root,'agents/coding-implementer/AGENT.md')),false);
});
