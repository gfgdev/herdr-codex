import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {Desks} from '../src/desks.mjs';
import {Requests} from '../src/requests.mjs';
import {Retirement} from '../src/retirement.mjs';
import {deskOverview} from '../src/desk-overview.mjs';
import {deskCommand} from '../src/desk-cli.mjs';

const THREAD='01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const OTHER='01a1d317-b5d9-7530-8623-f60c0df12d38';

function fixture(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-overview-')));
  const stateDir=join(directory,'state');mkdirSync(stateDir);
  const checkout=join(directory,'checkout');mkdirSync(checkout);
  const other=join(directory,'other');mkdirSync(other);
  const config={stateDir},store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});
  const retirement=new Retirement(store,{});
  const requests=new Requests(store,{retirement});
  desks.create({id:'bpm',name:'BPM',purpose:'Test client operations'});
  desks.projectAdd({deskId:'bpm',id:'app',name:'App checkout',path:checkout});
  desks.definitionPut({deskId:'bpm',id:'analyst',name:'Analyst',harness:'goose',scope:'write',instructions:'Inspect evidence.'});
  const startWorker=(id,taskId,threadId,project,{write=false}={})=>{
    const fields={deskId:'bpm',deskProjectId:project===checkout?'app':'home'};
    store.saveTask({id:taskId,name:id,project,threadId,status:'active',...fields});
    const worker={id,taskId,name:id,project,role:'goose',terminalId:'term-'+id,mailbox:'mail-'+id,
      ...fields,deskDefinitionId:'analyst',deskDefinitionVersion:1,launchState:'running'};
    if(write)store.reserveWorker({...worker,writePaths:[project]});else store.saveWorker(worker);
    return store.worker(id);
  };
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,stateDir,config,store,desks,retirement,requests,checkout,other,startWorker};
}

test('overview projects recorded desk, projects, agents, counts and reservations without report contents',t=>{
  const f=fixture(t);
  const worker=f.startWorker('w1','task-w1',THREAD,f.checkout,{write:true});
  f.store.ingest(worker,{id:'msg-1',taskId:'task-w1',workerId:'w1',terminalId:'term-w1',kind:'question',text:'secret-report-text',createdAt:new Date().toISOString()});
  f.requests.reserve(worker,'req-1','message',{text:'queued-note'});

  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm'});

  assert.equal(view.version,1);
  assert.equal(view.verification.live,false);
  assert.match(view.verification.note,/Recorded integration records only/);
  assert.equal(view.desk.id,'bpm');
  assert.equal(view.filter.threadId,null);

  // Registered project IDs/paths, including the implicit home project.
  assert.equal(view.projects.total,2);
  assert.deepEqual(view.projects.items.map(p=>p.id).sort(),['app','home']);
  assert.ok(view.projects.items.find(p=>p.id==='app').path===f.checkout);

  // Agent/task/role identity, owner chat, terminal and recorded lifecycle.
  assert.equal(view.agents.total,1);
  const agent=view.agents.items[0];
  assert.equal(agent.agentId,'w1');
  assert.equal(agent.taskId,'task-w1');
  assert.equal(agent.role,'analyst');
  assert.equal(agent.ownerChat,THREAD);
  assert.equal(agent.terminal,'term-w1');
  assert.equal(agent.lifecycle.launchState,'running');
  assert.equal(agent.lifecycle.taskStatus,'active');
  assert.equal(agent.pendingReports,1);
  assert.equal(agent.pendingRequests,1);
  assert.equal(view.totals.pendingReports,1);
  assert.equal(view.totals.pendingRequests,1);

  // Exact-checkout writer reservations expose ownership, never report bodies.
  assert.equal(view.reservations.total,1);
  assert.equal(view.reservations.items[0].workerId,'w1');
  assert.deepEqual(view.reservations.items[0].paths,[f.checkout]);
  assert.equal(view.reservations.items[0].retained,false);
  assert.equal(view.reservations.threaded,false);
  assert.equal(JSON.stringify(view).includes('secret-report-text'),false);
  assert.equal(JSON.stringify(view).includes('queued-note'),false);

  // Bounded lists expose totals and truncation.
  const clipped=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',limit:1});
  assert.equal(clipped.projects.total,2);
  assert.equal(clipped.projects.items.length,1);
  assert.equal(clipped.projects.truncated,true);
  assert.equal(clipped.truncated,true);
});

test('thread filter narrows agents but never hides another owner blocking reservation',t=>{
  const f=fixture(t);
  f.startWorker('w1','task-w1',THREAD,f.checkout,{write:true});
  f.startWorker('w2','task-w2',OTHER,f.other);

  const filtered=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',threadId:OTHER});

  assert.equal(filtered.filter.threadId,OTHER);
  assert.equal(filtered.agents.total,1);
  assert.equal(filtered.agents.items[0].agentId,'w2');
  assert.equal(filtered.totals.agents,2);
  assert.equal(filtered.totals.agentsShown,1);
  // w1 belongs to the other chat and its checkout is outside the app project;
  // the reservation on the desk checkout is still reported with minimal metadata.
  assert.equal(filtered.reservations.total,1);
  assert.equal(filtered.reservations.items[0].workerId,'w1');
  assert.equal(JSON.stringify(filtered.reservations.items[0]).includes('text'),false);

  const scopedToOther=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',threadId:OTHER});
  assert.equal(scopedToOther.reservations.total,1);
});

