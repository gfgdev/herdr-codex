import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync,renameSync,realpathSync,statSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runtimeCheckCommand} from './runtime-checks.mjs';

const execute=promisify(execFile),MAX_OUTPUT=8*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const digest=value=>hash(JSON.stringify(sorted(value)));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;

// These are integration contracts, never an allowlist for native execution.
export const REQUIRED_CORE_METHODS={
  'events.subscribe':[], 'terminal.get':['terminal'], 'terminal.read':['terminal','lines'],
  'terminal.run':['argv','cwd','env','labels','wait'], 'terminal.list':['all','labels'],
  'terminal.send':['terminal','text','wait'], 'terminal.wait':['terminal','timeout'],
  'terminal.interrupt':['terminal','timeout'], 'terminal.label':['terminal','labels'],
  'doc.get':['name'], 'doc.set':['name','version','value'],
};
export const REQUIRED_APP_COMMANDS=['space.new','space.select','tab.new','tab.move','tab.select','terminal.keep'];
export const BRIDGE_EVENTS=['doc','finished','status','turn','lost','restarted','removed'];
export const BRIDGE_NOTIFICATIONS=['event','heartbeat','missed'];

async function defaultProbe(executable,args){
  try{return (await execute(executable,args,{encoding:'utf8',timeout:15000,maxBuffer:MAX_OUTPUT})).stdout;}
  catch(error){throw new Error(`Native capability probe failed: ${args.join(' ')} (${error.code??error.signal??'failed'}). Native commands remain available.`,{cause:error});}
}
function executableIdentity(path){
  if(typeof path!=='string'||!isAbsolute(path))throw new Error('Capability discovery requires absolute executable paths');
  const resolved=realpathSync(path),stat=statSync(resolved);
  if(!stat.isFile())throw new Error('Capability executable must be a regular file');
  return {path,resolved,sha256:hash(readFileSync(resolved)),bytes:stat.size};
}
function parse(raw,label){
  let value;try{value=JSON.parse(raw);}catch{throw new Error(`Malformed native ${label}: expected JSON; previous catalog was retained`);}
  return value;
}
function namedEntries(values,label){
  if(!Array.isArray(values)||!values.length)throw new Error(`Malformed native ${label}: expected nonempty named entries`);
  const seen=new Set();
  for(const entry of values){
    if(!object(entry)||!text(entry.name)||seen.has(entry.name))throw new Error(`Malformed native ${label}: missing or duplicate name`);
    seen.add(entry.name);
  }
  return values;
}
function referencedSchemas(schema,value){
  const found={},seen=new Set();
  const walk=item=>{
    if(!item||typeof item!=='object')return;
    if(typeof item.$ref==='string'&&item.$ref.startsWith('#/components/schemas/')){
      const name=item.$ref.slice('#/components/schemas/'.length);
      if(!seen.has(name)){
        seen.add(name);const referenced=schema.components?.schemas?.[name];
        if(referenced===undefined)throw new Error(`Malformed native schema: unresolved local reference ${name}`);
        found[name]=referenced;walk(referenced);
      }
    }
    for(const child of Object.values(item))walk(child);
  };walk(value);return found;
}
function catalogEntries(schema,commands,documents){
  if(!object(schema)||!text(schema.openrpc)||!object(schema.info))throw new Error('Malformed native schema: expected OpenRPC identity');
  const methods=namedEntries(schema.methods,'schema methods');
  const entries=methods.map(method=>{
    if(!Array.isArray(method.params)||!object(method.result)||!Object.hasOwn(method.result,'schema')||
      method.params.some(param=>!object(param)||!text(param.name)||!Object.hasOwn(param,'schema'))||
      new Set(method.params.map(param=>param.name)).size!==method.params.length)
      throw new Error(`Malformed native method ${method.name}: expected named params and result schema`);
    const definition={method,schemas:referencedSchemas(schema,method)};
    return {id:'core:'+method.name,kind:'core-method',name:method.name,
      description:method.description??method.summary??'',revision:digest(definition),definition};
  });
  for(const command of namedEntries(commands,'desktop commands')){
    if(!Array.isArray(command.args)||command.args.some(arg=>!object(arg)||!text(arg.name)||typeof arg.required!=='boolean'))
      throw new Error(`Malformed native desktop command ${command.name}: expected arguments`);
    entries.push({id:'app:'+command.name,kind:'app-command',name:command.name,
      description:command.about??command.description??'',revision:digest(command),definition:command});
  }
  for(const [id,content] of Object.entries(documents))entries.push({id,kind:'native-guide',name:id,
    description:content.slice(0,180),revision:hash(content),definition:{text:content}});
  return entries.sort((a,b)=>a.id.localeCompare(b.id));
}
export function compareCatalogs(previous,next){
  const a=new Map((previous?.entries??[]).map(entry=>[entry.id,entry])),b=new Map(next.entries.map(entry=>[entry.id,entry]));
  return {fromRevision:previous?.revision??null,toRevision:next.revision,
    added:[...b.keys()].filter(id=>!a.has(id)),removed:[...a.keys()].filter(id=>!b.has(id)),
    changed:[...b.keys()].filter(id=>a.has(id)&&a.get(id).revision!==b.get(id).revision)};
}
export function compatibilityReport(snapshot,{baseline}={}){
  const methods=new Map(snapshot.schema.methods.map(method=>[method.name,method]));
  const commands=new Set(snapshot.commands.map(command=>command.name));
  const missing=[],review=[];
  for(const [name,params] of Object.entries(REQUIRED_CORE_METHODS)){
    const method=methods.get(name);
    if(!method){missing.push({kind:'method',name});continue;}
    for(const param of params)if(!method.params.some(p=>p.name===param))missing.push({kind:'parameter',name:name+'.'+param});
  }
  for(const name of REQUIRED_APP_COMMANDS)if(!commands.has(name))missing.push({kind:'command',name});
  // These result properties are read by wake, mailbox, and identity handling.
  const resultFields={Terminal:['address','cwd','state','labels','pid','status','turn'],SubscribeResult:['seq','terminals'],DocGetResult:['version','value']};
  for(const [name,properties] of Object.entries(resultFields)){
    const definition=snapshot.schema.components?.schemas?.[name];
    for(const property of properties)if(!Object.hasOwn(definition?.properties??{},property))missing.push({kind:'result-field',name:name+'.'+property});
  }
  const diff=baseline?compareCatalogs(baseline,snapshot):null;
  const requiredIds=new Set([...Object.keys(REQUIRED_CORE_METHODS).map(name=>'core:'+name),...REQUIRED_APP_COMMANDS.map(name=>'app:'+name)]);
  if(diff)for(const id of diff.changed.filter(id=>requiredIds.has(id)))review.push({kind:'changed-contract',id});
  if(baseline&&digest(baseline.schema.notifications??null)!==digest(snapshot.schema.notifications??null))
    review.push({kind:'changed-notification-schema',id:'core:notifications'});
  // Current upstream schemas describe event notifications in prose. Preserve
  // and compare that text, but never treat a regex match as a tested protocol.
  const eventContract=methods.get('events.subscribe');
  return {status:missing.length?'incompatible':review.length?'review-required':'requirements-present',
    missing,review,behavior:'not-verified',activationRecommended:false,
    requiredNotifications:BRIDGE_NOTIFICATIONS,requiredEvents:BRIDGE_EVENTS,
    eventContract:{source:'core:events.subscribe',description:eventContract?.description??null,
      machineReadableNotificationSchema:!!snapshot.schema.notifications,
      note:'Native schema discovery does not prove event delivery, recovery, or a Codex host wake.'},
    requiredBehaviorChecks:['native-forwarding','worker-adoption','child-discovery','event-and-recovery','duplicate-delivery','codex-host-wake'],
    ...(diff?{diff}:{})};
}
function readJson(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('Capability cache is unreadable; run refresh after inspecting its path',{cause:error});}}
function saveJson(path,value){const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,path);}
function summary(snapshot){return {revision:snapshot.revision,capturedAt:snapshot.capturedAt,
  coreVersion:snapshot.runtime.core.version,appVersion:snapshot.runtime.app.version,
  counts:{methods:snapshot.schema.methods.length,commands:snapshot.commands.length,guides:Object.keys(snapshot.documents).length},
  compatibility:snapshot.compatibility,change:snapshot.change,
  nativeAccess:'unrestricted-by-catalog',identityCoverage:snapshot.identityCoverage};}

