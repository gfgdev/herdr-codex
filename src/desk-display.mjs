import {realpathSync} from 'node:fs';
import {localSpace} from './routing.mjs';

const canonical=path=>{try{return realpathSync(path);}catch{return null;}};

// Display location never replaces the registered execution project or grants.
export function deskDisplay(desk) {
  const home=canonical(desk.home);
  if(!home||home!==desk.home)throw new Error('Registered desk home must be canonical');
  const folder=desk.fileTemplate?.enabled?desk.fileTemplate.root:home;
  if(!folder||canonical(folder)!==folder)throw new Error('Registered desk files folder must exist and be canonical');
  // Older spaces retain their original creation folder: Herdr has no folder
  // setter. Their first/selected browse terminal supplies the live Files cwd.
  return {folder,files:!!desk.fileTemplate?.enabled,
    matches:space=>localSpace(space)&&[home,folder].includes(canonical(space.folder))};
}

export async function openDeskFiles({desk,appCall,getTerminal,spaceId}) {
  const display=deskDisplay(desk);
  if(typeof getTerminal!=='function')throw new Error('Desk files view requires native terminal verification');
  const inventory=async()=>{
    const value=await appCall('ls',{});
    if(!Array.isArray(value?.spaces))throw new Error('Unexpected native desktop inventory');
    return value.spaces;
  };
  let spaces=await inventory(),matches=spaces.filter(display.matches);
  let target=spaceId?spaces.find(s=>s.id===spaceId):matches.length===1?matches[0]:null;
  if(spaceId&&(!target||!display.matches(target)))throw new Error('Selected space does not match the local desk files or legacy home');
  if(!spaceId&&matches.length>1)throw new Error('Several native spaces match this desk; choose an explicit --space');
  if(!target){
    await appCall('space.new',{name:desk.name+' · desk',folder:display.folder,tab:'Desk files'});
    spaces=await inventory();matches=spaces.filter(display.matches);
    if(matches.length!==1)throw new Error('Desk space creation is not uniquely confirmed; inspect app ls before retrying');
    target=matches[0];
  }
  const current=async()=>{
    const selected=(await inventory()).find(s=>s.id===target.id);
    if(!selected||!display.matches(selected))throw new Error('Desk space identity changed; no further placement attempted');
    return selected;
  };
  const browse=async tab=>{
    if(tab.name!=='Desk files'||tab.terminals?.length!==1)return false;
    const native=await getTerminal(tab.terminals[0].terminal);
    return native?.state==='live'&&localSpace(native)&&canonical(native.cwd)===display.folder&&
      !native.labels?.['codex.worker']&&!native.labels?.['codex.task'];
  };
  const findBrowse=async space=>{
    const tabs=[];for(const tab of space.tabs??[])if(await browse(tab))tabs.push(tab);
    if(tabs.length>1)throw new Error('Several Desk files tabs match; inspect the desk before retrying');
    return tabs[0];
  };
  let selected=await current(),tab=await findBrowse(selected);
  if(!tab){
    await appCall('tab.new',{space:target.id,name:'Desk files',folder:display.folder});
    selected=await current();tab=await findBrowse(selected);
    if(!tab)throw new Error('Desk files tab creation is not confirmed; inspect app ls before retrying');
  }
  if(selected.tabs[0]?.id!==tab.id)await appCall('tab.move',{id:tab.id,index:1});
  selected=await current();
  if(!selected.active)await appCall('space.select',{id:target.id});
  await appCall('tab.select',{id:tab.id});
  spaces=await inventory();selected=spaces.find(s=>s.id===target.id);
  const tabs=selected?.tabs??[],active=tabs.filter(t=>t.active);
  if(spaces.filter(s=>s.active).length!==1||!selected?.active||!display.matches(selected)||
    tabs[0]?.id!==tab.id||active.length!==1||active[0].id!==tab.id||!await browse(active[0]))
    throw new Error('Desktop selection changed; desk files view is not verified');
  return {deskId:desk.id,spaceId:target.id,tabId:tab.id,terminalId:tab.terminals[0].terminal,
    home:desk.home,displayFolder:display.folder,status:'selected',verified:true};
}
