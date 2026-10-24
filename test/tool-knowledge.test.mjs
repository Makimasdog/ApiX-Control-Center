import http from 'node:http';
import {fileTool} from '../dist/src/assistant/assistant-tools.js';
import {sourceManifest} from '../dist/src/validation/node-project.js';
import {reviewSnapshot} from '../dist/src/assistant/assistant-delivery.js';
import {createHash,randomBytes} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKnowledgeBase} from '../dist/src/assistant/knowledge-base.js';
import {createToolGovernance,redact,safeArguments} from '../dist/src/assistant/tool-governance.js';
import {createToolProgress} from '../dist/src/assistant/tool-progress.js';
import {createToolRegistry} from '../dist/src/assistant/tool-registry.js';
import {createOwnerAccess} from '../src/infrastructure/owner-access.mjs';
import {workerEnvironment} from '../src/infrastructure/environment.mjs';
import {startDeliveryFixture} from './delivery-fixture.mjs';

function store(){const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p'),('q');CREATE TABLE employees(id TEXT PRIMARY KEY,deleted_at TEXT);INSERT INTO employees VALUES ('e',NULL),('f',NULL);CREATE TABLE assistant_events(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT);INSERT INTO assistant_events VALUES (1,'s','user','message');");return {db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};}
const tick=()=>new Promise(r=>setImmediate(r));
const withoutFts=s=>({...s,db:new Proxy(s.db,{get(target,property){if(property==='exec')return sql=>{if(sql.includes('USING fts5'))throw new Error('no such module: fts5');return target.exec(sql);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}})});
const upload=(id,text,extra={})=>({spaceId:id,filename:'handbook.md',base64:Buffer.from(text).toString('base64'),...extra});

test('strict schemas, cross-field and dangerous input checks preserve declared MCP schemas',()=>{
 const tools=createToolRegistry([{name:'mcp_fixture',readOnly:true,inputSchema:{type:'object',properties:{x:{type:'string'}}},description:'fixture'}]);
 for(const [name,args] of [['write_file',{path:'a',content:'x',approved:true}],['edit_file',{path:'a',expectedSha256:'a'.repeat(64),edits:[{oldText:'a',newText:'b',extra:1}]}],['read_file',{path:'a',startLine:3,endLine:2}],['read_memory',{}],['run_command',{executable:'node\0'}],['read_file',{path:'a',cursor:'x',startLine:1}]])assert.throws(()=>tools.validate(name,args),e=>e.code==='INVALID_ARGUMENTS');
 assert.doesNotThrow(()=>tools.validate('mcp_fixture',{x:'a',ownSchemaAllows:true}));
 assert.throws(()=>safeArguments(JSON.parse('{"__proto__":{"admin":true}}')),e=>e.code==='INVALID_ARGUMENTS');
 assert.throws(()=>safeArguments({a:{b:{c:{d:{e:{f:{g:{h:{i:{j:{k:{l:{m:{n:1}}}}}}}}}}}}}}));
 assert.deepEqual(redact({apiKey:'secret',path:'a',content:'private',nested:{token:'secret'}}),{apiKey:'<redacted>',path:'a',content:'<redacted>',nested:{token:'<redacted>'}});
});

test('role, allow/deny and version boundaries apply server-side and audit redacts payloads',()=>{
 const s=store();try{const access=createToolGovernance(s),tools=createToolRegistry();assert.throws(()=>access.check('p','e',tools.get('write_file'),{path:'x',content:'x'}),e=>e.code==='TOOL_FORBIDDEN');
 assert.equal(access.check('p','e',tools.get('read_file'),{path:'a'}).role,'planner');access.save('p',{subject:'e',role:'executor',allow:[],deny:['read_file'],version:0});
 assert.throws(()=>access.check('p','e',tools.get('read_file'),{path:'a'}),e=>e.code==='TOOL_FORBIDDEN');assert.throws(()=>access.check('p','e',tools.get('configure_agents'),{}));assert.equal(access.get('q','e').role,'planner');
 assert.throws(()=>access.save('p',{subject:'e',role:'coordinator',allow:[],deny:[],version:0}),e=>e.code==='VERSION_CONFLICT');assert.throws(()=>access.save('p',{subject:'e',role:'owner',allow:[],deny:[],version:1}));assert.throws(()=>access.get('missing'));
 access.audit('p','e','write_file',{content:'never-save-this',secret:'secret'},'rejected','TOOL_FORBIDDEN');assert(!JSON.stringify(access.list('p')).includes('never-save-this'));assert.equal(access.list('q').length,0);
 }finally{s.db.close();}
});

test('progress detector distinguishes pagination, result changes, bounded polls and A/B cycles',()=>{
 const s=store();try{const p=createToolProgress(s),observe=(tool,args,result,code)=>{const permit=p.check('s','p',tool,args,0);p.observe('s',permit.signature,result,code);return permit;};
 for(let i=0;i<5;i++)observe('read_file',{cursor:'page'+i},{content:'page'+i});
 for(let i=0;i<3;i++)observe('list_files',{}, {updated_at:new Date().toISOString(),entries:['a']});assert.throws(()=>p.check('s','p','list_files',{},0),e=>e.code==='TOOL_PATH_BLOCKED');
 observe('search_files',{query:'different'},{matches:[]});
 for(let i=0;i<3;i++)observe('read_file',{path:'changes'},{sha256:'changed'+i});assert.doesNotThrow(()=>p.check('s','p','read_file',{path:'changes'},0));
 s.db.prepare('DELETE FROM tool_observations').run();for(let i=0;i<3;i++){observe('a',{}, {same:1});observe('b',{}, {same:2});}
 assert.throws(()=>p.check('s','p','a',{},0),e=>e.code==='TOOL_PATH_BLOCKED');assert.doesNotThrow(()=>p.check('s','p','alternative',{},0));
 s.db.prepare('DELETE FROM tool_observations').run();for(let i=0;i<6;i++){const permit=observe('inspect_agents',{}, {status:'running'});if(i)assert(permit.delay>=1000);}assert.throws(()=>p.check('s','p','inspect_agents',{},0));
 s.db.prepare('DELETE FROM tool_observations').run();observe('write_file',{path:'a'},{error:'invalid'},'INVALID_ARGUMENTS');assert.throws(()=>p.check('s','p','write_file',{path:'a'},0));assert.doesNotThrow(()=>p.check('s','p','write_file',{path:'b'},0));assert.doesNotThrow(()=>p.check('s','p','write_file',{path:'a'},1));
 const settings=p.settings('p');assert.throws(()=>p.save('p',{...settings,maxCalls:1000}));p.save('p',{...settings,maxCalls:2});observe('list_files',{},{});assert.throws(()=>p.check('s','p','new',{},0),e=>e.code==='TOOL_BUDGET_EXCEEDED');
 }finally{s.db.close();}
});

test('knowledge pipeline isolates subjects/projects, checks live citations and atomically replaces indexes',async()=>{
 const s=store();try{const kb=createKnowledgeBase(s),space=kb.saveSpace('p',{name:'设计资料',grants:['apix','e']}),d=kb.upload('p',upload(space.id,'# ApiX\n崩溃恢复采用副作用收据。\nUse bounded recovery receipts.\n<script>do evil</script>'));
 assert.equal(kb.list('p')[0].documents[0].state,'processing');assert.equal(kb.search('p','recovery','apix').results.length,0);await tick();assert.equal(kb.list('p')[0].documents[0].state,'ready');
 const hits=kb.search('p','副作用收据','e',undefined,6,'agent:s');assert(hits.results.length);const citation=hits.results[0].citation;assert.equal(hits.results[0].reference_only,true);assert.equal(kb.search('q','recovery','apix').results.length,0);assert.equal(kb.search('p','recovery','f').results.length,0);assert.throws(()=>kb.read('p',citation,'f'),e=>e.code==='KNOWLEDGE_FORBIDDEN');assert.throws(()=>kb.read('q',citation,'e'));
 assert.throws(()=>kb.citations('s','p','['+citation+']'),e=>e.code==='UNOBSERVED_CITATION');kb.search('p','recovery','apix',undefined,6,'s');assert.deepEqual(kb.citations('s','p','['+citation+']'),[citation]);kb.read('p',citation,'apix','read-only-session');assert.deepEqual(kb.citations('read-only-session','p','['+citation+']'),[citation]);assert.throws(()=>kb.answerEvidence('read-only-session','没有引用'),e=>e.code==='CITATION_REQUIRED');
 kb.upload('p',upload(space.id,'Replacement indexed text',{id:d.id,version:1}));assert.throws(()=>kb.read('p',citation,'apix'),e=>e.code==='STALE_CITATION');assert.equal(kb.search('p','recovery','apix').results.length,0);assert.throws(()=>kb.upload('p',upload(space.id,'stale',{id:d.id,version:1})),e=>e.code==='VERSION_CONFLICT');await tick();assert.equal(kb.search('p','Replacement','apix').results.length,1);
 const next=kb.search('p','Replacement','apix').results[0].citation;kb.saveSpace('p',{id:space.id,name:'更新库',grants:[],version:1});assert.equal(kb.search('p','Replacement','apix').results.length,0);assert.throws(()=>kb.read('p',next,'apix'));
 kb.removeDocument('p',{id:d.id,version:2});assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_fts').n,0);assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_chunks').n,0);assert.throws(()=>kb.read('p',next));
 }finally{s.db.close();}
});

