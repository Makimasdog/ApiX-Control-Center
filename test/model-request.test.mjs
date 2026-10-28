import {test} from 'node:test';
import assert from 'node:assert/strict';
import http,{createServer} from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {inferModel} from '../dist/src/models/model-backend.js';
import {prepareModelRequest} from '../dist/src/models/model-request.js';
import {createPromptDiagnostics,requestHash} from '../dist/src/models/prompt-diagnostics.js';

const scope={projectId:'p',sessionId:'s',purpose:'assistant_loop',routeScopeId:'route'};
const result=api=>api==='openai-responses'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}:api==='anthropic-messages'?{stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}:{choices:[{finish_reason:'stop',message:{content:'ok'}}]};
async function fixture(work,respond){
 const requests=[],server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({raw,headers:req.headers});if(respond)respond(res,requests.length);else res.end(JSON.stringify(result('openai-completions')));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const settings={provider:'apix-custom',model:'fixture',apiType:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:''};
 try{await work(settings,requests);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
for(const api of ['openai-completions','openai-responses','anthropic-messages'])test(`${api} diagnostics bind exact wire bytes and do not change the request`,()=>fixture(async(settings,requests)=>{
 settings.apiType=api;const prompt='中文 "quoted" \\ \n history CURRENT_STATE <private-body>';
 await inferModel(settings,prompt);const prepared=prepareModelRequest(settings,prompt),observed=[],attempts=[];
 await inferModel(settings,prompt,undefined,{diagnostics:{scope,usageId:()=>api,tracker:createPromptDiagnostics()},onRequestPrepared:(_n,m)=>{observed.push(m);assert.equal(Object.isFrozen(m),true);assert(!JSON.stringify(m).includes('private-body'));assert(!JSON.stringify(m).includes(settings.baseUrl));},onAttempt:a=>attempts.push(a)});
 assert.equal(requests.length,2);assert.equal(requests[0].raw,requests[1].raw);assert.equal(prepared.bodyText,requests[1].raw);assert.equal(observed[0].wireBodyHash,requestHash(requests[1].raw));assert.equal(observed[0].wireBodyBytes,Buffer.byteLength(requests[1].raw));assert.equal(observed[0].promptSha256,requestHash(prompt));
 assert.deepEqual(attempts[0].transportObservation,{requestCreated:true,writeCompleted:true,responseHeaders:true,terminal:true});
},res=>res.end(JSON.stringify(result(api)))));

test('registration, prepare, callback failure, asynchronous callback and preparation deadline create zero requests',()=>fixture(async(settings,requests)=>{
 const original=http.request;let creations=0;http.request=(...args)=>{creations++;return original(...args);};syncBuiltinESMExports();
 const options={diagnostics:{scope,usageId:()=> 'failure',tracker:createPromptDiagnostics()},onRequestPrepared:()=>{}};
 try{
  for(const change of [
   {onAttemptStart:()=>{throw Error('registration');}},
   {onRequestPrepared:()=>{throw Error('storage');}},
   {onRequestPrepared:async()=>{throw Error('asynchronous storage');}},
   {timeoutMs:1,onRequestPrepared:()=>{const until=Date.now()+10;while(Date.now()<until){/* synchronous storage delay */}}},
   {promptDescriptor:{schema:1,layout:'legacy-v1',generation:null,promptSha256:'stale',regions:[],fields:[],frames:[]}}
  ]){const attempts=[];await assert.rejects(inferModel(settings,'fixture',undefined,{...options,...change,onAttempt:a=>attempts.push(a)}));assert.equal(attempts.length,change.onAttemptStart?0:1);assert.equal(attempts[0]?.status??'failed','failed');}
  await assert.rejects(inferModel({...settings,model:''},'fixture',undefined,options));assert.equal(creations,0);assert.equal(requests.length,0);
 }finally{http.request=original;syncBuiltinESMExports();}
}));

test('retry freezes body/configuration, associates attempts separately and does not use its own failed attempt as history baseline',()=>fixture(async(settings,requests)=>{
 const initial={...settings},tracker=createPromptDiagnostics(),prepared=[],settled=[];let usageId='';
 await inferModel(settings,'same input',undefined,{maxAttempts:2,diagnostics:{scope,usageId:()=>usageId,tracker},onAttemptStart:n=>usageId='usage-'+n,onRequestPrepared:(_n,m)=>prepared.push(m),onAttempt:a=>settled.push(a),onRetry:()=>{settings.model='mutated';settings.baseUrl='http://127.0.0.1:1/v1';}});
 assert.equal(requests.length,2);assert.equal(requests[0].raw,requests[1].raw);assert.equal(JSON.parse(requests[1].raw).model,'fixture');assert.deepEqual(prepared.map(m=>m.usageId),['usage-1','usage-2']);assert(prepared.every(m=>m.baselineUsageId===null));assert.deepEqual(settled.map(a=>a.status),['failed','completed']);
 let next;await inferModel(initial,'same input',undefined,{diagnostics:{scope,usageId:()=> 'next',tracker},onRequestPrepared:(_n,m)=>next=m});assert.equal(next.baselineUsageId,'usage-2');assert.equal(next.wireBodyPrefixBytes,Buffer.byteLength(requests[2].raw));
},(res,n)=>{if(n===1){res.writeHead(503);res.end('{}');}else res.end(JSON.stringify(result('openai-completions')));}));
