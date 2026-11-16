import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Requests, stopAttribution } from '../src/requests.mjs';
import { Delegation } from '../src/delegation.mjs';
import { Bridge } from '../src/bridge.mjs';
import { loadContext } from '../src/context.mjs';

const THREAD = '01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const clone = value => structuredClone(value);

// This transport models native effects independently from the manager database.
// Lost receipts are thrown AFTER external acceptance and retained in its ledger.
class Native {
  terminals = new Map(); calls = []; accepted = []; next = 1;
  loseRun = false; loseSend = false; rejectSend = null; replaceAfterRun = false;
  interruptKeepsWorking = false; killNoop = false; killError = null; killHook = null;
  async request(method, params) {
    this.calls.push({method, params:clone(params)});
    if (method === 'terminal.run') {
      const address = 't' + this.next++;
      const native = {address,pid:7000+this.next,state:'live',status:{state:this.initialStatus??'idle'},turn:0,cwd:params.cwd,labels:clone(params.labels),argv:clone(params.argv),keep:params.keep??false};
      this.terminals.set(address, native);
      this.accepted.push({method,address});
      const receipt = {address,pid:native.pid};
      if (this.replaceAfterRun) { native.pid += 1000; native.status={state:'idle'}; }
      if (this.loseRun) { this.loseRun=false; throw new Error('Simulated receipt lost after terminal creation'); }
      return receipt;
    }
    if (method === 'terminal.list') return {terminals:[...this.terminals.values()].filter(t=>!params.labels || Object.entries(params.labels).every(([k,v])=>t.labels[k]===v)).map(clone)};
    const native = this.terminals.get(params.terminal);
    if (!native) throw Object.assign(new Error('Unknown native terminal'),{data:{kind:'not_found'}});
    if (method === 'terminal.get') {
      if (this.beforeGetReply) { const hook=this.beforeGetReply;this.beforeGetReply=null;await hook(native); }
      return clone(native);
    }
    if (method === 'terminal.wait') return {status:native.status,turn:native.turn};
    if (method === 'terminal.read') return this.accepted.filter(c=>c.address===native.address&&c.text).map(c=>c.text).join('\n');
    if (method === 'terminal.send') {
      if (params.if && params.if!==native.status.state) throw Object.assign(new Error('Status mismatch'),{data:{kind:'status_mismatch'}});
      if (this.rejectSend) { const kind=this.rejectSend;this.rejectSend=null;throw Object.assign(new Error('Native refusal'),{data:{kind}}); }
      native.turn++;native.status={state:'working'};
      this.accepted.push({method,address:native.address,text:params.text,turn:native.turn});
      if (this.loseSend) { this.loseSend=false;throw new Error('Simulated send receipt lost after acceptance'); }
      return {started:true,status:native.status,turn:native.turn};
    }
    if (method === 'terminal.interrupt') {
      this.accepted.push({method,address:native.address});
      if (this.interruptKeepsWorking) { native.status={state:'working'}; return {status:clone(native.status),turn:native.turn,outcome:'still_working'}; }
      native.status={state:'done'};
      return {status:clone(native.status),turn:native.turn,outcome:'confirmed'};
    }
    if (method === 'terminal.kill') {
      this.accepted.push({method,address:native.address});
      if (this.killHook) { const hook=this.killHook;this.killHook=null;await hook(native); }
      if (this.killError) { const error=this.killError;this.killError=null;throw error; }
      if (this.killNoop) return {killed:false};
      native.state='finished';native.exit_code=0;native.status={state:'done'};
      return {killed:true,exit_code:0};
    }
    throw new Error('Unexpected native operation '+method);
  }
}

async function fixture(t,opts={}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'herdr-delegation-adversarial-')));
  const project=join(dir,'project'), stateDir=join(dir,'state');
  await mkdir(project);await mkdir(stateDir);await mkdir(join(project,'one'));await mkdir(join(project,'two'));
  const dbPath=join(stateDir,'manager.sqlite');
  const stores=[];const native=new Native();
  const config={stateDir,packageRoot:dir,hc:'/fake/hc',app:'/fake/app',node:process.execPath,profileFile:join(dir,'profile.json'),
    ...(opts.containmentProvider?{containmentProvider:opts.containmentProvider}:{}),
    ...(opts.trustedContainmentSources?{trustedContainmentSources:opts.trustedContainmentSources}:{})};
  const service=()=>{const store=new Store(dbPath);stores.push(store);return {store,api:new Delegation({config,store,rpc:native,prepare:async w=>({argv:['fake-agent'],cwd:w.project})})};};
  const first=service();
  t.after(async()=>{for(const s of stores)s.close();await rm(dir,{recursive:true,force:true});});
  const input=(id='agent-a',extra={})=>({id,name:id,threadId:THREAD,project,instruction:'Inspect the actual repository and report findings.',...extra});
  return {dir,project,stateDir,native,service,input,...first};
}

// A real Bridge over the same manager database and fake native transport, so a
// stop race can be observed through the production event path instead of
// calling the settlement decision directly.
function bridgeFor(f) {
  const config={stateDir:f.stateDir,packageRoot:f.dir,hc:'/fake/hc',codex:'/fake/codex',path:join(f.dir,'config.json')};
  const queue={async list(){return [];},async add(){throw new Error('queue is not used in this fixture');},
    async update(){throw new Error('queue is not used in this fixture');},async delete(){throw new Error('queue is not used in this fixture');},close(){}};
  const bridge=new Bridge(config,{clientFactory:()=>f.native,queue});
  bridge.rpc=f.native;
  return bridge;
}

// Start a stop, wait until its dispatch is durably in flight, then mark the
// original finished so the exit is observed BEFORE the kill receipt resolves.
// Returns the pending stop promise and the gate that releases the receipt.
async function startGatedStop(f) {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.native.killHook=async()=>{await gate;};
  const pending=f.api.stop('agent-a','stop-1');
  for(let i=0;i<50&&f.store.meta('stop:agent-a').dispatch!=='dispatching';i++) await new Promise(r=>setImmediate(r));
  assert.equal(f.store.meta('stop:agent-a').dispatch,'dispatching','the signal is durably in flight before its receipt');
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=143;
  return {pending,release};
}

