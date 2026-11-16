import { mkdirSync, realpathSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { safeId, uuid, digest } from './config.mjs';
import { DeskFiles } from './desk-files.mjs';
import { RecipeLibrary } from './recipes.mjs';

const now=()=>new Date().toISOString();
const clone=v=>JSON.parse(JSON.stringify(v));
const LOCAL=new Set(['file','directory','vault','repository']);
const EXTERNAL=new Set(['mailbox','spreadsheet','url','service']);
const WORK_STATES=new Set(['planned','assigned','running','blocked','review','done','cancelled']);
const JOB_STATES=new Set(['pending','running','blocked','review','completed','failed','cancelled']);
const TERMINAL_WORK=new Set(['done','cancelled']);
const TERMINAL_JOB=new Set(['completed','failed','cancelled']);
const within=(path,root)=>path===root||path.startsWith(root+'/');
function object(v,keys,label){
  if(!v||typeof v!=='object'||Array.isArray(v))throw new TypeError(`${label} must be an object`);
  for(const key of Object.keys(v))if(!keys.includes(key))throw new TypeError(`Unknown ${label} field: ${key}`);
  return v;
}
function text(value,label,{optional=false,max=65536}={}){
  if(optional&&value===undefined)return '';
  if(typeof value!=='string'||(!optional&&!value.trim())||value.includes('\0')||Buffer.byteLength(value)>max)throw new TypeError(`Invalid ${label}`);
  return value;
}
function list(value,label,{ids=false}={}){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>200)throw new TypeError(`${label} must be an array of at most 200 entries`);
  const result=value.map(v=>ids?safeId(v,label):text(v,label,{max:8192}));
  if(new Set(result).size!==result.length)throw new TypeError(`Duplicate ${label}`);
  return result;
}
function thread(value,optional=false){
  if(optional&&value===undefined)return null;
  if(!uuid.test(value??''))throw new TypeError('Use an exact manager chat UUID');
  return value;
}
function version(value){if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Version must be a positive integer');return value;}
function parameters(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Parameters must be a JSON object');
  const seen=new Set();
  const visit=(v,depth=0)=>{if(depth>24)throw new Error('Parameters are too deeply nested');if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'&&Number.isFinite(v))return;if(typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw new Error('Parameters must contain finite JSON values without shared objects');seen.add(v);for(const [k,x] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw new Error('Reserved parameter field');visit(x,depth+1);}};
  visit(value);if(Buffer.byteLength(JSON.stringify(value))>262144)throw new Error('Parameters exceed 256 KiB');
  const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(key=>[key,sorted(v[key])])):v;return sorted(value);
}
function acyclic(items,edges,label){
  const byId=new Map(items.map(x=>[x.id,x])),done=new Set(),active=new Set();
  const visit=id=>{if(active.has(id))throw new Error(label+' contains a cycle');if(done.has(id))return;const item=byId.get(id);if(!item)throw new Error(label+' refers to an unknown member: '+id);active.add(id);for(const next of edges(item))visit(next);active.delete(id);done.add(id);};
  for(const id of byId.keys())visit(id);
}
function canonical(path,{file=false}={}){
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw new TypeError('Resource/project path must be an explicit absolute path');
  const actual=realpathSync(path),s=statSync(actual);
  if(file?!s.isFile():!s.isDirectory())throw new TypeError(file?'Expected a regular file':'Expected a directory');
  return actual;
}
function ownedDirectory(path){
  // Only the integration-owned desk subtree may be created. Never follow a
  // planted symlink while creating desk workspaces or their landing pages.
  for(let p=path;;p=dirname(p)){
    try{if(lstatSync(p).isSymbolicLink())throw new Error('Desk state paths cannot contain symbolic links');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(p)===p)break;
  }
  mkdirSync(path,{recursive:true,mode:0o700});
  if(realpathSync(path)!==resolve(path))throw new Error('Desk workspace identity changed');
}
function access(value){
  const result=list(value??['read'],'access');
  if(!result.length||result.some(v=>!['read','write'].includes(v)))throw new TypeError('Resource access must contain read and/or write');
  return result.sort();
}
function externalRef(value,kind){
  const result=text(value,'resource reference',{max:8192});
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(result)){
    const url=new URL(result);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new TypeError('External URLs must be http(s), without credentials, query strings or fragments');
  }else if(kind==='url')throw new TypeError('URL resources require an http(s) URL');
  return result;
}

/** Durable desk records are authoritative. Herdr spaces and DESK.md are views.
 * Every mutation is explicit, journaled and additive to the existing store. */
