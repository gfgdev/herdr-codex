import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostQueueClient,HostQueueError} from '../src/host-queue.mjs';
import {CodexQueue,withHostQueueRpc} from '../src/host-queue.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
const threadId='01a1908c-c75c-7ea2-b055-9f0b3666af2b';
const input=text=>[{type:'text',text,text_elements:[]}];
const options={threadId,receipt:'receipt-1',clientUserMessageId:'herdr-stable-client'};
test('ownership mismatch never mutates a queue item',async()=>{
  const calls=[];
  const client=createHostQueueClient(async(method,params)=>{calls.push({method,params});return {data:[{id:'receipt-1',clientUserMessageId:'foreign',input:input('foreign')}],nextCursor:null};});
  await assert.rejects(client.remove(options),{code:'OWNERSHIP_MISMATCH'});
  assert.deepEqual(calls.map(x=>x.method),['thread/queue/list']);
});
test('consumed or absent message is not re-added by cleanup',async()=>{
  const calls=[];const client=createHostQueueClient(async(method)=>{calls.push(method);return {data:[],nextCursor:null};});
  assert.deepEqual(await client.remove(options),{status:'absent'});
  assert.deepEqual(await client.update({...options,text:'new'}),{status:'absent'});
  assert.deepEqual(calls,['thread/queue/list','thread/queue/list']);
});
test('update preserves exact identity and validates server receipt',async()=>{
  const calls=[];const client=createHostQueueClient(async(method,params)=>{calls.push({method,params});
    return method.endsWith('/list')?{data:[{id:options.receipt,clientUserMessageId:options.clientUserMessageId,input:input('old')}],nextCursor:null}:{queuedSubmission:{id:options.receipt,clientUserMessageId:options.clientUserMessageId,input:params.input}};
  });
  assert.equal((await client.update({...options,text:'new'})).status,'updated');
  assert.deepEqual(calls[1],{method:'thread/queue/update',params:{threadId,queuedSubmissionId:options.receipt,input:input('new')}});
});
test('mutation receipt mismatch is uncertain, not safe to repeat',async()=>{
  const client=createHostQueueClient(async()=>({queuedSubmission:{id:'unrelated',clientUserMessageId:'foreign',input:input('text')}}));
  await assert.rejects(client.add({threadId,clientUserMessageId:'owned',text:'text'}),error=>error instanceof HostQueueError && error.code==='INVALID_RECEIPT' && error.uncertain);
});
test('pagination validates cycles before mutation',async()=>{
  let n=0;const client=createHostQueueClient(async()=>({data:[{id:`receipt-${++n}`,clientUserMessageId:'c',input:input('text')}],nextCursor:'cycle'}));
  await assert.rejects(client.remove(options),{code:'INVALID_RESPONSE'});assert.equal(n,2);
});
test('delete false is a benign consumption race and never triggers add',async()=>{
  const calls=[];const client=createHostQueueClient(async(method)=>{calls.push(method);return method.endsWith('/list')?{data:[{id:options.receipt,clientUserMessageId:options.clientUserMessageId,input:input('text')}],nextCursor:null}:{deleted:false};});
  assert.deepEqual(await client.remove(options),{status:'absent'});assert.deepEqual(calls,['thread/queue/list','thread/queue/delete']);
});
test('invalid target is rejected before transport calls',async()=>{
  const client=createHostQueueClient(async()=>{throw new Error('transport must not run');});
  await assert.rejects(client.list('another chat'),{code:'INVALID_THREAD'});
});

