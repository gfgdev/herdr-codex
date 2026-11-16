import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,realpathSync,existsSync,mkdtempSync,rmSync,renameSync} from 'node:fs';
import {join,dirname,resolve,posix,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {load,dump,JSON_SCHEMA} from './vendor-js-yaml.mjs';
import {digest,safeId} from './config.mjs';

const LIMIT=8*1024*1024;
const identity=p=>p.normalize('NFC').toLowerCase();
function plain(path){for(let p=resolve(path);;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())throw new Error('Recipe files cannot follow symbolic links: '+p);}catch(e){if(e.code!=='ENOENT')throw e;}if(dirname(p)===p)break;}return resolve(path);}
function relativePath(value){
  if(typeof value!=='string'||!value||value.includes('\0')||value.includes('\\')||isAbsolute(value)||value.split('/').some(x=>x==='..')||value.includes(':'))throw new Error('Recipe file path must stay inside its bundle: '+value);
  const result=posix.normalize(value);if(result==='.'||result.startsWith('../'))throw new Error('Invalid recipe file path');return result;
}
function parse(content){
  let value;try{value=load(content,{schema:JSON_SCHEMA});}catch(e){if(content.includes('{%'))return null;throw new Error('Recipe YAML cannot be inspected: '+e.message);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected a native recipe object');
  return value.recipe??value;
}
function filesList(files){
  if(!Array.isArray(files)||!files.length||files.length>1000)throw new Error('Recipe needs between 1 and 1000 files');const seen=new Set();let size=0;
  return files.map(file=>{
    const path=relativePath(file.path),key=identity(path);
    if(seen.has(key))throw new Error('Duplicate/case-aliased recipe path: '+path);seen.add(key);
    if(typeof file.content!=='string'||file.content.includes('\0'))throw new Error('Recipe bundle files must be UTF-8 text');
    size+=Buffer.byteLength(file.content);if(size>LIMIT)throw new Error('Recipe bundle exceeds 8 MiB');
    const sha256=digest(file.content);if(file.sha256!==undefined&&file.sha256!==sha256)throw new Error('Recipe file hash mismatch: '+path);
    return {path,content:file.content,sha256};
  }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
function graph(files,entry){
  const byPath=new Map(files.map(f=>[f.path,f])),visited=new Set(),active=new Set();
  const visit=path=>{
    if(active.has(path))throw new Error('Cyclic native recipe reference: '+path);if(visited.has(path))return;
    const file=byPath.get(path);if(!file)throw new Error('Referenced local recipe is missing: '+path);
    active.add(path);const doc=parse(file.content);
    for(const child of doc?.sub_recipes??[]){
      if(typeof child.path!=='string')throw new Error('Native subrecipe needs a local path');
      const local=child.path.replace(/^\{\{\s*recipe_dir\s*\}\}\//,'');
      if(/[{}]/.test(local))throw new Error('Dynamic subrecipe paths cannot be frozen; use a bundle-relative path or {{ recipe_dir }}');
      const rel=relativePath(local),target=posix.normalize(posix.join(posix.dirname(path),rel));
      visit(target);
    }
    for(const match of file.content.matchAll(/\{%[-]?\s*(?:include|extends|import|from)\s+['"]([^'"]+)['"]/g)){
      const target=posix.join(posix.dirname(path),relativePath(match[1]));
      if(!byPath.has(target))throw new Error('Referenced recipe template is missing: '+target);
    }
    active.delete(path);visited.add(path);
  };
  visit(entry);return [...visited];
}
export function recipeBundle({id,version=1,entry='recipe.yaml',files}){
  safeId(id,'recipe ID');if(!Number.isSafeInteger(version)||version<1)throw new Error('Recipe version must be a positive integer');
  entry=relativePath(entry);files=filesList(files);graph(files,entry);
  const sha256=digest(JSON.stringify({entry,files:files.map(({path,sha256})=>({path,sha256}))}));
  const parameters=parse(files.find(f=>f.path===entry).content)?.parameters;
  return {id,version,sha256,entry,files,...(parameters?{parameters}: {})};
}
export function assertRecipeSnapshot(snapshot){
  const checked=recipeBundle(snapshot);if(snapshot.sha256!==checked.sha256)throw new Error('Recipe snapshot hash mismatch');
  if(snapshot.parameters!==undefined&&JSON.stringify(snapshot.parameters)!==JSON.stringify(checked.parameters))throw new Error('Recipe parameter metadata differs from authored source');
  return checked;
}
export function recipeParameters(values={}){
  if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('Recipe parameters must be an object');
  const result={};for(const [key,value]of Object.entries(values)){
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||key==='recipe_dir')throw new Error('Invalid or reserved recipe parameter: '+key);
    if(!['string','number','boolean'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value)))throw new Error('Recipe parameter must be a string, number or boolean: '+key);
    const string=String(value);if(string.includes('\0'))throw new Error('Recipe parameter contains NUL');result[key]=string;
  }return result;
}
/** Authority checks augment native validation; they do not serialize or filter native fields. */
function documentPolicy(doc,label,profile,parameters={},worker){
  if(!doc)return;const settings=doc.settings??{};
  for(const [key,expected]of [['goose_provider','openai'],['goose_model',profile.model]])if(settings[key]!=null&&settings[key]!==expected)throw new Error(`Recipe ${label} would override selected ${key}; remove it or use ${expected}`);
  for(const key of ['env','environment','config','cwd','working_directory','readPaths','writePaths','sandbox','container'])if(Object.hasOwn(doc,key)||Object.hasOwn(settings,key))throw new Error('Recipe cannot override worker configuration or resource authority: '+key);
  if(worker)for(const param of doc.parameters??[])if(param.input_type==='file'&&Object.hasOwn(parameters,param.key)){
    const file=realpathSync(resolve(worker.project,parameters[param.key]));
    const roots=[worker.project,worker.stateDir,...worker.readPaths??[],...worker.writePaths??[]].map(p=>resolve(p));
    if(!roots.some(root=>file===root||file.startsWith(root+'/')))throw new Error('Recipe file parameter is outside assigned resources: '+param.key);
  }
}
export function assertRecipePolicy(snapshot,profile,parameters={},worker){
  const checked=assertRecipeSnapshot(snapshot);parameters=recipeParameters(parameters);
  for(const path of graph(checked.files,checked.entry))documentPolicy(parse(checked.files.find(f=>f.path===path).content),path,profile,parameters,worker);
  return checked;
}

function scan(root){
  plain(root);const files=[];let bytes=0;const walk=rel=>{for(const name of readdirSync(join(root,rel)).sort()){
    if(name.startsWith('.'))continue;const path=posix.join(rel,name),full=plain(join(root,path)),s=lstatSync(full);
    if(s.isDirectory())walk(path);else if(s.isFile()){bytes+=s.size;if(bytes>LIMIT||files.length>=1000)throw new Error('Recipe bundle exceeds snapshot storage limits');const raw=readFileSync(full),content=raw.toString('utf8');if(!Buffer.from(content).equals(raw))throw new Error('Recipe files must be UTF-8');files.push({path,content});}else throw new Error('Recipe bundle only supports regular files');
  }};walk('');return files;
}
function writeBundle(root,files,{immutable=false}={}){
  plain(root);mkdirSync(root,{recursive:true,mode:0o700});
  for(const file of files){const path=plain(join(root,file.path));mkdirSync(dirname(path),{recursive:true,mode:0o700});
    if(immutable&&existsSync(path)){if(readFileSync(path,'utf8')!==file.content)throw new Error('Frozen recipe file differs: '+file.path);continue;}
    const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,file.content,{flag:'wx',mode:immutable?0o400:0o600});renameSync(temp,path);
  }
}
export class RecipeLibrary{
  constructor({store,config,desks}){this.store=store;this.config=config;this.desks=desks;}
  directory(deskId,id){this.desks.require(deskId,{active:true});safeId(id,'recipe ID');return plain(join(this.desks.files.root(deskId),'recipes',id));}
  put(deskId,input){
    if(!input||typeof input!=='object')throw new Error('Recipe input required');const id=safeId(input.id,'recipe ID');
    let files=input.files??[];if(input.content!==undefined)files=[{path:'recipe.yaml',content:input.content},...files.filter(f=>f.path!=='recipe.yaml')];
    files=filesList(files);const root=this.directory(deskId,id);
    // An omitted companion is preserved; editing/removing authored files is explicit.
    const current=existsSync(root)?scan(root):[],merged=new Map(current.map(f=>[f.path,f]));for(const file of files)merged.set(file.path,file);
    recipeBundle({id,files:[...merged.values()]});writeBundle(root,files);return this.get(deskId,id);
  }
  list(deskId){
    this.desks.require(deskId);const root=plain(join(this.desks.files.root(deskId),'recipes'));if(!existsSync(root))return [];
    return readdirSync(root).filter(x=>!x.startsWith('.')).sort().map(id=>this.get(deskId,id));
  }
  get(deskId,id,version){
    if(version!==undefined){const saved=this.desks._version('recipe',deskId,id,version);if(!saved)throw new Error('Unknown recipe version');assertRecipeSnapshot(saved);return saved;}
    const snapshot=recipeBundle({id,files:scan(this.directory(deskId,id))});const {version:ignored,...body}=snapshot;
    return this.desks._versionPut('recipe',{deskId,...body});
  }
  snapshot(deskId,id,version){const r=this.get(deskId,id,version);return assertRecipeSnapshot(r);}
  async validateNative(snapshot){
    snapshot=assertRecipeSnapshot(snapshot);const profile=JSON.parse(readFileSync(this.config.profileFile,'utf8'));
    assertRecipePolicy(snapshot,profile);if(!isAbsolute(profile.goose??''))throw new Error('Selected Goose executable must be absolute');
    const root=realpathSync(mkdtempSync(join(tmpdir(),'herdr-recipe-validation-')));
    try{
      writeBundle(root,snapshot.files);const runtime=join(root,'.native');mkdirSync(runtime,{mode:0o700});
      const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:runtime,GOOSE_PATH_ROOT:runtime,XDG_CONFIG_HOME:runtime,XDG_STATE_HOME:runtime,GOOSE_TELEMETRY_OFF:'1'};
      const checks=graph(snapshot.files,snapshot.entry).map(path=>{
        const result=spawnSync(profile.goose,['recipe','validate',join(root,path)],{cwd:root,env,encoding:'utf8',maxBuffer:1024*1024,timeout:30000});
        return {path,code:result.status,signal:result.signal,error:result.error?.message??null,stdout:result.stdout??'',stderr:result.stderr??'',passed:result.status===0&&!result.signal&&!result.error};
      });
      return {passed:checks.every(c=>c.passed),recipeSha256:snapshot.sha256,binary:profile.goose,binarySha256:digest(readFileSync(profile.goose)),checks,noInference:true};
    }finally{rmSync(root,{recursive:true,force:true});}
  }
}

function literalTemplateText(value){
  // Preserve arbitrary manager context without interpreting its template syntax.
  return '{% raw %}'+value.replace(/\{%-?\s*endraw\s*-?%\}/g,token=>'{% endraw %}{{ '+JSON.stringify(token)+' }}{% raw %}')+'{% endraw %}';
}
export function prepareRecipeOverlay(worker, renderedContent, instructions, directory){
  const snapshot=assertRecipeSnapshot(worker.recipe),entry=snapshot.files.find(f=>f.path===snapshot.entry);
  let original;try{original=load(entry.content,{schema:JSON_SCHEMA});}catch{}
  const originalBody=original?.recipe??original;
  const mode=originalBody&&typeof originalBody==='object'&&!Array.isArray(originalBody)?'authored-yaml-overlay':'native-rendered-overlay';
  const document=mode==='authored-yaml-overlay'?structuredClone(original):load(renderedContent,{schema:JSON_SCHEMA});
  const body=document.recipe??document;
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Native recipe did not render an object');
  body.instructions=(body.instructions??'')+'\n\n'+literalTemplateText(instructions);
  const content=dump(document,{schema:JSON_SCHEMA,noRefs:true,lineWidth:-1});
  const files=filesList(snapshot.files.map(file=>({path:file.path,content:file.path===snapshot.entry?content:file.content})));
  writeBundle(directory,files,{immutable:true});
  const metadata={version:1,mode,sourceRecipeSha256:snapshot.sha256,entry:join(directory,snapshot.entry),
    effectiveRecipeSha256:digest(JSON.stringify({entry:snapshot.entry,files:files.map(({path,sha256})=>({path,sha256}))})),
    instructionsSha256:digest(instructions),files:files.map(({path,sha256})=>({path,sha256}))};
  return metadata;
}

// Launcher preflight: read only local, already-rendered recipes. Never credentials.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(!['check-launch','prepare-overlay'].includes(process.argv[2]))throw new Error('Use RecipeLibrary through the integration');
    const worker=JSON.parse(readFileSync(process.argv[3],'utf8')),profile=JSON.parse(readFileSync(worker.profileFile,'utf8'));
    assertRecipePolicy(worker.recipe,profile,worker.recipeParameters,worker);
    if(process.argv[2]==='prepare-overlay'){
      const result=prepareRecipeOverlay(worker,readFileSync(process.argv[4],'utf8'),readFileSync(process.argv[5],'utf8'),process.argv[6]);
      process.stdout.write(JSON.stringify(result)+'\n');
    }else for(const path of process.argv.slice(4)){
      const content=readFileSync(path,'utf8'),doc=parse(content);if(!doc)throw new Error('Native rendering did not produce inspectable YAML');
      const bundleRoot=resolve(worker.stateDir,'recipe'),overlayRoot=resolve(worker.stateDir,worker.executionReceiptVersion===1?'execution':'recipe-evidence','recipe-overlay');
      for(const child of doc.sub_recipes??[]){
        const childPath=resolve(bundleRoot,child.path??'');
        if(!worker.recipe.files.some(file=>[resolve(bundleRoot,file.path),resolve(overlayRoot,file.path)].includes(childPath)))throw new Error('Rendered subrecipe is outside the frozen bundle');
      }
      // Native output has already been rendered. Literal template-like prose in
      // its instructions must not be evaluated a second time by our validator.
      documentPolicy(doc,path,profile,worker.recipeParameters,worker);
    }
  }catch(e){console.error('Recipe launch rejected: '+e.message);process.exitCode=1;}
}
