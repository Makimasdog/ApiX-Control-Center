import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';

export const collaborationVersion='collaboration-v1';
export async function runCollaborationScenario(caseId,{gateway}={}){
  const checks=[],artifacts={};let h,base,session;
  const check=(id,actual,expected,refs=[])=>{const passed=JSON.stringify(actual)===JSON.stringify(expected);checks.push({id,actual,expected,passed,refs});assert(passed,id+': '+JSON.stringify(actual));};
  const until=async(read,label)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const value=await read();if(value)return value;await delay(80);}throw new Error('scenario deadline: '+label);};
  const state=()=>h.request(base);
  const accept=async task=>{const delivery=await h.request('/api/tasks/'+task.id+'/delivery');artifacts[task.id]=delivery;await h.request('/api/tasks/'+task.id+'/review',{accepted:true,fingerprint:delivery.inspection.fingerprint});};
  let steps=[];
  try{
    h=await startDeliveryFixture({name:'OpenJudge '+caseId,startupMs:30000,requestMs:30000,plan:()=>({steps}),runtimeEntries:{APIX_SUPERVISION_TICK_MS:'300'},setup:async project=>{
      await writeFile(join(project,'README.md'),'user-owned fixture bytes\n');
      for(const args of [['init'],['config','core.autocrlf','false'],['config','user.name','ApiX Evaluation'],['config','user.email','test@example.invalid'],['add','README.md'],['commit','-m','fixture baseline']])execFileSync('git',args,{cwd:project,stdio:'ignore',windowsHide:true});
    }});
    const employee=async(id,mode='normal')=>{
      await h.request('/api/adapters',{id,name:id,executable:process.execPath,args:[resolve('test/evaluation-worker.mjs'),mode,...(gateway?[gateway.baseUrl,gateway.model]:[])],format:'plain'});
      return (await h.request('/api/employees',{name:id,runtime:id,role:'implementation testing review'})).id;
    };
    if(caseId==='collaboration-diamond'){
      const ids=[];for(const name of ['implement','test','docs','integrate'])ids.push(await employee('eval-'+name));
      steps=[{employeeId:ids[0],prompt:'APIX_EVAL_IMPLEMENT',dependsOn:[]},{employeeId:ids[1],prompt:'APIX_EVAL_TEST',dependsOn:[0]},{employeeId:ids[2],prompt:'APIX_EVAL_DOC',dependsOn:[0]},{employeeId:ids[3],prompt:'APIX_EVAL_INTEGRATE',dependsOn:[1,2]}];
      await h.request('/api/projects/'+h.projectId+'/execution',{version:0,projectLimit:2,employeeLimit:1});
    }else if(caseId==='collaboration-recovery'){
      const primary=await employee('eval-failing','fail'),alternate=await employee('eval-replacement');
      const workflow=await h.request('/api/projects/'+h.projectId+'/workflow');
      await h.request('/api/projects/'+h.projectId+'/workflow',{version:workflow.version,enabled:true,approved:true,managerVersion:workflow.manager.version,employees:[primary,alternate].map(id=>({id,version:0}))});
      steps=[{employeeId:primary,prompt:'APIX_EVAL_RECOVER',dependsOn:[]},{employeeId:alternate,prompt:'APIX_EVAL_DEPENDENT',dependsOn:[0]}];
    }else if(caseId==='collaboration-stop'){
      const id=await employee('eval-stoppable','hold');steps=[{employeeId:id,prompt:'APIX_EVAL_STOP',dependsOn:[]},{employeeId:id,prompt:'APIX_EVAL_MUST_NOT_START',dependsOn:[0]}];
    }else throw new Error('Unknown collaboration case');
    if(gateway)await h.request('/api/manager/settings',{baseUrl:gateway.baseUrl,model:gateway.model,apiType:'openai-completions',apiKeyEnv:''});
    session=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:caseId+' '+JSON.stringify({requiredSteps:steps})});base='/api/coordination/sessions/'+session.id;
    for(const[field,value]of Object.entries({scope:'isolated evaluation project only',constraints:'no external providers, no credentials in artifacts',deliverable:'actual files and execution evidence',acceptance:'frozen handoff, verified artifacts and correct dependencies'}))session=await h.request(base+'/answers',{revision:session.revision,field,value});
    session=await h.request(base+'/confirm',{revision:session.revision});
    if(gateway){
      check('real-manager-produced-plan',session.agent.mode,'api',[session.id]);
      // Keep test inputs fixed after observing the actual manager plan; this is an explicit operator plan edit.
      session=await h.request(base+'/plan',{revision:session.revision,planVersion:session.planVersion,steps});
    }
    if(session.status==='plan_review')session=await h.request(base+'/dispatch',{planVersion:session.planVersion});
    check('dispatch-no-failure',session.failures.length,0,[session.id]);
    if(caseId==='collaboration-diamond'){
      session=await until(async()=>{const s=await state();return s.tasks[0].status==='completed'&&s;},'implementation');
      check('dependencies-wait-for-acceptance',session.tasks.slice(1).map(t=>t.status),['queued','queued','queued'],session.tasks.map(t=>t.id));
      await accept(session.tasks[0]);
      session=await until(async()=>{const s=await state();return s.tasks[1].status==='running'&&s.tasks[2].status==='running'&&s;},'parallel branches');
      check('two-distinct-workers-running',new Set(session.tasks.slice(1,3).map(t=>t.employee_id)).size,2,session.tasks.slice(1,3).map(t=>t.id));
      check('integration-waits',session.tasks[3].status,'queued',[session.tasks[3].id]);
      for(const task of session.tasks.slice(1,3)){
        const s=await state();await h.request(base+'/instructions',{revision:s.revision,taskId:task.id,content:'APIX_EVAL_GUIDANCE verify actual files and retain README'});
      }
      session=await until(async()=>{const s=await state();return s.tasks.slice(1,3).every(t=>t.status==='completed')&&s;},'guided branches');
      check('guidance-completed',session.instructions.filter(m=>session.tasks.slice(1,3).some(t=>t.id===m.taskId)).map(m=>m.status),['completed','completed'],session.instructions.map(m=>m.id));
      await accept(session.tasks[1]);check('one-branch-insufficient',(await state()).tasks[3].status,'queued',[session.tasks[3].id]);
      await accept(session.tasks[2]);
      session=await until(async()=>{const s=await state();return s.tasks[3].status==='completed'&&s;},'integration');
      const delivery=await h.request('/api/tasks/'+session.tasks[3].id+'/delivery');
      const output=execFileSync(process.execPath,['verify.mjs'],{cwd:delivery.workspacePath,encoding:'utf8',windowsHide:true,timeout:5000});
      check('host-verifies-integrated-code',output.trim(),'APIX_EVAL_VERIFIED',[session.tasks[3].id]);
      execFileSync(process.execPath,['--input-type=module','--eval',"import assert from 'node:assert/strict';import {sum} from './sum.mjs';for(const [a,b] of [[17,23],[-19,8],[0,0],[.25,.5]])assert.equal(sum(a,b),a+b);"],{cwd:delivery.workspacePath,windowsHide:true,timeout:5000});
      check('host-hidden-inputs',true,true,[session.tasks[3].id]);
      check('both-branches-transferred',(await readFile(join(delivery.workspacePath,'review.md'),'utf8')).includes('APIX_EVAL_GUIDANCE_OK'),true,[session.tasks[3].id]);
      check('user-content-preserved',await readFile(join(delivery.workspacePath,'README.md'),'utf8'),'user-owned fixture bytes\n',[session.tasks[3].id]);
      await accept(session.tasks[3]);session=await state();check('all-deliveries-accepted',session.tasks.map(t=>t.status),['accepted','accepted','accepted','accepted'],session.tasks.map(t=>t.id));
      check('session-completed',session.derivedStatus,'completed',[session.id]);
      await h.restart();check('accepted-state-survives-restart',(await state()).derivedStatus,'completed',[session.id]);
    }else if(caseId==='collaboration-recovery'){
      session=await until(async()=>{const s=await state();return s.tasks[0].status==='completed'&&s;},'automatic recovery');
      check('reassigned-to-alternate',session.tasks[0].employee_id,steps[1].employeeId,[session.tasks[0].id]);
      check('partial-work-preserved',session.tasks[0].result.includes('preserve recovery evidence'),true,[session.tasks[0].id]);
      check('recovery-does-not-bypass-acceptance',session.tasks[1].status,'queued',[session.tasks[1].id]);
      const details=await h.request('/api/tasks/'+session.tasks[0].id+'/details');
      check('one-failed-one-recovered-run',details.runs.map(r=>r.status).sort(),['completed','failed'],details.runs.map(r=>r.id));
      await accept(session.tasks[0]);session=await until(async()=>{const s=await state();return s.tasks[1].status==='completed'&&s;},'dependent after repair');
      await accept(session.tasks[1]);session=await state();check('recovered-session-completed',session.derivedStatus,'completed',[session.id]);
    }else{
      session=await until(async()=>{const s=await state();if(s.tasks[0].status!=='running')return false;const d=await h.request('/api/tasks/'+s.tasks[0].id+'/delivery');try{await readFile(join(d.workspacePath,'started.txt'));return s;}catch{return false;}},'owned worker startup');
      const details=await h.request('/api/tasks/'+session.tasks[0].id+'/details');
      await h.request('/api/runs/'+details.runs[0].id+'/stop',{});
      session=await until(async()=>{const s=await state();return ['cancelled','unknown'].includes(s.tasks[0].status)&&s;},'stop');
      const runs=(await h.request('/api/snapshot')).runs;
      check('dependent-never-launched',runs.filter(r=>r.task_id===session.tasks[1].id).length,0,[session.tasks[1].id]);
      check('stopped-run-not-completed',runs.find(r=>r.id===details.runs[0].id)?.status==='completed',false,[details.runs[0].id]);
      const runtime=await h.request('/api/runs/'+details.runs[0].id+'/runtime');
      check('stop-evidence-known',['root_exited','quiescent'].includes(runtime.stopEvidence),true,[details.runs[0].id]);
    }
    return {caseId,scenarioVersion:collaborationVersion,runType:gateway?'real-provider':'local-protocol',status:'pass',checks,semanticStatus:'not_run',artifacts:await capture()};
  }catch(error){
    return {caseId,scenarioVersion:collaborationVersion,runType:gateway?'real-provider':'local-protocol',status:'fail',checks,error:error.message,semanticStatus:'not_run',artifacts:await capture()};
  }finally{
    if(h){
      const active=(await h.request('/api/snapshot')).runs.filter(r=>['running','starting','stopping'].includes(r.status));
      for(const run of active)await h.request('/api/runs/'+run.id+'/stop',{});
      if(active.length)await until(async()=>!(await h.request('/api/snapshot')).runs.some(r=>['running','starting','stopping'].includes(r.status)),'cleanup');
      await h.close(true);
    }
  }
  async function capture(){
    if(!h)return {collection:'unavailable'};
    const snapshot=await h.request('/api/snapshot');
    return {directory:h.dir,projectId:h.projectId,sessionId:session?.id??null,session:base?await state():null,runs:snapshot.runs.map(({id,task_id,status,exit_code})=>({id,taskId:task_id,status,exitCode:exit_code})),deliveries:artifacts,modelCalls:h.calls,timeline:base?await h.request(base+'/timeline'):null};
  }
}
