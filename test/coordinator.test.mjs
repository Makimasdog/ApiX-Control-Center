import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createTaskScheduler } from '../src/task-scheduler.mjs';
import { createRuntimeAdapters } from '../dist/src/runtime-adapters.js';
import { BUILTIN_PROVIDERS } from '../dist/src/model-providers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('Windows npm shims resolve package bin entries without a shell', {skip:process.platform!=='win32'}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'apix-shims-'));
  const db=new DatabaseSync(':memory:');
  try {
    for(const [runtime,packageName,entry] of [['gemini','@google/gemini-cli','bundle/gemini.js'],['opencode','opencode-ai','bin/opencode.exe']]) {
      const packageDir=join(dir,'node_modules',packageName);
      await mkdir(dirname(join(packageDir,entry)),{recursive:true});
      await writeFile(join(packageDir,'package.json'),JSON.stringify({bin:{[runtime]:entry}}));
      await writeFile(join(packageDir,entry),'fixture');
      await writeFile(join(dir,`${runtime}.cmd`),'fixture');
    }
    const row=(sql,...params)=>db.prepare(sql).get(...params);
    const rows=(sql,...params)=>db.prepare(sql).all(...params);
    const adapters=createRuntimeAdapters({db,row,rows,now:()=>new Date().toISOString()},name=>['gemini','opencode'].includes(name)?join(dir,`${name}.cmd`):null);
    assert.equal(adapters.command('gemini').executable,process.execPath);
    assert.equal(adapters.command('gemini').prefix[0],join(dir,'node_modules','@google','gemini-cli','bundle','gemini.js'));
    assert.equal(adapters.command('opencode').executable,join(dir,'node_modules','opencode-ai','bin','opencode.exe'));
    assert.equal(adapters.command('kimi'),null);
    assert.equal(adapters.catalog().find(item=>item.id==='kimi').available,false);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate) {
  for(let i=0;i<150;i++){ const result=await predicate(); if(result)return result; await delay(60); }
  throw new Error('Timed out');
}
async function harness(work, extraEnv={}) {
  const dir=await mkdtemp(join(tmpdir(),'apix-coordinator-'));
  const project=join(dir,'project');
  execFileSync('git',['init',project],{stdio:'ignore'});
  await writeFile(join(project,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:project});
  execFileSync('git',['-c','user.name=ApiX Test','-c','user.email=test@example.invalid','commit','-m','fixture'],{cwd:project,stdio:'ignore'});
  const port=await new Promise(resolvePort=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolvePort(p));});});
  let server; let errors='';
  const env={...process.env,APIX_LEGACY_API:'0',APIX_DATA_DIR:join(dir,'data'),PORT:String(port),APIX_PI_ENTRY:join(root,'test/fake-pi.mjs'),APIX_CODEX_ENTRY:join(root,'test/fake-codex.mjs'),APIX_CLAUDE_ENTRY:join(root,'test/fake-claude.mjs'),...extraEnv};
  const request=async(path,body,expected=200,headers={})=>{
    const res=await fetch(`http://127.0.0.1:${port}${path}`,body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const json=await res.json();assert.equal(res.status,expected,JSON.stringify(json));return json;
  };
  const start=async()=>{
    server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env,stdio:['ignore','ignore','pipe']});
    server.stderr.on('data',c=>errors+=c);
    await waitFor(async()=>{if(server.exitCode!==null)throw new Error(errors);try{return(await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok;}catch{return false;}});
  };
  const stop=async()=>{if(server?.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r));}};
  try {await start(); await work({request,project,dir,origin:`http://127.0.0.1:${port}`,restart:async()=>{await stop();await start();}});}
  finally {await stop();await rm(dir,{recursive:true,force:true});}
}
const answers={scope:'仅检查当前项目',constraints:'保持现有功能',deliverable:'代码检查报告',acceptance:'列出可复现的验证证据'};
test('manager tools follow project permission, use project cwd and stream audited activity',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'工具验收',path:h.project})).id;
  for(const [mode,expected] of [['ask_approval',[]],['read_only',['read','grep','find','ls']],['full_access',['read','bash','edit','write','grep','find','ls']]]){
    const policy=(await h.request(`/api/projects/${projectId}/workflow`)).manager;
    await h.request('/api/permissions',{projectId,subject:'apix',mode,version:policy.version});
    const s=await h.request('/api/coordination/sessions',{projectId,goal:'测试工具'});
    const res=await fetch(`${h.origin}/api/coordination/sessions/${s.id}/messages/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:s.revision,content:'fixture-manager-tools'})});
    const stream=await res.text();assert.match(stream,/event: complete/);assert.doesNotMatch(stream,/event: error/);
    const details=await h.request(`/api/coordination/sessions/${s.id}`);
    assert.match(details.turns.at(-1).content,new RegExp(expected.length?expected.join(','):'无'));
    assert.equal(details.managerTools.length,expected.length?2:0);
    if(expected.length)assert.match(stream,/event: tool/);
    if(mode!=='full_access')await assert.rejects(readFile(join(h.project,'manager-tool-fixture.txt')));
  }
  assert.equal(await readFile(join(h.project,'manager-tool-fixture.txt'),'utf8'),'manager write fixture');
}));

test('manager aborts tool-enabled inference when project permission is revoked',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'撤销工具',path:h.project})).id;
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'full_access',version:0});
  const s=await h.request('/api/coordination/sessions',{projectId,goal:'测试撤销'});
  const pending=h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'fixture-manager-wait'});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.busy;});
  await delay(300);
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'read_only',version:1});
  const result=await pending;assert.equal(result.agent.mode,'rules');assert.match(result.agent.error,/权限已变化/);assert.equal(result.plan_id,null);
}));

test('explicit work creates a real review plan without automatic authorization',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'待审计划',path:h.project})).id;
  await h.request('/api/employees',{name:'员工',runtime:'pi',role:'开发'});
  let s=await h.request('/api/coordination/sessions',{projectId,goal:'开始工作：安排项目检查'});
  s=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'开始工作：安排项目检查'});
  assert.equal(s.status,'plan_review');assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].status,'awaiting_approval');
  assert.equal((await h.request('/api/snapshot')).runs.length,0);
  assert.equal(s.policy.mode,'ask_approval');assert.equal(s.workflow.enabled,false);
}));

test('natural language after manager tools is formatted without replaying tools before dispatch',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'工具后结构化',path:h.project})).id;
  const employeeId=(await h.request('/api/employees',{name:'员工',runtime:'pi',role:'开发'})).id;
  await h.request(`/api/projects/${projectId}/workflow`,{version:0,enabled:true,approved:true,managerVersion:0,employees:[{id:employeeId,version:0}]});
  let s=await h.request('/api/coordination/sessions',{projectId,goal:'开始工作：安排检查'});
  s=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'开始工作：安排检查'});
  assert.equal(s.agent.mode,'pi');assert.equal(s.status,'running');assert.equal(s.tasks.length,1);
  assert.deepEqual(s.managerTools,[{toolName:'read',phase:'start'},{toolName:'read',phase:'end',isError:false}]);
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
},{APIX_FIXTURE_NON_JSON_AFTER_TOOLS:'1'}));

test('project workflow turns one work message into an approved run and keeps questions and acceptance separate',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'自动工作区',path:h.project})).id;
  const employeeId=(await h.request('/api/employees',{name:'工作员工',runtime:'pi',role:'开发'})).id;
  let w=await h.request(`/api/projects/${projectId}/workflow`);
  await h.request(`/api/projects/${projectId}/workflow`,{version:0,enabled:true,employees:[{id:employeeId,version:0}],managerVersion:0},400);
  assert.equal((await h.request(`/api/projects/${projectId}/workflow`)).manager.mode,'ask_approval');
  w=await h.request(`/api/projects/${projectId}/workflow`,{version:0,enabled:true,approved:true,employees:[{id:employeeId,version:0}],managerVersion:0});
  let question=await h.request('/api/coordination/sessions',{projectId,goal:'解释项目'});
  question=await h.request(`/api/coordination/sessions/${question.id}/messages`,{revision:question.revision,content:'这个项目是做什么的？'});
  assert.equal(question.plan_id,null);assert.equal((await h.request('/api/snapshot')).runs.length,0);
  await h.request(`/api/coordination/sessions/${question.id}/stop`,{revision:question.revision},400);
  let s=await h.request('/api/coordination/sessions',{projectId,goal:'开始工作：检查项目'});
  s=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'开始工作：检查项目'});
  assert.equal(s.status,'running');assert.equal(s.assessment.ready,true);assert.match(s.requirements.scope,/自动工作区/);
  s=await waitFor(async()=>{const d=await h.request(`/api/coordination/sessions/${s.id}`);return d.tasks[0].status==='completed'&&d;});
  assert.equal(s.derivedStatus,'awaiting_acceptance');assert.notEqual(s.tasks[0].status,'accepted');
  await h.restart();assert.equal((await h.request(`/api/projects/${projectId}/workflow`)).enabled,true);
  await h.request(`/api/projects/${projectId}/workflow`,{version:w.version,enabled:false});
  const another=await h.request('/api/coordination/sessions',{projectId,goal:'新的任务'});
  const blocked=await h.request(`/api/coordination/sessions/${another.id}/messages`,{revision:another.revision,content:'开始工作：检查项目'});
  assert.equal(blocked.status,'plan_review');assert.ok(blocked.plan_id);
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
},{APIX_FIXTURE_MODERN_PI:'1'}));
test('automatic work respects strict fee approval and stop cancels queued work before releasing slots',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'预算与停止',path:h.project})).id;
  const employeeId=(await h.request('/api/employees',{name:'员工',runtime:'pi',role:'开发'})).id;
  await h.request(`/api/projects/${projectId}/workflow`,{version:0,enabled:true,approved:true,employees:[{id:employeeId,version:0}],managerVersion:0});
  await h.request(`/api/projects/${projectId}/execution`,{version:0,paused:true});
  let s=await h.request('/api/coordination/sessions',{projectId,goal:'开始工作：检查项目'});
  s=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'开始工作：检查项目'});
  assert.equal(s.tasks[0].status,'queued');
  await h.request(`/api/projects/${projectId}/workflow`,{version:1,enabled:true,approved:true,employees:[{id:employeeId,version:1}],managerVersion:1},400);
  s=await h.request(`/api/coordination/sessions/${s.id}/stop`,{revision:s.revision});assert.equal(s.status,'cancelled');assert.equal(s.tasks[0].status,'cancelled');
  await h.request(`/api/projects/${projectId}/execution`,{version:1,paused:false});assert.equal((await h.request('/api/snapshot')).runs.length,0);
  await h.request('/api/scheduling/accounts',{id:'api',alias:'收费账户',type:'api',currency:'USD',version:0});
  await h.request(`/api/employees/${employeeId}/capabilities`,{version:0,accountId:'api'});
  await h.request(`/api/projects/${projectId}/scheduling`,{version:0,requireFreshQuota:false,limitMinor:100,currency:'USD',managerAccountId:'api',managerEstimateMinor:1});
  s=await h.request('/api/coordination/sessions',{projectId,goal:'开始工作：检查项目'});
  s=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'开始工作：检查项目'});
  assert.equal(s.status,'plan_review');assert.equal((await h.request('/api/snapshot')).runs.length,0);
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:s.planVersion},400);
  await h.request('/api/permissions',{projectId,subject:employeeId,version:1,mode:'read_only'});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:s.planVersion},400);
}));
test('revoking automatic work while a plan is being generated prevents dispatch',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'撤回授权',path:h.project})).id;
  const employeeId=(await h.request('/api/employees',{name:'员工',runtime:'pi',role:'开发'})).id;
  await h.request(`/api/projects/${projectId}/workflow`,{version:0,enabled:true,approved:true,employees:[{id:employeeId,version:0}],managerVersion:0});
  const s=await h.request('/api/coordination/sessions',{projectId,goal:'开始工作：检查项目'});
  const pending=h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'开始工作：检查项目'});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.busy && state.status==='ready';});
  await h.request(`/api/projects/${projectId}/workflow`,{version:1,enabled:false});
  const result=await pending;assert.equal(result.plan_id,null);assert.equal((await h.request('/api/snapshot')).runs.length,0);assert(result.turns.some(t=>t.kind==='workflow_blocked'));
},{APIX_FIXTURE_PLAN_DELAY_MS:'1500'}));
test('custom manager uses an environment key reference and accepts Pi agent_end',async()=>harness(async h=>{
  await h.request('/api/manager/settings',{baseUrl:'https://example.invalid/v1',model:'fixture-model',apiType:'openai-completions',apiKeyEnv:'APIX_TEST_MANAGER_KEY'});
  const {s}=await setup(h);
  assert.equal(s.agent.mode,'pi');assert.equal(s.agent.error,null);
  const models=JSON.parse(await readFile(join(h.dir,'data','manager-pi','models.json'),'utf8'));
  assert.equal(models.providers['apix-custom'].apiKey,'APIX_TEST_MANAGER_KEY');
  assert(!JSON.stringify(models).includes('fixture-secret-value'));
  const plan=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  assert.equal(plan.agent.mode,'pi');assert.equal(plan.status,'plan_review');
},{APIX_FIXTURE_MODERN_PI:'1',APIX_TEST_MANAGER_KEY:'fixture-secret-value'}));
test('planning meetings isolate participants, record disagreements and require a new plan approval',async()=>harness(async h=>{
  const {projectId,employeeId,s}=await setup(h);const second=(await h.request('/api/employees',{name:'第二参与者',runtime:'claude',role:'验证'})).id;
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  const original=p.planVersion;
  await h.request(`/api/coordination/sessions/${s.id}/planning-meetings`,{revision:p.revision,planVersion:p.planVersion,participants:[{employeeId}]},400);
  p=await h.request(`/api/coordination/sessions/${s.id}/planning-meetings`,{revision:p.revision,planVersion:p.planVersion,approved:true,participants:[{employeeId},{employeeId:second}]});
  assert.equal(p.status,'plan_review');assert.equal((await h.request('/api/snapshot')).runs.length,0);
  const meeting=p.planningMeetings.at(-1);assert.equal(meeting.status,'completed');assert.equal(meeting.body.proposals.length,2);assert.equal(meeting.body.disagreements.length,1);
  assert.match(meeting.body.proposals[0].claims[0].reason,/isolated identity/);
  await h.request(`/api/coordination/sessions/${s.id}/planning-meetings`,{revision:p.revision,planVersion:p.planVersion,approved:true,participants:[{employeeId}]},400);
  p=await h.request(`/api/coordination/sessions/${s.id}/planning-meetings`,{revision:p.revision,planVersion:p.planVersion,approved:true,previousId:meeting.id,participants:[{employeeId}]});
  assert.equal(p.planningMeetings.at(-1).round,2);
  p=await h.request(`/api/coordination/sessions/${s.id}/planning-meetings/apply`,{revision:p.revision,planVersion:p.planVersion,meetingId:p.planningMeetings.at(-1).id});
  assert.notEqual(p.planVersion,original);assert.equal(p.status,'plan_review');
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:original},400);
  assert.equal((await h.request('/api/snapshot')).runs.length,0);
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.tasks[0].status==='completed';});
}));
test('shared budgets gate real dispatch and quota snapshots bind approved plans',async()=>harness(async h=>{
  const {projectId,employeeId,s}=await setup(h);
  await h.request('/api/scheduling/accounts',{id:'shared-api',alias:'测试 API 账户',type:'api',currency:'USD',limitMinor:100,remainingPercent:90,observedAt:new Date().toISOString(),version:0});
  await h.request(`/api/employees/${employeeId}/capabilities`,{version:0,model:'test-model',tags:['review'],tools:['git'],accountId:'shared-api'});
  await h.request(`/api/projects/${projectId}/scheduling`,{version:0,requireFreshQuota:false,limitMinor:100,currency:'USD',managerAccountId:'shared-api',managerEstimateMinor:5});
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion},400);
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[{prompt:'fixture work',employeeId,dependsOn:[],scheduling:{kind:'review',tags:['review'],tools:['git'],estimateMinor:60}}]});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  p=await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.tasks[0].status==='completed' && state;});
  const budget=await h.request(`/api/projects/${projectId}/scheduling`);assert.equal(budget.committedMinor,65);assert.equal(budget.ledger[0].state,'unmeasured');
  await h.request(`/api/projects/${projectId}/scheduling/settle`,{id:budget.ledger[0].id,actualMinor:15,reviewed:true});
  assert.equal((await h.request(`/api/projects/${projectId}/scheduling`)).committedMinor,20);
  const changed=await h.request(`/api/employees/${employeeId}/capabilities`,{version:1,model:'changed-model',accountId:'shared-api'});assert.equal(changed.version,2);
}));
test('queued reassignment requires fresh inspection and respects paused execution slots',async()=>harness(async h=>{
  const {projectId,employeeId,s}=await setup(h);const replacement=(await h.request('/api/employees',{name:'替代员工',runtime:'claude',role:'开发'})).id;
  await h.request(`/api/projects/${projectId}/execution`,{version:0,paused:true});
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});assert.equal(p.tasks[0].status,'queued');
  const task=p.tasks[0].id;const checked=await h.request(`/api/tasks/${task}/delivery`);assert.ok(checked.recoveryFingerprint);assert.equal(checked.workspacePath,null);
  await h.request(`/api/tasks/${task}/recovery`,{revision:p.revision,runId:null,fingerprint:'stale',reviewed:true,employeeId:replacement},400);
  const result=await h.request(`/api/tasks/${task}/recovery`,{revision:p.revision,runId:null,fingerprint:checked.recoveryFingerprint,reviewed:true,employeeId:replacement});
  assert.equal(result.session.tasks[0].employee_id,replacement);assert.equal(result.session.tasks[0].status,'queued');assert.equal((await h.request('/api/snapshot')).runs.length,0);
  await h.request(`/api/tasks/${task}/recovery`,{revision:p.revision,runId:null,fingerprint:checked.recoveryFingerprint,reviewed:true,employeeId},400);
  await h.request(`/api/projects/${projectId}/execution`,{version:1,paused:false});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.tasks[0].status==='completed';});
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
}));
test('read-only ApiX can draft a plan but cannot launch consultation or execution workers',async()=>harness(async h=>{
  const {projectId,employeeId,s}=await setup(h);await h.request('/api/permissions',{projectId,subject:'apix',mode:'read_only',version:0});
  const p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});assert.equal(p.status,'plan_review');
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion},400);
  await h.request(`/api/coordination/sessions/${s.id}/planning-meetings`,{revision:p.revision,planVersion:p.planVersion,approved:true,participants:[{employeeId}]},400);
  assert.equal((await h.request('/api/snapshot')).runs.length,0);
}));
test('a manager quota failure pauses its shared account before any fallback work can launch',async()=>harness(async h=>{
  const {projectId,employeeId,s}=await setup(h);
  await h.request('/api/scheduling/accounts',{id:'shared',alias:'manager and workers',type:'api',currency:'USD',limitMinor:100,remainingPercent:90,observedAt:new Date().toISOString(),version:0});
  await h.request(`/api/employees/${employeeId}/capabilities`,{version:0,accountId:'shared'});
  await h.request(`/api/projects/${projectId}/scheduling`,{version:0,requireFreshQuota:false,managerAccountId:'shared',managerEstimateMinor:5});
  await h.request('/api/manager/settings',{provider:'test-provider',model:'fixture-manager-quota'});
  await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision},400);
  const budget=await h.request(`/api/projects/${projectId}/scheduling`);assert.ok(budget.accounts[0].pause);assert.equal(budget.committedMinor,5);assert.equal((await h.request('/api/snapshot')).runs.length,0);
}));
async function* streamFrames(response) {
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  try {
    while(true) {
      const {done,value}=await reader.read();buffer+=decoder.decode(value??new Uint8Array(),{stream:!done});
      let index;
      while((index=buffer.indexOf('\n\n'))>=0) {
        const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);
        const type=frame.match(/^event: (.+)$/m)?.[1];const data=frame.match(/^data: (.+)$/m)?.[1];
        if(type&&data) yield {type,data:JSON.parse(data)};
      }
      if(done)break;
    }
  } finally {reader.releaseLock();}
}
function streamRequest(h,s,content) {
  return fetch(`${h.origin}/api/coordination/sessions/${s.id}/messages/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:s.revision,content})});
}
async function setup(h,runtime='pi') {
  const projectId=(await h.request('/api/projects',{name:'协调系统',path:h.project})).id;
  const employeeId=(await h.request('/api/employees',{name:'执行员工',runtime,role:'开发与验证'})).id;
  let s=await h.request('/api/coordination/sessions',{projectId,goal:'检查项目并汇总发现'});
  s=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:JSON.stringify(answers)});
  return {projectId,employeeId,s};
}
test('ApiX requires complete confirmed requirements; approvals, independent memory and replay survive restart',async()=>harness(async h=>{
  const {projectId,s}=await setup(h);
  assert.equal(s.agent.name,'ApiX');assert.equal(s.agent.foundation,'Pi');assert.equal(s.assessment.ready,true);
  await h.request('/api/tasks',{projectId,prompt:'bypass'},409);
  const incomplete=await h.request('/api/coordination/sessions',{projectId,goal:'另一个目标'});
  await h.request(`/api/coordination/sessions/${incomplete.id}/confirm`,{revision:1},400);
  await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:1},400);
  let plan=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  assert.equal(plan.status,'plan_review');assert.equal((await h.request('/api/snapshot')).runs.length,0);
  const approval=(await h.request('/api/snapshot')).approvals.find(a=>a.task_id===plan.tasks[0].id);
  await h.request(`/api/approvals/${approval.id}`,{approved:true},400);
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'read_only',version:0});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:plan.planVersion},400);
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'ask_approval',version:1});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:plan.planVersion});
  plan=await waitFor(async()=>{const p=await h.request(`/api/coordination/sessions/${s.id}`);return p.derivedStatus==='awaiting_acceptance'&&p;});
  const discussed=await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:plan.revision,content:'fixture-progress-state'});
  const progress=JSON.parse(discussed.turns.at(-1).content);
  assert.equal(progress.status,'awaiting_acceptance');
  assert.equal(progress.tasks[0].status,'completed');
  assert.equal(progress.progress[0].taskId,plan.tasks[0].id);
  assert.deepEqual(progress.dependencies,[]); assert.deepEqual(progress.guidance,[]);
  assert.equal(discussed.revision,plan.revision,'progress must not change confirmed requirements');
  await h.request(`/api/tasks/${plan.tasks[0].id}/review`,{accepted:true});
  const timeline=await h.request(`/api/coordination/sessions/${s.id}/timeline`);
  assert(timeline.events.some(e=>e.kind==='artifact.collected'));
  assert(timeline.events.some(e=>e.kind==='message.created'));
  const first=timeline.events.find(e=>e.kind==='coordination.snapshot');
  const past=await h.request(`/api/coordination/sessions/${s.id}/timeline?at=${first.sequence}`);
  assert.equal(past.state.revision,1);assert.equal(past.state.tasks.length,0);
  assert((await h.request(`/api/coordination/memory?projectId=${projectId}&q=${encodeURIComponent('代码检查报告')}`)).length);
  await h.restart();
  assert.equal((await h.request(`/api/coordination/sessions/${s.id}`)).derivedStatus,'completed');
  assert.equal((await h.request(`/api/coordination/sessions?projectId=${projectId}`)).length,2);
  const summaries=await h.request(`/api/coordination/sessions?projectId=${projectId}&summary=1`);
  assert.equal(summaries.length,2);assert.equal(summaries.find(x=>x.id===s.id).derivedStatus,'completed');
  for(const summary of summaries)for(const key of ['turns','instructions','requirements','capabilities','tasks'])assert.equal(key in summary,false,key);
  const firstSnapshot=await fetch(h.origin+'/api/snapshot');const etag=firstSnapshot.headers.get('etag');assert.ok(etag);await firstSnapshot.json();
  const unchanged=await fetch(h.origin+'/api/snapshot',{headers:{'If-None-Match':etag}});
  assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
  await h.request(`/api/projects/${projectId}/execution`,{version:0,paused:true});
  const changed=await fetch(h.origin+'/api/snapshot',{headers:{'If-None-Match':etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);await changed.json();
}));
test('full access requires explicit worker permission; automatic dispatch and permission revocation are enforced',async()=>harness(async h=>{
  const {projectId,employeeId,s}=await setup(h);
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'full_access',version:0});
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  assert.equal(p.status,'plan_review','worker does not inherit full access');
  p=await h.request(`/api/coordination/sessions/${s.id}/revise`,{revision:p.revision,reason:'使用已授权员工'});
  await h.request('/api/permissions',{projectId,subject:employeeId,mode:'full_access',version:0});
  p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:p.revision});
  assert.equal(p.status,'running');
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'read_only',version:1});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.tasks.every(t=>t.status==='cancelled');});
  await h.request('/api/permissions',{projectId,subject:'apix',mode:'full_access',version:1},400);
},{APIX_FIXTURE_HOLD:'1'}));
test('plan edits create a new immutable plan; model config is persisted; Claude adapter returns artifacts',async()=>harness(async h=>{
  const {s}=await setup(h,'claude');
  await h.request('/api/manager/settings',{provider:'test-provider',model:'test-model'});
  assert.equal((await h.request('/api/manager/settings')).model,'test-model');
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});const oldPlan=p.plan_id;
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[{prompt:'verify changed plan',employeeId:p.tasks[0].employee_id,dependsOn:[]}]});
  assert.notEqual(p.plan_id,oldPlan);
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).derivedStatus==='awaiting_acceptance');
  assert((await h.request('/api/snapshot')).artifacts.some(a=>a.content.includes('Claude result')));
}));
test('interaction modes, conversation SSE and custom Pi endpoint persist across restart',async()=>harness(async h=>{
  const projectId=(await h.request('/api/projects',{name:'模式测试',path:h.project})).id;
  let s=await h.request('/api/coordination/sessions',{projectId,goal:'梳理新功能',interactionMode:'structured'});
  assert.equal(s.interaction_mode,'structured');
  assert.match(s.turns.at(-1).content,/范围与边界/);
  const response=await fetch(`${h.origin}/api/coordination/sessions/${s.id}/messages/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:s.revision,content:'请先确认范围'})});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const frames=(await response.text()).split('\n\n').filter(Boolean);
  assert(frames.some(frame=>frame.startsWith('event: delta\n')));
  const completed=frames.find(frame=>frame.startsWith('event: complete\n'));
  assert(completed);s=JSON.parse(completed.split('data: ')[1]);
  assert.equal(s.interaction_mode,'structured');assert(s.turns.some(turn=>turn.role==='apix'&&turn.content.includes('约束')));
  const changed=await h.request(`/api/coordination/sessions/${s.id}/mode`,{revision:s.revision,mode:'conversational'});
  assert.equal(changed.interaction_mode,'conversational');assert.equal(changed.revision,s.revision+1);
  await h.request(`/api/coordination/sessions/${s.id}/mode`,{revision:changed.revision,mode:'invalid'},400);
  const settings=await h.request('/api/manager/settings',{model:'qwen-test',baseUrl:'http://127.0.0.1:11434/v1',apiType:'openai-completions',apiKeyEnv:''});
  assert.equal(settings.provider,'apix-custom');assert.equal(settings.baseUrl,'http://127.0.0.1:11434/v1');
  const conversation=await fetch(`${h.origin}/api/coordination/sessions/${s.id}/messages/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:changed.revision,content:'继续澄清'})});
  const conversationFrames=(await conversation.text()).split('\n\n').filter(Boolean);
  assert.equal(conversation.status,200);
  assert(conversationFrames.some(frame=>frame.startsWith('event: delta\n')));
  const conversationComplete=conversationFrames.find(frame=>frame.startsWith('event: complete\n'));
  assert(conversationComplete);
  assert.equal(JSON.parse(conversationComplete.split('data: ')[1]).interaction_mode,'conversational');
  const generated=JSON.parse(await readFile(join(h.dir,'data','manager-pi','models.json'),'utf8'));
  assert.equal(generated.providers['apix-custom'].baseUrl,settings.baseUrl);
  assert.equal(generated.providers['apix-custom'].models[0].id,'qwen-test');
  await h.restart();
  assert.equal((await h.request(`/api/coordination/sessions/${s.id}`)).interaction_mode,'conversational');
  assert.equal((await h.request('/api/manager/settings')).baseUrl,settings.baseUrl);
},{APIX_FIXTURE_STREAM:'1'}));
test('employee details combine task history, progress and measured runtime usage',async()=>harness(async h=>{
  const {employeeId,s}=await setup(h,'codex');
  const plan=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:plan.planVersion});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).derivedStatus==='awaiting_acceptance');
  const details=await h.request(`/api/employees/${employeeId}/details`);
  assert.equal(details.employee.id,employeeId);
  assert.equal(details.tasks.length,1);assert.equal(details.runs.length,1);
  assert.equal(details.usage.inputTokens,120);assert.equal(details.usage.outputTokens,34);
  assert.equal(details.usage.measuredRuns,1);
  await h.request('/api/employees/nonexistent/details',undefined,400);
}));
test('Gemini, OpenCode and Kimi execute through approved plans and collect structured results',async()=>harness(async h=>{
  const {projectId,s}=await setup(h,'gemini');
  const employees={gemini:(await h.request('/api/snapshot')).employees[0].id};
  for(const runtime of ['opencode','kimi']) employees[runtime]=(await h.request('/api/employees',{name:`${runtime} worker`,runtime,role:'Developer'})).id;
  const catalog=(await h.request('/api/snapshot')).runtimes;
  for(const runtime of Object.keys(employees)) assert(catalog.some(item=>item.id===runtime&&item.available&&item.managed));
  let plan=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  plan=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:plan.revision,planVersion:plan.planVersion,steps:Object.entries(employees).map(([runtime,employeeId])=>({prompt:`Ask ${runtime} to inspect`,employeeId,dependsOn:[]}))});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:plan.planVersion});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.derivedStatus==='awaiting_acceptance'&&state;});
  const state=await h.request('/api/snapshot');
  for(const [runtime,employeeId] of Object.entries(employees)) {
    const task=state.tasks.find(item=>item.employee_id===employeeId);
    assert.equal(task.status,'completed',JSON.stringify(task));
    assert.match(task.result,new RegExp(runtime==='opencode'?'OpenCode result':runtime==='gemini'?'Gemini result':'Kimi result'));
    assert(state.artifacts.some(item=>item.run_id===state.runs.find(run=>run.task_id===task.id).id));
    assert(state.messages.some(item=>item.task_id===task.id&&item.type==='response'&&item.to_agent==='apix-director'));
    const details=await h.request(`/api/employees/${employeeId}/details`);
    assert.equal(details.usage.measuredRuns,1);
  }
  assert.equal((await h.request(`/api/employees/${employees.gemini}/details`)).usage.inputTokens,41);
  assert.equal((await h.request(`/api/employees/${employees.opencode}/details`)).usage.outputTokens,15);
  assert.equal((await h.request(`/api/employees/${employees.kimi}/details`)).usage.cachedTokens,5);
  assert(state.events.some(item=>item.source==='gemini-stream'&&item.kind==='message'));
  assert(state.events.some(item=>item.source==='opencode-stream'&&item.kind==='text'));
  assert(state.events.some(item=>item.source==='kimi-stream'&&item.kind==='result'));
  assert.equal(projectId,state.projects[0].id);
},{APIX_GEMINI_ENTRY:join(root,'test/fake-provider.mjs'),APIX_OPENCODE_ENTRY:join(root,'test/fake-provider.mjs'),APIX_KIMI_ENTRY:join(root,'test/fake-provider.mjs')}));

