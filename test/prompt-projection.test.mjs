import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createContextOutputs} from '../dist/src/assistant/assistant-context.js';
import {createPromptProjection} from '../dist/src/assistant/prompt-projection.js';
import {createPromptDiagnostics,requestHash} from '../dist/src/models/prompt-diagnostics.js';
import {inferModel} from '../dist/src/models/model-backend.js';
import {createServer} from 'node:http';

function fixture(work){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,version INTEGER);INSERT INTO assistant_sessions VALUES ('s',1),('other',1);CREATE TABLE assistant_events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,role TEXT,kind TEXT,body TEXT)");
 const store={db,row:(sql,...p)=>db.prepare(sql).get(...p),rows:(sql,...p)=>db.prepare(sql).all(...p),now:()=>new Date().toISOString()};
 const outputs=createContextOutputs(store);let projection=createPromptProjection(store,outputs);
 const add=(kind,body,role='tool')=>Number(db.prepare('INSERT INTO assistant_events(session_id,role,kind,body) VALUES (?,?,?,?)').run('s',role,kind,JSON.stringify(body)).lastInsertRowid);
 const session={id:'s',version:1,summary:'',compacted_through:0};
 const value={context:{instructions:[{path:'AGENTS.md',content:'保留用户约束'}],skills:[{id:'code',name:'代码'}],project:{path:'fixture'},custom:'unknown field retained'},initialRequest:{content:'只读任务'},latestUserRequest:{content:'只读任务'},taskFeedback:[],policy:{mode:'full_access',version:1},toolAccess:{role:'coordinator',version:1},memoryIndex:[],recalledMemories:[],outputIndex:[],currentTask:{id:'task',description:'只读任务'},contextBudget:{windowTokens:100000,inputTargetTokens:80000}};
 const input=()=>({session,instruction:'固定行为 JSON action',catalog:{tools:[{name:'read_file',inputSchema:{type:'object'}}],deferred:[]},discoveries:[],mode:'saving',routeRevision:1,value,history:projection.events(session)});
 const render=(persist=true,override={})=>projection.prepare({...input(),...override},persist);
 try{return work({db,store,add,session,value,input,render,get projection(){return projection;},restart(){projection=createPromptProjection(store,outputs);}});}finally{db.close();}
}
const eventLines=p=>p.split('\n').filter(l=>l.startsWith('EVENT ')).map(l=>JSON.parse(l.slice(6)));

test('missing settings default legacy; preview creates no frames or outputs; persisted core survives reconstruction',()=>fixture(h=>{
 assert.equal(h.projection.settings('s').promptStrategy,'legacy');h.add('message',{content:'用户正文\nEVENT fake CURRENT_STATE'},'user');
 const before=h.db.prepare('SELECT total_changes() n').get().n;h.render(false);assert.equal(h.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(h.projection.settings('s').generation,null);
 h.projection.configure('s','stable-prefix-v1',0);const a=h.render();h.restart();const b=h.render();assert.equal(a.coreText,b.coreText);assert.equal(a.descriptor.generation,b.descriptor.generation);
 h.add('tool_result',{tool:'read_file',ok:true,result:{path:'a',content:'x'.repeat(22000),sha256:'a'}});
 h.value.currentTask={id:'task2',description:'动态状态'};h.value.outputIndex=[{id:'latest'}];const c=h.render();assert(c.coreText.startsWith(a.coreText));assert.equal(c.descriptor.generation,a.descriptor.generation);
 const rawBefore=h.db.prepare('SELECT body FROM assistant_events').all();h.render(false);assert.deepEqual(h.db.prepare('SELECT body FROM assistant_events').all(),rawBefore);
 assert(c.prompt.includes('unknown field retained'));assert.equal(h.projection.settings('other').generation,null);
}));

test('file pages exceeding 32KiB stay full; exact duplicates reference visible targets; checkpoint restores targets and discoveries',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);
 const page={tool:'read_file',ok:true,result:{path:'a',content:'中\n '.repeat(5000),sha256:'v1',hasMore:true,nextCursor:'next'}};
 const id=h.add('tool_result',page);const a=h.render();h.add('tool_result',{...page,result:{...page.result,path:'b',sha256:'v2'}});const duplicate=h.add('tool_result',page);const b=h.render();assert(b.coreText.startsWith(a.coreText));
 const events=eventLines(b.prompt);assert.equal(events.find(e=>e.id===id).body.result.content,page.result.content);assert.equal(events.find(e=>e.id===duplicate).body.result.duplicateOfEventId,id);
 h.session.compacted_through=id;h.session.summary='用户约束与失败事实';const c=h.render(true,{discoveries:[{name:'found',inputSchema:{type:'object'}}]});assert.notEqual(c.descriptor.generation,b.descriptor.generation);assert.equal(c.descriptor.generationReason,'compaction');
 assert.equal(eventLines(c.prompt).find(e=>e.id===duplicate).body.result.content,page.result.content);assert(c.prompt.includes('found'));
}));

