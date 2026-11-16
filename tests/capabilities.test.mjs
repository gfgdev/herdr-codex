import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {NativeCapabilities,REQUIRED_CORE_METHODS,REQUIRED_APP_COMMANDS,capabilityCommand} from '../src/capabilities.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'herdr-capability-')),calls=[];
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const hc=join(root,'hc'),app=join(root,'herdr-app');
  for(const path of [hc,app])writeFileSync(path,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const schema={openrpc:'1.3.2',info:{title:'herdr-core',version:'1.0'},components:{schemas:{
    Terminal:{type:'object',properties:Object.fromEntries(['address','cwd','state','labels','pid','status','turn'].map(name=>[name,{type:'string'}]))},
    SubscribeResult:{type:'object',properties:{seq:{type:'integer'},terminals:{type:'array',items:{$ref:'#/components/schemas/Terminal'}}}},
    DocGetResult:{type:'object',properties:{version:{type:'integer'},value:{}}},
  }},methods:Object.entries(REQUIRED_CORE_METHODS).map(([name,params])=>({name,description:name==='events.subscribe'?'Every status, turn, lost, restarted, removed, finished, doc change as event; heartbeat and missed.':'Native '+name,
    params:params.map(name=>({name,required:true,schema:{type:'string'}})),result:{name:'result',schema:
      name==='events.subscribe'?{$ref:'#/components/schemas/SubscribeResult'}:name==='terminal.get'?{$ref:'#/components/schemas/Terminal'}:name==='doc.get'?{$ref:'#/components/schemas/DocGetResult'}:{type:'object'}}}))};
  const commands=REQUIRED_APP_COMMANDS.map(name=>({name,args:[],about:'Native '+name}));
  const bundles=new Map([[hc,{version:'hc 1.0',schema}],[app,{version:'app 1.0',commands}]]);
  const probe=async(exe,args)=>{
    calls.push({exe,args});const bundle=bundles.get(exe);if(!bundle)throw new Error('Unexpected executable');
    if(args[0]==='--version')return bundle.version;
    if(args[0]==='--help')return 'Native complete help '+bundle.version;
    if(args[0]==='--skill')return 'Native guide '+bundle.version;
    if(args[0]==='schema')return bundle.rawSchema??JSON.stringify(bundle.schema);
    if(args[0]==='commands')return bundle.rawCommands??JSON.stringify(bundle.commands);
    throw new Error('Mutation attempted by discovery: '+args.join(' '));
  };
  const config={stateDir:join(root,'state'),hc,app,profileFile:join(root,'must-not-read-credentials.json')};
  const catalog=new NativeCapabilities({config,probe});
  return {root,hc,app,config,catalog,probe,calls,schema,commands,bundles,
    candidate(){const ch=join(root,'candidate-hc'),ca=join(root,'candidate-app');for(const path of [ch,ca])writeFileSync(path,'candidate-binary');
      bundles.set(ch,structuredClone(bundles.get(hc)));bundles.set(ca,structuredClone(bundles.get(app)));return {hc:ch,app:ca};}};
}

test('native inventories and guides are revisioned without assuming behavioral qualification',async t=>{
  const f=fixture(t),first=await f.catalog.inspect(),again=await f.catalog.inspect();
  assert.equal(first.revision,again.revision);assert.equal(first.compatibility.status,'requirements-present');
  assert.equal(first.compatibility.behavior,'not-verified');assert.equal(first.compatibility.activationRecommended,false);
  assert.equal(first.entries.length,Object.keys(REQUIRED_CORE_METHODS).length+REQUIRED_APP_COMMANDS.length+4);
  assert.ok(first.entries.some(e=>e.id==='core:skill'));
  assert.equal(existsSync(f.config.profileFile),false);
  assert.ok(f.calls.every(c=>['--version','--help','--skill','schema','commands'].includes(c.args[0])));
  assert.equal((await f.catalog.status()).nativeAccess,'unrestricted-by-catalog');
});

test('unknown future method and desktop command become searchable without wrapper registration',async t=>{
  const f=fixture(t),before=await f.catalog.inspect();
  f.schema.methods.push({name:'future.inspect',description:'Inspect new native artifacts',params:[{name:'artifact',schema:{type:'string'},required:true}],result:{name:'result',schema:{type:'object'}}});
  f.commands.push({name:'future.panel',args:[{name:'artifact',required:false}],about:'Open a future artifact panel'});
  const result=await f.catalog.search('future');assert.equal(result.total,2);assert.notEqual(result.revision,before.revision);
  const detail=await f.catalog.describe('core:future.inspect');assert.equal(detail.available,true);assert.equal(detail.definition.method.params[0].name,'artifact');
  const current=await f.catalog.inspect();assert.deepEqual(current.change.added,['app:future.panel','core:future.inspect']);assert.equal(current.compatibility.status,'requirements-present');
});

