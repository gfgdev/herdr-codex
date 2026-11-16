import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDeskSpace} from '../src/desk-cli.mjs';

function fixture(t,{legacy=false,existing=false}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'herdr-files-'))),home=join(root,'private-home'),files=join(root,'Desk');
  mkdirSync(home);mkdirSync(files);t.after(()=>rmSync(root,{recursive:true,force:true}));
  const desk={id:'desk',name:'Desk',home,fileTemplate:{enabled:true,root:files}},terminals=new Map(),calls=[],hooks={};
  const game={id:'game',folder:root,machine:null,active:true,tabs:[{id:'game-tab',active:true,terminals:[{terminal:'game-worker'}]}]};
  let spaces=[structuredClone(game)],seq=0;
  const addTab=(space,name,cwd)=>{
    const terminal='t'+(++seq),tab={id:'tab'+seq,name,active:false,terminals:[{terminal}]};
    terminals.set(terminal,{state:'live',cwd,labels:{},machine:null});space.tabs.push(tab);return tab;
  };
  if(legacy||existing){
    const space={id:'desk',folder:legacy?home:files,machine:null,active:false,tabs:[]};spaces.push(space);
    if(legacy)addTab(space,'Private shell',home);
    if(existing)addTab(space,'Desk files',files);
  }
  const appCall=async(method,args)=>{
    calls.push({method,args:structuredClone(args)});
    if(method==='ls'){hooks.inventory?.(spaces);return {spaces:structuredClone(spaces)};}
    if(method==='space.new'){const space={id:'desk',folder:args.folder,name:args.name,machine:null,active:false,tabs:[]};spaces.push(space);addTab(space,args.tab,args.folder);return {};}
    if(method==='tab.new'){addTab(spaces.find(s=>s.id===args.space),args.name,args.folder);return {};}
    if(method==='tab.move'){const space=spaces.find(s=>s.tabs.some(t=>t.id===args.id)),index=space.tabs.findIndex(t=>t.id===args.id);space.tabs.splice(args.index-1,0,...space.tabs.splice(index,1));return {};}
    if(method==='space.select'){for(const s of spaces)s.active=s.id===args.id;return {};}
    if(method==='tab.select'){const space=spaces.find(s=>s.tabs.some(t=>t.id===args.id));for(const tab of space.tabs)tab.active=tab.id===args.id;hooks.selected?.(spaces);return {};}
    throw new Error('Unexpected mutation '+method);
  };
  const getTerminal=async id=>structuredClone(terminals.get(id));
  return {root,files,home,desk,game,calls,hooks,spaces,terminals,appCall,getTerminal,open:()=>openDeskSpace({desk,appCall,getTerminal})};
}

test('new file-managed desk opens actual files first; retries do not create tabs or terminals',async t=>{
  const f=fixture(t),first=await f.open(),again=await f.open();
  assert.equal(first.displayFolder,f.files);assert.equal(first.home,f.home);assert.equal(first.verified,true);
  assert.equal(again.terminalId,first.terminalId);assert.equal(f.terminals.size,1);
  assert.equal(f.spaces[1].folder,f.files);assert.equal(f.spaces[1].tabs[0].name,'Desk files');
  assert.deepEqual(f.spaces[0].tabs,f.game.tabs);
});

test('legacy desk reuses existing files tab, preserves fallback and private shell, and reselects files',async t=>{
  const f=fixture(t,{legacy:true,existing:true}),before=structuredClone(f.spaces[1]),result=await f.open();
  assert.equal(f.spaces[1].folder,f.home,'native fallback is not rewritten');
  assert.equal(result.tabId,before.tabs[1].id);assert.equal(f.spaces[1].tabs[1].id,before.tabs[0].id);
  f.spaces[1].tabs.forEach(tab=>tab.active=tab.id===before.tabs[0].id);
  await f.open();assert.equal(f.spaces[1].tabs[0].active,true);assert.equal(f.terminals.size,2);
  assert.equal(f.calls.some(c=>c.method==='tab.new'||c.method==='space.new'),false);
  assert.deepEqual(f.spaces[0].tabs,f.game.tabs);
});

test('legacy desk missing browse tab gains exactly one without changing its shell cwd',async t=>{
  const f=fixture(t,{legacy:true}),original=structuredClone(f.terminals.get('t1'));
  await f.open();await f.open();assert.equal(f.terminals.size,2);assert.deepEqual(f.terminals.get('t1'),original);
  assert.equal(f.calls.filter(c=>c.method==='tab.new').length,1);
});

test('agent named Desk files is never adopted or moved as a browsing shell',async t=>{
  const f=fixture(t,{existing:true});f.terminals.get('t1').labels={'codex.worker':'agent','codex.task':'task'};
  const result=await f.open();assert.notEqual(result.terminalId,'t1');assert.equal(f.spaces[1].tabs[1].terminals[0].terminal,'t1');
  assert.equal(f.terminals.get('t1').cwd,f.files);
});

test('foreign, remote and ambiguous spaces cannot be implicitly adopted',async t=>{
  const f=fixture(t,{legacy:true,existing:true});
  await assert.rejects(openDeskSpace({...f,spaceId:'game'}),/does not match/);
  f.spaces.push({...structuredClone(f.spaces[1]),id:'copy',folder:f.files});
  await assert.rejects(f.open(),/Several native spaces/);
  f.spaces[2].machine='remote';const result=await f.open();assert.equal(result.spaceId,'desk');
});

test('missing or aliased files root fails before native mutation',async t=>{
  const f=fixture(t),alias=join(f.root,'alias');symlinkSync(f.files,alias);f.desk.fileTemplate.root=alias;
  await assert.rejects(f.open(),/must exist and be canonical/);assert.equal(f.calls.length,0);
  f.desk.fileTemplate.root=join(f.root,'absent');await assert.rejects(f.open(),/must exist and be canonical/);assert.equal(f.calls.length,0);
});

test('focus change is reported without touching another project or claiming success',async t=>{
  const f=fixture(t,{existing:true});f.hooks.selected=spaces=>{spaces.forEach(s=>s.active=s.id==='game');};
  await assert.rejects(f.open(),/selection changed/);assert.deepEqual(f.spaces[0].tabs,f.game.tabs);
  assert.equal(f.calls.some(c=>/close|send|keys/.test(c.method)),false);
});