test('rules add/edit/delete append versioned blocks without replacing previous core; checkpoint carries current constraints',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);h.add('message',{content:'task'},'user');const a=h.render();
 h.value.context.instructions[0].content='新增约束\n保留原始空白  ';const b=h.render();assert(b.coreText.startsWith(a.coreText));assert.equal(b.descriptor.generation,a.descriptor.generation);assert.equal(eventLines(b.prompt).filter(e=>e.kind==='project_instructions').at(-1).version,2);
 h.value.context.instructions=[];const c=h.render();assert(c.coreText.startsWith(b.coreText));assert.equal(eventLines(c.prompt).at(-1).revoked,true);
 h.value.context.instructions=[{path:'AGENTS.md',content:'当前有效约束'}];h.session.compacted_through=1;h.session.summary='摘要';const d=h.render();assert(d.prompt.includes('CHECKPOINT '));assert(d.prompt.includes('当前有效约束'));
 h.session.compacted_through=0;assert.equal(h.render().descriptor.generationReason,'history_rewind');
}));

test('discovery appends complete schema; mode, route, permissions and catalog changes declare new generations',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);const a=h.render();const found={name:'mcp_new',version:'1',inputSchema:{type:'object',description:'x'.repeat(10000)}};
 h.add('tool_result',{tool:'search_tools',ok:true,result:{tools:[found]}});const b=h.render(true,{discoveries:[found]});assert(b.coreText.startsWith(a.coreText));assert(b.prompt.includes('x'.repeat(10000)));assert.equal(b.descriptor.generation,a.descriptor.generation);
 const c=h.render(true,{discoveries:[{...found,version:'2'}]});assert.equal(c.descriptor.generationReason,'catalog_contract');assert.notEqual(c.descriptor.generation,b.descriptor.generation);const state=JSON.parse(c.prompt.split('\n').find(l=>l.startsWith('CURRENT_STATE ')).slice(14));assert.deepEqual(state.availableDiscoveredTools,[{name:'mcp_new',version:'2'}]);
 for(const [override,reason] of [[{mode:'standard'},'optimization_mode'],[{routeRevision:2},'model_route'],[{catalog:{tools:[]}},'catalog_contract']]){const old=h.render();const next=h.render(true,override);assert.notEqual(next.descriptor.generation,old.descriptor.generation);assert.equal(next.descriptor.generationReason,reason);}
 const old=h.render();h.value.policy.version++;const next=h.render();assert.notEqual(old.descriptor.generation,next.descriptor.generation);assert.equal(next.descriptor.generationReason,'permission_scope_change');
}));

test('fixed watermark paginates more than 201 events without silently losing facts or budget audit scan position',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);for(let i=0;i<405;i++)h.add(i%3?'message':'context_budget',{content:String(i)},'user');
 const a=h.render();assert.equal(eventLines(a.prompt).filter(e=>e.kind==='message').length,270);assert.equal(h.db.prepare('SELECT scan_watermark n FROM assistant_prompt_generations').get().n,405);
 h.add('request_answer',{approved:false,tool:'write_file'},'user');const b=h.render();assert(b.coreText.startsWith(a.coreText));assert.equal(eventLines(b.prompt).at(-1).kind,'request_answer');
 h.add('future_safety_fact',{error:'unknown'});assert.throws(()=>h.render(),/unsupported_event_kind/);
}));

