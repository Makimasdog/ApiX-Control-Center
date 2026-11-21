import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {createRuntimeController} from '../dist/src/agents/runtime-controller.js';
import {foldAgentRun} from '../dist/web/agent-run-model.js';

function fixture(work){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE employees(id TEXT PRIMARY KEY,runtime TEXT,deleted_at TEXT);INSERT INTO employees VALUES ('e','codex',NULL),('c','claude',NULL);CREATE TABLE tasks(id TEXT PRIMARY KEY,employee_id TEXT,status TEXT);INSERT INTO tasks VALUES ('t','e','idle');CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,status TEXT,started_at TEXT);INSERT INTO runs VALUES ('r','t','running',datetime('now')),('other','t','failed',datetime('now'));CREATE TABLE agent_messages(id TEXT PRIMARY KEY,status TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,source TEXT,kind TEXT,payload TEXT,created_at TEXT);CREATE TABLE apix_run_usage(run_id TEXT PRIMARY KEY,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,source TEXT,updated_at TEXT);`);
 db.prepare('UPDATE runs SET started_at=?').run(new Date().toISOString());
 let state={permission:1},messages=0;const store={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()},controller=createRuntimeController(store);
 const hooks={snapshot:()=>state,assert:()=>{},message:()=>{messages++;const id='m'+messages;db.prepare("INSERT INTO agent_messages VALUES (?,'queued')").run(id);return {id};},claimed:id=>db.prepare("UPDATE agent_messages SET status='processing' WHERE id=?").run(id),record:(id,name,payload)=>db.prepare("INSERT INTO events(run_id,source,kind,payload,created_at) VALUES (?,'agent-runtime-v1',?,?,?)").run(id,name,JSON.stringify(payload),store.now())};controller.setHooks(hooks);
 const input={command:{executable:process.execPath,prefix:[resolve('test/fake-native-runtime.mjs')]},args:[],cwd:process.cwd(),env:{...process.env},runtime:'codex',format:'jsonl',prompt:'hold ask',runId:'r'};
 return Promise.resolve().then(()=>work({db,store,controller,hooks,input,change:()=>state={permission:2},messages:()=>messages})).finally(()=>db.close());
}
test('backend settings default CLI, validate employee/backend/version and preserve opt-in',()=>fixture(async h=>{
 assert.deepEqual(h.controller.settings('e'),{backend:'cli',version:0});assert.throws(()=>h.controller.saveSettings('e',{backend:'claude-agent-sdk',expectedVersion:0}),e=>e.code==='RUNTIME_UNSUPPORTED');assert.throws(()=>h.controller.saveSettings('e',{backend:'codex-app-server',expectedVersion:0}),e=>e.code==='RUNTIME_INCOMPATIBLE');h.controller.saveSettings('e',{backend:'codex-app-server',expectedVersion:0,acknowledgeExperimental:true});assert.equal(h.controller.settings('e').version,1);assert.throws(()=>h.controller.saveSettings('e',{backend:'cli',expectedVersion:0}),/变化/);
}));
test('real adapter and persisted interactions reject stale permission, idempotent delivery is never repeated',{timeout:30000},()=>fixture(async h=>{
 h.controller.saveSettings('e',{backend:'codex-app-server',expectedVersion:0,acknowledgeExperimental:true});const handle=h.controller.open(h.input,'e');let question;
 const consume=(async()=>{for await(const e of handle.events){if(e.kind==='runtime'){h.controller.observe('r',e.name,e.payload);if(e.name==='interaction.opened')question=e.payload.interactionId;}if(e.kind==='closed')h.controller.finish('r',e.outcome==='completed'?'completed':'cancelled',e.evidence);}})();
 try{
 for(let i=0;i<200&&!question;i++)await new Promise(r=>setTimeout(r,10));assert(question);const pending=h.controller.interactions.list('r')[0];assert.equal(pending.state,'pending');assert.equal(h.controller.waiting('r'),true);
 const sent=await h.controller.send('r',{requestId:'request01',content:'保持只读',mode:'steer'});assert.equal(sent.delivery,'accepted');assert.deepEqual(await h.controller.send('r',{requestId:'request01',content:'保持只读',mode:'steer'}),sent);assert.equal(h.messages(),1);await assert.rejects(h.controller.send('r',{requestId:'request01',content:'不同内容',mode:'steer'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 await assert.rejects(h.controller.interactions.answer('other',question,{requestId:'answer001',answer:{answers:{choice:{answers:['只读']}}},expectedPermissionVersion:pending.permissionVersion}),e=>e.code==='INTERACTION_EXPIRED');
 h.change();await assert.rejects(h.controller.interactions.answer('r',question,{requestId:'answer001',answer:{answers:{choice:{answers:['只读']}}},expectedPermissionVersion:pending.permissionVersion}),e=>e.code==='PERMISSION_CHANGED');assert.equal(h.controller.interactions.list('r')[0].answerDelivery,'not_sent');
 }finally{h.controller.stopped('r');await consume;await handle.close();}
 assert.equal(h.controller.details('r').active,false);assert.equal(h.controller.interactions.list('r')[0].state,'invalidated');
}));
test('event pagination is run-bound, read-only and never exposes raw vendor events or native IDs',()=>fixture(async h=>{
 h.hooks.record('r','runtime.bound',{backend:'cli'});h.db.prepare("INSERT INTO events(run_id,source,kind,payload,created_at) VALUES ('other','native','private','{\"secret\":\"raw\"}','now')").run();const cursor=h.db.prepare('SELECT MAX(id) n FROM events').get().n;
 assert.throws(()=>h.controller.events('r',{afterId:cursor}),e=>e.code==='INVALID_CURSOR');assert.throws(()=>h.controller.events('r',{afterId:1,beforeId:1}),e=>e.code==='INVALID_CURSOR');assert.throws(()=>h.controller.events('r',{limit:201}),e=>e.code==='INVALID_CURSOR');assert(!JSON.stringify(h.controller.events('other',{})).includes('raw'));assert.equal(h.controller.events('r',{}).items.length,1);assert.equal(h.controller.details('r').legacyRecord,true);
}));
test('usage replaces snapshots per turn, never sums duplicates, retains unknown and resume needs confirmed compatible history',()=>fixture(async h=>{
 for(const id of ['a','b']){h.controller.observe('r','turn.started',{turnId:id});for(let i=0;i<2;i++)h.controller.observe('r','usage.updated',{turnId:id,source:'codex-app-server',basis:'turn',usage:{inputTokens:10,outputTokens:3,cachedInputTokens:2,extraPrivateField:'never-store-this-field'}});h.controller.observe('r','turn.finished',{turnId:id,status:'completed'});}
 assert.equal(h.db.prepare('SELECT input_tokens FROM apix_run_usage').get().input_tokens,20);assert(!JSON.stringify(h.db.prepare('SELECT usage_json FROM agent_runtime_turns').all()).includes('never-store-this-field'));h.controller.observe('r','turn.started',{turnId:'c'});h.controller.observe('r','usage.updated',{turnId:'c',source:'codex-app-server',usage:{outputTokens:1}});assert.equal(h.db.prepare('SELECT input_tokens FROM apix_run_usage').get().input_tokens,null);assert.throws(()=>h.controller.continuation('t','r','e'),e=>e.code==='RUNTIME_INCOMPATIBLE');
}));
test('pure event fold deduplicates only the chosen Run and produces escaped-by-renderer public nodes',()=>{
 const event={id:1,runId:'r',kind:'output.delta',occurredAt:'now',payload:{turnId:'a',nodeId:'x',text:'<script>测试</script>'}};assert.deepEqual(foldAgentRun('r',[event,event,{...event,id:2,runId:'other'}]),[{id:'output:a:x',kind:'output',text:'<script>测试</script>'}]);
});
test('native continuation opens a new Run with the old native history, leaves old records closed and rejects config drift',{timeout:30000},()=>fixture(async h=>{
 h.controller.saveSettings('e',{backend:'codex-app-server',expectedVersion:0,acknowledgeExperimental:true});
 async function consume(handle,id){const output=[];for await(const e of handle.events){if(e.kind==='runtime')h.controller.observe(id,e.name,e.payload);if(e.kind==='output')output.push(e.text);if(e.kind==='closed')h.controller.finish(id,e.outcome==='completed'?'completed':'failed',e.evidence);}return output.join('');}
 const first=h.controller.open({...h.input,prompt:'只读任务'},'e');await consume(first,'r');assert(h.controller.details('r').recoveryAvailable);h.db.prepare("UPDATE runs SET status='completed' WHERE id='r'").run();
 h.controller.continuation('t','r','e');h.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('new-run','t','running',h.store.now());const next=h.controller.open({...h.input,prompt:'只读后续',runId:'new-run'},'e');const output=await consume(next,'new-run');assert(output.includes('原生延续'));assert.equal(h.db.prepare("SELECT resume_from_run_id FROM agent_run_bindings WHERE run_id='new-run'").get().resume_from_run_id,'r');assert.equal(h.controller.details('r').phase,'completed');h.change();assert.throws(()=>h.controller.continuation('t','new-run','e'),e=>e.code==='RUNTIME_INCOMPATIBLE');
}));
test('possibly accepted guidance persists unknown and same-request retries do not re-enter the native runtime',{timeout:30000},()=>fixture(async h=>{
 h.controller.saveSettings('e',{backend:'codex-app-server',expectedVersion:0,acknowledgeExperimental:true});const handle=h.controller.open(h.input,'e');let ready=false;
 const consume=(async()=>{for await(const e of handle.events){if(e.kind==='runtime'){h.controller.observe('r',e.name,e.payload);if(e.name==='turn.bound')ready=true;}if(e.kind==='closed')h.controller.finish('r','unknown',e.evidence);}})();
 try{for(let i=0;i<200&&!ready;i++)await new Promise(r=>setTimeout(r,10));assert(ready);const request={requestId:'uncertain01',content:'unknown-steer',mode:'steer'};await assert.rejects(h.controller.send('r',request),e=>e.code==='DELIVERY_UNKNOWN');await consume;const old=await h.controller.send('r',request);assert.equal(old.delivery,'unknown');assert.equal(h.messages(),1);}finally{await handle.close();await consume;}
}));
