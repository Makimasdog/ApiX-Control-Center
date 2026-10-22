import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {realpathSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {type Store,type Task,type Employee,object,text} from './contracts.js';
import {autonomyDefaults,parseAutonomyPolicy,parseArchitecture,type AutonomyPolicy,type Architecture,type CheckCommand} from './architecture.js';
import type {Permissions} from './permissions.js';
import type {Scheduling} from './scheduling.js';

interface PlanRecord {plan_id:string;session_id:string;revision:number;policy_version:number;workflow_version:number;body:string;state:string;started_at:string|null;reason:string|null}
interface ManagedTask extends Task {workspace_path:string|null;result:string|null}
interface Inspection {fingerprint:string|null;files:string[];conflicts:string[];preview:string;previewTruncated?:boolean;context?:{files:{path:string;content:string}[];truncated:boolean}}
interface Dependencies extends Store {
  permissions:Permissions;scheduling:Scheduling;employees():Employee[];
  workflow(projectId:string):{enabled:boolean;version:number;employeeIds:string[]};
  inspect(task:ManagedTask):Promise<Inspection>;
  workspace(task:ManagedTask):string;
  accept(id:string,fingerprint:string):void;
  review(projectId:string,sessionId:string,architecture:Architecture,moduleId:string,evidence:unknown):Promise<{passed:boolean;findings:string[];reviewMode:string}>;
  retry(task:ManagedTask,employeeId:string,prompt:string):Promise<void>;
  reassignPending(taskId:string,employeeId:string):void;
  activatePending?(planId:string):void;
  delivered?(sessionId:string,planId:string):void;
  stop(runId:string):void;
  sendMessage(input:Record<string,unknown>):{id:string;status:string};
  record(taskId:string,kind:string,payload:unknown):void;
}
export function createAutonomy(deps:Dependencies) {
  const {db,row,rows,now}=deps;const busy=new Set<string>();const stopping=new Set<string>();const validatedContracts=new Map<string,string>();
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_policies(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_plans(plan_id TEXT PRIMARY KEY REFERENCES plans(id),session_id TEXT NOT NULL,revision INTEGER NOT NULL,policy_version INTEGER NOT NULL,workflow_version INTEGER NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),module_id TEXT NOT NULL,original_prompt TEXT NOT NULL,repairs INTEGER NOT NULL DEFAULT 0,last_checkpoint TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_checks(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT,status TEXT NOT NULL,fingerprint TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_repairs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,employee_id TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);`);
  if(!rows<{name:string}>('PRAGMA table_info(autonomy_repairs)').some(c=>c.name==='run_id'))db.exec('ALTER TABLE autonomy_repairs ADD COLUMN run_id TEXT');
  // An interrupted verification may have left an external test process. Never silently replay it.
  db.prepare("UPDATE autonomy_checks SET status='interrupted' WHERE status='running'").run();
  db.prepare("UPDATE autonomy_plans SET state='attention',reason='服务重启中断了验证；请确认验收进程已停止并重新检查后恢复' WHERE plan_id IN (SELECT t.plan_id FROM autonomy_tasks a JOIN tasks t ON t.id=a.task_id JOIN autonomy_checks c ON c.task_id=t.id WHERE c.status='interrupted')").run();
  function settings(projectId:string):AutonomyPolicy {
    if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');
    const saved=row<{body:string}>('SELECT body FROM autonomy_policies WHERE project_id=?',projectId);return saved?JSON.parse(saved.body):{...autonomyDefaults,checks:[]};
  }
  function save(projectId:string,input:Record<string,unknown>) {
    const previous=settings(projectId);if(input.version!==previous.version)throw new Error('自主交付策略已变化，请刷新');
    if(input.enabled===false){const policy={...previous,enabled:false,version:previous.version+1};db.prepare('INSERT INTO autonomy_policies VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(policy));return policy;}
    if(input.approved!==true)throw new Error('自主交付需要明确批准验收命令、返工范围与费用');
    if(rows("SELECT id FROM tasks WHERE project_id=? AND status IN ('running','starting','stopping','unknown','queued','awaiting_approval','completed','needs_revision','failed','blocked') AND plan_id IN (SELECT plan_id FROM autonomy_plans WHERE state!='completed')",projectId).length || row("SELECT id FROM tasks WHERE project_id=? AND status IN ('running','stopping','unknown','queued') LIMIT 1",projectId))throw new Error('请先停止或处理当前工作，再更改自主交付策略');
    const workflow=deps.workflow(projectId);if(!workflow.enabled || deps.permissions.get(projectId).mode!=='full_access')throw new Error('请先开启项目自动协作并授权 ApiX');
    const policy=parseAutonomyPolicy(input,previous.version+1);
    db.prepare('INSERT INTO autonomy_policies VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(policy));return policy;
  }
  function bindPlan(planId:string,sessionId:string,revision:number,architecture:Architecture,steps:{taskId:string;moduleId:string;prompt:string}[]) {
    const project=row<{project_id:string}>('SELECT project_id FROM plans WHERE id=?',planId)!;const policy=settings(project.project_id);const workflow=deps.workflow(project.project_id);
    db.prepare('INSERT INTO autonomy_plans VALUES (?,?,?,?,?,?,?,?,?)').run(planId,sessionId,revision,policy.version,workflow.version,JSON.stringify(architecture),'ready',null,null);
    for(const step of steps)db.prepare('INSERT INTO autonomy_tasks(task_id,module_id,original_prompt) VALUES (?,?,?)').run(step.taskId,step.moduleId,step.prompt);
  }
  function details(planId:string|null){if(!planId)return null;const plan=row<PlanRecord>('SELECT * FROM autonomy_plans WHERE plan_id=?',planId);return plan?{...plan,architecture:JSON.parse(plan.body) as Architecture,body:undefined,tasks:rows('SELECT a.* FROM autonomy_tasks a JOIN tasks t ON t.id=a.task_id WHERE t.plan_id=?',planId),checks:rows<{body:string}>('SELECT c.* FROM autonomy_checks c JOIN tasks t ON t.id=c.task_id WHERE t.plan_id=? ORDER BY c.rowid DESC LIMIT 100',planId).map(c=>({...c,body:JSON.parse(c.body)})),repairs:rows('SELECT r.* FROM autonomy_repairs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? ORDER BY r.rowid',planId)}:null;}
  function resumeFingerprint(planId:string){return createHash('sha256').update(JSON.stringify({plan:row('SELECT * FROM autonomy_plans WHERE plan_id=?',planId),tasks:rows('SELECT id,status,prompt,employee_id,updated_at FROM tasks WHERE plan_id=? ORDER BY rowid',planId),runs:rows('SELECT r.id,r.status,r.ended_at FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? ORDER BY r.rowid',planId)})).digest('hex');}
  function resume(planId:string,input:Record<string,unknown>){const plan=row<PlanRecord>('SELECT * FROM autonomy_plans WHERE plan_id=?',planId);if(!plan || plan.state!=='attention' || busy.has(planId) || input.reviewed!==true || input.fingerprint!==resumeFingerprint(planId))throw new Error('请检查当前自主交付状态再恢复');const project=row<{project_id:string}>('SELECT project_id FROM plans WHERE id=?',planId)!;current(plan,project.project_id);if(rows("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status IN ('unknown','running','starting','stopping')",planId).length)throw new Error('请先停止或恢复原员工运行');if(row("SELECT c.id FROM autonomy_checks c JOIN tasks t ON t.id=c.task_id WHERE t.plan_id=? AND c.status='interrupted' LIMIT 1",planId) && input.confirmedStopped!==true)throw new Error('验证进程状态未知，须确认已停止后恢复');for(const task of rows<ManagedTask>("SELECT * FROM tasks WHERE plan_id=? AND status NOT IN ('accepted','cancelled')",planId))deps.permissions.assertGranted(task.id,task.project_id,task.employee_id);if(input.confirmedStopped===true)db.prepare("UPDATE autonomy_checks SET status='interrupted_resolved',body=json_set(body,'$.stopConfirmation','user','$.stopConfirmedAt',?) WHERE task_id IN (SELECT id FROM tasks WHERE plan_id=?) AND status='interrupted'").run(now(),planId);db.prepare("UPDATE autonomy_plans SET state='running',reason=NULL WHERE plan_id=?").run(planId);try{deps.activatePending?.(planId);}catch(error){halt(plan,String(error instanceof Error?error.message:error));throw error;}}
  function current(plan:PlanRecord,projectId:string) {
    const policy=settings(projectId);const workflow=deps.workflow(projectId);const session=row<{plan_id:string;revision:number;confirmed_revision:number|null;status:string}>('SELECT * FROM coordination_sessions WHERE id=?',plan.session_id);
    if(!policy.enabled || policy.version!==plan.policy_version || !workflow.enabled || workflow.version!==plan.workflow_version || !session || session.plan_id!==plan.plan_id || session.revision!==plan.revision || session.confirmed_revision!==plan.revision || !['running','plan_review'].includes(session.status))throw new Error('自主交付的策略、需求或自动协作授权已变化');
    if(deps.permissions.get(projectId).mode!=='full_access')throw new Error('ApiX 自主交付权限已撤销');
    if(validatedContracts.get(plan.plan_id)!==plan.body){const saved=object(JSON.parse(plan.body));const checked=parseArchitecture(saved,policy.checks);if(saved.digest!==checked.digest)throw new Error('冻结契约摘要不一致，请重新规划');validatedContracts.set(plan.plan_id,plan.body);}return policy;
  }
  function assertPlan(planId:string,projectId:string){const plan=row<PlanRecord>('SELECT * FROM autonomy_plans WHERE plan_id=?',planId);if(!plan)return;current(plan,projectId);if(plan.state==='attention')throw new Error(plan.reason??'自主交付需要处理');}
  function context(taskId:string){const saved=row<{module_id:string;body:string}>('SELECT a.module_id,p.body FROM autonomy_tasks a JOIN tasks t ON t.id=a.task_id JOIN autonomy_plans p ON p.plan_id=t.plan_id WHERE a.task_id=?',taskId);return saved?`统一架构契约（所有员工必须遵守，禁止自行扩大模块边界；变更接口须 ApiX 重新规划）：\n${saved.body}\n当前模块：${saved.module_id}`:'';}
  function halt(plan:PlanRecord,reason:string){validatedContracts.delete(plan.plan_id);if(row<{state:string;reason:string}>('SELECT state,reason FROM autonomy_plans WHERE plan_id=?',plan.plan_id)?.reason===reason)return;db.prepare("UPDATE autonomy_plans SET state='attention',reason=? WHERE plan_id=?").run(reason,plan.plan_id);for(const t of rows<{id:string}>('SELECT id FROM tasks WHERE plan_id=?',plan.plan_id))deps.record(t.id,'autonomy.attention',{reason});for(const run of rows<{id:string;task_id:string}>("SELECT r.id,r.task_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status='running'",plan.plan_id)){try{deps.stop(run.id);}catch(error){deps.record(run.task_id,'autonomy.stop_failed',{runId:run.id,error:String(error)});}}}
  function taskCurrent(plan:PlanRecord,task:ManagedTask,policy:AutonomyPolicy){current(plan,task.project_id);const fresh=row<ManagedTask>('SELECT * FROM tasks WHERE id=?',task.id);if(!fresh || fresh.employee_id!==task.employee_id || fresh.status!==task.status || fresh.prompt!==task.prompt)throw new Error('检查期间任务已变化');if(!deps.workflow(task.project_id).employeeIds.includes(task.employee_id) || deps.permissions.decision(task.project_id,task.employee_id)!=='allow')throw new Error('员工不在自主交付授权范围');deps.permissions.assertGranted(task.id,task.project_id,task.employee_id);if(task.status!=='queued')deps.scheduling.assertBinding(task.id,task.project_id,task.employee_id);if(plan.started_at && Date.now()-Date.parse(plan.started_at)>policy.maxMinutes*60000)throw new Error('自主交付已达到目标时间上限');}
  function redact(value:string){let result=value;for(const [key,secret] of Object.entries(process.env))if(/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)&&secret&&secret.length>=6)result=result.split(secret).join('<redacted>');return result;}
  async function execute(check:CheckCommand,cwd:string,guard:()=>void,onSpawn:(pid:number|undefined)=>void) {
    const script=realpathSync.native(resolve(cwd,check.args[0]!));const rel=relative(realpathSync.native(cwd),script);if(rel.startsWith('..') || isAbsolute(rel))throw new Error('验收脚本通过路径或链接越过工作区');
    const env={...process.env};for(const key of Object.keys(env))if(/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)||key.startsWith('APIX_'))delete env[key];
    return await new Promise<{id:string;args:string[];exitCode:number|null;signal:string|null;output:string;timedOut:boolean;durationMs:number}>((done,reject)=>{
      const start=Date.now();let output='';let timedOut=false;let failure:Error|null=null;let killed=false;let settled=false;let uncertainTimer:ReturnType<typeof setTimeout>|undefined;
      const child=spawn(process.execPath,[script,...check.args.slice(1)],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      try{onSpawn(child.pid);}catch(error){child.on('error',()=>{});child.kill();reject(error);return;}
      const kill=()=>{if(killed)return;killed=true;if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>{});else child.kill('SIGKILL');uncertainTimer=setTimeout(()=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(watch);child.stdout.destroy();child.stderr.destroy();child.unref();reject(Object.assign(new Error('无法确认验收进程停止；请检查记录的 PID，不能自动重试'),{code:'VERIFICATION_UNKNOWN'}));},6000);};
      const timer=setTimeout(()=>{timedOut=true;kill();},check.timeoutMs);const watch=setInterval(()=>{try{guard();}catch(error){failure=error as Error;kill();}},200);
      const append=(chunk:Buffer)=>{output=(output+chunk.toString('utf8')).slice(-20000);};child.stdout.on('data',append);child.stderr.on('data',append);
      child.once('error',error=>{failure=error;});
      child.once('close',(exitCode,signal)=>{clearTimeout(timer);clearInterval(watch);clearTimeout(uncertainTimer);if(settled)return;settled=true;if(failure){reject(failure);return;}done({id:check.id,args:check.args,exitCode,signal,output:redact(output),timedOut,durationMs:Date.now()-start});});
    });
  }
  function waitingRepair(taskId:string){return row<{id:string;instruction:string}>("SELECT id,instruction FROM autonomy_repairs WHERE task_id=? AND status='waiting' AND run_id IS (SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY rowid DESC LIMIT 1",taskId,taskId);}
  function waitingDependency(task:ManagedTask){
    const ancestors=rows<{id:string;status:string}>("WITH RECURSIVE ancestors(id) AS (SELECT depends_on_id FROM task_dependencies WHERE task_id=? UNION SELECT d.depends_on_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id) SELECT t.id,t.status FROM tasks t JOIN ancestors a ON a.id=t.id",task.id);
    const blocked=[task,...ancestors.filter(t=>t.status==='blocked')];if(blocked.some(t=>row<{result:string|null}>('SELECT result FROM tasks WHERE id=?',t.id)?.result||row('SELECT id FROM runs WHERE task_id=? LIMIT 1',t.id)||row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",t.id)))return false;
    const failures=ancestors.filter(t=>['failed','cancelled','unknown','rejected','needs_revision'].includes(t.status));
    if(failures.length)return failures.every(t=>t.status==='needs_revision'&&waitingRepair(t.id));
    return ancestors.some(t=>row("SELECT id FROM autonomy_repairs WHERE task_id=? AND status='dispatched' LIMIT 1",t.id));
  }
  async function repair(plan:PlanRecord,task:ManagedTask,findings:string[],policy:AutonomyPolicy) {
    taskCurrent(plan,task,policy);const binding=row<{module_id:string;original_prompt:string;repairs:number}>('SELECT * FROM autonomy_tasks WHERE task_id=?',task.id)!;
    if(binding.repairs>=policy.maxRepairs){halt(plan,`任务 ${task.id} 已达到 ${policy.maxRepairs} 次修复上限：${findings.join('；')}`);return;}
    const architecture=JSON.parse(plan.body) as Architecture;const module=architecture.modules.find(m=>m.id===binding.module_id);
    const spec=deps.scheduling.taskSpec(task.id);const next=deps.scheduling.candidates(task.project_id,spec,task.employee_id).filter(c=>c.eligible && deps.workflow(task.project_id).employeeIds.includes(c.employeeId) && deps.permissions.decision(task.project_id,c.employeeId)==='allow');
    const replace=task.status==='failed'||task.status==='cancelled'||binding.repairs>0;
    const pool=policy.autoReassign?next:next.filter(c=>c.employeeId===task.employee_id);
    const chosen=(replace&&policy.autoReassign?pool.find(c=>!c.waiting&&c.employeeId!==task.employee_id):undefined)??pool.find(c=>!c.waiting);
    if(!pool.length){halt(plan,'没有满足能力、额度和权限条件的员工可接手修复');return;}
    const pending=waitingRepair(task.id);
    const prompt=pending?.instruction??`${binding.original_prompt}\n\nApiX 修复任务 ${binding.repairs+1}（保持原需求、模块 ${module?.id??'integration'} 和契约 ${architecture.digest}）：\n${findings.map((f,i)=>`${i+1}. ${f}`).join('\n')}\n保留已完成工作，只修复上述问题并补充实际验证证据。禁止扩大需求、修改授权或自行启动其他 Agent。`;
    if(prompt.length>10000){halt(plan,'修复说明超过任务上下文上限，请精简后重新安排');return;}
    const repairId=pending?.id??randomUUID();
    if(!pending)db.prepare('INSERT INTO autonomy_repairs(id,task_id,attempt,employee_id,instruction,status,created_at,run_id) VALUES (?,?,?,?,?,?,?,?)').run(repairId,task.id,binding.repairs+1,chosen?.employeeId??pool[0]!.employeeId,prompt,chosen?'prepared':'waiting',now(),row<{id:string}>('SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id)?.id??null);
    if(!chosen){db.prepare("UPDATE tasks SET status='needs_revision',updated_at=? WHERE id=?").run(now(),task.id);if(!pending)deps.record(task.id,'autonomy.repair_waiting',{repairId,reasons:pool.map(c=>({employeeId:c.employeeId,waiting:c.waiting}))});return;}
    db.prepare("UPDATE autonomy_repairs SET status='prepared',employee_id=? WHERE id=?").run(chosen.employeeId,repairId);
    try{await deps.retry(task,chosen.employeeId,prompt);db.prepare("UPDATE autonomy_repairs SET status='dispatched' WHERE id=?").run(repairId);db.prepare('UPDATE autonomy_tasks SET repairs=repairs+1,last_checkpoint=NULL WHERE task_id=?').run(task.id);deps.record(task.id,'autonomy.repair_dispatched',{repairId,employeeId:chosen.employeeId,findings});}
    catch(error){db.prepare("UPDATE autonomy_repairs SET status='blocked' WHERE id=?").run(repairId);halt(plan,String(error instanceof Error?error.message:error));}
  }
  async function verify(plan:PlanRecord,task:ManagedTask,policy:AutonomyPolicy) {
    const architecture=JSON.parse(plan.body) as Architecture;const binding=row<{module_id:string}>('SELECT module_id FROM autonomy_tasks WHERE task_id=?',task.id)!;
    const module=architecture.modules.find(m=>m.id===binding.module_id);const checkIds=module?.checkIds??policy.checks.map(c=>c.id);const inspection=await deps.inspect(task);
    if(!inspection.fingerprint || inspection.conflicts.length || inspection.previewTruncated || inspection.context?.truncated)throw new Error('代码冲突、二进制文件或代码超出自动审查范围，需要完整人工检查');
    const latest=row<{id:string}>('SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
    const checkId=randomUUID();db.prepare('INSERT INTO autonomy_checks(id,task_id,run_id,status,fingerprint,body,created_at) VALUES (?,?,?,?,?,?,?)').run(checkId,task.id,latest?.id??null,'running',inspection.fingerprint,'{}',now());
    const tests:Awaited<ReturnType<typeof execute>>[]=[];let completed=false;
    try{
      const cwd=deps.workspace(task);for(const id of checkIds){taskCurrent(plan,task,policy);const check=policy.checks.find(c=>c.id===id);if(!check)throw new Error('契约引用的验收命令未获授权');tests.push(await execute(check,cwd,()=>taskCurrent(plan,task,policy),pid=>db.prepare('UPDATE autonomy_checks SET body=? WHERE id=?').run(JSON.stringify({tests,activeProcess:{pid,cwd,args:check.args,startedAt:now()}}),checkId)));}
      taskCurrent(plan,task,policy);const after=await deps.inspect(task);if(after.fingerprint!==inspection.fingerprint)throw new Error('验收命令修改了交付代码，请检查后重新验证');
      let findings=tests.filter(t=>t.exitCode!==0 || t.timedOut).map(t=>`检查 ${t.id} 失败，退出码 ${t.exitCode}，超时 ${t.timedOut}：${t.output.slice(-4000)}`);
      const paths=module?.paths??architecture.modules.flatMap(m=>m.paths);const normalize=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
      const outside=inspection.files.filter(file=>!paths.some(path=>normalize(file)===normalize(path)||normalize(file).startsWith(normalize(path)+'/')));if(outside.length)findings.push(`交付修改超出冻结模块文件边界：${outside.join('、')}。恢复范围外文件，只保留本模块修改。`);
      let review:{passed:boolean;findings:string[];reviewMode:string}|null=null;
      if(!findings.length){review=await deps.review(task.project_id,plan.session_id,architecture,binding.module_id,{fingerprint:inspection.fingerprint,files:inspection.files,diff:inspection.preview,currentCode:inspection.context,tests});findings=review.findings;}
      taskCurrent(plan,task,policy);if((await deps.inspect(task)).fingerprint!==inspection.fingerprint)throw new Error('审查期间交付代码已变化');taskCurrent(plan,task,policy);
      const passed=!findings.length && review?.passed===true;
      db.prepare('UPDATE autonomy_checks SET status=?,body=? WHERE id=?').run(passed?'passed':'failed',JSON.stringify({tests,review,findings}),checkId);completed=true;
      deps.record(task.id,'autonomy.quality_checked',{checkId,passed,tests,review});
      if(passed){deps.accept(task.id,inspection.fingerprint);return;}
      db.prepare("UPDATE tasks SET status='needs_revision',updated_at=? WHERE id=? AND status='completed'").run(now(),task.id);
      await repair(plan,row<ManagedTask>('SELECT * FROM tasks WHERE id=?',task.id)!,findings,policy);
    }catch(error){if(!completed){const uncertain=(error as {code?:string}).code==='VERIFICATION_UNKNOWN';const previous=row<{body:string}>('SELECT body FROM autonomy_checks WHERE id=?',checkId)!;db.prepare('UPDATE autonomy_checks SET status=?,body=? WHERE id=?').run(uncertain?'interrupted':'error',JSON.stringify({...JSON.parse(previous.body),tests,error:redact(String(error instanceof Error?error.message:error))}),checkId);}throw error;}
  }
  async function tick() {
    for(const plan of rows<PlanRecord>("SELECT * FROM autonomy_plans WHERE state IN ('ready','running')")){
      if(busy.has(plan.plan_id))continue;const tasks=rows<ManagedTask>('SELECT * FROM tasks WHERE plan_id=? ORDER BY rowid',plan.plan_id);const projectId=tasks[0]?.project_id;if(!projectId)continue;
      const session=row<{status:string}>('SELECT status FROM coordination_sessions WHERE id=?',plan.session_id);if(session?.status==='plan_review')continue;
      busy.add(plan.plan_id);
      try{
        const policy=current(plan,projectId);if(!plan.started_at){plan.started_at=now();db.prepare("UPDATE autonomy_plans SET state='running',started_at=? WHERE plan_id=?").run(plan.started_at,plan.plan_id);}
        if(Date.now()-Date.parse(plan.started_at)>policy.maxMinutes*60000){for(const run of rows<{id:string}>("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status='running'",plan.plan_id))deps.stop(run.id);throw new Error('自主交付达到目标时间上限，已请求停止员工');}
        for(const snapshot of tasks){
          if(row<{state:string}>('SELECT state FROM autonomy_plans WHERE plan_id=?',plan.plan_id)?.state==='attention')break;
          const task=row<ManagedTask>('SELECT * FROM tasks WHERE id=?',snapshot.id)!;
          const binding=row<{module_id:string;last_checkpoint:string|null}>('SELECT * FROM autonomy_tasks WHERE task_id=?',task.id);if(!binding)throw new Error('计划包含未绑定架构契约的任务');
          if(task.status==='completed'){taskCurrent(plan,task,policy);await verify(plan,task,policy);}
          else if(task.status==='failed' || task.status==='cancelled')await repair(plan,task,[`员工运行 ${task.status}：${redact(task.result??'无输出，请检查错误并补齐证据')}`],policy);
          else if(task.status==='needs_revision' && waitingRepair(task.id))await repair(plan,task,[],policy);
          else if(task.status==='blocked' && waitingDependency(task))continue;
          else if(task.status==='unknown' || task.status==='needs_revision' || task.status==='blocked')throw new Error(`任务 ${task.id} 为 ${task.status}，需要检查进程、代码交接或人工拒绝原因`);
          else if(task.status==='queued' && policy.autoReassign && !row('SELECT id FROM runs WHERE task_id=? LIMIT 1',task.id)){
            taskCurrent(plan,task,policy);const options=deps.scheduling.candidates(projectId,deps.scheduling.taskSpec(task.id),task.employee_id);const assigned=options.find(c=>c.employeeId===task.employee_id);
            if(!assigned?.eligible || assigned.waiting){const alternative=options.find(c=>c.eligible&&!c.waiting&&c.employeeId!==task.employee_id&&deps.workflow(projectId).employeeIds.includes(c.employeeId)&&deps.permissions.decision(projectId,c.employeeId)==='allow');if(alternative)deps.reassignPending(task.id,alternative.employeeId);}
          }
          else if(task.status==='running'){
            taskCurrent(plan,task,policy);const run=row<{id:string;started_at:string}>('SELECT id,started_at FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id)!;
            if(Date.now()-Date.parse(run.started_at)>policy.maxRunMinutes*60000){if(!stopping.has(run.id)){stopping.add(run.id);deps.record(task.id,'autonomy.timeout',{runId:run.id});deps.stop(run.id);}continue;}
            const architecture=JSON.parse(plan.body) as Architecture;const risk=architecture.modules.find(m=>m.id===binding.module_id)?.risk??'high';const interval=policy.checkpointMinutes*60000*(risk==='high'?0.5:risk==='low'?2:1);
            if(Date.now()-Date.parse(binding.last_checkpoint??run.started_at)>=interval){
              const latest=row<{payload:string}>('SELECT payload FROM agent_messages WHERE task_id=? AND from_agent=? AND created_at>=? AND type=\'event\' ORDER BY rowid DESC LIMIT 1',task.id,task.employee_id,run.started_at);let blocked=false;if(latest){try{blocked=object(JSON.parse(latest.payload)).blocked===true;}catch{}}
              if(blocked){if(!stopping.has(run.id)){stopping.add(run.id);deps.record(task.id,'autonomy.blocked_stop',{runId:run.id});deps.stop(run.id);}continue;}
              const recent=rows<{status:string;created_at:string;payload:string}>('SELECT status,created_at,payload FROM agent_messages WHERE target_task_id=? AND target_run_id=? AND from_agent=\'apix-director\' AND type=\'event\' ORDER BY rowid DESC LIMIT 3',task.id,run.id).filter(m=>{try{return object(JSON.parse(m.payload)).risk!==undefined;}catch{return false;}});
              if(recent.length>=2 && recent.slice(0,2).every(m=>m.status!=='completed' && Date.now()-Date.parse(m.created_at)>=interval)) {if(!stopping.has(run.id)){stopping.add(run.id);deps.record(task.id,'autonomy.unresponsive_stop',{runId:run.id});deps.stop(run.id);}continue;}
              const sent=deps.sendMessage({projectId,taskId:task.id,from:'apix-director',to:task.employee_id,type:'event',idempotencyKey:`autonomy-checkpoint:${run.id}:${Math.floor(Date.now()/interval)}`,timeoutMs:Math.ceil(interval),payload:{kind:'progress_request',source:'apix',risk,contractDigest:architecture.digest,content:'请核对冻结模块契约，报告真实进度、已执行检查及阻塞；处理并确认本轮检查点消息。'}});
              if(sent.status==='rejected')throw new Error('监督检查点消息被拒绝');db.prepare('UPDATE autonomy_tasks SET last_checkpoint=? WHERE task_id=?').run(now(),task.id);deps.record(task.id,'autonomy.checkpoint',{runId:run.id,messageId:sent.id,risk});
            }
          }
        }
        if(rows<{status:string}>('SELECT status FROM tasks WHERE plan_id=?',plan.plan_id).every(t=>t.status==='accepted')){db.prepare("UPDATE autonomy_plans SET state='completed',reason=NULL WHERE plan_id=?").run(plan.plan_id);validatedContracts.delete(plan.plan_id);deps.delivered?.(plan.session_id,plan.plan_id);}
      }catch(error){halt(plan,redact(String(error instanceof Error?error.message:error)));}finally{busy.delete(plan.plan_id);}
    }
  }
  return {settings,save,bindPlan,details,resumeFingerprint,resume,assertPlan,context,tick,waiting:(planId:string)=>rows<{id:string}>("SELECT id FROM tasks WHERE plan_id=? AND status='needs_revision'",planId).some(t=>waitingRepair(t.id))};
}
export type Autonomy=ReturnType<typeof createAutonomy>;
