import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProjectIo,projectIo} from '../dist/src/projects/project-io.js';
import {executableOnPath} from '../src/infrastructure/executable.mjs';
import {git} from '../src/projects/git.mjs';
import {commandCapabilities} from '../dist/src/execution/command-capabilities.js';
import {createAssistantCoding} from '../dist/src/assistant/assistant-coding.js';

async function fixture(work){
  const dir=await mkdtemp(join(tmpdir(),'apix-project-io-'));
  try{const path=join(dir,'worker.mjs');await writeFile(path,"import {parentPort,threadId} from 'node:worker_threads';parentPort.on('message',({operation,args})=>{if(operation==='crash')process.exit(3);if(operation==='hold')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,args[0]);parentPort.postMessage({result:{threadId,value:args[0]}});});");await work(dir,pathToFileURL(path));}
  finally{assert(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('project IO bounds two workers and its queue while keeping the event loop responsive',()=>fixture(async(_dir,workerUrl)=>{
  const io=createProjectIo({workerUrl,timeoutMs:5000});let ticks=0;const timer=setInterval(()=>ticks++,10);
  try{const jobs=Array.from({length:34},()=>io('hold',[20])),all=Promise.all(jobs);await assert.rejects(io('hold',[1]),/繁忙/);const results=await all;assert.equal(new Set(results.map(r=>r.threadId)).size,2);assert(ticks>=5,'blocking worker work must leave main-thread timers running');}
  finally{clearInterval(timer);}
}));

test('project IO rejects a crashed or timed out worker and recovers without replay',()=>fixture(async(_dir,workerUrl)=>{
  const io=createProjectIo({workerUrl,timeoutMs:1000});await assert.rejects(io('crash',[]),/中断/);assert.equal((await io('echo',['next'])).value,'next');await assert.rejects(io('hold',[2200]),/超时/);assert.equal((await io('echo',['after-timeout'])).value,'after-timeout');
}));

test('production project IO preserves fingerprints and scan access boundaries',()=>fixture(async(dir)=>{
  await writeFile(join(dir,'a.txt'),'real scan');const result=await projectIo('sourceManifest',[dir]);assert(result.files.some(f=>f.path==='a.txt'));assert.equal((await projectIo('sourceManifest',[dir])).hash,result.hash);await assert.rejects(projectIo('arbitrary_module',[]),/未知/);await assert.rejects(projectIo('readProjectTool',[dir,'write_file',{path:'forbidden.txt',content:'no'}]),/只读/);await assert.rejects(readFile(join(dir,'forbidden.txt')),{code:'ENOENT'});
  assert.deepEqual((await projectIo('diagnoseNodeProject',[dir])).capabilities,commandCapabilities());
}));

test('executable lookup uses absolute PATH entries and preserves Windows exe preference',()=>fixture(async(dir)=>{
  const first=join(dir,'first'),second=join(dir,'second');await mkdir(first);await mkdir(second);const win=process.platform==='win32',name='apix-fixture-tool';
  await writeFile(join(first,name+(win?'.cmd':'')),'fixture');await writeFile(join(second,name+(win?'.exe':'')),'fixture');if(!win){await chmod(join(first,name),0o700);await chmod(join(second,name),0o700);}
  assert.equal(executableOnPath(name,{PATH:[first,second].join(delimiter)}),join(win?second:first,name+(win?'.exe':'')));assert.equal(executableOnPath(name,{PATH:'.'}),null);
}));

test('asynchronous file reads discard results after root changes or cancellation',()=>fixture(async(dir)=>{
  await writeFile(join(dir,'a.txt'),'read result');let root=dir;
  const coding=createAssistantCoding({rows:()=>[],db:{},now:()=>''},()=>root),session={id:'s',project_id:'p'};
  const moved=coding.execute(session,'read_file',{path:'a.txt'},new AbortController().signal);root=join(dir,'changed');await assert.rejects(moved,/路径变化/);
  root=dir;const controller=new AbortController(),cancelled=coding.execute(session,'read_file',{path:'a.txt'},controller.signal);controller.abort();await assert.rejects(cancelled,/已停止/);
  assert.match((await coding.execute(session,'read_file',{path:'a.txt'},new AbortController().signal)).content,/read result/);
}));

test('asynchronous Git bounds pending work, preserves errors and keeps timers running',()=>fixture(async(dir)=>{
  let ticks=0;const timer=setInterval(()=>ticks++,10);
  try{assert.match(await git(dir,['--version'],{stdio:['ignore','pipe','ignore']}),/^git version/);const jobs=Promise.all(Array.from({length:68},()=>git(dir,['--version'])));await assert.rejects(git(dir,['--version']),{code:'GIT_BUSY'});assert((await jobs).every(v=>v.startsWith('git version')));assert(ticks>0);await assert.rejects(git(dir,['status']),e=>!!e.stderr&&e.code!==0);}
  finally{clearInterval(timer);}
}));