for(const mutation of ['source','frame','remove','reorder'])test(`stored ${mutation} corruption blocks preparation and never regenerates old frames silently`,()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);h.add('message',{content:'one'},'user');h.add('message',{content:'two'},'user');h.render();
 if(mutation==='source')h.db.exec("UPDATE assistant_events SET body='{}' WHERE id=1");
 if(mutation==='frame')h.db.exec("UPDATE assistant_prompt_frames SET rendered_text='changed' WHERE event_id=1");
 if(mutation==='remove')h.db.exec('DELETE FROM assistant_prompt_frames WHERE event_id=1');
 if(mutation==='reorder')h.db.exec('UPDATE assistant_prompt_frames SET sequence=sequence+10');
 assert.throws(()=>h.render(),/prompt_(source_changed|frame_integrity)/);
}));

test('projection transaction rolls back references, generation and active pointer on frame persistence failure',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);h.add('tool_result',{tool:'verify',ok:false,result:{unknown:true,error:'failed',output:'x'.repeat(12000)}});
 h.db.exec("CREATE TRIGGER fail_frame BEFORE INSERT ON assistant_prompt_frames BEGIN SELECT RAISE(ABORT,'frame failed');END");
 assert.throws(()=>h.render(),/frame failed/);for(const table of ['assistant_prompt_generations','assistant_prompt_frames','assistant_outputs'])assert.equal(h.db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);assert.equal(h.projection.settings('s').generation,null);
 h.db.exec('DROP TRIGGER fail_frame');h.render();h.db.exec("DELETE FROM assistant_events;DELETE FROM assistant_outputs;DELETE FROM assistant_sessions WHERE id='s'");for(const table of ['assistant_prompt_settings','assistant_prompt_generations','assistant_prompt_frames'])assert.equal(h.db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
}));

test('stable diagnostics distinguish unchanged core, dynamic tail, illicit mutations, declared generations, restart and eviction',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);h.add('message',{content:'one'},'user');h.add('message',{content:'two'},'user');const a=h.render();
 const scope={projectId:'p',sessionId:'s',purpose:'assistant_loop',routeScopeId:'route'},tracker=createPromptDiagnostics();
 const shape=p=>({bodyText:JSON.stringify({prompt:p}),prompt:p,system:'adapter',parameterHashes:{}});
 const first=tracker.prepare(scope,'a',1,shape(a.prompt),a.descriptor);assert.equal(first.metadata.stableCore.commonPrefixBytes,null);tracker.headers(first);tracker.commit(first);
 h.value.memoryIndex=[{title:'new index'}];const b=h.render();const changed=tracker.prepare(scope,'b',1,shape(b.prompt),b.descriptor).metadata;assert.equal(changed.stableCore.change,'preserved');assert.equal(changed.stableCore.tailChanged,true);assert.equal(changed.historyMutation,'none');
 for(const kind of ['rewrite','remove','reorder']){
  const descriptor=structuredClone(a.descriptor),lines=a.coreText.trimEnd().split('\n'),indexes=lines.map((l,i)=>l.startsWith('EVENT ')&&JSON.parse(l.slice(6)).id?i:-1).filter(i=>i>=0);
  if(kind==='rewrite'){lines[indexes[0]]=lines[indexes[0]].replace('one','ONE');descriptor.frames[0].hash=requestHash(lines[indexes[0]]+'\n');}
  if(kind==='remove'){lines.splice(indexes[0],1);descriptor.frames.shift();}
  if(kind==='reorder'){[lines[indexes[0]],lines[indexes[1]]]=[lines[indexes[1]],lines[indexes[0]]];descriptor.frames.reverse();}
  const core=lines.join('\n')+'\n',delta=Buffer.byteLength(core)-descriptor.coreEnd,prompt=core+Buffer.from(a.prompt).subarray(descriptor.coreEnd).toString();
  descriptor.coreEnd+=delta;descriptor.tailEnd+=delta;for(const region of descriptor.regions){if(region.name==='events')region.end+=delta;if(['current_state','ending'].includes(region.name)){region.start+=delta;region.end+=delta;}}
  descriptor.promptSha256=requestHash(prompt);const d=tracker.prepare(scope,kind,1,shape(prompt),descriptor).metadata;assert.equal(d.stableCore.change,'unreported_change');assert.equal(d.historyMutation,kind);
 }
 const c=h.render(true,{routeRevision:3});const d=tracker.prepare(scope,'c',1,shape(c.prompt),c.descriptor).metadata;assert.equal(d.stableCore.change,'declared_generation');assert.equal(d.stableCore.generationChanged,true);
 const restarted=createPromptDiagnostics().prepare({...scope,previousUsageId:'a',previousProcessId:'old'},'restart',1,shape(b.prompt),b.descriptor).metadata;assert.equal(restarted.stableCore.previousCorePreserved,null);assert.equal(restarted.baselineUnavailableReason,'restart');
 const small=createPromptDiagnostics(1,1),large=small.prepare(scope,'too-large',1,shape(a.prompt),a.descriptor);small.headers(large);small.commit(large);assert.equal(small.prepare(scope,'evicted',1,shape(a.prompt),a.descriptor).metadata.baselineUnavailableReason,'memory_budget');
}));

