import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAssistantLoop} from '../dist/src/assistant-loop.js';
const tool=(name,args={})=>({action:'tool',tool:name,args,message:'执行 '+name});
const finish={action:'finish',outcome:'completed',message:'已完成并核对证据'};
async function wait(service,id){for(let i=0;i<200;i++){const s=service.details(id);if(!s.busy&&s.status!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw new Error('loop timeout');}
async function fixture(work){
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p'),('other');");
  const calls=[],prompts=[];let policy={mode:'full_access',version:0},fingerprint='initial',queue=[],childComplete=false;
  const deps={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString(),policy:()=>policy,describe:()=>({instructions:'Keep existing rules'}),infer:async(_p,prompt)=>{prompts.push(prompt);const answer=queue.shift();if(!answer)throw new Error('No fixture answer');return typeof answer==='function'?await answer(prompt):JSON.stringify(answer);},execute:async(_s,name,args,signal)=>{calls.push({name,args});if(signal.aborted)throw new Error('stopped');if(name==='write_file')fingerprint+='x';if(name==='verify')return {exitCode:0,fingerprint,truncated:false};if(name==='delegate')return {childSessionId:'child'};return {observed:true};},fingerprint:()=>fingerprint,child:()=>({status:childComplete?'completed':'running',complete:childComplete,details:{id:'child',accepted:childComplete}}),stopChild:()=>calls.push({name:'stopChild'})};
  const service=createAssistantLoop(deps);const s=service.create({projectId:'p'});
  try{await work({db,deps,service,id:s.id,calls,prompts,answer:(...values)=>queue.push(...values),policy:value=>policy=value,childReady:()=>childComplete=true});}finally{db.close();}
}
test('default loop performs tools, verifies changes and delivers without any registered employee',()=>fixture(async h=>{
  h.answer(tool('write_file',{path:'a.txt',content:'good'}),tool('verify',{executable:'node',args:['test.mjs']}),finish);
  h.service.message(h.id,{content:'实现文件并验证'});const s=await wait(h.service,h.id);
  assert.equal(s.status,'completed');assert.deepEqual(h.calls.map(c=>c.name),['write_file','verify']);assert(s.verification);
}));
test('failed tools return observations and stale verification cannot approve changed code',()=>fixture(async h=>{
  const execute=h.deps.execute;let once=true;h.deps.execute=async(...args)=>{if(args[1]==='read_file'&&once){once=false;throw new Error('file missing');}return execute(...args);};
  h.answer(tool('read_file',{path:'missing'}),tool('write_file',{path:'a',content:'one'}),tool('verify'),tool('write_file',{path:'a',content:'two'}),finish,tool('verify'),finish);
  h.service.message(h.id,{content:'修复并复验'});const s=await wait(h.service,h.id);assert.equal(s.status,'completed');assert(s.events.some(e=>e.kind==='completion_rejected'));assert(h.prompts.some(p=>p.includes('file missing')));
}));
test('one-time approval binds parameters, permission version, request and session; rejection never executes',()=>fixture(async h=>{
  h.policy({mode:'ask_approval',version:0});h.answer(tool('write_file',{path:'a',content:'requested'}),{...finish,outcome:'blocked'});
  h.service.message(h.id,{content:'写入'});let s=await wait(h.service,h.id);assert.equal(s.status,'waiting_user');assert.equal(h.calls.length,0);
  await assert.rejects(()=>h.service.reply(h.id,{version:s.version,requestId:'wrong',approved:true}),/不属于/);
  h.policy({mode:'ask_approval',version:1});await assert.rejects(()=>h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:true}),/权限已变化/);
  await h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:false});s=await wait(h.service,h.id);assert.equal(h.calls.length,0);assert.equal(s.status,'attention');
}));
test('approved operation executes once without changing the project policy',()=>fixture(async h=>{
  h.policy({mode:'ask_approval',version:3});h.answer(tool('write_file',{path:'a',content:'good'}),{action:'ask',question:'如何验证？',options:[],multiple:false});
  h.service.message(h.id,{content:'写入'});const s=await wait(h.service,h.id);
  await h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:true});await wait(h.service,h.id);assert.equal(h.calls.length,1);assert.equal(h.service.details(h.id).policy.mode,'ask_approval');
  await assert.rejects(()=>h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:true}),/请求已变化/);
}));
test('read-only policy never executes a proposed write',()=>fixture(async h=>{
  h.policy({mode:'read_only',version:0});h.answer(tool('write_file',{path:'a',content:'forbidden'}));h.service.message(h.id,{content:'修改'});const s=await wait(h.service,h.id);assert.equal(s.status,'attention');assert.equal(h.calls.length,0);
}));
test('multi-select and free text are recorded and the loop continues',()=>fixture(async h=>{
  h.answer({action:'ask',question:'选择范围',options:['后端','前端','文档'],multiple:true},finish);h.service.message(h.id,{content:'先确认范围'});const s=await wait(h.service,h.id);
  await assert.rejects(()=>h.service.reply(h.id,{version:s.version,requestId:s.pending.id,selected:['伪造']}),/选择无效/);
  await h.service.reply(h.id,{version:s.version,requestId:s.pending.id,selected:['后端','文档'],content:'保持接口兼容'});const done=await wait(h.service,h.id);assert.equal(done.status,'completed');assert(h.prompts.at(-1).includes('保持接口兼容'));
}));
test('delegation is a loop step; accepted child wakes the manager for another decision',()=>fixture(async h=>{
  h.answer(tool('delegate',{goal:'系统模块'}),tool('inspect_agents'),finish);h.service.message(h.id,{content:'开发系统'});let s=await wait(h.service,h.id);assert.equal(s.status,'waiting_agents');assert.equal(h.prompts.length,1);
  await h.service.tick();assert.equal(h.prompts.length,1);h.childReady();await h.service.tick();s=await wait(h.service,h.id);assert.equal(s.status,'completed');assert.deepEqual(h.calls.map(c=>c.name),['delegate','inspect_agents']);assert(s.events.some(e=>e.kind==='delegation_result'));
}));
test('stop discards a late model decision and does not dispatch its side effect',()=>fixture(async h=>{
  let resolve;h.answer(()=>new Promise(r=>resolve=r));h.service.message(h.id,{content:'工作'});while(!resolve)await new Promise(r=>setTimeout(r,1));h.service.stop(h.id);resolve(JSON.stringify(tool('write_file',{path:'late',content:'bad'})));const s=await wait(h.service,h.id);assert.equal(s.status,'stopped');assert.equal(h.calls.length,0);
}));
test('new user steering invalidates the in-flight decision and preserves both messages',()=>fixture(async h=>{
  let resolve;h.answer(()=>new Promise(r=>resolve=r),finish);h.service.message(h.id,{content:'写文件'});while(!resolve)await new Promise(r=>setTimeout(r,1));h.service.message(h.id,{content:'改为只解释，不写文件'});resolve(JSON.stringify(tool('write_file',{path:'late',content:'bad'})));const s=await wait(h.service,h.id);assert.equal(s.status,'completed');assert.equal(h.calls.length,0);assert(h.prompts.at(-1).includes('改为只解释'));
}));
test('restart does not replay interrupted work; project notes are versioned and isolated',()=>fixture(async h=>{
  h.service.remember('p','rule','use actual evidence');assert.equal(h.service.notes('other').length,0);
  assert.throws(()=>h.service.editMemory(h.id,{title:'rule',version:0,content:'wrong'}),/版本/);
  h.service.editMemory(h.id,{title:'rule',version:1,content:'updated'});assert.equal(h.service.notes('p')[0].version,2);
  h.db.prepare("UPDATE assistant_sessions SET status='running' WHERE id=?").run(h.id);
  const restored=createAssistantLoop(h.deps);assert.equal(restored.details(h.id).status,'attention');assert.equal(h.calls.length,0);
  assert.throws(()=>restored.message(h.id,{content:'继续'}),/检查原进程/);
}));
test('compaction persists a summary while original events remain inspectable',()=>fixture(async h=>{
  for(let i=0;i<14;i++)h.db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'user','message',?,'now')").run(h.id,JSON.stringify({content:'约束：不扩大范围。'+'x'.repeat(3000)}));
  h.answer({summary:'目标与约束：不扩大范围，保留全部证据引用。'},finish);h.service.message(h.id,{content:'继续'});const s=await wait(h.service,h.id);assert.equal(s.status,'completed');assert(s.summary.includes('不扩大范围'));assert(s.compacted_through>0);assert(s.events.length>=16);assert(h.prompts[0].startsWith('APIX_COMPACT_JSON'));
}));
test('step budget stops an unproductive loop instead of running forever',()=>fixture(async h=>{
  for(let i=0;i<24;i++)h.answer(tool('list_files'));h.service.message(h.id,{content:'检查'});const s=await wait(h.service,h.id);assert.equal(s.status,'attention');assert.equal(h.calls.length,24);
}));