export class NativeCapabilities {
  constructor({config,probe=defaultProbe,now=()=>new Date().toISOString(),qualificationStatus=runtimeCheckCommand}){
    this.config=config;this.probe=probe;this.now=now;this.directory=join(config.stateDir,'capabilities');this.qualificationStatus=qualificationStatus;
  }
  async discover({hc=this.config.hc,app=this.config.app,nativeExecutables=this.config.nativeExecutables??{}}={}){
    const launchers={core:executableIdentity(hc),app:executableIdentity(app)};
    const binaries={};for(const key of ['core','app'])if(nativeExecutables[key])binaries[key]=executableIdentity(nativeExecutables[key]);
    const requests=[['core.version',hc,'--version'],['app.version',app,'--version'],
      ['core:help',hc,'--help'],['core:skill',hc,'--skill'],['app:help',app,'--help'],['app:skill',app,'--skill'],
      ['schema',hc,'schema'],['commands',app,'commands']];
    const values=Object.fromEntries(await Promise.all(requests.map(async([key,exe,arg])=>{
      const output=await this.probe(exe,[arg]);
      if(!text(output)||Buffer.byteLength(output)>MAX_OUTPUT)throw new Error(`Malformed native ${key}: empty or oversized output`);
      return [key,output];
    })));
    const schema=parse(values.schema,'schema'),commandValue=parse(values.commands,'commands');
    const commands=Array.isArray(commandValue)?commandValue:commandValue?.commands;
    const documents=Object.fromEntries(['core:help','core:skill','app:help','app:skill'].map(key=>[key,values[key]]));
    const entries=catalogEntries(schema,commands,documents);
    const runtime={core:{launcher:launchers.core,version:values['core.version'].trim(),...(binaries.core?{binary:binaries.core}:{})},
      app:{launcher:launchers.app,version:values['app.version'].trim(),...(binaries.app?{binary:binaries.app}:{})}};
    // Re-probe the small, native inventories on each explicit catalog access.
    // This detects same-version changes behind a launcher without guessing at
    // shell source or reading a model profile/environment for executable paths.
    const revision=digest({format:1,runtime,schema,commands,documents});
    return {format:1,revision,capturedAt:this.now(),runtime,schema,commands,documents,entries,
      identityCoverage:{launcherHashes:true,explicitBinaryHashes:Object.keys(binaries),
        inventoryHashes:true,note:'For launcher scripts, nativeExecutables.core/app can identify underlying binaries. Without those paths, same-version binary changes are detected only when reported inventories change.'}};
  }
  async inspect({force=false}={}){
    const previous=readJson(join(this.directory,'current.json'));
    const candidate=await this.discover();
    // Every inspection already probes the source; force must not erase an
    // unresolved changed-contract finding merely by refreshing the same build.
    if(previous?.revision===candidate.revision)return previous;
    const baseline=previous;
    candidate.change=compareCatalogs(baseline,candidate);
    candidate.compatibility=compatibilityReport(candidate,{baseline});
    if(previous?.compatibility?.review?.length){
      const review=new Map([...previous.compatibility.review,...candidate.compatibility.review].map(item=>[item.id,item]));
      candidate.compatibility.review=[...review.values()];
      if(candidate.compatibility.status!=='incompatible')candidate.compatibility.status='review-required';
    }
    mkdirSync(join(this.directory,'revisions'),{recursive:true,mode:0o700});
    saveJson(join(this.directory,'revisions',candidate.revision+'.json'),candidate);
    saveJson(join(this.directory,'current.json'),candidate);
    return candidate;
  }
  async report(snapshot){
    let qualification;
    const binary=snapshot.runtime.core.binary;
    if(!binary)qualification={status:'unbound',passed:false,note:'Set nativeExecutables.core to bind local-core qualification to this selected runtime.'};
    else {
      try{
        const result=await this.qualificationStatus({action:'status',values:{'core-binary':binary.path},config:this.config});
        qualification={status:result.status,passed:result.passed===true,stale:result.stale,
          reasons:result.reasons,reportPath:result.reportPath,note:result.note,
          checks:result.report?.checks?.map(check=>({id:check.id,passed:check.passed,evidence:check.summary}))};
      }catch(error){qualification={status:'unavailable',passed:false,note:'Qualification receipt could not be verified: '+error.message};}
    }
    return {...summary(snapshot),qualification,compatibility:{...snapshot.compatibility,
      behavior:qualification.passed?'local-core-fixtures-passed':'not-verified',
      behaviorScope:{localCore:qualification.passed?'verified':'not-verified',desktop:'not-verified',remote:'not-verified',actualCodexHostWake:'not-verified'}}};
  }
  async status(options){return this.report(await this.inspect(options));}
  async search(query='',{limit=20}={}){
    if(typeof query!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid capability search query or limit');
    const snapshot=await this.inspect(),words=query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched=snapshot.entries.filter(entry=>words.every(word=>(entry.id+' '+entry.description+' '+JSON.stringify(entry.definition)).toLowerCase().includes(word)));
    return {revision:snapshot.revision,total:matched.length,results:matched.slice(0,limit).map(({definition,...entry})=>entry)};
  }
  async describe(id,{revision}={}){
    const snapshot=await this.inspect();
    if(revision&&revision!==snapshot.revision)return {revision:snapshot.revision,stale:true,requestedRevision:revision,note:'Catalog changed; search or describe again using the current revision.'};
    const entry=snapshot.entries.find(value=>value.id===id);
    if(!entry)return {revision:snapshot.revision,available:false,id,note:'Absent from this installed inventory. Native CLI help remains authoritative for other entry points.'};
    return {revision:snapshot.revision,available:true,...entry};
  }
  async check({hc,app,nativeExecutables={}}={}){
    if(!hc||!app)throw new Error('Candidate check requires explicit hc and app executables');
    const baseline=await this.inspect(),candidate=await this.discover({hc,app,nativeExecutables});
    candidate.change=compareCatalogs(baseline,candidate);candidate.compatibility=compatibilityReport(candidate,{baseline});
    const directory=join(this.directory,'candidates');mkdirSync(directory,{recursive:true,mode:0o700});
    saveJson(join(directory,candidate.revision+'.json'),candidate);
    return {...await this.report(candidate),baselineRevision:baseline.revision,candidate:true,activated:false,
      note:'Discovery only. No install, update, restart, worker launch, runtime switch, or host notification was requested. Run behavioral tests in an isolated candidate session before activation.'};
  }
}

export async function capabilityCommand({action,values={},config,probe}){
  const catalog=new NativeCapabilities({config,...(probe?{probe}:{})});
  if(action==='status')return catalog.status();
  if(action==='refresh')return catalog.status({force:true});
  if(action==='search')return catalog.search(values.query??values.text??'',{limit:values.limit===undefined?20:Number(values.limit)});
  if(action==='describe')return catalog.describe(values.id,{revision:values.revision});
  if(action==='check')return catalog.check({hc:values['candidate-hc'],app:values['candidate-app'],
    nativeExecutables:{...(values['candidate-core-binary']?{core:values['candidate-core-binary']}:{}),...(values['candidate-app-binary']?{app:values['candidate-app-binary']}:{})}});
  throw new Error('Use capabilities status|refresh|search|describe|check');
}
