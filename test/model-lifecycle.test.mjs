import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {inferModel} from '../dist/src/models/model-backend.js';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {getEventListeners} from 'node:events';

const signal=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const frame=data=>'data: '+(typeof data==='string'?data:JSON.stringify(data))+'\n\n';
const delta=frame({choices:[{delta:{content:'ok'}}]});
const stop=frame({choices:[{delta:{},finish_reason:'stop'}]});
const timeoutError=error=>{const match=error.message.match(/模型请求超时（(\d+) ms/);assert(match);assert(Number(match[1])>0&&Number(match[1])<=150);return true;};
async function fixture(t,handler,work){
  const entered=signal(),closed=signal();let phase='connection',count=0,expired=false;
  const server=createServer(async(req,res)=>{
    for await(const _ of req){}count++;phase='headers';
    res.once('close',()=>{phase='closed';closed.resolve();});
    handler(res,(next='body')=>{phase=next;entered.resolve();});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const guard=setTimeout(()=>{expired=true;t.diagnostic('fixture watchdog: '+phase);server.closeAllConnections();},2000);
  const settings={provider:'apix-custom',model:'fixture',apiType:'openai-completions',apiKeyEnv:'',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  try{await work(settings,{entered:entered.promise,closed:closed.promise,count:()=>count});assert.equal(expired,false,'fixture watchdog fired');}
  finally{clearTimeout(guard);server.closeAllConnections();await new Promise(r=>server.close(r));}
}

for(const headers of [false,true])test(`deadline destroys request stalled at ${headers?'body':'headers'}`,{timeout:3000},async t=>{
  await fixture(t,(res,ready)=>{if(headers){res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();}ready(headers?'body':'headers');},async(settings,s)=>{
    const result=inferModel(settings,'fixture',undefined,{timeoutMs:150});await s.entered;
    // 准备与记账共用截止时间，因此本次请求剩余时限可能不足 150ms。
    await assert.rejects(result,timeoutError);await s.closed;assert.equal(s.count(),1);
  });
});
test('partial body cancellation closes transport, repeated abort is harmless',{timeout:3000},async t=>{
  const controller=new AbortController(),observed=signal();
  await fixture(t,(res,ready)=>{res.setHeader('Content-Type','text/event-stream');res.write(delta);ready();},async(settings,s)=>{
    const result=inferModel(settings,'fixture',()=>observed.resolve(),{signal:controller.signal,timeoutMs:1000});
    await observed.promise;controller.abort();controller.abort();await assert.rejects(result,/停止/);await s.closed;assert.equal(s.count(),1);
  });
});
test('pre-cancelled request never reaches server',{timeout:3000},async t=>{
  await fixture(t,res=>res.end(),async(settings,s)=>{const controller=new AbortController();controller.abort();await assert.rejects(inferModel(settings,'fixture',undefined,{signal:controller.signal}),/停止/);assert.equal(s.count(),0);});
});
for(const api of ['openai-completions','openai-responses','anthropic-messages'])test(`${api} terminal completes while body stays open, ignores late events`,{timeout:3000},async t=>{
  const events=api==='openai-completions'?delta+stop+frame('[DONE]'):api==='openai-responses'?frame({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}}):frame({type:'content_block_delta',delta:{type:'text_delta',text:'ok'}})+frame({type:'message_delta',delta:{stop_reason:'end_turn'}})+frame({type:'message_stop'});
  const controller=new AbortController();
  await fixture(t,(res,ready)=>{res.setHeader('Content-Type','text/event-stream');res.write(events+frame('{invalid late data'));ready();},async(settings,s)=>{
    let text='';assert.equal(await inferModel({...settings,apiType:api},'fixture',d=>text+=d,{timeoutMs:150,signal:controller.signal}),'ok');controller.abort();controller.abort();await s.closed;assert.equal(text,'ok');assert.equal(s.count(),1);
  });
});
for(const [name,body] of [['invalid event','data: {invalid\n\n'],['missing terminal',delta+stop],['missing stop',delta+frame('[DONE]')]])test(name+' rejects incomplete result',{timeout:3000},async t=>{
  await fixture(t,res=>{res.setHeader('Content-Type','text/event-stream');res.end(body);},async(settings,s)=>{await assert.rejects(inferModel(settings,'fixture',undefined,{timeoutMs:150}));await s.closed;assert.equal(s.count(),1);});
});
test('transport interruption cannot complete partial text',{timeout:3000},async t=>{
  const received=signal();let response;
  await fixture(t,(res,ready)=>{response=res;res.setHeader('Content-Type','text/event-stream');res.write(delta);ready();},async(settings,s)=>{
    const result=inferModel(settings,'fixture',()=>received.resolve(),{timeoutMs:1000});await received.promise;response.destroy();await assert.rejects(result);await s.closed;assert.equal(s.count(),1);
  });
});
test('abort racing deadline settles once and does not replay',{timeout:3000},async t=>{
  const controller=new AbortController();let timer;
  await fixture(t,(res,ready)=>{res.write('{');ready();},async(settings,s)=>{
    const result=inferModel(settings,'fixture',undefined,{timeoutMs:150,signal:controller.signal});await s.entered;timer=setTimeout(()=>controller.abort(),150);
    try{await assert.rejects(result,/超时|停止/);await s.closed;controller.abort();assert.equal(s.count(),1);}finally{clearTimeout(timer);}
  });
});
test('timeout outcome survives cancellation arriving during transport close',{timeout:3000},async t=>{
  const controller=new AbortController();
  await fixture(t,(res,ready)=>{res.once('close',()=>controller.abort());res.write('{');ready();},async(settings,s)=>{
    const result=inferModel(settings,'fixture',undefined,{timeoutMs:150,signal:controller.signal});await s.entered;
    await assert.rejects(result,timeoutError);await s.closed;assert(controller.signal.aborted);assert.equal(getEventListeners(controller.signal,'abort').length,0);
  });
});
test('missing close acknowledgement preserves unknown cleanup even if usage recording fails',{timeout:4000},async t=>{
  const original=http.request,controller=new AbortController();let socket,emit;
  // Fault injection suppresses acknowledgement, not actual socket destruction.
  http.request=(...args)=>{const req=original(...args);req.once('socket',assigned=>{socket=assigned;emit=assigned.emit;assigned.emit=function(event,...values){return event==='close'?false:emit.call(this,event,...values);};});return req;};syncBuiltinESMExports();
  try{await fixture(t,res=>{res.setHeader('Content-Type','text/event-stream');res.write(delta+stop+frame('[DONE]'));},async(settings,s)=>{
    const started=performance.now();await assert.rejects(inferModel(settings,'fixture',undefined,{signal:controller.signal,timeoutMs:150,onAttempt:()=>{throw new Error('usage persistence failure');}}),e=>e.code==='MODEL_CLEANUP_UNKNOWN'&&/清理未确认.*资源状态未知/.test(e.message)&&e.message.includes('Token 用量记录未确认'));
    assert(performance.now()-started<1800);assert(socket.destroyed);assert.equal(s.count(),1);assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();
  });}finally{http.request=original;syncBuiltinESMExports();if(socket&&emit){socket.emit=emit;socket.emit('close',false);}}
});
test('unterminated SSE frame at EOF cannot count as a terminal event',{timeout:3000},async t=>{
  await fixture(t,res=>{res.setHeader('Content-Type','text/event-stream');res.end(delta+stop+'data: [DONE]');},async settings=>assert.rejects(inferModel(settings,'fixture'),/中断/));
});