test('a stored stop attribution survives replay and is never rewritten by a later observation', () => {
  // A confirmed non-intentional resolution must not be re-labelled intentional
  // on replay: the stored verdict is authoritative.
  assert.equal(stopAttribution({ state: 'confirmed', attribution: 'already-exited' }, 'process_finished'), 'already-exited');
  assert.equal(stopAttribution({ state: 'confirmed', attribution: 'unattributed' }, 'process_finished'), 'unattributed');
  // An acknowledged dispatch is the only pending-free signal that makes an exit intentional.
  assert.equal(stopAttribution({ dispatch: 'accepted' }, 'process_finished'), 'intentional');
  // A dispatch still in flight is NOT acceptance.
  assert.equal(stopAttribution({ state: 'requested', dispatch: 'dispatching' }, 'process_finished'), 'unattributed');
  // A never-dispatched stop of an already-finished original is already-exited, not intentional.
  assert.equal(stopAttribution({ dispatch: 'not-dispatched', alreadyExited: true }, 'process_finished'), 'already-exited');
  // A refused or unknown transport is never intentional.
  assert.equal(stopAttribution({ dispatch: 'refused' }, 'process_finished'), 'unattributed');
  assert.equal(stopAttribution({ dispatch: 'uncertain' }, 'process_finished'), 'unattributed');
});

test('lost terminal creation receipt is recovered without another launch',async t=>{
  const f=await fixture(t);f.native.loseRun=true;
  await assert.rejects(f.api.delegate(f.input()),/receipt lost/);
  const second=f.service();
  const retry=await second.api.delegate(f.input());
  assert.equal(retry.launchState,'uncertain');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.run').length,1);
  await second.api.recover('agent-a');
  await second.api.delegate(f.input());
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.run').length,1);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,1);
});

test('lost initial prompt receipt survives reopening and identical retry without resending',async t=>{
  const f=await fixture(t);f.native.loseSend=true;
  await assert.rejects(f.api.delegate(f.input()),/receipt lost/);
  const other=f.service();const retry=await other.api.delegate(f.input());
  assert.equal(retry.request.state,'uncertain');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,1);
  await assert.rejects(other.api.followup('agent-a','next',{instruction:'New instruction'}),/Resolve request|Initial assignment/);
});

test('receipt persisted but caller loses response: repeated delegate has one native prompt',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  const other=f.service();const retry=await other.api.delegate(f.input());
  assert.equal(retry.request.state,'sent');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,1);
  await assert.rejects(other.api.delegate(f.input('agent-a',{instruction:'Changed task'})),/different frozen/);
  await assert.rejects(other.api.delegate(f.input('agent-a',{harness:'goose'})),/different frozen/);
  await assert.rejects(other.api.delegate(f.input('agent-a',{scope:'write'})),/different frozen/);
});

test('two simultaneous claims of one follow-up perform one external send',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());const other=f.service();
  const results=await Promise.all([f.api.followup('agent-a','follow-1',{instruction:'Review parser'}),other.api.followup('agent-a','follow-1',{instruction:'Review parser'})]);
  assert.ok(results.every(r=>['sending','sent'].includes(r.state)));
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,2);
  assert.equal(f.api.requests.get('agent-a','follow-1').state,'sent');
});

test('simultaneous writers with disjoint paths in one checkout cannot both launch',async t=>{
  const f=await fixture(t);const other=f.service();
  const results=await Promise.allSettled([f.api.delegate(f.input('writer-a',{scope:'write',writePaths:[join(f.project,'one')]})),other.api.delegate(f.input('writer-b',{scope:'write',writePaths:[join(f.project,'two')]}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.run').length,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
});

test('concurrent readers share one checkout and writers can use separate checkouts',async t=>{
  const f=await fixture(t);const other=f.service();
  await Promise.all([f.api.delegate(f.input('reader-a')),other.api.delegate(f.input('reader-b'))]);
  const project2=join(f.dir,'project2');await mkdir(project2);
  await Promise.all([f.api.delegate(f.input('writer-a',{scope:'write'})),other.api.delegate(f.input('writer-b',{project:project2,scope:'write'}))]);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.run').length,4);
});

test('idle messages remain queued, then attach once through uncertain follow-up recovery',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());f.native.terminals.get('t1').status={state:'done'};
  await f.api.message('agent-a','note-1',{instruction:'FIRST QUEUED NOTE'});
  await f.api.message('agent-a','note-2',{instruction:'SECOND QUEUED NOTE',mode:'queue'});
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,1);
  f.native.loseSend=true;
  await assert.rejects(f.api.followup('agent-a','follow-1',{instruction:'Resume with notes'}),/receipt lost/);
  const retry=await f.api.followup('agent-a','follow-1',{instruction:'Resume with notes'});
  assert.equal(retry.state,'uncertain');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,2);
  assert.equal(f.api.requests.get('agent-a','note-1').state,'attached');
  f.api.requests.reconcile('agent-a','follow-1','Native text contains the saved exact prompt and both notes.');
  await f.api.followup('agent-a','follow-2',{instruction:'Next task'});
  const sends=f.native.accepted.filter(x=>x.method==='terminal.send');
  assert.match(sends[1].text,/FIRST QUEUED NOTE/);assert.match(sends[1].text,/SECOND QUEUED NOTE/);
  assert.doesNotMatch(sends[2].text,/FIRST QUEUED NOTE|SECOND QUEUED NOTE/);
});

