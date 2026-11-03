import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync,readdirSync,unlinkSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createRuntimeAdapters} from '../../dist/src/agents/runtime-adapters.js';
import {executableOnPath} from '../../src/infrastructure/executable.mjs';
import {loadEnvironment} from '../../src/infrastructure/environment.mjs';
import {startEvaluationGateway} from '../../src/evaluation/model-gateway.mjs';
import {configuredModel} from './evaluate-coding-real.mjs';
import {assertion,caseStatus,findingsFor,redactEvidence,digest} from '../../src/evaluation/evidence.mjs';
import {startDeliveryFixture} from '../../test/delivery-fixture.mjs';

export function inspectNative(){
  const db=new DatabaseSync(':memory:');
  try{
    const adapters=createRuntimeAdapters({db,row:(q,...p)=>db.prepare(q).get(...p),rows:(q,...p)=>db.prepare(q).all(...p)},executableOnPath);
    const commands=Object.fromEntries(['codex','claude'].map(id=>[id,adapters.command(id)]));
    const claudePath=join(homedir(),'.claude/settings.json'),claude=existsSync(claudePath)?JSON.parse(readFileSync(claudePath,'utf8')):{};
    return {commands,claude:{baseUrl:claude.env?.ANTHROPIC_BASE_URL,model:claude.env?.ANTHROPIC_MODEL??claude.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,hasCredential:!!(claude.env?.ANTHROPIC_AUTH_TOKEN??claude.env?.ANTHROPIC_API_KEY)},versions:Object.fromEntries(Object.entries(commands).map(([id,command])=>[id,command?execFileSync(command.executable,[...command.prefix,'--version'],{encoding:'utf8',windowsHide:true,timeout:15000}).trim():null]))};
  }finally{db.close();}
}

export function previousReservation(root=resolve('.tmp/evaluation')){
  const baseline=JSON.parse(readFileSync('协作/验收数据/2026-11-02-openjudge-implementation/budget-history.json','utf8'));
  const later=existsSync(root)?readdirSync(root).filter(n=>n.startsWith('native-')).flatMap(n=>{const path=join(root,n,'budget.json');return existsSync(path)?[{path,...JSON.parse(readFileSync(path,'utf8'))}]:[];}):[];
  return {baselineReservedCny:baseline.reservedCny,later,reservedCny:baseline.reservedCny+later.reduce((n,b)=>n+b.reservedCny,0)};
}

export function allocateNativeBudget(previous,workerUpperBound){
  const workerReservation=Math.max(0,workerUpperBound-previous.later.reduce((n,b)=>n+(b.workerReservationCny??0),0));
  const remaining=20-previous.reservedCny-workerReservation;
  if(remaining<=0)throw new Error('Cumulative 20 CNY reservation exhausted');
  return {workerReservation,remaining};
}

