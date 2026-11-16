import {accessSync,constants,readFileSync,writeFileSync,mkdirSync,realpathSync,statSync,lstatSync,readdirSync,renameSync,openSync,writeSync,closeSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const HARNESS=[
  {id:'wakes',file:'test-native-wakes.mjs',summary:'native-wakes-summary.json',args:[]},
  {id:'delegation',file:'test-native-delegation.mjs',summary:'summary.json',args:['--desks']},
  {id:'adoption',file:'test-native-adoption.mjs',summary:'summary.json',args:[]},
  {id:'desk-runtime',file:'test-desk-runtime-native.mjs',summary:'desk-runtime-native-report.json',binaryArg:'--core-binary',args:[]},
];
const MACHO=new Set(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']);
const MAX_LOG_BYTES=1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
const absolute=(value,label)=>{if(typeof value!=='string'||!isAbsolute(value)||value.includes('\0'))throw new Error('Expected absolute '+label);return resolve(value);};
const moduleRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');

/** Never accept the configured hc shell wrapper: it can override isolation
 * variables and route a supposedly isolated test into a production session. */
export function inspectCoreBinary(path,{platform=process.platform}={}) {
  if(platform!=='darwin')throw new Error('Native qualification is currently supported only on macOS');
  const canonical=realpathSync(absolute(path,'--core-binary raw executable'));
  if(!statSync(canonical).isFile())throw new Error('Expected a raw native core executable file');
  accessSync(canonical,constants.X_OK);
  const bytes=readFileSync(canonical);
  if(bytes.length<32||!MACHO.has(bytes.subarray(0,4).toString('hex')))throw new Error('Expected a raw Mach-O core binary, not an hc shell wrapper or script');
  return {path:canonical,sha256:hash(bytes),bytes:bytes.length};
}

export function qualificationSources(packageRoot=moduleRoot) {
  const root=realpathSync(packageRoot),files=[];
  const add=path=>{
    const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Qualification source must be a regular file: '+path);
    files.push({path:relative(root,path).replaceAll('\\','/'),sha256:hash(readFileSync(path))});
  };
  for(const item of HARNESS)add(join(root,'scripts',item.file));
  for(const name of readdirSync(join(root,'src')).sort())if(/\.(mjs|py)$/.test(name))add(join(root,'src',name));
  for(const name of readdirSync(join(root,'tests/fixtures')).sort())if(/^native.*\.(mjs|py)$/.test(name))add(join(root,'tests/fixtures',name));
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return {sha256:hash(JSON.stringify(files)),files};
}

/** An isolated harness only receives ordinary local process settings. Its own
 * unique session/socket setup remains authoritative; no production HC_* or
 * provider credentials are inherited. Logs are bounded without stopping work. */
export async function runQualificationHarness({node,script,args,logPath,timeoutMs=300000}) {
  const log=openSync(logPath,'wx',0o600);let retained=0,total=0,truncated=false,closed=false;
  const write=chunk=>{
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;
    if(retained<MAX_LOG_BYTES){const part=bytes.subarray(0,MAX_LOG_BYTES-retained);writeSync(log,part);retained+=part.length;}
    if(total>MAX_LOG_BYTES&&!truncated){truncated=true;writeSync(log,'\n[qualification log truncated; remaining output drained]\n');}
  };
  const env={HOME:process.env.HOME??'',USER:process.env.USER??'qualification',LOGNAME:process.env.LOGNAME??'qualification',
    PATH:`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,SHELL:'/bin/sh',TERM:'xterm-256color',TMPDIR:tmpdir()};
  const child=spawn(node,[script,...args],{env,stdio:['ignore','pipe','pipe'],detached:true});
  let timedOut=false;
  const stop=signal=>{if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
  // This watchdog covers deterministic fixture failure, never inference or a
  // production assignment. Only the newly created process group is targeted.
  const soft=setTimeout(()=>{timedOut=true;stop('SIGTERM');},timeoutMs);
  const hard=setTimeout(()=>stop('SIGKILL'),timeoutMs+5000);
  try {
    return await new Promise(resolvePromise=>{
      let spawnError;
      child.stdout.on('data',write);child.stderr.on('data',write);
      child.once('error',error=>{spawnError=error.message;write('\n'+error.message+'\n');});
      child.once('close',(code,signal)=>resolvePromise({code,signal,timedOut,...(spawnError?{error:spawnError}:{}),log:{path:logPath,totalBytes:total,retainedBytes:retained,truncated}}));
    });
  } finally {
    clearTimeout(soft);clearTimeout(hard);if(!closed){closeSync(log);closed=true;}
  }
}

function saveReport(config,out,report) {
  const reportPath=join(out,'qualification.json'),text=JSON.stringify(report,null,2)+'\n';
  writeFileSync(reportPath,text,{flag:'wx',mode:0o600});
  const dir=join(absolute(config.stateDir,'configuration stateDir'),'runtime-qualifications');mkdirSync(dir,{recursive:true,mode:0o700});
  const pointer={version:1,reportPath,sha256:hash(text)},temp=join(dir,'.latest-'+randomUUID()+'.json');
  writeFileSync(temp,JSON.stringify(pointer,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,join(dir,'latest.json'));
  return reportPath;
}

export async function runtimeCheckCommand({action,values={},config},dependencies={}) {
  const platform=dependencies.platform??process.platform;
  const inspect=dependencies.inspectBinary??(path=>inspectCoreBinary(path,{platform}));
  const sources=dependencies.sources??(()=>qualificationSources(config.packageRoot??moduleRoot));
  const run=dependencies.runner??runQualificationHarness;
  if(action==='status'){
    const pointerPath=join(absolute(config.stateDir,'configuration stateDir'),'runtime-qualifications/latest.json');
    let pointer,report;
    try{pointer=JSON.parse(readFileSync(pointerPath,'utf8'));}
    catch(error){if(error.code==='ENOENT')return {status:'unqualified',passed:false,stale:false,report:null,note:'No native qualification recorded. Native commands remain available.'};throw error;}
    const reasons=[];let bytes;
    try{bytes=readFileSync(pointer.reportPath);if(hash(bytes)!==pointer.sha256)reasons.push('qualification report changed');report=JSON.parse(bytes.toString('utf8'));}
    catch(error){return {status:'stale',passed:false,stale:true,reportPath:pointer.reportPath,reasons:['qualification report unavailable: '+error.message]};}
    try{const candidate=inspect(values['core-binary']??report.coreBinary.path);if(candidate.sha256!==report.coreBinary.sha256||candidate.path!==report.coreBinary.path)reasons.push('core executable changed');}
    catch(error){reasons.push('core executable unavailable or unsupported: '+error.message);}
    try{if(sources().sha256!==report.sources.sha256)reasons.push('integration or qualification sources changed');}
    catch(error){reasons.push('qualification sources unavailable: '+error.message);}
    for(const check of report.checks??[]){
      if(!check.summary)continue;
      try{if(hash(readFileSync(check.summary.path))!==check.summary.sha256)reasons.push(check.id+' qualification evidence changed');}
      catch(error){reasons.push(check.id+' qualification evidence unavailable: '+error.message);}
    }
    if(platform!==report.platform)reasons.push('qualification platform changed');
    return {status:reasons.length?'stale':report.passed?'qualified':'failed',passed:report.passed===true&&!reasons.length,stale:!!reasons.length,reasons,reportPath:pointer.reportPath,report,
      note:'Qualification covers this exact local core and integration sources, not remote hosts, desktop behavior, or actual Codex host wake delivery.'};
  }
  if(action!=='qualify')throw new Error('Unknown runtime operation; use qualify or status');
  if(platform!=='darwin')throw new Error('Native qualification is currently supported only on macOS');
  const coreBinary=inspect(values['core-binary']),initialSources=sources(),out=absolute(values.out,'--out new directory');
  mkdirSync(out,{recursive:false,mode:0o700});
  const report={version:1,startedAt:now(),platform,coreBinary,sources:initialSources,passed:false,noModels:true,noCodexDispatch:true,activationPerformed:false,checks:[]};
  report.execution={mode:'original-runtime-layout',relocated:false,consistency:'Raw executable identity checked before and after every harness; no external updater lock is claimed.'};
  try {
    // Herdr's macOS holders use their executable's physical bundle identity.
    // Relocating a signed raw executable can delay or break holder startup.
    // Keep the selected runtime intact; each harness still overrides every
    // session/socket/data path, and executable changes fail qualification.
    for(const harness of HARNESS){
      const binaryBefore=inspect(coreBinary.path);
      if(binaryBefore.sha256!==coreBinary.sha256||binaryBefore.path!==coreBinary.path)throw new Error('Core executable changed before '+harness.id+' qualification');
      if(sources().sha256!==initialSources.sha256)throw new Error('Integration or qualification sources changed during qualification');
      const dir=join(out,harness.id),logPath=join(out,harness.id+'.log'),script=join(config.packageRoot??moduleRoot,'scripts',harness.file);
      const check={id:harness.id,script,logPath,binaryBefore,passed:false};report.checks.push(check);
      const result=await run({node:config.node??process.execPath,script,args:[harness.binaryArg??'--hc-binary',coreBinary.path,'--out',dir,...harness.args],logPath});
      check.result=result;
      check.binaryAfter=inspect(coreBinary.path);
      if(check.binaryAfter.sha256!==coreBinary.sha256||check.binaryAfter.path!==coreBinary.path)throw new Error('Core executable changed during '+harness.id+' qualification');
      if(result.code!==0||result.signal||result.timedOut||result.error)throw new Error(harness.id+' harness did not exit successfully');
      const summaryPath=join(dir,harness.summary),summaryBytes=readFileSync(summaryPath),summary=JSON.parse(summaryBytes.toString('utf8'));
      check.summary={path:summaryPath,sha256:hash(summaryBytes),checks:summary.checks?.length??0};
      if(summary.passed!==true||summary.noModels!==true||summary.noCodexDispatch!==true||!Array.isArray(summary.checks)||!summary.checks.length||summary.checks.some(c=>c.passed!==true))throw new Error(harness.id+' harness summary does not confirm all checks passed without models or Codex dispatch');
      const exit=summary.coreExit??summary.core?.exit;
      if(!exit||exit.error||exit.code!==0||exit.signal||!Array.isArray(summary.cleanup)||
        !summary.cleanup.includes('isolated core stop requested')||harness.id==='desk-runtime'&&!summary.cleanup.includes('isolated bridge stopped')||summary.cleanup.some(item=>!['bridge stopped','isolated core stop requested',...(harness.id==='desk-runtime'?['isolated bridge stopped']:[])].includes(item)))
        throw new Error(harness.id+' harness did not confirm clean isolated-core shutdown');
      check.cleanup={confirmed:true,coreExit:exit};
      check.passed=true;
    }
    const after=inspect(coreBinary.path);report.coreBinaryAfter=after;
    if(after.sha256!==coreBinary.sha256||after.path!==coreBinary.path)throw new Error('Core executable changed during qualification');
    const afterSources=sources();if(afterSources.sha256!==initialSources.sha256)throw new Error('Integration or qualification sources changed during qualification');
    report.passed=true;
  } catch(error){report.error=error.message;}
  report.finishedAt=now();const reportPath=saveReport(config,out,report);
  return {status:report.passed?'qualified':'failed',passed:report.passed,reportPath,report,
    note:'No runtime was activated. This local-core fixture qualification does not qualify remote hosts, desktop behavior, or actual Codex host wake delivery.'};
}
