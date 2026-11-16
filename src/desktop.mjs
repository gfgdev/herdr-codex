import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { canonicalProject, localSpace, assertNativeWorker } from './routing.mjs';
import {deskDisplay} from './desk-display.mjs';

function canonical(path) {
  if(typeof path!=='string'||!path)return null;
  try{return realpathSync(path);}catch{return null;}
}
function spaces(snapshot) {
  if(!Array.isArray(snapshot?.spaces))throw new Error('Unexpected Herdr desktop inventory; no terminal was placed');
  return snapshot.spaces;
}
function visible(snapshot,terminalId) {
  return spaces(snapshot).filter(localSpace).flatMap(space=>(space.tabs??[]).flatMap(tab=>(tab.terminals??[])
    .filter(item=>item.terminal===terminalId).map(()=>({space,tab}))));
}
function active(snapshot) { return spaces(snapshot).filter(space=>space.active); }
function mismatch(found,target,terminalId) {
  const wrong=found.find(item=>item.space.id!==target.id);
  if(wrong)throw new Error(`Terminal ${terminalId} is already visible in Herdr space ${wrong.space.id} (${wrong.space.name??'unnamed'}), outside the selected project space ${target.id}. Inspect it explicitly; no tab was closed or moved.`);
}
function assertActive(snapshot,target,project) {
  const selected=active(snapshot);
  if(selected.length!==1||selected[0].id!==target.id||!localSpace(selected[0])||canonical(selected[0].folder)!==project)
    throw new Error('Herdr desktop focus changed or the selected space no longer matches the project. Placement was not continued; select the intended space and retry.');
}

// A desk is a registered grouping of explicit projects, not a replacement cwd.
// The caller supplies this snapshot from the desk registry, never from a worker
// prompt or whichever native desktop space happens to be selected.
function deskContext(desk,worker) {
  if(!desk||typeof desk!=='object'||Array.isArray(desk)||typeof desk.id!=='string'||!desk.id||
    worker.deskId!==desk.id||typeof worker.deskProjectId!=='string'||!worker.deskProjectId)
    throw new Error('Desk display requires a matching registered worker desk and project identity');
  const home=canonicalProject(desk.home);
  if(home!==desk.home)throw new Error('Registered desk home must be canonical');
  if(!Array.isArray(desk.projects))throw new Error('Desk display requires registered project bindings');
  const projects=new Map();
  for(const project of desk.projects){
    if(!project||typeof project.id!=='string'||!project.id||projects.has(project.id))
      throw new Error('Desk project identities must be unique and explicit');
    const path=canonicalProject(project.path);
    if(path!==project.path)throw new Error('Registered desk project path must be canonical');
    projects.set(project.id,path);
  }
  const check=member=>{
    if(!member||member.deskId!==desk.id||projects.get(member.deskProjectId)!==member.project)
      throw new Error('Worker does not match this desk and its registered execution project');
  };
  check(worker);
  const display=deskDisplay(desk);
  return {home,display,check,result:{deskId:desk.id,deskProjectId:worker.deskProjectId,displayFolder:display.folder}};
}

/**
 * Show a registered worker in its actual project space, or in an explicitly
 * registered desk home whose project membership matches the worker.
 * appCall('ls', {}) reads inventory; appCall('space.select', {id}) and
 * appCall('terminal.keep', {...}) invoke app do. Uses structured text; split anchors use native identity checks.
 * The app has global focus, so placement is checked afterwards, not atomic.
 */