test('knowledge search starts without FTS5 and preserves existing documents and access boundaries',async()=>{
 const existing=store();try{const seeded=createKnowledgeBase(existing),space=seeded.saveSpace('p',{name:'既有资料',grants:['apix','e']});seeded.upload('p',upload(space.id,'Existing Recovery_Receipt and 副作用收据'));await tick();
  const kb=createKnowledgeBase(withoutFts(existing));assert.equal(kb.search('p','recovery_receipt','e').results.length,1);assert.equal(kb.search('p','副作用收据','e').results.length,1);assert.equal(kb.search('p','recovery','f').results.length,0);
  const added=kb.upload('p',upload(space.id,'Fallback bounded recovery'));await tick();assert.equal(kb.search('p','fallback').results.length,1);
  const restored=createKnowledgeBase(existing);assert.equal(restored.search('p','Existing').results.length,1);assert.equal(restored.search('p','Fallback').results.length,1);restored.removeDocument('p',{id:added.id,version:1});assert.equal(restored.search('p','Fallback').results.length,0);
 }finally{existing.db.close();}
 const fresh=store();try{const kb=createKnowledgeBase(withoutFts(fresh)),space=kb.saveSpace('p',{name:'新环境'}),doc=kb.upload('p',upload(space.id,'Fresh Offline_Index'));await tick();assert.equal(kb.search('p','offline_index').results.length,1);assert.equal(fresh.row('SELECT COUNT(*) AS n FROM kb_fts').n,1);const restored=createKnowledgeBase(fresh);assert.equal(restored.search('p','offline_index').results.length,1);restored.removeDocument('p',{id:doc.id,version:1});assert.equal(fresh.row('SELECT COUNT(*) AS n FROM kb_fts').n,0);
 }finally{fresh.db.close();}
});

