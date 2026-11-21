import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {trace, summarize, formatLine} from '../scripts/inspect/why.mjs';

/**
 * why 追溯验收：内存库只放账本与最小关联表，验证「一条链按序号串起来」的语义。
 * 账本是 append-only，序号即时间顺序，所以断言只依赖 sequence 与事件归属。
 */
function fixture(work){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE apix_ledger(sequence INTEGER PRIMARY KEY AUTOINCREMENT,schema_version INTEGER NOT NULL DEFAULT 1,project_id TEXT NOT NULL,aggregate_id TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE coordination_sessions(id TEXT PRIMARY KEY,project_id TEXT,plan_id TEXT,status TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,plan_id TEXT,employee_id TEXT,status TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,status TEXT);
    CREATE TABLE coordination_plan_briefs(plan_id TEXT PRIMARY KEY,session_id TEXT,revision INTEGER,requirements_json TEXT);
    INSERT INTO coordination_sessions VALUES ('s1','p1','plan1','running');
    INSERT INTO tasks VALUES ('t1','p1','plan1','a','running'),('t2','p1','plan1','b','queued'),('other','p2','plan2','c','running');
    INSERT INTO runs VALUES ('r1','t1','running');
    INSERT INTO coordination_plan_briefs VALUES ('plan1','s1',1,'{}');`);
  const led=(aggregateId,kind,payload,actor='apix')=>db.prepare('INSERT INTO apix_ledger(project_id,aggregate_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)').run('p1',aggregateId,kind,actor,JSON.stringify(payload),'2026-11-21T10:00:00.000Z');
  try{work({db,led});}finally{db.close();}
}

test('会话追溯：按账本序号升序串起计划、派发、交互、指导与熔断，且不混入其它项目',()=>fixture(({db,led})=>{
  led('s1','plan.created',{planId:'plan1',revision:3,steps:[{},{},{}]});
  led('s1','plan.dispatched',{planId:'plan1',source:'user'});
  led('s1','interaction.recorded',{role:'apix',kind:'message',content:'已拆成三个模块'});
  led('t1','guidance.sent',{taskId:'t1',messageId:'m1',content:'先改 A 模块'},'user');
  led('t1','chain.capped',{rootTaskId:'t1',hop:9,from:'b',to:'a',messageId:'m9'});
  led('other','guidance.sent',{taskId:'other',content:'不该出现'});
  const before=db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n;
  const result=trace(db,{sessionId:'s1'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apix_ledger').get().n,before,'追溯必须只读，不能写账本');
  assert.equal(result.subject.projectId,'p1');
  assert.deepEqual(result.subject.taskIds.sort(),['t1','t2']);
  assert.deepEqual(result.events.map(e=>e.kind),['plan.created','plan.dispatched','interaction.recorded','guidance.sent','chain.capped']);
  assert.deepEqual([...result.events.map(e=>e.sequence)].sort((a,b)=>a-b),result.events.map(e=>e.sequence),'必须按序号升序');
  assert.match(result.events[0].summary,/3 个步骤/);
  assert.match(result.events[3].summary,/先改 A 模块/);
  assert.match(result.events[4].summary,/熔断 hop=9/);
  assert.equal(result.events.some(e=>e.summary.includes('不该出现')),false,'不能混入其它项目的事件');
  assert.match(formatLine(result.events[0]),/^#1\s+\d\d-\d\d \d\d:\d\d:\d\d\s+plan\.created/);
}));

test('任务与运行追溯：由 run 反推任务并带上所属会话的计划事件',()=>fixture(({db,led})=>{
  led('s1','plan.created',{planId:'plan1',revision:1,steps:[{}]});
  led('t1','guidance.progress_requested',{taskId:'t1',runId:'r1'});
  led('t2','autonomy.timeout',{runId:'r2'});
  const byRun=trace(db,{runId:'r1'});
  assert.equal(byRun.subject.taskId,'t1');
  assert.equal(byRun.subject.sessionId,'s1');
  assert.deepEqual(byRun.events.map(e=>e.kind),['plan.created','guidance.progress_requested']);
  const byTask=trace(db,{taskId:'t1',limit:1});
  assert.equal(byTask.events.length,1,'limit 生效');
  assert.throws(()=>trace(db,{runId:'missing'}),/运行 missing 不存在/);
}));

test('未知事件类型回退为载荷摘要，空载荷不报错',()=>{
  assert.equal(summarize('unknown.kind',{a:1,b:'x'}),'a=1 b=x');
  assert.equal(summarize('unknown.kind',{}),'');
  assert.equal(summarize('guidance.decided',{taskId:'t',action:'guide'}),'监督决策 guide → 任务 t');
});
