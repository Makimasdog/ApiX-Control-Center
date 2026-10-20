import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createAutonomy} from '../dist/src/coordination/autonomy.js';
import {parseArchitecture,autonomyDefaults} from '../dist/src/coordination/architecture.js';
import {taskProfile} from '../dist/src/coordination/scheduling.js';
import {createApiXAgent} from '../dist/src/coordination/apix-agent.js';
async function fixture(work){
  const dir=await mkdtemp(join(tmpdir(),'apix-autonomy-unit-'));const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE plans(id TEXT PRIMARY KEY,project_id TEXT);CREATE TABLE coordination_sessions(id TEXT PRIMARY KEY,plan_id TEXT,revision INTEGER,confirmed_revision INTEGER,status TEXT);CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,plan_id TEXT,employee_id TEXT,runtime TEXT,prompt TEXT,status TEXT,workspace_path TEXT,result TEXT,updated_at TEXT);CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,status TEXT,started_at TEXT,ended_at TEXT);CREATE TABLE agent_messages(id TEXT PRIMARY KEY,task_id TEXT,target_task_id TEXT,target_run_id TEXT,from_agent TEXT,to_agent TEXT,type TEXT,payload TEXT,status TEXT,created_at TEXT);CREATE TABLE task_dependencies(task_id TEXT,depends_on_id TEXT);CREATE TABLE code_handoffs(task_id TEXT,status TEXT);
    INSERT INTO projects VALUES ('p');INSERT INTO plans VALUES ('plan','p');INSERT INTO coordination_sessions VALUES ('s','plan',1,1,'running');`);
  const store={db,row:(sql,...params)=>db.prepare(sql).get(...params),rows:(sql,...params)=>db.prepare(sql).all(...params),now:()=>new Date().toISOString()};
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('t','p','plan','a','codex','approved task','awaiting_approval',dir,'',store.now());db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('run','t','running',new Date(Date.now()-40000).toISOString(),null);
  await writeFile(join(dir,'verify.mjs'),"console.log('host check passed');");
  let workflow={enabled:true,version:1,employeeIds:['a','b']};let permission='full_access';let reviews=0,accepts=0,retries=0;const events=[];
  const deps={...store,permissions:{get:()=>({mode:permission,version:1}),decision:()=>permission==='full_access'?'allow':'deny',assertGranted:()=>{if(permission!=='full_access')throw new Error('revoked');}},scheduling:{assertBinding:()=>{},taskSpec:()=>taskProfile({difficulty:2}),candidates:()=>[{employeeId:'a',eligible:true,waiting:null},{employeeId:'b',eligible:true,waiting:null}]},employees:()=>[],workflow:()=>workflow,inspect:async()=>({fingerprint:'stable',files:['a.txt'],conflicts:[],preview:'real diff',previewTruncated:false}),workspace:()=>dir,accept:()=>{accepts++;db.prepare("UPDATE tasks SET status='accepted' WHERE id='t'").run();},review:async()=>{reviews++;return {passed:true,findings:[],reviewMode:'apix_self_review'};},retry:async(task,employeeId,prompt)=>{retries++;db.prepare("UPDATE tasks SET status='running',employee_id=?,prompt=? WHERE id='t'").run(employeeId,prompt);},reassignPending:()=>{},stop:()=>{db.exec("UPDATE tasks SET status='cancelled';UPDATE runs SET status='cancelled'");},sendMessage:input=>{const id='m'+Math.random();db.prepare('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,'t','t','run','apix-director','a','event',JSON.stringify(input.payload),'queued',store.now());return {id,status:'queued'};},record:(taskId,kind,payload)=>events.push({taskId,kind,payload})};
  let service=createAutonomy(deps);const policy={...autonomyDefaults,enabled:true,approved:true,checkpointMinutes:1,maxRunMinutes:10,checks:[{id:'tests',args:['verify.mjs'],timeoutMs:1000}]};
  service.save('p',policy);const architecture=parseArchitecture({summary:'scope',modules:[{id:'core',name:'core',paths:['a.txt'],dependsOn:[],risk:'high',difficulty:2,workload:{inputTokens:1000,outputTokens:100,calls:1},interfaces:[],dataStructures:[],acceptance:['host verification'],checkIds:['tests']}]},policy.checks);service.bindPlan('plan','s',1,architecture,[{taskId:'t',moduleId:'core',prompt:'approved task'}]);
  db.exec("UPDATE tasks SET status='running'");try{await work({dir,db,store,service,deps,events,counts:()=>({reviews,accepts,retries}),revoke:()=>permission='read_only',restart:()=>service=createAutonomy(deps)});}finally{db.close();const path=resolve(dir);assert(path.startsWith(resolve(tmpdir())+(process.platform==='win32'?'\\':'/')));await rm(path,{recursive:true,force:true});}
}
test('oversized complete review evidence pauses delivery without accepting or spending repair attempts',()=>fixture(async({db,service,deps,counts})=>{
  let calls=0;const agent=createApiXAgent({infer:async()=>{calls++;return '{"passed":true,"findings":[]}';}});
  const inspect=deps.inspect;
  deps.inspect=async()=>({...await inspect(),context:{files:[{path:'a.txt',content:'\n'.repeat(60000)}],truncated:false}});
  deps.review=async(_project,_session,architecture,moduleId,evidence)=>agent.review({goal:'实现',scope:'a.txt',constraints:'安全',deliverable:'代码',acceptance:'完整检查'},architecture,moduleId,evidence,{projectId:'p',purpose:'quality'});
  db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");
  await service.tick();
  assert.equal(service.details('plan').state,'attention');assert.match(service.details('plan').reason,/验收证据超出完整上下文预算/);
  assert.equal(calls,0);assert.equal(counts().accepts,0);assert.equal(counts().retries,0);
  assert.equal(service.details('plan').checks[0].status,'error');
}));

test('high risk checkpoints repeat and two unanswered checkpoints stop the known run before reassignment',()=>fixture(async({db,service,events,counts})=>{
  await service.tick();assert.equal(events.filter(e=>e.kind==='autonomy.checkpoint').length,1);
  const stale=new Date(Date.now()-35000).toISOString();db.prepare('UPDATE autonomy_tasks SET last_checkpoint=?').run(stale);db.prepare('UPDATE agent_messages SET created_at=?').run(stale);
  await service.tick();assert.equal(events.filter(e=>e.kind==='autonomy.checkpoint').length,2);
  db.prepare('UPDATE autonomy_tasks SET last_checkpoint=?').run(stale);db.prepare('UPDATE agent_messages SET created_at=?').run(stale);
  await service.tick();assert(events.some(e=>e.kind==='autonomy.unresponsive_stop'));assert.equal(counts().retries,0);
  await service.tick();assert.equal(counts().retries,1);assert.equal(service.details('plan').repairs[0].employee_id,'b');assert.equal(service.details('plan').repairs[0].status,'dispatched');
}));

test('credential configuration blockers pause autonomy without code repair attempts',()=>fixture(async({db,service,counts})=>{
  db.prepare("UPDATE tasks SET status='blocked',result=?").run('员工认证与管理者凭据共用，请分离密钥');
  db.exec("UPDATE runs SET status='cancelled'");await service.tick();
  assert.equal(service.details('plan').state,'attention');assert.deepEqual(counts(),{reviews:0,accepts:0,retries:0});
}));
test('unknown workers require explicit recovery and are never automatically retried',()=>fixture(async({db,service,counts})=>{
  db.exec("UPDATE tasks SET status='unknown';UPDATE runs SET status='unknown'");await service.tick();assert.equal(service.details('plan').state,'attention');assert.equal(counts().retries,0);assert.throws(()=>service.resume('plan',{reviewed:true,fingerprint:service.resumeFingerprint('plan')}),/原员工/);
}));
test('permission revoked while reviewing actual checks prevents acceptance and repair',()=>fixture(async({db,service,deps,revoke,counts})=>{
  db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");deps.review=async()=>{revoke();return {passed:true,findings:[],reviewMode:'apix_self_review'};};await service.tick();assert.equal(counts().accepts,0);assert.equal(counts().retries,0);assert.equal(service.details('plan').state,'attention');
}));
test('restart preserves interrupted verification and requires a fresh explicit stop confirmation',()=>fixture(async({db,service,restart})=>{
  db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed';INSERT INTO autonomy_checks VALUES ('check','t','run','running','stable','{}','now')");const restored=restart();assert.equal(restored.details('plan').checks[0].status,'interrupted');assert.equal(restored.details('plan').state,'attention');
  const input={reviewed:true,fingerprint:restored.resumeFingerprint('plan')};assert.throws(()=>restored.resume('plan',input),/确认已停止/);restored.resume('plan',{...input,confirmedStopped:true});await restored.tick();assert.equal(restored.details('plan').state,'completed');assert(restored.details('plan').checks.some(c=>c.status==='passed'));assert.equal(restart().details('plan').state,'completed','resolved interrupted history must not reopen a delivered plan');
}));
test('manual recovery resume activates an already authorized pending retry and preserves fingerprint checks',()=>fixture(async({db,service,deps})=>{
  db.exec("UPDATE tasks SET status='awaiting_approval';UPDATE runs SET status='cancelled';UPDATE autonomy_plans SET state='attention',reason='worker recovery'");let activated=0;deps.activatePending=()=>activated++;
  assert.throws(()=>service.resume('plan',{reviewed:true,fingerprint:'stale'}),/检查/);service.resume('plan',{reviewed:true,fingerprint:service.resumeFingerprint('plan')});assert.equal(activated,1);assert.equal(service.details('plan').state,'running');
}));
test('a changed model or budget binding during quality review cannot be silently approved',()=>fixture(async({db,service,deps,counts})=>{
  db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");deps.review=async()=>{deps.scheduling.assertBinding=()=>{throw new Error('档案版本已变化');};return {passed:true,findings:[],reviewMode:'apix_self_review'};};await service.tick();assert.equal(counts().accepts,0);assert.match(service.details('plan').reason,/档案版本/);
}));
test('never-run queued work is reassigned within the same module when its original runtime becomes unavailable',()=>fixture(async({db,service,deps})=>{
  db.exec("UPDATE tasks SET status='queued';DELETE FROM runs");let assigned=null;deps.scheduling.candidates=()=>[{employeeId:'a',eligible:false,waiting:'unavailable'},{employeeId:'b',eligible:true,waiting:null}];deps.scheduling.assertBinding=()=>{throw new Error('runtime availability changed');};deps.reassignPending=(taskId,employeeId)=>assigned={taskId,employeeId};await service.tick();assert.deepEqual(assigned,{taskId:'t',employeeId:'b'});assert.equal(service.details('plan').state,'running');
}));

test('Q03 truncated evidence and conflicts pause without invoking review or repair',async()=>{
  for(const change of [{previewTruncated:true},{context:{files:[],truncated:true}},{conflicts:['a.txt']}])await fixture(async({db,service,deps,counts})=>{
    db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");const inspect=deps.inspect;deps.inspect=async()=>({...await inspect(),...change});await service.tick();
    assert.equal(service.details('plan').state,'attention');assert.deepEqual(counts(),{reviews:0,accepts:0,retries:0});
  });
});
test('Q04 scope violations produce specific repairs instead of acceptance',()=>fixture(async({db,service,deps,counts})=>{
  db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");const inspect=deps.inspect;deps.inspect=async()=>({...await inspect(),files:['a.txt','outside.txt']});await service.tick();
  assert.equal(counts().accepts,0);assert.equal(counts().reviews,0);assert.equal(counts().retries,1);assert.match(service.details('plan').repairs[0].instruction,/outside.txt/);
}));
test('Q05 changing code during actual checks or model review invalidates acceptance',async()=>{
  for(const phase of ['checks','review'])await fixture(async({db,service,deps,counts})=>{
    db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");let inspections=0;const inspect=deps.inspect;deps.inspect=async()=>({...await inspect(),fingerprint:++inspections> (phase==='checks'?1:2)?'changed':'stable'});await service.tick();
    assert.equal(counts().accepts,0);assert.equal(counts().retries,0);assert.equal(counts().reviews,phase==='checks'?0:1);assert.equal(service.details('plan').state,'attention');assert.match(service.details('plan').checks[0].body.error,/变化|修改/);
  });
});
test('Q06 a missing verification script remains an error and is never accepted',()=>fixture(async({dir,db,service,counts})=>{
  await rm(join(dir,'verify.mjs'));db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");await service.tick();assert.equal(service.details('plan').state,'attention');assert.equal(service.details('plan').checks[0].status,'error');assert.deepEqual(counts(),{reviews:0,accepts:0,retries:0});
}));
test('Q07 an actual hung check is terminated and creates a bounded repair',()=>fixture(async({dir,db,service,counts})=>{
  await writeFile(join(dir,'verify.mjs'),"console.log('entered actual hanging check');setInterval(()=>{},100);");db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");await service.tick();const check=service.details('plan').checks[0];
  assert.equal(check.status,'failed');assert.equal(check.body.tests[0].timedOut,true);assert.match(check.body.tests[0].output,/entered actual/);assert.equal(counts().reviews,0);assert.equal(counts().accepts,0);assert.equal(counts().retries,1);
}));
test('Q08 concurrent ticks perform one actual check and one acceptance',()=>fixture(async({dir,db,service,deps,counts})=>{
  await writeFile(join(dir,'verify.mjs'),"setTimeout(()=>console.log('actual delayed check'),100);");db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");let reviews=0;deps.review=async()=>{reviews++;return {passed:true,findings:[],reviewMode:'apix_self_review'};};await Promise.all([service.tick(),service.tick()]);
  assert.equal(service.details('plan').checks.length,1);assert.equal(counts().accepts,1);assert.equal(reviews,1);assert.equal(service.details('plan').state,'completed');
}));
test('S02 blocked reports and runtime deadlines stop before the next repair',async()=>{
  for(const reason of ['blocked','timeout'])await fixture(async({db,service,events,counts})=>{
    if(reason==='blocked')db.prepare('INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?,?,?,?)').run('blocked','t','t','run','a','apix-director','event',JSON.stringify({blocked:true}),'completed',new Date().toISOString());
    else db.prepare('UPDATE runs SET started_at=?').run(new Date(Date.now()-11*60000).toISOString());
    await service.tick();assert(events.some(e=>e.kind===(reason==='blocked'?'autonomy.blocked_stop':'autonomy.timeout')));assert.equal(counts().retries,0);await service.tick();assert.equal(counts().retries,1);
  });
});
test('S03 the total goal deadline stops the run without creating a repair',()=>fixture(async({db,service,counts})=>{
  db.prepare('UPDATE autonomy_plans SET started_at=?').run(new Date(Date.now()-121*60000).toISOString());await service.tick();assert.equal(service.details('plan').state,'attention');assert.match(service.details('plan').reason,/时间上限/);assert.equal(db.prepare("SELECT status FROM runs WHERE id='run'").get().status,'cancelled');assert.equal(counts().retries,0);
}));
test('resource contention defers one repair and resumes automatically without spending the repair count',()=>fixture(async({dir,db,service,deps,counts,events})=>{
  await writeFile(join(dir,'verify.mjs'),"process.exitCode=1;console.log('repair this failure');");db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");let waiting=true;const eligible=deps.scheduling.candidates;deps.scheduling.candidates=()=>eligible().map(c=>({...c,waiting:waiting?'concurrency occupied':null}));
  await service.tick();assert.equal(service.details('plan').state,'running');assert.equal(service.details('plan').repairs[0].status,'waiting');assert.equal(service.details('plan').tasks[0].repairs,0);assert.equal(counts().retries,0);
  await service.tick();assert.equal(service.details('plan').repairs.length,1);assert.equal(events.filter(e=>e.kind==='autonomy.repair_waiting').length,1);
  waiting=false;await Promise.all([service.tick(),service.tick()]);assert.equal(counts().retries,1);assert.equal(service.details('plan').repairs.length,1);assert.equal(service.details('plan').repairs[0].status,'dispatched');assert.match(service.details('plan').repairs[0].instruction,/repair this failure/);
}));
test('waiting repair cannot override manual rejection of a later run or revoked permissions',async()=>{
  for(const change of ['new-run','revoke'])await fixture(async({db,service,deps,revoke,counts})=>{
    db.exec("UPDATE tasks SET status='failed';UPDATE runs SET status='failed'");deps.scheduling.candidates=()=>[{employeeId:'a',eligible:true,waiting:'busy'}];await service.tick();assert.equal(service.details('plan').repairs[0].status,'waiting');
    if(change==='new-run')db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('later','t','completed',new Date(Date.now()-60000).toISOString(),new Date().toISOString());else revoke();
    deps.scheduling.candidates=()=>[{employeeId:'a',eligible:true,waiting:null}];await service.tick();assert.equal(counts().retries,0);assert.equal(service.details('plan').state,'attention');
  });
});
test('persisted invalid or tampered contracts are rejected on restart before any quality approval',async()=>{
  for(const change of ['schema','digest'])await fixture(async({db,restart,counts})=>{
    const saved=JSON.parse(db.prepare('SELECT body FROM autonomy_plans').get().body);if(change==='schema')saved.modules[0].dataStructures=[{name:'bad',schema:{type:'invalid'}}];else saved.digest='tampered';db.prepare('UPDATE autonomy_plans SET body=?').run(JSON.stringify(saved));db.exec("UPDATE tasks SET status='completed';UPDATE runs SET status='completed'");const service=restart();await service.tick();assert.equal(service.details('plan').state,'attention');assert.deepEqual(counts(),{reviews:0,accepts:0,retries:0});
  });
});
test('waiting for repair resources keeps only clean never-run dependencies waiting',async()=>{
  for(const conflict of [false,true])await fixture(async({db,service,deps,counts})=>{
    db.exec("UPDATE tasks SET status='failed';UPDATE runs SET status='failed';INSERT INTO tasks SELECT 'child',project_id,plan_id,employee_id,runtime,'integration','blocked',NULL,'',updated_at FROM tasks WHERE id='t';INSERT INTO task_dependencies VALUES ('child','t');INSERT INTO autonomy_tasks(task_id,module_id,original_prompt) VALUES ('child','integration','integration')");deps.scheduling.candidates=()=>[{employeeId:'a',eligible:true,waiting:'busy'}];if(conflict)db.exec("INSERT INTO code_handoffs VALUES ('child','conflict')");await service.tick();assert.equal(service.details('plan').state,conflict?'attention':'running');assert.equal(counts().retries,0);
  });
});
test('repair migration preserves old evidence without binding unconfirmed waiting work to a run',()=>fixture(async({db,restart,counts})=>{
  db.exec("INSERT INTO autonomy_repairs(id,task_id,attempt,employee_id,instruction,status,created_at) VALUES ('old','t',1,'a','old evidence','waiting','2026-10-14');ALTER TABLE autonomy_repairs DROP COLUMN run_id;UPDATE tasks SET status='needs_revision';UPDATE runs SET status='completed'");const restored=restart();assert.equal(restored.details('plan').repairs[0].instruction,'old evidence');assert.equal(restored.details('plan').repairs[0].run_id,null);await restored.tick();assert.equal(counts().retries,0);assert.equal(restored.details('plan').state,'attention');
}));