test('structured provider error fails a run even when its process exits zero',async()=>harness(async h=>{
  const {s}=await setup(h,'gemini');
  const plan=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:plan.planVersion});
  await waitFor(async()=>{const state=await h.request('/api/snapshot');return state.tasks.some(item=>item.status==='failed')&&state;});
  const state=await h.request('/api/snapshot');
  assert.equal(state.runs[0].status,'failed');
  assert.match(state.tasks[0].result,/gemini fixture error/);
},{APIX_GEMINI_ENTRY:join(root,'test/fake-provider.mjs'),APIX_FIXTURE_FAIL_RUNTIME:'gemini'}));
test('structured quota error with only a message pauses new launches even on exit zero',async()=>harness(async h=>{
  const worker=join(h.dir,'structured-quota.mjs');
  await writeFile(worker,"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'insufficient_quota'}})+'\\n'));");
  await h.request('/api/adapters',{id:'structured-quota',name:'Structured quota',executable:process.execPath,args:[worker],format:'jsonl'});
  const {s,employeeId}=await setup(h,'structured-quota');
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[0,1].map(i=>({prompt:'quota-'+i,employeeId,dependsOn:[]}))});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  p=await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return state.tasks[0].status==='failed'&&state;});
  assert.equal(p.tasks[1].status,'queued');assert.match(p.tasks[1].queue_reason,/已暂停/);
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
  assert.equal((await h.request(`/api/projects/${s.project_id}/execution`)).runtimePauses[0].runtime,'structured-quota');
}));
test('custom worker exchanges project-scoped mailbox messages using its run credential',async()=>harness(async h=>{
  const worker=join(h.dir,'mailbox-worker.mjs');
  await writeFile(worker,`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
    const base=process.env.APIX_MAILBOX_URL;
    const headers={Authorization:'Bearer '+process.env.APIX_AGENT_TOKEN,'Content-Type':'application/json'};
    const res=await fetch(base+'/messages',{method:'POST',headers,body:JSON.stringify({from:'system',projectId:'fake',to:'apix-director',type:'event',idempotencyKey:'worker-progress',payload:{kind:'progress_update',summary:'正在检查验收依据',blocked:false,progress:'worker contacted mailbox'}})});
    if(!res.ok)throw new Error(await res.text());
    const self=await fetch(base+'/messages',{method:'POST',headers,body:JSON.stringify({to:process.env.APIX_AGENT_ID,type:'event',idempotencyKey:'self-checkpoint',payload:{checkpoint:true}})});
    if(!self.ok)throw new Error(await self.text());
    const guidance=new Set();
    for(let attempt=0;attempt<60 && guidance.size<2;attempt++) {
      const inbox=await (await fetch(base+'/messages',{headers})).json();
      for(const message of inbox) {
        const ack=await fetch(base+'/messages/'+message.id+'/ack',{method:'POST',headers,body:'{}'});
        if(!ack.ok)throw new Error(await ack.text());
        if(message.payload.kind==='guidance')guidance.add(message.payload.source);
        const completed=await fetch(base+'/messages/'+message.id+'/complete',{method:'POST',headers,body:'{}'});
        if(!completed.ok)throw new Error(await completed.text());
      }
      if(guidance.size<2)await new Promise(r=>setTimeout(r,100));
    }
    if(!guidance.has('apix')||!guidance.has('user'))throw new Error('Expected both ApiX and user guidance');
    process.stdout.write('Worker completed mailbox exchange with '+[...guidance].join(',')+' guidance');
  });`);
  await h.request('/api/adapters',{id:'custom-worker',name:'自定义员工',executable:process.execPath,args:[worker],format:'plain'});
  const {s,employeeId}=await setup(h,'custom-worker');
  const p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  await h.request('/api/adapters',{id:'custom-worker',name:'changed',executable:process.execPath,args:[],format:'plain'},400);
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await h.request(`/api/coordination/sessions/${s.id}/instructions`,{revision:s.revision,taskId:p.tasks[0].id,content:'请核对验收标准'});
  await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);assert.notEqual(state.derivedStatus,'attention',JSON.stringify(state.tasks));return state.derivedStatus==='awaiting_acceptance';});
  const messages=(await h.request('/api/snapshot')).messages;
  assert(messages.some(m=>m.idempotency_key.endsWith(':worker-progress')&&m.from_agent===employeeId&&m.payload.progress==='worker contacted mailbox'&&m.source_run_id));
  assert(messages.some(m=>m.to_agent===employeeId&&m.payload.kind==='guidance'&&m.payload.source==='apix'));
  assert(messages.some(m=>m.to_agent===employeeId&&m.payload.kind==='guidance'&&m.payload.source==='user'));
  const session=await h.request(`/api/coordination/sessions/${s.id}`);
  assert(session.turns.some(t=>t.kind==='worker_guidance'&&t.role==='apix'));
  assert(session.guidance.some(g=>g.status==='sent'&&g.action==='guide'));
  await h.request(`/api/coordination/sessions/${s.id}/instructions`,{revision:s.revision,taskId:p.tasks[0].id,content:'late instruction'},400);
  await h.request('/api/agent/messages',undefined,400,{Authorization:'Bearer invalid'});
}));