test('stopped worker with a retained writer lease reports ownership honestly',t=>{
  const f=fixture(t);
  const worker=f.startWorker('w1','task-w1',THREAD,f.checkout,{write:true});
  f.store.saveWorker({...worker,launchState:'stopped'});
  f.store.db.prepare('INSERT INTO retirements VALUES(?,?,?,?,?)').run(
    'w1','exec-w1','pending_retirement',JSON.stringify({workerId:'w1',state:'pending_retirement'}),new Date().toISOString());

  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm'});
  const agent=view.agents.items[0];
  assert.equal(agent.lifecycle.launchState,'stopped');
  assert.equal(agent.lifecycle.retirementState,'pending_retirement');
  assert.equal(agent.writerLeaseHeld,true);
  assert.equal(agent.ownership.held,true);
  assert.equal(agent.ownership.stoppedButHeld,true);
  assert.equal(agent.ownership.retained,true);
  assert.equal(view.reservations.items[0].retained,true);
  assert.equal(view.reservations.items[0].recordedLaunchState,'stopped');
});

test('pending retirement alone is retained, not stoppedButHeld',t=>{
  const f=fixture(t);
  const worker=f.startWorker('w1','task-w1',THREAD,f.checkout,{write:true});
  f.store.saveWorker({...worker,launchState:'running'});
  f.store.db.prepare('INSERT INTO retirements VALUES(?,?,?,?,?)').run(
    'w1','exec-w1','pending_retirement',JSON.stringify({workerId:'w1',state:'pending_retirement'}),new Date().toISOString());

  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm'});
  const agent=view.agents.items[0];
  // A recorded running launch state is NOT stopped, so pending retirement must
  // not be reported as stopped-but-held.
  assert.equal(agent.lifecycle.launchState,'running');
  assert.equal(agent.lifecycle.retirementState,'pending_retirement');
  assert.equal(agent.ownership.held,true);
  assert.equal(agent.ownership.retained,true);
  assert.equal(agent.ownership.stoppedButHeld,false);
  // Reservation metadata keeps retained separate from recorded stop state.
  assert.equal(view.reservations.items[0].retained,true);
  assert.equal(view.reservations.items[0].recordedLaunchState,'running');
});

test('malformed request records are explicit unknown with bounded, metadata-only reasons',t=>{
  const f=fixture(t);
  f.startWorker('w1','task-w1',THREAD,f.checkout);
  f.startWorker('w2','task-w2',OTHER,f.other);
  const insert=(workerId,requestId,data)=>f.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)')
    .run(workerId,requestId,'fp',data);
  insert('w1','r-empty','{}');                                   // missing identity
  insert('w1','r-num','42');                                     // not an object
  insert('w1','r-null','null');                                  // not an object
  insert('w1','r-state','{"workerId":"w1","requestId":"r-state","state":"bogus"}'); // unknown state
  insert('w1','r-json','{');                                     // malformed JSON
  insert('w1','r-foreign','{"workerId":"w2","requestId":"r-foreign","state":"queued"}'); // worker mismatch
  insert('w1','r-row','{"workerId":"w1","requestId":"different","state":"queued"}'); // row mismatch
  insert('w2','r-empty2','{}');                                  // second worker

  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm'});
  const reasons=view.errors.items.map(item=>item.reason);
  for(const reason of ['missing-worker-id','not-an-object','unknown-state','malformed-json','worker-mismatch','row-mismatch'])
    assert.ok(reasons.includes(reason),'expected reason '+reason);
  assert.equal(view.errors.total,8);
  assert.equal(view.errors.items.length,8);
  assert.equal(view.errors.truncated,false);
  assert.equal(typeof view.errors.note,'string');

  // A malformed or unclassifiable record makes the affected counts unknown (null),
  // never a misleading zero, and never exposes raw record content.
  assert.equal(view.totals.pendingRequests,null);
  for(const agent of view.agents.items){
    assert.equal(agent.pendingRequests,null);
    assert.ok(['missing-worker-id','not-an-object','unknown-state','malformed-json','worker-mismatch','row-mismatch'].includes(agent.requestError));
  }
  for(const item of view.errors.items) assert.deepEqual(Object.keys(item).sort(),['reason','row','workerId']);
  assert.equal(JSON.stringify(view).includes('bogus'),false);
  assert.equal(JSON.stringify(view).includes('different'),false);
});

