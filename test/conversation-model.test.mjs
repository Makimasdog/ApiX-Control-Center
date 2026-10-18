import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createConversationModels,modelCatalog,supportedEfforts,reasoningParameters} from '../dist/src/conversation-models.js';
import {inferModel} from '../dist/src/model-backend.js';
import {createApiXAgent} from '../dist/src/apix-agent.js';
import {taskEventList} from '../dist/web/task-events.js';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {startModelFixture} from './fake-model-http.mjs';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const defaults={provider:'apix-custom',model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1',apiType:'openai-completions',apiKeyEnv:'DEEPSEEK_API_KEY'};
test('conversation models isolate sessions, freeze provider settings, survive reopen and reject stale updates',()=>{
 const db=new DatabaseSync(':memory:');const deps={db,row:(q,...p)=>db.prepare(q).get(...p),now:()=>new Date().toISOString()};let current={...defaults};let models=createConversationModels(deps,()=>current);
 try{models.initialize('assistant','a');models.initialize('assistant','b');models.initialize('coordination','a');
 const a=models.save('assistant','a',{version:1,model:'deepseek-v4-pro',reasoningEffort:'max'});assert.equal(a.settings.reasoningEffort,'max');assert.equal(models.get('assistant','b').settings.model,'deepseek-flash');assert.equal(models.get('coordination','a').settings.model,'deepseek-flash');
 assert.throws(()=>models.save('assistant','a',{version:1,model:'deepseek-flash'}),/已变化/);assert.throws(()=>models.save('assistant','a',{version:2,model:'unknown',reasoningEffort:'max'}),/不支持/);
 current={...defaults,baseUrl:'http://localhost:9000',model:'other'};models=createConversationModels(deps,()=>current);assert.equal(models.get('assistant','a').settings.baseUrl,defaults.baseUrl);assert.equal(models.get('assistant','a').settings.model,'deepseek-v4-pro');assert.equal(models.get('assistant','new').settings.model,'other');
 const v=models.get('assistant','a').version;assert.throws(()=>models.save('assistant','a',{version:v,model:'-invalid'}),/无效/);assert.equal(models.get('assistant','a').version,v);
 }finally{db.close();}
});
test('only documented provider capabilities are offered, and no reasoning parameter is sent by default',()=>{
 assert(modelCatalog({...defaults,baseUrl:'https://api.deepseek.com'}).models.some(m=>m.id==='deepseek-v4-pro'));
 assert.deepEqual(supportedEfforts(defaults),['none','low','high','max']);assert.deepEqual(supportedEfforts({...defaults,baseUrl:'http://localhost:9000'}),[]);assert.deepEqual(supportedEfforts({...defaults,model:'unknown'}),[]);
 assert.deepEqual(reasoningParameters(defaults),{});assert.deepEqual(reasoningParameters({...defaults,reasoningEffort:'none'}),{thinking:{type:'disabled'}});
 assert.deepEqual(reasoningParameters({...defaults,reasoningEffort:'high'}),{thinking:{type:'enabled'},reasoning_effort:'high'});
 assert.deepEqual(reasoningParameters({...defaults,apiType:'openai-responses',reasoningEffort:'max'}),{reasoning:{effort:'max'}});
 assert.deepEqual(reasoningParameters({...defaults,apiType:'anthropic-messages',reasoningEffort:'low'}),{thinking:{type:'enabled'},output_config:{effort:'low'}});
 assert.throws(()=>reasoningParameters({...defaults,reasoningEffort:'medium'}),/不支持/);
});
test('actual HTTP request body contains selected model and protocol-specific effort without a paid model call',async()=>{
 const previous=https.request,secret=process.env.APIX_EFFORT_FIXTURE;process.env.APIX_EFFORT_FIXTURE='fixture';const calls=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push({...body,fixtureHeaders:req.headers});res.end(JSON.stringify(body.input?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}:body.max_tokens?{stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}:{choices:[{finish_reason:'stop',message:{content:'ok'}}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 // Map only this documented provider's transport to loopback; retain capability validation.
 https.request=(url,options,callback)=>{assert.equal(url.hostname,'api.deepseek.com');return http.request(`http://127.0.0.1:${server.address().port}${url.pathname}`,options,callback);};syncBuiltinESMExports();
 try{for(const apiType of ['openai-completions','openai-responses','anthropic-messages'])assert.equal(await inferModel({...defaults,model:'deepseek-v4-pro',apiKeyEnv:'APIX_EFFORT_FIXTURE',apiType,reasoningEffort:'max'},'fixture'),'ok');assert(calls.every(c=>c.model==='deepseek-v4-pro'));assert.equal(calls[0].fixtureHeaders.authorization,'Bearer fixture');assert.equal(calls[2].fixtureHeaders['x-api-key'],'fixture');assert.equal(calls[0].reasoning_effort,'max');assert.equal(calls[1].reasoning.effort,'max');assert.equal(calls[2].output_config.effort,'max');}
 finally{https.request=previous;syncBuiltinESMExports();server.closeAllConnections();await new Promise(r=>server.close(r));if(secret===undefined)delete process.env.APIX_EFFORT_FIXTURE;else process.env.APIX_EFFORT_FIXTURE=secret;}
});
test('event viewer filters by type and content and escapes both previews and complete long logs',()=>{
 const events=[{kind:'stderr',created_at:'2026-10-17T12:00:00Z',payload:{text:'<script>unsafe</script>'+('长日志'.repeat(1000))}},{kind:'tool_result',created_at:'2026-10-17T12:00:01Z',payload:{text:'unique query'}}];
 const all=taskEventList(events);assert(!all.includes('<script>'));assert(all.includes('&lt;script&gt;'));assert(all.includes('长日志'.repeat(1000)));assert(all.includes('<details'));
 assert.match(taskEventList(events,'tool_result','unique'),/显示 1 \/ 2/);assert(!taskEventList(events,'tool_result','unique').includes('长日志'));assert.match(taskEventList(events,'stderr','missing'),/没有符合条件/);
});
test('HTTP conversations route their own models, reject active changes, persist across restart and guard missing sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'apix-chat-model-'));const project=join(dir,'project');await mkdir(project);const model=await startModelFixture();
 const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});const base=`http://127.0.0.1:${port}`;let child,errors='';
 const request=async(path,body,status=200)=>{const res=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;};
 const wait=async predicate=>{for(let i=0;i<200;i++){const result=await predicate();if(result)return result;await new Promise(r=>setTimeout(r,50));}throw new Error('fixture timed out: '+errors);};
 const start=async()=>{child=spawn(process.execPath,['server.mjs'],{cwd:resolve('.'),env:{...process.env,PORT:String(port),APIX_DATA_DIR:join(dir,'data')},windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',c=>errors+=c);await wait(async()=>{try{return(await fetch(base+'/api/snapshot')).ok;}catch{return false;}});};
 const stop=async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}};
 try{await start();await request('/api/manager/settings',{baseUrl:model.baseUrl,model:'qwen3.8-27b',apiType:'openai-completions',apiKeyEnv:''});const projectId=(await request('/api/projects',{name:'独立模型',path:project})).id;
 const a=await request('/api/assistant/sessions',{projectId}),b=await request('/api/assistant/sessions',{projectId}),c=await request('/api/coordination/sessions',{projectId,goal:'解释项目'});
 const path='/api/conversation-models/assistant/'+a.id;let config=await request(path);config=await request(path,{version:config.version,model:'selected-model',reasoningEffort:''});
 await request(path,{version:1,model:'stale'},400);await request(path,{version:config.version,model:'invalid-effort',reasoningEffort:'high'},400);assert.equal((await request('/api/conversation-models/assistant/'+b.id)).settings.model,'qwen3.8-27b');
 await request('/api/assistant/sessions/'+a.id+'/messages',{content:'解释如何工作'});await wait(async()=>(await request('/api/assistant/sessions/'+a.id)).status==='completed');assert.equal(model.calls.at(-1).body.model,'selected-model');
 await request('/api/conversation-models/coordination/'+c.id,{version:1,model:'coord-model'});await request('/api/coordination/sessions/'+c.id+'/messages',{revision:c.revision,content:'解释如何工作'});assert.equal(model.calls.at(-1).body.model,'coord-model');
 await request('/api/manager/settings',{baseUrl:model.baseUrl,model:'new-default',apiType:'openai-completions',apiKeyEnv:''});await stop();await start();assert.equal((await request(path)).settings.model,'selected-model');assert.equal((await request('/api/conversation-models/assistant/'+b.id)).settings.model,'qwen3.8-27b');
 await request('/api/assistant/sessions/'+a.id+'/messages',{content:'fixture-http-hold'});await wait(async()=>model.calls.at(-1).body.messages?.at(-1)?.content.includes('fixture-http-hold'));await request(path,{version:config.version,model:'blocked'},400);await request('/api/assistant/sessions/'+a.id+'/stop',{});
 await request('/api/conversation-models/assistant/missing',undefined,400);await request('/api/conversation-models/coordination/'+a.id,undefined,400);
 }finally{await stop();await model.close();assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('conversation picker has a separate mount from the global settings form',async()=>{
 const source=await readFile('web/coordinator.ts','utf8');assert.equal(source.split('id="coord-model"').length-1,1);assert.equal(source.split('id="coord-conversation-model"').length-1,1);
});

test('employee supervision carries the conversation identity to its inference backend',async()=>{
 let received;const agent=createApiXAgent({infer:async(_prompt,_delta,context)=>{received=context;return JSON.stringify({action:'observe',focus:'verification'});}});
 const context={sessionId:'selected-chat',projectId:'p',purpose:'discussion'};
 const result=await agent.guide({goal:'check',scope:'scope',constraints:'keep',deliverable:'report',acceptance:'evidence'},'task',{summary:'working',blocked:false},context);
 assert.equal(result.mode,'api');assert.equal(received,context);
});
