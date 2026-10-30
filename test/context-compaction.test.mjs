import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createContextCompaction} from '../dist/src/assistant/context-compaction.js';

function fixture(work){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('s'),('other');CREATE TABLE assistant_events(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT,body TEXT)");
 const store={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};
 const s={id:'s',summary:'原约束',compacted_through:0},gate=createContextCompaction(store);
 const add=(kind,role='system',body={content:kind})=>Number(db.prepare('INSERT INTO assistant_events(session_id,role,kind,body) VALUES (?,?,?,?)').run(s.id,role,kind,JSON.stringify(body)).lastInsertRowid);
 try{work({db,store,s,gate,add});}finally{db.close();}
}

test('pending/failed/no-gain records suppress the same effective input, isolate sessions and never write on status GET',()=>fixture(h=>{
 assert.equal(h.gate.status(h.s),null);const id=h.add('message','user');let attempt=h.gate.begin(h.s,'gen-1',false);assert.equal(attempt.effectiveWatermark,id);
 assert.equal(h.gate.status(h.s).reason,'in_progress');assert.throws(()=>h.gate.begin(h.s,'new-generation',false),/自动压缩已暂停/);
 h.gate.fail(attempt,'failed');assert.equal(h.gate.status(h.s).blocked,true);assert.equal(h.gate.status({...h.s,id:'other'}),null);
 attempt=h.gate.begin(h.s,'gen-1',true);h.gate.fail(attempt,'no_gain');const changes=h.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(h.gate.status(h.s).reason,'no_gain');assert.equal(h.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(createContextCompaction(h.store).status(h.s).blocked,true);h.gate.clear(attempt);assert.equal(h.gate.status(h.s),null);
}));

test('resume, restart/error/budget/display/configuration and recovery audit events cannot release suppression',()=>fixture(h=>{
 h.add('message','user');const attempt=h.gate.begin(h.s,'gen-1',false);h.gate.fail(attempt,'failed');
 for(const kind of ['resumed','stopped','restart_interrupted','error','process_unknown','context_budget','activity','memory_recalled','compacted','optimization_changed','model_retry','inference_accounting_failure','file_recovery_checked','command_recovery_checked','command_log_anchor','command_log_expired','request','answer']){
  h.add(kind,kind==='resumed'||kind==='stopped'?'user':'system');assert.equal(h.gate.status(h.s).blocked,true,kind);assert.throws(()=>h.gate.begin(h.s,'different-generation',false),/自动压缩已暂停/);
 }
 h.add('message','assistant');assert.equal(h.gate.status(h.s).blocked,true);
}));

test('actual user decisions and tool results release suppression without erasing the last failure on reads',()=>fixture(h=>{
 let attempt=h.gate.begin(h.s,null,false);h.gate.fail(attempt,'failed');
 for(const [kind,role] of [...['message','request_answer','intent_confirmed','task_started','memory_edited','delivery_changes_requested','delivery_accepted'].map(k=>[k,'user']),...['tool_result','file_edit_result','verification_contract','verification_evidence','command_finished','npm_validation_prepared','npm_validation_finished','delegation_result','supervision_event'].map(k=>[k,'system'])]){
  const id=h.add(kind,role);assert.equal(h.gate.status(h.s).blocked,false,kind);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM assistant_compaction_blocks').get().n,1);
  attempt=h.gate.begin(h.s,null,false);assert.equal(attempt.effectiveWatermark,id);h.gate.fail(attempt,'failed');
 }
}));

test('effective watermark scans past 201 audit events and all effective pages',()=>fixture(h=>{
 const old=h.gate.begin(h.s,null,false);h.gate.fail(old,'no_gain');for(let i=0;i<405;i++)h.add('context_budget');assert.equal(h.gate.status(h.s).blocked,true);
 let id;for(let i=0;i<405;i++)id=h.add('tool_result','tool',{tool:'read_file',ok:true,result:{path:'p'+i,sha256:'v'+i}});
 const next=h.gate.begin(h.s,null,false);assert.equal(next.effectiveWatermark,id);assert.notEqual(next.signature,old.signature);
}));

test('begin failure precedes inference; reason-save failure retains durable pending; clear is part of caller transaction',()=>fixture(h=>{
 h.db.exec("CREATE TRIGGER fail_begin BEFORE INSERT ON assistant_compaction_blocks BEGIN SELECT RAISE(ABORT,'begin failed');END");assert.throws(()=>h.gate.begin(h.s,null,false),/begin failed/);assert.equal(h.gate.status(h.s),null);h.db.exec('DROP TRIGGER fail_begin');
 const a=h.gate.begin(h.s,null,false);h.db.exec("CREATE TRIGGER fail_reason BEFORE UPDATE ON assistant_compaction_blocks BEGIN SELECT RAISE(ABORT,'reason failed');END");assert.throws(()=>h.gate.fail(a,'failed'),/reason failed/);assert.equal(h.gate.status(h.s).reason,'in_progress');h.db.exec('DROP TRIGGER fail_reason');
 h.db.exec('SAVEPOINT candidate');h.gate.clear(a);h.db.exec('ROLLBACK TO candidate;RELEASE candidate');assert.equal(h.gate.status(h.s).blocked,true);
 h.db.exec("DELETE FROM assistant_sessions WHERE id='s'");assert.equal(h.db.prepare('SELECT COUNT(*) n FROM assistant_compaction_blocks').get().n,0);
}));

for(const reason of ['in_progress','failed','no_gain'])test(`${reason} suppression survives actual SQLite close/reopen`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'apix-compaction-recovery-'));let db;
 try{
 const open=()=>{db=new DatabaseSync(join(dir,'fixture.sqlite'));return createContextCompaction({db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()});};
 db=new DatabaseSync(join(dir,'fixture.sqlite'));db.exec("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('s');CREATE TABLE assistant_events(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT,body TEXT);INSERT INTO assistant_events VALUES (1,'s','user','message','{}')");db.close();
 let gate=open();const s={id:'s',summary:'边界',compacted_through:0},attempt=gate.begin(s,'persisted-generation',false);if(reason!=='in_progress')gate.fail(attempt,reason);db.close();
 gate=open();assert.equal(gate.status(s).reason,reason);assert.throws(()=>gate.begin(s,'changed-generation',false),/自动压缩已暂停/);gate.clear(gate.begin(s,'changed-generation',true));assert.equal(gate.status(s),null);
 }finally{db?.close();assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});