export async function showWorker({worker,spaceId,place='tab',appCall,getTerminal,desk,getRegisteredWorker,createSpace=false,spaceName}) {
  if(typeof appCall!=='function')throw new TypeError('appCall is required');
  if(!worker?.terminalId)throw new Error('Worker has no confirmed terminal');
  const project=canonicalProject(worker.project);
  if(project!==worker.project)throw new Error('Registered worker project must be canonical');
  const context=desk===undefined?null:deskContext(desk,worker);
  const displayFolder=context?.display.folder??project;
  const matches=space=>context?context.display.matches(space):localSpace(space)&&canonical(space.folder)===project;
  const identity=context?.result??{};
  if(typeof getTerminal!=='function')throw new TypeError('Showing a worker requires native identity verification');
  const verify=async()=>assertNativeWorker(worker,await getTerminal(worker.terminalId));
  await verify();
  if(!['tab','right','down'].includes(place))throw new Error('Invalid desktop placement');
  const before=await appCall('ls',{}),inventory=spaces(before);
  let target;
  if(spaceId!==undefined){
    target=inventory.find(space=>space.id===spaceId);
    if(!target)throw new Error(`Unknown Herdr space ${spaceId}; no terminal was placed`);
    if(!localSpace(target))throw new Error('Registered local worker requires a local desktop space');
    if(!matches(target))throw new Error(`Herdr space ${spaceId} does not match ${context?'registered desk home/files':'worker project'} ${displayFolder}; no terminal was placed`);
  }else{
    let matching=inventory.filter(matches);
    if(!matching.length){
      // An explicit show request authorizes creating exactly the canonical
      // project/desk space. The currently selected space is never used, and if
      // creation cannot be uniquely confirmed the caller gets a concrete action
      // instead of an unrelated space.
      const folder=displayFolder,name=spaceName??(context?desk.name+' · desk':basename(folder));
      const action={method:'space.new',params:{name,folder}};
      if(!createSpace) throw new Error(`No Herdr desktop space matches ${context?'desk files':'project'} ${folder}. Create one explicitly with app do space.new --name ${JSON.stringify(name)} --folder ${JSON.stringify(folder)}, then retry. The currently selected space was not used.`);
      try{ await appCall('space.new',action.params); }
      catch(error){
        return {status:'create-space-required',verified:false,terminalId:worker.terminalId,project:folder,...identity,action,
          warning:`Could not create the project space automatically: ${error.message}`,note:'Create the space, then retry show_agent; the agent itself is unaffected.'};
      }
      matching=spaces(await appCall('ls',{})).filter(matches);
      if(matching.length!==1) return {status:'create-space-required',verified:false,terminalId:worker.terminalId,project:folder,...identity,action,
        note:'Space creation was not uniquely confirmed; inspect app ls before retrying. No terminal was placed.'};
    } else if(matching.length!==1) throw new Error(`More than one Herdr space matches ${context?'desk files':'project'} ${displayFolder}; pass an explicit space ID. No terminal was placed.`);
    target=matching[0];
  }
  const spaceFolder=canonical(target.folder);
  const existing=visible(before,worker.terminalId);mismatch(existing,target,worker.terminalId);
  if(existing.length){
    await verify();
    return {status:'already-visible',verified:true,terminalId:worker.terminalId,spaceId:target.id,tabId:existing[0].tab.id,project,...identity};
  }
  if(active(before).length!==1||active(before)[0].id!==target.id)await appCall('space.select',{id:target.id});
  const selected=await appCall('ls',{});assertActive(selected,target,spaceFolder);
  let splitAnchor;
  if(place!=='tab'){
    const selectedSpace=spaces(selected).find(space=>space.id===target.id);
    const tabs=(selectedSpace.tabs??[]).filter(tab=>tab.active);
    if(tabs.length!==1||!tabs[0].terminals?.length)throw new Error('Split placement needs an active tab with project terminals; use place=tab.');
    const anchors=tabs[0].terminals.map(item=>item.terminal);
    for(const terminalId of anchors){
      const native=await getTerminal(terminalId);
      if(context){
        if(typeof getRegisteredWorker!=='function')throw new Error('Desk splits require registered-worker lookup; use place=tab.');
        const anchor=await getRegisteredWorker(terminalId);
        context.check(anchor);
        if(anchor.terminalId!==terminalId)throw new Error('Desk split anchor registry identity changed; use place=tab.');
        assertNativeWorker(anchor,native);
      }else if(native?.state!=='live'||!localSpace(native)||canonical(native.cwd)!==project)throw new Error(`Split anchor ${terminalId} does not belong to this project as a live local terminal; use place=tab.`);
    }
    const checked=await appCall('ls',{});assertActive(checked,target,spaceFolder);
    const current=(spaces(checked).find(space=>space.id===target.id).tabs??[]).filter(tab=>tab.active);
    if(current.length!==1||current[0].id!==tabs[0].id||JSON.stringify((current[0].terminals??[]).map(item=>item.terminal))!==JSON.stringify(anchors))
      throw new Error('Herdr active tab changed while checking split anchors; no terminal was placed. Retry after selecting the intended tab.');
    splitAnchor={tabId:tabs[0].id,terminals:anchors};
  }
  await verify();
  const preKeep=await appCall('ls',{});assertActive(preKeep,target,spaceFolder);
  if(splitAnchor){
    const current=(spaces(preKeep).find(space=>space.id===target.id).tabs??[]).filter(tab=>tab.active);
    if(current.length!==1||current[0].id!==splitAnchor.tabId||JSON.stringify((current[0].terminals??[]).map(item=>item.terminal))!==JSON.stringify(splitAnchor.terminals))
      throw new Error('Herdr active tab changed before placement; no terminal was placed.');
  }
  const placement=await appCall('terminal.keep',{terminal:worker.terminalId,place});
  const after=await appCall('ls',{}),observed=visible(after,worker.terminalId);
  mismatch(observed,target,worker.terminalId);
  // Focus can change after selection because Herdr offers no target-space
  // argument on terminal.keep. Surface the race instead of claiming success.
  assertActive(after,target,spaceFolder);
  await verify();
  if(placement?.pending===true||!observed.length){
    return {status:'pending',verified:false,terminalId:worker.terminalId,spaceId:target.id,project,...identity,
      ...(observed[0]?{observedTabId:observed[0].tab.id}:{}),nativeReceipt:placement,
      note:'Placement requested; inspect app ls again before claiming the terminal is visible.'};
  }
  return {status:'shown',verified:true,terminalId:worker.terminalId,spaceId:target.id,tabId:observed[0].tab.id,project,...identity,nativeReceipt:placement};
}