test('ApiX actively requests progress from a silent worker and records the supervision',async()=>harness(async h=>{
  const worker=join(h.dir,'silent-worker.mjs');
  await writeFile(worker,`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
    const base=process.env.APIX_MAILBOX_URL;
    const headers={Authorization:'Bearer '+process.env.APIX_AGENT_TOKEN,'Content-Type':'application/json'};
    for(let attempt=0;attempt<80;attempt++) {
      const inbox=await (await fetch(base+'/messages',{headers})).json();
      const request=inbox.find(message=>message.payload.kind==='progress_request');
      if(request){
        const reply=await fetch(base+'/messages',{method:'POST',headers,body:JSON.stringify({to:'apix-director',type:'event',idempotencyKey:'idle-report',payload:{kind:'progress_update',summary:'已收到进度请求，正在核对验收标准',blocked:false}})});
        if(!reply.ok)throw new Error(await reply.text());
        process.stdout.write('Reported progress after ApiX request');return;
      }
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error('ApiX did not request progress');
  });`);
  await h.request('/api/adapters',{id:'silent-worker',name:'沉默员工',executable:process.execPath,args:[worker],format:'plain'});
  const {s}=await setup(h,'silent-worker');
  const p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).derivedStatus==='awaiting_acceptance');
  const state=await h.request(`/api/coordination/sessions/${s.id}`);
  assert(state.turns.some(t=>t.kind==='progress_requested'));
  const messages=(await h.request('/api/snapshot')).messages;
  assert.equal(messages.filter(m=>m.idempotency_key.startsWith('apix-status-request:')).length,1);
  assert(messages.some(m=>m.idempotency_key.endsWith(':idle-report')));
},{APIX_SUPERVISION_TICK_MS:'100',APIX_SUPERVISION_AFTER_MS:'300'}));
test('provider catalog and manager validation preserve old settings on every failure',async()=>harness(async h=>{
  assert.deepEqual((await h.request('/api/manager/providers')).providers,BUILTIN_PROVIDERS);
  const local={provider:'apix-custom',model:'qwen-test',baseUrl:'http://[::1]:11434/v1',apiType:'openai-completions',apiKeyEnv:''};
  await h.request('/api/manager/settings',local);
  const invalid=[
    [{baseUrl:'invalid-url'},/URL 格式无效/],
    [{baseUrl:'ftp://example.invalid'},/HTTP\/HTTPS/],
    [{baseUrl:'https://user:pass@example.invalid'},/认证信息/],
    [{baseUrl:'https://example.invalid/?key=x'},/查询参数/],
    [{baseUrl:'https://example.invalid/#x'},/锚点/],
    [{model:''},/模型 ID/],
    [{baseUrl:'https://example.invalid'},/API Key/],
    [{baseUrl:'http://localhost.example.invalid'},/API Key/],
    [{apiType:'invalid'},/API 类型/],
    [{apiKeyEnv:'lower_case'},/大写字母/],
    [{baseUrl:'http://localhost/'+ 'a'.repeat(1001)},/1000/],
    [{model:'-option'},/模型配置/],
    [{provider:'p'.repeat(101)},/模型配置/],
    [{model:'m'.repeat(201)},/模型配置/]
  ];
  for(const [changes,error] of invalid) {
    assert.match((await h.request('/api/manager/settings',{...local,...changes},400)).error,error);
    assert.deepEqual(await h.request('/api/manager/settings'),local);
  }
  const remote={...local,baseUrl:'https://example.invalid/v1',apiKeyEnv:'APIX_TEST_NOT_SET'};
  assert.deepEqual(await h.request('/api/manager/settings',remote),remote,'save validates the variable name, not its value');
  const old={provider:'old-pi-provider',model:'old-model',baseUrl:'',apiType:'openai-completions',apiKeyEnv:''};
  assert.deepEqual(await h.request('/api/manager/settings',old),old);
  await h.restart();assert.deepEqual(await h.request('/api/manager/settings'),old);
  assert.deepEqual(await h.request('/api/manager/settings',{}),{provider:'',model:'',baseUrl:'',apiType:'openai-completions',apiKeyEnv:''});
}));

