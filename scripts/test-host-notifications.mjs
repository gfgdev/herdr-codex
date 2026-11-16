#!/usr/bin/env node
/** Opt-in real Codex queue test. No agent launches, model calls, or host turn start.
 * Run while the target chat is actively executing this test. Every fixture is
 * withdrawn before returning, including on failure. Uses an isolated inbox. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.mjs';
import { Bridge } from '../src/bridge.mjs';
import { CodexQueue } from '../src/host-queue.mjs';

const {values}=parseArgs({options:{config:{type:'string'},thread:{type:'string'},out:{type:'string'}}});
if(!isAbsolute(values.out??''))throw new Error('Use a new absolute --out directory');
const selected=readConfig(values.config),root=resolve(fileURLToPath(new URL('..',import.meta.url)));
mkdirSync(values.out,{mode:0o700});
const out=realpathSync(values.out),config={...selected,stateDir:out,path:join(out,'config.json'),packageRoot:root,registryDoc:'fixture-not-used'};
writeFileSync(config.path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
const evidence={startedAt:new Date().toISOString(),noAgentLaunches:true,noModelCalls:true,noHostTurnStarts:true,checks:[],calls:[]};
const transport=new CodexQueue({executable:config.codex});
const queue=Object.fromEntries(['list','add','update','delete'].map(method=>[method,async(...args)=>{
  evidence.calls.push({method,threadId:args[0],...(typeof args[1]==='string'?{receipt:args[1]}:{})});
  return transport[method](...args);
}]));
queue.close=()=>{};
// Native activity is irrelevant to this transport test and must not reach the
// user's real agents. Any accidental native operation fails the test.
const bridge=new Bridge(config,{queue,clientFactory:()=>({subscribe:async()=>({seq:1}),close(){},request:async()=>{throw new Error('Unexpected native operation in host queue test');}})});
const thread=values.thread,knownReceipts=new Set();let before=[],started=false,failure;
const cli=async(...args)=>{
  const child=spawn(process.execPath,[join(root,'src/cli.mjs'),'--config',config.path,...args],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',code=>code===0?res():rej(new Error('Fixture CLI failed: '+stderr)));});
  return JSON.parse(stdout);
};
const check=name=>evidence.checks.push(name);
try{
  before=await queue.list(thread);await bridge.start();started=true;await bridge.chain;
  const workers=[];
  for(const suffix of ['a','b']){
    const project=join(out,'project-'+suffix);mkdirSync(project);
    const task={id:'notification-fixture-'+suffix,name:'Notification queue test '+suffix,project,threadId:thread,status:'active'};
    const worker={id:'fixture-worker-'+suffix,taskId:task.id,name:'Fixture '+suffix,project,terminalId:'fixture-'+suffix,mailbox:'not-used-'+suffix};
    bridge.store.saveTask(task);bridge.store.saveWorker(worker);workers.push(worker);
  }
  const ingest=(id,index=0,kind='result')=>{const w=workers[index];return bridge.store.ingest(w,{id,taskId:w.taskId,workerId:w.id,terminalId:w.terminalId,kind,text:'Queue-only verification '+id+'. No work to start.',createdAt:new Date().toISOString(),turn:1});};
  ingest('report-a');ingest('report-b',1);await bridge.pump({strict:true});
  const notice=bridge.notifications.list()[0],receipt=notice.queueId;knownReceipts.add(receipt);
  assert.ok(receipt);let rows=await queue.list(thread);assert.equal(rows.filter(r=>bridge.notifications.owns(r,notice)).length,1);
  assert.equal(evidence.calls.filter(c=>c.method==='add').length,1);check('Two project reports coalesce into one actual Codex queue entry');
  ingest('report-a-revised');ingest('question-b',1,'question');await bridge.pump({strict:true});
  rows=await queue.list(thread);const updated=rows.find(r=>r.id===receipt);assert.ok(updated);
  assert.match(updated.input[0].text,/report-a-revised/);assert.match(updated.input[0].text,/question-b/);
  assert.equal(evidence.calls.filter(c=>c.method==='add').length,1);check('Related updates replace the same queue entry and retain the question');
  await cli('message','decision','--id','report-a','--action','accept','--request-id','fixture-accept-a','--text','Queue-only fixture verified.');
  await cli('message','ack','--id','report-a');
  assert.doesNotMatch((await queue.list(thread)).find(r=>r.id===receipt).input[0].text,/- result report-a —/);
  check('Separate-process message ack waits for host preview cleanup');
  const received=await cli('notification','receive','--id',notice.id);assert.equal(received.actionable,true);
  assert.equal((await queue.list(thread)).some(r=>r.id===receipt),false);check('Separate-process notification receive withdraws host wake before returning');
  assert.equal((await cli('notification','receive','--id',notice.id)).actionable,false);
  ingest('fresh-after-receipt');await bridge.pump({strict:true});
  const fresh=bridge.notifications.list().at(-1);knownReceipts.add(fresh.queueId);
  assert.notEqual(fresh.id,notice.id);assert.equal((await cli('notification','receive','--id',notice.id)).actionable,false);
  assert.equal(bridge.store.message('fresh-after-receipt').receivedAt,null);check('Stale notification cannot claim a later independent report');
  await cli('notification','receive','--id',fresh.id);
  for(const m of bridge.store.messages({pending:true})){
    await cli('message','decision','--id',m.id,'--action','accept','--request-id','accept-'+m.id,'--text','Queue-only fixture verified.');
    await cli('message','ack','--id',m.id);
  }
  assert.equal(ingest('report-a'),false);await bridge.pump({strict:true});
  assert.equal((await queue.list(thread)).some(r=>knownReceipts.has(r.id)),false);check('Replayed handled message does not create another host wake');
  ingest('legacy-handled');const legacy=await queue.add(thread,{clientId:randomUUID(),text:'Herdr attention for this existing Codex chat.\nMessage ID: legacy-handled\nIntegration config: '+config.path+'\nQueue-only migration test.'});
  knownReceipts.add(legacy.id);bridge.store.startDispatch('legacy-handled');bridge.store.finishDispatch('legacy-handled',{status:'queued',receipt:legacy.id});
  await cli('message','decision','--id','legacy-handled','--action','accept','--request-id','legacy-accept','--text','Migration fixture verified.');
  await cli('message','ack','--id','legacy-handled');assert.equal((await queue.list(thread)).some(r=>r.id===legacy.id),false);
  check('Already-handled pre-upgrade notification is withdrawn by exact recorded receipt');
}catch(error){failure=error;evidence.error=error.stack;}
finally{
  try{
    for(const m of bridge.store.messages({pending:true})){
      if(!m.action)bridge.store.recordAction(m.id,{kind:'abort',requestId:'cleanup-'+m.id,text:'Isolated queue fixture cleanup; no agent work.'});
      bridge.store.ack(m.id);
    }
    if(started)await bridge.pump({strict:true});
    for(const t of bridge.store.tasks())bridge.store.saveTask({...t,status:'closed'});
    await bridge.stop();
    const after=await queue.list(thread);
    const owned=after.filter(r=>knownReceipts.has(r.id)||bridge.notifications.list().some(n=>bridge.notifications.owns(r,n)));
    assert.deepEqual(owned,[],'No test notifications may remain queued');
    for(const row of before)assert.deepEqual(after.find(r=>r.id===row.id),row,'Pre-existing user queue item changed');
    evidence.cleanup={ownedQueueEntriesRemaining:0,existingQueueItemsPreserved:before.length};
    check('Cleanup leaves no fixture wake and preserves every pre-existing queue item');
  }catch(error){failure??=error;evidence.cleanupError=error.stack;}
  await transport.close();bridge.store.close();
  evidence.finishedAt=new Date().toISOString();evidence.passed=!failure;
  writeFileSync(join(out,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
}
if(failure)throw failure;
console.log(JSON.stringify({passed:true,checks:evidence.checks,evidence:join(out,'evidence.json')}));