test('a request query failure is unknown and metadata-only, never zero',t=>{
  const f=fixture(t);
  f.startWorker('w1','task-w1',THREAD,f.checkout);
  const realPrepare=f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare=sql=>{
    if(String(sql).includes('FROM agent_requests'))throw new Error('simulated query failure: /secret/path');
    return realPrepare(sql);
  };
  try{
    const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm'});
    assert.equal(view.agents.items[0].pendingRequests,null);
    assert.equal(view.agents.items[0].requestError,'read-failed');
    assert.equal(view.totals.pendingRequests,null);
    assert.equal(view.errors.total,1);
    assert.deepEqual(view.errors.items[0],{workerId:'w1',row:null,reason:'read-failed'});
    // Raw error text must not be echoed into the projection.
    assert.equal(JSON.stringify(view).includes('simulated query failure'),false);
    assert.equal(JSON.stringify(view).includes('/secret/path'),false);
  }finally{
    f.store.db.prepare=realPrepare;
  }
});

test('valid request lifecycle states still classify without errors',t=>{
  const f=fixture(t);
  const worker=f.startWorker('w1','task-w1',THREAD,f.checkout);
  f.requests.reserve(worker,'req-open','message',{text:'note'});           // queued -> open
  const closed=f.requests.reserve(worker,'req-closed','task',{description:'d'}); // prepared
  f.requests.save({...closed,state:'sent'});                               // terminal

  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm'});
  assert.equal(view.errors.total,0);
  assert.deepEqual(view.errors.items,[]);
  assert.equal(view.agents.items[0].requestError,null);
  assert.equal(view.agents.items[0].pendingRequests,1);
  assert.equal(view.totals.pendingRequests,1);
});

test('request-record errors are capped with total and truncation',t=>{
  const f=fixture(t);
  f.startWorker('w1','task-w1',THREAD,f.checkout);
  f.startWorker('w2','task-w2',OTHER,f.other);
  const insert=(workerId,requestId,data)=>f.store.db.prepare('INSERT INTO agent_requests VALUES(?,?,?,?)')
    .run(workerId,requestId,'fp',data);
  for(let i=0;i<6;i++){insert('w1','w1-'+i,'{}');insert('w2','w2-'+i,'42');}

  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',limit:5});
  assert.equal(view.errors.total,12);
  assert.equal(view.errors.items.length,5);
  assert.equal(view.errors.truncated,true);
  assert.equal(view.truncated,true);
  for(const item of view.errors.items){
    assert.ok(typeof item.workerId==='string');
    assert.ok(item.reason==='missing-worker-id'||item.reason==='not-an-object');
  }
});

test('absent agent_requests table genuinely means zero pending, with no error',t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'herdr-desk-overview-')));
  const stateDir=join(directory,'state');mkdirSync(stateDir);
  const checkout=join(directory,'checkout');mkdirSync(checkout);
  const config={stateDir},store=new Store(join(stateDir,'manager.sqlite')),desks=new Desks({store,config});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  desks.create({id:'bpm',name:'BPM',purpose:'Test client operations'});
  desks.projectAdd({deskId:'bpm',id:'app',name:'App checkout',path:checkout});
  // Deliberately do NOT construct Requests: the table is genuinely absent.
  store.saveTask({id:'task-w1',name:'w1',project:checkout,threadId:THREAD,status:'active',deskId:'bpm',deskProjectId:'app'});
  store.saveWorker({id:'w1',taskId:'task-w1',name:'w1',project:checkout,role:'goose',terminalId:'term-w1',mailbox:'mail-w1',
    deskId:'bpm',deskProjectId:'app',deskDefinitionId:'analyst',deskDefinitionVersion:1,launchState:'running'});
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_requests'").get(),undefined);
  const view=deskOverview({store,config,desks,deskId:'bpm'});
  assert.equal(view.agents.items[0].pendingRequests,0);
  assert.equal(view.agents.items[0].requestError,null);
  assert.equal(view.errors.total,0);
  assert.deepEqual(view.errors.items,[]);
  assert.equal(view.totals.pendingRequests,0);
});

test('clipped overview reports the returned agent count and the public deskCommand path agrees',async t=>{
  const f=fixture(t);
  for(let i=0;i<30;i++)f.startWorker('w'+(i+1),'task-w'+(i+1),THREAD,f.checkout);
  const view=deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',limit:25});
  assert.equal(view.agents.total,30);
  assert.equal(view.agents.items.length,25);
  assert.equal(view.totals.agents,30);
  assert.equal(view.totals.agentsShown,25);
  assert.equal(view.truncated,true);
  // The public CLI command path reports the same clipped count.
  const viaCli=await deskCommand({action:'overview',values:{id:'bpm',limit:'5'},store:f.store,config:f.config});
  assert.equal(viaCli.agents.total,30);
  assert.equal(viaCli.agents.items.length,5);
  assert.equal(viaCli.totals.agentsShown,5);
  assert.equal(viaCli.truncated,true);
});

test('overview rejects unknown desks and invalid filters, and stays read-only',t=>{
  const f=fixture(t);
  assert.throws(()=>deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'missing'}),/Unknown desk/);
  assert.throws(()=>deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',threadId:'not-a-uuid'}),/manager chat UUID/);
  assert.throws(()=>deskOverview({store:f.store,config:f.config,desks:f.desks,deskId:'bpm',limit:0}),/limit/);
  // No worker/task rows were created by the read-only projection.
  assert.equal(f.store.workers().length,0);
  assert.equal(f.store.tasks().length,0);
});
