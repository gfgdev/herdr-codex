import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync,statSync,symlinkSync,realpathSync} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectCoreBinary,qualificationSources,runtimeCheckCommand,runQualificationHarness} from '../src/runtime-checks.mjs';

function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'herdr qualification '))),packageRoot=join(root,'package'),stateDir=join(root,'state'),binary=join(root,'core');
  for(const path of [packageRoot,stateDir,join(packageRoot,'scripts'),join(packageRoot,'src'),join(packageRoot,'tests'),join(packageRoot,'tests/fixtures')])mkdirSync(path);
  for(const name of ['test-native-wakes.mjs','test-native-delegation.mjs','test-native-adoption.mjs','test-desk-runtime-native.mjs'])writeFileSync(join(packageRoot,'scripts',name),'// isolated fixture '+name+'\n');
  writeFileSync(join(packageRoot,'src/runtime.mjs'),'// integration version one\n');writeFileSync(join(packageRoot,'tests/fixtures/native-agent.mjs'),'// native fixture\n');
  const bytes=Buffer.alloc(64);Buffer.from('cffaedfe','hex').copy(bytes);writeFileSync(binary,bytes,{mode:0o700});
  const config={stateDir,packageRoot,node:process.execPath},calls=[],hooks={};
  const runner=async input=>{
    calls.push({...input,snapshotBytes:readFileSync(input.args[1])});const out=input.args[input.args.indexOf('--out')+1];mkdirSync(out);
    writeFileSync(input.logPath,'fixture stdout and stderr retained\n');
    const name=basename(input.script),summary=name==='test-native-wakes.mjs'?'native-wakes-summary.json':name==='test-desk-runtime-native.mjs'?'desk-runtime-native-report.json':'summary.json';
    const value={passed:true,noModels:true,noCodexDispatch:true,checks:[{name:'fixture behavior',passed:true}],coreExit:{code:0,signal:null},cleanup:[...(name==='test-desk-runtime-native.mjs'?['isolated bridge stopped']:[]),'isolated core stop requested']};
    hooks.summary?.(value,input);if(!hooks.omitSummary)writeFileSync(join(out,summary),JSON.stringify(value));
    await hooks.run?.(input);
    return hooks.result??{code:0,signal:null,timedOut:false,log:{path:input.logPath}};
  };
  const deps={runner,platform:'darwin'};
  const qualify=(out=join(root,'evidence'))=>runtimeCheckCommand({action:'qualify',values:{'core-binary':binary,out},config},deps);
  const status=values=>runtimeCheckCommand({action:'status',values,config},deps);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,packageRoot,stateDir,binary,config,calls,hooks,runner,deps,qualify,status};
}

test('qualification rejects scripts, wrappers, non-executables and unsupported platforms before launch',async t=>{
  const f=fixture(t);writeFileSync(f.binary,'#!/bin/sh\nexport HC_SESSION=production\nexec hc "$@"\n');
  await assert.rejects(f.qualify(),/raw Mach-O/);assert.equal(f.calls.length,0);assert.equal(existsSync(join(f.root,'evidence')),false);
  assert.throws(()=>inspectCoreBinary(f.binary,{platform:'linux'}),/only on macOS/);
  assert.throws(()=>inspectCoreBinary(f.root,{platform:'darwin'}),/executable file/);
  chmodSync(f.binary,0o600);assert.throws(()=>inspectCoreBinary(f.binary,{platform:'darwin'}),/permission|EACCES/i);
});

test('qualification preserves original runtime layout and records exact binary identity before and after each harness',async t=>{
  const f=fixture(t);let running=false;
  f.hooks.run=async()=>{assert.equal(running,false);running=true;await new Promise(resolve=>setTimeout(resolve,2));running=false;};
  const result=await f.qualify();assert.equal(result.passed,true);assert.equal(result.status,'qualified');assert.equal(f.calls.length,4);
  assert.deepEqual(f.calls.map(c=>basename(c.script)),['test-native-wakes.mjs','test-native-delegation.mjs','test-native-adoption.mjs','test-desk-runtime-native.mjs']);
  assert.ok(f.calls[1].args.includes('--desks'));assert.equal(f.calls[3].args[0],'--core-binary');assert.equal(f.calls[0].args[0],'--hc-binary');assert.ok(f.calls.every(c=>c.node===process.execPath));
  assert.equal(f.calls[0].args[1],f.binary);assert.ok(f.calls.every(c=>c.args[1]===f.binary));
  assert.deepEqual(f.calls[0].snapshotBytes,readFileSync(f.binary));assert.equal(existsSync(f.binary),true);assert.equal(result.report.execution.relocated,false);
  assert.equal(existsSync(join(f.root,'evidence/core-under-test')),false);
  assert.equal(new Set(f.calls.map(c=>c.args[c.args.indexOf('--out')+1])).size,4);
  assert.equal(result.report.coreBinary.sha256,result.report.coreBinaryAfter.sha256);assert.equal(result.report.activationPerformed,false);
  for(const check of result.report.checks){assert.equal(check.binaryBefore.sha256,result.report.coreBinary.sha256);assert.equal(check.binaryAfter.sha256,result.report.coreBinary.sha256);assert.equal(check.cleanup.confirmed,true);}
  assert.equal(result.report.sources.files.length,6);assert.equal(result.report.checks.length,4);
  assert.equal((statSync(result.reportPath).mode&0o777),0o600);
  const status=await f.status();assert.equal(status.status,'qualified');assert.equal(status.passed,true);assert.equal(status.stale,false);
  assert.match(status.note,/not remote hosts/);assert.match(status.note,/actual Codex host wake/);
});