test('same-version launcher or inventory changes invalidate stale descriptions',async t=>{
  const f=fixture(t),first=await f.catalog.inspect();
  writeFileSync(f.hc,'#!/bin/sh\n# revised binary same version\nexit 0\n');
  const second=await f.catalog.inspect();assert.notEqual(second.revision,first.revision);assert.equal(second.runtime.core.version,first.runtime.core.version);
  f.schema.methods.find(m=>m.name==='terminal.get').description='Now includes another field.';
  const third=await f.catalog.inspect();assert.notEqual(third.revision,second.revision);
  assert.deepEqual(await f.catalog.describe('core:terminal.get',{revision:first.revision}),{revision:third.revision,stale:true,requestedRevision:first.revision,note:'Catalog changed; search or describe again using the current revision.'});
});

test('explicit underlying binary identity catches same-version changes behind stable launchers',async t=>{
  const f=fixture(t),binary=join(f.root,'native-core-binary');writeFileSync(binary,'first binary');
  f.config.nativeExecutables={core:binary};const first=await f.catalog.inspect();writeFileSync(binary,'other binary');
  const second=await f.catalog.inspect();assert.notEqual(second.revision,first.revision);
  assert.equal(first.runtime.core.launcher.sha256,second.runtime.core.launcher.sha256);
  assert.notEqual(first.runtime.core.binary.sha256,second.runtime.core.binary.sha256);
  assert.deepEqual(second.identityCoverage.explicitBinaryHashes,['core']);
});

test('candidate missing integration method is incompatible and never replaces selected runtime catalog',async t=>{
  const f=fixture(t),selected=await f.catalog.inspect(),candidate=f.candidate();
  f.bundles.get(candidate.hc).schema.methods=f.bundles.get(candidate.hc).schema.methods.filter(m=>m.name!=='terminal.label');
  const report=await f.catalog.check(candidate);
  assert.equal(report.compatibility.status,'incompatible');assert.equal(report.activated,false);
  assert.ok(report.compatibility.missing.some(m=>m.name==='terminal.label'));
  assert.ok(report.compatibility.diff.removed.includes('core:terminal.label'));
  assert.equal(JSON.parse(readFileSync(join(f.config.stateDir,'capabilities/current.json'))).revision,selected.revision);
  assert.equal(f.config.hc,f.hc);assert.equal(f.config.app,f.app);
});

test('referenced result schema changes and event prose changes require review before activation',async t=>{
  const f=fixture(t);await f.catalog.inspect();const candidate=f.candidate(),s=f.bundles.get(candidate.hc).schema;
  s.components.schemas.Terminal.properties.status={type:'object',properties:{newState:{type:'string'}}};
  s.methods.find(m=>m.name==='events.subscribe').description='Delivery changed to activity notifications.';
  const report=await f.catalog.check(candidate);
  assert.equal(report.compatibility.status,'review-required');assert.equal(report.compatibility.behavior,'not-verified');
  assert.ok(report.compatibility.review.some(r=>r.id==='core:terminal.get'));
  assert.ok(report.compatibility.review.some(r=>r.id==='core:events.subscribe'));
  assert.equal(report.compatibility.eventContract.machineReadableNotificationSchema,false);
});

test('required result field and desktop command removals are explicit incompatibilities',async t=>{
  const f=fixture(t);await f.catalog.inspect();const candidate=f.candidate();
  delete f.bundles.get(candidate.hc).schema.components.schemas.Terminal.properties.turn;
  f.bundles.get(candidate.app).commands=f.bundles.get(candidate.app).commands.filter(c=>c.name!=='tab.move');
  const result=await f.catalog.check(candidate);assert.equal(result.compatibility.status,'incompatible');
  assert.ok(result.compatibility.missing.some(x=>x.name==='Terminal.turn'));
  assert.ok(result.compatibility.missing.some(x=>x.name==='tab.move'));
});

