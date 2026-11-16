import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareWorker } from '../src/workers.mjs';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'herdr workers with spaces ')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  await mkdir(project);
  const profileFile = join(dir, 'profile.json');
  const profile = {
    model: 'selected-model', endpoint: 'https://model.example.invalid/v1',
    credentialFile: join(dir, 'credential-does-not-exist'),
    piCli: join(dir, 'native pi/cli.js'), piPackageRoot: join(dir, 'native pi'),
    goose: join(dir, 'native goose/goose'), python: '/usr/bin/python3',
  };
  await writeFile(profileFile, JSON.stringify(profile));
  const worker = {
    version: 1, id: 'worker-1', taskId: 'task-1', name: 'native Pi', role: 'pi',
    project, stateDir: join(dir, 'worker one'), hc: join(dir, 'native hc'),
    node: process.execPath, profileFile, packageRoot, mailbox: 'task-1',
    instructions: 'Implement the task and ask the manager before the first edit.',
    readPaths: [],
  };
  return { dir, worker, profile, profileFile };
}

function nativePlan(prepared, mode = 'plan') {
  const python = String.raw`
import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('worker_launch',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p,w,profile=m.load_configuration(sys.argv[2])
env={'HOME':os.environ['HOME'],'PATH':'/usr/bin:/bin','HC_TERMINAL_ID':'t42',
     'HC_SESSION':'fixture-session','HERDR_MODAL_API_KEY':'must-not-forward',
     'OPENAI_API_KEY':'must-not-forward','SECRET_FROM_MANAGER':'must-not-forward',
     'TMPDIR':'/unavailable-manager-tmp','TMP':'/unavailable-manager-tmp',
     'TEMP':'/unavailable-manager-tmp','HERDR_CODEX_SCRATCH':'/unavailable-manager-tmp'}
r,e,policy,c=m.prepare_native_state(p,w,profile,env)
print(json.dumps({'env':e,'argv':c,'policy':policy.read_text(),
                 'instructions':m.operator_instructions(w),'runtime':str(r)}))
`;
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', python,
    join(packageRoot, 'src/worker-launch.py'), prepared.configFile, mode], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('preparation is idempotent, does not launch binaries or read the credential, and preserves argv paths', async t => {
  const { worker, profileFile, profile } = await fixture(t);
  profile.python = '/missing/python not executed';
  await writeFile(profileFile, JSON.stringify(profile));
  const first = await prepareWorker(worker);
  assert.deepEqual(first.argv, [profile.python, join(packageRoot, 'src/worker-launch.py'), join(worker.stateDir, 'worker.json')]);
  assert.equal(first.cwd, await realpath(worker.project));
  assert.deepEqual(await prepareWorker(worker), first);
  const saved = JSON.parse(await readFile(first.configFile, 'utf8'));
  assert.equal(saved.profileFile, profileFile);
  assert.deepEqual(saved.writePaths, [worker.project]);
  assert.equal(first.env.HERDR_CODEX_WORKER_CONFIG, first.configFile);
  assert.ok(!JSON.stringify(first).includes('credential-does-not-exist'));
  await assert.rejects(prepareWorker({ ...worker, instructions: 'Different task' }), /already exists/);
});

test('each worker receives independent runtime state and explicit read-only scope wins over Pi default', async t => {
  const { worker, dir } = await fixture(t);
  const pi = await prepareWorker({ ...worker, writePaths: [] });
  const goose = await prepareWorker({ ...worker, id: 'worker-2', name: 'Goose', role: 'goose', stateDir: join(dir, 'worker two') });
  const piPlan = nativePlan(pi);
  const goosePlan = nativePlan(goose);
  assert.notEqual(piPlan.env.TMPDIR, goosePlan.env.TMPDIR);
  assert.notEqual(piPlan.env.GOOSE_PATH_ROOT, goosePlan.env.GOOSE_PATH_ROOT);
  for (const plan of [piPlan, goosePlan]) {
    assert.ok(plan.policy.includes('(deny file-write*)'));
    assert.ok(!plan.policy.includes(`(allow file-write* (subpath ${JSON.stringify(worker.project)}))`));
    assert.equal(plan.env.HC_TERMINAL_ID, 't42');
    assert.equal(plan.env.HC_SESSION, 'fixture-session');
    assert.equal(plan.env.OPENAI_API_KEY, undefined);
    assert.equal(plan.env.HERDR_MODAL_API_KEY, undefined);
    assert.equal(plan.env.SECRET_FROM_MANAGER, undefined);
  }
});