test('local model discovery API is read-only, authenticated by environment and origin protected',async()=>harness(async h=>{
  let calls=0;
  const service=createHttpServer((req,res)=>{
    calls++;assert.equal(req.method,'GET');assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,'Bearer fixture-local-secret');
    res.end(JSON.stringify({data:[{id:'actual-local-model',owned_by:'fixture'}]}));
  });
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
  try{
    const baseUrl='http://127.0.0.1:'+service.address().port+'/v1';
    const saved=await h.request('/api/manager/settings',{provider:'legacy',model:'manual-model'});
    const input={baseUrl,apiKeyEnv:'APIX_TEST_LOCAL_MODEL_KEY'};
    assert.deepEqual(await h.request('/api/manager/models',input),{models:[{id:'actual-local-model',name:'actual-local-model'}]});
    assert.deepEqual(await h.request('/api/manager/settings'),saved);
    const rejected=await fetch(h.origin+'/api/manager/models',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify(input)});
    assert.equal(rejected.status,403);assert.equal(calls,1);
    assert.match((await h.request('/api/manager/models',{baseUrl:'https://example.invalid/v1',apiKeyEnv:'APIX_TEST_LOCAL_MODEL_KEY'},400)).error,/回环/);
    assert.equal(calls,1);assert.deepEqual(await h.request('/api/manager/settings'),saved);
  }finally{service.closeAllConnections();await new Promise(resolve=>service.close(resolve));}
},{APIX_TEST_LOCAL_MODEL_KEY:'fixture-local-secret'}));