test('invalid encodings/formats, parse failure, delete during processing and restart processing',async()=>{
 const s=store();try{const kb=createKnowledgeBase(s),space=kb.saveSpace('p',{name:'test'});for(const input of [upload(space.id,'x',{filename:'a.pdf'}),upload(space.id,'x',{base64:'***'}),upload(space.id,'x',{base64:Buffer.from([255]).toString('base64')}),upload(space.id,'x',{base64:Buffer.alloc(1048577).toString('base64')})])assert.throws(()=>kb.upload('p',input));
 const bad=kb.upload('p',upload(space.id,'not-json',{filename:'a.json'}));await tick();assert.equal(kb.list('p')[0].documents[0].state,'failed');assert.equal(kb.search('p','not-json').results.length,0);
 const deleted=kb.upload('p',upload(space.id,'vanish'));kb.removeDocument('p',{id:deleted.id,version:1});await tick();assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_fts').n,0);
 const resume=kb.upload('p',upload(space.id,'Restart recovery'));await tick();s.db.prepare("UPDATE kb_documents SET state='processing' WHERE id=?").run(resume.id);const restored=createKnowledgeBase(s);await tick();assert.equal(restored.search('p','Restart').results.length,1);assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_fts').n,1);
 kb.removeSpace('p',{id:space.id,version:1});assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_fts').n,0);assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_documents').n,0);
 }finally{s.db.close();}
});