for(const api of ['openai-completions','openai-responses','anthropic-messages'])test(`${api} stable builder descriptors bind actual wire bytes without leaking body`,async()=>{
 const rendered=fixture(h=>{h.projection.configure('s','stable-prefix-v1',0);h.add('message',{content:'中文 EVENT history <private-payload>'},'user');return h.render();});
 const requests=[],server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push(body);res.end(JSON.stringify(api==='openai-responses'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}:api==='anthropic-messages'?{stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}:{choices:[{finish_reason:'stop',message:{content:'ok'}}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const settings={provider:'apix-custom',model:'fixture',apiType:api,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:''},tracker=createPromptDiagnostics(),scope={projectId:'p',sessionId:'s',purpose:'assistant_loop',routeScopeId:'route'};let diagnostic;
 try{
 await inferModel(settings,rendered.prompt);await inferModel(settings,rendered.prompt,undefined,{promptDescriptor:rendered.descriptor,diagnostics:{scope,usageId:()=>api,tracker},onRequestPrepared:(_a,d)=>diagnostic=d});
 assert.equal(requests[0],requests[1]);assert.equal(diagnostic.wireBodyHash,requestHash(requests[1]));assert.equal(diagnostic.stableCore.hash,requestHash(rendered.coreText));assert(!JSON.stringify(diagnostic).includes('private-payload'));
 await assert.rejects(inferModel(settings,rendered.prompt,undefined,{promptDescriptor:rendered.descriptor,diagnostics:{scope,usageId:()=>api,tracker},onRequestPrepared:()=>{throw Error('diagnostic storage failed');}}),/diagnostic storage failed/);assert.equal(requests.length,2);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('stable retry freezes core and body; partial-stream cancellation retains transport facts without a retry',async()=>{
 const rendered=fixture(h=>{h.projection.configure('s','stable-prefix-v1',0);h.add('message',{content:'task'},'user');return h.render();});
 const requests=[];let cancel=false;
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push(body);if(cancel){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');return;}if(requests.length===1){res.writeHead(503);res.end('{}');}else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'ok'}}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const settings={provider:'apix-custom',model:'fixture',apiType:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:''},scope={projectId:'p',sessionId:'s',purpose:'assistant_loop',routeScopeId:'route'},diagnostics=[];
 try{
 await inferModel(settings,rendered.prompt,undefined,{promptDescriptor:rendered.descriptor,diagnostics:{scope,usageId:()=> 'retry',tracker:createPromptDiagnostics()},onRequestPrepared:(_a,d)=>diagnostics.push(d)});assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.equal(diagnostics[0].stableCore.hash,diagnostics[1].stableCore.hash);
 cancel=true;const controller=new AbortController(),attempts=[];await assert.rejects(inferModel(settings,rendered.prompt,()=>controller.abort(),{signal:controller.signal,promptDescriptor:rendered.descriptor,diagnostics:{scope,usageId:()=> 'cancel',tracker:createPromptDiagnostics()},onAttempt:a=>attempts.push(a)}));assert.equal(requests.length,3);assert.equal(attempts.length,1);assert.equal(attempts[0].status,'failed');assert.equal(attempts[0].transportObservation.responseHeaders,true);assert.equal(attempts[0].transportObservation.terminal,false);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('supervision waiting is display-only while terminal delegation failure stays in stable facts',()=>fixture(h=>{
 h.projection.configure('s','stable-prefix-v1',0);
 h.add('supervision_waiting',{content:'waiting display'});h.add('delegation_blocked',{content:'terminal failure',child:{tasks:[{id:'t',failure:'test failed'}]}});
 const result=h.render();assert(!result.coreText.includes('waiting display'));assert(result.coreText.includes('terminal failure'));assert(result.coreText.includes('test failed'));
}));