test('delayed SSE exposes deltas before completion, preserves context and confirmed requirements',async()=>harness(async h=>{
  const {s:initial}=await setup(h);
  let s=initial;let preview='';let checkedPending=false;const events=[];
  for await(const event of streamFrames(await streamRequest(h,s,'fixture-long-reply'))) {
    events.push(event.type);
    if(event.type==='delta') {
      preview+=event.data.text;
      if(!checkedPending) {
        checkedPending=true;
        const pending=await h.request(`/api/coordination/sessions/${s.id}`);
        assert.equal(pending.busy,true);
        assert.equal(pending.turns.at(-1).role,'user');
        assert.match((await h.request(`/api/coordination/sessions/${s.id}/messages`,{revision:s.revision,content:'duplicate'},400)).error,/正在处理/);
      }
    }
    if(event.type==='complete')s=event.data;
  }
  assert(checkedPending);assert.equal(events[0],'start');assert.equal(events.at(-1),'complete');
  assert.equal(events.filter(type=>type==='complete').length,1);
  assert.equal(preview,s.turns.at(-1).content);assert(preview.length>1000);assert.equal(s.busy,false);
  for await(const event of streamFrames(await streamRequest(h,s,'fixture-context')))if(event.type==='complete')s=event.data;
  assert.match(s.turns.at(-1).content,/fixture-long-reply/);
  const plan=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  const requirements=plan.requirements;
  for await(const event of streamFrames(await streamRequest(h,plan,'请解释当前进度')))if(event.type==='complete')s=event.data;
  assert.equal(s.turns.at(-1).content,'请检查这些需求，是否还有需要调整的约束？','natural reply must not be replaced with a canned summary');
  assert.deepEqual(s.requirements,requirements);assert.equal(s.plan_id,plan.plan_id);
  assert.equal((await h.request('/api/snapshot')).runs.length,0);
  await h.restart();assert.deepEqual((await h.request(`/api/coordination/sessions/${s.id}`)).turns,s.turns);
},{APIX_FIXTURE_STREAM:'1',APIX_FIXTURE_STREAM_DELAY_MS:'100'}));