test('a failed native subprocess retains logs and a failed receipt and prevents subsequent harnesses',async t=>{
  const f=fixture(t);f.hooks.result={code:4,signal:null};const result=await f.qualify();
  assert.equal(result.passed,false);assert.equal(result.status,'failed');assert.equal(f.calls.length,1);
  assert.match(result.report.error,/did not exit successfully/);assert.match(readFileSync(f.calls[0].logPath,'utf8'),/retained/);
  assert.equal(JSON.parse(readFileSync(result.reportPath)).passed,false);assert.equal((await f.status()).status,'failed');
});

test('successful exit alone cannot qualify a missing, failed, incomplete or unsafe summary',async t=>{
  for(const variant of ['missing','failed','empty','failed-check','models','host']){
    const f=fixture(t);
    if(variant==='missing')f.hooks.omitSummary=true;
    f.hooks.summary=s=>{
      if(variant==='failed')s.passed=false;if(variant==='empty')s.checks=[];if(variant==='failed-check')s.checks[0].passed=false;
      if(variant==='models')s.noModels=false;if(variant==='host')s.noCodexDispatch=false;
    };
    const result=await f.qualify();assert.equal(result.passed,false,variant);assert.equal(f.calls.length,1,variant);assert.ok(existsSync(result.reportPath));
  }
});

test('binary changes during a harness invalidate qualification and stop later launches',async t=>{
  const f=fixture(t);f.hooks.run=()=>{if(f.calls.length===1){const data=readFileSync(f.binary);data[32]=1;writeFileSync(f.binary,data);}};
  const result=await f.qualify();assert.equal(result.passed,false);assert.match(result.report.error,/changed during wakes qualification/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].snapshotBytes[32],0);
  const status=await f.status();assert.equal(status.status,'stale');assert.ok(status.reasons.includes('core executable changed'));
});

test('a raw executable replaced by a wrapper is rejected without running that wrapper',async t=>{
  const f=fixture(t);f.hooks.run=input=>writeFileSync(input.args[1],'#!/bin/sh\nexport HC_SESSION=production\nexec hc "$@"\n');
  const result=await f.qualify();assert.equal(result.passed,false);assert.equal(f.calls.length,1);assert.match(result.report.error,/raw Mach-O/);
});

test('qualification is stale when runtime sources, fixtures or the selected raw executable change',async t=>{
  const f=fixture(t);await f.qualify();
  writeFileSync(join(f.packageRoot,'src/runtime.mjs'),'// new integration behavior\n');
  let status=await f.status();assert.equal(status.passed,false);assert.equal(status.stale,true);assert.ok(status.reasons.includes('integration or qualification sources changed'));
  const replacement=join(f.root,'other-core');writeFileSync(replacement,readFileSync(f.binary),{mode:0o700});
  status=await f.status({'core-binary':replacement});assert.ok(status.reasons.includes('core executable changed'));
});

test('source changes during qualification and altered receipts cannot claim successful qualification',async t=>{
  const f=fixture(t);f.hooks.run=()=>writeFileSync(join(f.packageRoot,'tests/fixtures/native-agent.mjs'),'// changed fixture\n');
  const result=await f.qualify();assert.equal(result.passed,false);assert.match(result.report.error,/sources changed during qualification/);
  const tampered={...result.report,passed:true};writeFileSync(result.reportPath,JSON.stringify(tampered));
  const status=await f.status();assert.equal(status.status,'stale');assert.equal(status.passed,false);assert.ok(status.reasons.includes('qualification report changed'));
});

test('changed or missing harness summary invalidates an otherwise successful qualification',async t=>{
  const f=fixture(t),result=await f.qualify();writeFileSync(result.report.checks[0].summary.path,'{}');
  let status=await f.status();assert.equal(status.status,'stale');assert.ok(status.reasons.includes('wakes qualification evidence changed'));
  rmSync(result.report.checks[1].summary.path);status=await f.status();assert.equal(status.passed,false);assert.ok(status.reasons.some(reason=>reason.startsWith('delegation qualification evidence unavailable')));
});

