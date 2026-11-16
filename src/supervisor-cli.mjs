#!/usr/bin/env node
import {readFileSync,openSync,closeSync,constants} from 'node:fs';
import {parseArgs} from 'node:util';
import {requestSupervision} from './activity-ipc.mjs';

try{
 const [command,...tail]=process.argv.slice(2);
 if(!command||command==='help'||command==='--help')console.log('herdr-supervise inbox | receive --id MESSAGE | reply --id MESSAGE --request-id KEY --text TEXT | decision --id MESSAGE --request-id KEY --action accept|abort --text REASON | ack --id MESSAGE | escalate --id MESSAGE --request-id KEY --text REASON | delegate --request-id KEY --id CHILD --definition ROLE --text TEXT\nUse --text-file PATH for larger text. This helper uses only your frozen role authority and existing native identity.');
 else{
  if(!['inbox','receive','reply','decision','ack','escalate','delegate'].includes(command))throw new Error('Unknown supervisor command');
  const {values}=parseArgs({args:tail,strict:true,options:{id:{type:'string'},'request-id':{type:'string'},text:{type:'string'},'text-file':{type:'string'},action:{type:'string'},definition:{type:'string'}}});
  if(values.text!==undefined&&values['text-file'])throw new Error('Supply text or text-file, not both');
  if(!process.env.HERDR_CODEX_WORKER_CONFIG||!process.env.HC_TERMINAL_ID)throw new Error('Run inside the registered supervisor terminal');
  const worker=JSON.parse(readFileSync(process.env.HERDR_CODEX_WORKER_CONFIG,'utf8')),descriptor=worker.supervisionCredential;
  if(!worker.supervisionGrant||descriptor?.version!==1)throw new Error('This worker has no supervisor authority');
  const fd=openSync(descriptor.credentialFile,constants.O_RDONLY|constants.O_NOFOLLOW);let credential;try{credential=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
  if(credential.version!==1||credential.workerId!==worker.id)throw new Error('Credential belongs to a different worker');
  const result=await requestSupervision({socketPath:descriptor.socketPath,request:{workerId:worker.id,terminalId:process.env.HC_TERMINAL_ID,token:credential.token,command,args:{id:values.id,requestId:values['request-id'],action:values.action,definitionId:values.definition,text:values['text-file']?readFileSync(values['text-file'],'utf8'):values.text}}});
  console.log(JSON.stringify(result,null,2));
 }
}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