test('an uncertain inline message blocks a later follow-up until it is resolved',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  f.native.loseSend=true;
  await assert.rejects(f.api.message('agent-a','inline-1',{instruction:'Inline note'}),/receipt lost/);
  assert.equal(f.api.requests.get('agent-a','inline-1').state,'uncertain');
  await assert.rejects(f.api.followup('agent-a','after-inline',{instruction:'Must wait for the inline note'}),/Resolve request inline-1/);
  assert.equal(f.api.requests.get('agent-a','after-inline').state,'prepared');
  // Resolving the inline note releases the barrier and the reserved follow-up flows.
  f.api.requests.reconcile('agent-a','inline-1','Transcript shows the inline note was consumed.');
  await f.api.followup('agent-a','after-inline',{instruction:'Must wait for the inline note'});
  assert.match(f.native.accepted.at(-1).text,/Must wait for the inline note/);
});

test('a prepared ordinary assignment is blocked by a later uncertain interrupt',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  const worker=f.store.worker('agent-a');
  f.api.requests.reserve(worker,'prepared-a','followup',{instruction:'PREPARED-ALPHA',context:null});
  f.native.interruptKeepsWorking=true;
  const interrupted=await f.api.interrupt('agent-a','stop-later');
  assert.equal(interrupted.state,'uncertain');
  await assert.rejects(f.api.followup('agent-a','prepared-a',{instruction:'PREPARED-ALPHA'}),/Resolve request stop-later/);
  assert.equal(f.api.requests.get('agent-a','prepared-a').state,'prepared');
  // Confirming the later interrupt releases the earlier prepared assignment.
  f.native.interruptKeepsWorking=false;
  f.native.terminals.get('t1').status={state:'idle'};f.native.terminals.get('t1').turn=2;
  await f.api.interrupt('agent-a','stop-later');
  await f.api.followup('agent-a','prepared-a',{instruction:'PREPARED-ALPHA'});
  assert.match(f.native.accepted.at(-1).text,/PREPARED-ALPHA/);
});

test('an earlier initial can still proceed past a later refused prepared assignment',async t=>{
  const f=await fixture(t);f.native.initialStatus='blocked';
  const launched=await f.api.delegate(f.input());assert.equal(launched.request.state,'prepared');
  // A later follow-up is refused while the initial is unresolved, so it is
  // durably reserved as prepared and must not deadlock the earlier initial.
  f.native.terminals.get('t1').status={state:'idle'};
  await assert.rejects(f.api.followup('agent-a','later-refused',{instruction:'LATER-REFUSED'}));
  assert.equal(f.api.requests.get('agent-a','later-refused').state,'prepared');
  const resumed=await f.api.delegate(f.input());
  assert.equal(resumed.request.state,'sent');
  await f.api.followup('agent-a','later-refused',{instruction:'LATER-REFUSED'});
  const sends=f.native.accepted.filter(x=>x.method==='terminal.send');
  assert.match(sends[0].text,/Inspect the actual repository/);
  assert.match(sends[1].text,/LATER-REFUSED/);
});

test('known native refusal returns attached notes for a different future follow-up',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  await f.api.message('agent-a','note',{instruction:'Preserved note',mode:'queue'});
  f.native.rejectSend='blocked';
  await assert.rejects(f.api.followup('agent-a','refused',{instruction:'Attempt'}),/Native refusal/);
  assert.equal(f.api.requests.get('agent-a','note').state,'queued');
  await f.api.followup('agent-a','retry-new',{instruction:'Now permitted'});
  assert.match(f.native.accepted.at(-1).text,/Preserved note/);
});

test('selected context is frozen; source file changes do not change a prepared retry',async t=>{
  const f=await fixture(t);const source=join(f.dir,'brief.md');await writeFile(source,'ORIGINAL CONTEXT');
  const input=f.input('agent-a',{context:loadContext(source)});
  f.native.loseRun=true;await assert.rejects(f.api.delegate(input));
  await writeFile(source,'CHANGED CONTEXT');
  await f.api.recover('agent-a');await f.api.delegate(input);
  const sends=f.native.accepted.filter(x=>x.method==='terminal.send');
  assert.match(sends[0].text,/ORIGINAL CONTEXT/);assert.doesNotMatch(sends[0].text,/CHANGED CONTEXT/);
  await assert.rejects(f.api.delegate({...input,context:loadContext(source)}),/different frozen/);
});

test('closed task, changed process and quarantined worker reject new activation',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  const worker=f.store.worker('agent-a'),task=f.store.task(worker.taskId);
  f.store.saveTask({...task,status:'closed'});
  await assert.rejects(f.api.followup('agent-a','closed',{instruction:'Must not restart'}),/closed/);
  f.store.saveTask(task);const native=f.native.terminals.get('t1');native.pid++;
  await assert.rejects(f.api.followup('agent-a','replaced',{instruction:'Must not send'}),/identity/);
  native.pid--;f.store.meta('observation:agent-a',{quarantined:true});
  await assert.rejects(f.api.followup('agent-a','quarantined',{instruction:'Must not send'}),/quarantined/);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,1);
});

test('read-only scope cannot acquire write paths through a template override',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.api.delegate(f.input('bad',{scope:'read-only',writePaths:[f.project]})),/Read-only/);
  assert.equal(f.native.accepted.length,0);
});

test('interrupt can stop a live worker even when its previous prompt receipt is uncertain',async t=>{
  const f=await fixture(t);f.native.loseSend=true;
  await assert.rejects(f.api.delegate(f.input('agent-a',{scope:'write'})),/receipt lost/);
  await f.api.interrupt('agent-a','stop-uncertain');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.interrupt').length,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
  assert.equal(f.api.requests.get('agent-a','initial').state,'uncertain');
});

test('replacement process between launch receipt and get is never accepted as the original agent',async t=>{
  const f=await fixture(t);f.native.replaceAfterRun=true;
  await assert.rejects(f.api.delegate(f.input()));
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,0);
});

