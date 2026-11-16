#!/usr/bin/env node
// Deterministic raw-text agent: no model, shell evaluation or host dispatch.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ledger=process.argv[2],taskOutput=process.argv[3];
if(!ledger||!process.env.HC_TERMINAL_ID||!process.stdin.isTTY)throw new Error('Run inside the private test core');
const status=state=>process.stdout.write(`\x1b]7501;state=${state}:app=native-delegate-fixture\x1b\\`);
const record=value=>appendFileSync(ledger,JSON.stringify({at:new Date().toISOString(),pid:process.pid,terminal:process.env.HC_TERMINAL_ID,...value})+'\n');
let stream='',prompt='',pasting=false,sequence=0,finishTimer,escapeTimer;
function interrupt(){clearTimeout(finishTimer);prompt='';record({kind:'interrupt',sequence});process.stdout.write('\r\nINTERRUPTED_NATIVE_DELEGATION\r\n');status('done');}
function submit(){
  const text=prompt;prompt='';if(!text.trim())return;
  clearTimeout(finishTimer);sequence++;record({kind:'prompt',sequence,text});
  if(taskOutput&&text.includes('WRITE_DESK_FILE'))writeFileSync(join(taskOutput,'native-'+sequence+'.md'),'Native task output '+sequence+'\n');
  process.stdout.write(`\r\nPROMPT ${sequence}\r\n${text.replaceAll('\n','\r\n')}\r\n`);status('working');
  if(!text.includes('HOLD_NATIVE_DELEGATION'))finishTimer=setTimeout(()=>{process.stdout.write(`DONE ${sequence}\r\n`);status('done');},120);
}
function drain(){
  clearTimeout(escapeTimer);
  while(stream.length){
    if(pasting){
      const end=stream.indexOf('\x1b[201~');
      if(end<0){if(stream.length>5){prompt+=stream.slice(0,-5);stream=stream.slice(-5);}return;}
      prompt+=stream.slice(0,end);stream=stream.slice(end+6);pasting=false;continue;
    }
    if(stream.startsWith('\x1b[200~')){stream=stream.slice(6);pasting=true;continue;}
    if('\x1b[200~'.startsWith(stream)&&stream[0]==='\x1b'){
      escapeTimer=setTimeout(()=>{if(stream==='\x1b'){stream='';interrupt();}else{record({kind:'partial-escape',value:stream});stream='';}},35);return;
    }
    const c=stream[0];stream=stream.slice(1);
    if(c==='\x1b'){interrupt();continue;}
    if(c==='\r'){submit();continue;}
    if(c==='\x03'){interrupt();continue;}
    prompt+=c;
  }
}
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
process.stdin.on('data',data=>{stream+=data;drain();});
record({kind:'startup'});process.stdout.write('\x1b[?2004hNative delegation fixture ready\r\n');status('idle');