test('explicit authorized writer paths work for Goose without widening unrelated project writes', async t => {
  const { worker } = await fixture(t);
  const docs = join(worker.project, 'docs');
  await mkdir(docs);
  const prepared = await prepareWorker({ ...worker, role: 'goose', writePaths: [docs] });
  const plan = nativePlan(prepared);
  assert.ok(plan.policy.includes(`(allow file-write* (subpath ${JSON.stringify(docs)}))`));
  assert.ok(!plan.policy.includes(`(allow file-write* (subpath ${JSON.stringify(worker.project)}))`));
  assert.equal(plan.env.GOOSE_MODEL, 'selected-model');
  assert.equal(plan.env.OPENAI_HOST, 'https://model.example.invalid');
  assert.equal(plan.env.OPENAI_BASE_PATH, 'v1/chat/completions');
  const hooks = JSON.parse(await readFile(join(plan.runtime, 'goose/.agents/plugins/herdr-core-status/hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
});

test('temporary-file APIs use private scratch and the documented mktemp command survives lost temp environment', async t => {
  const { worker, dir } = await fixture(t);
  const prepared = await prepareWorker({ ...worker, role: 'goose', stateDir: join(dir, "worker's $(literal) state") });
  const plan = nativePlan(prepared);
  const scratch = join(plan.runtime, 'tmp');
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'HERDR_CODEX_SCRATCH']) assert.equal(plan.env[name], scratch);
  const probe = spawnSync('/usr/bin/python3', ['-B', '-c', String.raw`
import json,os,subprocess,tempfile
with tempfile.TemporaryDirectory() as d:
    p=subprocess.run(['/usr/bin/mktemp','-d',os.environ['HERDR_CODEX_SCRATCH']+'/probe.XXXXXXXX'],check=True,capture_output=True,text=True)
    shell_dir=p.stdout.strip()
    os.rmdir(shell_dir)
    print(json.dumps([d,shell_dir]))
`], { cwd: worker.project, env: plan.env, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  for (const file of JSON.parse(probe.stdout)) assert.ok(file.startsWith(scratch + '/'), file);

  // Execute the actual prompt example, including its quoting, with broken temp
  // defaults. This reproduces the reviewer's denied-default-temp situation.
  const setup = plan.instructions.match(/```sh\n([^\n]+)\n```/)[1];
  const fallback = spawnSync('/bin/sh', ['-c', `${setup}\nprintf '%s' "$scratch"\nprintf 'fixture' > "$scratch/-"\n`], {
    cwd: worker.project, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', TMPDIR: '/unavailable-tmp', TMP: '/unavailable-tmp', TEMP: '/unavailable-tmp' },
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.ok(fallback.stdout.startsWith(scratch + '/review.'), fallback.stdout);
  assert.equal(await readFile(join(fallback.stdout, '-'), 'utf8'), 'fixture');
  assert.match(plan.instructions, /failed setup leave that check unverified/);
  assert.match(plan.instructions, /a final echo, tail, or cleanup status is not proof/);
});

test('read-only review sandbox permits documented scratch fixtures while denying project writes', {
  skip: process.platform !== 'darwin' || process.env.HERDR_TEST_SANDBOX !== '1'
    ? 'Set HERDR_TEST_SANDBOX=1 on macOS outside an enclosing sandbox to verify the real OS policy' : false,
}, async t => {
  const { worker } = await fixture(t);
  await writeFile(join(worker.project, 'existing.txt'), 'readable');
  const plan = nativePlan(await prepareWorker({ ...worker, role: 'goose' }));
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-f', join(plan.runtime, 'worker.sb'),
    '/usr/bin/python3', '-B', '-c', String.raw`
import json,os,pathlib,tempfile,subprocess
assert pathlib.Path('existing.txt').read_text() == 'readable'
try: pathlib.Path('forbidden.txt').write_text('must fail')
except PermissionError: pass
else: raise AssertionError('read-only project became writable')
with tempfile.TemporaryDirectory() as d:
    p=pathlib.Path(d)/'-';p.write_text('fixture')
    assert p.read_text() == 'fixture'
    probe=subprocess.run(['/usr/bin/mktemp','-d',os.environ['HERDR_CODEX_SCRATCH']+'/review.XXXXXXXX'],check=True,capture_output=True,text=True)
    shell_dir=probe.stdout.strip()
    os.rmdir(shell_dir)
    print(json.dumps({'scratch':d,'shellScratch':shell_dir,'projectWriteDenied':True}))
`], { cwd: worker.project, env: plan.env, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.ok(result.scratch.startsWith(plan.env.HERDR_CODEX_SCRATCH + '/'));
  assert.ok(result.shellScratch.startsWith(plan.env.HERDR_CODEX_SCRATCH + '/'));
  assert.equal(result.projectWriteDenied, true);
});

test('concurrent task sandboxes write their own vault outputs while denying peers, shared notes and controls', {
  skip:process.platform!=='darwin'||process.env.HERDR_TEST_SANDBOX!=='1'?'Requires actual macOS sandbox':false,
},async t=>{
  const {worker,dir}=await fixture(t),stateDir=join(dir,'desk-state'),vault=join(dir,'vault');await mkdir(stateDir);await mkdir(vault);await writeFile(join(vault,'human.md'),'Human source.');
  const store=new Store(join(stateDir,'manager.sqlite'));t.after(()=>store.close());const desks=new Desks({store,config:{stateDir}});
  desks.create({id:'test',name:'Test',purpose:'Task outputs',vaultPath:vault});desks.files.scaffold('test');
  const workspaces=['alpha','beta'].map(agentId=>desks.files.workspace('test',{agentId,instruction:'Write own findings.'}));
  const plans=await Promise.all(workspaces.map(async(w,i)=>nativePlan(await prepareWorker({...worker,id:'task-'+i,stateDir:join(dir,'worker-'+i),writePaths:[w.outputs,w.evidence],readPaths:[vault]}))));
  const probe=(plan,own,peer)=>new Promise((resolve,reject)=>{
    const program=String.raw`import pathlib,sys,json
own,peer,shared,control,project=map(pathlib.Path,sys.argv[1:])
(own/'actual.md').write_text('Task output verified.\n')
assert (own/'actual.md').read_text()=='Task output verified.\n'
for denied in [peer/'forbidden.md',shared,control,project/'forbidden.md']:
    try: denied.write_text('must fail')
    except PermissionError: pass
    else: raise AssertionError('Unexpected write allowed: '+str(denied))
print(json.dumps({'ownWrite':True,'denied':4}))`;
    const child=spawn('/usr/bin/sandbox-exec',['-f',join(plan.runtime,'worker.sb'),'/usr/bin/python3','-B','-c',program,own.outputs,peer.outputs,join(vault,'human.md'),join(vault,'Desk/AGENTS.md'),worker.project],{cwd:worker.project,env:plan.env,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});
  });
  const results=await Promise.all([probe(plans[0],workspaces[0],workspaces[1]),probe(plans[1],workspaces[1],workspaces[0])]);assert.ok(results.every(r=>r.ownWrite&&r.denied===4));assert.equal(await readFile(join(vault,'human.md'),'utf8'),'Human source.');
});

test('Pi retains selected endpoint compatibility and native features', async t => {
  const { worker, profile, dir } = await fixture(t);
  await writeFile(join(dir, 'pi-models.json'), JSON.stringify({ providers: { modal: {
    baseUrl: profile.endpoint, api: 'openai-completions', apiKey: 'ignored-credential-reference',
    models: [{ id: profile.model, name: 'Selected', compat: { requiresReasoningContentOnAssistantMessages: true } }],
  } } }));
  const prepared = await prepareWorker(worker);
  const plan = nativePlan(prepared);
  assert.ok(!plan.argv.some(x => ['--no-extensions', '--no-skills', '--no-mcp', '--offline', '--print'].includes(x)));
  assert.ok(plan.argv.includes(profile.model));
  const models = JSON.parse(await readFile(join(plan.runtime, 'pi/models.json'), 'utf8'));
  assert.equal(models.providers.modal.baseUrl, profile.endpoint);
  assert.equal(models.providers.modal.apiKey, '$HERDR_MODAL_API_KEY');
  assert.equal(models.providers.modal.models[0].compat.requiresReasoningContentOnAssistantMessages, true);
  assert.match(plan.instructions, /herdr-message --kind question/);
  assert.match(plan.instructions, /finish this turn/);
});

test('helper quoting preserves identity and prose arguments without shell interpolation', async t => {
  const { worker, dir } = await fixture(t);
  const hc = join(dir, "hc ' quoted");
  // A real fake CLI records its exact arguments; preparation never executes it.
  await writeFile(hc, '#!/bin/sh\n/usr/bin/python3 -c \'import os,sys,json;print(json.dumps({"args":sys.argv[1:],"terminal":os.environ.get("HC_TERMINAL_ID")}))\' "$@"\n', { mode: 0o700 });
  const prepared = await prepareWorker({ ...worker, hc });
  const prose = 'A `literal` $(printf command) "quoted" message';
  const result = spawnSync(join(prepared.stateDir, 'bin/hc'), ['send', 't5', prose], {
    encoding: 'utf8', env: { ...process.env, HC_TERMINAL_ID: 't42' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['send', 't5', prose], terminal: 't42' });
});

test('invalid configuration fails without starting a worker', async t => {
  const { worker } = await fixture(t);
  await assert.rejects(prepareWorker({ ...worker, project: 'relative' }), /absolute/);
  await assert.rejects(prepareWorker({ ...worker, mailbox: '../bad' }), /document name/);
  await assert.rejects(prepareWorker({ ...worker, role: 'codex' }), /pi or goose/);
  await assert.rejects(prepareWorker({ ...worker, stateDir: join(worker.project, 'state') }), /outside/);
});

test('Goose status reflects actual lifecycle events and rejects arbitrary prose states', () => {
  const source = String.raw`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('status',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps([m.sequence(x) for x in ['SessionStart','UserPromptSubmit','Stop','SessionEnd']]))
try: m.sequence('assistant said done')
except KeyError: pass
else: raise AssertionError('accepted prose status')
`;
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', source, join(packageRoot, 'src/goose-status.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['idle', 'working', 'done', 'clear'].map(x => `\x1b]7501;state=${x}:app=goose\x1b\\`));
});