test('persistent Agent setup always needs explicit approval, including with full project access',()=>fixture(async h=>{
  h.answer(tool('configure_agents',{runtimes:['codex'],approved:true}));h.service.message(h.id,{content:'设置协作'});const s=await wait(h.service,h.id);assert.equal(s.status,'waiting_user');assert.match(s.pending.question,/持续项目授权/);assert.equal(h.calls.length,0);
}));
test('approval becomes stale when project files change',()=>fixture(async h=>{
  h.policy({mode:'ask_approval',version:0});h.answer(tool('write_file',{path:'a',content:'old'}));h.service.message(h.id,{content:'修改'});const s=await wait(h.service,h.id);h.deps.fingerprint=()=> 'changed';
  await assert.rejects(()=>h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:true}),/文件已变化/);assert.equal(h.calls.length,0);
}));
test('a tool error after a possible write still requires verification',()=>fixture(async h=>{
  h.deps.execute=async()=>{throw new Error('partial write failure');};h.answer(tool('write_file'),finish,{...finish,outcome:'blocked'});h.service.message(h.id,{content:'写入'});const s=await wait(h.service,h.id);assert.equal(s.needs_verification,1);assert(s.events.some(e=>e.kind==='completion_rejected'));assert.equal(s.status,'attention');
}));
test('history pagination is bounded and preserves older records',()=>fixture(async h=>{
  for(let i=0;i<250;i++)h.db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'user','message',?,'now')").run(h.id,JSON.stringify({content:String(i)}));
  const latest=h.service.details(h.id);assert.equal(latest.events.length,100);assert(latest.previousEventId);const previous=h.service.eventPage(h.id,latest.previousEventId);assert.equal(previous.events.length,100);assert(previous.events.at(-1).id<latest.events[0].id);assert.equal(h.service.eventPage(h.id,previous.previousEventId).events.length,50);assert.throws(()=>h.service.eventPage(h.id,-1),/游标/);
}));
test('another active main loop blocks project writes but permits read-only conversation',()=>fixture(async h=>{
  const other=h.service.create({projectId:'p'});h.db.prepare("UPDATE assistant_sessions SET status='running' WHERE id=?").run(other.id);
  h.answer(tool('write_file'));h.service.message(h.id,{content:'写文件'});let s=await wait(h.service,h.id);assert.equal(s.status,'attention');assert.equal(h.calls.length,0);
  h.answer(tool('read_file',{path:'README.md'}),finish);h.service.message(h.id,{content:'改为只读查看'});s=await wait(h.service,h.id);assert.equal(s.status,'completed');assert.equal(h.calls[0].name,'read_file');
}));
test('an interrupted process in another conversation cannot be bypassed by creating a new writer',()=>fixture(async h=>{
  const other=h.service.create({projectId:'p'});h.db.prepare("UPDATE assistant_sessions SET status='running' WHERE id=?").run(other.id);const restored=createAssistantLoop(h.deps);
  h.answer(tool('run_command'));restored.message(h.id,{content:'重新写项目'});const s=await wait(restored,h.id);assert.equal(s.status,'attention');assert.equal(h.calls.length,0);
}));
