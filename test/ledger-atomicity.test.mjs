import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMailboxService} from '../src/messaging/mailbox.mjs';
import {createMemory} from '../dist/src/coordination/memory.js';
import {createPermissions} from '../dist/src/coordination/permissions.js';
import {createCoordinator} from '../dist/src/coordination/coordinator.js';

/**
 * P2 Step 1 账本原子性验收：真实 SQLite（内存库）+ 真实账本/权限/邮箱/编排大脑，
 * 仅桩掉 LLM、调度、自主交付等进程外依赖。
 * 故障注入用 TEMP TRIGGER + RAISE(ABORT) 让 apix_ledger 的第 N 次 INSERT 真实失败，
 * 断言同一操作的状态写入一并回滚——不是 fake store，是 SQLite 自身的写失败路径。
 */
const REQUIREMENTS = JSON.stringify({goal:'完成模块',scope:'模块 a.txt',constraints:'保持兼容',deliverable:'代码',acceptance:'测试通过'});

async function fixture(work){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT NOT NULL DEFAULT '/tmp/project');
    CREATE TABLE employees(id TEXT PRIMARY KEY,role TEXT,enabled INTEGER NOT NULL DEFAULT 1,deleted_at TEXT);
    CREATE TABLE plans(id TEXT PRIMARY KEY,project_id TEXT,goal TEXT,status TEXT,created_at TEXT,updated_at TEXT,mode TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,plan_id TEXT,employee_id TEXT,runtime TEXT,prompt TEXT,status TEXT,queue_reason TEXT,result TEXT,verification_status TEXT,recovery_fingerprint TEXT,delivery_commit TEXT,delivery_fingerprint TEXT,repository_id TEXT,workspace_path TEXT,conversation_id TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,status TEXT,started_at TEXT,mailbox_seen_at TEXT);
    CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,action TEXT,status TEXT,created_at TEXT,resolved_at TEXT,target_path TEXT,prompt_hash TEXT);
    CREATE TABLE task_dependencies(task_id TEXT,depends_on_id TEXT);
    CREATE TABLE project_repositories(id TEXT PRIMARY KEY,project_id TEXT,path TEXT);
    CREATE TABLE code_handoffs(task_id TEXT,status TEXT,report TEXT);
    CREATE TABLE agent_mailboxes(project_id TEXT NOT NULL,agent_id TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,PRIMARY KEY(project_id,agent_id));
    CREATE TABLE agent_messages(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,correlation_id TEXT,reply_to TEXT,project_id TEXT NOT NULL,task_id TEXT,conversation_id TEXT,from_agent TEXT NOT NULL,to_agent TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal',payload TEXT NOT NULL,payload_bytes INTEGER NOT NULL,context_tokens INTEGER,timeout_ms INTEGER NOT NULL,expires_at TEXT NOT NULL,retry_count INTEGER NOT NULL DEFAULT 0,max_retries INTEGER NOT NULL DEFAULT 3,next_retry_at TEXT,error TEXT,created_at TEXT NOT NULL,delivered_at TEXT,acknowledged_at TEXT,completed_at TEXT,target_task_id TEXT,target_run_id TEXT,source_run_id TEXT,root_task_id TEXT,parent_message_id TEXT,hop INTEGER NOT NULL DEFAULT 0,UNIQUE(project_id,idempotency_key));
    CREATE TABLE agent_message_events(id INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT,project_id TEXT,event_type TEXT,actor_agent TEXT,payload TEXT,created_at TEXT);
    CREATE TABLE coordination_sessions(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,requirements_json TEXT,revision INTEGER,confirmed_revision INTEGER,plan_id TEXT,created_at TEXT,updated_at TEXT,interaction_mode TEXT DEFAULT 'conversational',archived_at TEXT,deleted_at TEXT);
    CREATE TABLE coordination_plan_briefs(plan_id TEXT PRIMARY KEY,session_id TEXT,revision INTEGER,requirements_json TEXT);
    CREATE TABLE coordination_turns(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT,content TEXT,created_at TEXT);
    CREATE TABLE autonomy_plans(plan_id TEXT PRIMARY KEY,state TEXT);
    INSERT INTO projects VALUES ('p','/tmp/project');
    INSERT INTO employees VALUES ('a','worker',1,NULL),('b','worker',1,NULL);`);
  const store={db,row:(sql,...p)=>db.prepare(sql).get(...p),rows:(sql,...p)=>db.prepare(sql).all(...p),now:()=>new Date().toISOString()};
  const memory=createMemory(store);
  const permissions=createPermissions(store,memory);
  const calls={onCreated:[],onTaskEvent:[],resolveApproval:[]};
  const employees=()=>[{id:'a',name:'员工 A',role:'worker',runtime:'pi',enabled:1},{id:'b',name:'员工 B',role:'worker',runtime:'pi',enabled:1}];
  const assign=(projectId,steps)=>steps.map(step=>({...step,decision:{strategy:'balanced',selectedEmployeeId:step.employeeId,candidates:[],estimateSource:'user_approved_upper_bound'}}));
  const scheduling={assign,bind:()=>{},approveBinding:()=>{},profile:()=>({model:'',tags:[],tools:[],languages:[],projectIds:[],accountId:null,contextTokens:null,version:0,updatedAt:null}),admission:()=>null,policy:()=>({version:0,quotaMaxAgeMinutes:60,requireFreshQuota:false,limitMinor:null,currency:null,managerAccountId:null,managerEstimateMinor:null}),view:()=>({policy:{limitMinor:null,requireFreshQuota:false}}),reports:()=>[],taskSpec:()=>({}),candidates:()=>[],reserveManager:()=>false,settle:()=>{},assertBinding:()=>{}};
  const agent={plan:async()=>({mode:'api',steps:[{prompt:'实现模块 A',employeeId:'a',dependsOn:[]}]}),discuss:async()=>({kind:'clarification',question:'?',updates:{},conflicts:[],mode:'rules'}),architect:async()=>{throw new Error('不应调用');},guide:async()=>({action:'observe',mode:'rules'}),review:async()=>'',testConnection:async()=>({})};
  const buildServices=(overrides={})=>{
    const coordinator=createCoordinator({...store,memory,permissions,employees,capabilities:()=>[],scheduling,agent,
      autonomy:{settings:()=>({enabled:false,version:0,checks:[]}),details:()=>null,waiting:()=>false,resumeFingerprint:()=>null,assertPlan:()=>{},bindPlan:()=>{}},
      consult:async()=>'',reportManagerFailure:()=>{},
      resolveApproval:async id=>{calls.resolveApproval.push(id);},stopRun:()=>{},reviewTask:async()=>{},
      onCreated:id=>calls.onCreated.push(id),onTaskEvent:(id,kind)=>calls.onTaskEvent.push([id,kind]),
      sendMessage:input=>mailbox.sendMessage(input),...overrides});
    // recordEvent 与 control-plane 同款接线：消息事件 → 账本 + recordTask（嵌套事务路径）
    const mailbox=createMailboxService({...store,recordEvent:(projectId,aggregateId,kind,payload,actor)=>{
      memory.append(projectId,aggregateId,kind,payload,actor);
      const taskId=payload.taskId ?? db.prepare('SELECT task_id FROM agent_messages WHERE id=?').get(aggregateId)?.task_id;
      if(taskId)coordinator.recordTask(taskId,kind,{messageId:aggregateId,actor,...payload});
    }});
    return {coordinator,mailbox};
  };
  const services=buildServices();
  /** 让 apix_ledger 的第 skip+1 次 INSERT 起真实失败（RAISE(ABORT) 中止语句） */
  const armLedgerFault=(skip=0)=>{
    const threshold=db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n+skip;
    db.exec(`CREATE TEMP TRIGGER ledger_fault BEFORE INSERT ON apix_ledger WHEN (SELECT COUNT(*) FROM apix_ledger) >= ${threshold} BEGIN SELECT RAISE(ABORT, '注入：账本写入失败'); END;`);
    return ()=>db.exec('DROP TRIGGER IF EXISTS ledger_fault');
  };
  const counts=()=>({
    sessions:db.prepare('SELECT COUNT(*) AS n FROM coordination_sessions').get().n,
    turns:db.prepare('SELECT COUNT(*) AS n FROM coordination_turns').get().n,
    plans:db.prepare('SELECT COUNT(*) AS n FROM plans').get().n,
    tasks:db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    approvals:db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,
    grants:db.prepare('SELECT COUNT(*) AS n FROM apix_grants').get().n,
    messages:db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,
    messageEvents:db.prepare('SELECT COUNT(*) AS n FROM agent_message_events').get().n,
    ledger:db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,
  });
  /** 直接落库一个可确认的会话（不经 coordinator，账本为空，便于精确计数） */
  const seedSession=(status='ready',{plan=false,taskStatus='awaiting_approval'}={})=>{
    const planId=plan?'plan-1':null;
    db.prepare('INSERT INTO coordination_sessions(id,project_id,title,status,requirements_json,revision,confirmed_revision,plan_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('s','p','目标',status,REQUIREMENTS,1,plan?1:null,planId,'2026-11-21T00:00:00.000Z','2026-11-21T00:00:00.000Z');
    if(plan){
      db.prepare('INSERT INTO plans VALUES (?,?,?,?,?,?,?)').run(planId,'p','完成模块','planned','2026-11-21T00:00:00.000Z','2026-11-21T00:00:00.000Z','coordinator');
      db.prepare('INSERT INTO tasks(id,project_id,plan_id,employee_id,runtime,prompt,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('t','p',planId,'a','pi','实现模块 A',taskStatus,'2026-11-21T00:00:00.000Z','2026-11-21T00:00:00.000Z');
      db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)').run('approval-1','t','start-agent-in-project','pending','2026-11-21T00:00:00.000Z',null,'/tmp/project','hash');
      db.prepare('INSERT INTO coordination_plan_briefs VALUES (?,?,?,?)').run(planId,'s',1,REQUIREMENTS);
    }
    return {sessionId:'s',taskId:'t',planId};
  };
  const allowAll=()=>{permissions.save('p','apix','full_access',0);permissions.save('p','a','full_access',0);};
  /** 指导/重试类操作的前置：策略放行 + 任务执行授权令牌（assertExecution 校验） */
  const grantTask=()=>{allowAll();permissions.grant('t','p','a','user');};
  try{await work({db,store,memory,permissions,...services,buildServices,armLedgerFault,counts,seedSession,allowAll,grantTask,calls});}finally{db.close();}
}
const FAULT=/注入：账本写入失败/;

test('createSession：账本首次或中途写失败，会话/交互/快照全部回滚',()=>fixture(({coordinator,armLedgerFault,counts,calls})=>{
  for(const skip of [0,1]){ // 第 1 条（首轮 turn）或第 2 条（次轮 turn）账本写入失败
    const disarm=armLedgerFault(skip);
    assert.throws(()=>coordinator.createSession({projectId:'p',goal:'原子性验收目标'}),FAULT);
    disarm();
    assert.deepEqual(counts(),{sessions:0,turns:0,plans:0,tasks:0,approvals:0,grants:0,messages:0,messageEvents:0,ledger:0});
    assert.deepEqual(calls.onCreated,[],'回滚后不得触发创建回调');
  }
  const created=coordinator.createSession({projectId:'p',goal:'原子性验收目标'});
  assert.equal(created.status,'clarifying');
  assert.equal(counts().ledger,3,'成功路径：2 条 interaction.recorded + 1 条快照');
  assert.deepEqual(calls.onCreated,[created.id]);
}));

test('confirmSession：plan.created 写失败时计划/任务/审批/会话状态一并回滚',()=>fixture(async ({db,coordinator,armLedgerFault,counts,seedSession})=>{
  seedSession('ready');
  const before=counts();
  const disarm=armLedgerFault(0); // 事务内第一条账本写入即 plan.created
  await assert.rejects(()=>coordinator.confirmSession('s',{revision:1}),FAULT);
  disarm();
  assert.deepEqual(counts(),before,'plans/tasks/approvals/briefs/账本都不得残留');
  const s=db.prepare('SELECT status,plan_id,revision,confirmed_revision FROM coordination_sessions WHERE id=?').get('s');
  assert.deepEqual({...s},{status:'ready',plan_id:null,revision:1,confirmed_revision:null});
  // 成功路径对照：计划落库且带 plan.created 与快照
  const confirmed=await coordinator.confirmSession('s',{revision:1});
  assert.equal(confirmed.status,'plan_review');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='plan.created'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='coordination.snapshot'").get().n,1);
}));

test('dispatchSession：授权账本写失败时授权令牌/会话状态/审批全部回滚，不触发派发',()=>fixture(async ({db,coordinator,armLedgerFault,counts,seedSession,allowAll,calls})=>{
  seedSession('plan_review',{plan:true});
  allowAll();
  const before=counts();
  const disarm=armLedgerFault(0); // permissions.grant 的 execution.authorized 是事务内第一条账本写入
  await assert.rejects(()=>coordinator.dispatchSession('s',{planVersion:'plan-1'}),FAULT);
  disarm();
  assert.deepEqual(counts(),before);
  assert.equal(db.prepare('SELECT status FROM coordination_sessions WHERE id=?').get('s').status,'plan_review');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get('approval-1').status,'pending');
  assert.deepEqual(calls.resolveApproval,[],'回滚后不得 resolveApproval（不 spawn）');
  // 成功路径对照
  const dispatched=await coordinator.dispatchSession('s',{planVersion:'plan-1'});
  assert.equal(dispatched.status,'running');
  assert.deepEqual(dispatched.failures,[]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='plan.dispatched'").get().n,1);
  assert.deepEqual(calls.resolveApproval,['approval-1']);
}));

test('instructEmployee：guidance.sent 写失败时已落库的消息与消息事件一并回滚',()=>fixture(({db,coordinator,armLedgerFault,counts,seedSession,grantTask})=>{
  seedSession('running',{plan:true,taskStatus:'running'});
  grantTask();
  const before=counts();
  // 事务内账本写入顺序：message.created(项目聚合)→recordTask 任务聚合→会话聚合→快照→turn→guidance.sent→快照
  const disarm=armLedgerFault(5); // 第 6 条 guidance.sent 失败
  assert.throws(()=>coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'请补充实现细节'}),FAULT);
  disarm();
  assert.deepEqual(counts(),before,'消息、消息事件、recordTask 账本、turn 都不得残留');
  // 成功路径对照：消息 queued + guidance.sent + 快照
  const detail=coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'请补充实现细节'});
  assert.equal(detail.turns.filter(t=>t.kind==='worker_guidance').length,1);
  assert.equal(db.prepare("SELECT status FROM agent_messages WHERE from_agent='apix-director'").get().status,'queued');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='guidance.sent'").get().n,1);
}));

test('instructEmployee：熔断分支账本写失败时 rejected 消息与 chain.capped 一并回滚',()=>fixture(({db,mailbox,coordinator,armLedgerFault,counts,seedSession,grantTask})=>{
  seedSession('running',{plan:true,taskStatus:'running'});
  grantTask();
  // 构造 9 跳父链（hop 0..8），末端上报 Director，使下一次指导 hop=9 触发熔断
  let parent=null;
  for(let i=0;i<9;i++){
    const sent=mailbox.sendMessage({projectId:'p',taskId:'t',from:['a','b'][i%2],to:i===8?'apix-director':['b','a'][i%2],type:'event',idempotencyKey:`chain-${i}`,timeoutMs:3600000,parentMessageId:parent,payload:{kind:'progress_update',summary:'step'}});
    parent=sent.id;
  }
  const before=counts();
  // 熔断分支账本顺序：chain.capped(项目聚合)→recordTask 任务聚合→会话聚合→快照→worker_attention turn→快照
  const disarm=armLedgerFault(4); // 第 5 条 worker_attention 的 interaction.recorded 失败
  assert.throws(()=>coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'深链指导'}),FAULT);
  disarm();
  assert.deepEqual(counts(),before,'熔断记录也必须整体回滚，不能留下半截审计');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE status='rejected'").get().n,0);
}));

test('instructEmployee：消息被拒绝时保留拦截记录并在提交后抛错',()=>fixture(({db,buildServices,seedSession,counts,grantTask})=>{
  seedSession('running',{plan:true,taskStatus:'running'});
  grantTask();
  const {coordinator}=buildServices({sendMessage:()=>({id:'m-rejected',status:'rejected'})});
  const before=counts();
  assert.throws(()=>coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'高风险内容'}),/指导消息被监督规则拒绝/);
  assert.deepEqual(counts(),before,'拒绝分支不写 turn/guidance.sent');
}));

test('recordTask：会话聚合写失败时任务聚合事件一并回滚，不触发通知',()=>fixture(({db,coordinator,armLedgerFault,counts,seedSession,calls})=>{
  seedSession('running',{plan:true,taskStatus:'running'});
  const disarm=armLedgerFault(1); // 第 1 条任务聚合成功，第 2 条会话聚合失败
  assert.throws(()=>coordinator.recordTask('t','runtime.run_exited',{runId:'r',status:'completed'}),FAULT);
  disarm();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,0,'首条 append 不得残留');
  assert.deepEqual(calls.onTaskEvent,[],'失败路径不得通知');
  // 成功路径：任务聚合 + 会话聚合 + 快照，通知一次
  coordinator.recordTask('t','runtime.run_exited',{runId:'r',status:'completed'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,3);
  assert.deepEqual(calls.onTaskEvent,[['s','runtime.run_exited']]);
}));

test('recordTask：嵌套在外层 BEGIN/SAVEPOINT 内可重入，外层回滚则全部回滚',()=>fixture(({db,coordinator,seedSession})=>{
  seedSession('running',{plan:true,taskStatus:'running'});
  // 外层原始 BEGIN（control-plane 调用点姿势）+ 内层 recordTask
  db.exec('BEGIN');
  coordinator.recordTask('t','runtime.run_exited',{runId:'r'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,3);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,0,'外层回滚必须带走嵌套写入');
  // 外层提交则保留
  db.exec('BEGIN');
  coordinator.recordTask('t','runtime.run_exited',{runId:'r'});
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,3);
  // 连续两次 recordTask（各自独立事务）不互相污染
  coordinator.recordTask('t','runtime.run_exited',{runId:'r2'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,6);
}));

test('authorizeRetry：授权账本写失败时任务状态/新审批/授权令牌全部回滚',()=>fixture(({db,coordinator,armLedgerFault,counts,seedSession,allowAll})=>{
  seedSession('running',{plan:true,taskStatus:'failed'});
  allowAll();
  const before=counts();
  const disarm=armLedgerFault(0); // grant 的 execution.authorized 失败
  assert.throws(()=>coordinator.authorizeRetry('t',{revision:1}),FAULT);
  disarm();
  assert.deepEqual(counts(),before);
  const task=db.prepare('SELECT status,prompt,employee_id FROM tasks WHERE id=?').get('t');
  assert.deepEqual({...task},{status:'failed',prompt:'实现模块 A',employee_id:'a'});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status='pending'").get().n,1,'原 pending 审批不得被撤销');
  // 成功路径对照
  const result=coordinator.authorizeRetry('t',{revision:1});
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get('t').status,'awaiting_approval');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(result.approvalId).status,'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='execution.authorized'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coordination_turns WHERE kind='retry_approved'").get().n,1);
}));

test('turn 自身原子：事务外的尾随 turn 账本写失败时 turns 插入一并回滚',()=>fixture(({db,coordinator,armLedgerFault,seedSession})=>{
  seedSession('plan_review',{plan:true});
  // reviseSession：事务#1（撤销+取消+turn+快照=2 条账本），随后事务外尾随 turn（第 3 条账本）
  const disarm=armLedgerFault(2);
  assert.throws(()=>coordinator.reviseSession('s',{revision:1,reason:'调整目标'}),FAULT);
  disarm();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,2,'事务#1 已提交，保留');
  const turns=db.prepare('SELECT kind FROM coordination_turns ORDER BY rowid').all().map(t=>t.kind);
  assert.deepEqual(turns,['change_requested'],'尾随 clarification turn 必须随其账本写入一起回滚');
  assert.equal(db.prepare('SELECT status FROM coordination_sessions WHERE id=?').get('s').status,'clarifying');
}));

test('stopSession：取消状态与任务取消落快照，供投影重放',()=>fixture(({db,coordinator,seedSession})=>{
  seedSession('running',{plan:true,taskStatus:'queued'});
  coordinator.stopSession('s',{revision:1});
  const snapshot=db.prepare("SELECT payload FROM apix_ledger WHERE kind='coordination.snapshot' ORDER BY sequence DESC LIMIT 1").get();
  assert(snapshot,'stopSession 必须留下快照证据');
  const state=JSON.parse(snapshot.payload);
  assert.equal(state.status,'cancelled');
  assert.equal(state.tasks[0].status,'cancelled');
}));