test('request-level claims survive reopening and compare the complete payload',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());const worker=f.store.worker('agent-a');
  const one=new Requests(f.store),other=f.service(),two=new Requests(other.store);
  one.reserve(worker,'x','followup',{instruction:'same',context:null});
  assert.equal(one.claim(worker.id,'x',()=> 'Frozen exact wire bytes').state,'sending');
  assert.equal(two.claim(worker.id,'x',()=> 'Must not render again'),null);
  assert.equal(two.get(worker.id,'x').wireText,'Frozen exact wire bytes');
  assert.throws(()=>two.reserve(worker,'x','followup',{instruction:'different',context:null}),/different content/);
});

test('follow-up cannot overtake an initial assignment that is still awaiting readiness',async t=>{
  const f=await fixture(t);f.native.initialStatus='blocked';
  const result=await f.api.delegate(f.input());assert.equal(result.request.state,'prepared');
  f.native.terminals.get('t1').status={state:'idle'};
  await assert.rejects(f.api.followup('agent-a','too-early',{instruction:'Follow-up must happen second'}));
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,0);
  await f.api.delegate(f.input());
  await f.api.followup('agent-a','too-early',{instruction:'Follow-up must happen second'});
  const sends=f.native.accepted.filter(x=>x.method==='terminal.send');
  assert.match(sends[0].text,/Inspect the actual repository/);
  assert.match(sends[1].text,/Follow-up must happen second/);
});

test('closing a task while native identity is being checked prevents a new prompt',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  const task=f.store.task(f.store.worker('agent-a').taskId);
  f.native.beforeGetReply=async()=>f.store.saveTask({...task,status:'closed'});
  await assert.rejects(f.api.followup('agent-a','closing-race',{instruction:'Must not run after closure'}));
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.send').length,1);
});

test('lost launch receipt cannot attach a replacement shell with matching labels', async t => {
  const f=await fixture(t);
  f.native.loseRun=true;
  await assert.rejects(f.api.delegate(f.input()), /receipt lost/);
  const native=[...f.native.terminals.values()][0];
  native.argv=['/bin/sh'];native.keep=true;
  await assert.rejects(f.api.recover(f.input().id), /original launch program/);
  assert.equal(f.native.accepted.filter(r=>r.method==='terminal.send').length,0);
});

test('delivery receipts separate native injection, durable queueing and confirmed consumption',async t=>{
  const f=await fixture(t);
  const launch=await f.api.delegate(f.input());
  assert.equal(launch.request.state,'sent');
  assert.equal(launch.request.delivery,'native-injected');
  assert.match(launch.request.note,/not been confirmed to consume/);
  f.native.terminals.get('t1').status={state:'done'};
  const note=await f.api.message('agent-a','note-1',{instruction:'Queued note'});
  assert.equal(note.state,'queued'); assert.equal(note.delivery,'queued');
  // Injection alone still reports native-injected until actual evidence is recorded.
  assert.equal(f.api.requests.get('agent-a','initial').delivery,'native-injected');
  const reconciled=f.api.requests.reconcile('agent-a','initial','Terminal transcript shows the exact prompt was consumed.');
  assert.equal(reconciled.state,'sent'); assert.equal(reconciled.delivery,'confirmed');
  assert.match(reconciled.reconciliation,/transcript/);
  assert.throws(()=>f.api.requests.reconcile('agent-a','initial',''),/actual delivery evidence/);
});

test('a confirmed interrupt is tied to the original turn and records only the retained session',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  const result=await f.api.interrupt('agent-a','stop-1');
  assert.equal(result.state,'sent'); assert.equal(result.delivery,'confirmed');
  assert.equal(result.interruption.confirmed,true); assert.equal(result.interruption.gone,false);
  assert.equal(result.interruption.turnBefore,1); assert.equal(result.interruption.turnAfter,1);
  assert.match(result.note,/Session and writer lease retained/);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.interrupt').length,1);
});

test('an unobserved interrupt blocks later input, cannot be cleared by free text, and re-observes on the same-key retry',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  f.native.interruptKeepsWorking=true;
  const first=await f.api.interrupt('agent-a','stop-1');
  assert.equal(first.state,'uncertain'); assert.equal(first.delivery,'uncertain');
  assert.equal(first.interruption.confirmed,false);
  assert.match(first.note,/not yet observed stopped/);
  await assert.rejects(f.api.followup('agent-a','next',{instruction:'Must wait'}),/Resolve request stop-1/);
  // Free text must never lift a lifecycle barrier while the turn may still run.
  assert.throws(()=>f.api.requests.reconcile('agent-a','stop-1','Operator says it stopped'),/re-observing the original terminal/);
  // Same-key retry re-observes the ORIGINAL turn; it never sends a second signal.
  const retry=await f.api.interrupt('agent-a','stop-1');
  assert.equal(retry.state,'uncertain'); assert.equal(retry.interruption.confirmed,false);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.interrupt').length,1);
  await assert.rejects(f.api.followup('agent-a','still-blocked',{instruction:'No'}),/Resolve request stop-1/);
  // Only an observed stopped turn releases the barrier; then a follow-up flows.
  f.native.interruptKeepsWorking=false;
  f.native.terminals.get('t1').status={state:'idle'}; f.native.terminals.get('t1').turn=2;
  const confirmed=await f.api.interrupt('agent-a','stop-1');
  assert.equal(confirmed.state,'sent'); assert.equal(confirmed.delivery,'confirmed');
  assert.equal(confirmed.interruption.confirmed,true);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.interrupt').length,1);
  // The refused follow-up was durably reserved; resuming the SAME request ID
  // delivers it now that the barrier is released.
  await f.api.followup('agent-a','next',{instruction:'Must wait'});
  assert.match(f.native.accepted.at(-1).text,/Must wait/);
});

