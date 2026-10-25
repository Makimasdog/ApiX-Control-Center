import {test} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createServer} from 'node:http';import {fetch} from './local-fetch.mjs';
import {serviceDiagnostics,waitServiceReady,stopService} from './service-diagnostics.mjs';
test('readiness fails early on actual exit and redacts captured output',{timeout:8000},async()=>{
 const child=spawn(process.execPath,['-e',"console.log('diagnostic-private-key');console.error('startup failed');process.exit(7)"],{stdio:['ignore','pipe','pipe']});const d=serviceDiagnostics(child,{API_KEY:'diagnostic-private-key'});await once(child,'close');
 await assert.rejects(waitServiceReady(d,'http://127.0.0.1:1'),e=>{assert(e.message.includes('startup_exited'));assert(e.message.includes('"exitCode":7'));assert(!e.message.includes('diagnostic-private-key'));assert(e.message.includes('<redacted>'));return true;});
});
test('readiness bounds requests with stalled headers and retains stage evidence',{timeout:8000},async()=>{
 const child=spawn(process.execPath,['-e',"const s=require('node:http').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"],{stdio:['ignore','pipe','pipe']});const d=serviceDiagnostics(child);let text='';const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture startup watchdog')),3000);child.stdout.on('data',b=>{text+=b;if(text.includes('\n')){clearTimeout(timer);resolve(Number(text.trim()));}});});
 try{const started=performance.now();await assert.rejects(waitServiceReady(d,'http://127.0.0.1:'+port,{timeoutMs:180,requestMs:40}),e=>{assert(e.message.includes('startup_deadline'));assert(e.message.includes('connection_error'));return true;});assert(performance.now()-started<1500);}finally{await stopService(child);}
});

test('local fixture HTTP closes pooled connections and never replays a failed write',async()=>{
 const requests=[],server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url,port:req.socket.remotePort,connection:req.headers.connection,authorization:req.headers.authorization,body});if(req.url==='/api/drop'){req.socket.destroy();return;}res.end('ok');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal(await (await fetch(new Request(origin+'/api/write',{method:'POST',body:'first'}))).text(),'ok');
  assert.equal(await (await fetch(origin+'/api/write',{method:'POST',body:'second'})).text(),'ok');
  assert(requests.every(r=>r.connection==='close'));assert.notEqual(requests[0].port,requests[1].port);assert.deepEqual(requests.map(r=>r.body),['first','second']);assert(requests.every(r=>r.authorization==='Bearer '+process.env.APIX_OWNER_TOKEN));
  await assert.rejects(fetch(origin+'/api/drop',{method:'POST',body:'once'}));assert.equal(requests.filter(r=>r.path==='/api/drop').length,1);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