test('refresh and unrelated additions do not erase unresolved consumed-contract changes',async t=>{
  const f=fixture(t);await f.catalog.inspect();
  f.schema.methods.find(m=>m.name==='terminal.get').params[0].schema={type:'integer'};
  assert.equal((await f.catalog.status()).compatibility.status,'review-required');
  assert.equal((await f.catalog.status({force:true})).compatibility.status,'review-required');
  f.commands.push({name:'future.extra',args:[],about:'New panel'});
  assert.equal((await f.catalog.status()).compatibility.status,'review-required');
});

test('malformed inventories retain prior catalog and do not silently serve it as current',async t=>{
  const f=fixture(t),before=await f.catalog.inspect(),path=join(f.config.stateDir,'capabilities/current.json'),saved=readFileSync(path,'utf8');
  f.bundles.get(f.hc).rawSchema='{malformed';
  await assert.rejects(f.catalog.search('terminal'),/Malformed native schema/);assert.equal(readFileSync(path,'utf8'),saved);
  delete f.bundles.get(f.hc).rawSchema;f.schema.methods.push(structuredClone(f.schema.methods[0]));
  await assert.rejects(f.catalog.status(),/duplicate name/);assert.equal(readFileSync(path,'utf8'),saved);
  f.schema.methods.pop();f.schema.methods[0].result.schema={$ref:'#/components/schemas/Absent'};
  await assert.rejects(f.catalog.status(),/unresolved local reference/);assert.equal(JSON.parse(readFileSync(path)).revision,before.revision);
});

test('command API searches and describes full native guides without a new registered tool',async t=>{
  const f=fixture(t),call=(action,values)=>capabilityCommand({action,values,config:f.config,probe:f.probe});
  const result=await call('refresh');assert.equal(result.compatibility.behavior,'not-verified');
  const guide=await call('describe',{id:'app:skill'});assert.equal(guide.definition.text,'Native guide app 1.0');
  assert.equal((await call('describe',{id:'core:not-installed'})).available,false);
  await assert.rejects(call('check',{}),/explicit hc and app/);
  await assert.rejects(call('search',{limit:0}),/Invalid capability search/);
});

test('qualification is bound to selected core binary and does not imply desktop or host wake qualification',async t=>{
  const f=fixture(t),binary=join(f.root,'underlying-core');writeFileSync(binary,'binary');f.config.nativeExecutables={core:binary};
  let called;
  const catalog=new NativeCapabilities({config:f.config,probe:f.probe,qualificationStatus:async input=>{
    called=input;return {status:'qualified',passed:true,stale:false,reportPath:'/evidence/report.json',report:{checks:[{id:'adoption',passed:true,summary:{sha256:'evidence-hash'}}]}};
  }});
  const result=await catalog.status();assert.equal(called.values['core-binary'],binary);
  assert.equal(result.compatibility.behavior,'local-core-fixtures-passed');assert.equal(result.compatibility.behaviorScope.desktop,'not-verified');
  assert.equal(result.compatibility.behaviorScope.actualCodexHostWake,'not-verified');assert.equal(result.compatibility.activationRecommended,false);
  delete f.config.nativeExecutables;called=null;const unbound=await catalog.status();assert.equal(unbound.qualification.status,'unbound');assert.equal(called,null);
});

test('stale qualification never promotes discovered feature support',async t=>{
  const f=fixture(t);f.config.nativeExecutables={core:f.hc};
  const catalog=new NativeCapabilities({config:f.config,probe:f.probe,qualificationStatus:async()=>({status:'stale',passed:false,stale:true,reasons:['integration sources changed']})});
  const result=await catalog.status();assert.equal(result.compatibility.behavior,'not-verified');assert.equal(result.qualification.status,'stale');
});

test('real subprocess discovery does not need a native feature allowlist',async t=>{
  const f=fixture(t),data=join(f.root,'catalog.json');
  writeFileSync(data,JSON.stringify({schema:f.schema,commands:f.commands}));
  const script=`#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconst d=JSON.parse(readFileSync(${JSON.stringify(data)}));const a=process.argv[2];\nif(a==='schema')console.log(JSON.stringify(d.schema));else if(a==='commands')console.log(JSON.stringify(d.commands));else if(a==='future-native-command')console.log('future available');else console.log('fixture '+a);\n`;
  for(const path of [f.hc,f.app])writeFileSync(path,script,{mode:0o755});
  const catalog=new NativeCapabilities({config:f.config});assert.equal((await catalog.status()).compatibility.status,'requirements-present');
  assert.equal(execFileSync(f.hc,['future-native-command'],{encoding:'utf8'}).trim(),'future available');
});
