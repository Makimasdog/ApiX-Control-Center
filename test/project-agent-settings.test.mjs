import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {projectDirectory,browseFolders,sameProjectDirectory} from '../src/projects/project-folders.mjs';
import {executionArgs,inspectCodex,normalizeQuota} from '../dist/src/agents/agent-settings.js';
const fixture=resolve('test/fake-agent-settings.mjs');
test('folder browser and explicit creation validate absolute directories and preserve files',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'apix-folder-'));
  try{const sub=join(temp,'中文 空格');assert.throws(()=>projectDirectory(sub),/不存在/);assert(!existsSync(sub));assert.equal(projectDirectory(sub,true),realpathSync.native(sub));assert(sameProjectDirectory(sub,realpathSync.native(sub)));assert(!sameProjectDirectory(sub,join(temp,'missing')));assert.throws(()=>projectDirectory(''),/绝对路径/);assert.throws(()=>projectDirectory('relative',true),/绝对路径/);const file=join(temp,'file');await writeFile(file,'keep');assert.throws(()=>projectDirectory(file,true),/文件夹/);const list=browseFolders(temp);assert(list.directories.some(d=>d.path===realpathSync.native(sub)));assert(!list.directories.some(d=>d.path===file));}finally{await rm(temp,{recursive:true,force:true});}
});
test('model argv and automatic effort distinguish difficulty and runtime',()=>{
  const modelArgs=(_,model)=>model?['--model',model]:[];
  for(const [difficulty,effort] of [[1,'low'],[2,'low'],[3,'medium'],[4,'high'],[5,'high'],[null,'medium']])assert.deepEqual(executionArgs('codex',{model:'model name',reasoningEffort:'auto'},difficulty,modelArgs),['--model','model name','-c',`model_reasoning_effort="${effort}"`]);
  assert.deepEqual(executionArgs('claude',{model:''},null,modelArgs),[]);assert.throws(()=>executionArgs('claude',{model:'m',reasoningEffort:'auto'},3,modelArgs),/仅支持/);assert.throws(()=>executionArgs('codex',{model:'m',reasoningEffort:'invalid'},3,modelArgs),/无效/);
});
test('quota remains unknown when absent, zero means exhausted, and all windows survive',()=>{
  assert.equal(normalizeQuota({}).state,'unknown');assert.equal(normalizeQuota({rateLimits:{primary:{usedPercent:100}}}).windows[0].remainingPercent,0);assert.equal(normalizeQuota({rateLimits:{primary:{usedPercent:null}}}).state,'unknown');
});
test('Codex query uses read-only RPC with independent model catalog and bounded timeout',async()=>{
  const info=await inspectCodex({executable:process.execPath,prefix:[fixture]},process.env);
  assert.equal(info.quota.state,'known');assert.deepEqual(info.quota.windows.map(w=>w.remainingPercent),[77,55]);assert.equal(info.models[0].name,'测试模型');
  await assert.rejects(inspectCodex({executable:process.execPath,prefix:['-e','setTimeout(()=>{},10000)']},process.env,80),/超时/);
});
async function freePort(){return await new Promise(resolvePort=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolvePort(port));});});}
async function waitFor(check){for(let i=0;i<200;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out');}
test('HTTP project creation, employee settings, runtime quota, UTF-8 JSONL and stderr end to end',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'apix-settings-http-'));const port=await freePort();let server;let errors='';const base=`http://127.0.0.1:${port}`;
  const get=async path=>{const r=await fetch(base+path);return await r.json();};
  const post=async(path,body,status=200)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;};
  try{
    server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),APIX_DATA_DIR:join(temp,'db'),APIX_LEGACY_API:'1',APIX_CODEX_ENTRY:fixture},stdio:['ignore','ignore','pipe']});server.stderr.on('data',c=>errors+=c);
    await waitFor(async()=>{try{return (await fetch(base+'/api/snapshot')).ok;}catch{return false;}});
    const path=join(temp,'新项目');await post('/api/projects',{name:'测试项目',path},400);assert(!existsSync(path));const project=await post('/api/projects',{name:'测试项目',path,createDirectory:true});
    const duplicate=await post('/api/projects',{name:'重复项目',path},400);assert.match(duplicate.error,/已添加/);
    const streamed=await new Promise((resolveResponse,reject)=>{
      const req=request(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'}},response=>{let raw='';response.setEncoding('utf8');response.on('data',c=>raw+=c);response.on('end',()=>resolveResponse({status:response.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);
      void(async()=>{for(const byte of Buffer.from(JSON.stringify({name:'分块请求中文项目',path:join(temp,'字节请求项目'),createDirectory:true}))){req.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}req.end();})().catch(reject);
    });assert.equal(streamed.status,200,JSON.stringify(streamed.body));assert.equal((await get('/api/snapshot')).projects.find(p=>p.id===streamed.body.id).name,'分块请求中文项目');
    const folders=await get(`/api/project-folders?path=${encodeURIComponent(temp)}`);assert(folders.directories.some(d=>d.name==='新项目'));
    const employee=await post('/api/employees',{name:'测试员工',runtime:'codex',role:'编程'});
    await post(`/api/employees/${employee.id}/capabilities`,{version:0,model:'fixture-model',reasoningEffort:'auto'});
    await post(`/api/employees/${employee.id}/capabilities`,{version:1,model:'fixture-model'});
    await post(`/api/employees/${employee.id}/capabilities`,{version:2,model:'fixture-model',reasoningEffort:'invalid'},400);
    const details=await get(`/api/employees/${employee.id}/details`);assert.equal(details.capability.reasoningEffort,'auto');
    const info=await post(`/api/employees/${employee.id}/runtime-info`,{});assert.equal(info.quota.windows[0].remainingPercent,77);
    await post('/api/scheduling/accounts',{id:'api-budget',alias:'API 预算',type:'api',currency:'CNY',limitMinor:10000,version:0});
    const updated=await get(`/api/employees/${employee.id}/details`);assert.equal(updated.accounts[0].budgetRemainingMinor,10000);assert.equal(updated.accounts[0].remainingPercent,null);
    const ledger=new DatabaseSync(join(temp,'db','apix.sqlite'));try{ledger.prepare("INSERT INTO scheduling_reservations VALUES (?,?,?,NULL,'CNY','unmeasured',NULL,?)").run('unknown-fee',project.id,'api-budget',new Date().toISOString());}finally{ledger.close();}
    const unknown=await get(`/api/employees/${employee.id}/details`);assert.equal(unknown.accounts[0].budgetRemainingMinor,null);assert.equal(unknown.accounts[0].unknownCount,1);
    const task=await post('/api/tasks',{projectId:project.id,employeeId:employee.id,prompt:'输出中文报告'});
    await post(`/api/approvals/${task.approvalId}`,{approved:true});
    const done=await waitFor(async()=>{const s=await get('/api/snapshot');const t=s.tasks.find(t=>t.id===task.taskId);return t?.status==='completed'?t:null;});
    assert.match(done.result,/员工报告：中文完整，已完成 R1-R3；检查 fit 边界/);assert(!done.result.includes('�'));assert.match(done.result,/"pythonUTF8":"1"/);
    const run=await get(`/api/tasks/${task.taskId}/details`);const args=run.events.find(e=>e.kind==='run_started').payload.executionArgs;assert(args.includes('fixture-model'));assert(args.includes('model_reasoning_effort="medium"'));
    assert.equal(run.events.filter(e=>e.kind==='stderr').map(e=>e.payload.text).join(''),'中文标准错误完整');assert(!run.events.some(e=>e.kind==='unparsed_stdout'));assert(run.events.some(e=>e.kind==='turn.completed'));
    const denied=await fetch(base+'/api/project-folders',{headers:{Origin:'https://attacker.invalid'}});assert.equal(denied.status,403);
    const alias=await new Promise((resolveStatus,reject)=>{const req=request(base+`/api/project-folders?path=${encodeURIComponent(temp)}`,{headers:{Host:`localhost:${port}`,Origin:`http://localhost:${port}`}},response=>{response.resume();resolveStatus(response.statusCode);});req.on('error',reject);req.end();});assert.equal(alias,200);
    const crossHost=await fetch(base+'/api/project-folders',{headers:{Origin:`http://localhost:${port}`}});assert.equal(crossHost.status,403);
  }catch(e){throw new Error(e.message+'\n'+errors,{cause:e});}finally{if(server){server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));}await rm(temp,{recursive:true,force:true});}
});
