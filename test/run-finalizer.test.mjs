import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRunFinalizer,TERMINAL_RUN_STATUSES} from '../src/coordination/run-finalizer.mjs';

function fixture(work){
  const db=new DatabaseSync(':memory:');
  let clock=Date.parse('2026-11-18T00:00:00Z');
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,verification_status TEXT NOT NULL DEFAULT 'pending',updated_at TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,status TEXT NOT NULL,status_source TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,finalized_at TEXT,stop_evidence TEXT,exit_code INTEGER);
    INSERT INTO tasks VALUES ('t','running','pending','2026-11-18T00:00:00Z');
    INSERT INTO runs(id,task_id,status,status_source,started_at) VALUES ('r','t','running','process','2026-11-18T00:00:00Z');`);
  const settled=[],statuses=[],committed=[];
  const store={db,row:(sql,...args)=>db.prepare(sql).get(...args),rows:(sql,...args)=>db.prepare(sql).all(...args),now:()=>new Date(clock).toISOString()};
  const finalizer=createRunFinalizer(store,{
    settle:(id,actual,unused)=>settled.push([id,actual,unused]),
    onTaskStatus:(taskId,runId,status,source)=>statuses.push([taskId,runId,status,source]),
    afterCommit:(taskId,runId,status)=>committed.push([taskId,runId,status]),
  });
  try{work({db,store,finalizer,settled,statuses,committed,advance:n=>clock+=n});}finally{db.close();}
}
const runOf=db=>db.prepare('SELECT * FROM runs WHERE id=?').get('r');
const taskOf=db=>db.prepare('SELECT * FROM tasks WHERE id=?').get('t');

test('unknown is a terminal state that a late process exit cannot overwrite',()=>fixture(h=>{
  const first=h.finalizer.finalize('r','unknown','agent-health',null,null,{deferAfterCommit:true});
  assert.equal(first.changed,true);
  assert.equal(runOf(h.db).status,'unknown');
  assert.equal(taskOf(h.db).status,'unknown');
  // 迟到的正常退出
  const late=h.finalizer.finalize('r','completed','process-exit',0,'root_exited',{deferAfterCommit:true});
  assert.equal(late.changed,false);
  assert.equal(late.status,'unknown');
  assert.equal(runOf(h.db).status,'unknown');
  assert.equal(taskOf(h.db).status,'unknown');
  assert.equal(taskOf(h.db).verification_status,'pending');
  assert.deepEqual(h.committed,[]);
  assert.deepEqual(h.settled,[]);
}));

test('repeated finalize is idempotent and settles budget once',()=>fixture(h=>{
  assert.equal(h.finalizer.finalize('r','completed','process-exit',0,'root_exited').changed,true);
  assert.equal(h.finalizer.finalize('r','completed','process-exit',0,'root_exited').changed,false);
  assert.equal(h.finalizer.finalize('r','failed','process-exit',1).changed,false);
  assert.deepEqual(h.settled,[['r',null,false]]);
  assert.deepEqual(h.committed,[['t','r','completed']]);
  assert.equal(h.statuses.length,1);
  assert.equal(taskOf(h.db).verification_status,'ready');
  assert.equal(runOf(h.db).status,'completed');
  assert.equal(runOf(h.db).stop_evidence,'root_exited');
  assert.ok(runOf(h.db).finalized_at);
}));

test('a stopping run rejects a late completed outcome and stays open for cancelled/unknown',()=>fixture(h=>{
  h.db.prepare("UPDATE runs SET status='stopping' WHERE id='r'").run();
  const rejected=h.finalizer.finalize('r','completed','native-runtime',0,'quiescent');
  assert.equal(rejected.changed,false);
  assert.equal(rejected.rejected,'STOPPING_CANNOT_COMPLETE');
  assert.equal(runOf(h.db).status,'stopping');
  assert.equal(taskOf(h.db).status,'running');
  assert.deepEqual(h.settled,[]);
  // 随后按停止证据收敛，仍然只有一次收尾
  assert.equal(h.finalizer.finalize('r','cancelled','native-runtime',0,'quiescent').changed,true);
  assert.equal(runOf(h.db).status,'cancelled');
  assert.equal(h.finalizer.finalize('r','completed','native-runtime',0,'quiescent').changed,false);
  assert.equal(runOf(h.db).status,'cancelled');
}));

test('settle failure rolls back the whole finalize so state and budget stay consistent',()=>fixture(h=>{
  const broken=createRunFinalizer(h.store,{settle:()=>{throw new Error('budget down');}});
  assert.throws(()=>broken.finalize('r','completed','process-exit',0),/budget down/);
  assert.equal(runOf(h.db).status,'running');
  assert.equal(runOf(h.db).ended_at,null);
  assert.equal(taskOf(h.db).status,'running');
  assert.equal(taskOf(h.db).verification_status,'pending');
}));

test('unknown never advances dependents and terminal set is explicit',()=>{
  assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(),['blocked','cancelled','completed','failed','unknown']);
  fixture(h=>{
    h.finalizer.finalize('r','unknown','agent-health');
    assert.deepEqual(h.committed,[]);
    assert.deepEqual(h.settled,[]);
    assert.equal(taskOf(h.db).verification_status,'pending');
  });
});

test('missing run is reported instead of silently mutating',()=>fixture(h=>{
  assert.deepEqual(h.finalizer.finalize('nope','completed','process-exit',0),{changed:false,status:null,taskId:null});
}));
