import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {startDeliveryFixture} from './delivery-fixture.mjs';
async function until(read){const end=Date.now()+30000;while(Date.now()<end){const result=await read();if(result)return result;await new Promise(r=>setTimeout(r,50));}throw Error('recovery fixture deadline');}
test('failed employee is automatically reassigned with its workspace preserved and DAG waits for acceptance',{timeout:90000},async()=>{
 let primary,alternate;
 const h=await startDeliveryFixture({startupMs:30000,requestMs:30000,runtimeEntries:{APIX_SUPERVISION_TICK_MS:'1000'},plan:()=>({steps:[{employeeId:primary,prompt:'first module',dependsOn:[]},{employeeId:alternate,prompt:'dependent module',dependsOn:[0]}]}),setup:async project=>{
  await writeFile(join(project,'README.md'),'recovery fixture');for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','test@example.invalid'],['add','README.md'],['commit','-m','fixture']])execFileSync('git',args,{cwd:project,stdio:'ignore'});
 }});
 try{
  const worker=join(h.dir,'worker.mjs'),release=join(h.dir,'release');
  await writeFile(worker,`import{writeFileSync,readFileSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{if(process.argv[2]==='bad'){writeFileSync('partial.txt','preserved');process.stderr.write('expected 2 but received 3');process.exitCode=1;return;}while(!existsSync(${JSON.stringify(release)}))await delay(50);process.stdout.write('finished '+(existsSync('partial.txt')?readFileSync('partial.txt','utf8'):'dependent'));});`);
  for(const [id,mode]of[['recovery-bad','bad'],['recovery-good','good']])await h.request('/api/adapters',{id,name:id,executable:process.execPath,args:[worker,mode],format:'plain'});
  primary=(await h.request('/api/employees',{name:'first worker',runtime:'recovery-bad',role:'implement'})).id;alternate=(await h.request('/api/employees',{name:'replacement',runtime:'recovery-good',role:'implement'})).id;
  const workflow=await h.request('/api/projects/'+h.projectId+'/workflow');await h.request('/api/projects/'+h.projectId+'/workflow',{version:workflow.version,enabled:true,approved:true,managerVersion:workflow.manager.version,employees:[primary,alternate].map(id=>({id,version:0}))});
  let s=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:'automatically recover first module then continue dependent'});const base='/api/coordination/sessions/'+s.id;
  for(const[field,value]of Object.entries({scope:'README and partial.txt',constraints:'local files only',deliverable:'two reports',acceptance:'inspect actual run records'}))s=await h.request(base+'/answers',{revision:s.revision,field,value});
  s=await h.request(base+'/confirm',{revision:s.revision});if(s.status==='plan_review')s=await h.request(base+'/dispatch',{planVersion:s.planVersion});assert.equal(s.failures.length,0);
  const failure=await until(async()=>{const state=await h.request(base);return state.tasks[0].status==='failed'&&state;});
  assert.equal(failure.derivedStatus,'queued');assert.equal(failure.tasks[0].recovery.automatic,true);assert.match(failure.tasks[0].result,/expected 2/);assert.equal(failure.tasks[1].status,'queued');
  const repairing=await until(async()=>{const state=await h.request(base);return state.tasks[0].employee_id===alternate&&state.tasks[0].status==='running'&&state.tasks[0].recovery.state==='dispatched'&&state;});
  assert.equal(repairing.tasks[0].recovery.attempts,1);assert.equal(repairing.tasks[1].status,'queued');assert.match(repairing.tasks[0].prompt,/expected 2 but received 3/);
  await writeFile(release,'continue');s=await until(async()=>{const state=await h.request(base);return state.tasks[0].status==='completed'&&state;});assert.equal(s.tasks[0].result,'finished preserved');assert.equal(s.tasks[1].status,'queued');
  const delivery=await h.request('/api/tasks/'+s.tasks[0].id+'/delivery');await h.request('/api/tasks/'+s.tasks[0].id+'/review',{accepted:true,fingerprint:delivery.inspection.fingerprint});
  s=await until(async()=>{const state=await h.request(base);return state.tasks[1].status==='completed'&&state;});assert.equal(s.tasks[0].status,'accepted');
  const details=await h.request('/api/tasks/'+s.tasks[0].id+'/details');assert.equal(details.runs.length,2);assert.equal(details.runs[1].status,'failed');assert.equal(h.calls.length,1);
 }finally{await h.close();}
});
