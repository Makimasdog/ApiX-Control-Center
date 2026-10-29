/**
 * 自主交付引擎 - 验收检查、自动修复、worktree 集成、交付检查、架构契约验证
 *
 * 所属层级：协调层 - 领域服务（第3层）
 * 核心功能：
 *   1. settings()/save() - 自主交付策略的读取与保存
 *   2. bindPlan() - 将计划绑定架构契约（自主交付模式）
 *   3. tick() - 自主交付主循环：检查任务状态、触发验收、自动修复、超时停止
 *   4. verify() - 验收检查：运行授权命令 + LLM 自审 + 指纹比对
 *   5. repair() - 自动修复：分析失败原因、选择替代员工、派发修复任务
 *   6. resume() - 恢复中断的自主交付流程
 * 依赖关系：
 *   - 依赖 architecture.ts 的架构契约解析
 *   - 依赖 permissions.ts 的权限校验
 *   - 依赖 scheduling.ts 的员工调度
 *   - 被 coordinator.ts 调用
 * 设计意图：在授权边界内（次数、时间、费用）自动修复失败任务，
 *   超出边界则暂停（attention 状态）等待人工介入。
 */
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {realpathSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {type Store,type Task,type Employee,object,text} from './contracts.js';
import {autonomyDefaults,parseAutonomyPolicy,parseArchitecture,type AutonomyPolicy,type Architecture,type CheckCommand} from './architecture.js';
import type {Permissions} from './permissions.js';
import type {Scheduling} from './scheduling.js';

/** 自主交付计划记录（持久化到 autonomy_plans 表） */
interface PlanRecord {plan_id:string;session_id:string;revision:number;policy_version:number;workflow_version:number;body:string;state:string;started_at:string|null;reason:string|null}
/** 受管任务（扩展 Task 增加工作区和结果字段） */
interface ManagedTask extends Task {workspace_path:string|null;result:string|null}
/** 代码检查结果（指纹、文件列表、冲突、预览） */
interface Inspection {fingerprint:string|null;files:string[];conflicts:string[];preview:string;previewTruncated?:boolean;context?:{files:{path:string;content:string}[];truncated:boolean}}
/** 外部依赖注入接口（扩展 Store 并注入所有协作模块） */
interface Dependencies extends Store {
  fault?(task:ManagedTask):{strategy:string;category:string}; // 故障诊断
  permissions:Permissions;  // [→ 见 permissions.ts]
  scheduling:Scheduling;    // [→ 见 scheduling.ts]
  employees():Employee[];
  workflow(projectId:string):{enabled:boolean;version:number;employeeIds:string[]};
  inspect(task:ManagedTask):Promise<Inspection>; // 代码检查（生成指纹）
  workspace(task:ManagedTask):string|Promise<string>; // 获取工作区路径
  accept(id:string,fingerprint:string):void|Promise<void>; // 验收通过
  review(projectId:string,sessionId:string,architecture:Architecture,moduleId:string,evidence:unknown):Promise<{passed:boolean;findings:string[];reviewMode:string}>; // LLM 自审
  retry(task:ManagedTask,employeeId:string,prompt:string):Promise<void>; // 重试任务
  reassignPending(taskId:string,employeeId:string):void; // 重新分配排队任务
  activatePending?(planId:string):void|Promise<void>; // 激活待处理计划
  delivered?(sessionId:string,planId:string):void; // 交付完成回调
  stop(runId:string):void; // 停止运行
  sendMessage(input:Record<string,unknown>):{id:string;status:string}; // 发送邮箱消息
  record(taskId:string,kind:string,payload:unknown):void; // 记录事件
}

/**
 * createAutonomy - 创建自主交付引擎实例
 * @param deps - 外部依赖注入
 * @returns 包含完整自主交付功能的对象
 */
export function createAutonomy(deps:Dependencies) {
  const {db,row,rows,now}=deps;
  /** 计划级互斥锁：防止同一计划被并发 tick 处理 */
  const busy=new Set<string>();
  /** 正在停止的运行 ID 集合：防止重复发送停止请求 */
  const stopping=new Set<string>();
  /** 已验证的契约摘要缓存：避免重复解析和校验 */
  const validatedContracts=new Map<string,string>();
  // 初始化自主交付相关数据表
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_policies(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_plans(plan_id TEXT PRIMARY KEY REFERENCES plans(id),session_id TEXT NOT NULL,revision INTEGER NOT NULL,policy_version INTEGER NOT NULL,workflow_version INTEGER NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),module_id TEXT NOT NULL,original_prompt TEXT NOT NULL,repairs INTEGER NOT NULL DEFAULT 0,last_checkpoint TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_checks(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT,status TEXT NOT NULL,fingerprint TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_repairs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,employee_id TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);`);
  // 迁移：为旧表添加 run_id 列
  if(!rows<{name:string}>('PRAGMA table_info(autonomy_repairs)').some(c=>c.name==='run_id'))db.exec('ALTER TABLE autonomy_repairs ADD COLUMN run_id TEXT');
  // 重启恢复：将中断的运行中检查标记为 interrupted
  db.prepare("UPDATE autonomy_checks SET status='interrupted' WHERE status='running'").run();
  // 重启恢复：将受中断影响的计划标记为 attention
  db.prepare("UPDATE autonomy_plans SET state='attention',reason='服务重启中断了验证；请确认验收进程已停止并重新检查后恢复' WHERE plan_id IN (SELECT t.plan_id FROM autonomy_tasks a JOIN tasks t ON t.id=a.task_id JOIN autonomy_checks c ON c.task_id=t.id WHERE c.status='interrupted')").run();
  db.prepare("UPDATE autonomy_plans SET state='attention',reason='自动修复派发被重启中断，请核对原操作后恢复' WHERE plan_id IN (SELECT t.plan_id FROM autonomy_repairs r JOIN tasks t ON t.id=r.task_id WHERE r.status='prepared')").run();

  /** 获取项目的自主交付策略 */
  function settings(projectId:string):AutonomyPolicy {
    if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');
    const saved=row<{body:string}>('SELECT body FROM autonomy_policies WHERE project_id=?',projectId);return saved?JSON.parse(saved.body):{...autonomyDefaults,checks:[]};
  }

  /** 保存自主交付策略（需明确批准，且无运行中任务） */
  function save(projectId:string,input:Record<string,unknown>) {
    const previous=settings(projectId);if(input.version!==previous.version)throw new Error('自主交付策略已变化，请刷新');
    if(input.enabled===false){const policy={...previous,enabled:false,version:previous.version+1};db.prepare('INSERT INTO autonomy_policies VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(policy));return policy;}
    if(input.approved!==true)throw new Error('自主交付需要明确批准验收命令、返工范围与费用');
    // 启用前检查：无运行中任务，自动协作已开启，权限为 full_access
    if(rows("SELECT id FROM tasks WHERE project_id=? AND status IN ('running','starting','stopping','unknown','queued','awaiting_approval','completed','needs_revision','failed','blocked') AND plan_id IN (SELECT plan_id FROM autonomy_plans WHERE state!='completed')",projectId).length || row("SELECT id FROM tasks WHERE project_id=? AND status IN ('running','stopping','unknown','queued') LIMIT 1",projectId))throw new Error('请先停止或处理当前工作，再更改自主交付策略');
    const workflow=deps.workflow(projectId);if(!workflow.enabled || deps.permissions.get(projectId).mode!=='full_access')throw new Error('请先开启项目自动协作并授权 ApiX');
    const policy=parseAutonomyPolicy(input,previous.version+1);
    db.prepare('INSERT INTO autonomy_policies VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body').run(projectId,JSON.stringify(policy));return policy;
  }

  /** 将计划绑定架构契约（创建 autonomy_plans 和 autonomy_tasks 记录） */
  function bindPlan(planId:string,sessionId:string,revision:number,architecture:Architecture,steps:{taskId:string;moduleId:string;prompt:string}[]) {
    const project=row<{project_id:string}>('SELECT project_id FROM plans WHERE id=?',planId)!;const policy=settings(project.project_id);const workflow=deps.workflow(project.project_id);
    db.prepare('INSERT INTO autonomy_plans VALUES (?,?,?,?,?,?,?,?,?)').run(planId,sessionId,revision,policy.version,workflow.version,JSON.stringify(architecture),'ready',null,null);
    for(const step of steps)db.prepare('INSERT INTO autonomy_tasks(task_id,module_id,original_prompt) VALUES (?,?,?)').run(step.taskId,step.moduleId,step.prompt);
  }

  /** 获取计划的详细信息（架构、任务、检查、修复记录） */
  function details(planId:string|null){if(!planId)return null;const plan=row<PlanRecord>('SELECT * FROM autonomy_plans WHERE plan_id=?',planId);return plan?{...plan,architecture:JSON.parse(plan.body) as Architecture,body:undefined,tasks:rows('SELECT a.* FROM autonomy_tasks a JOIN tasks t ON t.id=a.task_id WHERE t.plan_id=?',planId),checks:rows<{body:string}>('SELECT c.* FROM autonomy_checks c JOIN tasks t ON t.id=c.task_id WHERE t.plan_id=? ORDER BY c.rowid DESC LIMIT 100',planId).map(c=>({...c,body:JSON.parse(c.body)})),repairs:rows('SELECT r.* FROM autonomy_repairs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? ORDER BY r.rowid',planId)}:null;}

  /** 计算恢复指纹（用于确认恢复前状态未变化） */
  function resumeFingerprint(planId:string){return createHash('sha256').update(JSON.stringify({plan:row('SELECT * FROM autonomy_plans WHERE plan_id=?',planId),tasks:rows('SELECT id,status,prompt,employee_id,updated_at FROM tasks WHERE plan_id=? ORDER BY rowid',planId),runs:rows('SELECT r.id,r.status,r.ended_at FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? ORDER BY r.rowid',planId)})).digest('hex');}

  /**
   * resume - 恢复中断的自主交付流程（attention → running）
   * @param planId - 计划 ID
   * @param input - 包含 reviewed、fingerprint、confirmedStopped
   */
  async function resume(planId:string,input:Record<string,unknown>){const plan=row<PlanRecord>('SELECT * FROM autonomy_plans WHERE plan_id=?',planId);if(!plan || plan.state!=='attention' || busy.has(planId) || input.reviewed!==true || input.fingerprint!==resumeFingerprint(planId))throw new Error('请检查当前自主交付状态再恢复');const project=row<{project_id:string}>('SELECT project_id FROM plans WHERE id=?',planId)!;current(plan,project.project_id);if(rows("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status IN ('unknown','running','starting','stopping')",planId).length)throw new Error('请先停止或恢复原员工运行');if(row("SELECT c.id FROM autonomy_checks c JOIN tasks t ON t.id=c.task_id WHERE t.plan_id=? AND c.status='interrupted' LIMIT 1",planId) && input.confirmedStopped!==true)throw new Error('验证进程状态未知，须确认已停止后恢复');for(const task of rows<ManagedTask>("SELECT * FROM tasks WHERE plan_id=? AND status NOT IN ('accepted','cancelled')",planId))deps.permissions.assertGranted(task.id,task.project_id,task.employee_id);if(row("SELECT r.id FROM autonomy_repairs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status='prepared' LIMIT 1",planId)&&input.confirmedStopped!==true)throw new Error('修复派发结果未知，须核对并确认原进程停止');if(input.confirmedStopped===true)db.prepare("UPDATE autonomy_repairs SET status='interrupted_resolved' WHERE task_id IN (SELECT id FROM tasks WHERE plan_id=?) AND status='prepared'").run(planId);if(input.confirmedStopped===true)db.prepare("UPDATE autonomy_checks SET status='interrupted_resolved',body=json_set(body,'$.stopConfirmation','user','$.stopConfirmedAt',?) WHERE task_id IN (SELECT id FROM tasks WHERE plan_id=?) AND status='interrupted'").run(now(),planId);db.prepare("UPDATE autonomy_plans SET state='running',reason=NULL WHERE plan_id=?").run(planId);try{(await deps.activatePending?.(planId));}catch(error){halt(plan,String(error instanceof Error?error.message:error));throw error;}}

  /**
   * current - 校验计划的当前有效性（策略版本、需求版本、权限状态）
   * @param plan - 计划记录
   * @param projectId - 项目 ID
   * @returns 当前有效的策略
   * @throws 当策略/需求/权限已变化时抛出错误
   */
  function current(plan:PlanRecord,projectId:string) {
    const policy=settings(projectId);const workflow=deps.workflow(projectId);const session=row<{plan_id:string;revision:number;confirmed_revision:number|null;status:string}>('SELECT * FROM coordination_sessions WHERE id=?',plan.session_id);
    // 校验策略版本、工作流版本、会话状态是否仍匹配
    if(!policy.enabled || policy.version!==plan.policy_version || !workflow.enabled || workflow.version!==plan.workflow_version || !session || session.plan_id!==plan.plan_id || session.revision!==plan.revision || session.confirmed_revision!==plan.revision || !['running','plan_review'].includes(session.status))throw new Error('自主交付的策略、需求或自动协作授权已变化');
    if(deps.permissions.get(projectId).mode!=='full_access')throw new Error('ApiX 自主交付权限已撤销');
    // 校验冻结契约摘要一致性（防止数据损坏）
    if(validatedContracts.get(plan.plan_id)!==plan.body){const saved=object(JSON.parse(plan.body));const checked=parseArchitecture(saved,policy.checks);if(saved.digest!==checked.digest)throw new Error('冻结契约摘要不一致，请重新规划');validatedContracts.set(plan.plan_id,plan.body);}return policy;
  }

  /** 断言计划有效（用于准入检查） */
  function assertPlan(planId:string,projectId:string){const plan=row<PlanRecord>('SELECT * FROM autonomy_plans WHERE plan_id=?',planId);if(!plan)return;current(plan,projectId);if(plan.state==='attention')throw new Error(plan.reason??'自主交付需要处理');}

  /** 获取任务的架构契约上下文（供员工 prompt 使用） */
  function context(taskId:string){const saved=row<{module_id:string;body:string}>('SELECT a.module_id,p.body FROM autonomy_tasks a JOIN tasks t ON t.id=a.task_id JOIN autonomy_plans p ON p.plan_id=t.plan_id WHERE a.task_id=?',taskId);return saved?`统一架构契约（所有员工必须遵守，禁止自行扩大模块边界；变更接口须 ApiX 重新规划）：\n${saved.body}\n当前模块：${saved.module_id}`:'';}

  /**
   * halt - 暂停自主交付计划（设置 attention 状态并停止运行中任务）
   * @param plan - 计划记录
   * @param reason - 暂停原因
   */
  function halt(plan:PlanRecord,reason:string){validatedContracts.delete(plan.plan_id);if(row<{state:string;reason:string}>('SELECT state,reason FROM autonomy_plans WHERE plan_id=?',plan.plan_id)?.reason===reason)return;db.prepare("UPDATE autonomy_plans SET state='attention',reason=? WHERE plan_id=?").run(reason,plan.plan_id);for(const t of rows<{id:string}>('SELECT id FROM tasks WHERE plan_id=?',plan.plan_id))deps.record(t.id,'autonomy.attention',{reason});for(const run of rows<{id:string;task_id:string}>("SELECT r.id,r.task_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status='running'",plan.plan_id)){try{deps.stop(run.id);}catch(error){deps.record(run.task_id,'autonomy.stop_failed',{runId:run.id,error:String(error)});}}}

  /** 任务级当前性校验（检查任务未变化、员工在授权范围、未超时） */
  function taskCurrent(plan:PlanRecord,task:ManagedTask,policy:AutonomyPolicy){current(plan,task.project_id);const fresh=row<ManagedTask>('SELECT * FROM tasks WHERE id=?',task.id);if(!fresh || fresh.employee_id!==task.employee_id || fresh.status!==task.status || fresh.prompt!==task.prompt)throw new Error('检查期间任务已变化');if(!deps.workflow(task.project_id).employeeIds.includes(task.employee_id) || deps.permissions.decision(task.project_id,task.employee_id)!=='allow')throw new Error('员工不在自主交付授权范围');deps.permissions.assertGranted(task.id,task.project_id,task.employee_id);if(task.status!=='queued')deps.scheduling.assertBinding(task.id,task.project_id,task.employee_id);if(plan.started_at && Date.now()-Date.parse(plan.started_at)>policy.maxMinutes*60000)throw new Error('自主交付已达到目标时间上限');}

  /** 脱敏处理：将环境变量中的密钥替换为 <redacted> */
  function redact(value:string){let result=value;for(const [key,secret] of Object.entries(process.env))if(/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)&&secret&&secret.length>=6)result=result.split(secret).join('<redacted>');return result;}

  /**
   * execute - 执行验收命令（子进程方式，带超时和守卫检查）
   * @param check - 验收命令定义
   * @param cwd - 工作目录
   * @param guard - 守卫函数（定期检查任务是否仍有效）
   * @param onSpawn - 进程启动回调（记录 PID）
   * @returns 执行结果（退出码、输出、超时状态等）
   * 设计意图：直接使用 Node 可执行文件，不经过 shell 解释；
   *   环境变量中的 APIX_ 前缀和密钥相关变量会被清除。
   */
  async function execute(check:CheckCommand,cwd:string,guard:()=>void,onSpawn:(pid:number|undefined)=>void) {
    const script=realpathSync.native(resolve(cwd,check.args[0]!));const rel=relative(realpathSync.native(cwd),script);if(rel.startsWith('..') || isAbsolute(rel))throw new Error('验收脚本通过路径或链接越过工作区');
    const env={...process.env};for(const key of Object.keys(env))if(/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)||key.startsWith('APIX_'))delete env[key]; // 清除敏感环境变量
    return await new Promise<{id:string;args:string[];exitCode:number|null;signal:string|null;output:string;timedOut:boolean;durationMs:number}>((done,reject)=>{
      const start=Date.now();let output='';let timedOut=false;let failure:Error|null=null;let killed=false;let settled=false;let uncertainTimer:ReturnType<typeof setTimeout>|undefined;
      const child=spawn(process.execPath,[script,...check.args.slice(1)],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      try{onSpawn(child.pid);}catch(error){child.on('error',()=>{});child.kill();reject(error);return;}
      const kill=()=>{if(killed)return;killed=true;if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>{});else child.kill('SIGKILL');uncertainTimer=setTimeout(()=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(watch);child.stdout.destroy();child.stderr.destroy();child.unref();reject(Object.assign(new Error('无法确认验收进程停止；请检查记录的 PID，不能自动重试'),{code:'VERIFICATION_UNKNOWN'}));},6000);};
      const timer=setTimeout(()=>{timedOut=true;kill();},check.timeoutMs);const watch=setInterval(()=>{try{guard();}catch(error){failure=error as Error;kill();}},200); // 每 200ms 检查守卫
      const append=(chunk:Buffer)=>{output=(output+chunk.toString('utf8')).slice(-20000);};child.stdout.on('data',append);child.stderr.on('data',append);
      child.once('error',error=>{failure=error;});
      child.once('close',(exitCode,signal)=>{clearTimeout(timer);clearInterval(watch);clearTimeout(uncertainTimer);if(settled)return;settled=true;if(failure){reject(failure);return;}done({id:check.id,args:check.args,exitCode,signal,output:redact(output),timedOut,durationMs:Date.now()-start});});
    });
  }

  /** 获取任务的等待中修复指令 */
  function waitingRepair(taskId:string){return row<{id:string;instruction:string}>("SELECT id,instruction FROM autonomy_repairs WHERE task_id=? AND status='waiting' AND run_id IS (SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY rowid DESC LIMIT 1",taskId,taskId);}

  /** 检查任务的前置依赖是否可恢复（递归检查 DAG 上游） */
  function waitingDependency(task:ManagedTask){
    const ancestors=rows<{id:string;status:string}>("WITH RECURSIVE ancestors(id) AS (SELECT depends_on_id FROM task_dependencies WHERE task_id=? UNION SELECT d.depends_on_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id) SELECT t.id,t.status FROM tasks t JOIN ancestors a ON a.id=t.id",task.id);
    const blocked=[task,...ancestors.filter(t=>t.status==='blocked')];if(blocked.some(t=>row<{result:string|null}>('SELECT result FROM tasks WHERE id=?',t.id)?.result||row('SELECT id FROM runs WHERE task_id=? LIMIT 1',t.id)||row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",t.id)))return false;
    const failures=ancestors.filter(t=>['failed','cancelled','unknown','rejected','needs_revision'].includes(t.status));
    if(failures.length)return failures.every(t=>t.status==='needs_revision'&&waitingRepair(t.id));
    return ancestors.some(t=>row("SELECT id FROM autonomy_repairs WHERE task_id=? AND status='dispatched' LIMIT 1",t.id));
  }

  /**
   * repair - 自动修复失败任务
   * @param plan - 计划记录
   * @param task - 失败的任务
   * @param findings - 问题列表
   * @param policy - 自主交付策略
   * 设计意图：在 maxRepairs 限制内自动选择替代员工并派发修复任务；
   *   超限则暂停计划等待人工介入。
   */
  async function repair(plan:PlanRecord,task:ManagedTask,findings:string[],policy:AutonomyPolicy) {
    taskCurrent(plan,task,policy);const fault=deps.fault?.(task);if(fault&&fault.strategy!=='repair'){halt(plan,'故障需要核对后恢复：'+fault.category);return;}const binding=row<{module_id:string;original_prompt:string;repairs:number}>('SELECT * FROM autonomy_tasks WHERE task_id=?',task.id)!;
    if(binding.repairs>=policy.maxRepairs){halt(plan,`任务 ${task.id} 已达到 ${policy.maxRepairs} 次修复上限：${findings.join('；')}`);return;} // 超限暂停
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

  /**
   * verify - 验收检查（运行授权命令 + LLM 自审 + 指纹比对）
   * @param plan - 计划记录
   * @param task - 已完成的任务
   * @param policy - 自主交付策略
   * 设计意图：验收命令执行前后都要检查指纹，确保代码未被篡改；
   *   验收命令不能修改交付代码，否则需要重新验证。
   */
  async function verify(plan:PlanRecord,task:ManagedTask,policy:AutonomyPolicy) {
    const architecture=JSON.parse(plan.body) as Architecture;const binding=row<{module_id:string}>('SELECT module_id FROM autonomy_tasks WHERE task_id=?',task.id)!;
    const module=architecture.modules.find(m=>m.id===binding.module_id);const checkIds=module?.checkIds??policy.checks.map(c=>c.id);const inspection=await deps.inspect(task);
    if(!inspection.fingerprint || inspection.conflicts.length || inspection.previewTruncated || inspection.context?.truncated)throw new Error('代码冲突、二进制文件或代码超出自动审查范围，需要完整人工检查');
    const latest=row<{id:string}>('SELECT id FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
    const checkId=randomUUID();db.prepare('INSERT INTO autonomy_checks(id,task_id,run_id,status,fingerprint,body,created_at) VALUES (?,?,?,?,?,?,?)').run(checkId,task.id,latest?.id??null,'running',inspection.fingerprint,'{}',now());
    const tests:Awaited<ReturnType<typeof execute>>[]=[];let completed=false;
    try{
      const cwd=(await deps.workspace(task));for(const id of checkIds){taskCurrent(plan,task,policy);const check=policy.checks.find(c=>c.id===id);if(!check)throw new Error('契约引用的验收命令未获授权');tests.push(await execute(check,cwd,()=>taskCurrent(plan,task,policy),pid=>db.prepare('UPDATE autonomy_checks SET body=? WHERE id=?').run(JSON.stringify({tests,activeProcess:{pid,cwd,args:check.args,startedAt:now()}}),checkId)));}
      taskCurrent(plan,task,policy);const after=await deps.inspect(task);if(after.fingerprint!==inspection.fingerprint)throw new Error('验收命令修改了交付代码，请检查后重新验证'); // 指纹变化=代码被修改
      let findings=tests.filter(t=>t.exitCode!==0 || t.timedOut).map(t=>`检查 ${t.id} 失败，退出码 ${t.exitCode}，超时 ${t.timedOut}：${t.output.slice(-4000)}`);
      // 检查交付修改是否超出冻结模块文件边界
      const paths=module?.paths??architecture.modules.flatMap(m=>m.paths);const normalize=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
      const outside=inspection.files.filter(file=>!paths.some(path=>normalize(file)===normalize(path)||normalize(file).startsWith(normalize(path)+'/')));if(outside.length)findings.push(`交付修改超出冻结模块文件边界：${outside.join('、')}。恢复范围外文件，只保留本模块修改。`);
      let review:{passed:boolean;findings:string[];reviewMode:string}|null=null;
      if(!findings.length){review=await deps.review(task.project_id,plan.session_id,architecture,binding.module_id,{fingerprint:inspection.fingerprint,files:inspection.files,diff:inspection.preview,currentCode:inspection.context,tests});findings=review.findings;} // LLM 自审
      taskCurrent(plan,task,policy);if((await deps.inspect(task)).fingerprint!==inspection.fingerprint)throw new Error('审查期间交付代码已变化');taskCurrent(plan,task,policy);
      const passed=!findings.length && review?.passed===true;
      db.prepare('UPDATE autonomy_checks SET status=?,body=? WHERE id=?').run(passed?'passed':'failed',JSON.stringify({tests,review,findings}),checkId);completed=true;
      deps.record(task.id,'autonomy.quality_checked',{checkId,passed,tests,review});
      if(passed){(await deps.accept(task.id,inspection.fingerprint));return;} // 验收通过
      db.prepare("UPDATE tasks SET status='needs_revision',updated_at=? WHERE id=? AND status='completed'").run(now(),task.id);
      await repair(plan,row<ManagedTask>('SELECT * FROM tasks WHERE id=?',task.id)!,findings,policy); // 验收失败，触发自动修复
    }catch(error){if(!completed){const uncertain=(error as {code?:string}).code==='VERIFICATION_UNKNOWN';const previous=row<{body:string}>('SELECT body FROM autonomy_checks WHERE id=?',checkId)!;db.prepare('UPDATE autonomy_checks SET status=?,body=? WHERE id=?').run(uncertain?'interrupted':'error',JSON.stringify({...JSON.parse(previous.body),tests,error:redact(String(error instanceof Error?error.message:error))}),checkId);}throw error;}
  }

  /**
   * tick - 自主交付主循环（定期调用，推进所有活跃计划）
   * 设计意图：遍历所有 ready/running 状态的计划，根据任务状态执行相应操作：
   *   - completed → verify（验收检查）
   *   - failed/cancelled → repair（自动修复）
   *   - needs_revision + waitingRepair → repair（执行待处理修复）
   *   - blocked + waitingDependency → 跳过（等待依赖恢复）
   *   - unknown/needs_revision/blocked → halt（暂停等待人工介入）
   *   - queued + autoReassign → 尝试替代员工
   *   - running → 检查超时、发送检查点消息
   */
  async function tick() {
    for(const plan of rows<PlanRecord>("SELECT * FROM autonomy_plans WHERE state IN ('ready','running')")){
      if(busy.has(plan.plan_id))continue;const tasks=rows<ManagedTask>('SELECT * FROM tasks WHERE plan_id=? ORDER BY rowid',plan.plan_id);const projectId=tasks[0]?.project_id;if(!projectId)continue;
      const session=row<{status:string}>('SELECT status FROM coordination_sessions WHERE id=?',plan.session_id);if(session?.status==='plan_review')continue; // 计划待审时跳过
      busy.add(plan.plan_id);
      try{
        const policy=current(plan,projectId);if(!plan.started_at){plan.started_at=now();db.prepare("UPDATE autonomy_plans SET state='running',started_at=? WHERE plan_id=?").run(plan.started_at,plan.plan_id);}
        if(Date.now()-Date.parse(plan.started_at)>policy.maxMinutes*60000){for(const run of rows<{id:string}>("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status='running'",plan.plan_id))deps.stop(run.id);throw new Error('自主交付达到目标时间上限，已请求停止员工');}
        for(const snapshot of tasks){
          if(row<{state:string}>('SELECT state FROM autonomy_plans WHERE plan_id=?',plan.plan_id)?.state==='attention')break;
          const task=row<ManagedTask>('SELECT * FROM tasks WHERE id=?',snapshot.id)!;
          const binding=row<{module_id:string;last_checkpoint:string|null}>('SELECT * FROM autonomy_tasks WHERE task_id=?',task.id);if(!binding)throw new Error('计划包含未绑定架构契约的任务');
          if(task.status==='completed'){taskCurrent(plan,task,policy);await verify(plan,task,policy);} // 已完成 → 验收检查
          else if(task.status==='failed' || task.status==='cancelled')await repair(plan,task,[`员工运行 ${task.status}：${redact(task.result??'无输出，请检查错误并补齐证据')}`],policy); // 失败 → 自动修复
          else if(task.status==='needs_revision' && waitingRepair(task.id))await repair(plan,task,[],policy); // 待修改且有修复指令 → 执行修复
          else if(task.status==='blocked' && waitingDependency(task))continue; // 被阻塞但可恢复 → 跳过
          else if(task.status==='unknown' || task.status==='needs_revision' || task.status==='blocked')throw new Error(`任务 ${task.id} 为 ${task.status}，需要检查进程、代码交接或人工拒绝原因`); // 异常状态 → 暂停
          else if(task.status==='queued' && policy.autoReassign && !row('SELECT id FROM runs WHERE task_id=? LIMIT 1',task.id)){ // 排队中 → 尝试替代员工
            taskCurrent(plan,task,policy);const options=deps.scheduling.candidates(projectId,deps.scheduling.taskSpec(task.id),task.employee_id);const assigned=options.find(c=>c.employeeId===task.employee_id);
            if(!assigned?.eligible || assigned.waiting){const alternative=options.find(c=>c.eligible&&!c.waiting&&c.employeeId!==task.employee_id&&deps.workflow(projectId).employeeIds.includes(c.employeeId)&&deps.permissions.decision(projectId,c.employeeId)==='allow');if(alternative)deps.reassignPending(task.id,alternative.employeeId);}
          }
          else if(task.status==='running'){ // 运行中 → 检查超时和检查点
            taskCurrent(plan,task,policy);const run=row<{id:string;started_at:string}>('SELECT id,started_at FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id)!;
            if(Date.now()-Date.parse(run.started_at)>policy.maxRunMinutes*60000){if(!stopping.has(run.id)){stopping.add(run.id);deps.record(task.id,'autonomy.timeout',{runId:run.id});deps.stop(run.id);}continue;} // 单次运行超时
            // 根据模块风险等级调整检查点间隔（高风险更频繁）
            const architecture=JSON.parse(plan.body) as Architecture;const risk=architecture.modules.find(m=>m.id===binding.module_id)?.risk??'high';const interval=policy.checkpointMinutes*60000*(risk==='high'?0.5:risk==='low'?2:1);
            if(Date.now()-Date.parse(binding.last_checkpoint??run.started_at)>=interval){
              const latest=row<{payload:string}>('SELECT payload FROM agent_messages WHERE task_id=? AND from_agent=? AND created_at>=? AND type=\'event\' ORDER BY rowid DESC LIMIT 1',task.id,task.employee_id,run.started_at);let blocked=false;if(latest){try{blocked=object(JSON.parse(latest.payload)).blocked===true;}catch{}}
              if(blocked){if(!stopping.has(run.id)){stopping.add(run.id);deps.record(task.id,'autonomy.blocked_stop',{runId:run.id});deps.stop(run.id);}continue;} // 员工报告阻塞 → 停止
              // 检查 Director 风险消息（连续 2 次未响应则停止）
              const recent=rows<{status:string;created_at:string;payload:string}>('SELECT status,created_at,payload FROM agent_messages WHERE target_task_id=? AND target_run_id=? AND from_agent=\'apix-director\' AND type=\'event\' ORDER BY rowid DESC LIMIT 3',task.id,run.id).filter(m=>{try{return object(JSON.parse(m.payload)).risk!==undefined;}catch{return false;}});
              if(recent.length>=2 && recent.slice(0,2).every(m=>m.status!=='completed' && Date.now()-Date.parse(m.created_at)>=interval)) {if(!stopping.has(run.id)){stopping.add(run.id);deps.record(task.id,'autonomy.unresponsive_stop',{runId:run.id});deps.stop(run.id);}continue;}
              // 发送检查点消息请求进度报告
              const sent=deps.sendMessage({projectId,taskId:task.id,from:'apix-director',to:task.employee_id,type:'event',idempotencyKey:`autonomy-checkpoint:${run.id}:${Math.floor(Date.now()/interval)}`,timeoutMs:Math.ceil(interval),payload:{kind:'progress_request',source:'apix',risk,contractDigest:architecture.digest,content:'请核对冻结模块契约，报告真实进度、已执行检查及阻塞；处理并确认本轮检查点消息。'}});
              if(sent.status==='rejected')throw new Error('监督检查点消息被拒绝');db.prepare('UPDATE autonomy_tasks SET last_checkpoint=? WHERE task_id=?').run(now(),task.id);deps.record(task.id,'autonomy.checkpoint',{runId:run.id,messageId:sent.id,risk});
            }
          }
        }
        // 所有任务已验收 → 计划完成
        if(rows<{status:string}>('SELECT status FROM tasks WHERE plan_id=?',plan.plan_id).every(t=>t.status==='accepted')){db.prepare("UPDATE autonomy_plans SET state='completed',reason=NULL WHERE plan_id=?").run(plan.plan_id);validatedContracts.delete(plan.plan_id);deps.delivered?.(plan.session_id,plan.plan_id);}
      }catch(error){halt(plan,redact(String(error instanceof Error?error.message:error)));}finally{busy.delete(plan.plan_id);}
    }
  }
  return {settings,save,bindPlan,details,resumeFingerprint,resume,assertPlan,context,tick,waiting:(planId:string)=>rows<{id:string}>("SELECT id FROM tasks WHERE plan_id=? AND status='needs_revision'",planId).some(t=>waitingRepair(t.id))};
}
/** 自主交付引擎实例类型（用于类型引用） */
export type Autonomy=ReturnType<typeof createAutonomy>;
