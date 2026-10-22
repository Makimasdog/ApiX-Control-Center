import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {inferModel,directModelSettings} from '../dist/src/models/model-backend.js';

test('404 identifies endpoint/model configuration without leaking response text or retrying',async()=>fixture(async(settings,calls)=>{
 await assert.rejects(inferModel(settings,'fixture'),error=>error.message.includes('HTTP 404')&&error.message.includes('/proxy/v1/chat/completions')&&error.message.includes('使用当前应用配置')&&!error.message.includes('PRIVATE_BODY'));
 assert.equal(calls.length,1);
},(_req,res)=>{res.writeHead(404);res.end('PRIVATE_BODY');}));
async function fixture(work,handler){const calls=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({url:req.url,headers:req.headers,body:JSON.parse(raw)});await handler(req,res,calls.at(-1));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const settings={provider:'apix-custom',model:'qwen3.8-27b',baseUrl:`http://127.0.0.1:${server.address().port}/proxy/v1`,apiType:'openai-completions',apiKeyEnv:''};try{await work(settings,calls);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
const finals={
  'openai-completions':text=>({choices:[{finish_reason:'stop',message:{content:text}}]}),
  'openai-responses':text=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}),
  'anthropic-messages':text=>({stop_reason:'end_turn',content:[{type:'thinking',thinking:'hidden'},{type:'text',text}]})
};
for(const api of Object.keys(finals))test(`${api} direct HTTP preserves model, base path, credentials and public text`,async()=>{
  const previous=process.env.APIX_TEST_DIRECT_KEY;process.env.APIX_TEST_DIRECT_KEY='fixture-direct-secret';
  try{await fixture(async(settings,calls)=>{
    const text=await inferModel({...settings,apiType:api,apiKeyEnv:'APIX_TEST_DIRECT_KEY'},'host task');assert.equal(text,'实际答复');assert.equal(calls.length,1);const c=calls[0];
    assert.equal(c.body.model,'qwen3.8-27b');assert.equal(c.body.tools,undefined);assert.equal(c.body.stream,true);
    assert.equal(c.headers[api==='anthropic-messages'?'x-api-key':'authorization'],api==='anthropic-messages'?'fixture-direct-secret':'Bearer fixture-direct-secret');
    assert.equal(c.url,'/proxy/v1/'+(api==='openai-completions'?'chat/completions':api==='openai-responses'?'responses':'messages'));
    if(api==='openai-responses'){assert.equal(c.body.input,'host task');assert.equal(c.body.store,false);}else assert.equal(c.body.messages.at(-1).content,'host task');
  },(_req,res)=>res.end(JSON.stringify(finals[api]('实际答复'))));}finally{if(previous===undefined)delete process.env.APIX_TEST_DIRECT_KEY;else process.env.APIX_TEST_DIRECT_KEY=previous;}
});
for(const api of Object.keys(finals))test(`${api} parses real SSE and requires a successful terminal event`,async()=>{
  await fixture(async(settings)=>{let parts='';assert.equal(await inferModel({...settings,apiType:api},'stream',p=>parts+=p),'中文');assert.equal(parts,'中文');},(_req,res)=>{
    const events=api==='openai-completions'?[{choices:[{index:0,delta:{reasoning_content:'hidden',content:'中文'}}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},'[DONE]']:api==='openai-responses'?[{type:'response.reasoning_text.delta',delta:'hidden'},{type:'response.output_text.delta',delta:'中文'},{type:'response.completed',response:finals[api]('中文')}]:[{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'hidden'}},{type:'content_block_delta',delta:{type:'text_delta',text:'中文'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
    const bytes=Buffer.from(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\r\n\r\n').join(''));res.setHeader('Content-Type','text/event-stream');for(let i=0;i<bytes.length;i+=7)res.write(bytes.subarray(i,i+7));res.end();
  });
});
test('missing config, missing key and unsafe URL fail before making a request',async()=>{
  assert.throws(()=>directModelSettings({provider:'',model:'',baseUrl:'',apiType:'openai-completions',apiKeyEnv:''}),/配置 ApiX/);
  await fixture(async(settings,calls)=>{
    for(const change of [{baseUrl:'https://remote.invalid/v1'},{baseUrl:settings.baseUrl+'?key=x'},{apiKeyEnv:'APIX_MISSING_DIRECT_FIXTURE_KEY'}])await assert.rejects(inferModel({...settings,...change},'task'));
    assert.equal(calls.length,0);await assert.rejects(inferModel(settings,'x'.repeat(524289)),/512 KiB/);assert.equal(calls.length,0);
  },(_req,res)=>res.end('{}'));
});
test('HTTP errors and redirects never expose provider text or repeat the request',async()=>{
  for(const status of [401,429,500,302])await fixture(async(settings,calls)=>{await assert.rejects(inferModel(settings,'task'),e=>!e.message.includes('provider-private-secret'));assert.equal(calls.length,1);},(_req,res)=>{res.writeHead(status,{Location:'/other'});res.end('provider-private-secret');});
});
test('broken, failed and truncated model replies cannot become successful output',async()=>{
  const bad=[['application/json','{"choices":[{"finish_reason":"length","message":{"content":"partial"}}]}'],['application/json','{"error":{"message":"provider-private-secret"}}'],['application/json','{"choices":[{"finish_reason":"stop","message":{"content":"'+'x'.repeat(100001)+'"}}]}'],['text/event-stream','data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],['text/event-stream','data: {"type":"error","error":{"message":"private"}}\n\n'],['application/json','x'.repeat(2*1024*1024+1)]];
  for(const [type,body] of bad)await fixture(async(settings)=>assert.rejects(inferModel(settings,'task',()=>{})),(_req,res)=>{res.setHeader('Content-Type',type);res.end(body);});
});
test('deadline includes response body and explicit abort cancels the HTTP call',async()=>{
  await fixture(async(settings)=>{await assert.rejects(inferModel(settings,'task',undefined,{timeoutMs:40}),/超时/);const stop=new AbortController();stop.abort();await assert.rejects(inferModel(settings,'task',undefined,{signal:stop.signal}),/停止/);},(_req,res)=>{res.setHeader('Content-Type','application/json');res.write('{');});
});
test('explicit provider quota codes survive sanitization without exposing provider error messages',async()=>{
  for(const stream of [false,true])await fixture(async(settings)=>assert.rejects(inferModel(settings,'task'),e=>e.message.includes('insufficient_quota')&&!e.message.includes('private-key')),
    (_req,res)=>{const value={type:'error',error:{type:'rate_limit_error',message:'private-key'}};res.setHeader('Content-Type',stream?'text/event-stream':'application/json');res.end(stream?'data: '+JSON.stringify(value)+'\n\n':JSON.stringify(value));});
});
