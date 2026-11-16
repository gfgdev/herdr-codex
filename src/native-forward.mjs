import {spawn} from 'node:child_process';

/** Only integration options preceding a native command belong to this CLI.
 * Once native/app is reached, every following token belongs to Herdr, including
 * --, --config, unknown future flags, and arguments for programs it launches. */
export function parseIntegrationArgs(argv,{configPath=process.env.HERDR_CODEX_CONFIG}={}) {
  if(!Array.isArray(argv)||argv.some(arg=>typeof arg!=='string'))throw new TypeError('Expected command arguments');
  const args=[...argv];let selected=false;
  const takeConfig=index=>{
    if(selected)throw new Error('Specify integration --config only once');
    const token=args[index],inline=token.startsWith('--config=');
    const value=inline?token.slice('--config='.length):args[index+1];
    if(!value||(!inline&&value.startsWith('--')))throw new Error('Missing integration --config path');
    configPath=value;selected=true;args.splice(index,inline?1:2);
  };
  while(args[0]==='--config'||args[0]?.startsWith('--config='))takeConfig(0);
  const [command]=args;
  const native=command==='native'||command==='app';
  if(!native){
    // Preserve the existing managed-command syntax. This compatibility search
    // never crosses the native boundary above.
    for(let index=0;index<args.length;index++){
      if(args[index]==='--config'||args[index].startsWith('--config=')){takeConfig(index);index--;}
    }
  }
  const [resolvedCommand,resolvedAction,...resolvedTail]=args;
  return {args,configPath,command:resolvedCommand,action:resolvedAction,tail:resolvedTail,
    ...(native?{nativeArgs:args.slice(1)}:{})};
}

/** Forward only to the native CLI process spawned here, never its server,
 * terminal workers, process group, or unrelated agents. Inherited descriptors
 * preserve a caller-provided PTY as well as ordinary pipes and binary output. */
export async function forwardNative(executable,args,{env=process.env,cwd}={}) {
  const child=spawn(executable,args,{stdio:'inherit',env,...(cwd?{cwd}:{})});
  const handlers=new Map();
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']){
    const handler=()=>{
      if(child.exitCode!==null||child.signalCode!==null)return;
      try{child.kill(signal);}catch(error){if(error.code!=='ESRCH')throw error;}
    };
    handlers.set(signal,handler);process.on(signal,handler);
  }
  try {
    return await new Promise((resolve,reject)=>{
      child.once('error',reject);
      // close waits for the process and inherited output to finish before the
      // wrapper reports its result; no wrapper output is added to native I/O.
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
  } finally {
    for(const [signal,handler] of handlers)process.removeListener(signal,handler);
  }
}

/** Call at the CLI boundary after forwardNative has removed its handlers. */
export function exitLikeNative({code,signal}) {
  if(signal){
    // Re-raise instead of translating a native signal termination into exit 1.
    // SIGKILL here terminates only this wrapper, after its child has exited.
    process.kill(process.pid,signal);
    return;
  }
  process.exitCode=code??1;
}