test('SSE stale revisions, model fallback and client disconnect leave the session usable',async()=>harness(async h=>{
  const {s:initial}=await setup(h);let s=initial;
  const stale=[];
  for await(const event of streamFrames(await streamRequest(h,{...s,revision:s.revision-1},'stale')))stale.push(event);
  assert.deepEqual(stale.map(event=>event.type),['start','error']);
  assert.equal((await h.request(`/api/coordination/sessions/${s.id}`)).turns.length,s.turns.length);
  for await(const event of streamFrames(await streamRequest(h,s,'fixture-invalid-reply')))if(event.type==='complete')s=event.data;
  assert.equal(s.agent.mode,'rules');assert.match(s.agent.error,/不支持的行为/);assert.equal(s.busy,false);
  for await(const event of streamFrames(await streamRequest(h,s,'fixture-runtime-error')))if(event.type==='complete')s=event.data;
  assert.equal(s.agent.mode,'rules');assert.match(s.agent.error,/Pi 未返回可用答复/);assert.equal(s.busy,false);
  const frames=streamFrames(await streamRequest(h,s,'fixture-context'));
  for await(const event of frames)if(event.type==='delta')break;
  // Stop reading without reissuing the request; the backend still owns this turn.
  s=await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return !state.busy&&state;});
  assert.equal(s.turns.filter(turn=>turn.role==='user'&&turn.content==='fixture-context').length,1);
  assert.equal(s.turns.at(-1).role,'apix');
  const reader=(await streamRequest(h,s,'断开后继续')).body.getReader();await reader.cancel();
  s=await waitFor(async()=>{const state=await h.request(`/api/coordination/sessions/${s.id}`);return !state.busy&&state;});
  assert.equal(s.turns.filter(turn=>turn.role==='user'&&turn.content==='断开后继续').length,1);
},{APIX_FIXTURE_STREAM:'1',APIX_FIXTURE_STREAM_DELAY_MS:'60'}));

test('scheduler propagates launch failure through downstream dependencies',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT,plan_id TEXT,updated_at TEXT,result TEXT);CREATE TABLE task_dependencies(task_id TEXT,depends_on_id TEXT);CREATE TABLE plans(id TEXT,mode TEXT);CREATE TABLE meeting_items(id TEXT,task_id TEXT);CREATE TABLE approvals(task_id TEXT,status TEXT,action TEXT,created_at TEXT);INSERT INTO tasks(id,status) VALUES ('a','completed'),('b','queued'),('c','queued');INSERT INTO task_dependencies VALUES ('b','a'),('c','b');INSERT INTO approvals VALUES ('b','approved','start-agent-in-project','now');");
    const row=(q,...p)=>db.prepare(q).get(...p);const rows=(q,...p)=>db.prepare(q).all(...p);
    createTaskScheduler({db,row,rows,now:()=>new Date().toISOString(),launch:()=>{throw new Error('runtime gone');}}).scheduleDependents('a');
    assert.equal(row('SELECT status FROM tasks WHERE id=?','b').status,'failed');
    assert.equal(row('SELECT status FROM tasks WHERE id=?','c').status,'blocked');
  } finally {db.close();}
});

test('coordinator dependencies wait for acceptance and rejection blocks downstream work',async()=>harness(async h=>{
  const {s,employeeId}=await setup(h);
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[
    {prompt:'检查并提交首个报告',employeeId,dependsOn:[]},
    {prompt:'核对前置交付',employeeId,dependsOn:[0]},
    {prompt:'最终汇总',employeeId,dependsOn:[1]},
  ]});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  const waiting=await waitFor(async()=>{const current=await h.request(`/api/coordination/sessions/${s.id}`);return current.tasks[0].status==='completed'&&current;});
  assert.equal(waiting.derivedStatus,'awaiting_acceptance');
  assert.deepEqual(waiting.tasks.map(task=>task.status),['completed','queued','queued']);
  assert.deepEqual(waiting.progress[1].waitingFor,[p.tasks[0].id]);
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
  const pendingDelivery=await h.request(`/api/tasks/${p.tasks[1].id}/delivery`);
  const refused=await h.request(`/api/tasks/${p.tasks[1].id}/recovery`,{revision:waiting.revision,runId:null,fingerprint:pendingDelivery.recoveryFingerprint,reviewed:true,employeeId},400);
  assert.match(refused.error,/前置任务/);
  assert.deepEqual((await h.request(`/api/coordination/sessions/${s.id}`)).tasks.map(task=>task.status),['completed','queued','queued']);
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
  await h.request(`/api/tasks/${p.tasks[0].id}/review`,{accepted:true});
  await waitFor(async()=>{const current=await h.request(`/api/coordination/sessions/${s.id}`);return current.tasks[1].status==='completed';});
  await h.request(`/api/tasks/${p.tasks[1].id}/review`,{accepted:false});
  const blocked=await h.request(`/api/coordination/sessions/${s.id}`);
  assert.deepEqual(blocked.tasks.map(task=>task.status),['accepted','needs_revision','blocked']);
  assert.equal(blocked.derivedStatus,'attention');
  assert.equal((await h.request('/api/snapshot')).runs.length,2);
}));

