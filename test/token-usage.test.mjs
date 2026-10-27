import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {inferModel} from '../dist/src/models/model-backend.js';
import {modelUsage,unknownUsage} from '../dist/src/models/model-usage.js';
import {createTokenUsage} from '../dist/src/assistant/token-usage.js';
import {createContextOutputs,estimateTokens} from '../dist/src/assistant/assistant-context.js';
import {optimizedCatalog} from '../dist/src/assistant/context-optimizer.js';
import {builtinTools} from '../dist/src/assistant/tool-registry.js';
import {tokenUsageView} from '../dist/web/token-usage-view.js';
import {createAssistantInference,InferenceAccountingError} from '../dist/src/assistant/assistant-inference.js';

async function fixture(api,respond,work){
 const requests=[],server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));respond(res,requests.length);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const settings={provider:'apix-custom',model:'local-usage',apiType:api,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:''};
 try{await work(settings,requests);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const chatUsage={prompt_tokens:100,completion_tokens:12,prompt_tokens_details:{cached_tokens:40,cache_write_tokens:5},completion_tokens_details:{reasoning_tokens:3}};
const responseUsage={input_tokens:100,output_tokens:12,input_tokens_details:{cached_tokens:40,cache_write_tokens:5},output_tokens_details:{reasoning_tokens:3}};
const anthropicUsage={input_tokens:55,output_tokens:12,cache_read_input_tokens:40,cache_creation_input_tokens:5};
const result=(api,usage)=>api==='openai-completions'?{choices:[{finish_reason:'stop',message:{content:'ok'}}],usage}:api==='openai-responses'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}],usage}:{stop_reason:'end_turn',content:[{type:'text',text:'ok'}],usage};
const sse=(res,events)=>{res.setHeader('Content-Type','text/event-stream');res.end(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));};

for(const api of ['openai-completions','openai-responses','anthropic-messages'])for(const streaming of [true,false])test(`${api} captures ${streaming?'streaming':'JSON'} usage without counting cumulative values twice`,()=>fixture(api,res=>{
 const usage=api==='openai-completions'?chatUsage:api==='openai-responses'?responseUsage:anthropicUsage;
 if(!streaming){res.end(JSON.stringify(result(api,usage)));return;}
 sse(res,api==='openai-completions'?[{choices:[{delta:{content:'ok'}}]},{choices:[{delta:{},finish_reason:'stop'}]},{choices:[],usage},'[DONE]']:api==='openai-responses'?[{type:'response.output_text.delta',delta:'ok'},{type:'response.completed',response:result(api,usage)}]:[{type:'message_start',message:{usage:{...usage,output_tokens:1}}},{type:'content_block_delta',delta:{type:'text_delta',text:'ok'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:12}},{type:'message_stop'}]);
},async(settings,requests)=>{
 const attempts=[],starts=[];assert.equal(await inferModel(settings,'test',undefined,{onAttemptStart:n=>starts.push(n),onAttempt:r=>attempts.push(r)}),'ok');
 assert.deepEqual(starts,[1]);assert.equal(attempts.length,1);assert.equal(attempts[0].usageComplete,true);assert.equal(attempts[0].usage.inputTokens,100);assert.equal(attempts[0].usage.outputTokens,12);assert.equal(attempts[0].usage.cachedInputTokens,40);assert.equal(attempts[0].usage.cacheWriteTokens,5);assert.equal(attempts[0].usage.reasoningTokens,api==='anthropic-messages'?null:3);
 if(api==='openai-completions')assert.deepEqual(requests[0].stream_options,{include_usage:true});
}));

test('missing and malformed fields remain unknown, including absent Anthropic cache counters',()=>{
 assert.deepEqual(modelUsage('openai-responses',{}),unknownUsage());
 const u=modelUsage('openai-completions',{prompt_tokens:-1,completion_tokens:'20',prompt_tokens_details:{cached_tokens:Infinity}});assert.deepEqual(u,unknownUsage());
 assert.equal(modelUsage('anthropic-messages',{input_tokens:10,output_tokens:2}).inputTokens,null);
 assert.equal(modelUsage('openai-responses',{input_tokens:0,output_tokens:0}).inputTokens,0);
});
test('partial stream keeps observed usage but never marks it complete',()=>fixture('anthropic-messages',res=>sse(res,[{type:'message_start',message:{usage:anthropicUsage}},{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}]),async settings=>{
 const attempts=[];await assert.rejects(inferModel(settings,'test',undefined,{onAttempt:r=>attempts.push(r)}),/中断/);assert.equal(attempts.length,1);assert.equal(attempts[0].status,'failed');assert.equal(attempts[0].usageComplete,false);assert.equal(attempts[0].usage.inputTokens,100);
}));
test('transport retries report each attempt, without hiding failed usage',()=>fixture('openai-completions',(res,n)=>{if(n===1){res.writeHead(503,{'Retry-After':'0'});res.end('{}');}else res.end(JSON.stringify(result('openai-completions',chatUsage)));},async settings=>{
 const attempts=[],starts=[];await inferModel(settings,'test',undefined,{onAttemptStart:n=>starts.push(n),onAttempt:r=>attempts.push(r)});assert.deepEqual(starts,[1,2]);assert.deepEqual(attempts.map(a=>a.status),['failed','completed']);assert.equal(attempts[0].usage.inputTokens,null);assert.equal(attempts[1].usage.inputTokens,100);
}));
test('ledger registration failure prevents network and final recording failure never retries a completed call',()=>fixture('openai-completions',res=>res.end(JSON.stringify(result('openai-completions',chatUsage))),async(settings,requests)=>{
 await assert.rejects(inferModel(settings,'test',undefined,{onAttemptStart:()=>{throw new InferenceAccountingError('start failed');}}),InferenceAccountingError);assert.equal(requests.length,0);
 await assert.rejects(inferModel(settings,'test',undefined,{onAttempt:()=>{throw new InferenceAccountingError('finish failed');}}),InferenceAccountingError);assert.equal(requests.length,1);
}));
test('token accounting failure retains host safety state and blocks further inference',async()=>{
 const failures=[];let requests=0;const infer=createAssistantInference({settings:()=>({apiKeyEnv:''}),account:()=>null,reserve:()=>false,settle:()=>{},pause:()=>{},quotaFailure:()=>false,recordFailure:r=>failures.push(r),infer:async()=>{requests++;throw new InferenceAccountingError('usage unavailable');}});
 await assert.rejects(infer('p','task',undefined,'s'),InferenceAccountingError);assert.equal(failures[0].stage,'token_usage');await assert.rejects(infer('p','next',undefined,'s'),InferenceAccountingError);assert.equal(requests,1);
});

