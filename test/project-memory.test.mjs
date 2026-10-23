import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectMemory,memoryIndex} from '../dist/src/assistant/project-memory.js';
import {loadInstructions} from '../dist/src/assistant/instruction-memory.js';
import {compactPrefix,contextBreakdown,createContextOutputs,trimHistory} from '../dist/src/assistant/assistant-context.js';
function fixture(work){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES('p'),('q');CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT);INSERT INTO tasks VALUES('t','p'),('other','q');");const store={db,row:(sql,...p)=>db.prepare(sql).get(...p),rows:(sql,...p)=>db.prepare(sql).all(...p),now:()=>new Date().toISOString()};try{work(store);}finally{db.close();}}
test('canonical memory migration preserves collisions, versions and task scopes; restarting is idempotent',()=>fixture(store=>{
  store.db.exec("CREATE TABLE assistant_notes(project_id TEXT,title TEXT,content TEXT,source TEXT,version INTEGER,updated_at TEXT,PRIMARY KEY(project_id,title));INSERT INTO assistant_notes VALUES('p','same','confirmed','user',3,'2026-10-22');CREATE TABLE memories(id TEXT,project_id TEXT,title TEXT,content TEXT,source TEXT,version INTEGER,updated_at TEXT,scope TEXT,task_id TEXT,category TEXT);INSERT INTO memories VALUES('old','p','same','legacy body','user',7,'2026-10-21','task','t','decision');CREATE TABLE project_profiles(project_id TEXT,summary TEXT);INSERT INTO project_profiles VALUES('p','profile unchanged');");
  const before=store.rows('SELECT * FROM memories'),memory=createProjectMemory(store);assert.equal(memory.list('p').length,2);assert.equal(memory.list('p').find(n=>n.id==='old').version,7);assert.equal(memory.read('p','same').content,'confirmed');assert.throws(()=>memory.read('p','','old'),/范围/);assert.equal(memory.read('p','','old','t').content,'legacy body');
  assert.deepEqual(store.rows('SELECT * FROM memories'),before);assert.equal(store.row('SELECT summary FROM project_profiles').summary,'profile unchanged');assert.equal(createProjectMemory(store).list('p').length,2);
  memory.remove('p','old',7);assert.equal(createProjectMemory(store).list('p').length,1,'deleted migrated note must not resurrect');assert.deepEqual(store.rows('SELECT * FROM memories'),before);
}));
test('migration failure rolls back copied notes and its marker without touching legacy rows',()=>fixture(store=>{
  store.db.exec("CREATE TABLE memories(id TEXT,project_id TEXT,title TEXT,content TEXT,source TEXT,version INTEGER,updated_at TEXT,scope TEXT,task_id TEXT,category TEXT);INSERT INTO memories VALUES('duplicate','p','one','first','user',1,'now','project',NULL,'project'),('duplicate','p','two','second','user',1,'now','project',NULL,'project');");
  assert.throws(()=>createProjectMemory(store),/UNIQUE/);assert.equal(store.row('SELECT count(*) AS n FROM assistant_notes').n,0);assert.equal(store.row("SELECT count(*) AS n FROM assistant_memory_meta WHERE key='migration-v1'").n,0);assert.equal(store.row('SELECT count(*) AS n FROM memories').n,2);
  store.db.prepare("UPDATE memories SET id='second' WHERE title='two'").run();assert.equal(createProjectMemory(store).list('p').length,2);
}));
test('candidate confirmation, edit conflicts, disable, delete, project settings and isolation share one service',()=>fixture(store=>{
  const m=createProjectMemory(store);let n=m.save('p',{title:'测试约定',content:'测试覆盖边界',kind:'feedback'},'agent');assert.equal(n.status,'candidate');assert.equal(m.context('p','测试','s').recalled.length,0);
  n=m.save('p',{id:n.id,version:1});assert.equal(n.status,'active');assert.equal(m.context('p','测试','s').recalled.length,1);assert.equal(m.context('q','测试','foreign').recalled.length,0);assert.throws(()=>m.save('p',{title:n.title,content:'overwrite'},'agent'),/不能覆盖/);
  assert.throws(()=>m.save('p',{id:n.id,version:1,content:'stale'}),/版本/);n=m.save('p',{id:n.id,version:2,disabled:true});assert.equal(m.context('p','测试','s').recalled.length,0);m.remove('p',n.id,3);assert(m.usage('p').some(u=>u.session_id==='s'));assert(store.row('SELECT count(*) AS n FROM assistant_note_versions').n>=3);
  m.saveSettings('p',{version:0,autoConfirm:true});assert.equal(m.save('p',{title:'preference',content:'Use small functions'},'agent').status,'active');m.saveSettings('p',{version:1,enabled:false});assert.equal(m.context('p','preference','s').recalled.length,0);assert.throws(()=>m.save('p',{title:'new',content:'value'},'agent'),/停用/);
}));
test('memory changes roll back if in-flight session invalidation cannot be persisted',()=>fixture(store=>{
  const m=createProjectMemory(store),n=m.save('p',{title:'stable',content:'original'});
  store.db.exec("CREATE TABLE assistant_sessions(id TEXT,project_id TEXT,version INTEGER);INSERT INTO assistant_sessions VALUES('s','p',1);CREATE TRIGGER reject_invalidation BEFORE UPDATE ON assistant_sessions BEGIN SELECT RAISE(ABORT,'invalidation fault');END;");
  assert.throws(()=>m.save('p',{id:n.id,version:1,content:'changed'}),/invalidation fault/);assert.equal(m.read('p','stable').content,'original');assert.equal(m.read('p','stable').version,1);
  assert.throws(()=>m.remove('p',n.id,1),/invalidation fault/);assert.equal(m.list('p').length,1);
  assert.throws(()=>m.saveSettings('p',{version:0,enabled:false}),/invalidation fault/);assert.equal(m.settings('p').enabled,true);assert.equal(m.settings('p').version,0);
}));
test('index stops at 200 lines or 25KB without bodies and never loads unrelated task memory',()=>fixture(store=>{
  const sample=Array.from({length:300},(_,i)=>({title:'主题'+i+'中'.repeat(100),content:'BODY_ONLY',status:'active',kind:'project',version:1}));const index=memoryIndex(sample);assert(index.lines<=200);assert(index.bytes<=25000);assert(index.truncated);assert(!index.content.includes('BODY_ONLY'));
  assert.equal(memoryIndex(sample.map((n,i)=>({...n,title:'n'+i}))).lines,200);
  const m=createProjectMemory(store);m.save('p',{title:'task only',content:'task private',scope:'task',taskId:'t'});assert(!JSON.stringify(m.context('p','task','s','assistant')).includes('task private'));assert(JSON.stringify(m.context('p','task','t','worker','t')).includes('task private'));assert.throws(()=>m.save('p',{title:'bad',content:'bad',scope:'task',taskId:'other'}),/范围/);
}));
test('credentials and personal information are rejected and legacy secrets quarantined in public views',()=>fixture(store=>{
  const m=createProjectMemory(store);for(const content of ['api_key=secret123456','password: hunter123','sk-abcdefghijklmnop','person@example.com'])assert.throws(()=>m.save('p',{title:'secret',content}),/敏感/);
  store.db.prepare("INSERT INTO assistant_notes(project_id,title,content,source,version,updated_at,id) VALUES('p','legacy','token=secret123456','user',1,'now','secret')").run();assert(!JSON.stringify(m.list()).includes('secret123456'));assert.equal(m.context('p','token','s').recalled.length,0);
}));
function files(work){const dir=mkdtempSync(join(tmpdir(),'apix-memory-'));const root=join(dir,'project');mkdirSync(root);const put=(name,body)=>{mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),body);};try{work({dir,root,put});}finally{rmSync(dir,{recursive:true,force:true});}}
test('instruction layers and scoped rules have deterministic order and imports precede their owner',()=>files(({dir,root,put})=>{
  writeFileSync(join(dir,'user.md'),'User preference');writeFileSync(join(dir,'managed.md'),'Managed advice');put('AGENTS.md','@shared.md\nRoot');put('shared.md','Shared');put('APIX.local.md','Private');put('src/AGENTS.md','Child');put('src/a.ts','code');put('.apix/rules/typescript.md','---\npaths: ["src/**/*.ts"]\n---\nType rule');
  const options={userFile:join(dir,'user.md'),managedFile:join(dir,'managed.md'),paths:['src/a.ts']};const result=loadInstructions(root,options);assert.deepEqual(result.map(f=>f.layer),['managed','user-private','project','project','local-private','path-rule','directory']);assert.equal(result[2].content,'Shared');assert.deepEqual(loadInstructions(root,options),result);assert(!loadInstructions(root).some(f=>f.layer==='directory'||f.layer==='path-rule'));assert(result.every(f=>!f.truncated&&f.authority==='reference_only'));
}));
test('external imports require content-bound confirmation; credential paths, cycle, depth and sizes fail closed',()=>files(({dir,root,put})=>{
  writeFileSync(join(dir,'external.md'),'Outside');put('APIX.md','@../external.md');let result=loadInstructions(root);assert(result[0].blocked);assert.equal(result[0].content,'');const approval=result[0].approval;assert.equal(loadInstructions(root,{externalApprovals:[approval]})[0].content,'Outside');writeFileSync(join(dir,'external.md'),'Changed');assert(loadInstructions(root,{externalApprovals:[approval]})[0].blocked);
  writeFileSync(join(dir,'.env'),'secret');put('APIX.md','@../.env');assert.throws(()=>loadInstructions(root),/凭据/);put('APIX.md','@APIX.md');assert.throws(()=>loadInstructions(root),/循环/);
  put('APIX.md','@0.md');for(let i=0;i<7;i++)put(i+'.md','@'+(i+1)+'.md');assert.throws(()=>loadInstructions(root),/5 层/);put('APIX.md','x'.repeat(16001));assert.throws(()=>loadInstructions(root),/16000/);
  for(const name of ['AGENTS.md','CLAUDE.md','APIX.md','APIX.local.md','CLAUDE.local.md'])put(name,'x'.repeat(14000));assert.throws(()=>loadInstructions(root),/64000/);
}));
test('context stages keep pending tool pairs and output references durable',()=>fixture(store=>{
  store.db.exec('CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES (\'s\')');const events=[{id:1,role:'assistant',kind:'activity',body:'{}'},{id:2,role:'assistant',kind:'tool_started',body:'{}'},...Array.from({length:9},(_,i)=>({id:i+3,role:'system',kind:'command_progress',body:'{}'}))];assert.equal(compactPrefix(events),1);assert(trimHistory(events).some(e=>e.kind==='tool_started'));
  const outputs=createContextOutputs(store),large={id:99,role:'tool',kind:'tool_result',body:JSON.stringify({result:'value'.repeat(1000)})};const ref=outputs.history('s',[large,...events],true)[0].body.result.outputRef;assert(ref);assert(outputs.read('s',{id:ref}).text.includes('value'));assert.throws(()=>outputs.read('foreign',{id:ref}),/不属于/);assert.equal(createContextOutputs(store).read('s',{id:ref}).id,ref);
  const value={contextBudget:{windowTokens:8192,inputTargetTokens:6144},context:{instructions:['rules'],skills:['skill']},history:[],memoryIndex:'index',recalledMemories:[]};const a=contextBreakdown('system',['tool'],value);assert.deepEqual(a,contextBreakdown('system',['tool'],value));assert.equal(Object.keys(a.categories).length,10);assert.equal(a.usedTokens,Object.values(a.categories).reduce((a,b)=>a+b,0));
}));