export async function main(argv=process.argv.slice(2)){
  const feeIndex=argv.indexOf('--workers-max-cny'),workerUpperBound=feeIndex<0?0:Number(argv[feeIndex+1]);
  if(argv.some((arg,i)=>!(feeIndex>=0&&i===feeIndex+1)&&!['--inspect','--approve-cost','--workers-included','--workers-max-cny','--stop-only'].includes(arg)))throw new Error('Unknown native evaluation option');
  const inspection=inspectNative();
  if(argv.includes('--inspect')){console.log(JSON.stringify({...inspection,budget:previousReservation(),workerBilling:'UNKNOWN; no inference sent'}));return 0;}
  if(!argv.includes('--approve-cost')||!argv.includes('--workers-included')&&!(workerUpperBound>0&&workerUpperBound<=20))throw new Error('Requires explicit cost approval and confirmation that configured worker relay calls are included or have an operator-declared upper bound');
  if(!inspection.commands.codex||!inspection.commands.claude||!inspection.claude.hasCredential)throw new Error('Real Codex/Claude executable and explicit Claude provider credential are required');
  loadEnvironment();
  const previous=previousReservation(),{workerReservation,remaining}=allocateNativeBudget(previous,workerUpperBound);
  const settings=configuredModel(join(homedir(),'.apix-agent-os/apix.sqlite'));
  const gateway=await startEvaluationGateway({baseUrl:settings.baseUrl,apiKey:process.env[settings.apiKeyEnv],model:'deepseek-v4.1-flash-1017',maxCny:remaining,maxRequests:6});
  const parent=resolve('.tmp/evaluation');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'native-'));
  const claudeSettings=JSON.parse(readFileSync(join(homedir(),'.claude/settings.json'),'utf8')),claudeEnv=claudeSettings.env;
  const protectedValues=[...Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v).map(([,v])=>v),claudeEnv.ANTHROPIC_AUTH_TOKEN,claudeEnv.ANTHROPIC_API_KEY].filter(Boolean);
  const save=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(redactEvidence(value,protectedValues),null,2));
  const checks=[],evidence={runs:[],deliveries:[],sessions:[]};let h,session,stage='startup';
  const check=(id,actual,expected,refs=[])=>{const item=assertion(id,actual,expected,refs);checks.push(item);assert.equal(item.status,'pass',id+': '+JSON.stringify(actual));};
  const until=async(read,label,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){const result=await read();if(result)return result;await delay(150);}throw new Error('deadline: '+label);};
  const events=async runId=>{const items=[];let cursor;for(;;){const p=await h.request('/api/runs/'+runId+'/runtime-events?limit=200'+(cursor?'&afterId='+cursor:''));items.push(...p.items);if(!p.hasMore)break;cursor=p.nextCursor;}return items;};
  const captureRun=async runId=>{const runtime=await h.request('/api/runs/'+runId+'/runtime'),trace=await events(runId);const result={runId,runtime,events:trace};evidence.runs.push(result);return result;};
  const details=id=>h.request('/api/tasks/'+id+'/details');
  const completed=async id=>until(async()=>{await answerQuestions(id);const d=await details(id);if(['failed','unknown','cancelled','blocked'].includes(d.task.status))throw new Error('task '+d.task.status+': '+d.task.result);return d.task.status==='completed'&&d;},'task completion');
  const approve=async id=>{const d=await h.request('/api/tasks/'+id+'/delivery');evidence.deliveries.push(d);await h.request('/api/tasks/'+id+'/review',{accepted:true,fingerprint:d.inspection.fingerprint});return d;};
  const resume=async id=>{const before=await details(id);await h.request('/api/tasks/'+id+'/review',{accepted:false});const inspected=await h.request('/api/tasks/'+id+'/delivery'),s=await h.request('/api/coordination/sessions/'+session.id);await h.request('/api/tasks/'+id+'/recovery',{revision:s.revision,runId:before.runs[0].id,fingerprint:inspected.recoveryFingerprint,reviewed:true,employeeId:before.task.employee_id,continuation:'native',resumeFromRunId:before.runs[0].id});const d=await completed(id);check('native-resume-new-run-'+before.task.runtime,d.runs.length,before.runs.length+1,[id]);await captureRun(d.runs[0].id);};
  async function answerQuestions(taskId){
    const d=await details(taskId),runId=d.runs[0]?.id;if(!runId)return;
    for(const item of await h.request('/api/runs/'+runId+'/interactions'))if(item.state==='pending'){
      if(item.kind!=='question')throw new Error('Unexpected tool approval: '+JSON.stringify(item.request));
      const answers=Object.fromEntries(item.request.questions.map(q=>[q.id??q.question,item.request.answerFormat==='claude'?'仅核验隔离项目，继续执行现有 Node 检查':{answers:['仅核验隔离项目']} ]));
      await h.request('/api/runs/'+runId+'/interactions/'+item.id+'/answer',{requestId:'answer:'+item.id,expectedPermissionVersion:item.permissionVersion,answer:{answers}});
      check('question-answered-'+item.id,true,true,[runId,item.id]);
    }
  }
  let failure;
  try{
    h=await startDeliveryFixture({legacy:true,startupMs:30000,requestMs:30000,name:'真实 Codex Claude 原生工具协作',runtimeEntries:{APIX_CODEX_ENTRY:inspection.commands.codex.prefix[0]??inspection.commands.codex.executable,APIX_CLAUDE_ENTRY:inspection.commands.claude.prefix[0]??inspection.commands.claude.executable},setup:async project=>{
      for(const [path,content] of Object.entries({'README.md':'user-owned baseline\n','sum.mjs':'export const sum=(a,b)=>a-b; // BUG\n','verify.mjs':"throw new Error('TODO: replace with real assertions');\n"}))writeFileSync(join(project,path),content);
      for(const args of [['init'],['config','core.autocrlf','false'],['config','user.name','ApiX Native Evaluation'],['config','user.email','test@example.invalid'],['add','README.md','sum.mjs','verify.mjs'],['commit','-m','baseline']])execFileSync('git',args,{cwd:project,windowsHide:true,stdio:'ignore'});
    }});
    await h.request('/api/manager/settings',{baseUrl:gateway.baseUrl,model:gateway.model,apiType:'openai-completions',apiKeyEnv:''});
    const codex=(await h.request('/api/employees',{runtime:'codex',name:'真实 Codex',role:'实现与集成'})).id,claude=(await h.request('/api/employees',{runtime:'claude',name:'真实 Claude',role:'测试与审查'})).id;
    for(const [id,backend] of [[codex,'codex-app-server'],[claude,'claude-agent-sdk']]){await h.request('/api/employees/'+id+'/runtime-settings',{expectedVersion:0,backend,acknowledgeExperimental:true});await h.request('/api/permissions',{projectId:h.projectId,subject:id,mode:'ask_approval',version:0});}
    const provider=await h.request('/api/agent-providers',{name:'本机 Claude 独立测试通道',version:0,apiType:'anthropic-messages',baseUrl:inspection.claude.baseUrl,model:inspection.claude.model,apiKey:claudeEnv.ANTHROPIC_AUTH_TOKEN??claudeEnv.ANTHROPIC_API_KEY,authHeader:claudeEnv.ANTHROPIC_AUTH_TOKEN?'bearer':'default'});
    const binding=(await h.request('/api/agent-providers')).agents.find(a=>a.id===claude);await h.request('/api/agent-providers/bind',{agentId:claude,providerId:provider.id,providerVersion:provider.version,version:binding.version});
    const baseScope='只允许读写当前隔离项目；禁止联网、安装、读凭据、Git 提交和启动额外 Agent。';
    if(!argv.includes('--stop-only')){
    const nonce='GUIDED_'+randomUUID().slice(0,10);
    const steps=[
      {employeeId:codex,dependsOn:[],prompt:baseScope+'读取 README.md；搜索 sum.mjs 的 BUG，用文件编辑工具修复加法。首次运行先用 PowerShell Start-Sleep -Seconds 8 给宿主发送指导留时间，再实际用 node 验证负数/零/小数，创建 codex-note.txt。若这是原生延续且修复已完成，复验即可，不要再次等待。'},
      {employeeId:claude,dependsOn:[0],prompt:baseScope+'使用 Read 读取 sum.mjs 和 verify.mjs，用 Glob 或 Grep 定位 TODO，再用 Edit 将 verify.mjs 改为 node:assert/strict 的加法测试（正负/零/小数），用 Write 创建 review.md，Bash 实际执行 node verify.mjs。首次执行先调用 AskUserQuestion 询问核验范围，宿主将回答并排队补充指导；后续指导请更新 review.md 加入指定标识。原生延续时核对并复验已有产物即可。不要声称人工批准。'},
      {employeeId:codex,dependsOn:[1],prompt:baseScope+'读取 sum.mjs、verify.mjs、review.md、codex-note.txt；实际执行 node verify.mjs，创建 integration.md 记录实际验证输出与未验证项，不修改其他文件。'}
    ];
    session=await h.request('/api/coordination/sessions',{projectId:h.projectId,goal:'真实 Codex 实现、Claude 工具核验、Codex 集成。'+JSON.stringify(steps)});const base='/api/coordination/sessions/'+session.id;
    for(const [field,value] of Object.entries({scope:'只操作隔离测试项目',constraints:baseScope,deliverable:'加法修复、验证脚本、审查和集成记录',acceptance:'实际工具调用、宿主隐藏输入检查、指导生效、原生延续、停止与冻结交接'}))session=await h.request(base+'/answers',{revision:session.revision,field,value});
    stage='manager-plan';session=await h.request(base+'/confirm',{revision:session.revision});check('deepseek-manager-real',session.agent.mode,'api',[session.id]);session=await h.request(base+'/plan',{revision:session.revision,planVersion:session.planVersion,steps});
    for(const id of [codex,claude])await h.request('/api/permissions',{projectId:h.projectId,subject:id,mode:'full_access',version:1});
    session=await h.request(base+'/dispatch',{planVersion:session.planVersion});check('dispatch',session.failures.length,0);
    const ids=session.tasks.map(t=>t.id);stage='codex-tools';
    const first=await until(async()=>{const d=await details(ids[0]);if(['failed','unknown'].includes(d.task.status))throw new Error(d.task.result);const id=d.runs[0]?.id;return id&&(await events(id)).some(e=>JSON.stringify(e).includes('tool.started'))&&d;},'Codex first actual tool');
    await h.request('/api/runs/'+first.runs[0].id+'/messages',{requestId:'steer:'+nonce,mode:'steer',content:'额外验收：codex-note.txt 必须精确包含 '+nonce+'。'});
    let d=await completed(ids[0]);const codexRun=await captureRun(d.runs[0].id);
    check('codex-real-command-tool',codexRun.events.some(e=>e.kind==='tool.started'&&e.payload.name==='commandExecution'),true,[codexRun.runId]);
    check('codex-real-file-tool',codexRun.events.some(e=>e.kind==='tool.started'&&e.payload.name==='fileChange'),true,[codexRun.runId]);
    check('codex-steer-processed',codexRun.runtime.deliveries.some(x=>x.state==='processed'),true,[codexRun.runId]);
    check('claude-waits-for-codex-acceptance',(await h.request(base)).tasks[1].status,'queued',[ids[1]]);
    stage='codex-native-resume';await resume(ids[0]);const firstDelivery=await h.request('/api/tasks/'+ids[0]+'/delivery');check('codex-steer-effect',readFileSync(join(firstDelivery.workspacePath,'codex-note.txt'),'utf8').includes(nonce),true,[ids[0]]);await approve(ids[0]);
    stage='claude-tools';
    const waiting=await until(async()=>{const x=await details(ids[1]);if(['failed','unknown'].includes(x.task.status))throw new Error(x.task.result);const id=x.runs[0]?.id;return id&&(await h.request('/api/runs/'+id+'/interactions')).some(q=>q.kind==='question'&&q.state==='pending')&&x;},'Claude native question');
    const queued=await h.request('/api/runs/'+waiting.runs[0].id+'/messages',{requestId:'queue:'+nonce,mode:'queue',content:'补充指导：核验后在 review.md 中加入 '+nonce+'，保留事实和未验证项。'});check('claude-guidance-queued',queued.delivery,'queued',[waiting.runs[0].id]);
    d=await completed(ids[1]);const claudeRun=await captureRun(d.runs[0].id),toolNames=new Set(claudeRun.events.filter(e=>e.kind==='tool.started').map(e=>e.payload.name));
    check('claude-real-read-edit-write-command',['Read','Edit','Write','Bash'].every(name=>toolNames.has(name)),true,[claudeRun.runId]);check('claude-real-search',toolNames.has('Glob')||toolNames.has('Grep'),true,[claudeRun.runId]);check('claude-queue-processed',claudeRun.runtime.deliveries.some(x=>x.state==='processed'),true,[claudeRun.runId]);
    stage='claude-native-resume';await resume(ids[1]);const secondDelivery=await h.request('/api/tasks/'+ids[1]+'/delivery');check('claude-guidance-effect',readFileSync(join(secondDelivery.workspacePath,'review.md'),'utf8').includes(nonce),true,[ids[1]]);await approve(ids[1]);
    stage='integration';d=await completed(ids[2]);await captureRun(d.runs[0].id);const finalDelivery=await approve(ids[2]);
    execFileSync(process.execPath,['--input-type=module','--eval',"import assert from 'node:assert/strict';import{sum}from'./sum.mjs';for(const[a,b]of[[13,29],[-13,5],[0,0],[.25,.5]])assert.equal(sum(a,b),a+b);"],{cwd:finalDelivery.workspacePath,windowsHide:true,timeout:5000});check('host-hidden-inputs',true,true,[ids[2]]);check('user-baseline-preserved',readFileSync(join(finalDelivery.workspacePath,'README.md'),'utf8'),'user-owned baseline\n');check('integration-report-present',existsSync(join(finalDelivery.workspacePath,'integration.md')),true);
    session=await h.request(base);check('all-accepted',session.tasks.map(t=>t.status),['accepted','accepted','accepted']);await h.restart();check('restart-preserves-completion',(await h.request(base)).derivedStatus,'completed');
    }
    if(argv.includes('--stop-only'))for(const id of [codex,claude])await h.request('/api/permissions',{projectId:h.projectId,subject:id,mode:'full_access',version:1});
    for(const [id,runtime] of [[codex,'codex'],[claude,'claude']]){
      for(const name of ['stop-started.txt','should-not-exist.txt'])assert.equal(existsSync(join(h.project,name)),false,'stop marker must start absent');
      stage='stop-'+runtime;const t=await h.request('/api/tasks',{projectId:h.projectId,employeeId:id,prompt:baseScope+"只执行一次 PowerShell 命令：创建 stop-started.txt，然后 Start-Sleep -Seconds 90，最后创建 should-not-exist.txt。不要后台启动；宿主会在等待时停止。"});await h.request('/api/approvals/'+t.approvalId,{approved:true});
      const started=await until(async()=>{const x=await details(t.taskId),path=x.task.workspace_path??h.project;return existsSync(join(path,'stop-started.txt'))&&x;},'stop command started');await h.request('/api/runs/'+started.runs[0].id+'/stop',{});await until(async()=>['cancelled','unknown'].includes((await details(t.taskId)).task.status),'stop complete');const run=await captureRun(started.runs[0].id);check('stop-evidence-'+runtime,run.runtime.stopEvidence,'quiescent',[run.runId]);await delay(1000);check('no-late-write-'+runtime,existsSync(join(started.task.workspace_path??h.project,'should-not-exist.txt')),false,[run.runId]);
      unlinkSync(join(started.task.workspace_path??h.project,'stop-started.txt'));
    }
    check('no-fake-model-calls',h.calls.length,0);if(session)evidence.sessions.push(await h.request('/api/coordination/sessions/'+session.id));stage='complete';
  }catch(error){failure={stage,message:error.message};}
  finally{
    if(h){
      try{
        for(const run of (await h.request('/api/snapshot')).runs.filter(r=>['running','starting','stopping'].includes(r.status)))await h.request('/api/runs/'+run.id+'/stop',{});
        await until(async()=>!(await h.request('/api/snapshot')).runs.some(r=>['running','starting','stopping'].includes(r.status)),'cleanup',20000);
        for(const run of (await h.request('/api/snapshot')).runs)if(!evidence.runs.some(saved=>saved.runId===run.id))await captureRun(run.id);
        if(session)evidence.sessions.push(await h.request('/api/coordination/sessions/'+session.id));
      }catch(error){failure??={stage:'cleanup',message:error.message};}
      try{await h.close(true);}catch(error){failure??={stage:'cleanup',message:error.message};}
    }
    save('budget.json',{...gateway.summary(),reservedCny:gateway.summary().reservedCny+workerReservation,managerReservedCny:gateway.summary().reservedCny,workerUpperBoundCny:workerUpperBound,workerReservationCny:workerReservation,previousReservedCny:previous.reservedCny,cumulativeReservedCny:previous.reservedCny+gateway.summary().reservedCny+workerReservation,workerBilling:workerUpperBound?'operator_declared_upper_bound_not_a_metered_bill':'included_without_incremental_charge_confirmed_by_operator',workerActualBilledCny:null});await gateway.close();
  }
  if(failure)checks.push(assertion('execution-complete',failure.stage,'complete'));
  const record={schemaVersion:1,caseId:argv.includes('--stop-only')?'native-codex-claude-stop':'native-codex-claude',attemptId:digest(directory).slice(0,16),status:caseStatus(checks),runType:'real-native',assertions:checks,events:evidence.runs.flatMap(r=>r.events),semanticStatus:'not_run'};
  save('evidence.json',evidence);save('result.json',{status:record.status,stage,failure,inspection,checks,directory,fixtureDirectory:h?.dir??null});save('findings.json',findingsFor(record));writeFileSync(join(directory,'cases.jsonl'),JSON.stringify(redactEvidence(record,protectedValues))+'\n');
  const python=resolve('.tmp/evaluation/openjudge/venv/Scripts/python.exe');const code=await new Promise((done,reject)=>{const child=spawn(python,['scripts/evaluation/openjudge/evaluate.py','--input',join(directory,'cases.jsonl'),'--output',join(directory,'scores.json')],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('close',done);});
  console.log(JSON.stringify({status:record.status,directory,failure:redactEvidence(failure,protectedValues),gradingExitCode:code}));return record.status==='pass'&&code===0?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>process.exitCode=code).catch(error=>{console.error(error.message);process.exitCode=1;});