test('intentional stop records intent before the kill, confirms exit, retains the lease pending descendant clearance and refuses later input',async t=>{
  const f=await fixture(t);
  await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
  let intentAtKill=null;
  f.native.killHook=async()=>{intentAtKill=f.store.meta('stop:agent-a');};
  const result=await f.api.stop('agent-a','stop-1',{note:'Operator ended a wedged turn'});
  assert.equal(intentAtKill?.state,'requested','stop intent must be durable before the native kill');
  assert.equal(result.state,'sent'); assert.equal(result.delivery,'confirmed-stopped');
  assert.equal(result.stop.confirmed,true); assert.equal(result.stop.note,'Operator ended a wedged turn');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1);
  assert.equal(f.store.worker('agent-a').launchState,'stopped');
  // The native stop is confirmed, but ownership is a SEPARATE fact: with no
  // trusted descendant-clearance provider the writer lease is retained as
  // `pending_retirement` rather than raw-released on parent exit.
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'a confirmed stop retains writer ownership pending descendant clearance');
  assert.equal(f.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get('agent-a')?.state,'pending_retirement');
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed');
  const journal=f.store.db.prepare("SELECT type FROM journal WHERE type IN ('agent.stop.requested','agent.stopped') ORDER BY seq").all().map(r=>r.type);
  assert.deepEqual(journal,['agent.stop.requested','agent.stopped']);
  await assert.rejects(f.api.followup('agent-a','after-stop',{instruction:'Must be refused'}),/intentionally stopped/);
  const retry=await f.api.stop('agent-a','stop-1');
  assert.equal(retry.state,'sent');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'idempotent retry must not kill again');
});

test('an intentional stop still ends the original verified agent after its task is closed, without reopening the task or permitting ordinary delivery',async t=>{
  const f=await fixture(t);
  await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const worker=f.store.worker('agent-a'),task=f.store.task(worker.taskId);
  // A cleanup stop request was prepared while the task was still open...
  f.api.requests.reserve(worker,'cleanup-stop','stop',{});
  // ...and the task is closed before that prepared stop is claimed.
  f.store.saveTask({...task,status:'closed'});
  // Ordinary delivery stays refused on the closed task (the task is never reopened).
  await assert.rejects(f.api.followup('agent-a','after-close',{instruction:'Must not restart'}),/closed|intentionally stopped/);
  // The intentional stop of the ORIGINAL verified agent is still permitted.
  const stopped=await f.api.stop('agent-a','cleanup-stop');
  assert.equal(stopped.state,'sent');
  assert.equal(stopped.delivery,'confirmed-stopped');
  assert.equal(stopped.stop.confirmed,true);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'stop on a closed task must signal exactly once');
  assert.equal(f.store.worker('agent-a').launchState,'stopped');
  // The stop did NOT reopen the task.
  assert.equal(f.store.task(task.id).status,'closed');
  // Ordinary input is still refused after the stop.
  await assert.rejects(f.api.followup('agent-a','later',{instruction:'No'}),/intentionally stopped/);
  // A same-key replay does not signal a second time.
  const replay=await f.api.stop('agent-a','cleanup-stop');
  assert.equal(replay.state,'sent');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'same-key replay must not signal again');
  // A DIFFERENT stop identity would still be refused as a conflicting in-flight stop.
  await assert.rejects(f.api.stop('agent-a','other-stop'),/in-flight intentional stop/);
});

test('a stop receipt exposes a compact, truthful retirement outcome and same-key replay reflects current lease facts without re-signalling',async t=>{
  // `clearing` starts false: the provider reports UNKNOWN coverage, so a stop
  // must retain writer ownership as pending_retirement (never a false release).
  // Flipping it models a later, independent manager clearance.
  let clearing=false;
  const provider=({executionId})=>({coverage:clearing?'complete':'unknown',source:'test-containment',executionId,observedAt:new Date().toISOString(),descendants:[]});
  const f=await fixture(t,{containmentProvider:provider,trustedContainmentSources:['test-containment']});
  await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const writerStop=await f.api.stop('agent-a','stop-1');
  assert.equal(writerStop.state,'sent');
  assert.deepEqual(writerStop.retirement,{state:'pending_retirement',reason:'descendant-coverage-unknown',writerLeaseHeld:true,coverage:'unknown'});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id='agent-a'").get().n,1);
  // Same-key replay reports the SAME current facts and does not signal again.
  const writerReplay=await f.api.stop('agent-a','stop-1');
  assert.deepEqual(writerReplay.retirement,writerStop.retirement);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'replay must not kill again');
  // A later manager clearance releases ownership; the replay reflects it live.
  clearing=true;
  await f.api.retirement.reconcile({threadId:THREAD,workerId:'agent-a',executionId:f.api.retirement.executionId(f.store.worker('agent-a')),
    evidence:{coverage:'complete',source:'test-containment',reference:'review-1',descendants:[],observedAt:new Date().toISOString()}});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id='agent-a'").get().n,0);
  const releasedReplay=await f.api.stop('agent-a','stop-1');
  assert.equal(releasedReplay.retirement.state,'released');
  assert.equal(releasedReplay.retirement.writerLeaseHeld,false);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'release replay must not signal');
  // Read-only worker: no writer lease to retain, so the stop releases ownership.
  await f.api.delegate(f.input('agent-b',{scope:'read-only'}));
  const readerStop=await f.api.stop('agent-b','stop-1');
  assert.equal(readerStop.state,'sent');
  assert.deepEqual(readerStop.retirement,{state:'released',reason:'stop-confirmed',writerLeaseHeld:false});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM writer_leases WHERE worker_id='agent-b'").get().n,0);
});

test('an unconfirmed stop keeps intent durable and confirms on retry without a second kill',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  f.native.killNoop=true;
  const first=await f.api.stop('agent-a','stop-1',{note:'Stop it'});
  assert.equal(first.state,'uncertain'); assert.equal(first.delivery,'stop-requested');
  assert.equal(first.stop.confirmed,false);
  assert.equal(f.store.meta('stop:agent-a').state,'unconfirmed');
  await assert.rejects(f.api.followup('agent-a','blocked',{instruction:'No'}),/intentionally stopped/);
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=0;
  const retry=await f.api.stop('agent-a','stop-1');
  assert.equal(retry.state,'sent'); assert.equal(retry.stop.confirmed,true);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1);
});

