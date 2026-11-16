import {readFileSync} from 'node:fs';
import {realpathSync} from 'node:fs';
import {Desks} from './desks.mjs';
import {digest,safeId} from './config.mjs';
import {Delegation} from './delegation.mjs';
import {Retirement, noCoverage} from './retirement.mjs';
import {localSpace} from './routing.mjs';
import {openDeskFiles} from './desk-display.mjs';
import {RecipeLibrary} from './recipes.mjs';
import {WorkflowRuns} from './desk-runs.mjs';
import {deskOverview} from './desk-overview.mjs';

const need=(v,label)=>{if(!v)throw new Error('Missing '+label);return v;};
const positive=v=>{if(v===undefined)return undefined;const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new Error('Version must be a positive integer');return n;};
const canonical=path=>{try{return realpathSync(path);}catch{return null;}};

/** A desk space is a view; browsing does not change worker execution paths. */
export async function openDeskSpace({desk,appCall,spaceId,getTerminal}) {
  if(desk.fileTemplate?.enabled)return openDeskFiles({desk,appCall,spaceId,getTerminal});
  let snapshot=await appCall('ls',{});
  if(!Array.isArray(snapshot?.spaces))throw new Error('Unexpected native desktop inventory');
  let matches=snapshot.spaces.filter(s=>localSpace(s)&&canonical(s.folder)===desk.home);
  let target=spaceId?snapshot.spaces.find(s=>s.id===spaceId):matches.length===1?matches[0]:null;
  if(spaceId&&(!target||!localSpace(target)||canonical(target.folder)!==desk.home))throw new Error('Selected space does not match the local desk home');
  if(!spaceId&&matches.length>1)throw new Error('Several native spaces match this desk; choose an explicit --space');
  if(!target){
    await appCall('space.new',{name:desk.name+' · desk',folder:desk.home});
    snapshot=await appCall('ls',{});matches=(snapshot.spaces??[]).filter(s=>localSpace(s)&&canonical(s.folder)===desk.home);
    if(matches.length!==1)throw new Error('Desk space creation is not uniquely confirmed; inspect app ls before retrying');
    target=matches[0];
  }
  if(!target.active)await appCall('space.select',{id:target.id});
  const after=await appCall('ls',{}),selected=after.spaces?.filter(s=>s.active);
  if(selected?.length!==1||selected[0].id!==target.id||!localSpace(selected[0])||canonical(selected[0].folder)!==desk.home)throw new Error('Desktop selection changed; desk space is not verified');
  return {deskId:desk.id,spaceId:target.id,home:desk.home,status:'selected',verified:true};
}