function mockTransport(handler) {
  const calls=[],launches=[];
  function spawnImpl(executable,args,options) {
    launches.push({executable,args,options});
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    let buffer='',ended=false;
    const emit=message=>child.stdout.write(JSON.stringify(message)+'\n');
    const exit=()=>{if(!ended){ended=true;child.emit('exit',0,null);}};
    child.stdin=new Writable({write(chunk,_encoding,done){
      buffer+=chunk.toString();let newline;
      while((newline=buffer.indexOf('\n'))!==-1){
        const message=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);calls.push(message);
        if(message.method==='initialize')emit({id:message.id,result:{codexHome:'/test',platformOs:'macos',platformFamily:'unix',userAgent:'test'}});
        else if(message.id)handler(message,emit,child);
      }
      done();
    }});
    child.stdin.on('finish',()=>setImmediate(exit));child.kill=()=>{exit();return true;};
    return child;
  }
  return {spawnImpl,calls,launches};
}
test('transport ignores unsolicited events and omits credential env keys',async()=>{
  const mock=mockTransport((message,emit)=>{emit({method:'thread/queue/changed',params:{threadId}});emit({id:message.id,result:{data:[],nextCursor:null}});});
  const queue=new CodexQueue({executable:'/bin/codex',env:{HOME:'/tmp/herdr-test-home',PATH:'/bin',MODAL_TOKEN_SECRET:'do-not-pass',OPENAI_API_KEY:'do-not-pass'},spawnImpl:mock.spawnImpl});
  try{assert.deepEqual(await queue.list(threadId),[]);}finally{await queue.close();}
  assert.deepEqual(mock.launches[0].args,['app-server','--listen','stdio://']);
  assert.deepEqual(mock.launches[0].options.env,{HOME:'/tmp/herdr-test-home',PATH:'/bin'});
  assert.deepEqual(mock.calls.map(x=>x.method),['initialize','initialized','thread/queue/list']);
});
test('configured shared socket uses proxy and never silently falls back',async()=>{
  const mock=mockTransport((message,emit)=>emit({id:message.id,error:{code:-32601,message:'method unavailable'}}));
  const queue=new CodexQueue({executable:'/bin/codex',socketPath:'/tmp/herdr-control.sock',spawnImpl:mock.spawnImpl});
  try{await assert.rejects(queue.list(threadId),{code:'RPC_-32601'});}finally{await queue.close();}
  assert.equal(mock.launches.length,1);assert.deepEqual(mock.launches[0].args,['app-server','proxy','--sock','/tmp/herdr-control.sock']);
});
test('disconnect after mutation is uncertain and transport never resends',async()=>{
  const mock=mockTransport((_message,_emit,child)=>child.emit('exit',1,null));
  const queue=new CodexQueue({executable:'/bin/codex',spawnImpl:mock.spawnImpl});
  try{await assert.rejects(queue.add(threadId,{clientId:'owned-fixture',text:'text'}),error=>error.code==='TRANSPORT_CLOSED'&&error.uncertain);}finally{await queue.close();}
  assert.equal(mock.calls.filter(x=>x.method==='thread/queue/add').length,1);
});
test('timeout after mutation is uncertain and never retried',async()=>{
  const mock=mockTransport(()=>{});
  const queue=new CodexQueue({executable:'/bin/codex',timeoutMs:10,spawnImpl:mock.spawnImpl});
  try{await assert.rejects(queue.add(threadId,{clientId:'owned-fixture',text:'text'}),error=>error.code==='TIMEOUT'&&error.uncertain);}finally{await queue.close();}
  assert.equal(mock.calls.filter(x=>x.method==='thread/queue/add').length,1);
});
test('unrelated inference methods are rejected before sending',async()=>{
  const mock=mockTransport(()=>{});
  await assert.rejects(withHostQueueRpc({executable:'/bin/codex',spawnImpl:mock.spawnImpl},rpc=>rpc('turn/start',{threadId})),{code:'DISALLOWED_METHOD'});
  assert.deepEqual(mock.calls.map(x=>x.method),['initialize','initialized']);
});
test('internal mutation failure is conservative because commit is unknown',async()=>{
  const mock=mockTransport((message,emit)=>emit({id:message.id,error:{code:-32603,message:'internal error with secret data'}}));
  const queue=new CodexQueue({executable:'/bin/codex',spawnImpl:mock.spawnImpl});
  try{await assert.rejects(queue.delete(threadId,'exact-owned-receipt'),error=>error.code==='RPC_-32603'&&error.uncertain&&!error.message.includes('secret'));}finally{await queue.close();}
});