test('run credentials isolate concurrent employee inboxes, acknowledgements and idempotency',async()=>harness(async h=>{
  const worker=join(h.dir,'run-mailbox-worker.mjs');
  await writeFile(worker,`import {writeFileSync} from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(h.dir)}+'/'+process.env.APIX_RUN_ID+'.json',JSON.stringify({token:process.env.APIX_AGENT_TOKEN}));setTimeout(()=>process.exit(0),60000);});`);
  await h.request('/api/adapters',{id:'run-worker',name:'Run worker',executable:process.execPath,args:[worker],format:'plain',mailbox:true});
  const {s,employeeId}=await setup(h,'run-worker');
  await h.request(`/api/projects/${s.project_id}/execution`,{version:0,projectLimit:4,employeeLimit:2,paused:false});
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[{prompt:'检查 A',employeeId,dependsOn:[]},{prompt:'检查 B',employeeId,dependsOn:[]}]});
  try {
    await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
    const state=await waitFor(async()=>{const state=await h.request('/api/snapshot');return state.runs.length===2&&state;});
    const run0=state.runs.find(r=>r.task_id===p.tasks[0].id),run1=state.runs.find(r=>r.task_id===p.tasks[1].id);
    const headers=[];
    for(const run of [run0,run1]) {const fixture=await waitFor(async()=>{try{return JSON.parse(await readFile(join(h.dir,run.id+'.json'),'utf8'));}catch{return false;}});headers.push({Authorization:'Bearer '+fixture.token});}
    const message=await h.request('/api/messages',{projectId:s.project_id,taskId:p.tasks[0].id,from:'apix-director',to:employeeId,type:'event',idempotencyKey:'isolated-guidance',payload:{kind:'guidance',content:'A only'}});
    assert.equal(message.target_run_id,run0.id);
    assert.equal((await h.request('/api/agent/messages',undefined,200,headers[1])).length,0);
    assert.equal((await h.request('/api/agent/messages',undefined,200,headers[0]))[0].id,message.id);
    for(const action of ['ack','complete','nack'])await h.request(`/api/agent/messages/${message.id}/${action}`,{},400,headers[1]);
    await h.request('/api/agent/messages',{to:'apix-director',type:'response',replyTo:message.id,idempotencyKey:'wrong-reply',payload:'wrong'},400,headers[1]);
    await h.request(`/api/agent/messages/${message.id}/ack`,{},200,headers[0]);
    let detail=await h.request(`/api/coordination/sessions/${s.id}`);
    assert.equal(detail.instructions.find(m=>m.id===message.id).status,'processing');
    await h.request(`/api/agent/messages/${message.id}/complete`,{},200,headers[0]);
    detail=await h.request(`/api/coordination/sessions/${s.id}`);
    assert.equal(detail.instructions.find(m=>m.id===message.id).status,'completed');
    for(const header of headers)await h.request('/api/agent/messages',{to:'apix-director',type:'event',idempotencyKey:'checkpoint',payload:{kind:'checkpoint'}},200,header);
    const messages=(await h.request('/api/snapshot')).messages.filter(m=>m.idempotency_key.endsWith(':checkpoint'));
    assert.equal(messages.length,2); assert.notEqual(messages[0].source_run_id,messages[1].source_run_id);
    const peer=await h.request('/api/agent/messages',{to:employeeId,targetTaskId:p.tasks[1].id,type:'event',idempotencyKey:'peer',payload:{summary:'同计划交接'}},200,headers[0]);
    const team=await h.request('/api/agent/team',undefined,200,headers[0]);
    assert.equal(team.find(e=>e.id===employeeId).tasks.length,2);
    assert.equal(peer.target_run_id,run1.id);
    assert((await h.request('/api/agent/messages',undefined,200,headers[1])).some(m=>m.id===peer.id));
    assert(!(await h.request('/api/agent/messages',undefined,200,headers[0])).some(m=>m.id===peer.id));
    await h.request(`/api/runs/${run0.id}/stop`,{});
    await waitFor(async()=>(await h.request('/api/snapshot')).runs.find(r=>r.id===run0.id).status==='cancelled');
    await h.request('/api/agent/messages',undefined,400,headers[0]);
  } finally {
    for(const run of (await h.request('/api/snapshot')).runs.filter(r=>['running','starting'].includes(r.status)))await h.request(`/api/runs/${run.id}/stop`,{});
  }
}));

test('accepted code including new files reaches chained workers from frozen Git deliveries',async()=>harness(async h=>{
  const worker=join(h.dir,'code-worker.mjs');
  await writeFile(worker,`import {writeFileSync,readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{if(prompt.startsWith('produce')){writeFileSync('shared.txt','accepted input');execFileSync('git',['add','--','shared.txt']);writeFileSync('unstaged.txt','new untracked input');process.stdout.write('produced');}else if(prompt.startsWith('consume')){const value=readFileSync('shared.txt','utf8');writeFileSync('report.txt',value);process.stdout.write('consumed '+value);}else{process.stdout.write(readFileSync('shared.txt','utf8')+' / '+readFileSync('report.txt','utf8'));}});`);
  await h.request('/api/adapters',{id:'code-worker',name:'Code worker',executable:process.execPath,args:[worker],format:'plain'});
  const {s,employeeId}=await setup(h,'code-worker');
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[{prompt:'produce input',employeeId,dependsOn:[]},{prompt:'consume input',employeeId,dependsOn:[0]},{prompt:'verify chained inputs',employeeId,dependsOn:[1]}]});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[0].status==='completed');
  const initial=await h.request(`/api/tasks/${p.tasks[0].id}/delivery`);
  assert.deepEqual(initial.inspection.files,['shared.txt','unstaged.txt']); assert.match(initial.inspection.preview,/accepted input/);
  const source=(await h.request('/api/snapshot')).tasks.find(t=>t.id===p.tasks[0].id);
  await writeFile(join(source.workspace_path,'shared.txt'),'accepted input changed');
  await h.request(`/api/tasks/${p.tasks[0].id}/review`,{accepted:true,fingerprint:initial.inspection.fingerprint},400);
  await writeFile(join(source.workspace_path,'shared.txt'),'accepted input');
  const inspected=await h.request(`/api/tasks/${p.tasks[0].id}/delivery`);
  await h.request(`/api/tasks/${p.tasks[0].id}/review`,{accepted:true,fingerprint:inspected.inspection.fingerprint});
  await writeFile(join(source.workspace_path,'shared.txt'),'unreviewed mutation');
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[1].status==='completed');
  let state=await h.request(`/api/coordination/sessions/${s.id}`);
  assert.match(state.tasks[1].result,/consumed accepted input/);
  assert(!state.tasks[1].result.includes('unreviewed mutation'));
  await h.request(`/api/tasks/${p.tasks[1].id}/review`,{accepted:true});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[2].status==='completed');
  state=await h.request(`/api/coordination/sessions/${s.id}`);
  assert.equal(state.tasks[2].result,'accepted input / accepted input');
  assert.equal(state.handoffs.find(item=>item.task_id===p.tasks[2].id).report.sources.length,2);
  await h.request(`/api/tasks/${p.tasks[2].id}/review`,{accepted:true});
  const integration=await h.request('/api/integrations',{planId:state.plan_id});
  assert.equal(integration.status,'ready'); assert.deepEqual(integration.report.changedFiles.sort(),['report.txt','shared.txt','unstaged.txt']);
  await writeFile(join(integration.workspacePath,'shared.txt'),'integration changed after review');
  await h.request(`/api/integrations/${integration.id}/apply`,{},400);
  await assert.rejects(readFile(join(h.project,'shared.txt'),'utf8'),{code:'ENOENT'});
}));

test('conflicting accepted inputs block the consumer before process launch and preserve evidence',async()=>harness(async h=>{
  const worker=join(h.dir,'conflict-worker.mjs');
  await writeFile(worker,`import {writeFileSync} from 'node:fs';let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{writeFileSync('collision.txt',prompt.startsWith('left')?'left':'right');process.stdout.write('produced conflict fixture');});`);
  await h.request('/api/adapters',{id:'conflict-worker',name:'Conflict worker',executable:process.execPath,args:[worker],format:'plain'});
  const {s,employeeId}=await setup(h,'conflict-worker');
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[{prompt:'left input',employeeId,dependsOn:[]},{prompt:'right input',employeeId,dependsOn:[]},{prompt:'consumer',employeeId,dependsOn:[0,1]}]});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks.slice(0,2).every(t=>t.status==='completed'));
  for(const task of p.tasks.slice(0,2))await h.request(`/api/tasks/${task.id}/review`,{accepted:true});
  const state=await h.request(`/api/coordination/sessions/${s.id}`);
  assert.equal(state.tasks[2].status,'blocked'); assert.equal(state.derivedStatus,'attention');
  const run=(await h.request('/api/snapshot')).runs.find(r=>r.task_id===p.tasks[2].id);
  assert.equal(run.pid,null); assert.equal(run.status,'blocked'); assert(run.ended_at);
  const inspection=await h.request(`/api/tasks/${p.tasks[2].id}/delivery`);
  assert.equal(inspection.handoff.status,'conflict'); assert.deepEqual(inspection.inspection.conflicts,['collision.txt']);
  await assert.rejects(readFile(join(h.project,'collision.txt'),'utf8'),{code:'ENOENT'});
  const blocked=(await h.request('/api/snapshot')).tasks.find(t=>t.id===p.tasks[2].id);
  await writeFile(join(blocked.workspace_path,'collision.txt'),'user resolved');
  execFileSync('git',['add','--','collision.txt'],{cwd:blocked.workspace_path});
  const reviewed=await h.request(`/api/tasks/${blocked.id}/delivery`);
  await h.request(`/api/tasks/${blocked.id}/recovery`,{revision:s.revision,runId:reviewed.latestRun.id,fingerprint:reviewed.recoveryFingerprint,reviewed:true});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[2].status==='completed');
  const resolved=await h.request(`/api/tasks/${blocked.id}/delivery`);
  assert.equal(resolved.handoff.status,'ready'); assert.equal(resolved.handoff.report.resolution,'用户检查并批准当前解决结果');
}));

