import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {recipeBundle} from '../src/recipes.mjs';
import {prepareWorker} from '../src/workers.mjs';
import {load,JSON_SCHEMA} from '../src/vendor-js-yaml.mjs';
const packageRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
test('installed native Goose renders the actual sandboxed execution overlay without inference',{
 skip:process.platform!=='darwin'||process.env.HERDR_TEST_SANDBOX!=='1'||!process.env.HERDR_TEST_GOOSE?'Requires explicit macOS native Goose rendering test':false,
},async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'herdr-native-recipe-render-')));t.after(()=>rm(dir,{recursive:true,force:true}));const project=join(dir,'project');await mkdir(project);
 const profileFile=join(dir,'profile.json');await writeFile(profileFile,JSON.stringify({model:'selected-fixture-model',endpoint:'https://never-contact.invalid/v1',credentialFile:join(dir,'credential-must-not-exist'),goose:process.env.HERDR_TEST_GOOSE}));
 const content='title: Native overlay\ndescription: Native rendering fixture\ninstructions: Original native instructions\nprompt: "Inspect {{ subject }}"\nfuture_native_field:\n  keep: exactly\nparameters:\n- key: subject\n  input_type: string\n  requirement: required\n  description: Input\nsub_recipes:\n- name: child\n  path: children/child.yaml\n';
 const recipe=recipeBundle({id:'render',files:[{path:'recipe.yaml',content},{path:'children/child.yaml',content:'title: Child\ndescription: Native child\nprompt: Report a fact\n'}]});
 const worker={version:1,id:'w',taskId:'t',name:'native-render',role:'goose',project,stateDir:join(dir,'worker'),hc:'/usr/bin/true',node:process.execPath,profileFile,packageRoot,mailbox:'task',recipe,recipeParameters:{subject:'fixture'}};
 const prepared=await prepareWorker(worker),instructions='Supervisor instructions. Keep {{ literal }} and {% include "not-a-file" %} and {% endraw %} as literal text.\nSecond line: "quoted"; café.';
 const program=String.raw`import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p,w,c=m.load_configuration(sys.argv[2]);r,e,policy,cmd=m.prepare_native_state(p,w,c,{'HOME':os.environ['HOME'],'PATH':os.environ['PATH'],'HC_TERMINAL_ID':'fixture-no-core'})
assert 'OPENAI_API_KEY' not in e
metadata=m.recipe_preflight(p,w,c,e,policy,cmd,r,sys.argv[3])
print(json.dumps({'argv':cmd,'metadata':metadata}))
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,join(packageRoot,'src/worker-launch.py'),prepared.configFile,instructions],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);
 const plan=JSON.parse(result.stdout),overlay=load(await readFile(plan.metadata.entry,'utf8'),{schema:JSON_SCHEMA}),rendered=load(await readFile(join(worker.stateDir,'execution/recipe-overlay-rendered.yaml'),'utf8'),{schema:JSON_SCHEMA});
 assert.ok(!plan.argv.includes('--system'));assert.equal(plan.argv[plan.argv.indexOf('--recipe')+1],plan.metadata.entry);
 assert.deepEqual(overlay.future_native_field,{keep:'exactly'});assert.equal(rendered.prompt,'Inspect fixture');assert.ok(rendered.instructions.startsWith('Original native instructions'));assert.ok(rendered.instructions.includes(instructions));assert.equal(plan.metadata.sourceRecipeSha256,recipe.sha256);assert.notEqual(plan.metadata.effectiveRecipeSha256,recipe.sha256);
 assert.equal(await readFile(join(worker.stateDir,'recipe/recipe.yaml'),'utf8'),content);assert.equal(plan.metadata.mode,'authored-yaml-overlay');
});
