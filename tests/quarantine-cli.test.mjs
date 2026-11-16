import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync,chmodSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';

const CLI=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER='01a1d317-b5d9-7530-8623-f60c0df12d38';
const REASON='worker evidence version must be 1';

// The CLI publishes an immutable runtime snapshot (0o400 files, 0o500 dirs).
// Restore write permission inside the fixture's own tree before removal; the
// production immutability guarantee is untouched.
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

function seed(directory){
  const stateDir=join(directory,'state');
  mkdirSync(stateDir,{recursive:true});
  const task={id:'task-1',name:'Repair browser persistence',project:'/private/project',threadId:THREAD,status:'active'};
  const worker={id:'worker-1',taskId:task.id,name:'pi-work',role:'pi',project:task.project,terminalId:'t7',mailbox:'cx-worker-1'};
  const message={id:'m-bad',taskId:task.id,workerId:worker.id,terminalId:worker.terminalId,kind:'progress',text:'bad report',createdAt:'2026-11-13T00:00:00.000Z',turn:1};
  const store=new Store(join(stateDir,'manager.sqlite'));
  store.saveTask(task);store.saveWorker(worker);
  const archived=store.quarantine(worker,message,{code:'REPORT_INVALID',reason:REASON});
  store.close();
  return {stateDir,worker,message,archived};
}

async function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-quarantine-cli-')));
  const {stateDir,worker,message,archived}=seed(directory);
  const config={version:1,stateDir,hc:'/never/execute',app:'/never/execute',codex:'/never/execute',profileFile:'/never/execute',node:process.execPath};
  const configPath=join(directory,'config.json');writeFileSync(configPath,JSON.stringify(config));
  const run=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[CLI,'--config',configPath,...args],{cwd:directory,env:{...process.env,HERDR_CODEX_CONFIG:configPath},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('quarantine CLI fixture timed out'));},15000);
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.once('error',error=>finish(error));child.once('close',(code,signal)=>finish(null,{code,signal,stdout,stderr}));
  });
  const json=async args=>{const result=await run(args);assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);return JSON.parse(result.stdout);};
  t.after(()=>{writableTree(directory);rmSync(directory,{recursive:true,force:true});});
  return {directory,stateDir,worker,message,archived,run,json};
}

test('quarantine list shows metadata only, tagged as untrusted worker claims',async t=>{
  const f=await fixture(t),result=await f.json(['quarantine','list','--thread',THREAD]);
  assert.equal(result.threadId,THREAD);
  assert.equal(result.authority,'worker-claims');
  assert.match(result.note,/unverified worker claims/i);
  assert.equal(result.count,1);
  const entry=result.entries[0];
  assert.equal(entry.id,f.archived.id);
  assert.equal(entry.reportId,'m-bad');
  assert.equal(entry.code,'REPORT_INVALID');
  assert.equal(entry.reason,REASON);
  assert.equal(entry.bytes,f.archived.bytes);
  assert.equal(entry.sha256,f.archived.payloadSha256);
  assert.ok(!('message' in entry)&&!('data' in entry),'list must not expose the raw report');
});

test('quarantine show returns the bounded raw report for the owning chat',async t=>{
  const f=await fixture(t),result=await f.json(['quarantine','show','--id',f.archived.id,'--thread',THREAD]);
  assert.equal(result.id,f.archived.id);
  assert.equal(result.code,'REPORT_INVALID');
  assert.equal(result.reason,REASON);
  assert.equal(result.authority,'worker-claims');
  assert.match(result.note,/unverified evidence, not proof/i);
  assert.deepEqual(result.message,f.message);
});

test('quarantine show is denied for a different chat UUID',async t=>{
  const f=await fixture(t),result=await f.run(['quarantine','show','--id',f.archived.id,'--thread',OTHER]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/does not belong to this chat/);
});

test('quarantine list scopes to the requested chat and narrows by task or worker',async t=>{
  const f=await fixture(t);
  const other=await f.json(['quarantine','list','--thread',OTHER]);
  assert.equal(other.count,0);
  const narrow=await f.json(['quarantine','list','--thread',THREAD,'--task','task-1','--worker','worker-1']);
  assert.equal(narrow.count,1);
  const empty=await f.json(['quarantine','list','--thread',THREAD,'--worker','worker-x']);
  assert.equal(empty.count,0);
});

test('quarantine requires an exact chat UUID',async t=>{
  const f=await fixture(t),missing=await f.run(['quarantine','list']);
  assert.notEqual(missing.code,0);
  assert.match(missing.stderr,/Missing --thread UUID/);
  const malformed=await f.run(['quarantine','list','--thread','not-a-uuid']);
  assert.notEqual(malformed.code,0);
  assert.match(malformed.stderr,/exact existing Codex chat UUID/);
});