function store(){const db=new DatabaseSync(':memory:');return {db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};}
test('ledger isolates task/session/project totals, survives reconstruction and exposes unknown coverage',()=>{
 const s=store();try{
 let ledger=createTokenUsage(s);const begin=(invocationId,projectId,sessionId,taskId,attempt=1)=>ledger.start({invocationId,projectId,sessionId,taskId,attempt,purpose:'compaction',provider:'fixture',model:'<img src=x onerror=alert(1)>',apiType:'openai-completions',estimatedPromptTokens:50});
 const first=begin('one','p','s','task');ledger.finish(first,{attempt:1,status:'completed',durationMs:10,usage:modelUsage('openai-completions',chatUsage),usageComplete:true});
 assert.throws(()=>ledger.finish(first,{attempt:1,status:'completed',durationMs:10,usage:unknownUsage(),usageComplete:false}),/未确认/);
 ledger.finish(begin('two','p','s','task'),{attempt:1,status:'failed',durationMs:20,usage:unknownUsage(),usageComplete:false});
 ledger.finish(begin('two','p','s','task',2),{attempt:2,status:'completed',durationMs:30,usage:modelUsage('openai-completions',chatUsage),usageComplete:true});
 begin('three','p','s','next');begin('four','p','other','task');begin('five','other','s','task');
 ledger=createTokenUsage(s);const report=ledger.report('p','s','task');assert.equal(report.task.calls,3);assert.equal(report.task.inputTokens,200);assert.equal(report.task.coverage.inputTokens,2);assert.equal(report.task.incomplete,1);assert.equal(report.task.failed,1);assert.equal(report.task.retries,1);assert.equal(report.session.calls,4);assert.equal(report.project.calls,5);assert.equal(report.project.pending,2);assert.equal(report.recent.length,3);assert.equal(report.cost,null);
 assert.equal(ledger.report('p','s','absent').task.inputTokens,null);assert.equal(ledger.report('p','s','next').task.pending,1);assert.equal(ledger.report('p','s','next').task.incomplete,1);
 const view=tokenUsageView(report);assert(!view.includes('<img'));assert(view.includes('&lt;img'));assert(view.includes('历史压缩'));assert(view.includes('未知'));
 for(const id of ['huge-1','huge-2'])ledger.finish(begin(id,'huge','s','task'),{attempt:1,status:'completed',durationMs:1,usage:modelUsage('openai-completions',{prompt_tokens:Number.MAX_SAFE_INTEGER,completion_tokens:1}),usageComplete:true});
 assert.equal(ledger.report('huge','s','task').task.inputTokens,null);assert.equal(ledger.report('huge','s','task').task.coverage.inputTokens,2);
 }finally{s.db.close();}
});
test('saving catalog reduces serialized context while discovered tools regain their full schema',()=>{
 const standard=optimizedCatalog(builtinTools,false,[]),saving=optimizedCatalog(builtinTools,true,[]);
 assert.deepEqual(standard.tools,builtinTools);assert(saving.estimatedReductionTokens>0);assert(estimateTokens(saving.tools)+estimateTokens(saving.deferred)<estimateTokens(standard.tools));
 assert(!saving.tools.some(t=>t.name==='remember'));assert(saving.deferred.some(t=>t.name==='remember'));
 assert(optimizedCatalog(builtinTools,true,['remember']).tools.find(t=>t.name==='remember').inputSchema);
});
test('saving history preserves flags and complete session-scoped output references',()=>{
 const s=store();try{
 s.db.exec("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY);INSERT INTO assistant_sessions VALUES ('s'),('other')");const outputs=createContextOutputs(s);
 const body=JSON.stringify({tool:'verify',ok:true,result:{exitCode:1,error:'failed test',unknown:true,output:'x'.repeat(4000)}}),events=[{id:1,role:'tool',kind:'tool_result',body},...[2,3,4].map(id=>({id,role:'system',kind:'activity',body:'{}'}))];
 const normal=outputs.history('s',events,true),saving=outputs.history('s',events,true,true);assert.equal(normal[0].body.result.output.length,4000);assert.equal(saving[0].body.result.exitCode,1);assert.equal(saving[0].body.result.unknown,true);assert.equal(saving[0].body.result.error,'failed test');assert(saving[0].body.result.outputRef);assert.equal(saving[0].body.result.fullResultAvailable,true);
 const read=outputs.read('s',{id:saving[0].body.result.outputRef,limit:6000});assert.equal(read.text,body);assert.throws(()=>outputs.read('other',{id:read.id}),/不属于/);
 assert(estimateTokens(saving)<estimateTokens(normal));
 }finally{s.db.close();}
});
