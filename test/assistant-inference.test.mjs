import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inferModel} from '../dist/src/model-backend.js';
import {createAssistantInference,managerInferenceError} from '../dist/src/assistant-inference.js';
import {createAssistantLoop} from '../dist/src/assistant-loop.js';

const deferred=()=>{let resolve,reject;return {promise:new Promise((r,j)=>{resolve=r;reject=j;}),resolve:v=>resolve(v),reject:error=>reject(error)};};
const finish={action:'finish',outcome:'completed',message:'read only done'};
const write={action:'tool',tool:'write_file',args:{path:'a.txt',content:'late'},message:'write'};
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
async function transport(t,work,{partial=false,unknown=true,reply}={}){
  const observed=deferred(),sockets=[],original=http.request,previous=process.env.APIX_INFERENCE_TEST_KEY;
  // Some cases never await this phase signal; watchdog failure is also asserted below.
  observed.promise.catch(()=>{});
  process.env.APIX_INFERENCE_TEST_KEY='private-fixture-key';let expired=false,requests=0;
  const server=http.createServer(async(req,res)=>{
    for await(const _ of req){}requests++;if(reply){res.setHeader('Content-Type','application/json');res.end(reply);return;}res.setHeader('Content-Type','text/event-stream');
    res.write(frame({choices:[{delta:{content:JSON.stringify(write)}}]}));
    if(!partial)res.write(frame({choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const settings={provider:'apix-custom',model:'selected-fixture',apiType:'openai-completions',apiKeyEnv:'APIX_INFERENCE_TEST_KEY',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  http.request=(...args)=>{const req=original(...args);if(unknown)req.once('socket',socket=>{const emit=socket.emit;sockets.push({socket,emit});socket.emit=function(event,...values){return event==='close'?false:emit.call(this,event,...values);};});return req;};syncBuiltinESMExports();
  const guard=setTimeout(()=>{expired=true;t.diagnostic('transport watchdog fired');observed.reject(new Error('transport watchdog fired'));server.closeAllConnections();},4000);
  try{await work({settings,observed:observed.promise,request:(signal)=>inferModel(settings,'fixture',()=>observed.resolve(),{signal,timeoutMs:1000}),requests:()=>requests});assert.equal(expired,false,'watchdog must not complete cancellation for the implementation');}
  finally{clearTimeout(guard);http.request=original;syncBuiltinESMExports();for(const {socket,emit} of sockets){socket.emit=emit;socket.emit('close',false);}server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.APIX_INFERENCE_TEST_KEY;else process.env.APIX_INFERENCE_TEST_KEY=previous;}
}
function adapter(settings,infer){
  const calls=[];const wrapped=createAssistantInference({settings:id=>{calls.push(['settings',id]);return settings;},account:id=>{calls.push(['account',id]);return 'shared';},reserve:(...args)=>{calls.push(['reserve',...args]);return true;},settle:(...args)=>calls.push(['settle',...args]),pause:(...args)=>calls.push(['pause',...args]),quotaFailure:message=>message.includes('insufficient_quota'),infer});
  return {wrapped,calls};
}
async function idle(service,id){
  const limit=Date.now()+2500;while(Date.now()<limit){const s=service.details(id);if(!s.busy&&s.status!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw new Error('loop did not settle');
}
async function loopFixture(inference,work){
  const dir=await mkdtemp(join(tmpdir(),'apix-infer-'));const path=join(dir,'state.sqlite');let db,service;const calls=[];let policy={mode:'full_access',version:0};
  const open=()=>{db=new DatabaseSync(path);db.exec("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY);INSERT OR IGNORE INTO projects VALUES ('p')");const deps={db,row:(sql,...p)=>db.prepare(sql).get(...p),rows:(sql,...p)=>db.prepare(sql).all(...p),now:()=>new Date().toISOString(),policy:()=>policy,describe:()=>({}),infer:inference,execute:async(_s,tool,args)=>{calls.push({tool,args});return {};},fingerprint:()=> 'same',child:()=>({status:'running',complete:false,details:{}}),stopChild:()=>{}};service=createAssistantLoop(deps);};open();
  try{await work({get service(){return service;},calls,setPolicy:value=>policy=value,restart:()=>{db.close();open();}});}finally{db.close();assert(dir.startsWith(join(tmpdir(),'apix-infer-')));await rm(dir,{recursive:true,force:true});}
}
const unknownEvent=s=>s.events.find(e=>e.kind==='process_unknown'&&e.body.resource==='model_transport');

test('production assembly uses the tested inference adapter',async()=>{
  const source=await readFile('control-plane.mjs','utf8');assert.match(source,/infer:createAssistantInference\(/);assert.match(source,/throw managerInferenceError\(error,revoked\)/);
});
test('real backend cleanup error crosses production wrapper with safe host code',{timeout:7000},async t=>{
  await transport(t,async net=>{
    const a=adapter(net.settings,async()=>{try{await net.request();}catch(error){error.message+=' private-fixture-key';error.cause={private:'do not copy'};error.body='private response';throw error;}});
    await assert.rejects(a.wrapped('p','task',undefined,'chat'),error=>{
      assert.equal(error.code,'MODEL_CLEANUP_UNKNOWN');assert(!error.message.includes('private-fixture-key'));assert.equal(error.cause,undefined);assert.equal(error.body,undefined);return true;
    });assert.equal(net.requests(),1);assert.equal(a.calls.filter(c=>c[0]==='settle').length,1);
  });
});
for(const mode of ['running','stopped','revoked'])test(`${mode} cleanup unknown persists, blocks restart and releases busy`,{timeout:7000},async t=>{
  await transport(t,async net=>{
    const revoke=new AbortController();let revoked=false;const decisions=[];
    const a=adapter(net.settings,async(_prompt,_delta,context)=>{
      if(decisions.length)return JSON.stringify(decisions.shift());
      try{return await net.request(AbortSignal.any([context.signal,revoke.signal]));}catch(error){throw managerInferenceError(error,revoked);}
    });
    await loopFixture(a.wrapped,async h=>{
      const id=h.service.create({projectId:'p'}).id;h.service.message(id,{content:'work'});await net.observed;
      if(mode==='stopped')h.service.stop(id);
      if(mode==='revoked'){revoked=true;revoke.abort();}
      let s=await idle(h.service,id);assert.equal(s.status,'attention');assert.equal(s.busy,false);assert(unknownEvent(s));assert.equal(h.calls.length,0);assert.equal(net.requests(),1);
      assert.throws(()=>h.service.message(id,{content:'continue'}),/检查原进程/);
      const stale=s.version-1;
      assert.throws(()=>h.service.resume(id,{version:stale,confirmed:true}),/最新版本/);assert.throws(()=>h.service.resume(id,{version:s.version,confirmed:false}),/检查/);
      h.restart();s=h.service.details(id);assert.equal(s.status,'attention');assert.equal(s.busy,false);assert(unknownEvent(s));assert.throws(()=>h.service.message(id,{content:'continue'}),/检查原进程/);
      const other=h.service.create({projectId:'p'}).id;decisions.push(write);h.service.message(other,{content:'write from another chat'});const blocked=await idle(h.service,other);assert.equal(blocked.status,'attention');assert.equal(h.calls.length,0);assert(blocked.events.some(e=>e.kind==='error'&&e.body.error.includes('未确认')));
      decisions.push(finish);h.service.resume(id,{version:s.version,confirmed:true});s=await idle(h.service,id);assert.equal(s.status,'completed');assert.equal(h.calls.length,0);assert.equal(net.requests(),1);
      h.setPolicy({mode:'ask_approval',version:1});decisions.push(write);h.service.message(other,{content:'new write'});let pending=await idle(h.service,other);assert.equal(pending.status,'waiting_user');assert.equal(h.calls.length,0);
      h.setPolicy({mode:'ask_approval',version:2});await assert.rejects(h.service.reply(other,{version:pending.version,requestId:pending.pending.id,approved:true}),/权限已变化/);
      decisions.push(finish);await h.service.reply(other,{version:pending.version,requestId:pending.pending.id,approved:false});await idle(h.service,other);
      decisions.push(write,{...finish,outcome:'blocked'});h.service.message(other,{content:'fresh write'});pending=await idle(h.service,other);assert.equal(pending.status,'waiting_user');
      await h.service.reply(other,{version:pending.version,requestId:pending.pending.id,approved:true});await idle(h.service,other);assert.equal(h.calls.length,1);assert.equal(net.requests(),1);
    });
  },{partial:mode!=='running'});
});
test('normal errors, foreign codes, quota settlement and conversation identity remain bounded',{timeout:5000},async()=>{
  const settings={provider:'apix-custom',model:'selected',apiKeyEnv:'APIX_INFERENCE_TEST_KEY'};const previous=process.env.APIX_INFERENCE_TEST_KEY;process.env.APIX_INFERENCE_TEST_KEY='private-fixture-key';
  try{for(const code of ['MODEL_CLEANUP_UNKNOWN','third_party_code',undefined]){
    const permissionError=managerInferenceError(Object.assign(new Error('ordinary'),{code}),true);assert.match(permissionError.message,/权限已变化/);assert.equal(permissionError.code,undefined);
    const a=adapter(settings,async()=>{throw Object.assign(new Error('private-fixture-key insufficient_quota'),{code,cause:'private',body:'private'});});
    await assert.rejects(a.wrapped('p','task',undefined,'selected-chat'),error=>{assert.equal(error.code,undefined);assert(!error.message.includes('private-fixture-key'));assert.equal(error.cause,undefined);return true;});assert.equal(a.calls.filter(c=>c[0]==='pause').length,1);assert.equal(a.calls.filter(c=>c[0]==='settle').length,1);
  }
  const controller=new AbortController(),a=adapter(settings,async(prompt,onDelta,context)=>{assert.equal(prompt,'task');assert.equal(onDelta,undefined);assert.equal(context.modelSettings,settings);assert.equal(context.signal,controller.signal);assert.equal(context.purpose,'assistant_loop');return JSON.stringify(finish);});
  assert.equal(await a.wrapped('p','task',controller.signal,'selected-chat'),JSON.stringify(finish));assert(a.calls.some(c=>c[0]==='settings'&&c[1]==='selected-chat'));assert.equal(a.calls.filter(c=>c[0]==='pause').length,0);
  }finally{if(previous===undefined)delete process.env.APIX_INFERENCE_TEST_KEY;else process.env.APIX_INFERENCE_TEST_KEY=previous;}
});
test('reservation refusal prevents inference and absent reservation is not settled',async()=>{
  let calls=0,settles=0;const deps={settings:()=>({apiKeyEnv:''}),account:()=>null,reserve:()=>{throw new Error('budget blocked');},settle:()=>settles++,pause:()=>{},quotaFailure:()=>false,infer:async()=>{calls++;return 'ok';}};
  await assert.rejects(createAssistantInference(deps)('p','task'),/budget blocked/);assert.equal(calls,0);assert.equal(settles,0);
  deps.reserve=()=>false;assert.equal(await createAssistantInference(deps)('p','task'),'ok');assert.equal(calls,1);assert.equal(settles,0);
});
test('confirmed transport stop does not manufacture an unknown event',{timeout:7000},async t=>{
  await transport(t,async net=>{const a=adapter(net.settings,(_p,_d,context)=>net.request(context.signal));await loopFixture(a.wrapped,async h=>{const id=h.service.create({projectId:'p'}).id;h.service.message(id,{content:'work'});await net.observed;h.service.stop(id);const s=await idle(h.service,id);assert.equal(s.status,'stopped');assert.equal(s.busy,false);assert.equal(unknownEvent(s),undefined);assert.equal(h.calls.length,0);assert.equal(net.requests(),1);});},{partial:true,unknown:false});
});
for(const reply of ['{invalid',JSON.stringify({error:{code:'MODEL_CLEANUP_UNKNOWN',message:'private-fixture-key'}})])test(`ordinary protocol/provider error cannot forge host uncertainty: ${reply.startsWith('{invalid')?'syntax':'provider code'}`,{timeout:7000},async t=>{
  await transport(t,async net=>{let first=true;const a=adapter(net.settings,(_p,_d,context)=>{if(first){first=false;return net.request(context.signal);}return Promise.resolve(JSON.stringify(finish));});await loopFixture(a.wrapped,async h=>{const id=h.service.create({projectId:'p'}).id;h.service.message(id,{content:'work'});let s=await idle(h.service,id);assert.equal(s.status,'attention');assert.equal(unknownEvent(s),undefined);assert(s.events.some(e=>e.kind==='error'));assert.equal(h.calls.length,0);h.service.message(id,{content:'new read only request'});s=await idle(h.service,id);assert.equal(s.status,'completed');assert.equal(net.requests(),1);});},{unknown:false,reply});
});
