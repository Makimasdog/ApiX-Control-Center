import {test} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {serviceDiagnostics,waitServiceReady,stopService} from './service-diagnostics.mjs';
test('readiness fails early on actual exit and redacts captured output',{timeout:8000},async()=>{
 const child=spawn(process.execPath,['-e',"console.log('diagnostic-private-key');console.error('startup failed');process.exit(7)"],{stdio:['ignore','pipe','pipe']});const d=serviceDiagnostics(child,{API_KEY:'diagnostic-private-key'});await once(child,'close');
 await assert.rejects(waitServiceReady(d,'http://127.0.0.1:1'),e=>{assert(e.message.includes('startup_exited'));assert(e.message.includes('"exitCode":7'));assert(!e.message.includes('diagnostic-private-key'));assert(e.message.includes('<redacted>'));return true;});
});
test('readiness bounds requests with stalled headers and retains stage evidence',{timeout:8000},async()=>{
 const child=spawn(process.execPath,['-e',"const s=require('node:http').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"],{stdio:['ignore','pipe','pipe']});const d=serviceDiagnostics(child);let text='';const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture startup watchdog')),3000);child.stdout.on('data',b=>{text+=b;if(text.includes('\n')){clearTimeout(timer);resolve(Number(text.trim()));}});});
 try{const started=performance.now();await assert.rejects(waitServiceReady(d,'http://127.0.0.1:'+port,{timeoutMs:180,requestMs:40}),e=>{assert(e.message.includes('startup_deadline'));assert(e.message.includes('connection_error'));return true;});assert(performance.now()-started<1500);}finally{await stopService(child);}
});
