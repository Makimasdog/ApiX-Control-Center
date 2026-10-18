import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,existsSync,rmSync,watch,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createAssistantCommands} from '../dist/src/assistant-commands.js';
import {createAssistantLoop} from '../dist/src/assistant-loop.js';
import {fileTool,projectFingerprint} from '../dist/src/assistant-tools.js';
import {checkPassed} from '../dist/src/assistant-verification.js';

const action=(tool,args)=>({action:'tool',tool,args,message:tool});
const finish={action:'finish',outcome:'completed',message:'done'};
async function idle(h,id=h.id){for(let n=0;n<3000;n++){const s=h.service.details(id);if(!s.busy&&s.status!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw new Error('loop watchdog fired');}
async function fixture(work){
 const root=mkdtempSync(join(tmpdir(),'apix-bridge-'));const dbRoot=mkdtempSync(join(tmpdir(),'apix-bridge-db-'));let db,bridge,service,policy={mode:'full_access',version:1};const queue=[];
 const start=()=>{db=new DatabaseSync(join(dbRoot,'data.sqlite'));db.exec("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY);INSERT OR IGNORE INTO projects VALUES ('p')");const store={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};bridge=createAssistantCommands({...store,root:()=>root,env:()=>process.env,protectedValues:()=>[],policy:()=>policy});service=createAssistantLoop({...store,policy:()=>policy,projectRoot:()=>root,describe:()=>({}),fingerprint:()=>projectFingerprint(root),commandState:(s,phase)=>phase==='resume'?bridge.recover(s):bridge.assertClear(s,phase==='message'),infer:async()=>{const decision=queue.shift();if(!decision)throw new Error('fixture exhausted');return JSON.stringify(decision);},execute:(s,tool,args,signal)=>tool==='write_file'?fileTool(root,tool,args):bridge.execute(s,tool,args,signal),child:()=>({complete:false}),stopChild:()=>{}});};start();
 const h={root,get db(){return db;},get bridge(){return bridge;},get service(){return service;},id:service.create({projectId:'p'}).id,push:(...items)=>queue.splice(0,queue.length,...items),policy:value=>policy=value,restart:()=>{db.close();start();}};
 try{await work(h);}finally{db.close();for(const dir of [root,dbRoot]){assert(resolve(dir).startsWith(resolve(tmpdir())));rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
}
test('production command bridge records real normal and failed process facts',{timeout:25000},()=>fixture(async h=>{
 const s=h.service.details(h.id);
 for(const code of [0,3]){const result=await h.bridge.execute(s,'run_command',{executable:'node',args:['-e',`console.log('evidence');process.exit(${code})`]},new AbortController().signal);assert.equal(result.exitCode,code,JSON.stringify(result));assert.equal(result.processesEnded,true);assert.equal(result.sideEffectsNeedReview,false);assert.equal(result.evidencePersisted,true);assert.equal(checkPassed(result),code===0);assert(h.db.prepare('SELECT body FROM assistant_outputs WHERE id=?').get(result.outputRef));}
 assert.equal(h.db.prepare("SELECT COUNT(*) n FROM assistant_events WHERE kind='command_finished'").get().n,2);
}));
for(const phase of ['intent','identity','output'])test(`actual SQLite ${phase} recording failure gates execution and recovery`,{timeout:25000},()=>fixture(async h=>{
 h.db.exec(phase==='output'?"CREATE TRIGGER deny BEFORE INSERT ON assistant_outputs WHEN NEW.id NOT LIKE 'review-%' BEGIN SELECT RAISE(FAIL,'output record failed');END;":`CREATE TRIGGER deny BEFORE INSERT ON assistant_events WHEN NEW.kind='command_${phase}' ${phase==='identity'?"AND json_extract(NEW.body,'$.identity.pid') IS NOT NULL":''} BEGIN SELECT RAISE(FAIL,'record failed');END;`);
 h.push(action('run_command',{executable:'node',args:['-e',"require('node:fs').writeFileSync('ran','yes');setTimeout(()=>{},200)"],timeoutMs:5000}),finish);h.service.message(h.id,{content:'command'});let s=await idle(h);assert.equal(s.status,'attention');assert.equal(s.busy,false);assert(s.events.some(e=>e.kind==='process_unknown'));
 if(phase==='intent')assert.equal(existsSync(join(h.root,'ran')),false);
 assert.throws(()=>h.service.message(h.id,{content:'repeat'}),/核对|恢复|检查后继续/);
 const other=h.service.create({projectId:'p'}).id;h.push(action('write_file',{path:'unsafe',content:'no'}));try{h.service.message(other,{content:'other write'});await idle(h,other);}catch(error){assert.match(error.message,/核对|恢复|检查后继续/);}assert.equal(existsSync(join(h.root,'unsafe')),false);
 h.db.exec('DROP TRIGGER deny');
 if(phase!=='intent'){h.restart();assert.throws(()=>h.service.message(h.id,{content:'restart bypass'}),/核对|恢复|检查后继续/);}
 s=h.service.details(h.id);h.push(finish);h.service.resume(h.id,{version:s.version,confirmed:true});await idle(h);assert.equal(h.service.details(h.id).busy,false);
}));
for(const tool of ['run_command','verify','run_check'])test(`${tool} uses shared bridge and never verifies interrupted work`,{timeout:25000},()=>fixture(async h=>{
 writeFileSync(join(h.root,'check.cjs'),"const fs=require('node:fs');fs.writeFileSync('ready','1');setInterval(()=>{},1000)");
 if(tool==='run_check'){
  h.push(action('configure_verification',{checks:[{id:'check',args:['check.cjs'],timeoutMs:5000}],writablePaths:['src']}));h.service.message(h.id,{content:'configure'});let s=await idle(h);h.push(action(tool,{checkId:'check'}));await h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:true});
 }else{h.push(action(tool,{executable:'node',args:['check.cjs'],timeoutMs:5000}));h.service.message(h.id,{content:'work'});}
 await new Promise((resolve,reject)=>{const done=()=>{if(existsSync(join(h.root,'ready'))){clearTimeout(timer);w.close();resolve();}};const w=watch(h.root,done),timer=setTimeout(()=>{w.close();reject(new Error('ready watchdog'));},10000);done();});
 h.service.stop(h.id);const s=await idle(h);assert.equal(s.status,'attention');assert.equal(s.busy,false);assert.equal(s.verification,null);assert(s.events.some(e=>e.kind==='command_intent'));assert(s.events.some(e=>e.kind==='command_finished'));assert(s.events.some(e=>e.kind==='process_unknown'));assert(!s.events.some(e=>e.kind==='verification_evidence'&&e.body.passed));assert.throws(()=>h.service.message(h.id,{content:'retry'}),/核对|恢复|检查后继续/);
 const latest=h.service.details(h.id);h.push(finish);h.service.resume(h.id,{version:latest.version,confirmed:true});await idle(h);assert.equal(h.db.prepare("SELECT COUNT(*) n FROM assistant_events WHERE kind='command_intent'").get().n,1);
}));
test('server assembly uses the shared production command bridge',()=>{const source=readFileSync('control-plane.mjs','utf8');assert.match(source,/assistantCommands\.execute\(s,tool,args,signal\)/);assert.match(source,/assistantCommands\.recover\(s\)/);});
test('a reconstructed recovery guard refuses a still active job and never kills by old PID',{timeout:30000},()=>fixture(async h=>{
 writeFileSync(join(h.root,'active.cjs'),"require('node:fs').writeFileSync('active-ready','1');setInterval(()=>{},1000)");
 const controller=new AbortController(),s=h.service.details(h.id);const resultPromise=h.bridge.execute(s,'run_command',{executable:'node',args:['active.cjs'],timeoutMs:10000},controller.signal);
 try{await new Promise((resolve,reject)=>{const done=()=>{if(existsSync(join(h.root,'active-ready'))){clearTimeout(timer);w.close();resolve();}};const w=watch(h.root,done),timer=setTimeout(()=>{w.close();reject(new Error('ready watchdog'));},10000);done();});
 const store={db:h.db,row:(q,...p)=>h.db.prepare(q).get(...p),rows:(q,...p)=>h.db.prepare(q).all(...p),now:()=>new Date().toISOString()};const reconstructed=createAssistantCommands({...store,root:()=>h.root,env:()=>process.env,protectedValues:()=>[],policy:()=>({mode:'full_access',version:1})});
 assert.throws(()=>reconstructed.recover(s),/活跃|身份/);controller.abort();const result=await resultPromise;assert.equal(result.processesEnded,true);reconstructed.recover(s);
 }finally{controller.abort();await resultPromise;}
}));
test('permission revocation cancels a real command and keeps the recovery gate',{timeout:30000},()=>fixture(async h=>{
 writeFileSync(join(h.root,'revoke.cjs'),"require('node:fs').writeFileSync('revoke-ready','1');setInterval(()=>{},1000)");h.push(action('run_command',{executable:'node',args:['revoke.cjs'],timeoutMs:10000}));h.service.message(h.id,{content:'work'});
 await new Promise((resolve,reject)=>{const done=()=>{if(existsSync(join(h.root,'revoke-ready'))){clearTimeout(timer);w.close();resolve();}};const w=watch(h.root,done),timer=setTimeout(()=>{w.close();reject(new Error('ready watchdog'));},10000);done();});
 h.policy({mode:'read_only',version:2});const state=await idle(h);assert.equal(state.status,'attention');assert(state.events.some(e=>e.kind==='command_finished'&&e.body.reason==='permission_revoked'));assert.throws(()=>h.service.message(h.id,{content:'retry'}),/核对|恢复|检查后继续/);
}));

test('trusted final evidence failure rolls back verification and requires review',{timeout:25000},()=>fixture(async h=>{
 writeFileSync(join(h.root,'check.cjs'),"console.log('real test')");
 h.push(action('configure_verification',{checks:[{id:'check',args:['check.cjs'],timeoutMs:5000}],writablePaths:['src']}));h.service.message(h.id,{content:'configure'});let s=await idle(h);
 h.db.exec("CREATE TRIGGER deny_check BEFORE INSERT ON assistant_outputs WHEN json_extract(NEW.body,'$.outputRef') IS NOT NULL AND NEW.id<>json_extract(NEW.body,'$.outputRef') BEGIN SELECT RAISE(FAIL,'check evidence unavailable');END;");
 h.push(action('run_check',{checkId:'check'}),finish);await h.service.reply(h.id,{version:s.version,requestId:s.pending.id,approved:true});s=await idle(h);
 assert.equal(s.status,'attention');assert.equal(s.verification,null);assert(s.events.some(e=>e.kind==='command_finished'&&e.body.executionComplete));assert(!s.events.some(e=>e.kind==='verification_evidence'&&e.body.passed));assert(s.events.some(e=>e.kind==='process_unknown'));assert.throws(()=>h.service.message(h.id,{content:'retry'}),/核对|恢复|检查后继续/);
 h.db.exec('DROP TRIGGER deny_check');h.restart();assert.throws(()=>h.service.message(h.id,{content:'restart retry'}),/核对|恢复|检查后继续/);
}));

test('journal loss after launch exposes unreliable safety state and still blocks project writes',{timeout:25000},()=>fixture(async h=>{
 h.db.exec("CREATE TRIGGER deny_identity BEFORE INSERT ON assistant_events WHEN NEW.kind='command_identity' AND json_extract(NEW.body,'$.identity.pid') IS NOT NULL BEGIN SELECT RAISE(FAIL,'identity unavailable');END;CREATE TRIGGER deny_unknown BEFORE INSERT ON assistant_events WHEN NEW.kind='process_unknown' BEGIN SELECT RAISE(FAIL,'safety journal unavailable');END;CREATE TRIGGER deny_attention BEFORE UPDATE ON assistant_sessions WHEN NEW.status='attention' BEGIN SELECT RAISE(FAIL,'state unavailable');END;");
 h.push(action('run_command',{executable:'node',args:['-e','setInterval(()=>{},1000)'],timeoutMs:5000}),finish);h.service.message(h.id,{content:'run'});const s=await idle(h);assert.equal(s.status,'attention');assert.equal(s.busy,false);assert.equal(s.runtimeSafety.persisted,false);assert.throws(()=>h.service.message(h.id,{content:'retry'}),/未可靠保存/);
 h.db.exec('DROP TRIGGER deny_identity;DROP TRIGGER deny_unknown;DROP TRIGGER deny_attention');h.restart();assert.throws(()=>h.service.message(h.id,{content:'restart'}),/核对|恢复/);
 const other=h.service.create({projectId:'p'}).id;h.push(action('write_file',{path:'unsafe',content:'no'}));h.service.message(other,{content:'write'});await idle(h,other);assert.equal(existsSync(join(h.root,'unsafe')),false);
}));
