import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {commandTool} from '../dist/src/assistant/assistant-tools.js';
import {inspectCommand,inspectCommandSync} from '../dist/src/execution/command-lifecycle.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'apix-command-life-'));
 writeFileSync(join(root,'worker.cjs'),`const fs=require('node:fs');fs.writeFileSync('owned.pid',String(process.pid));setInterval(()=>fs.appendFileSync('writes','x'),25);fs.writeFileSync('ready','yes');process.stdout.write('READY\\n');process.send?.('ready');`);
 writeFileSync(join(root,'parent.ps1'),`param([string]$Mode)\n$si=New-Object Diagnostics.ProcessStartInfo\n$si.FileName='${process.execPath.replaceAll("'","''")}'\n$si.Arguments='"${join(root,'worker.cjs').replaceAll("'","''")}"'\n$si.UseShellExecute=$false\n$si.RedirectStandardOutput=$true\n$si.RedirectStandardError=$true\n$si.CreateNoWindow=$true\n$p=[Diagnostics.Process]::Start($si)\nif($p.StandardOutput.ReadLine() -ne 'READY'){throw 'worker not ready'}\nif($Mode -eq 'exit'){exit 0}\n[Threading.Thread]::Sleep(60000)\n`);
 writeFileSync(join(root,'parent.cjs'),`const {spawn}=require('node:child_process');const child=spawn(process.execPath,[require('node:path').join(__dirname,'worker.cjs')],{cwd:__dirname,stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{${''}if(process.argv[2]==='exit')process.exit(0);});setInterval(()=>{},1000);`);
 const alive=()=>{if(!existsSync(join(root,'owned.pid')))return false;try{process.kill(Number(readFileSync(join(root,'owned.pid'),'utf8')),0);return true;}catch{return false;}};
 return {root,command:mode=>({executable:'powershell.exe',args:['-NoProfile','-NonInteractive','-File',join(root,'parent.ps1'),mode]}),alive,cleanup:()=>{let fallback=false;if(alive()){fallback=true;const pid=Number(readFileSync(join(root,'owned.pid'),'utf8'));if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p.CommandLine.Contains('${root.replaceAll("'","''")}')){Stop-Process -Id ${pid} -Force}`],{windowsHide:true});else process.kill(pid,'SIGKILL');}assert(resolve(root).startsWith(resolve(tmpdir())));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});return fallback;}};
}
function ready(root){return new Promise((resolve,reject)=>{const path=join(root,'ready');const done=()=>{if(existsSync(path)){clearTimeout(timer);watcher.close();resolve();}};const watcher=watch(root,done);const timer=setTimeout(()=>{watcher.close();reject(new Error('ready signal missing'));},12000);done();});}
test('parent exit zero with a writing descendant is not successful delivery',{timeout:25000},async()=>{
 const h=fixture();let fallback=false;try{const result=await commandTool(h.root,{...h.command('exit'),timeoutMs:10000},process.env,new AbortController().signal);assert.equal(result.executionComplete,false);assert.equal(result.sideEffectsNeedReview,true);assert.equal(result.processesEnded,true);assert.equal(h.alive(),false);}finally{fallback=h.cleanup();}assert.equal(fallback,false,'fixture fallback must not substitute for runtime termination');
});
test('cancel and repeated cancel confirm the entire owned job has stopped',{timeout:25000},async()=>{
 const h=fixture(),controller=new AbortController();try{const entered=ready(h.root);const resultPromise=commandTool(h.root,{...h.command('hold'),timeoutMs:10000},process.env,controller.signal);await entered;controller.abort();controller.abort();const result=await resultPromise;assert.equal(result.aborted,true);assert.equal(result.processesEnded,true);assert.equal(result.sideEffectsNeedReview,true);assert.equal(h.alive(),false);}finally{assert.equal(h.cleanup(),false,'fixture fallback fired');}
});
test('deadline terminates a real descendant and does not invent a zero exit',{timeout:25000},async()=>{
 const h=fixture();try{const result=await commandTool(h.root,{...h.command('hold'),timeoutMs:400},process.env,new AbortController().signal);assert.equal(existsSync(join(h.root,'ready')),true,'deadline case must enter the real descendant stage');assert.equal(result.timedOut,true);assert.equal(result.exitCode,null);assert.equal(result.processesEnded,true);assert.equal(result.executionComplete,false);assert.equal(result.sideEffectsNeedReview,true);assert.equal(h.alive(),false);}finally{assert.equal(h.cleanup(),false,'fixture fallback fired');}
});
test('wrong creation identity refuses termination rather than killing an unrelated PID',{timeout:25000},async()=>{
 const h=fixture(),controller=new AbortController();let resultPromise;try{let identity;const entered=ready(h.root);resultPromise=commandTool(h.root,{...h.command('hold'),timeoutMs:10000},process.env,controller.signal,()=>{},[],{identity:value=>identity=value});await entered;
 assert.equal(inspectCommandSync(identity),'active');assert.equal(await inspectCommand({...identity,ownerBirth:'wrong'},true),'unknown');assert.equal(h.alive(),true);
 controller.abort();assert.equal((await resultPromise).processesEnded,true);
 }finally{controller.abort();await resultPromise;assert.equal(h.cleanup(),false,'fixture fallback fired');}
});
for(const failure of ['refused','hung','kill_false','kill_throw'])test(`termination ${failure} is bounded and reports unknown, not safe completion`,{timeout:25000},async()=>{
 const h=fixture(),controller=new AbortController(),original=cp.spawn,closures=[];
 cp.spawn=(exe,args,options)=>{let child;
  if(args.includes('-Inspect'))child=original(exe,['-NoProfile','-NonInteractive','-Command',failure==='hung'?'Start-Sleep -Seconds 60':"[Console]::WriteLine('inspect|unknown')"],options);
  else{child=original(exe,args,options);if(failure==='kill_false')child.kill=()=>false;if(failure==='kill_throw')child.kill=()=>{throw new Error('termination denied');};}
  closures.push(new Promise(r=>child.once('close',r)));return child;
 };syncBuiltinESMExports();
 try{const entered=ready(h.root),started=Date.now();const promise=commandTool(h.root,{...h.command('hold'),timeoutMs:10000},process.env,controller.signal);await entered;controller.abort();const result=await promise;assert.equal(result.unknown,true);assert.equal(result.processesEnded,false);assert.equal(result.executionComplete,false);assert.equal(result.sideEffectsNeedReview,true);await Promise.all(closures);assert(Date.now()-started<15000);assert.equal(h.alive(),false);
 }finally{cp.spawn=original;syncBuiltinESMExports();assert.equal(h.cleanup(),false,'fixture fallback fired');}
});
test('aborted before launch creates no command process',{timeout:5000},async()=>{const h=fixture(),controller=new AbortController();controller.abort();try{await assert.rejects(commandTool(h.root,{...h.command('hold')},process.env,controller.signal),/停止/);assert.equal(existsSync(join(h.root,'ready')),false);}finally{assert.equal(h.cleanup(),false);}});

test('timeout and repeated stop race settles once and ignores late supervisor events',{timeout:25000},async()=>{
 const h=fixture(),controller=new AbortController(),original=cp.spawn;let supervisor,stopTimer;
 cp.spawn=(exe,args,options)=>{const child=original(exe,args,options);if(!args.includes('-Inspect'))supervisor=child;return child;};syncBuiltinESMExports();
 try{const entered=ready(h.root),promise=commandTool(h.root,{...h.command('hold'),timeoutMs:1000},process.env,controller.signal,()=>{},[],{identity:value=>{if(value.pid)stopTimer??=setTimeout(()=>{controller.abort();controller.abort();},1000);}});await entered;const result=await promise;assert(result.aborted||result.timedOut);assert.equal(result.processesEnded,true);assert.equal(result.executionComplete,false);const snapshot=JSON.stringify(result);supervisor.emit('close',0);supervisor.emit('error',new Error('late failure'));assert.equal(JSON.stringify(result),snapshot);assert.equal(h.alive(),false);
 }finally{clearTimeout(stopTimer);cp.spawn=original;syncBuiltinESMExports();controller.abort();assert.equal(h.cleanup(),false,'fixture fallback fired');}
});

test('nonexistent executable is a confirmed no-worker startup failure',{timeout:15000},async()=>{
 const h=fixture();try{const result=await commandTool(h.root,{executable:join(h.root,'missing.exe')},process.env,new AbortController().signal);assert.equal(result.reason,'start_failed');assert.equal(result.exitCode,null);assert.equal(result.processesEnded,true);assert.equal(result.executionComplete,false);assert.equal(result.sideEffectsNeedReview,false);}finally{assert.equal(h.cleanup(),false);}
});