test('uncertain harness shutdown fails qualification and retains evidence for recovery',async t=>{
  const f=fixture(t);f.hooks.summary=value=>{delete value.coreExit;};const result=await f.qualify();
  assert.equal(result.passed,false);assert.match(result.report.error,/did not confirm clean/);assert.equal(existsSync(f.calls[0].logPath),true);assert.equal(f.calls.length,1);
});

test('nonzero or signal-terminated cores cannot qualify as a clean shutdown',async t=>{
  for(const exit of [{code:1,signal:null},{code:null,signal:'SIGKILL'},{code:0,signal:'SIGTERM'}]){
    const f=fixture(t);f.hooks.summary=value=>{value.coreExit=exit;};const result=await f.qualify();
    assert.equal(result.passed,false,JSON.stringify(exit));assert.match(result.report.error,/did not confirm clean isolated-core shutdown/);
    assert.equal(f.calls.length,1);assert.equal(existsSync(f.calls[0].logPath),true);
  }
});

test('status without a receipt launches nothing, and qualification never overwrites an existing output directory',async t=>{
  const f=fixture(t);assert.equal((await f.status()).status,'unqualified');assert.equal(f.calls.length,0);
  const out=join(f.root,'existing');mkdirSync(out);writeFileSync(join(out,'human.txt'),'preserve');
  await assert.rejects(f.qualify(out),/EEXIST/);assert.equal(readFileSync(join(out,'human.txt'),'utf8'),'preserve');assert.equal(f.calls.length,0);
});

test('harness fingerprint includes integration and fixture bytes and rejects source symlinks',t=>{
  const f=fixture(t),before=qualificationSources(f.packageRoot);writeFileSync(join(f.packageRoot,'scripts/test-native-adoption.mjs'),'// changed\n');
  assert.notEqual(qualificationSources(f.packageRoot).sha256,before.sha256);
  const path=join(f.packageRoot,'src/runtime.mjs');rmSync(path);symlinkSync(f.binary,path);
  assert.throws(()=>qualificationSources(f.packageRoot),/regular file/);
});

test('runner bounds output while draining it and excludes production session/provider variables',async t=>{
  const f=fixture(t),script=join(f.root,'no-herdr-fixture.mjs'),logPath=join(f.root,'bounded.log');
  writeFileSync(script,"if(Object.keys(process.env).some(k=>/^(HC_|HERDR_|OPENAI_|ANTHROPIC_)/.test(k)))throw new Error('Unexpected inherited runtime or provider context');process.stdout.write('x'.repeat(1100000));process.stderr.write('tail');process.exitCode=17;");
  const result=await runQualificationHarness({node:process.execPath,script,args:[],logPath});
  assert.equal(result.code,17);assert.equal(result.signal,null);assert.equal(result.log.truncated,true);assert.equal(result.log.totalBytes,1100004);
  assert.ok(statSync(logPath).size<1024*1024+100);assert.match(readFileSync(logPath,'utf8').slice(-100),/log truncated/);
});


test('Desk runtime is a required fourth check with its own summary and clean bridge marker',async t=>{
  const f=fixture(t);f.hooks.summary=(summary,input)=>{if(basename(input.script)==='test-desk-runtime-native.mjs')summary.checks[0].passed=false;};
  const result=await f.qualify();assert.equal(result.passed,false);assert.equal(f.calls.length,4);assert.match(result.report.error,/desk-runtime harness summary/);assert.equal(result.report.checks[3].summary.path,join(f.root,'evidence/desk-runtime/desk-runtime-native-report.json'));
});

test('Desk runtime cleanup error cannot be mistaken for the known clean isolated bridge marker',async t=>{
  const f=fixture(t);f.hooks.summary=(summary,input)=>{if(basename(input.script)==='test-desk-runtime-native.mjs')summary.cleanup.push('bridge cleanup: unresolved worker');};
  const result=await f.qualify();assert.equal(result.passed,false);assert.equal(f.calls.length,4);assert.match(result.report.error,/desk-runtime harness did not confirm clean/);
});


test('Desk runtime requires explicit isolated bridge shutdown as well as core exit',async t=>{
  const f=fixture(t);f.hooks.summary=(summary,input)=>{if(basename(input.script)==='test-desk-runtime-native.mjs')summary.cleanup=['isolated core stop requested'];};
  const result=await f.qualify();assert.equal(result.passed,false);assert.equal(f.calls.length,4);assert.match(result.report.error,/desk-runtime harness did not confirm clean/);
});