test('project pause and concurrency queue approved work and release slots without duplicate launches',async()=>harness(async h=>{
  const release=join(h.dir,'release');const worker=join(h.dir,'limited-worker.mjs');
  await writeFile(worker,`import {existsSync} from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('limited worker finished',()=>process.exit(0));}},50);setTimeout(()=>process.exit(1),30000).unref();});`);
  await h.request('/api/adapters',{id:'limited-worker',name:'Limited worker',executable:process.execPath,args:[worker],format:'plain'});
  const {s,employeeId}=await setup(h,'limited-worker');
  await h.request(`/api/projects/${s.project_id}/execution`,{version:0,projectLimit:1,employeeLimit:2,paused:true});
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[0,1,2].map(i=>({prompt:'independent '+i,employeeId,dependsOn:[]}))});
  try {
    p=await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
    assert(p.tasks.every(t=>t.status==='queued'&&t.queue_reason.includes('项目已暂停')));
    assert.equal((await h.request('/api/snapshot')).runs.length,0);
    await h.request(`/api/projects/${s.project_id}/execution`,{version:0,paused:false},400);
    await h.request(`/api/projects/${s.project_id}/execution`,{version:1,paused:false});
    const running=await h.request(`/api/coordination/sessions/${s.id}`);
    assert.deepEqual(running.tasks.map(t=>t.status),['running','queued','queued']);
    assert(running.tasks[1].queue_reason.includes('项目并发已满'));
    await writeFile(release,'go');
    await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks.every(t=>t.status==='completed'));
    const state=await h.request('/api/snapshot');assert.equal(state.runs.length,3);
    let active=0,peak=0;
    for(const event of state.messageEvents.filter(e=>e.event_type==='agent.status').reverse()) {if(event.payload.status==='running'){active++;peak=Math.max(peak,active);}if(['completed','failed','cancelled'].includes(event.payload.status))active--;}
    assert.equal(peak,1);
  } finally {await writeFile(release,'go');for(const run of (await h.request('/api/snapshot')).runs.filter(r=>r.status==='running'))await h.request(`/api/runs/${run.id}/stop`,{});}
}));

test('quota failure pauses its runtime, preserves partial work and supports reviewed reassignment',async()=>harness(async h=>{
  const worker=join(h.dir,'quota-worker.mjs');
  await writeFile(worker,`import {writeFileSync,existsSync,readFileSync} from 'node:fs';let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{if(process.argv[2]==='bad'&&prompt.startsWith('quota')){writeFileSync('partial.txt','preserved partial');process.stderr.write('insufficient_quota',()=>process.exit(1));}else{process.stdout.write(existsSync('partial.txt')?readFileSync('partial.txt','utf8'):'healthy worker');}});`);
  for(const [id,mode] of [['quota-worker','bad'],['healthy-worker','good']])await h.request('/api/adapters',{id,name:id,executable:process.execPath,args:[worker,mode],format:'plain'});
  const {s,employeeId}=await setup(h,'quota-worker');
  const alternate=(await h.request('/api/employees',{name:'alternate',runtime:'healthy-worker',role:'开发与验证'})).id;
  let p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  p=await h.request(`/api/coordination/sessions/${s.id}/plan`,{revision:p.revision,planVersion:p.planVersion,steps:[{prompt:'quota first',employeeId,dependsOn:[]},{prompt:'healthy second',employeeId,dependsOn:[]}]});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[0].status==='failed');
  const paused=await h.request(`/api/projects/${s.project_id}/execution`);
  assert.equal(paused.runtimePauses[0].runtime,'quota-worker');
  let state=await h.request(`/api/coordination/sessions/${s.id}`);
  assert.equal(state.tasks[1].status,'queued'); assert.match(state.tasks[1].queue_reason,/已暂停/);
  assert.equal((await h.request('/api/snapshot')).runs.length,1);
  const inspected=await h.request(`/api/tasks/${state.tasks[0].id}/delivery`);
  assert.equal(inspected.workspacePath,state.tasks[0].workspace_path);
  const retry={revision:s.revision,employeeId:alternate,runId:inspected.latestRun.id,fingerprint:inspected.recoveryFingerprint,reviewed:true};
  await h.request(`/api/tasks/${state.tasks[0].id}/recovery`,{...retry,reviewed:false},400);
  await h.request(`/api/tasks/${state.tasks[0].id}/recovery`,retry);
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[0].status==='completed');
  state=await h.request(`/api/coordination/sessions/${s.id}`);
  assert.equal(state.tasks[0].employee_id,alternate); assert.equal(state.tasks[0].result,'preserved partial');
  assert.equal(state.tasks[1].status,'queued');
  await h.request(`/api/projects/${s.project_id}/execution/runtime`,{version:paused.version,runtime:'quota-worker',paused:false});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[1].status==='completed');
  const runs=(await h.request('/api/snapshot')).runs;
  assert.equal(runs.length,3); assert.equal(runs.filter(r=>r.task_id===state.tasks[0].id).length,2);
}));

test('restart recovery requires explicit stop confirmation and a fresh workspace fingerprint',async()=>harness(async h=>{
  const worker=join(h.dir,'restart-worker.mjs');
  await writeFile(worker,`import {existsSync,writeFileSync,readFileSync} from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{if(!existsSync('partial.txt')){writeFileSync('partial.txt','before restart');setTimeout(()=>process.exit(0),8000);}else{process.stdout.write('recovered '+readFileSync('partial.txt','utf8'));}});`);
  await h.request('/api/adapters',{id:'restart-worker',name:'Restart worker',executable:process.execPath,args:[worker],format:'plain'});
  const {s}=await setup(h,'restart-worker');const p=await h.request(`/api/coordination/sessions/${s.id}/confirm`,{revision:s.revision});
  await h.request(`/api/coordination/sessions/${s.id}/dispatch`,{planVersion:p.planVersion});
  const first=await waitFor(async()=>{const state=await h.request('/api/snapshot');const task=state.tasks.find(t=>t.id===p.tasks[0].id);try{await readFile(join(task.workspace_path,'partial.txt'));return task;}catch{return false;}});
  await h.restart();
  assert.equal((await h.request(`/api/coordination/sessions/${s.id}`)).tasks[0].status,'unknown');
  let inspected=await h.request(`/api/tasks/${first.id}/delivery`);
  const retry={revision:s.revision,runId:inspected.latestRun.id,fingerprint:inspected.recoveryFingerprint,reviewed:true};
  await h.request(`/api/tasks/${first.id}/recovery`,retry,400);
  await waitFor(async()=>{const d=await h.request(`/api/tasks/${first.id}/delivery`);return d.processMayExist!==true;});
  await writeFile(join(first.workspace_path,'partial.txt'),'checked after restart');
  await h.request(`/api/tasks/${first.id}/recovery`,{...retry,confirmedStopped:true},400);
  inspected=await h.request(`/api/tasks/${first.id}/delivery`);
  await h.request(`/api/tasks/${first.id}/recovery`,{...retry,fingerprint:inspected.recoveryFingerprint,confirmedStopped:true});
  await waitFor(async()=>(await h.request(`/api/coordination/sessions/${s.id}`)).tasks[0].status==='completed');
  const state=await h.request('/api/snapshot');
  assert.equal(state.tasks.find(t=>t.id===first.id).result,'recovered checked after restart');
  assert.equal(state.runs.length,2);assert(state.runs.some(r=>r.status_source==='user-recovery-confirmed'));
}));