export class Desks {
  constructor({store,config}){
    this.store=store;this.db=store.db;this.config=config;this.files=new DeskFiles(this);
    this.db.exec(`CREATE TABLE IF NOT EXISTS desks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_entities(kind TEXT NOT NULL,desk_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,desk_id,id));
      CREATE TABLE IF NOT EXISTS desk_versions(kind TEXT NOT NULL,desk_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,desk_id,id,version));`);
  }
  get(id){safeId(id,'desk ID');const row=this.db.prepare('SELECT data FROM desks WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
  list(){return this.db.prepare('SELECT data FROM desks ORDER BY id').all().map(r=>JSON.parse(r.data));}
  require(id,{active=false}={}){const desk=this.get(id);if(!desk)throw new Error('Unknown desk: '+id);if(active&&desk.status!=='active')throw new Error('Desk is archived');return desk;}
  _get(kind,deskId,id){this.require(deskId);safeId(id,kind+' ID');const row=this.db.prepare('SELECT data FROM desk_entities WHERE kind=? AND desk_id=? AND id=?').get(kind,deskId,id);return row?JSON.parse(row.data):null;}
  _list(kind,deskId){this.require(deskId);return this.db.prepare('SELECT data FROM desk_entities WHERE kind=? AND desk_id=? ORDER BY id').all(kind,deskId).map(r=>JSON.parse(r.data));}
  _save(kind,value){this.db.prepare('INSERT INTO desk_entities VALUES(?,?,?,?) ON CONFLICT(kind,desk_id,id) DO UPDATE SET data=excluded.data').run(kind,value.deskId,value.id,JSON.stringify(value));return value;}
  _insert(kind,value){
    const old=this._get(kind,value.deskId,value.id);
    if(old){
      const registration=v=>{const {createdAt,updatedAt,...body}=v;if(['work','job'].includes(kind))for(const key of ['status','note','taskId','agentId'])delete body[key];if(kind==='job'&&Object.hasOwn(body,'parameters'))body.parameters=parameters(body.parameters);return body;};
      if(JSON.stringify(registration(old))!==JSON.stringify(registration(value)))throw new Error(`${kind} ID already has different registration`);return old;
    }
    const record={...value,createdAt:now(),updatedAt:now()};this._save(kind,record);this.store.journal(`desk.${kind}.created`,{deskId:value.deskId,id:value.id});return record;
  }
  create(input){
    object(input,['id','name','purpose','vaultPath'],'desk');
    const id=safeId(input.id,'desk ID'),name=text(input.name,'desk name',{max:256}),purpose=text(input.purpose,'desk purpose');
    const state=canonical(this.config.stateDir),home=join(state,'desks',id,'home');
    const vaultPath=input.vaultPath===undefined?null:canonical(input.vaultPath);
    if(vaultPath&&(within(state,vaultPath)||within(home,vaultPath)))throw new Error('Integration state must remain outside the linked vault');
    const existing=this.get(id);
    if(existing){if(existing.name!==name||existing.purpose!==purpose||existing.vaultPath!==vaultPath)throw new Error('Desk ID already has different registration; use update explicitly');return existing;}
    ownedDirectory(home);
    return this.store.transaction(()=>{
      const old=this.get(id);if(old)throw new Error('Desk was registered concurrently; inspect the existing desk');
      const desk={id,name,purpose,home,vaultPath,status:'active',createdAt:now(),updatedAt:now()};
      this.db.prepare('INSERT INTO desks VALUES(?,?)').run(id,JSON.stringify(desk));
      this.store.journal('desk.created',{deskId:id,id,home});
      this.projectAdd({deskId:id,id:'home',name:name+' workspace',path:home,description:'Private execution workspace; existing vaults remain separate resources.'});
      if(vaultPath)this.resourceAdd({deskId:id,id:'vault',name:name+' knowledge',kind:'vault',path:vaultPath,access:['read','write']});
      // A landing page is created once. Subsequent updates never overwrite the
      // owner's notes; `desk show` always reads the current registry.
      try{writeFileSync(join(home,'DESK.md'),`# ${name}\n\n${purpose}\n\nDesk ID: \`${id}\`\n\nThis is the desk's private workspace. Its authoritative registration and work history live in the Herdr integration. Existing vaults and resources are referenced, not moved. Use the desk CLI to inspect current configuration.\n`,{flag:'wx',mode:0o600});}
      catch(error){if(error.code!=='EEXIST')throw error;}
      return desk;
    });
  }
  update(id,patch){
    object(patch,['name','purpose','vaultPath','status'],'desk update');
    if(!this.compiling&&this.files.registration(id)?.enabled&&(patch.name!==undefined||patch.purpose!==undefined))return this.files.author(id,'manifest',patch);
    return this.store.transaction(()=>{
      const old=this.require(id),next={...old};
      if(patch.name!==undefined)next.name=text(patch.name,'desk name',{max:256});
      if(patch.purpose!==undefined)next.purpose=text(patch.purpose,'desk purpose');
      if(patch.status!==undefined){if(!['active','archived'].includes(patch.status))throw new Error('Desk status must be active or archived');next.status=patch.status;}
      if(next.status==='archived'&&this.store.tasks().some(t=>t.deskId===id&&t.status==='active'))throw new Error('Resolve active desk tasks before archiving');
      if(patch.vaultPath!==undefined){
        const vault=canonical(patch.vaultPath);
        if(old.vaultPath&&old.vaultPath!==vault)throw new Error('Existing vault identity cannot silently change; register a separate resource');
        if(within(canonical(this.config.stateDir),vault)||within(old.home,vault))throw new Error('Integration state must remain outside the linked vault');
        next.vaultPath=vault;
        if(!this.resource(id,'vault'))this.resourceAdd({deskId:id,id:'vault',name:next.name+' knowledge',kind:'vault',path:vault,access:['read','write']});
      }
      if(JSON.stringify(next)===JSON.stringify(old))return old;
      next.updatedAt=now();this.db.prepare('UPDATE desks SET data=? WHERE id=?').run(JSON.stringify(next),id);this.store.journal('desk.updated',{deskId:id,id,fields:Object.keys(patch)});return next;
    });
  }
  projects(deskId){return this._list('project',deskId);}
  project(deskId,id){return this._get('project',deskId,id);}
  projectAdd(input){
    object(input,['deskId','id','name','path','description'],'project');this.require(input.deskId,{active:true});
    const value={deskId:input.deskId,id:safeId(input.id,'project ID'),name:text(input.name,'project name',{max:256}),path:canonical(input.path),description:text(input.description,'project description',{optional:true})};
    return this.store.transaction(()=>this._insert('project',value));
  }
  resources(deskId){return this._list('resource',deskId);}
  resource(deskId,id){return this._get('resource',deskId,id);}
  resourceAdd(input){
    object(input,['deskId','id','name','kind','path','ref','access','description'],'resource');this.require(input.deskId,{active:true});
    if(!LOCAL.has(input.kind)&&!EXTERNAL.has(input.kind))throw new Error('Unknown resource kind');
    const local=LOCAL.has(input.kind);
    if(local?input.ref!==undefined||input.path===undefined:input.path!==undefined||input.ref===undefined)throw new Error('Use path for local resources or ref for external resources');
    const value={deskId:input.deskId,id:safeId(input.id,'resource ID'),name:text(input.name,'resource name',{max:256}),kind:input.kind,
      ...(local?{path:canonical(input.path,{file:input.kind==='file'})}:{ref:externalRef(input.ref,input.kind)}),
      access:access(input.access),connected:local,description:text(input.description,'resource description',{optional:true})};
    return this.store.transaction(()=>this._insert('resource',value));
  }
  resourceUpdate(deskId,id,patch){
    object(patch,['access'],'resource update');this.require(deskId,{active:true});
    return this.store.transaction(()=>{
      const old=this.resource(deskId,id);if(!old)throw new Error('Unknown desk resource');
      const next={...old,...(patch.access===undefined?{}:{access:access(patch.access)})};
      if(JSON.stringify(next)===JSON.stringify(old))return old;
      if(LOCAL.has(old.kind)&&canonical(old.path,{file:old.kind==='file'})!==old.path)throw new Error('Resource path identity changed');
      if(this.jobs(deskId).some(job=>!TERMINAL_JOB.has(job.status)&&job.snapshot?.workflow?.resourceIds?.includes(id)))throw new Error('Resolve unsettled desk jobs using this resource before changing its access');
      for(const worker of this.store.workers()){
        if(worker.deskId!==deskId||this.store.task(worker.taskId)?.status!=='active')continue;
        const definition=worker.deskDefinitionId?this.definition(deskId,worker.deskDefinitionId,worker.deskDefinitionVersion):null;
        const job=worker.deskJobId?this.job(deskId,worker.deskJobId):null;
        const resourceIds=job?.snapshot?.workflow?.resourceIds??definition?.resourceIds;
        // Older records may not retain a definition. Matching frozen path
        // grants conservatively identify a live user of the local resource.
        const usesResource=resourceIds?.includes(id)||LOCAL.has(old.kind)&&[...(worker.readPaths??[]),...(worker.writePaths??[])].includes(old.path);
        if(usesResource)throw new Error('Resolve active desk agents using this resource before changing its access');
      }
      next.updatedAt=now();this._save('resource',next);
      this.store.journal('desk.resource.updated',{deskId,id,beforeAccess:old.access,access:next.access});return next;
    });
  }
  _version(kind,deskId,id,v){
    this.require(deskId);safeId(id,kind+' ID');if(v!==undefined)version(v);
    const row=v===undefined?this.db.prepare('SELECT data FROM desk_versions WHERE kind=? AND desk_id=? AND id=? ORDER BY version DESC LIMIT 1').get(kind,deskId,id):this.db.prepare('SELECT data FROM desk_versions WHERE kind=? AND desk_id=? AND id=? AND version=?').get(kind,deskId,id,v);
    return row?JSON.parse(row.data):null;
  }
  _versions(kind,deskId){this.require(deskId);return this.db.prepare('SELECT data FROM desk_versions WHERE kind=? AND desk_id=? ORDER BY id,version').all(kind,deskId).map(r=>JSON.parse(r.data));}
  _versionPut(kind,value){
    return this.store.transaction(()=>{
      const prior=this._version(kind,value.deskId,value.id);
      if(prior){const {version,createdAt,hash,...body}=prior;if(JSON.stringify(body)===JSON.stringify(value))return prior;}
      const record={...value,version:(prior?.version??0)+1,createdAt:now(),hash:digest(JSON.stringify(value))};
      this.db.prepare('INSERT INTO desk_versions VALUES(?,?,?,?,?)').run(kind,value.deskId,value.id,record.version,JSON.stringify(record));this.store.journal(`desk.${kind}.versioned`,{deskId:value.deskId,id:value.id,version:record.version});return record;
    });
  }
  definition(deskId,id,v){return this._version('definition',deskId,id,v);}
  definitions(deskId){return this._versions('definition',deskId);}
  _requireDefinition(deskId,id,v){
    safeId(id,'definition ID');
    if(this.compilingDefinitionIds&&!this.compilingDefinitionIds.has(id))throw new Error('Workflow/team refers to a missing authored agent: '+id);
    const result=this.definition(deskId,id,v);if(!result)throw new Error('Unknown desk agent definition: '+id);return result;
  }
  definitionPut(input){
    object(input,['deskId','id','name','harness','scope','instructions','resourceIds','acceptance','context','writeMode','authority'],'definition');this.require(input.deskId,{active:true});
    if(!this.compiling&&this.files.registration(input.deskId)?.enabled)return this.files.author(input.deskId,'definitions',input);
    if(input.writeMode!==undefined&&!['task','project'].includes(input.writeMode))throw new Error('writeMode must be task or project');
    if(!['pi','goose'].includes(input.harness))throw new Error('Definition harness must be pi or goose');
    if(!['read-only','write'].includes(input.scope))throw new Error('Definition scope must be read-only or write');
    const id=safeId(input.id,'definition ID'),resourceIds=list(input.resourceIds,'resource ID',{ids:true});
    for(const id of resourceIds)if(!this.resource(input.deskId,id))throw new Error('Unknown resource in this desk: '+id);
    let authority;
    if(input.authority!==undefined){
      object(input.authority,['delegateRoles','reviewRoles'],'authority');
      authority={delegateRoles:list(input.authority.delegateRoles,'delegate role',{ids:true}),reviewRoles:list(input.authority.reviewRoles,'review role',{ids:true})};
      for(const role of [...authority.delegateRoles,...authority.reviewRoles]){
        if(this.compilingDefinitionIds?!this.compilingDefinitionIds.has(role):role!==id&&!this.definition(input.deskId,role))throw new Error('Authority refers to a missing desk role: '+role);
      }
    }
    return this._versionPut('definition',{deskId:input.deskId,id,name:text(input.name,'definition name',{max:256}),harness:input.harness,scope:input.scope,instructions:text(input.instructions,'instructions'),resourceIds,acceptance:list(input.acceptance,'acceptance check'),context:text(input.context,'definition context',{optional:true}),...(input.writeMode?{writeMode:input.writeMode}:{}),...(authority?{authority}:{})});
  }
  team(deskId,id,v){return this._version('team',deskId,id,v);}
  teams(deskId){return this._versions('team',deskId);}
  teamPut(input){
    object(input,['deskId','id','name','instructions','members'],'team');this.require(input.deskId,{active:true});
    if(!this.compiling&&this.files.registration(input.deskId)?.enabled)return this.files.author(input.deskId,'teams',input);
    if(!Array.isArray(input.members)||!input.members.length||input.members.length>200)throw new Error('Team needs 1–200 members');
    const definitions=new Map(),members=input.members.map(member=>{
      object(member,['id','definitionId','definitionVersion','reportsTo'],'team member');const definition=this._requireDefinition(input.deskId,member.definitionId,member.definitionVersion),id=safeId(member.id,'team member ID');definitions.set(id,definition);
      return {id,definitionId:definition.id,definitionVersion:definition.version,reportsTo:member.reportsTo==null?null:safeId(member.reportsTo,'supervisor member ID')};
    });
    if(new Set(members.map(m=>m.id)).size!==members.length)throw new Error('Duplicate team member ID');
    acyclic(members,m=>m.reportsTo?[m.reportsTo]:[],'Team reporting hierarchy');
    for(const member of members)if(member.reportsTo&&(!definitions.get(member.reportsTo).authority?.delegateRoles?.includes(member.definitionId)||!definitions.get(member.reportsTo).authority?.reviewRoles?.includes(member.definitionId)))throw new Error('Team supervisor is not authorized to delegate role: '+member.definitionId);
    return this._versionPut('team',{deskId:input.deskId,id:safeId(input.id,'team ID'),name:text(input.name,'team name',{max:256}),instructions:text(input.instructions,'team instructions',{optional:true}),members});
  }
  workflow(deskId,id,v){return this._version('workflow',deskId,id,v);}
  workflows(deskId){return this._versions('workflow',deskId);}
  workflowPut(input){
    object(input,['deskId','id','name','definitionId','definitionVersion','instructions','projectId','resourceIds','acceptance','trigger','teamId','teamVersion','steps'],'workflow');this.require(input.deskId,{active:true});
    if(!this.compiling&&this.files.registration(input.deskId)?.enabled)return this.files.author(input.deskId,'workflows',input);
    if(input.trigger!==undefined&&input.trigger!=='manual')throw new Error('Only manual workflow triggers are accepted; use separate automation definitions for scheduling');
    const projectId=input.projectId??'home';if(!this.project(input.deskId,projectId))throw new Error('Unknown desk project');
    const structured=input.steps!==undefined,definition=input.definitionId===undefined&&structured?null:this._requireDefinition(input.deskId,input.definitionId,input.definitionVersion);
    if(!definition&&input.definitionVersion!==undefined)throw new Error('definitionVersion requires definitionId');
    let team=null;
    if(input.teamId!==undefined){if(this.compilingTeamIds&&!this.compilingTeamIds.has(input.teamId))throw new Error('Workflow refers to a missing authored team');team=this.team(input.deskId,input.teamId,input.teamVersion);if(!team)throw new Error('Unknown desk team');}
    else if(input.teamVersion!==undefined)throw new Error('teamVersion requires teamId');
    let steps;const definitions=new Map();if(definition)definitions.set(definition.id+'@'+definition.version,definition);
    if(structured){
      if(!Array.isArray(input.steps)||!input.steps.length||input.steps.length>200)throw new Error('Workflow needs 1–200 steps');
      steps=input.steps.map(step=>{
        object(step,['id','kind','definitionId','definitionVersion','dependsOn','instructions','recipeId','recipeVersion','parameters','command','supervisorStepId','teamMemberId','acceptance'],'workflow step');
        if(!['agent','recipe','command','review'].includes(step.kind))throw new Error('Unknown workflow step kind');
        if(team&&step.teamMemberId===undefined)throw new Error('Team workflows require teamMemberId on every step');
        const member=step.teamMemberId===undefined?null:team?.members.find(m=>m.id===step.teamMemberId);
        if(step.teamMemberId!==undefined&&!member)throw new Error('Unknown workflow team member');
        const role=this._requireDefinition(input.deskId,step.definitionId??member?.definitionId??definition?.id,step.definitionVersion??(member?.definitionVersion??(step.definitionId?undefined:definition?.version)));
        if(member&&(member.definitionId!==role.id||member.definitionVersion!==role.version))throw new Error('Workflow step does not match its pinned team member role');
        definitions.set(role.id+'@'+role.version,role);
        if(team&&!team.members.some(m=>m.definitionId===role.id&&m.definitionVersion===role.version))throw new Error('Workflow step role/version is absent from its team');
        const normalized={id:safeId(step.id,'step ID'),kind:step.kind,definitionId:role.id,definitionVersion:role.version,dependsOn:list(step.dependsOn,'step dependency',{ids:true}),instructions:text(step.instructions,'step instructions',{optional:true}),parameters:parameters(step.parameters),acceptance:list(step.acceptance,'step acceptance')};
        if(member)normalized.teamMemberId=member.id;
        if(step.supervisorStepId!==undefined)normalized.supervisorStepId=safeId(step.supervisorStepId,'supervisor step ID');
        if(step.kind==='recipe'){
          if(role.harness!=='goose')throw new Error('Recipe steps require a Goose role');
          normalized.recipeId=safeId(step.recipeId,'recipe ID');if(step.recipeVersion!==undefined)normalized.recipeVersion=version(step.recipeVersion);
        }else if(step.recipeId!==undefined||step.recipeVersion!==undefined)throw new Error('Only recipe steps accept recipeId/recipeVersion');
        if(step.kind==='command'){
          object(step.command,['argv'],'step command');
          if(!Array.isArray(step.command.argv)||!step.command.argv.length||step.command.argv.length>200)throw new Error('Command argv must contain 1–200 strings');
          normalized.command={argv:step.command.argv.map(arg=>text(arg,'command argument',{optional:true,max:8192}))};if(!normalized.command.argv[0])throw new Error('Command executable cannot be empty');
        }else if(step.command!==undefined)throw new Error('Only command steps accept command argv');
        return normalized;
      });
      if(new Set(steps.map(s=>s.id)).size!==steps.length)throw new Error('Duplicate workflow step ID');
      for(const step of steps)if(step.teamMemberId){const member=team.members.find(m=>m.id===step.teamMemberId);if(!member.reportsTo&&step.supervisorStepId)throw new Error('Explicit supervisor conflicts with team reporting hierarchy');if(member.reportsTo){const parents=steps.filter(s=>s.teamMemberId===member.reportsTo);if(parents.length!==1)throw new Error('Team supervisor needs exactly one workflow step');if(step.supervisorStepId&&step.supervisorStepId!==parents[0].id)throw new Error('Explicit supervisor conflicts with team reporting hierarchy');step.supervisorStepId=parents[0].id;}}
      acyclic(steps,s=>s.dependsOn,'Workflow dependencies');acyclic(steps,s=>s.supervisorStepId?[s.supervisorStepId]:[],'Workflow supervision');
      const byId=new Map(steps.map(s=>[s.id,s]));
      for(const step of steps){
        if(step.supervisorStepId){const supervisor=byId.get(step.supervisorStepId),role=definitions.get(supervisor.definitionId+'@'+supervisor.definitionVersion);if(!['agent','recipe'].includes(supervisor.kind)||!role.authority?.delegateRoles?.includes(step.definitionId)||!role.authority?.reviewRoles?.includes(step.definitionId))throw new Error('Workflow supervisor is not authorized to delegate role: '+step.definitionId);}
        if(step.kind==='review'){const role=definitions.get(step.definitionId+'@'+step.definitionVersion);if(!step.dependsOn.length)throw new Error('Review steps need an explicit dependency to review');for(const dependency of step.dependsOn)if(!role.authority?.reviewRoles?.includes(byId.get(dependency).definitionId))throw new Error('Review role is not authorized to review dependency role');}
      }
    }
    const allowed=[...new Set([...definitions.values()].flatMap(d=>d.resourceIds))],resourceIds=input.resourceIds===undefined?allowed:list(input.resourceIds,'resource ID',{ids:true});
    if(resourceIds.some(id=>!allowed.includes(id)))throw new Error('Workflow cannot grant resources outside its definition roles');
    return this._versionPut('workflow',{deskId:input.deskId,id:safeId(input.id,'workflow ID'),name:text(input.name,'workflow name',{max:256}),...(definition?{definitionId:definition.id,definitionVersion:definition.version}:{}),instructions:text(input.instructions,'workflow instructions',{optional:structured}),projectId,resourceIds,acceptance:list(input.acceptance,'acceptance check'),trigger:'manual',...(team?{teamId:team.id,teamVersion:team.version}:{}),...(steps?{steps}:{})});
  }
  automation(deskId,id,v){return this._version('automation',deskId,id,v);}
  automations(deskId){return this._versions('automation',deskId);}
  automationPut(input){
    object(input,['deskId','id','name','enabled','type','workflowId','workflowVersion','ownerThread','everySeconds','startAt','eventName','overlap','catchup'],'automation');this.require(input.deskId,{active:true});
    if(!this.compiling&&this.files.registration(input.deskId)?.enabled)return this.files.author(input.deskId,'automations',input);
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('Automation enabled must be boolean');
    if(!['manual','event','interval'].includes(input.type))throw new Error('Automation type must be manual, event or interval');
    if(input.overlap!==undefined&&!['skip','queue'].includes(input.overlap))throw new Error('Automation overlap must be skip or queue');
    if(this.compilingWorkflowIds&&!this.compilingWorkflowIds.has(input.workflowId))throw new Error('Automation refers to a missing authored workflow');
    const workflow=this.workflow(input.deskId,input.workflowId,input.workflowVersion);if(!workflow)throw new Error('Unknown automation workflow');
    const enabled=input.enabled??false,ownerThread=input.ownerThread==null?null:thread(input.ownerThread);if(enabled&&!ownerThread)throw new Error('Enabled automation requires an exact ownerThread');
    const value={deskId:input.deskId,id:safeId(input.id,'automation ID'),name:text(input.name??input.id,'automation name',{max:256}),enabled,type:input.type,workflowId:workflow.id,workflowVersion:workflow.version,ownerThread,overlap:input.overlap??'skip'};
    if(input.type==='interval'){
      if(input.catchup!==undefined&&input.catchup!=='latest')throw new Error('Interval catchup must be latest');value.catchup='latest';
      if(!Number.isSafeInteger(input.everySeconds)||input.everySeconds<1||input.everySeconds>31536000)throw new Error('Interval everySeconds must be a positive integer no larger than one year');value.everySeconds=input.everySeconds;
      if(input.startAt!==undefined){if(typeof input.startAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.startAt)||!Number.isFinite(Date.parse(input.startAt)))throw new Error('startAt must be an ISO timestamp with timezone');value.startAt=new Date(input.startAt).toISOString();}
    }else if(input.everySeconds!==undefined||input.startAt!==undefined||input.catchup!==undefined)throw new Error('Only interval automations accept everySeconds/startAt');
    if(input.type==='event')value.eventName=text(input.eventName,'event name',{max:256});else if(input.eventName!==undefined)throw new Error('Only event automations accept eventName');
    return this._versionPut('automation',value);
  }
  works(deskId){return this._list('work',deskId);}
  work(deskId,id){return this._get('work',deskId,id);}
  workCreate(input){
    object(input,['deskId','id','title','brief','projectId','ownerThread'],'work');this.require(input.deskId,{active:true});
    const existing=this.work(input.deskId,input.id);
    const projectId=input.projectId??'home';if(!this.project(input.deskId,projectId))throw new Error('Unknown desk project');
    return this.store.transaction(()=>this._insert('work',{deskId:input.deskId,id:safeId(input.id,'work ID'),title:text(input.title,'work title',{max:512}),brief:text(input.brief,'work brief'),projectId,ownerThread:input.ownerThread===undefined?(existing?.ownerThread??null):thread(input.ownerThread),status:'planned',note:'',taskId:null,agentId:null}));
  }
  workUpdate(deskId,id,patch){
    object(patch,['status','note','ownerThread','taskId','agentId'],'work update');
    return this.store.transaction(()=>{
      const old=this.work(deskId,id);if(!old)throw new Error('Unknown desk work item');const next={...old};
      if(patch.status!==undefined){if(!WORK_STATES.has(patch.status))throw new Error('Unknown work status');if(TERMINAL_WORK.has(old.status)&&patch.status!==old.status)throw new Error('Finished work cannot be implicitly reopened');next.status=patch.status;}
      if(patch.note!==undefined)next.note=text(patch.note,'work evidence/note');
      if((next.status==='done'||next.status==='cancelled')&&next.status!==old.status&&!patch.note?.trim())throw new Error('Completion/cancellation requires explicit evidence or explanation');
      if(patch.ownerThread!==undefined){next.ownerThread=thread(patch.ownerThread);if(old.ownerThread&&old.ownerThread!==next.ownerThread)throw new Error('Work ownership cannot silently change chats');}
      if(patch.taskId!==undefined){const task=this.store.task(patch.taskId);if(!task||task.deskId!==deskId||task.deskProjectId!==old.projectId||task.project!==this.project(deskId,old.projectId)?.path||task.threadId!==next.ownerThread||task.deskWorkId!==id)throw new Error('Task does not match work desk/project/chat');if(old.taskId&&old.taskId!==patch.taskId)throw new Error('Work task binding cannot change');next.taskId=task.id;}
      if(patch.agentId!==undefined){const agent=this.store.worker(patch.agentId);if(!agent||agent.deskId!==deskId||agent.deskProjectId!==old.projectId||agent.deskWorkId!==id||agent.taskId!==next.taskId)throw new Error('Agent does not match work task/desk');if(old.agentId&&old.agentId!==patch.agentId)throw new Error('Work agent binding cannot change');next.agentId=agent.id;}
      if(next.status==='done'&&old.status!=='done'&&next.taskId&&this.store.messages({taskId:next.taskId,pending:true}).length)throw new Error('Resolve and acknowledge the work task messages before marking work done');
      if(JSON.stringify(next)===JSON.stringify(old))return old;next.updatedAt=now();this._save('work',next);this.store.journal('desk.work.updated',{deskId,id,status:next.status,note:patch.note??null});return next;
    });
  }
  jobs(deskId){return this._list('job',deskId);}
  job(deskId,id){return this._get('job',deskId,id);}
  jobCreate(input){
    object(input,['deskId','id','workflowId','workflowVersion','projectId','ownerThread','workId','parameters'],'job');this.require(input.deskId,{active:true});
    const existing=this.job(input.deskId,input.id);
    const fileSnapshot=!existing&&this.files.registration(input.deskId)?.enabled?this.files.available(input.deskId,'workflows',input.workflowId):null;
    const workflow=this.workflow(input.deskId,input.workflowId,input.workflowVersion??existing?.workflowVersion??fileSnapshot?.workflows[input.workflowId]);if(!workflow)throw new Error('Unknown desk workflow');
    const projectId=input.projectId??existing?.projectId??workflow.projectId,project=this.project(input.deskId,projectId);if(!project)throw new Error('Unknown desk project');
    const ownerThread=thread(input.ownerThread),workId=input.workId??null;
    if(workId){const work=this.work(input.deskId,workId);if(!work||work.projectId!==projectId||work.ownerThread&&work.ownerThread!==ownerThread||(!existing&&(TERMINAL_WORK.has(work.status)||work.taskId)))throw new Error('Work item does not match job desk/project/chat or is finished');}
    const runParameters=parameters(input.parameters??existing?.parameters);
    // Replays retain the original snapshot even if authored files, recipes or
    // roles have since changed. Registration identity still checks all inputs.
    let snapshot=existing?.snapshot;
    if(!snapshot){
      const definitions={},freeze=definition=>{if(!definition)throw new Error('Missing frozen workflow definition');definitions[definition.id+'@'+definition.version]=clone(definition);return definition;};
      const definition=workflow.definitionId?freeze(this._requireDefinition(input.deskId,workflow.definitionId,workflow.definitionVersion)):null;
      for(const step of workflow.steps??[])freeze(this._requireDefinition(input.deskId,step.definitionId,step.definitionVersion));
      const team=workflow.teamId?this.team(input.deskId,workflow.teamId,workflow.teamVersion):null;
      for(const member of team?.members??[])freeze(this._requireDefinition(input.deskId,member.definitionId,member.definitionVersion));
      const pending=Object.values(definitions),visited=new Set();
      while(pending.length){const role=pending.shift(),key=role.id+'@'+role.version;if(visited.has(key))continue;visited.add(key);
        for(const roleId of [...(role.authority?.delegateRoles??[]),...(role.authority?.reviewRoles??[])]){
          const pinned=Object.values(definitions).filter(d=>d.id===roleId);
          if(!pinned.length){if(fileSnapshot&&!Object.hasOwn(fileSnapshot.definitions,roleId))throw new Error('Granted role is absent from authored desk: '+roleId);pinned.push(freeze(this._requireDefinition(input.deskId,roleId,fileSnapshot?.definitions[roleId])));}
          pending.push(...pinned);
        }
      }
      const frozenWorkflow=clone(workflow),recipes={};
      const library=new RecipeLibrary({store:this.store,config:this.config,desks:this});
      for(const step of frozenWorkflow.steps??[])if(step.kind==='recipe'){
        const recipe=library.snapshot(input.deskId,step.recipeId,step.recipeVersion);step.recipeVersion=recipe.version;recipes[recipe.id+'@'+recipe.version]=recipe;
      }
      const resources=Object.fromEntries(workflow.resourceIds.map(id=>{const resource=this.resource(input.deskId,id);if(!resource)throw new Error('Missing workflow resource: '+id);return [id,clone(resource)];}));
      snapshot={workflow:frozenWorkflow,definition:clone(definition),definitions,resources,project:clone(project),parameters:runParameters,...(fileSnapshot?{shared:fileSnapshot.shared}:{}),...(team?{team:clone(team)}:{}),...(Object.keys(recipes).length?{recipes}:{})};
    }
    return this.store.transaction(()=>{
      if(workId&&!this.work(input.deskId,workId).ownerThread)this.workUpdate(input.deskId,workId,{ownerThread});
      return this._insert('job',{deskId:input.deskId,id:safeId(input.id,'job ID'),workflowId:workflow.id,workflowVersion:workflow.version,projectId,ownerThread,workId,status:'pending',note:'',taskId:null,agentId:null,snapshot,...(!existing||Object.hasOwn(existing,'parameters')||input.parameters!==undefined?{parameters:runParameters}:{})});
    });
  }
  jobUpdate(deskId,id,patch){
    object(patch,['status','note','taskId','agentId'],'job update');
    return this.store.transaction(()=>{
      const old=this.job(deskId,id);if(!old)throw new Error('Unknown desk job');const next={...old};
      if(patch.status!==undefined){if(!JOB_STATES.has(patch.status))throw new Error('Unknown job status');if(TERMINAL_JOB.has(old.status)&&patch.status!==old.status)throw new Error('Finished jobs cannot be implicitly restarted');
        if(patch.status!==old.status){const transitions={pending:['running','blocked','failed','cancelled'],running:['blocked','review','completed','failed','cancelled'],blocked:['running','review','failed','cancelled'],review:['running','blocked','completed','failed','cancelled']};if(!transitions[old.status]?.includes(patch.status))throw new Error('Invalid job transition');}
        next.status=patch.status;}
      if(patch.note!==undefined)next.note=text(patch.note,'job evidence/note');
      if(TERMINAL_JOB.has(next.status)&&next.status!==old.status&&!patch.note?.trim())throw new Error('Job settlement requires explicit evidence or explanation');
      if(patch.taskId!==undefined){const task=this.store.task(patch.taskId);if(!task||task.deskId!==deskId||task.deskProjectId!==old.projectId||task.project!==this.project(deskId,old.projectId)?.path||task.threadId!==old.ownerThread||task.deskJobId!==id||(task.deskWorkId??null)!==old.workId)throw new Error('Task does not match job desk/project/chat');if(old.taskId&&old.taskId!==patch.taskId)throw new Error('Job task binding cannot change');next.taskId=task.id;}
      if(patch.agentId!==undefined){const agent=this.store.worker(patch.agentId);if(!agent||agent.deskId!==deskId||agent.deskProjectId!==old.projectId||agent.deskJobId!==id||(agent.deskWorkId??null)!==old.workId||agent.taskId!==next.taskId)throw new Error('Agent does not match job task/desk');if(old.agentId&&old.agentId!==patch.agentId)throw new Error('Job agent binding cannot change');next.agentId=agent.id;}
      if(next.status==='completed'&&old.status!=='completed'&&next.taskId&&this.store.messages({taskId:next.taskId,pending:true}).length)throw new Error('Resolve and acknowledge the job task messages before completing the job');
      if(JSON.stringify(next)===JSON.stringify(old))return old;next.updatedAt=now();this._save('job',next);this.store.journal('desk.job.updated',{deskId,id,status:next.status,note:patch.note??null});return next;
    });
  }
  resolveAssignment(input){
    object(input,['deskId','projectId','definitionId','definitionVersion','resourceIds'],'assignment');
    const desk=this.require(input.deskId,{active:true}),project=this.project(desk.id,input.projectId??'home');if(!project)throw new Error('Unknown desk project');
    if(canonical(project.path)!==project.path)throw new Error('Desk project path identity changed');
    const definition=this.definition(desk.id,input.definitionId,input.definitionVersion);if(!definition)throw new Error('Unknown desk agent definition');
    const ids=input.resourceIds===undefined?definition.resourceIds:list(input.resourceIds,'resource ID',{ids:true});
    if(ids.some(id=>!definition.resourceIds.includes(id)))throw new Error('Assignment cannot grant resources outside its definition');
    const resources=ids.map(id=>{const r=this.resource(desk.id,id);if(!r)throw new Error('Unknown desk resource');if(LOCAL.has(r.kind)&&canonical(r.path,{file:r.kind==='file'})!==r.path)throw new Error('Resource path identity changed');return r;});
    const readPaths=[project.path],writePaths=definition.scope==='write'?[project.path]:[];
    for(const r of resources.filter(r=>r.connected)){
      if(r.access.includes('read')||r.access.includes('write'))readPaths.push(r.path);
      if(definition.scope==='write'&&r.access.includes('write'))writePaths.push(r.path);
    }
    return {desk,project,definition,resources,unavailableResources:resources.filter(r=>!r.connected),readPaths:[...new Set(readPaths)],writePaths:[...new Set(writePaths)],context:definition.context};
  }
  events(deskId,{after=0,limit=100}={}){
    this.require(deskId);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new TypeError('Invalid activity cursor/limit');
    // Scope in SQLite before paging. Agent/message activity uses existing
    // task/worker identity rather than depending on every journal writer to add deskId.
    return this.db.prepare(`SELECT j.seq,j.at,j.type,j.data FROM journal j WHERE j.seq>? AND (
      json_extract(j.data,'$.deskId')=? OR
      EXISTS(SELECT 1 FROM tasks t WHERE t.id=json_extract(j.data,'$.taskId') AND json_extract(t.data,'$.deskId')=?) OR
      EXISTS(SELECT 1 FROM workers w WHERE w.id=json_extract(j.data,'$.workerId') AND json_extract(w.data,'$.deskId')=?) OR
      EXISTS(SELECT 1 FROM messages m JOIN tasks t ON t.id=m.task_id WHERE m.id=json_extract(j.data,'$.id') AND json_extract(t.data,'$.deskId')=?)
    ) ORDER BY j.seq LIMIT ?`).all(after,deskId,deskId,deskId,deskId,limit).map(r=>({...r,data:JSON.parse(r.data)}));
  }
  show(id){const desk=this.require(id);return {...desk,fileTemplate:this.files.registration(id)??null,projects:this.projects(id),resources:this.resources(id),definitions:this.definitions(id),teams:this.teams(id),workflows:this.workflows(id),automations:this.automations(id),work:this.works(id),jobs:this.jobs(id),agents:this.store.workers().filter(w=>w.deskId===id),tasks:this.store.tasks().filter(t=>t.deskId===id)};}
}
