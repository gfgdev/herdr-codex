import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,realpathSync,existsSync,renameSync,unlinkSync,linkSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {load,dump,JSON_SCHEMA} from './vendor-js-yaml.mjs';
import {digest,safeId} from './config.mjs';

export const pathIdentity=path=>process.platform==='darwin'?path.normalize('NFC').toLowerCase():path;
export const within=(path,root)=>{path=pathIdentity(path);root=pathIdentity(root);return path===root||path.startsWith(root+'/');};
export function plainPath(path){
  for(let p=resolve(path);;p=dirname(p)){
    try{if(lstatSync(p).isSymbolicLink())throw new Error('Desk files cannot follow symbolic links: '+p);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(dirname(p)===p)break;
  }
  return resolve(path);
}
export function directory(path){plainPath(path);mkdirSync(path,{recursive:true,mode:0o700});if(realpathSync(path)!==resolve(path))throw new Error('Desk directory identity changed');return path;}
function read(path){plainPath(path);const s=lstatSync(path);if(!s.isFile()||s.size>262144)throw new Error('Expected a desk text file no larger than 256 KiB: '+path);return readFileSync(path,'utf8');}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected YAML object');return value;}
function yaml(text){
  const result=object(load(text,{schema:JSON_SCHEMA})),seen=new Set();
  const visit=(v,depth=0)=>{if(depth>24)throw new Error('Desk YAML nesting is too deep');if(v&&typeof v==='object'){if(seen.has(v))throw new Error('YAML aliases/shared objects are not supported in desk definitions');seen.add(v);for(const [k,x] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw new Error('Reserved YAML field');visit(x,depth+1);}}};visit(result);return result;
}
function document(text){const m=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);if(!m)throw new Error('Definition requires YAML frontmatter and Markdown instructions');return {...yaml(m[1]),instructions:m[2].trim()};}
function render(value){const {instructions,...meta}=value;return '---\n'+dump(meta,{schema:JSON_SCHEMA,noRefs:true,lineWidth:100})+'---\n\n'+(instructions??'')+'\n';}
const latest=records=>[...new Map(records.map(r=>[r.id,r])).values()];
const body=record=>{const {deskId,version,createdAt,hash,...value}=record;return value;};
const key=id=>'desk.files:'+id;
function uniquePaths(paths){const seen=new Set();for(const path of paths){const k=pathIdentity(path);if(seen.has(k))throw new Error('Case/Unicode alias collision in desk paths: '+path);seen.add(k);}}
function identityFile(path,value){plainPath(path);const text=JSON.stringify(value,null,2)+'\n';try{writeFileSync(path,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(read(path)!==text)throw new Error('Task workspace already belongs to another identity');}}
const sharedInstructions=`# Desk working conventions

Use DESK.md for orientation and the assigned role for this task. Read relevant knowledge rather than loading the entire vault.

Write task findings and deliverables in the outputs directory given in your assignment; record checks and source references in evidence. Preserve unrelated human edits. Shared notes can be updated through an explicitly assigned maintenance task or checked publication after review.

Distinguish documented facts, decisions and assumptions. Report actual checks and unresolved questions. A terminal ending is not proof of success. Ask the managing Codex chat about business decisions outside the assignment.

Role and workflow files define future assignments; changing them does not expand a running agent's authority. Credentials and runtime databases remain outside this vault.
`;

/** File-authored intent; SQLite stores compiled history and execution state. */
export class DeskFiles {
  constructor(desks){this.desks=desks;this.store=desks.store;}
  registration(id){return this.store.meta(key(id));}
  root(id){const r=this.registration(id);if(!r?.enabled)throw new Error('Desk template is not initialized; use desk scaffold');plainPath(r.root);if(realpathSync(r.root)!==r.root)throw new Error('Desk template path identity changed');return r.root;}
  scaffold(id){
    const desk=this.desks.require(id,{active:true}),registered=this.registration(id);
    if(registered?.enabled){this.ensureLayout(id);return this.sync(id);}
    if(this.store.tasks().some(t=>t.deskId===id&&t.status==='active')||this.desks.jobs(id).some(j=>!['completed','failed','cancelled'].includes(j.status)))throw new Error('Resolve active desk assignments before migrating authored definitions');
    const root=join(desk.vaultPath??dirname(desk.home),'Desk'),planKey='desk.scaffold:'+id;
    let plan=this.store.meta(planKey);
    if(!plan){
      plainPath(root);
      if(existsSync(root)&&readdirSync(root).length)throw new Error('Desk folder already contains files; choose/migrate it explicitly without overwriting existing material');
      const definitions=latest(this.desks.definitions(id)),workflows=latest(this.desks.workflows(id)),teams=latest(this.desks.teams(id)),automations=latest(this.desks.automations(id));
      if(!definitions.length)for(const [role,harness,scope,instructions] of [
        ['researcher','goose','write','Investigate the assigned question, cite sources, distinguish facts from assumptions and save findings in the assigned outputs directory.'],
        ['operator','pi','write','Complete the assigned work, save deliverables in the assigned outputs directory and verify the result.'],
        ['reviewer','goose','read-only','Independently inspect the assigned evidence. Report supported defects, verification results and unresolved questions.']
      ])definitions.push({id:role,name:role[0].toUpperCase()+role.slice(1),harness,scope,writeMode:'task',instructions,resourceIds:desk.vaultPath?['vault']:[],acceptance:['Report evidence and unresolved questions.'],context:''});
      const files={
        'desk.yaml':dump({version:1,id,name:desk.name,purpose:desk.purpose,knowledgeRoot:desk.vaultPath??desk.home},{schema:JSON_SCHEMA,lineWidth:100}),
        'DESK.md':`# ${desk.name}\n\n${desk.purpose}\n\nDesk ID: \`${id}\`\n\n## Current priorities\n\nAdd priorities and links here. Existing knowledge stays in its current folders.\n\n- [Shared working conventions](AGENTS.md)\n- [Roles](agents/)\n- [Teams](teams/)\n- [Procedures](workflows/)\n- [Native Goose recipes](recipes/)\n- [Automations](automations/)\n- [Curated knowledge](knowledge/)\n- [Work and outputs](work/)\n- [Decisions](decisions/)\n- [Reports](reports/)\n\nExecution status, messages and job history are available through the Herdr Desk commands.\n`,
        'AGENTS.md':sharedInstructions,
        'automations/README.md':'# Automation definitions\n\nAuthor manual, event or interval triggers as <id>.yaml. New triggers default to disabled. Enabling requires an exact owner chat and a valid workflow; execution is managed by the Desk runtime. Mailbox and spreadsheet resources do not create connectors. Existing proposed files stay disabled until explicitly migrated.\n',
      };
      for(const d of definitions)files['agents/'+d.id+'/AGENT.md']=render(body(d));
      for(const w of workflows)files['workflows/'+w.id+'/WORKFLOW.md']=render(body(w));
      for(const t of teams)files['teams/'+t.id+'/TEAM.md']=render(body(t));
      for(const a of automations)files['automations/'+a.id+'.yaml']=dump(body(a),{schema:JSON_SCHEMA,noRefs:true,lineWidth:100});
      uniquePaths(Object.keys(files));plan={root,files,createdAt:new Date().toISOString()};this.store.meta(planKey,plan);
    }
    if(plan.root!==root)throw new Error('Scaffold plan differs from registered location');
    for(const [rel,text] of Object.entries(plan.files)){const path=join(root,rel);plainPath(path);if(existsSync(path)&&read(path)!==text)throw new Error('Interrupted scaffold has edited files; inspect before resuming: '+path);}
    for(const rel of ['agents','teams','workflows','recipes','automations','knowledge','work','inbox','decisions','reports'])directory(join(root,rel));
    for(const [rel,text] of Object.entries(plan.files)){const path=join(root,rel);directory(dirname(path));try{writeFileSync(path,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
    this.store.meta(key(id),{version:1,enabled:true,root});
    return this.sync(id);
  }
  ensureLayout(id){const root=this.root(id);for(const folder of ['teams','recipes','knowledge'])directory(join(root,folder));}
  snapshot(id,overrides={}){
    const root=this.root(id),files={};
    if(readdirSync(root).some(n=>/conflict/i.test(n)&&/\.(md|ya?ml)$/i.test(n)))throw new Error('Resolve synced desk control conflicts before running work');
    const take=rel=>{const value=Object.hasOwn(overrides,rel)?overrides[rel]:read(join(root,rel));files[rel]=value;return value;};
    const manifest=yaml(take('desk.yaml')),desk=this.desks.require(id);
    if(Object.keys(manifest).some(k=>!['version','id','name','purpose','knowledgeRoot'].includes(k))||manifest.version!==1||manifest.id!==id)throw new Error('Desk manifest schema/identity mismatch');
    if(manifest.knowledgeRoot!==(desk.vaultPath??desk.home))throw new Error('Knowledge root cannot be repointed by a file edit; register resources explicitly');
    const shared=take('AGENTS.md');take('DESK.md');
    const scan=(folder,file)=>{
      const dir=join(root,folder);plainPath(dir);
      const ids=new Set((existsSync(dir)?readdirSync(dir):[]).filter(n=>!n.startsWith('.')));
      for(const rel of Object.keys(overrides))if(rel.startsWith(folder+'/'))ids.add(rel.split('/')[1]);
      if(ids.size>200)throw new Error('Too many desk definitions');
      uniquePaths([...ids]);
      return [...ids].sort().map(id=>{
        safeId(id,'definition folder');const path=join(dir,id);plainPath(path);
        if(existsSync(path)){if(!lstatSync(path).isDirectory())throw new Error('Expected definition directory');if(readdirSync(path).some(n=>/conflict/i.test(n)))throw new Error('Resolve synced definition conflicts: '+path);}
        const parsed=document(take(folder+'/'+id+'/'+file));if(parsed.id!==id)throw new Error('Definition ID differs from its folder');return parsed;
      });
    };
    const definitions=scan('agents','AGENT.md'),teams=scan('teams','TEAM.md'),workflows=scan('workflows','WORKFLOW.md'),automations=[],proposedAutomations=[];
    const automationNames=new Set(readdirSync(join(root,'automations')));
    for(const rel of Object.keys(overrides))if(rel.startsWith('automations/'))automationNames.add(rel.slice('automations/'.length));
    uniquePaths([...automationNames]);
    const automationIds=new Set();
    for(const name of [...automationNames].sort()){
      if(name.startsWith('.')||name==='README.md')continue;
      if(!/^[a-zA-Z0-9._-]+\.ya?ml$/.test(name))throw new Error('Unsupported automation file: '+name);
      const a=yaml(take('automations/'+name)),id=name.replace(/\.ya?ml$/,'');safeId(id,'automation filename');
      if(automationIds.has(pathIdentity(id)))throw new Error('Duplicate automation ID across filenames: '+id);automationIds.add(pathIdentity(id));
      // Legacy disabled proposals were intentionally unconstrained metadata.
      // Retain them as inert files; never interpret them as active triggers.
      if(a.type===undefined&&a.enabled===false){proposedAutomations.push({file:name,status:'disabled-proposal'});continue;}
      if(a.id!==id)throw new Error('Automation ID differs from its filename');automations.push(a);
    }
    const hash=digest(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))));
    return {root,manifest,definitions,teams,workflows,automations,proposedAutomations,shared,files,hash};
  }
  compile(id,snapshot,{commit=true}={}){
    const abort={},desks=this.desks;let result;
    try{this.store.transaction(()=>{
      const oldFlag=desks.compiling,oldDefinitionIds=desks.compilingDefinitionIds,oldTeamIds=desks.compilingTeamIds,oldWorkflowIds=desks.compilingWorkflowIds;desks.compiling=true;
      desks.compilingDefinitionIds=new Set(snapshot.definitions.map(d=>d.id));desks.compilingTeamIds=new Set((snapshot.teams??[]).map(t=>t.id));desks.compilingWorkflowIds=new Set(snapshot.workflows.map(w=>w.id));
      try{
        desks.update(id,{name:snapshot.manifest.name,purpose:snapshot.manifest.purpose});
        const definitions=snapshot.definitions.map(d=>desks.definitionPut({...d,deskId:id}));
        const teams=(snapshot.teams??[]).map(t=>desks.teamPut({...t,deskId:id}));
        const workflows=snapshot.workflows.map(w=>desks.workflowPut({...w,deskId:id}));
        const automations=(snapshot.automations??[]).map(a=>desks.automationPut({...a,deskId:id}));
        result={version:1,enabled:true,root:snapshot.root,hash:snapshot.hash,shared:snapshot.shared,definitions:Object.fromEntries(definitions.map(d=>[d.id,d.version])),teams:Object.fromEntries(teams.map(t=>[t.id,t.version])),workflows:Object.fromEntries(workflows.map(w=>[w.id,w.version])),automations:Object.fromEntries(automations.map(a=>[a.id,a.version])),proposedAutomations:snapshot.proposedAutomations??[]};
        if(!commit)throw abort;
        const before=this.registration(id);this.store.meta(key(id),result);
        if(before?.hash!==snapshot.hash)this.store.journal('desk.files.synced',{deskId:id,hash:snapshot.hash,definitions:result.definitions,teams:result.teams,workflows:result.workflows,automations:result.automations});
      }finally{desks.compiling=oldFlag;desks.compilingDefinitionIds=oldDefinitionIds;desks.compilingTeamIds=oldTeamIds;desks.compilingWorkflowIds=oldWorkflowIds;}
    });}catch(e){if(e!==abort)throw e;}
    return result;
  }
  validate(id){try{const s=this.snapshot(id);const compiled=this.compile(id,s,{commit:false});return {valid:true,...compiled};}catch(e){return {valid:false,error:e.message};}}
  sync(id){this.ensureLayout(id);const s=this.snapshot(id);this.compile(id,s,{commit:false});if(this.snapshot(id).hash!==s.hash)throw new Error('Desk files changed during validation; retry after edits settle');return this.compile(id,s);}
  available(id,kind,definitionId){const r=this.sync(id);if(!Object.hasOwn(r[kind],definitionId))throw new Error('Authored '+kind+' entry is missing: '+definitionId);return r;}
  author(id,kind,input){
    const old=this.snapshot(id);this.compile(id,old,{commit:false});
    if(kind==='manifest'){
      if(Object.keys(input).some(k=>!['name','purpose'].includes(k)))throw new Error('Use registration commands for non-authored desk fields');
    }else if(input.deskId!==undefined&&input.deskId!==id)throw new Error('Foreign desk definition');
    const routes={definitions:['agents','AGENT.md'],teams:['teams','TEAM.md'],workflows:['workflows','WORKFLOW.md']};
    if(kind!=='manifest'&&kind!=='automations'&&!routes[kind])throw new Error('Unknown authored desk entity');
    const rel=kind==='manifest'?'desk.yaml':kind==='automations'?'automations/'+safeId(input.id)+'.yaml':routes[kind][0]+'/'+safeId(input.id)+'/'+routes[kind][1];
    const content=kind==='manifest'?dump({...old.manifest,...input},{schema:JSON_SCHEMA,lineWidth:100}):kind==='automations'?dump(body(input),{schema:JSON_SCHEMA,noRefs:true,lineWidth:100}):render(body(input));
    const next=this.snapshot(id,{[rel]:content});this.compile(id,next,{commit:false});
    if(this.snapshot(id).hash!==old.hash)throw new Error('Desk files changed while authoring; no file was overwritten');
    const path=join(old.root,rel);directory(dirname(path));const temp=path+'.'+randomUUID()+'.tmp';
    try{writeFileSync(temp,content,{flag:'wx',mode:0o600});renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
    const compiled=this.sync(id);
    if(kind==='manifest')return this.desks.get(id);
    const method={definitions:'definition',teams:'team',workflows:'workflow',automations:'automation'}[kind];return this.desks[method](id,input.id,compiled[kind][input.id]);
  }
  workspace(id,{agentId,workId,instruction}){
    safeId(agentId,'agent ID');if(workId)safeId(workId,'work ID');
    const root=this.root(id),work=join(root,'work',workId??'agent-'+agentId),agentRoot=join(work,'agents',agentId);
    directory(work);identityFile(join(work,'.work.json'),{deskId:id,workId:workId??'agent-'+agentId});
    directory(agentRoot);identityFile(join(agentRoot,'.assignment.json'),{deskId:id,agentId,workId:workId??null});
    for(const path of [join(agentRoot,'outputs'),join(agentRoot,'evidence')])directory(path);
    const brief=join(work,'BRIEF.md');plainPath(brief);try{writeFileSync(brief,'# Work brief\n\n'+instruction+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    return {root:agentRoot,outputs:join(agentRoot,'outputs'),evidence:join(agentRoot,'evidence'),brief};
  }
  publish(id,input){
    const {requestId,agentId,source,sourceSha256,resourceId,target,expectedSha256}=input;
    if(Object.keys(input).some(k=>!['requestId','agentId','source','sourceSha256','resourceId','target','expectedSha256'].includes(k)))throw new Error('Unknown publication field');
    safeId(requestId,'publication request');const fingerprint=digest(JSON.stringify(input)),receiptKey='desk.publish:'+id+':'+requestId;
    const prior=this.store.meta(receiptKey);if(prior&&prior.fingerprint!==fingerprint)throw new Error('Publication ID has different contents');if(prior?.status==='published')return prior;
    const worker=this.store.worker(agentId),workspace=worker?.delegation?.spec?.deskWorkspace;
    if(worker?.deskId!==id||!workspace||!isAbsolute(source)||![workspace.outputs,workspace.evidence].some(p=>within(resolve(source),p)))throw new Error('Source must belong to this desk agent task output');
    plainPath(source);const bytes=readFileSync(source);if(digest(bytes)!==sourceSha256)throw new Error('Source changed since review');
    const resource=this.desks.resource(id,resourceId);if(!resource?.path||!resource.access.includes('write')||resource.kind==='file')throw new Error('Target resource must be a writable directory');
    if(typeof target!=='string'||!target||isAbsolute(target)||target.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.obsidian'))throw new Error('Use a relative knowledge target');
    const dest=join(resource.path,target),root=this.root(id);plainPath(dest);
    if(!within(dest,resource.path)||within(dest,root)&&!['inbox','decisions','reports','knowledge'].some(p=>within(dest,join(root,p))))throw new Error('Publication cannot overwrite desk controls or task files');
    if(expectedSha256!==null&&!/^[0-9a-f]{64}$/.test(expectedSha256??''))throw new Error('Supply expectedSha256, or null for a new file');
    const desired=digest(bytes);
    const checkLease=()=>{for(const lease of this.store.db.prepare('SELECT paths FROM writer_leases').all())if(JSON.parse(lease.paths).some(p=>within(dest,p)||within(p,dest)))throw new Error('Target is owned by an active writer');};
    const currentHash=()=>{plainPath(dest);return existsSync(dest)?digest(readFileSync(dest)):null;};
    // Persist intent only after its precondition passes. A crash after the file
    // operation can then reconcile the desired bytes without repeating a write.
    const intent=this.store.transaction(()=>{
      const saved=this.store.meta(receiptKey);if(saved&&saved.fingerprint!==fingerprint)throw new Error('Publication ID has different contents');if(saved?.status==='published')return saved;
      checkLease();const current=currentHash();
      if(!(saved?.status==='writing'&&current===desired)&&current!==expectedSha256)throw new Error('Target changed since review; publication was not applied');
      if(saved?.status==='writing')return saved;
      let backup=null;
      if(current!==null){
        const folder=directory(join(this.desks.config.stateDir,'publication-backups',digest(id+':'+requestId))),path=join(folder,'before');
        try{writeFileSync(path,readFileSync(dest),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
        if(digest(readFileSync(path))!==expectedSha256)throw new Error('Target changed while retaining recovery evidence');backup=path;
      }
      const value={fingerprint,status:'writing',target:dest,sha256:desired,expectedSha256,backup};this.store.meta(receiptKey,value);return value;
    });
    if(intent.status==='published')return intent;
    return this.store.transaction(()=>{
      const saved=this.store.meta(receiptKey);if(saved.fingerprint!==fingerprint)throw new Error('Publication ID has different contents');if(saved.status==='published')return saved;
      checkLease();const current=currentHash();
      if(current!==desired){
        if(current!==expectedSha256)throw new Error('Target changed since review; publication was not applied');
        directory(dirname(dest));const temp=dest+'.'+randomUUID()+'.tmp';
        try{
          writeFileSync(temp,bytes,{flag:'wx',mode:0o600});
          if(expectedSha256===null)linkSync(temp,dest); // Atomic create without replacing a racing external edit.
          else{if(currentHash()!==expectedSha256)throw new Error('Target changed during publication');renameSync(temp,dest);}
        }finally{if(existsSync(temp))unlinkSync(temp);}
      }
      const receipt={...saved,status:'published',at:new Date().toISOString()};this.store.meta(receiptKey,receipt);this.store.journal('desk.output.published',{deskId:id,requestId,agentId,target:dest,sha256:desired});return receipt;
    });
  }
}