test('stop remains available while an unresolved assignment would otherwise block delivery',async t=>{
  const f=await fixture(t);f.native.loseSend=true;
  await assert.rejects(f.api.delegate(f.input()),/receipt lost/);
  await assert.rejects(f.api.followup('agent-a','next',{instruction:'Blocked'}),/Resolve request|Initial assignment/);
  const stopped=await f.api.stop('agent-a','stop-1');
  assert.equal(stopped.state,'sent');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1);
});

test('a failed kill still leaves durable stop intent and an unresolved request',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  f.native.killError=Object.assign(new Error('native machine_unavailable'),{data:{kind:'machine_unknown'}});
  await assert.rejects(f.api.stop('agent-a','stop-1'),/machine_unavailable/);
  assert.equal(f.store.meta('stop:agent-a').state,'unconfirmed');
  assert.equal(f.api.requests.get('agent-a','stop-1').state,'uncertain');
  await assert.rejects(f.api.followup('agent-a','blocked',{instruction:'No'}),/intentionally stopped/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stop.requested'").get().n,1);
});

test('stop verifies the original identity before signalling; a replaced process is never killed',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const pid=f.store.worker('agent-a').launchResult.pid;
  f.native.terminals.get('t1').pid=pid+1;
  await assert.rejects(f.api.stop('agent-a','stop-1'),/identity/);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,0,'a replaced process must never be killed');
  assert.equal(f.store.meta('stop:agent-a').state,'unconfirmed');
  assert.equal(f.store.meta('stop:agent-a').dispatch,'not-dispatched');
  assert.equal(f.api.requests.get('agent-a','stop-1').state,'uncertain');
  assert.equal(f.store.worker('agent-a').launchState,'started');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'the lease is retained until the original exit is proved');
});

test('the first stop request owns the signal; a different request ID is refused without a second kill',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  f.native.killNoop=true;
  const first=await f.api.stop('agent-a','stop-1');
  assert.equal(first.state,'uncertain');
  await assert.rejects(f.api.stop('agent-a','stop-2'),/already has an in-flight intentional stop \(stop-1\)/);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'a competing request ID must not signal again');
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=0;
  const retry=await f.api.stop('agent-a','stop-1');
  assert.equal(retry.state,'sent');assert.equal(retry.stop.confirmed,true);
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,1,'same-key retry only re-observes');
});

test('a signal dispatched before the terminal vanishes is still not proof of exit',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  f.native.killHook=async native=>{f.native.terminals.delete(native.address);};
  const result=await f.api.stop('agent-a','stop-1');
  assert.equal(f.store.meta('stop:agent-a').dispatch,'accepted','the kill signal was actually acknowledged');
  assert.equal(result.stop.confirmed,false);assert.equal(result.stop.gone,true);
  assert.equal(result.state,'uncertain','a vanished terminal is not proof the original exited');
  assert.equal(f.store.worker('agent-a').launchState,'started');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1);
  await assert.rejects(f.api.followup('agent-a','blocked',{instruction:'No'}),/intentionally stopped/);
});

test('a deliberately stopped original keeps readable history while later input is refused',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  await f.api.stop('agent-a','stop-1');
  const history=await f.api.read('agent-a',10);
  assert.equal(history.agentId,'agent-a');
  assert.equal(history.terminalId,'t1');
  assert.equal(history.launchState,'stopped');
  assert.equal(history.native.state,'finished','the finished original identity is retained for reading');
  await assert.rejects(f.api.followup('agent-a','more',{instruction:'No'}),/intentionally stopped/);
  await assert.rejects(f.api.interrupt('agent-a','more-interrupt'),/intentionally stopped/);
});

test('a later prepared assignment never blocks an earlier one',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input());
  f.native.interruptKeepsWorking=true;
  await f.api.interrupt('agent-a','stop-1');
  // A follow-up refused behind the unresolved interrupt is durably reserved...
  await assert.rejects(f.api.followup('agent-a','later',{instruction:'Later'}),/Resolve request stop-1/);
  assert.equal(f.api.requests.get('agent-a','later').state,'prepared');
  // ...and it must not prevent the ORIGINAL interrupt from being confirmed.
  f.native.interruptKeepsWorking=false;
  f.native.terminals.get('t1').status={state:'idle'};f.native.terminals.get('t1').turn=2;
  const confirmed=await f.api.interrupt('agent-a','stop-1');
  assert.equal(confirmed.state,'sent');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.interrupt').length,1);
  await f.api.followup('agent-a','later',{instruction:'Later'});
  assert.match(f.native.accepted.at(-1).text,/Later/);
});

test('two concurrent confirmStop callers commit one stopped transition and one notice',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const worker=f.store.worker('agent-a');
  // Seed a durable, signalled stop request whose exit has not yet been observed.
  f.api.requests.reserve(worker,'stop-1','stop',{});
  f.api.requests.claim('agent-a','stop-1');
  f.store.meta('stop:agent-a',{requestId:'stop-1',state:'requested',dispatch:'accepted',terminalId:worker.terminalId,pid:worker.launchResult?.pid??null});
  // Gate terminal.get so BOTH callers pass the pre-await check and are suspended
  // together; the transition must be atomic, not merely serialized by luck.
  const raw=f.native.request.bind(f.native);
  let arrived=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.native.request=async(method,params)=>{
    if(method==='terminal.get'){arrived++;if(arrived===2)release();await gate;}
    return raw(method,params);
  };
  f.native.terminals.get(worker.terminalId).state='finished';
  f.native.terminals.get(worker.terminalId).exit_code=0;
  const [a,b]=await Promise.all([
    f.api.confirmStop(worker,{requestId:'stop-1'}),
    f.api.confirmStop(worker,{requestId:'stop-1'}),
  ]);
  assert.equal(arrived,2,'both callers awaited the exit observation before either committed');
  assert.equal(a.state,'sent');assert.equal(b.state,'sent');
  assert.equal(f.store.worker('agent-a').launchState,'stopped');
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'a confirmed stop retains writer ownership pending descendant clearance');
  assert.equal(f.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get('agent-a')?.state,'pending_retirement');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:worker.taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,1);
});

