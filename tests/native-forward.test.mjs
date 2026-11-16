import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseIntegrationArgs} from '../src/native-forward.mjs';

const moduleURL=new URL('../src/native-forward.mjs',import.meta.url).href;
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'herdr native forwarding ')),runner=join(root,'runner.mjs'),child=join(root,'native.mjs');
  writeFileSync(runner,`import {parseIntegrationArgs,forwardNative,exitLikeNative} from ${JSON.stringify(moduleURL)};\nconst parsed=parseIntegrationArgs(process.argv.slice(2));\nconst result=await forwardNative(process.execPath,[${JSON.stringify(child)},...parsed.nativeArgs]);\nexitLikeNative(result);\n`);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=value=>writeFileSync(child,value);
  const run=(args,options={})=>spawnSync(process.execPath,[runner,...args],{timeout:5000,...options});
  return {root,runner,child,source,run};
}

test('native and app preserve every subsequent argument including config and separators',()=>{
  for(const command of ['native','app']){
    const nativeArgs=['--','future-command','--config','/native/config','--future=yes','line one\nline two','',"quote'\"$()`"];
    const original=[command,...nativeArgs],parsed=parseIntegrationArgs(original,{configPath:'/integration/default'});
    assert.deepEqual(parsed.nativeArgs,nativeArgs);assert.equal(parsed.configPath,'/integration/default');assert.deepEqual(original,[command,...nativeArgs]);
    const prefixed=parseIntegrationArgs(['--config','/integration/explicit',...original]);
    assert.equal(prefixed.configPath,'/integration/explicit');assert.deepEqual(prefixed.nativeArgs,nativeArgs);
    const inline=parseIntegrationArgs(['--config=/integration/inline',...original]);
    assert.equal(inline.configPath,'/integration/inline');assert.deepEqual(inline.nativeArgs,nativeArgs);
  }
});

test('managed commands retain trailing integration config and reject ambiguous prefixes',()=>{
  const result=parseIntegrationArgs(['desk','list','--config','/integration/legacy']);
  assert.deepEqual(result.args,['desk','list']);assert.equal(result.command,'desk');assert.equal(result.action,'list');assert.deepEqual(result.tail,[]);
  assert.equal(result.configPath,'/integration/legacy');assert.equal(result.nativeArgs,undefined);
  for(const args of [['--config'],['--config='],['--config','--help'],['--config','/one','--config','/two','native']])assert.throws(()=>parseIntegrationArgs(args),/config/);
});

test('unknown future flags and multiline values reach the native subprocess byte-for-byte',t=>{
  const f=fixture(t);f.source('process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  for(const command of ['native','app']){
    const args=['--','future-command','--config','/native/config','--new-native-feature','line1\nline2',"space quote' $() ` ", ''];
    const result=f.run([command,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),args);
  }
});

test('actual CLI forwards native config and future arguments without reading them as integration configuration',t=>{
  const f=fixture(t),configPath=join(f.root,'integration.json'),stateDir=join(f.root,'state');
  f.source(`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`);chmodSync(f.child,0o700);
  writeFileSync(configPath,JSON.stringify({version:1,stateDir,hc:f.child,app:f.child,codex:'/never-run',profileFile:'/never-read',node:process.execPath}));
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  for(const command of ['native','app']){
    const args=['--','future-command','--config','/not-an-integration-config','--new-option','line one\nline two'];
    const result=spawnSync(process.execPath,[cli,command,...args],{env:{...process.env,HERDR_CODEX_CONFIG:configPath},encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),args);assert.equal(result.stderr,'');
  }
});

test('stdin, stdout and stderr preserve binary bytes and native nonzero exit status',t=>{
  const f=fixture(t);f.source("import {readFileSync,writeSync} from 'node:fs'; const input=readFileSync(0);writeSync(1,input);writeSync(2,Buffer.from([0,255,10,13]));process.exitCode=23;");
  const input=Buffer.from([0,255,128,10,13,32,34,39]),result=f.run(['native','arbitrary'],{input});
  assert.equal(result.status,23);assert.equal(result.signal,null);assert.deepEqual(result.stdout,input);assert.deepEqual(result.stderr,Buffer.from([0,255,10,13]));
});

test('native signal termination remains a signal termination of the wrapper',t=>{
  const f=fixture(t);f.source("process.kill(process.pid,'SIGTERM');");
  const result=f.run(['native']);assert.equal(result.status,null);assert.equal(result.signal,'SIGTERM');assert.equal(result.stdout.length,0);assert.equal(result.stderr.length,0);
});

test('parent-directed termination reaches only its spawned native CLI and preserves that exit',async t=>{
  const f=fixture(t),received=join(f.root,'received.txt');
  f.source(`import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(received)},'terminated');process.exit(29);});process.stdout.write('ready\\n');setInterval(()=>{},1000);`);
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const wrapper=spawn(process.execPath,[f.runner,'native'],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(wrapper.exitCode===null&&wrapper.signalCode===null)wrapper.kill('SIGKILL');if(unrelated.exitCode===null&&unrelated.signalCode===null)unrelated.kill('SIGTERM');});
  const closed=new Promise((resolve,reject)=>{wrapper.once('error',reject);wrapper.once('close',(code,signal)=>resolve({code,signal}));});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Native signal fixture did not become ready')),3000);wrapper.stdout.once('data',chunk=>{clearTimeout(timeout);assert.equal(chunk.toString(),'ready\n');resolve();});});
  wrapper.kill('SIGTERM');
  const timeout=setTimeout(()=>wrapper.kill('SIGKILL'),3000);
  try{assert.deepEqual(await closed,{code:29,signal:null});}finally{clearTimeout(timeout);}
  assert.equal(readFileSync(received,'utf8'),'terminated');assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
});

test('forwarding retains a caller-provided PTY for native interactive input',t=>{
  const f=fixture(t);f.source("import {createInterface} from 'node:readline';process.stdout.write(JSON.stringify([!!process.stdin.isTTY,!!process.stdout.isTTY,!!process.stderr.isTTY])+'\\n');createInterface({input:process.stdin}).once('line',line=>{process.stdout.write('received:'+line+'\\n');process.exit(0);});");
  const python=`import os,pty,subprocess,sys,select,time\nmaster,slave=pty.openpty()\nchild=subprocess.Popen([sys.argv[1],sys.argv[2],'native'],stdin=slave,stdout=slave,stderr=slave)\nos.close(slave)\ndata=b''\ntry:\n os.write(master,b'hello native terminal\\n')\n end=time.monotonic()+5\n while time.monotonic()<end:\n  ready,_,_=select.select([master],[],[],0.1)\n  if ready:\n   try: part=os.read(master,65536)\n   except OSError: break\n   if not part: break\n   data+=part\n  if child.poll() is not None and not ready: break\n if child.poll() is None: child.kill()\n code=child.wait(timeout=2)\n sys.stdout.buffer.write(data)\n sys.exit(code)\nfinally:\n os.close(master)\n if child.poll() is None: child.kill();child.wait()\n`;
  const result=spawnSync('python3',['-c',python,process.execPath,f.runner],{encoding:'utf8',timeout:8000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/\[true,true,true\]/);assert.match(result.stdout,/received:hello native terminal/);
});
