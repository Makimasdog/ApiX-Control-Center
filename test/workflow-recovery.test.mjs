import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWorkflowRecovery} from '../src/coordination/workflow-recovery.mjs';
import {createTaskScheduler} from '../src/coordination/task-scheduler.mjs';

async function fixture(work){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,plan_id TEXT,employee_id TEXT,prompt TEXT,status TEXT,result TEXT,updated_at TEXT,queue_reason TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,status TEXT,ended_at TEXT);
    CREATE TABLE coordination_sessions(id TEXT,project_id TEXT,plan_id TEXT,revision INTEGER,confirmed_revision INTEGER,status TEXT);
    CREATE TABLE coordination_plan_briefs(plan_id TEXT,session_id TEXT,revision INTEGER);
    CREATE TABLE autonomy_plans(plan_id TEXT);
    CREATE TABLE code_handoffs(task_id TEXT,status TEXT);
    CREATE TABLE task_dependencies(task_id TEXT,depends_on_id TEXT);
    CREATE TABLE plans(id TEXT,mode TEXT);CREATE TABLE meeting_items(id TEXT,task_id TEXT);
    CREATE TABLE approvals(task_id TEXT,action TEXT,status TEXT,created_at TEXT);
    INSERT INTO tasks VALUES ('a','p','plan','worker','original','failed','failure',NULL,NULL),('b','p','plan','worker','next','blocked',NULL,NULL,NULL),('c','p','plan','worker','last','blocked',NULL,NULL,NULL);
    INSERT INTO runs VALUES ('r0','a','failed','ended');
    INSERT INTO coordination_sessions VALUES ('session','p','plan',1,1,'running');
    INSERT INTO coordination_plan_briefs VALUES ('plan','session',1);
    INSERT INTO plans VALUES ('plan','coordinator');
    INSERT INTO task_dependencies VALUES ('b','a'),('c','b');
    INSERT INTO approvals VALUES ('b','start-agent-in-project','approved','now'),('c','start-agent-in-project','approved','now');`);
  const store={db,row:(sql,...args)=>db.prepare(sql).get(...args),rows:(sql,...args)=>db.prepare(sql).all(...args),now:()=>new Date().toISOString()};
  const events=[],launches=[];let retries=0;
  const deps={...store,workflow:()=>({enabled:true,employeeIds:['worker','other']}),permissions:{decision:()=> 'allow',assertGranted:()=>{}},scheduling:{taskSpec:()=>({}),candidates:()=>[{employeeId:'worker',eligible:true},{employeeId:'other',eligible:true}]},record:(...args)=>events.push(args),retry:async(task,employeeId,prompt)=>{
    retries++;db.prepare("UPDATE tasks SET status='running',employee_id=?,prompt=? WHERE id=?").run(employeeId,prompt,task.id);
    db.prepare("INSERT INTO runs VALUES (?,?,'running',NULL)").run('r'+retries,task.id);
    scheduler.resumeBlocked(task.plan_id);scheduler.pump();
  }};
  const service=createWorkflowRecovery(deps);
  const scheduler=createTaskScheduler({...store,recoverable:service.pending,launch:task=>launches.push(task.id),onWaiting:(task,reason)=>db.prepare('UPDATE tasks SET queue_reason=? WHERE id=?').run(reason,task.id)});
  try{await work({db,store,deps,service,scheduler,events,launches,count:()=>retries,restart:()=>createWorkflowRecovery(deps)});}finally{db.close();}
}

test('ordinary collaboration repairs with an authorized alternative and releases a multi-level DAG only after acceptance',()=>fixture(async({db,store,service,scheduler,launches,count})=>{
  await Promise.all([service.tick(),service.tick()]);assert.equal(count(),1);
  assert.equal(store.row("SELECT employee_id FROM tasks WHERE id='a'").employee_id,'other');
  assert.equal(store.row("SELECT status FROM tasks WHERE id='c'").status,'queued');assert.deepEqual(launches,[]);
  db.exec("UPDATE tasks SET status='completed' WHERE id='a'");scheduler.pump();assert.deepEqual(launches,[]);
  db.exec("UPDATE tasks SET status='accepted' WHERE id='a'");scheduler.pump();assert.deepEqual(launches,['b']);
  db.exec("UPDATE tasks SET status='accepted' WHERE id='b'");scheduler.pump();assert.deepEqual(launches,['b','c']);
}));
test('new dependent tasks wait during repair instead of becoming terminally blocked',()=>fixture(async({db,store,scheduler,service})=>{
  db.exec("UPDATE tasks SET status='queued' WHERE id IN ('b','c')");scheduler.pump();
  assert.equal(store.row("SELECT status FROM tasks WHERE id='b'").status,'queued');
  assert.match(store.row("SELECT queue_reason FROM tasks WHERE id='b'").queue_reason,/自动恢复/);
  await service.tick();assert.equal(store.row("SELECT status FROM tasks WHERE id='c'").status,'queued');
}));
test('capacity waits consume no attempts and restart retains the two-attempt limit',()=>fixture(async({db,store,deps,service,restart,count})=>{
  deps.scheduling.candidates=()=>[{employeeId:'other',eligible:true,waiting:'occupied'}];await service.tick();assert.equal(count(),0);
  assert.equal(store.row('SELECT attempts FROM workflow_recoveries').attempts,0);
  deps.scheduling.candidates=()=>[{employeeId:'other',eligible:true}];await service.tick();
  db.exec("UPDATE tasks SET status='failed' WHERE id='a';UPDATE runs SET status='failed',ended_at='ended'");await restart().tick();
  db.exec("UPDATE tasks SET status='failed' WHERE id='a';UPDATE runs SET status='failed',ended_at='ended'");await restart().tick();
  assert.equal(count(),2);assert.equal(store.row('SELECT state FROM workflow_recoveries').state,'attention');
  assert.equal((store.row("SELECT prompt FROM tasks WHERE id='a'").prompt.match(/ApiX 自动恢复/g)||[]).length,1);
}));
test('cancel, unknown process, revoked authorization, stale plan, conflict and autonomous plans never use ordinary recovery',async()=>{
  for(const sql of ["UPDATE tasks SET status='cancelled' WHERE id='a'","UPDATE runs SET status='unknown'","UPDATE runs SET ended_at=NULL","UPDATE coordination_sessions SET confirmed_revision=2","UPDATE coordination_sessions SET status='stopped'","INSERT INTO code_handoffs VALUES ('a','conflict')","INSERT INTO autonomy_plans VALUES ('plan')"]){
    await fixture(async({db,service,count})=>{db.exec(sql);await service.tick();assert.equal(count(),0,sql);});
  }
  await fixture(async({deps,service,count})=>{deps.permissions.decision=()=> 'deny';await service.tick();assert.equal(count(),0);});
  await fixture(async({deps,service,count})=>{deps.permissions.assertGranted=()=>{throw Error('grant revoked');};await service.tick();assert.equal(count(),0);});
  await fixture(async({deps,restart,count})=>{deps.workflow=()=>({enabled:false,employeeIds:[]});await restart().tick();assert.equal(count(),0);});
});
test('interrupted dispatch, time limit and failed dispatch stop repeated automatic attempts',async()=>{
  for(const change of ["state='prepared'","started_at='2000-01-01T00:00:00Z'"]){await fixture(async({db,deps,service,restart,count,store})=>{
    deps.scheduling.candidates=()=>[{employeeId:'other',eligible:true,waiting:'occupied'}];await service.tick();
    db.exec(`UPDATE workflow_recoveries SET ${change}`);await restart().tick();assert.equal(count(),0);assert.equal(store.row('SELECT state FROM workflow_recoveries').state,'attention');
  });}
  await fixture(async({deps,restart,store})=>{let calls=0;deps.retry=async()=>{calls++;throw Error('rejected');};const service=restart();await service.tick();await service.tick();assert.equal(calls,1);assert.equal(store.row('SELECT state FROM workflow_recoveries').state,'attention');});
});
test('dependency recovery preserves own failures, executed tasks, conflicts and the latest rejection',()=>fixture(async({db,scheduler,store})=>{
  for(const setup of ["UPDATE tasks SET result='credential error' WHERE id='b'","INSERT INTO runs VALUES ('own','b','failed','ended')","INSERT INTO code_handoffs VALUES ('b','conflict')","INSERT INTO approvals VALUES ('b','start-agent-in-project','rejected','zzz')"]){
    db.exec('SAVEPOINT example');db.exec("UPDATE tasks SET status='running' WHERE id='a'");db.exec(setup);scheduler.resumeBlocked('plan');assert.equal(store.row("SELECT status FROM tasks WHERE id='b'").status,'blocked',setup);db.exec('ROLLBACK TO example;RELEASE example');
  }
}));