test('a failed lifecycle notice rolls the whole confirmed stop back and the retry commits once',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const worker=f.store.worker('agent-a');
  f.native.killNoop=true;
  await f.api.stop('agent-a','stop-1');
  assert.equal(f.store.meta('stop:agent-a').state,'unconfirmed');
  // A notice-write failure must abort every part of the confirmed transition.
  // `ingest` is synchronous, so the fault must throw synchronously to unwind the
  // enclosing transaction rather than yielding an unobserved rejection.
  const ingest=f.store.ingest.bind(f.store);
  f.store.ingest=()=>{throw new Error('simulated inbox failure');};
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=0;
  await assert.rejects(f.api.stop('agent-a','stop-1'),/simulated inbox failure/);
  assert.equal(f.store.worker('agent-a').launchState,'started','the worker stop rolled back');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'the lease rolled back');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,0,'the audit row rolled back');
  assert.equal(f.store.messages({taskId:worker.taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0,'the notice rolled back');
  assert.equal(f.store.meta('stop:agent-a').state,'unconfirmed');
  assert.equal(f.api.requests.get('agent-a','stop-1').state,'uncertain');
  // Clear the fault and reopen the manager; the retry commits the transition once.
  f.store.ingest=ingest;
  const reopened=f.service();
  const retry=await reopened.api.stop('agent-a','stop-1');
  assert.equal(retry.state,'sent');assert.equal(retry.stop.confirmed,true);
  assert.equal(reopened.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'the committed stop retains writer ownership pending descendant clearance');
  assert.equal(reopened.store.db.prepare('SELECT state FROM retirements WHERE worker_id=?').get('agent-a')?.state,'pending_retirement');
  assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(reopened.store.messages({taskId:worker.taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,1);
  assert.equal(reopened.store.meta('stop:agent-a').state,'confirmed');
  // A same-key CLI retry after the commit is a no-op, not another notice.
  await reopened.api.stop('agent-a','stop-1');
  assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(reopened.store.messages({taskId:worker.taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,1);
});

test('a refused kill is never later reported as the intentional stop',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  f.native.killError=Object.assign(new Error('native blocked the signal'),{data:{kind:'blocked'}});
  await assert.rejects(f.api.stop('agent-a','stop-1'),/native blocked the signal/);
  assert.equal(f.store.meta('stop:agent-a').dispatch,'refused','a recognised native refusal is not acceptance');
  assert.equal(f.api.requests.get('agent-a','stop-1').state,'uncertain');
  // The original now exits on its own. That exit must not be re-labelled as our
  // intentional stop just because a stop intent exists.
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=137;
  const retry=await f.api.stop('agent-a','stop-1');
  // The process genuinely exited, so the worker is truthfully stopped -- but the
  // exit is NOT attributed to our refused signal, and the result is not a
  // `confirmed-stopped` success. The manager still gets exactly one durable,
  // distinct unattributed-exit wake.
  assert.equal(retry.stop.confirmed,true);
  assert.equal(retry.stop.attribution,'unattributed');
  assert.equal(retry.state,'sent');
  assert.equal(retry.delivery,'unattributed-exit');
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed');
  assert.equal(f.store.meta('stop:agent-a').observedExit.reason,'process_finished','raw exit evidence is retained separately from the classified verdict');
  assert.equal(f.store.meta('stop:agent-a').reason,'unattributed_exit','the classified verdict is stored alongside the raw observation');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0);
  const unattributed=f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit');
  assert.equal(unattributed.length,1,'the refused exit is reported once, truthfully');
  assert.equal(unattributed[0].attention.attribution,'unattributed');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'an unattributed but confirmed exit still retains ownership pending clearance');
});

test('a pre-dispatch observation failure cannot mask a later unrelated exit',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  let first=true;
  f.native.beforeGetReply=async()=>{if(first){first=false;throw new Error('transport unavailable');}};
  await assert.rejects(f.api.stop('agent-a','stop-1'),/transport unavailable/);
  assert.equal(f.store.meta('stop:agent-a').dispatch,'not-dispatched');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,0,'no signal was ever issued');
  assert.equal(f.api.requests.get('agent-a','stop-1').state,'uncertain');
  // The process finishes later, for reasons unrelated to the failed stop.
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=1;
  const retry=await f.api.stop('agent-a','stop-1');
  // A later unrelated exit is settled truthfully but never attributed to the
  // observation that failed before any signal was dispatched.
  assert.equal(retry.stop.confirmed,true);
  assert.equal(retry.stop.attribution,'unattributed');
  assert.equal(retry.stop.reason,'unattributed_exit');
  assert.equal(retry.state,'sent');
  assert.equal(retry.delivery,'unattributed-exit');
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'a later unrelated exit retains ownership pending clearance');
});

test('an ambiguous kill transport stays uncertain and never pretends acceptance',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  f.native.killError=Object.assign(new Error('native machine_unknown'),{data:{kind:'machine_unknown'}});
  await assert.rejects(f.api.stop('agent-a','stop-1'),/native machine_unknown/);
  assert.equal(f.store.meta('stop:agent-a').dispatch,'uncertain','an unrecognised transport failure is not acceptance');
  assert.notEqual(f.store.meta('stop:agent-a').dispatch,'accepted');
  assert.equal(f.api.requests.get('agent-a','stop-1').state,'uncertain');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,0);
});