test('owner capabilities are durable, reject explicit employee bearer fallback and stay out of workers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'apix-owner-')),saved=process.env.APIX_OWNER_TOKEN;delete process.env.APIX_OWNER_TOKEN;
 try{const a=createOwnerAccess(1234,dir),token=JSON.parse(await readFile(join(dir,'owner-access.json'),'utf8')).token,b=createOwnerAccess(1234,dir);assert(b.authorized({headers:{authorization:'Bearer '+token}}));assert(a.authorized({headers:{cookie:a.cookie().split(';')[0]}}));assert(!a.authorized({headers:{authorization:'Bearer employee',cookie:a.cookie()}}));assert(!a.authorized({headers:{}}));const env=workerEnvironment({APIX_OWNER_TOKEN:token,ALIAS:token,KEEP:'ok'},'codex');assert.deepEqual(env,{KEEP:'ok'});}finally{if(saved===undefined)delete process.env.APIX_OWNER_TOKEN;else process.env.APIX_OWNER_TOKEN=saved;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('HTTP owner boundary and real knowledge CRUD reject unauthenticated/cross-project/stale requests',async()=>{
 const fixture=await startDeliveryFixture();try{
 const response=await globalThis.fetch(fixture.origin+'/api/snapshot');assert.equal(response.status,401);assert.equal((await response.json()).code,'OWNER_REQUIRED');
 const forged=await globalThis.fetch(fixture.origin+'/api/projects/'+fixture.projectId+'/tool-access',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer employee'},body:JSON.stringify({role:'coordinator'})});assert.equal(forged.status,401);
 const root=await globalThis.fetch(fixture.origin);assert((await root.text()).includes('owner-login'));
 const p='/api/projects/'+fixture.projectId,space=await fixture.request(p+'/knowledge/spaces/save',{name:'HTTP资料',grants:['apix']});const d=await fixture.request(p+'/knowledge/documents/upload',upload(space.id,'Authenticated knowledge document'));await new Promise(r=>setTimeout(r,30));const hits=await fixture.request(p+'/knowledge/search',{query:'Authenticated'});assert.equal(hits.results.length,1);await fixture.request(p+'/knowledge/documents/remove',{id:d.id,version:99},409);await fixture.request(p+'/knowledge/documents/remove',{id:d.id,version:1});assert.equal((await fixture.request(p+'/knowledge/search',{query:'Authenticated'})).results.length,0);
 }finally{await fixture.close();}
});


test('live employee token scopes host tools, knowledge grants and loop accounting; stripping it never opens owner APIs',async()=>{
 const fixture=await startDeliveryFixture();let db;
 try{
  const employee=(await fixture.request('/api/employees',{name:'工具读取测试员',runtime:'codex',role:'测试'})).id;
  const task={taskId:'host-tool-task'};
  db=new DatabaseSync(join(fixture.dir,'data','apix.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  const run='tool-auth-run',token=randomBytes(32).toString('hex');db.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,employee_id,created_at,updated_at) VALUES (?,?,'codex','auth-fixture','running',?,?,?)").run(task.taskId,fixture.projectId,employee,new Date().toISOString(),new Date().toISOString());db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.taskId);db.prepare("INSERT INTO runs(id,task_id,runtime,status,status_source,started_at) VALUES (?,?,'codex','running','fixture',?)").run(run,task.taskId,new Date().toISOString());db.prepare('INSERT INTO apix_agent_tokens VALUES (?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),run,fixture.projectId,employee,new Date().toISOString());
  const invoke=async(tool,args,status=200)=>{const r=await globalThis.fetch(fixture.origin+'/api/agent/tools/'+tool,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});const result=await r.json();assert.equal(r.status,status,JSON.stringify(result));return result;};
  const read=await invoke('read_file',{path:'check.cjs'});assert(read.content.includes('assert'));
  assert.equal((await invoke('write_file',{path:'src/evil',content:'x'},403)).code,'TOOL_FORBIDDEN');assert.equal((await invoke('read_file',{path:'check.cjs',projectId:'forged'},400)).code,'INVALID_ARGUMENTS');
  const space=await fixture.request('/api/projects/'+fixture.projectId+'/knowledge/spaces/save',{name:'员工资料',grants:[]});await fixture.request('/api/projects/'+fixture.projectId+'/knowledge/documents/upload',upload(space.id,'Employee knowledge permission'));await tick();assert.equal((await invoke('search_knowledge',{query:'Employee'})).results.length,0);
  await fixture.request('/api/projects/'+fixture.projectId+'/knowledge/spaces/save',{id:space.id,version:1,name:'员工资料',grants:[employee]});const found=await invoke('search_knowledge',{query:'permission'});assert.equal(found.results.length,1);assert.equal((await invoke('read_knowledge',{citation:found.results[0].citation})).reference_only,true);
  const policy=await fixture.request('/api/projects/'+fixture.projectId+'/tool-access?subject='+employee);await fixture.request('/api/projects/'+fixture.projectId+'/tool-access',{subject:employee,version:policy.version,role:'planner',allow:[],deny:['read_file']});assert.equal((await invoke('read_file',{path:'check.cjs'},403)).code,'TOOL_FORBIDDEN');
  for(const authorization of [undefined,'Bearer '+token]){const r=await globalThis.fetch(fixture.origin+'/api/snapshot',{headers:authorization?{Authorization:authorization}:{}});assert.equal(r.status,401);}
  assert(db.prepare('SELECT COUNT(*) AS n FROM tool_observations WHERE session_id=?').get('agent:'+run).n>=7);
  db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(run);const ended=await globalThis.fetch(fixture.origin+'/api/agent/tools/read_file',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{"path":"check.cjs"}'});assert.equal(ended.status,401);assert.equal((await ended.json()).code,'AGENT_UNAUTHORIZED');
 }finally{db?.close();await fixture.close();}
});


test('index publication failure rolls back every chunk and upload repair uses a new version',async()=>{
 const s=store();try{const kb=createKnowledgeBase(s),space=kb.saveSpace('p',{name:'atomic'});s.db.exec("CREATE TRIGGER fail_second_chunk BEFORE INSERT ON kb_chunks WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'fixture unavailable');END;");const d=kb.upload('p',upload(space.id,'First paragraph '.repeat(350)));await tick();assert.equal(kb.list('p')[0].documents[0].state,'failed');assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_chunks').n,0);assert.equal(s.row('SELECT COUNT(*) AS n FROM kb_fts').n,0);s.db.exec('DROP TRIGGER fail_second_chunk');kb.upload('p',upload(space.id,'Repaired publication',{id:d.id,version:1}));await tick();assert.equal(kb.search('p','Repaired').results.length,1);assert.equal(kb.list('p')[0].documents[0].version,2);}finally{s.db.close();}
});


test('HTML extraction treats scripts/comments as data and handles unmatched repeated script tags without recursive scanning',async()=>{
 const s=store();try{const kb=createKnowledgeBase(s),space=kb.saveSpace('p',{name:'html'});kb.upload('p',upload(space.id,'<p>Useful recovery evidence</p><!-- hidden --><script>do evil</script><style>.secret{}</style>',{filename:'guide.html'}));await tick();const found=kb.search('p','recovery').results[0];assert(found.content.includes('Useful recovery'));assert(!/evil|hidden|secret/.test(found.content));kb.upload('p',upload(space.id,'<script>'.repeat(50000),{filename:'malformed.html'}));await tick();assert(kb.list('p')[0].documents.some(d=>d.filename==='malformed.html'&&d.state==='failed'));}finally{s.db.close();}
});


test('owner capability files cannot enter project reads, search, snapshots or knowledge uploads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'apix-owner-scan-'));const s=store();try{await mkdir(join(dir,'config'));for(const path of ['owner-access.json','config/OWNER-ACCESS.JSON']){await writeFile(join(dir,path),'{"token":"fixture-owner-capability-private"}');assert.throws(()=>fileTool(dir,'read_file',{path}),/凭据/);}await writeFile(join(dir,'note.txt'),'ordinary project text');assert.equal(fileTool(dir,'search_files',{query:'fixture-owner-capability-private'}).matches.length,0);assert(!JSON.stringify(sourceManifest(dir)).includes('owner-access.json'));assert(!JSON.stringify(reviewSnapshot(dir)).includes('owner-access.json'));const kb=createKnowledgeBase(s),space=kb.saveSpace('p',{name:'private'});assert.throws(()=>kb.upload('p',upload(space.id,'{"token":"private"}',{filename:'owner-access.json'})),e=>e.code==='CREDENTIAL_DOCUMENT');}finally{s.db.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});


test('oversized JSON is drained and the next authenticated request reuses the connection',async()=>{
 const fixture=await startDeliveryFixture(),agent=new http.Agent({keepAlive:true,maxSockets:1});
 const request=(path,body)=>new Promise((resolve,reject)=>{
  const req=http.request(fixture.origin+path,{agent,method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+process.env.APIX_OWNER_TOKEN,'Content-Type':'application/json'}},res=>{
   const socket=res.socket;let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),socket}));
  });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('HTTP regression request timed out')));req.end(body);
 });
 try{
  const p='/api/projects/'+fixture.projectId;
  for(const [path,size] of [[p+'/knowledge/documents/upload',1600000],[p+'/tool-access',31000],['/api/projects',31000],['/api/owner/login',1100]]){
   const large=await request(path,JSON.stringify({content:'x'.repeat(size)}));assert.equal(large.status,413);assert.equal(large.body.code,'PAYLOAD_TOO_LARGE');
   const next=await request(p+'/tool-access');assert.equal(next.status,200);assert.equal(next.socket,large.socket);
  }
  const unicode=JSON.stringify({content:'中'.repeat(11000)});
  assert.equal((await request('/api/unknown-regression-route',unicode)).status,404,'legacy routes retain their character limit');
  assert.equal((await request(p+'/tool-access',unicode)).status,413,'project tool routes retain their byte limit');
  for(const path of ['/api/events/stream','/api/chat-history','/api/mailboxes']){const r=await request(path);assert.equal(r.status,400);assert.match(r.body.error,/projectId/);}
 }finally{agent.destroy();await fixture.close();}
});


test('HTTP database defects return 500 without leaking internal schema',async()=>{
 const fixture=await startDeliveryFixture();let db;
 try{
  const path='/api/projects/'+fixture.projectId+'/tool-access';
  await fixture.request(path,undefined,200);
  db=new DatabaseSync(join(fixture.dir,'data','apix.sqlite'));db.exec('DROP TABLE tool_access');
  const result=await fixture.request(path,undefined,500);assert.equal(result.code,'INTERNAL_ERROR');assert(!JSON.stringify(result).includes('tool_access'));
 }finally{db?.close();await fixture.close();}
});
