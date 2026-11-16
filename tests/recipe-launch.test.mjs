import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {recipeBundle} from '../src/recipes.mjs';
import {prepareWorker} from '../src/workers.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const launcher=join(root,'src/worker-launch.py');
const preamble=`import importlib.util,json,os,pathlib,sys,signal,threading,time\ns=importlib.util.spec_from_file_location('launch',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n`;
async function fixture(t){const dir=await realpath(await mkdtemp(join(tmpdir(),'recipe-launch-')));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'runtime'));return dir;}
test('native recipe process preserves arbitrary output bytes and exact nonzero exit, reporting once without autoaccept',async t=>{
 const dir=await fixture(t),report=join(dir,'report.txt');
 const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime'
w={'id':'w','taskId':'t','recipe':{'sha256':'recipe-hash'},'recipeParameters':{'a':'value'}}
def report(text): pathlib.Path(sys.argv[3]).write_text(text); return 0
code=m.run_recipe_process(w,[sys.executable,'-c','import os,sys;os.write(1,bytes([79,85,84,0,255]));os.write(2,bytes([69,82,82,0,254]));sys.exit(7)'],dict(os.environ),runtime,{'task':'assigned'},reporter=report)
assert code==7
try: m.run_recipe_process(w,[sys.executable,'-c','raise Exception("should not run")'],dict(os.environ),runtime,{},reporter=report)
except ValueError as e: assert 'already has exit evidence' in str(e)
else: raise AssertionError('restarted completed recipe')
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir,report]);assert.equal(result.status,0,result.stderr.toString());
 const evidence=JSON.parse(await readFile(join(dir,'runtime/recipe-result.json')));assert.deepEqual(evidence.exit,{code:7,signal:null});assert.equal(evidence.accepted,false);assert.equal(evidence.reportDelivery.code,0);assert.equal(evidence.pid,result.pid);assert.equal(evidence.terminalId,process.env.HC_TERMINAL_ID??null);
 const out=await readFile(evidence.logs.stdout.path),err=await readFile(evidence.logs.stderr.path);
 assert.deepEqual(out,Buffer.from([79,85,84,0,255]));assert.deepEqual(err,Buffer.from([69,82,82,0,254]));assert.ok(result.stdout.includes(out));assert.ok(result.stderr.includes(err));assert.equal(evidence.logs.stdout.sha256,createHash('sha256').update(out).digest('hex'));assert.equal(evidence.logs.stderr.sha256,createHash('sha256').update(err).digest('hex'));assert.match(await readFile(report,'utf8'),/not acceptance/);
});
test('recipe process records signal termination and retains evidence when report delivery fails',async t=>{
 const dir=await fixture(t);
 const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime'
w={'id':'w','taskId':'t','recipe':{'sha256':'source'},'recipeParameters':{}}
def fail(text): raise RuntimeError('transport unavailable')
code=m.run_recipe_process(w,[sys.executable,'-c','import os,signal;os.kill(os.getpid(),signal.SIGTERM)'],dict(os.environ),runtime,{},reporter=fail)
assert code==-signal.SIGTERM
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const evidence=JSON.parse(await readFile(join(dir,'runtime/recipe-result.json')));assert.deepEqual(evidence.exit,{code:null,signal:'SIGTERM'});assert.equal(evidence.reportDelivery.error,'RuntimeError');assert.equal(evidence.accepted,false);
});
test('recipe launcher selects real run, preserves provider and params, and rejects changed frozen files',async t=>{
 const dir=await fixture(t),project=join(dir,'project');await mkdir(project);
 const profile={goose:'/fixture/goose',model:'selected',endpoint:'https://modal.invalid/v1',credentialFile:join(dir,'missing-key')};const profileFile=join(dir,'profile.json');await writeFile(profileFile,JSON.stringify(profile));
 const recipe=recipeBundle({id:'recipe',files:[{path:'recipe.yaml',content:'title: Check\ndescription: Real native recipe\nprompt: "Check {{ topic }}"\nparameters:\n- key: topic\n  input_type: string\n  requirement: required\n  description: Task\n'}]});
 const worker={version:1,id:'w',taskId:'t',name:'Recipe',role:'goose',project,stateDir:join(dir,'worker'),hc:'/fixture/hc',node:process.execPath,profileFile,packageRoot:root,mailbox:'task',recipe,recipeParameters:{topic:'literal "quoted"\nvalue'}};
 const prepared=await prepareWorker(worker);
 const program=preamble+`p,w,c=m.load_configuration(sys.argv[2]);r,e,policy,cmd=m.prepare_native_state(p,w,c,{'PATH':'/usr/bin:/bin','HOME':os.environ['HOME'],'HC_TERMINAL_ID':'t9'});m.verify_recipe_files(w);print(json.dumps({'argv':cmd,'env':e,'policy':policy.read_text()}))`;
 const plan=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,prepared.configFile],{encoding:'utf8'});assert.equal(plan.status,0,plan.stderr);const data=JSON.parse(plan.stdout);
 assert.deepEqual(data.argv.slice(0,2),['/fixture/goose','run']);assert.ok(data.argv.includes('--recipe'));assert.ok(data.argv.includes('topic=literal "quoted"\nvalue'));assert.ok(!data.argv.includes('--max-turns'));assert.ok(!data.argv.includes('--interactive'));assert.equal(data.env.GOOSE_MODEL,'selected');assert.equal(data.env.GOOSE_PROVIDER,'openai');assert.equal(data.env.OPENAI_API_KEY,undefined);assert.ok(!data.argv.includes('--system'),'Goose rejects combining --recipe and --system');
 await chmod(join(worker.stateDir,'recipe/recipe.yaml'),0o600);await writeFile(join(worker.stateDir,'recipe/recipe.yaml'),'changed');const changed=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,prepared.configFile],{encoding:'utf8'});assert.notEqual(changed.status,0);assert.match(changed.stderr,/Frozen recipe content changed/);
});
test('software gate waits without starting recipe and binds exact assignment identity',async t=>{
 const dir=await fixture(t);const program=preamble+`
w={'id':'w','taskId':'t','stateDir':sys.argv[2],'recipe':{'sha256':'digest'}}
def publish():
 time.sleep(0.15)
 m.atomic_json(pathlib.Path(sys.argv[2])/'recipe-start.json',{'version':1,'workerId':'w','taskId':'t','recipeSha256':'digest','payload':{'instruction':'Task'}})
threading.Thread(target=publish).start()
start=time.monotonic();a=m.await_recipe_assignment(w);assert time.monotonic()-start>=0.1;assert a['payload']['instruction']=='Task'
w['id']='wrong'
try: m.await_recipe_assignment(w)
except ValueError as e: assert 'identity mismatch' in str(e)
else: raise AssertionError('wrong identity released')
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/waiting for its persisted assignment/);
});
test('termination sent to the recipe launcher reaches only its native child and leaves signal evidence',async t=>{
 const dir=await fixture(t);const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime'
w={'id':'w','taskId':'t','recipe':{'sha256':'source'},'recipeParameters':{}}
# Synchronize with the child's readiness file, then signal this launcher.
ready=runtime/'ready'
def terminate():
 while not ready.exists(): time.sleep(0.01)
 os.kill(os.getpid(),signal.SIGTERM)
threading.Thread(target=terminate).start()
code=m.run_recipe_process(w,[sys.executable,'-c','import pathlib,signal,sys;pathlib.Path(sys.argv[1]).write_text("ready");signal.pause()',str(ready)],dict(os.environ),runtime,{},reporter=lambda text:0)
assert code==-signal.SIGTERM
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
 const evidence=JSON.parse(await readFile(join(dir,'runtime/recipe-result.json')));assert.deepEqual(evidence.exit,{code:null,signal:'SIGTERM'});
});
test('parent-owned recipe logs ignore runtime symlinks and new receipts cannot be supplied by the child',async t=>{
 const dir=await fixture(t);const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime';outside=pathlib.Path(sys.argv[2])/'outside.txt';outside.write_text('PRESERVE')
(runtime/'recipe-stdout.log').symlink_to(outside)
w={'id':'w','taskId':'t','recipe':{'sha256':'source'},'recipeParameters':{},'executionReceiptVersion':1}
code=m.run_recipe_process(w,[sys.executable,'-c','import sys;sys.stdout.write("REAL OUTPUT")'],dict(os.environ),runtime,{},reporter=lambda text:0)
assert code==0;assert outside.read_text()=='PRESERVE';assert (runtime/'recipe-stdout.log').is_symlink()
receipt=json.loads((runtime.parent/'execution/recipe-result.json').read_text())
assert pathlib.Path(receipt['logs']['stdout']['path']).parent==runtime.parent/'execution'
assert pathlib.Path(receipt['logs']['stdout']['path']).read_text()=='REAL OUTPUT'
assert not (runtime/'recipe-result.json').exists()
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('preexisting protected log symlinks are rejected before child creation without touching targets',async t=>{
 const dir=await fixture(t);const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime';outside=pathlib.Path(sys.argv[2])/'outside.txt';outside.write_text('PRESERVE')
execution=runtime.parent/'execution';execution.mkdir();(execution/'recipe-stdout.log').symlink_to(outside)
w={'id':'w','taskId':'t','recipe':{'sha256':'source'},'recipeParameters':{},'executionReceiptVersion':1}
marker=runtime/'started'
try: m.run_recipe_process(w,[sys.executable,'-c','import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("started")',str(marker)],dict(os.environ),runtime,{},reporter=lambda text:0)
except FileExistsError: pass
else: raise AssertionError('followed or replaced existing output')
assert outside.read_text()=='PRESERVE';assert not marker.exists();assert (execution/'recipe-stdout.log').is_symlink()
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('atomic receipt writes reject both live and dangling symlinks without changing their target',async t=>{
 const dir=await fixture(t);const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime';outside=runtime.parent/'outside.txt';outside.write_text('PRESERVE')
for name,target in [('live',outside),('dangling',runtime.parent/'missing')]:
 receipt=runtime/(name+'.json');receipt.symlink_to(target)
 try: m.atomic_json(receipt,{'forged':False})
 except ValueError: pass
 else: raise AssertionError('accepted symlink receipt')
 assert receipt.is_symlink()
assert outside.read_text()=='PRESERVE';assert not (runtime.parent/'missing').exists()
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('native recipe logs bound retained bytes while hashing and displaying the entire stream',async t=>{
 const dir=await fixture(t),size=1024*1024+4096;const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime'
w={'id':'w','taskId':'t','recipe':{'sha256':'source'},'recipeParameters':{},'executionReceiptVersion':1}
code=m.run_recipe_process(w,[sys.executable,'-c','import os;os.write(1,b"x"*${size})'],dict(os.environ),runtime,{},reporter=lambda text:0)
assert code==0
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{maxBuffer:3*1024*1024});assert.equal(result.status,0,result.stderr.toString());
 const receipt=JSON.parse(await readFile(join(dir,'execution/recipe-result.json'),'utf8')),log=receipt.logs.stdout;assert.equal(log.bytes,size);assert.equal(log.retained,1024*1024);assert.equal(log.truncated,true);assert.equal((await readFile(log.path)).length,1024*1024);assert.equal(log.sha256,createHash('sha256').update(Buffer.alloc(size,'x')).digest('hex'));assert.ok(result.stdout.subarray(0,size).equals(Buffer.alloc(size,'x')));
});
test('software recipe exit metadata is informational and excludes provider credentials',async t=>{
 const dir=await fixture(t);const program=preamble+`
runtime=pathlib.Path(sys.argv[2])/'runtime';package=runtime.parent/'package';(package/'src').mkdir(parents=True)
record=runtime.parent/'delivery.json'
(package/'src/message-cli.mjs').write_text('import json,os,pathlib,sys\\nassert "OPENAI_API_KEY" not in os.environ\\npathlib.Path('+repr(str(record))+').write_text(json.dumps(sys.argv[1:]))\\n')
w={'id':'w','taskId':'t','recipe':{'sha256':'source'},'recipeParameters':{},'executionReceiptVersion':1,'node':sys.executable,'packageRoot':str(package)}
env=dict(os.environ);env['OPENAI_API_KEY']='must-not-propagate'
assert m.run_recipe_process(w,[sys.executable,'-c','print("done")'],env,runtime,{})==0
args=json.loads(record.read_text());assert args[args.index('--kind')+1]=='progress';assert args[args.index('--idempotency-key')+1]=='native-recipe-exit-v1'
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',program,launcher,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