test('a finished exit observed during an in-flight accepted kill settles conservatively as unattributed',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const bridge=bridgeFor(f);
  const {pending,release}=await startGatedStop(f);
  // ONE finished observation is enough: a pending dispatch is NOT acceptance,
  // and no second native event is guaranteed. The exit must settle conservatively
  // as UNATTRIBUTED on the first observation with exactly one durable wake.
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  const settled=f.store.meta('stop:agent-a');
  assert.equal(settled.state,'confirmed','a single observation settles truthfully');
  assert.equal(settled.attribution,'unattributed','a pending dispatch is never acceptance');
  assert.equal(settled.observedExit.reason,'process_finished','raw exit evidence is preserved separately');
  assert.equal(f.store.worker('agent-a').launchState,'stopped');
  // Native exit and writer ownership are SEPARATE facts: the exit is settled
  // (unattributed) yet ownership is retained as `pending_retirement` until the
  // manager reconciles explicit descendant clearance.
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writer_leases').get().n,1,'writer ownership is retained pending descendant clearance');
  assert.equal(f.store.db.prepare("SELECT state FROM retirements WHERE worker_id='agent-a'").get()?.state,'pending_retirement');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
  // The late accepted receipt is recorded as dispatch evidence, but the frozen
  // conservative verdict and the already-delivered notice are never rewritten.
  release();
  const result=await pending;
  assert.equal(result.state,'sent');
  assert.equal(result.delivery,'unattributed-exit');
  assert.equal(result.stop.attribution,'unattributed');
  const after=f.store.meta('stop:agent-a');
  assert.equal(after.dispatch,'accepted','the accepted receipt is recorded separately');
  assert.equal(after.attribution,'unattributed','an accepted late receipt never rewrites the verdict');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
  // A later native echo does not duplicate the stop or re-fault.
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
});

test('a finished exit observed during an in-flight refused kill is never fabricated as intentional',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const bridge=bridgeFor(f);
  const {pending,release}=await startGatedStop(f);
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed','a single observation settles truthfully without waiting for a second event');
  assert.equal(f.store.meta('stop:agent-a').attribution,'unattributed');
  // The late receipt is a known native refusal. The caller must still see the
  // true dispatch outcome rather than a swallowed confirmation.
  f.native.killError=Object.assign(new Error('native blocked the signal'),{data:{kind:'blocked'}});
  release();
  await assert.rejects(pending,/native blocked the signal/);
  const settled=f.store.meta('stop:agent-a');
  assert.equal(settled.dispatch,'refused');
  assert.equal(settled.state,'confirmed');
  assert.equal(settled.attribution,'unattributed');
  assert.equal(settled.dispatchError.kind,'blocked','the late refusal evidence is retained durably');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
  // The bridge already latched the settled observation: a later echo is quiet.
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
});

test('a finished exit observed during an unknown kill transport stays truthful and surfaces the error',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const bridge=bridgeFor(f);
  const {pending,release}=await startGatedStop(f);
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed');
  assert.equal(f.store.meta('stop:agent-a').attribution,'unattributed');
  // The late receipt is ambiguous: the transport never confirmed acceptance. The
  // observed exit is settled durably but never labelled intentional, and the
  // caller still sees the transport failure instead of a silent success.
  f.native.killError=Object.assign(new Error('native transport lost the receipt'),{data:{kind:'machine_unknown'}});
  release();
  await assert.rejects(pending,/transport lost the receipt/);
  const settled=f.store.meta('stop:agent-a');
  assert.equal(settled.dispatch,'uncertain');
  assert.equal(settled.state,'confirmed');
  assert.equal(settled.attribution,'unattributed');
  assert.equal(settled.dispatchError.kind,'machine_unknown');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
});

test('a duplicate finished observation while a kill is in flight still settles exactly once and never swallows the refusal',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  const bridge=bridgeFor(f);
  const {pending,release}=await startGatedStop(f);
  // Two finished observations while the kill receipt is still gated. An
  // immediate duplicate is NOT proof the dispatching caller died: it must not
  // produce a second settlement or notice.
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  await bridge.checkWorker(f.store.worker('agent-a'),{type:'finished'});
  assert.equal(f.store.meta('stop:agent-a').state,'confirmed');
  assert.equal(f.store.meta('stop:agent-a').attribution,'unattributed');
  assert.equal(f.store.worker('agent-a').launchState,'stopped');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
  // Releasing the gate with a known native refusal must reject the caller; the
  // already-settled early return must not swallow the error.
  f.native.killError=Object.assign(new Error('native blocked the signal'),{data:{kind:'blocked'}});
  release();
  await assert.rejects(pending,/native blocked the signal/);
  const settled=f.store.meta('stop:agent-a');
  assert.equal(settled.dispatch,'refused');
  assert.equal(settled.dispatchError.kind,'blocked');
  assert.equal(settled.attribution,'unattributed','the settled verdict stays conservative');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE type='agent.stopped'").get().n,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='unattributed_exit').length,1);
  assert.equal(f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='intentional_stop').length,0);
});

test('stopping an already-finished original reports already-exited, never an intentional signal',async t=>{
  const f=await fixture(t);await f.api.delegate(f.input('agent-a',{scope:'write',writePaths:[f.project]}));
  // The original finished before any stop was requested.
  f.native.terminals.get('t1').state='finished';f.native.terminals.get('t1').exit_code=0;
  const result=await f.api.stop('agent-a','stop-1');
  assert.equal(result.state,'sent');
  assert.equal(result.delivery,'already-exited');
  assert.equal(result.stop.confirmed,true);
  assert.equal(result.stop.attribution,'already-exited');
  assert.equal(f.store.meta('stop:agent-a').dispatch,'not-dispatched','no signal was ever issued');
  assert.equal(f.native.accepted.filter(x=>x.method==='terminal.kill').length,0);
  assert.equal(f.store.worker('agent-a').launchState,'stopped');
  const notices=f.store.messages({taskId:f.store.worker('agent-a').taskId}).filter(m=>m.attention?.reason==='already_exited');
  assert.equal(notices.length,1);
  assert.equal(notices[0].attention.attribution,'already-exited');
});
