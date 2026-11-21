import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMailboxService} from '../src/messaging/mailbox.mjs';
import {createMemory} from '../dist/src/coordination/memory.js';
import {createCoordinator} from '../dist/src/coordination/coordinator.js';

/**
 * 消息链跳数熔断验收：真实 mailbox（.mjs 源码）+ 真实事件账本 + 真实编排大脑共用同一内存库，
 * 仅按 autonomy.test.mjs 的惯例桩掉 LLM、调度、权限等进程外依赖。
 * 链路字段（hop/root_task_id/parent_message_id）全部落库，重建服务实例即模拟重启。
 */
function fixture(work){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE employees(id TEXT PRIMARY KEY,role TEXT,enabled INTEGER NOT NULL DEFAULT 1,deleted_at TEXT);
    CREATE TABLE plans(id TEXT PRIMARY KEY,project_id TEXT,updated_at TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,plan_id TEXT,employee_id TEXT,prompt TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,status TEXT,started_at TEXT,mailbox_seen_at TEXT);
    CREATE TABLE agent_mailboxes(project_id TEXT NOT NULL,agent_id TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,PRIMARY KEY(project_id,agent_id));
    CREATE TABLE agent_messages(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,correlation_id TEXT,reply_to TEXT,project_id TEXT NOT NULL,task_id TEXT,conversation_id TEXT,from_agent TEXT NOT NULL,to_agent TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal',payload TEXT NOT NULL,payload_bytes INTEGER NOT NULL,context_tokens INTEGER,timeout_ms INTEGER NOT NULL,expires_at TEXT NOT NULL,retry_count INTEGER NOT NULL DEFAULT 0,max_retries INTEGER NOT NULL DEFAULT 3,next_retry_at TEXT,error TEXT,created_at TEXT NOT NULL,delivered_at TEXT,acknowledged_at TEXT,completed_at TEXT,target_task_id TEXT,target_run_id TEXT,source_run_id TEXT,root_task_id TEXT,parent_message_id TEXT,hop INTEGER NOT NULL DEFAULT 0,UNIQUE(project_id,idempotency_key));
    CREATE TABLE agent_message_events(id INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT,project_id TEXT,event_type TEXT,actor_agent TEXT,payload TEXT,created_at TEXT);
    CREATE TABLE coordination_sessions(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,requirements_json TEXT,revision INTEGER,confirmed_revision INTEGER,plan_id TEXT,created_at TEXT,updated_at TEXT,interaction_mode TEXT DEFAULT 'conversational',archived_at TEXT,deleted_at TEXT);
    CREATE TABLE coordination_plan_briefs(plan_id TEXT PRIMARY KEY,session_id TEXT,revision INTEGER,requirements_json TEXT);
    CREATE TABLE coordination_turns(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT,content TEXT,created_at TEXT);
    CREATE TABLE task_dependencies(task_id TEXT,depends_on_id TEXT);
    CREATE TABLE code_handoffs(task_id TEXT,status TEXT,report TEXT);
    CREATE TABLE autonomy_plans(plan_id TEXT PRIMARY KEY,state TEXT);
    INSERT INTO projects VALUES ('p');
    INSERT INTO employees VALUES ('a','worker',1,NULL),('b','worker',1,NULL),('c','worker',1,NULL);
    INSERT INTO plans VALUES ('plan','p','2026-11-21T00:00:00.000Z');
    INSERT INTO tasks VALUES ('t','p','plan','a','worker task','running','2026-11-21T00:00:00.000Z');
    INSERT INTO coordination_sessions VALUES ('s','p','消息链验收','running','{"goal":"完成模块","scope":"模块 a.txt","constraints":"保持兼容","deliverable":"代码","acceptance":"测试通过"}',1,1,'plan','2026-11-21T00:00:00.000Z','2026-11-21T00:00:00.000Z','conversational',NULL,NULL);
    INSERT INTO coordination_plan_briefs VALUES ('plan','s',1,'{"goal":"完成模块","scope":"模块 a.txt","constraints":"保持兼容","deliverable":"代码","acceptance":"测试通过"}');`);
  const store={db,row:(sql,...p)=>db.prepare(sql).get(...p),rows:(sql,...p)=>db.prepare(sql).all(...p),now:()=>new Date().toISOString()};
  const memory=createMemory(store);
  // buildServices：每次调用都基于同一 db 重建 mailbox+coordinator，等价于进程重启后恢复实例
  const buildServices=()=>{
    const mailbox=createMailboxService({...store,recordEvent:(projectId,aggregateId,kind,payload,actor)=>memory.append(projectId,aggregateId,kind,payload,actor)});
    const coordinator=createCoordinator({...store,memory,
      permissions:{get:()=>({mode:'full_access',version:1}),decision:()=>'allow',assertGranted:()=>{}},
      employees:()=>[{id:'a',role:'worker'},{id:'b',role:'worker'},{id:'c',role:'worker'}],capabilities:()=>[],
      scheduling:{view:()=>({}),reports:()=>[],taskSpec:()=>({}),candidates:()=>[],reserveManager:()=>false,settle:()=>{},assertBinding:()=>{}},
      autonomy:{details:()=>({state:'running',tasks:[],checks:[],repairs:[]}),waiting:()=>false,resumeFingerprint:()=>'fingerprint',settings:()=>({enabled:true}),assertPlan:()=>{}},
      agent:{infer:async()=>'{}'},consult:async()=>'',reportManagerFailure:()=>{},sendMessage:mailbox.sendMessage,resolveApproval:()=>{},stopRun:()=>{},reviewTask:()=>{}});
    return {mailbox,coordinator};
  };
  try{work({db,store,memory,buildServices,...buildServices()});}finally{db.close();}
}
/** 沿既有父消息发送一跳：a→b→c 轮转，每三轮一次上报 Director（收件人决定下一跳的父消息选择） */
function chainSend(mailbox,parent,from,to,key){
  return mailbox.sendMessage({projectId:'p',taskId:'t',from,to,type:'event',idempotencyKey:key,timeoutMs:3600000,parentMessageId:parent,payload:{kind:'progress_update',summary:'chain step'}});
}

test('第 9 跳被投递前熔断：不投递、写 chain.capped 账本事件、生成 attention 待处理事项',()=>fixture(({db,memory,mailbox,coordinator})=>{
  const parentOf=[];let parent=null;
  for(let i=0;i<9;i++){ // 9 跳链条：hop 0..8 全部正常投递，收件人按 b、c、apix-director 轮转
    const to=['b','c','apix-director'][i%3];const from=['a','b','c'][i%3];
    const sent=chainSend(mailbox,parent,from,to,`chain-${i}`);
    assert.equal(sent.status,'queued');assert.equal(sent.chainCapped,undefined);
    parent=sent.id;parentOf.push(sent);
    const stored=db.prepare('SELECT hop,root_task_id FROM agent_messages WHERE id=?').get(sent.id);
    assert.equal(stored.hop,i);assert.equal(stored.root_task_id,'t');
  }
  // 第 9 跳增量（hop=9 > MAX_MESSAGE_HOP=8）经 instructEmployee 触发：人工指导沿员工最近上报续链
  const detail=coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'请汇报最终进度'});
  const cappedTurns=detail.turns.filter(t=>t.kind==='worker_attention');
  assert.equal(cappedTurns.length,1);
  assert.match(cappedTurns[0].content,/跳数已达上限/);
  const cappedRow=db.prepare("SELECT id,hop,status,error,root_task_id FROM agent_messages WHERE from_agent='apix-director' AND to_agent='a' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(cappedRow.hop,9);assert.equal(cappedRow.status,'rejected');assert.equal(cappedRow.root_task_id,'t');
  assert.match(cappedRow.error,/跳/);
  // 未投递：员工邮箱拉取不到被熔断的消息（rejected 永不进入 queued/delivered）
  assert.equal(mailbox.receiveMessages({projectId:'p',agentId:'a'}).some(m=>m.id===cappedRow.id),false);
  // chain.capped 事件写入 apix_ledger，含 root、hop、末端 agent、被拦 messageId
  const capped=db.prepare("SELECT payload FROM apix_ledger WHERE kind='chain.capped'").all();
  assert.equal(capped.length,1);
  const event=JSON.parse(capped[0].payload);
  assert.equal(event.rootTaskId,'t');assert.equal(event.hop,9);assert.equal(event.to,'a');
  assert.equal(event.messageId,cappedRow.id);
  // 指导被熔断后不产生 guidance.sent 事件（人工介入没有伪造成功）
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='guidance.sent'").get().n,0);
}));

test('每跳 hop 严格 +1、root_task_id 全程沿父继承；人工指导不清零跳数',()=>fixture(({db,memory,mailbox,coordinator})=>{
  let parent=null;
  for(let i=0;i<3;i++){ // a→b→c→director，建立 hop 0..2
    const sent=chainSend(mailbox,parent,['a','b','c'][i],['b','c','apix-director'][i],`hop-${i}`);
    parent=sent.id;
  }
  // 人工指导：沿员工最近一条上报（hop=2）续链 → 指导消息 hop=3，而非从 0 重新计数
  const detail=coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'请补充实现细节'});
  assert.equal(detail.turns.some(t=>t.kind==='worker_attention'),false);
  const guidance=db.prepare("SELECT id,hop,root_task_id,status FROM agent_messages WHERE from_agent='apix-director' AND to_agent='a' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(guidance.hop,3);assert.equal(guidance.root_task_id,'t');assert.equal(guidance.status,'queued');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM apix_ledger WHERE kind='guidance.sent'").get().n,1);
  // 指导之后员工继续派活：沿指导消息续链 → hop=4，证明 guidance 注入后链路计数未被清零
  const next=chainSend(mailbox,guidance.id,'a','b','after-guidance');
  assert.equal(db.prepare('SELECT hop,root_task_id FROM agent_messages WHERE id=?').get(next.id).hop,4);
  assert.equal(db.prepare('SELECT root_task_id FROM agent_messages WHERE id=?').get(next.id).root_task_id,'t');
}));

test('同一 DB 重建服务实例后 hop 不回退：链路计数完全由落库数据推导',()=>fixture(({db,memory,buildServices,mailbox,coordinator})=>{
  let parent=null;
  for(let i=0;i<3;i++){
    const sent=chainSend(mailbox,parent,['a','b','c'][i],['b','c','apix-director'][i],`restart-${i}`);
    parent=sent.id;
  }
  const revivedGuidance0=db.prepare("SELECT id,hop FROM agent_messages WHERE from_agent='apix-director' AND to_agent='a' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(revivedGuidance0,undefined); // 重启前不存在任何指导消息
  // 模拟重启：基于同一 db 重建 mailbox 与 coordinator 实例
  const revived=buildServices();
  // 重启后指导仍沿员工最近上报续链（hop=2 → 3），不会因进程内存丢失而回退到 0
  const detail=revived.coordinator.instructEmployee('s',{taskId:'t',revision:1,content:'重启后的指导'});
  assert.equal(detail.turns.some(t=>t.kind==='worker_attention'),false);
  const revivedGuidance=db.prepare("SELECT id,hop,root_task_id FROM agent_messages WHERE from_agent='apix-director' AND to_agent='a' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(revivedGuidance.hop,3);assert.equal(revivedGuidance.root_task_id,'t');
  // 重启后的员工派活同样续链：hop=4 而非 0
  const next=chainSend(revived.mailbox,revivedGuidance.id,'a','b','restart-next');
  assert.equal(db.prepare('SELECT hop FROM agent_messages WHERE id=?').get(next.id).hop,4);
}));