export async function deskCommand({action,values,store,config,rpc,pulse,appCall,retirement=null,delegationFactory=opts=>new Delegation(opts)}) {
  const desks=new Desks({store,config});
  const retirementService=retirement??new Retirement(store,{provider:config.containmentProvider??noCoverage,trustedSources:config.trustedContainmentSources??null});
  if(action==='list')return desks.list();
  const deskId=safeId(need(values.id,'--id DESK'),'desk ID');
  const payload=()=>{
    const file=need(values.file,'--file JSON');
    const bytes=readFileSync(file);if(bytes.length>262144)throw new Error('Desk payload is too large');
    const value=JSON.parse(bytes.toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Desk payload must be an object');
    if(value.deskId!==undefined&&value.deskId!==deskId)throw new Error('Payload desk differs from selected desk');
    return value;
  };
  if(action==='create'){
    const spec=values.file?payload():{name:need(values.name,'--name'),purpose:need(values.purpose??values.text,'--purpose'),...(values.vault?{vaultPath:values.vault}:{})};
    if(spec.id!==undefined&&spec.id!==deskId)throw new Error('Payload ID differs from selected desk');
    const desk=desks.create({...spec,id:deskId});const fileTemplate=desks.files.scaffold(deskId);return {...desk,fileTemplate};
  }
  if(action==='scaffold')return desks.files.scaffold(deskId);
  if(action==='validate')return desks.files.validate(deskId);
  if(action==='sync')return desks.files.sync(deskId);
  if(action==='publish')return desks.files.publish(deskId,payload());
  if(action==='update')return desks.update(deskId,payload());
  if(action==='show')return desks.show(deskId);
  if(action==='overview')return deskOverview({desks,store,config,deskId,threadId:values.thread??null,limit:values.limit===undefined?undefined:Number(values.limit)});
  const runtime=()=>new WorkflowRuns({store,config,rpc,pulse,delegationFactory,retirement:retirementService});
  if(action==='runs')return runtime().list(deskId);
  if(action==='run-show')return runtime().get(deskId,need(values.job,'--job'));
  if(action==='step-decision')return runtime().decide({deskId,id:need(values.job,'--job'),...payload()});
  if(action==='run-retry')return runtime().retry({deskId,id:need(values.job,'--job'),...payload()});
  if(action==='run-cancel')return runtime().cancel({deskId,id:need(values.job,'--job'),...payload()});
  if(action==='trigger-status')return runtime().triggers.status(deskId);
  if(action==='event')return runtime().triggers.emit({...payload(),deskId});
  if(action==='recipes')return new RecipeLibrary({store,config,desks}).list(deskId);
  if(action==='recipe-put')return new RecipeLibrary({store,config,desks}).put(deskId,payload());
  if(action==='recipe-validate'){const library=new RecipeLibrary({store,config,desks});return library.validateNative(library.snapshot(deskId,need(values.recipe,'--recipe')));}
  if(action==='open'){
    desks.require(deskId,{active:true});
    return openDeskSpace({desk:desks.show(deskId),appCall,spaceId:values.space,getTerminal:terminal=>rpc.request('terminal.get',{terminal})});
  }
  const lists={projects:'projects',resources:'resources',definitions:'definitions',workflows:'workflows',work:'works',jobs:'jobs',teams:'teams',automations:'automations'};
  if(lists[action])return desks[lists[action]](deskId);
  const inserts={'project-add':'projectAdd','resource-add':'resourceAdd','definition-put':'definitionPut','workflow-put':'workflowPut','work-create':'workCreate','job-create':'jobCreate','team-put':'teamPut','automation-put':'automationPut'};
  if(inserts[action])return desks[inserts[action]]({...payload(),deskId});
  if(action==='resource-update'){const {id,...patch}=payload();return desks.resourceUpdate(deskId,need(id,'payload id'),patch);}
  if(action==='work-update'||action==='job-update'){
    const {id,...patch}=payload();return desks[action==='work-update'?'workUpdate':'jobUpdate'](deskId,need(id,'payload id'),patch);
  }
  if(action==='agents')return delegationFactory({config,store,rpc,pulse}).list({deskId,threadId:values.thread});
  if(action==='activity')return desks.events(deskId,{after:values.after===undefined?0:Number(values.after)});
  if(action==='run'){
    const parameters=values['params-file']?JSON.parse(readFileSync(values['params-file'],'utf8')):{};
    const job=desks.jobCreate({deskId,id:need(values.job,'--job stable-id'),workflowId:need(values.workflow,'--workflow'),
      workflowVersion:positive(values['workflow-version']),projectId:values['desk-project'],ownerThread:need(values.thread,'--thread'),workId:values.work,parameters});
    if(['completed','cancelled','failed'].includes(job.status))return {job,reused:true,actionable:false,note:'Settled job; no agent started.'};
    if(job.snapshot.workflow.steps?.length)return runtime().create({deskId,id:job.id,workflowId:job.workflowId,workflowVersion:job.workflowVersion,ownerThread:job.ownerThread,projectId:job.projectId,workId:job.workId,parameters});
    const definition=job.snapshot.definition,workflow=job.snapshot.workflow;
    const agentId=job.agentId??'dj-'+digest(deskId+':'+job.id).slice(0,25);
    const api=delegationFactory({config,store,rpc,pulse});
    try{
      const result=await api.delegate({id:agentId,name:agentId,deskId,deskProjectId:job.projectId,
        deskDefinitionId:definition.id,deskDefinitionVersion:definition.version,deskJobId:job.id,deskWorkId:job.workId,
        threadId:job.ownerThread,instruction:[workflow.instructions,...workflow.acceptance.map(x=>'Acceptance: '+x)].join('\n\n')});
      const running=result.request?.state==='sent';
      if(running&&job.status==='pending')desks.jobUpdate(deskId,job.id,{status:'running',taskId:result.taskId,agentId:result.agentId,note:'Initial native assignment accepted; execution and business outcome remain unverified.'});
      else if(!running&&job.status==='pending')desks.jobUpdate(deskId,job.id,{taskId:result.taskId,agentId:result.agentId,note:'Inspect native launch/request state before retrying; no duplicate agent was created.'});
      if(job.workId){
        const work=desks.work(deskId,job.workId);
        if(['planned','assigned'].includes(work.status))desks.workUpdate(deskId,job.workId,{status:running?'running':'assigned',ownerThread:job.ownerThread,taskId:result.taskId,agentId:result.agentId});
      }
      return {job:desks.job(deskId,job.id),agent:result};
    }catch(error){
      store.journal('desk.job.dispatch-error',{deskId,id:job.id,agentId,error:String(error.message).slice(0,500)});
      throw error;
    }
  }
  throw new Error('Unknown desk operation. Run help for available desk commands.');
}
