import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createAssistantLoop} from '../dist/src/assistant/assistant-loop.js';
import {createAssistantCommands} from '../dist/src/assistant/assistant-commands.js';
import {fileTool,commandTool,projectFingerprint} from '../dist/src/assistant/assistant-tools.js';
import {createToolRegistry} from '../dist/src/assistant/tool-registry.js';
import {verificationContract} from '../dist/src/assistant/assistant-verification.js';
const action=(tool,args={})=>({action:'tool',tool,args,message:tool});
const finish={action:'finish',outcome:'completed',message:'ALL TESTS PASS'};
const write=content=>action('write_file',{path:'src/value.txt',content});
const check=action('run_check',{checkId:'unit'});
async function wait(h){for(let n=0;n<1500;n++){const d=h.service.details(h.id);if(!d.busy&&d.status!=='running')return d;await new Promise(r=>setTimeout(r,5));}throw Error('fixture timeout');}
async function fixture(work,script="const fs=require('node:fs');const value=fs.readFileSync('src/value.txt','utf8');console.log('observed='+value);process.exit(value==='good'?0:2)"){
  const root=mkdtempSync(join(tmpdir(),'apix-trusted-'));mkdirSync(join(root,'src'));writeFileSync(join(root,'src/value.txt'),'old');writeFileSync(join(root,'check.cjs'),script);
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p')");
  const store={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString()};
  const bridge=createAssistantCommands({...store,root:()=>root,env:()=>process.env,protectedValues:()=>[],policy:()=>({mode:'full_access',version:1})});
  const queue=[],calls=[],prompts=[];const deps={db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p),now:()=>new Date().toISOString(),policy:()=>({mode:'full_access',version:1}),projectRoot:()=>root,fingerprint:()=>projectFingerprint(root),describe:()=>({}),child:()=>({complete:false}),stopChild:()=>{},infer:async(_p,prompt)=>{prompts.push(prompt);const a=queue.shift();if(!a)throw Error('fixture exhausted');return JSON.stringify(typeof a==='function'?await a():a);},execute:async(s,tool,args,signal)=>{calls.push({tool,args});return tool==='write_file'?fileTool(root,tool,args):bridge.execute(s,tool,args,signal);}};
  const h={db,root,deps,calls,prompts,service:createAssistantLoop(deps),push:(...a)=>queue.push(...a)};h.id=h.service.create({projectId:'p'}).id;
  h.start=(...a)=>{h.push(...a);h.service.message(h.id,{content:'implement and verify'});return wait(h);};
  h.approve=async(...a)=>{const d=await h.start(action('configure_verification',{checks:[{id:'unit',args:['check.cjs'],timeoutMs:1000}],writablePaths:['src']}),...a);assert.equal(d.status,'waiting_user');assert.equal(calls.length,0);await h.service.reply(h.id,{version:d.version,requestId:d.pending.id,approved:true});return wait(h);};
  try{await work(h);}finally{db.close();assert(resolve(root).startsWith(resolve(tmpdir())));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
test('arbitrary successful diagnostic and no configured checks cannot verify or claim completion',()=>fixture(async h=>{
  const d=await h.start(write('good'),action('verify',{executable:'node',args:['-e','process.exit(0)']}),finish);
  assert.equal(d.status,'attention');assert.equal(d.verificationStatus,'needs_review');assert.equal(d.verification,null);assert(!d.events.some(e=>e.kind==='verification_evidence'));assert(!d.events.some(e=>e.kind==='answer'&&e.body.content==='ALL TESTS PASS'));
}));
test('read-only command explanation needs no code verification and receives no trusted pass',()=>fixture(async h=>{
  const d=await h.start(action('run_command',{executable:'node',args:['--version']}),finish);assert.equal(d.status,'completed',JSON.stringify(d.events.filter(e=>['command_finished','tool_result','error','process_unknown'].includes(e.kind))));assert.equal(d.verificationStatus,'not_required');assert.equal(d.verification,null);assert.equal(d.needs_verification,0);assert(!d.events.some(e=>e.kind==='verification_evidence'));
}));
test('a command that actually writes code still requires a trusted check',()=>fixture(async h=>{
  const d=await h.start(action('run_command',{executable:'node',args:['-e',"require('node:fs').writeFileSync('src/value.txt','good')"]}),finish);assert.equal(d.status,'attention');assert.equal(d.verificationStatus,'needs_review');assert.equal(d.needs_verification,1);assert.equal(d.verification,null);
}));
test('approved real check binds execution, output, current code and contract without employees',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,finish);assert.equal(d.status,'completed',JSON.stringify(d.events.filter(e=>['command_finished','tool_result','error','process_unknown'].includes(e.kind))));assert.equal(d.verificationStatus,'verified',JSON.stringify(d.events.filter(e=>['command_finished','tool_result','error','process_unknown'].includes(e.kind))));assert.equal(d.acceptanceStatus,'not_accepted');
  const e=d.checks[0];assert.equal(e.exitCode,0);assert(e.passed);assert.equal(e.projectFingerprint,projectFingerprint(h.root));assert.equal(e.checkContractVersion,d.contract.version);assert(e.startedAt&&e.finishedAt&&e.runId&&e.sessionId===h.id);
  assert.match(h.service.readOutput(h.id,{id:e.outputRef}).text,/observed=good/);
  h.service=createAssistantLoop(h.deps);assert.equal(h.service.details(h.id).verificationStatus,'verified');
}));
test('every required check must pass and model cannot override the fixed command',()=>fixture(async h=>{
  const pending=await h.start(action('configure_verification',{checks:[{id:'unit',args:['check.cjs'],timeoutMs:1000},{id:'second',args:['check.cjs'],timeoutMs:1000}],writablePaths:['src']}),write('good'),action('run_check',{checkId:'unit',executable:'node',args:['-e','process.exit(0)']}),check,finish,action('run_check',{checkId:'second'}),finish);
  await h.service.reply(h.id,{version:pending.version,requestId:pending.pending.id,approved:true});const d=await wait(h);assert.equal(d.status,'completed',JSON.stringify(d.events.filter(e=>['command_finished','tool_result','error','process_unknown'].includes(e.kind))));assert.equal(d.checks.length,2);assert(d.checks.every(e=>e.passed));assert(d.events.some(e=>e.kind==='completion_rejected'));assert(h.calls.filter(c=>c.tool==='run_command').every(c=>c.args.args[0]==='check.cjs'));
}));
test('check modifying its own script cannot generate trusted success',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,finish);assert.equal(d.status,'attention');assert.equal(d.verificationStatus,'needs_review');assert(d.events.some(e=>e.kind==='verification_evidence'&&e.body.exitCode===0&&e.body.passed===false));
},"require('node:fs').appendFileSync('check.cjs','\\n// changed');process.exit(0)"));
test('legacy verification string cannot promote an untrusted delivery',()=>fixture(async h=>{
  const d=await h.start(write('good'),()=>{h.db.prepare('UPDATE assistant_sessions SET verification=? WHERE id=?').run(projectFingerprint(h.root),h.id);return finish;});assert.equal(d.status,'attention');assert.equal(d.verification,null);assert.equal(d.verificationStatus,'needs_review');
}));
test('contract cannot make its own check writable or expand executor limits',()=>fixture(async h=>{
  const config={checks:[{id:'unit',args:['check.cjs'],timeoutMs:1000}],writablePaths:['check.cjs']};assert.throws(()=>verificationContract(h.root,config),/不得位于可修改范围/);
  assert.throws(()=>verificationContract(h.root,{...config,writablePaths:['../outside']}),/相对路径/);
  assert.throws(()=>verificationContract(h.root,{...config,writablePaths:['src'],checks:[{id:'unit',args:['check.cjs'],timeoutMs:120001}]}),/执行器限制/);
  const registry=createToolRegistry();assert.throws(()=>registry.validate('configure_verification',{...config,checks:[{id:'unit',args:['check.cjs','x'.repeat(1001)],timeoutMs:1000}]}));
}));
test('failed trusted check rejects completion and provides actual evidence for repair and retest',()=>fixture(async h=>{
  const d=await h.approve(write('bad'),check,finish,write('good'),check,finish);assert.equal(d.status,'completed',JSON.stringify(d.events.filter(e=>['command_finished','tool_result','error','process_unknown'].includes(e.kind))));
  const failed=d.events.find(e=>e.kind==='verification_evidence'&&e.body.exitCode===2);assert(failed);assert.equal(failed.body.passed,false);assert(d.events.some(e=>e.kind==='completion_rejected'));assert(h.prompts.some(p=>p.includes('outputRef')));assert.match(h.service.readOutput(h.id,{id:failed.body.outputRef}).text,/observed=bad/);
}));
test('an identical write decision reuses its receipt and does not invalidate an unchanged verified workspace',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,write('good'),finish,check,finish);assert.equal(d.status,'completed',JSON.stringify(d.events.filter(e=>['command_finished','tool_result','error','process_unknown'].includes(e.kind))));assert(d.events.some(e=>e.kind==='operation_reused'));assert.equal(h.calls.filter(c=>c.tool==='run_command').length,1);
}));
test('writes in another conversation invalidate old project evidence even for identical bytes',()=>fixture(async h=>{
  const verified=await h.approve(write('good'),check,finish);assert.equal(verified.verificationStatus,'verified');const first=h.id;h.id=h.service.create({projectId:'p'}).id;
  await h.start(write('good'),{...finish,outcome:'blocked'});const original=h.service.details(first);assert.equal(original.verificationStatus,'unverified');assert.equal(original.verification,null);
}));
test('modified approved script cannot silently retain authorization',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,action('write_file',{path:'check.cjs',content:'process.exit(0)'}),check,finish);assert.equal(d.status,'attention');assert.equal(d.verificationStatus,'needs_review');assert.equal(h.calls.filter(c=>c.tool==='run_command').length,1);assert.equal(d.verification,null);
}));
test('hidden helper files and dependency changes invalidate contract too',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,()=>{mkdirSync(join(h.root,'.tmp-helper'));writeFileSync(join(h.root,'.tmp-helper/code.cjs'),'process.exit(0)');return finish;});assert.equal(d.status,'attention');assert.equal(d.verificationStatus,'needs_review');
}));
test('code changed outside runtime after check is stale',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,()=>{writeFileSync(join(h.root,'src/value.txt'),'changed');return finish;},{...finish,outcome:'blocked'});assert.equal(d.status,'attention');assert.notEqual(d.verificationStatus,'verified');assert.equal(d.verification,null);assert(d.events.some(e=>e.kind==='completion_rejected'));
}));
test('timeout produces actual failed evidence and never automatically replays',()=>fixture(async h=>{
  const d=await h.approve(write('good'),check,check,finish);assert.equal(d.status,'attention');assert.equal(h.calls.filter(c=>c.tool==='run_command').length,1);assert(d.events.some(e=>e.kind==='verification_evidence'&&e.body.timedOut===true&&e.body.passed===false));assert.throws(()=>h.service.message(h.id,{content:'retry'}),/副作用结果尚未核对|检查原进程/);
},'setInterval(()=>{},1000)'));
test('unknown execution and spawn failure require explicit recovery, never inferred pass',()=>fixture(async h=>{
  const execute=h.deps.execute;h.deps.execute=(...a)=>a[1]==='run_command'?Promise.reject(Error('spawn failed')):execute(...a);
  const d=await h.approve(write('good'),check,check,finish);assert.equal(d.status,'attention');assert.equal(d.verificationStatus,'unknown');assert(d.events.some(e=>e.kind==='process_unknown'));assert.equal(d.checks[0].passed,false);
}));
test('stop during check persists aborted evidence and restart does not replay',()=>fixture(async h=>{
  const execute=h.deps.execute;h.deps.execute=async(...a)=>{if(a[1]==='run_command')setTimeout(()=>h.service.stop(h.id),50);return execute(...a);};
  const d=await h.approve(write('good'),check,finish);assert.notEqual(d.status,'completed');assert(d.events.some(e=>e.kind==='verification_evidence'&&e.body.aborted===true&&!e.body.passed));
  const count=h.calls.length;h.service=createAssistantLoop(h.deps);assert.equal(h.calls.length,count);assert.equal(h.service.details(h.id).verification,null);
},'setInterval(()=>{},1000)'));
test('approval binds hidden files and cannot authorize changed script closure',()=>fixture(async h=>{
  const d=await h.start(action('configure_verification',{checks:[{id:'unit',args:['check.cjs'],timeoutMs:1000}],writablePaths:['src']}));
  mkdirSync(join(h.root,'.tmp-new'));writeFileSync(join(h.root,'.tmp-new/helper.cjs'),'changed');await assert.rejects(()=>h.service.reply(h.id,{version:d.version,requestId:d.pending.id,approved:true}),/契约文件已变化/);assert.equal(h.calls.length,0);
}));
test('tool schemas match executor limits without relaxing safety',async()=>{
  const r=createToolRegistry();for(const name of ['verify','run_command']){for(const args of [{executable:'node',args:Array(41).fill('x')},{executable:'node',args:['x'.repeat(2001)]},{executable:'node',args:['\0']},{executable:'node',timeoutMs:99}])assert.throws(()=>r.validate(name,args));r.validate(name,{executable:'node',args:['x'],timeoutMs:100});}
  assert.throws(()=>r.validate('write_file',{path:'src/x',content:'x'.repeat(20001)}));
  await fixture(async h=>{assert.throws(()=>fileTool(h.root,'write_file',{path:'src/x',content:'x'.repeat(20001)}));const a={executable:'node',timeoutMs:5000};r.validate('run_command',a);const result=await commandTool(h.root,a,process.env,new AbortController().signal);assert.equal(result.exitCode,0,JSON.stringify(result));});
});
