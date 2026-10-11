import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createExecutionControl,quotaFailure} from '../src/execution-control.mjs';

function fixture(work) {
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p'),('q');CREATE TABLE tasks(id TEXT,project_id TEXT,employee_id TEXT,status TEXT);CREATE TABLE execution_settings(project_id TEXT PRIMARY KEY,project_limit INTEGER,employee_limit INTEGER,paused INTEGER,version INTEGER,updated_at TEXT);CREATE TABLE runtime_pauses(project_id TEXT,runtime TEXT,paused INTEGER,reason TEXT,source_run_id TEXT,updated_at TEXT,PRIMARY KEY(project_id,runtime));");
  const row=(sql,...args)=>db.prepare(sql).get(...args),rows=(sql,...args)=>db.prepare(sql).all(...args);
  try {work(createExecutionControl({db,row,rows,now:()=>new Date().toISOString()}),db);}finally{db.close();}
}
test('execution limits are versioned, validated and isolated by project',()=>fixture(control=>{
  assert.equal(control.get('p').employeeLimit,1);
  control.save('p',{version:0,projectLimit:1,employeeLimit:2,paused:true});
  assert.equal(control.get('q').version,0);
  assert.throws(()=>control.save('p',{version:0,paused:false}),/已变化/);
  for(const input of [{projectLimit:0},{projectLimit:9},{employeeLimit:5},{paused:'false'},{paused:null}])assert.throws(()=>control.save('p',{version:1,...input}),/并发/);
  assert.equal(control.get('p').paused,true);assert.equal(control.get('p').version,1);
}));
test('unknown runs reserve concurrency and runtime pauses require explicit versioned release',()=>fixture((control,db)=>{
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run('old','p','one','unknown');
  const task={id:'next',project_id:'p',employee_id:'one',runtime:'pi'};
  assert.match(control.admission(task),/员工并发/);
  assert.equal(control.admission({...task,project_id:'q'}),null);
  control.pauseRuntime('p','pi','quota','run');
  assert.match(control.admission({...task,employee_id:'two'}),/已暂停/);
  assert.throws(()=>control.setRuntime('p',{version:0,runtime:'pi',paused:false}),/已变化/);
  control.setRuntime('p',{version:1,runtime:'pi',paused:false});
  assert.equal(control.admission({...task,employee_id:'two'}),null);
}));
test('quota classification recognizes explicit errors without mistaking ordinary counters',()=>{
  for(const value of ['insufficient_quota','rate_limit_error','HTTP 429','429 Too Many Requests','RESOURCE_EXHAUSTED','额度耗尽'])assert.equal(quotaFailure(value),true,value);
  for(const value of ['checked 429 files','line 1429 failed','request timeout','normal result'])assert.equal(quotaFailure(value),false,value);
});
