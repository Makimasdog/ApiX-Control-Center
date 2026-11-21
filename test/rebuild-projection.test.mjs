import {fetch} from './local-fetch.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {startModelFixture} from './fake-model-http.mjs';
import {serviceDiagnostics,stopService,waitServiceReady} from './service-diagnostics.mjs';
import {rebuildProjection} from '../scripts/verify/rebuild-projection.mjs';

/**
 * P2 Step 2 只读重建校验器验收：
 * 用真实服务（隔离临时数据目录 + fake-pi + 模型 fixture）跑完整协作轮，
 * 再跑 scripts/verify/rebuild-projection.mjs 核对——
 * 1. 真实一轮后全覆盖零差异（green）；
 * 2. 注入无账本证据的历史会话/任务 → 标未覆盖（yellow），不得谎报绿；
 * 3. 旁路篡改任务状态（无事件）→ 投影差异（red，退出码 1）。
 * 全程只使用合成临时 DB，不接触线上或用户数据库。
 */
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const post=async(port,path,body,expected=200)=>{
  const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  assert.equal(response.status,expected,JSON.stringify(data));
  return data;
};
const get=async(port,path)=>{const response=await fetch(`http://127.0.0.1:${port}${path}`);assert.equal(response.status,200);return response.json();};
async function waitFor(predicate,timeout=20000){
  const started=Date.now();
  while(Date.now()-started<timeout){const result=await predicate();if(result)return result;await new Promise(done=>setTimeout(done,100));}
  throw new Error('等待服务状态超时');
}
async function freePort(){
  const {createServer}=await import('node:net');
  return new Promise((resolvePort,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolvePort(port));});});
}
async function isolatedProject(dataDir){
  const project=join(dataDir,'project');
  await mkdir(project);
  execFileSync('git',['-c','core.autocrlf=false','init','-q',project]);
  await writeFile(join(project,'README.md'),'隔离校验项目\n');
  execFileSync('git',['-c','core.autocrlf=false','add','README.md'],{cwd:project});
  execFileSync('git',['-c','core.autocrlf=false','-c','user.name=ApiX Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],{cwd:project});
  return project;
}
/** 跑校验器 CLI，返回退出码与 JSON 报告 */
function runVerifier(dbPath,...flags){
  return new Promise(resolveRun=>{
    const child=spawn(process.execPath,[join(root,'scripts','verify','rebuild-projection.mjs'),'--db',dbPath,'--json',...flags],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',c=>stdout+=c);
    child.stderr.on('data',c=>stderr+=c);
    child.on('close',code=>{
      let report=null;try{report=JSON.parse(stdout);}catch{}
      resolveRun({code,report,stderr});
    });
  });
}
/** 创建→澄清→确认一个会话（模型 fixture 返回单步 api 计划，权限 ask 不自动派发） */
async function readySession(port,projectId,goal){
  let session=await post(port,'/api/coordination/sessions',{projectId,goal});
  for(const [field,value] of Object.entries({scope:'仅隔离项目文件',constraints:'不扩大范围，不启动额外 Agent',deliverable:'实现与验证证据',acceptance:'实际检查通过后人工验收'}))
    session=await post(port,`/api/coordination/sessions/${session.id}/answers`,{revision:session.revision,field,value});
  return session;
}

test('rebuild-projection：真实一轮 green；历史缺证据 yellow；旁路篡改 red',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'apix-rebuild-test-'));
  const port=await freePort();
  const model=await startModelFixture();
  let server;
  const dbPath=join(dataDir,'data','apix.sqlite');
  try{
    const project=await isolatedProject(dataDir);
    server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,APIX_LEGACY_API:'0',APIX_DATA_DIR:join(dataDir,'data'),PORT:String(port),APIX_PI_ENTRY:join(root,'test','fake-pi.mjs'),APIX_CODEX_ENTRY:join(root,'test','fake-codex.mjs'),APIX_CLAUDE_ENTRY:join(root,'test','fake-claude.mjs')},stdio:['ignore','ignore','pipe']});
    let stderr='';server.stderr.on('data',c=>stderr=String(stderr+c).slice(-4000));
    await waitServiceReady(serviceDiagnostics(server),`http://127.0.0.1:${port}/api/snapshot`,{timeoutMs:30000});
    await post(port,'/api/manager/settings',{baseUrl:model.baseUrl,model:'fixture-model',apiType:'openai-completions',apiKeyEnv:''});
    const {id:projectId}=await post(port,'/api/projects',{name:'重建校验',path:project});
    const {id:employeeId}=await post(port,'/api/employees',{name:'实现员工',runtime:'pi',role:'实现'});

    // 会话 A：派发→fake-pi 完成→验收驳回（needs_revision，走 acceptTask 事务）
    let a=await readySession(port,projectId,'完成模块 A');
    a=await post(port,`/api/coordination/sessions/${a.id}/confirm`,{revision:a.revision});
    assert.equal(a.status,'plan_review');
    const taskA=a.tasks[0].id;
    a=await post(port,`/api/coordination/sessions/${a.id}/dispatch`,{planVersion:a.planVersion});
    await waitFor(async()=>(await get(port,`/api/coordination/sessions/${a.id}`)).tasks[0].status==='completed');
    await post(port,`/api/tasks/${taskA}/review`,{accepted:false});
    await waitFor(async()=>(await get(port,`/api/coordination/sessions/${a.id}`)).tasks[0].status==='needs_revision');

    // 会话 B：editPlan 替换计划（旧任务取消须留可重放事件）→hold 运行→stopRun→stopSession
    let b=await readySession(port,projectId,'保持运行后停止');
    b=await post(port,`/api/coordination/sessions/${b.id}/confirm`,{revision:b.revision});
    const oldTaskB=b.tasks[0].id;
    b=await post(port,`/api/coordination/sessions/${b.id}/plan`,{revision:b.revision,planVersion:b.planVersion,steps:[{prompt:'hold',employeeId,dependsOn:[]}]});
    const taskB=b.tasks.find(t=>t.status==='awaiting_approval').id;
    b=await post(port,`/api/coordination/sessions/${b.id}/dispatch`,{planVersion:b.planVersion});
    await waitFor(async()=>(await get(port,`/api/coordination/sessions/${b.id}`)).tasks.find(t=>t.id===taskB)?.status==='running');
    const runB=(await get(port,'/api/snapshot')).runs.find(r=>r.task_id===taskB&&['starting','running'].includes(r.status));
    assert(runB,'hold 运行应存在');
    await post(port,`/api/runs/${runB.id}/stop`,{});
    await waitFor(async()=>(await get(port,`/api/coordination/sessions/${b.id}`)).tasks.find(t=>t.id===taskB)?.status==='cancelled');
    b=await get(port,`/api/coordination/sessions/${b.id}`);
    await post(port,`/api/coordination/sessions/${b.id}/stop`,{revision:b.revision});
    await stopService(server);server=null;

    // 1) 真实一轮：全覆盖零差异
    const green=await runVerifier(dbPath,'--strict');
    assert.equal(green.code,0,green.stderr);
    assert.equal(green.report.verdict,'green',JSON.stringify(green.report.mismatches));
    assert.equal(green.report.mismatchCount,0);
    assert.equal(green.report.uncoveredCount,0);
    assert.equal(green.report.covered.session,2);
    assert.equal(green.report.covered.plan,3,'A 一个计划 + B 编辑前后两个计划');
    assert.equal(green.report.covered.task,3);
    assert.equal(green.report.diffRate,0);

    // 只读直调 also 可用（CLI 之外以 readOnly 打开核对同一结论）
    const readOnly=new DatabaseSync(dbPath,{readOnly:true});
    try{assert.equal(rebuildProjection(readOnly).verdict,'green');}finally{readOnly.close();}

    // 1b) result 兜底证据重放：状态写与 task.result_recorded 事件一致 → 仍 green
    const fallbackResult='Pi result: provider-error\nstderr 兜底证据';
    const withResult=new DatabaseSync(dbPath);
    try{
      withResult.prepare('UPDATE tasks SET result=? WHERE id=?').run(fallbackResult,taskA);
      withResult.prepare('INSERT INTO apix_ledger(project_id,aggregate_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)').run(projectId,taskA,'task.result_recorded','apix',JSON.stringify({result:fallbackResult,reason:'failed-stderr'}),'2026-11-21T00:00:00.000Z');
    }finally{withResult.close();}
    const resultReplay=await runVerifier(dbPath);
    assert.equal(resultReplay.code,0,resultReplay.stderr);
    assert.equal(resultReplay.report.verdict,'green',JSON.stringify(resultReplay.report.mismatches));

    // 2) 注入无账本证据的历史会话/任务 → 未覆盖，yellow，不得报绿
    const write=new DatabaseSync(dbPath);
    try{
      write.prepare("INSERT INTO coordination_sessions(id,project_id,title,status,requirements_json,revision,created_at,updated_at) VALUES ('legacy-s',?,'历史会话','running','{\"goal\":\"历史\"}',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run(projectId);
      write.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,result,created_at,updated_at) VALUES ('legacy-t',?,'pi','历史任务','completed','','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run(projectId);
    }finally{write.close();}
    const yellow=await runVerifier(dbPath);
    assert.equal(yellow.code,0,yellow.stderr);
    assert.equal(yellow.report.verdict,'yellow');
    assert.equal(yellow.report.mismatchCount,0);
    assert(yellow.report.uncovered.some(u=>u.entity==='session'&&u.id==='legacy-s'));
    assert(yellow.report.uncovered.some(u=>u.entity==='task'&&u.id==='legacy-t'));
    assert.equal((await runVerifier(dbPath,'--strict')).code,1);
    assert.equal((await runVerifier(dbPath,'--project','missing-project')).code,2);

    // 3) 旁路篡改任务状态与结果（无事件）→ 投影差异 red
    // 在隔离的 fixture 中模拟绕过应用约束的数据损坏。
    const tamper=new DatabaseSync(dbPath,{enableForeignKeyConstraints:false});
    try{tamper.prepare("UPDATE tasks SET status='failed',result='旁路篡改' WHERE id=?").run(taskA);tamper.prepare('DELETE FROM tasks WHERE id=?').run(oldTaskB);}finally{tamper.close();}
    const red=await runVerifier(dbPath);
    assert.equal(red.code,1);
    assert.equal(red.report.verdict,'red');
    const mismatch=red.report.mismatches.find(m=>m.entity==='task'&&m.id===taskA&&m.field==='status');
    assert(mismatch,JSON.stringify(red.report.mismatches));
    assert.equal(mismatch.projected,'needs_revision');
    assert.equal(mismatch.actual,'failed');
    const resultMismatch=red.report.mismatches.find(m=>m.entity==='task'&&m.id===taskA&&m.field==='result');
    assert(resultMismatch,'result 旁路篡改也必须被核对出来');
    assert.equal(resultMismatch.projected,fallbackResult);
    assert(red.report.mismatches.some(m=>m.entity==='task'&&m.id===oldTaskB&&m.field==='exists'),'账本记录的任务被删除时应报告差异');
  }finally{
    if(server)await stopService(server).catch(()=>{});
    await model.close();
    await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
  }
});
