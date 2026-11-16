import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {RecipeLibrary,recipeBundle,assertRecipePolicy,assertRecipeSnapshot,recipeParameters} from '../src/recipes.mjs';
import {prepareWorker,startRecipeWorker} from '../src/workers.mjs';
const packageRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const yaml='title: Analyze\ndescription: Native recipe\nprompt: Inspect the assigned task\nfuture_native_field:\n  preserve: exactly\n';
async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'herdr-recipes-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const project=join(dir,'project'),vault=join(dir,'vault'),stateDir=join(dir,'state');await Promise.all([project,vault,stateDir].map(p=>mkdir(p)));
 const profileFile=join(dir,'profile.json');const profile={model:'selected-model',endpoint:'https://modal.invalid/v1',credentialFile:join(dir,'missing-key'),goose:join(dir,'fake-goose')};await writeFile(profileFile,JSON.stringify(profile));
 const store=new Store(join(stateDir,'manager.sqlite'));t.after(()=>store.close());const config={stateDir,profileFile};const desks=new Desks({store,config});desks.create({id:'desk',name:'Fixture',purpose:'Recipes',vaultPath:vault});desks.files.scaffold('desk');
 const library=new RecipeLibrary({store,config,desks});const worker={version:1,id:'recipe-worker',taskId:'task',name:'Recipe Goose',role:'goose',project,stateDir:join(dir,'worker'),hc:join(dir,'hc'),node:process.execPath,profileFile,packageRoot,mailbox:'task',instructions:'Read only.',writePaths:[]};
 return {dir,project,vault,stateDir,store,config,desks,library,profile,worker};
}
test('authored native fields and transitive companions are frozen, versioned and preserved',async t=>{
 const f=await fixture(t);const main=yaml+'sub_recipes:\n  - name: child\n    path: ./sub/child.yaml\n';
 const child='title: Child\ndescription: Child\nprompt: "{% include \'notes.txt\' %}"\n';
 const one=f.library.put('desk',{id:'audit',content:main,files:[{path:'sub/child.yaml',content:child},{path:'sub/notes.txt',content:'Local facts\n'}]});
 assert.equal(one.version,1);assert.equal(one.files.find(x=>x.path==='recipe.yaml').content,main);assert.equal(one.files.length,3);
 assert.equal(f.library.get('desk','audit').version,1);assert.equal(f.library.list('desk')[0].id,'audit');
 await writeFile(join(f.vault,'Desk/recipes/audit/sub/notes.txt'),'New facts\n');
 const two=f.library.snapshot('desk','audit');assert.equal(two.version,2);assert.notEqual(two.sha256,one.sha256);
 assert.equal(f.library.snapshot('desk','audit',1).sha256,one.sha256);assert.equal(f.library.snapshot('desk','audit',1).files.find(x=>x.path==='sub/notes.txt').content,'Local facts\n');
 assert.equal(f.library.put('desk',{id:'audit',content:main}).version,2);
});
test('snapshot rejects traversal, aliases, cycles, missing dependencies and changed hashes',async t=>{
 const f=await fixture(t);assert.throws(()=>recipeBundle({id:'x',files:[{path:'../recipe.yaml',content:yaml}]}),/inside/);
 assert.throws(()=>recipeBundle({id:'x',files:[{path:'recipe.yaml',content:yaml},{path:'RECIPE.yaml',content:yaml}]}),/aliased/);
 assert.throws(()=>recipeBundle({id:'x',files:[{path:'recipe.yaml',content:yaml+'sub_recipes:\n- name: x\n  path: missing.yaml\n'}]}),/missing/);
 assert.throws(()=>recipeBundle({id:'x',files:[{path:'recipe.yaml',content:yaml+'sub_recipes:\n- name: x\n  path: recipe.yaml\n'}]}),/Cyclic/);
 const r=recipeBundle({id:'x',files:[{path:'recipe.yaml',content:yaml}]});assert.throws(()=>assertRecipeSnapshot({...r,sha256:'bad'}),/hash mismatch/);
 f.library.put('desk',{id:'x',content:yaml});await symlink(f.profile.credentialFile,join(f.vault,'Desk/recipes/x/secret'));assert.throws(()=>f.library.snapshot('desk','x'),/symbolic/);
});
test('native recipes retain compatible settings and reject model/config/resource overrides',()=>{
 const make=suffix=>recipeBundle({id:'x',files:[{path:'recipe.yaml',content:yaml+suffix}]});
 assertRecipePolicy(make('settings:\n  goose_provider: openai\n  goose_model: selected\n  temperature: 0.2\n'),{model:'selected'});
 for(const suffix of ['settings:\n  goose_model: other\n','settings:\n  goose_provider: another\n','settings:\n  goose_model: "{{ model }}"\n','writePaths: ["/"]\n','settings:\n  env: {OPENAI_HOST: somewhere}\n'])assert.throws(()=>assertRecipePolicy(make(suffix),{model:'selected'}),/override/);
 assert.deepEqual(recipeParameters({a:'literal "\nvalue',b:2,c:false}),{a:'literal "\nvalue',b:'2',c:'false'});
 assert.throws(()=>recipeParameters({recipe_dir:'/somewhere'}),/reserved/);
 assert.throws(()=>recipeParameters({x:{y:1}}),/string, number or boolean/);
});
test('native validation uses the selected binary and isolated no-credential environment, retaining failures',async t=>{
 const f=await fixture(t);await writeFile(f.profile.goose,'#!/bin/sh\n[ "$1" = recipe ] && [ "$2" = validate ] || exit 44\n[ -z "$OPENAI_API_KEY" ] || exit 45\n[ -z "$HERDR_MODAL_API_KEY" ] || exit 46\nprintf "native validation\\n"\nexit 7\n',{mode:0o700});
 const r=f.library.snapshot('desk',f.library.put('desk',{id:'x',content:yaml}).id);const result=await f.library.validateNative(r);
 assert.equal(result.passed,false);assert.equal(result.checks[0].code,7);assert.match(result.checks[0].stdout,/native validation/);assert.equal(result.noInference,true);assert.match(result.binarySha256,/^[a-f0-9]{64}$/);
});
test('worker freezes native recipe and waits for an idempotent, identity-bound assignment gate',async t=>{
 const f=await fixture(t),recipe=recipeBundle({id:'x',files:[{path:'recipe.yaml',content:yaml}]});
 const worker={...f.worker,recipe,recipeParameters:{format:'markdown'}};const prepared=await prepareWorker(worker);
 assert.equal(prepared.executionMode,'recipe');assert.equal(await readFile(join(worker.stateDir,'recipe/recipe.yaml'),'utf8'),yaml);
 const saved=JSON.parse(await readFile(prepared.configFile));assert.equal(saved.recipe.sha256,recipe.sha256);assert.deepEqual(saved.recipeParameters,{format:'markdown'});
 await assert.rejects(readFile(prepared.recipeStartFile),{code:'ENOENT'});
 const payload={message:'Perform the task',context:{project:'fixture'}};await startRecipeWorker(worker,payload);await startRecipeWorker(worker,payload);
 await assert.rejects(startRecipeWorker(worker,{message:'Different'}),/different assignment/);
 await assert.rejects(startRecipeWorker({...worker,id:'other'},payload),/identity mismatch/);
 assert.deepEqual(JSON.parse(await readFile(prepared.recipeStartFile)).payload,payload);
 await assert.rejects(prepareWorker({...worker,role:'pi'}),/require a Goose/);
});
test('supervisor helper and exact socket access require a complete scoped grant',async t=>{
 const f=await fixture(t),grant={version:1,childDefinitionIds:['reviewer'],projectIds:['desk-project'],allowNested:false};
 await assert.rejects(prepareWorker({...f.worker,supervisionGrant:grant}),/both/);
 const worker={...f.worker,supervisionGrant:grant,supervisionCredential:{version:1,socketPath:join(f.stateDir,'bridge.sock'),credentialFile:join(f.worker.stateDir,'supervision-auth.json')}};
 const p=await prepareWorker(worker);assert.match(await readFile(join(p.stateDir,'bin/herdr-supervise'),'utf8'),/supervisor-cli.mjs/);
 const code='import importlib.util,json,sys\ns=importlib.util.spec_from_file_location("w",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np,w,c=m.load_configuration(sys.argv[2]);print(m.operator_instructions(w));print(m.sandbox_policy(w,c,{}))';
 const r=spawnSync('/usr/bin/python3',['-B','-c',code,join(packageRoot,'src/worker-launch.py'),p.configFile],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/herdr-supervise inbox/);assert.ok(r.stdout.includes('(allow file-write* (literal '+JSON.stringify(worker.supervisionCredential.socketPath)+'))'));
});
