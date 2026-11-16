#!/usr/bin/env node
import {readFileSync,writeFileSync,readdirSync,lstatSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

// Copies authored example files only. It cannot register a trigger, launch an
// agent, edit runtime settings or invoke the Herdr/Goose/Modal binaries.
export function installExample({kit,deskRoot}){
  if(!['coding','research','operations'].includes(kit))throw new Error('Choose coding, research or operations');
  if(typeof deskRoot!=='string'||!isAbsolute(deskRoot))throw new Error('Use an absolute existing Desk template root');
  const plain=path=>{for(let current=resolve(path);;current=dirname(current)){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('Example paths cannot contain symbolic links');if(dirname(current)===current)break;}return resolve(path);};
  const target=plain(deskRoot);if(realpathSync(target)!==target)throw new Error('Desk root identity differs');
  for(const file of ['desk.yaml','AGENTS.md','DESK.md'])if(!lstatSync(plain(join(target,file))).isFile())throw new Error('Target is not a scaffolded Desk');
  const source=join(dirname(fileURLToPath(import.meta.url)),kit),files=[];
  const walk=relative=>{for(const name of readdirSync(join(source,relative)).sort()){const rel=join(relative,name),path=join(source,rel),stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error('Example contains a symbolic link');if(stat.isDirectory())walk(rel);else if(stat.isFile())files.push({relative:rel,bytes:readFileSync(path)});else throw new Error('Example contains a non-regular file');}};
  for(const folder of ['agents','teams','recipes','workflows','automations'])walk(folder);
  // Validate every destination before writing any of them. Existing identical
  // content is an idempotent copy; human edits are never overwritten.
  for(const file of files){const path=plain(join(target,file.relative));if(existsSync(path)&&(!lstatSync(path).isFile()||!readFileSync(path).equals(file.bytes)))throw new Error('Refusing to overwrite existing edited file: '+path);}
  let created=0;
  for(const file of files){const path=plain(join(target,file.relative));mkdirSync(dirname(path),{recursive:true});try{writeFileSync(path,file.bytes,{flag:'wx',mode:0o600});created++;}catch(error){if(error.code!=='EEXIST'||!readFileSync(path).equals(file.bytes))throw error;}}
  return {kit,deskRoot:target,created,unchanged:files.length-created,enabledAutomations:0,note:'Authored files copied. Register project working, then desk validate and desk sync. No worker or schedule was started.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--kit'||args[2]!=='--desk-root')throw new Error('Usage: node examples/desks/install.mjs --kit coding|research|operations --desk-root /absolute/vault/Desk');console.log(JSON.stringify(installExample({kit:args[1],deskRoot:args[3]}),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
