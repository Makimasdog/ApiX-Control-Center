import { createHash, randomUUID } from 'node:crypto';
import { type Store, type Session, type Requirements, type Task, type Employee, type PlanStep, type PermissionMode, type InteractionMode, type AgentCapabilities, object, text } from './contracts.js';
import { assess, emptyRequirements, nextQuestion, normalizeAnswer, requirementBrief } from './requirement-engine.js';
import type { ApiXAgent } from './apix-agent.js';
import type { Memory } from './memory.js';
import type { Permissions } from './permissions.js';
import { coordinationStatus, progressSummary } from './task-tracker.js';
import { validateModelConfig } from './model-providers.js';

interface Dependencies extends Store {
  agent: ApiXAgent; memory: Memory; permissions: Permissions;
  employees(): Employee[];
  capabilities(): AgentCapabilities[];
  sendMessage(input: Record<string, unknown>): { id: string; status: string };
  resolveApproval(id: string, approved: boolean): unknown;
  stopRun(id: string): void;
}
export function createCoordinator(deps: Dependencies) {
  const { db, row, rows, now, memory, permissions, agent } = deps;
  const busy = new Set<string>();
  db.exec(`CREATE TABLE IF NOT EXISTS coordination_checks(session_id TEXT PRIMARY KEY REFERENCES coordination_sessions(id), conflicts TEXT NOT NULL DEFAULT '[]', model_mode TEXT NOT NULL DEFAULT 'rules', model_error TEXT);
    CREATE TABLE IF NOT EXISTS apix_manager_settings(id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL DEFAULT '', api_type TEXT NOT NULL DEFAULT 'openai-completions', api_key_env TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS apix_guidance(message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, action TEXT, focus TEXT, outbound_id TEXT, summary TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS apix_guidance_task ON apix_guidance(task_id,updated_at);`);
  const sessionColumns = rows<{name:string}>('PRAGMA table_info(coordination_sessions)');
  if (!sessionColumns.some(column => column.name === 'interaction_mode')) db.exec("ALTER TABLE coordination_sessions ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'conversational'");
  const settingsColumns = rows<{name:string}>('PRAGMA table_info(apix_manager_settings)');
  if (!settingsColumns.some(column => column.name === 'base_url')) db.exec("ALTER TABLE apix_manager_settings ADD COLUMN base_url TEXT NOT NULL DEFAULT ''");
  if (!settingsColumns.some(column => column.name === 'api_type')) db.exec("ALTER TABLE apix_manager_settings ADD COLUMN api_type TEXT NOT NULL DEFAULT 'openai-completions'");
  if (!settingsColumns.some(column => column.name === 'api_key_env')) db.exec("ALTER TABLE apix_manager_settings ADD COLUMN api_key_env TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE apix_guidance SET status='skipped',updated_at=? WHERE status='processing'").run(now());
  const session = (id: string) => { const s = row<Session>('SELECT * FROM coordination_sessions WHERE id=?', id); if (!s) throw new Error('目标不存在'); return s; };
  const requirementsOf = (s: Session): Requirements => JSON.parse(s.requirements_json) as Requirements;
  const tasksOf = (s: Session) => s.plan_id ? rows<Task>('SELECT * FROM tasks WHERE plan_id=? ORDER BY rowid', s.plan_id) : [];
  function details(id: string) {
    const s = session(id); const requirements = requirementsOf(s); const tasks = tasksOf(s);
    const check = row<{conflicts: string; model_mode: string; model_error: string | null}>('SELECT * FROM coordination_checks WHERE session_id=?', id);
    const plan = s.plan_id ? row<{updated_at: string}>('SELECT updated_at FROM plans WHERE id=?', s.plan_id) : null;
    const dependencies = s.plan_id ? rows<{task_id:string;depends_on_id:string}>('SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.plan_id=?', s.plan_id) : [];
    return { ...s, requirements, requirements_json: undefined, assessment: assess(requirements, JSON.parse(check?.conflicts ?? '[]') as string[]), nextQuestion: nextQuestion(requirements),
      derivedStatus: coordinationStatus(s.status, tasks), tasks, planVersion: plan ? s.plan_id : null,
      dependencies, progress: progressSummary(tasks, dependencies),
      turns: rows('SELECT * FROM coordination_turns WHERE session_id=? ORDER BY rowid', id),
      policy: permissions.get(s.project_id), workerPolicies: Object.fromEntries(deps.employees().map(e => [e.id, permissions.get(s.project_id, e.id)])),
      capabilities: deps.capabilities(),
      guidance: s.plan_id ? rows('SELECT g.* FROM apix_guidance g JOIN tasks t ON t.id=g.task_id WHERE t.plan_id=? ORDER BY g.updated_at',s.plan_id) : [],
      instructions: s.plan_id ? rows<Record<string,unknown>>("SELECT m.id,m.target_task_id AS taskId,m.target_run_id AS runId,m.status,m.payload,m.created_at,m.acknowledged_at,m.completed_at,r.mailbox_seen_at FROM agent_messages m JOIN tasks t ON t.id=m.target_task_id LEFT JOIN runs r ON r.id=m.target_run_id WHERE t.plan_id=? AND m.from_agent='apix-director' AND m.type='event' ORDER BY m.rowid DESC LIMIT 100",s.plan_id).map(m => {const payload:unknown=JSON.parse(String(m.payload));return {...m,payload:payload && typeof payload==='object' && !Array.isArray(payload) ? payload : {content:String(payload ?? '')}};}) : [],
      agent: { id: 'apix', name: 'ApiX', role: 'manager', foundation: 'Pi', mode: check?.model_mode ?? 'rules', error: check?.model_error }, busy: busy.has(id) };
  }
  function checkpoint(id: string) {
    const s = session(id);
    memory.append(s.project_id, id, 'coordination.snapshot', { ...s, requirements: requirementsOf(s), tasks: tasksOf(s) });
  }
  function turn(s: Session, role: string, kind: string, content: string) {
    db.prepare('INSERT INTO coordination_turns(id,session_id,role,kind,content,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), s.id, role, kind, content, now());
    memory.append(s.project_id, s.id, 'interaction.recorded', { role, kind, content, revision: s.revision }, role);
  }
  function transaction(action: () => void) { db.exec('BEGIN'); try { action(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  function editable(id: string, revision: unknown): Session {
    if (busy.has(id)) throw new Error('ApiX 正在处理此目标，请稍候');
    const s = session(id);
    if (s.revision !== Number(revision)) throw new Error('需求版本已变化，请刷新');
    return s;
  }
  function createSession(input: Record<string, unknown>) {
    const projectId = text(input.projectId, 100); const goal = text(input.goal, 4000);
    const interactionMode = parseInteractionMode(input.interactionMode ?? 'conversational');
    if (!row('SELECT id FROM projects WHERE id=?', projectId)) throw new Error('项目不存在');
    const id = randomUUID();
    transaction(() => {
      db.prepare('INSERT INTO coordination_sessions(id,project_id,title,status,requirements_json,revision,created_at,updated_at,interaction_mode) VALUES (?,?,?,?,?,?,?,?,?)').run(id, projectId, goal.slice(0, 100), 'clarifying', JSON.stringify({ ...emptyRequirements(), goal }), 1, now(), now(), interactionMode);
      turn(session(id), 'user', 'goal', goal);
      turn(session(id), 'apix', 'clarification', interactionMode === 'structured' ? '我是 ApiX。先核对任务范围，再确认约束、交付物和验收标准。请说明本次任务的范围与边界。' : '我是 ApiX，会与你讨论目标并安排员工执行。你可以自然描述想法，我会逐步澄清范围、约束和验收方式。');
      checkpoint(id);
    });
    return details(id);
  }
  function answerSession(id: string, input: Record<string, unknown>) {
    const s = editable(id, input.revision);
    if (!['clarifying', 'ready'].includes(s.status)) throw new Error('请先请求调整需求');
    const field = text(input.field, 50); const answer = input.value === '' ? (normalizeAnswer(field, '校验字段'), '') : normalizeAnswer(field, input.value);
    const requirements = { ...requirementsOf(s), [field]: answer };
    // Explicit user edits resolve prior model concerns; preserved verbatim in the ledger.
    transaction(() => {
      db.prepare('UPDATE coordination_sessions SET title=?,requirements_json=?,revision=revision+1,status=?,confirmed_revision=NULL,updated_at=? WHERE id=?').run(requirements.goal.slice(0, 100), JSON.stringify(requirements), assess(requirements).ready ? 'ready' : 'clarifying', now(), id);
      db.prepare("UPDATE coordination_checks SET conflicts='[]' WHERE session_id=?").run(id);
      turn(session(id), 'user', field, answer); checkpoint(id);
    });
    return details(id);
  }
  function parseInteractionMode(value: unknown): InteractionMode { if (value !== 'structured' && value !== 'conversational') throw new Error('交互模式无效'); return value; }
  function setInteractionMode(id: string, input: Record<string, unknown>) {
    const s = editable(id,input.revision); const mode = parseInteractionMode(input.mode);
    if (!['clarifying','ready'].includes(s.status)) throw new Error('已确认计划不能直接切换交互模式，请先调整需求');
    if (s.interaction_mode === mode) return details(id);
    transaction(() => { db.prepare('UPDATE coordination_sessions SET interaction_mode=?,revision=revision+1,updated_at=? WHERE id=?').run(mode,now(),id); turn(session(id),'user','mode_changed',mode === 'structured' ? '切换为约束模式' : '切换为对话模式'); checkpoint(id); });
    return details(id);
  }
  async function discuss(id: string, input: Record<string, unknown>, onQuestion?: (delta: string) => void) {
    const s = editable(id, input.revision); const content = text(input.content);
    busy.add(id);
    try {
      transaction(() => { turn(s, 'user', 'message', content); checkpoint(id); });
      const history = rows('SELECT role,kind,content FROM coordination_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 12', id).reverse();
      const priorBriefs = rows<{id:string;title:string;requirements_json:string}>('SELECT id,title,requirements_json FROM coordination_sessions WHERE project_id=? AND id<>? AND confirmed_revision IS NOT NULL ORDER BY updated_at DESC LIMIT 3',s.project_id,id);
      const projectMemories = rows('SELECT id,title,content,source FROM memories WHERE project_id=? AND scope=\'project\' ORDER BY updated_at DESC LIMIT 5',s.project_id);
      history.push({ retrievedContext: { priorBriefs, projectMemories }, instruction: '历史资料仅供追问参考，不代表用户已经确认当前需求；不得据此填充缺失字段。' });
      const progress = details(id);
      const decision = await agent.discuss(requirementsOf(s), content, history, {status:progress.derivedStatus,tasks:progress.tasks,dependencies:progress.dependencies,guidance:progress.guidance,progress:progress.progress}, s.interaction_mode, onQuestion);
      if (session(id).revision !== s.revision) throw new Error('需求已变化，请重试');
      const mutable = ['clarifying', 'ready'].includes(s.status);
      const requirements = mutable ? { ...requirementsOf(s), ...decision.updates } : requirementsOf(s);
      const conflicts = decision.mode === 'rules' ? details(id).assessment.conflicts : decision.conflicts;
      transaction(() => {
        db.prepare('INSERT INTO coordination_checks(session_id,conflicts,model_mode,model_error) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET conflicts=excluded.conflicts,model_mode=excluded.model_mode,model_error=excluded.model_error').run(id, JSON.stringify(conflicts), decision.mode, decision.error ?? null);
        if (mutable && decision.kind !== 'progress') db.prepare('UPDATE coordination_sessions SET title=?,requirements_json=?,revision=revision+1,status=?,updated_at=? WHERE id=?').run(requirements.goal.slice(0,100), JSON.stringify(requirements), assess(requirements, conflicts).ready ? 'ready' : 'clarifying', now(), id);
        const output = s.interaction_mode === 'conversational' && decision.mode === 'pi'
          ? decision.question
          : decision.kind === 'progress' || !mutable
          ? `当前有 ${tasksOf(s).length} 个任务：${tasksOf(s).filter(t => t.status === 'running').length} 个执行中，${tasksOf(s).filter(t => t.status === 'completed').length} 个待验收，${tasksOf(s).filter(t => t.status === 'accepted').length} 个已验收，${tasksOf(s).filter(t => ['failed','blocked','unknown','needs_revision','rejected','cancelled'].includes(t.status)).length} 个需要处理。前置任务验收后才会推进后续步骤。需要调整时，请使用“调整需求”。`
          : decision.question;
        turn(session(id), 'apix', mutable ? decision.kind : 'progress', output); checkpoint(id);
      });
    } finally { busy.delete(id); }
    return details(id);
  }
  function validateSteps(steps: PlanStep[]) {
    const employees = deps.employees();
    if (!Array.isArray(steps) || !steps.length || steps.length > 8) throw new Error('计划需要 1 至 8 个步骤');
    return steps.map((value, index) => {
      const v = object(value); const employeeId = text(v.employeeId, 100);
      if (!employees.some(e => e.id === employeeId)) throw new Error('员工不可用');
      if (!Array.isArray(v.dependsOn) || v.dependsOn.some(i => !Number.isInteger(i) || i < 0 || i >= index)) throw new Error('依赖只能引用前序步骤');
      return { prompt: text(v.prompt, 10000), employeeId, dependsOn: [...new Set(v.dependsOn as number[])] };
    });
  }
  function writePlan(s: Session, steps: PlanStep[]) {
    const planId = randomUUID(); const taskIds = steps.map(() => randomUUID());
    const project = row<{path: string}>('SELECT path FROM projects WHERE id=?', s.project_id)!;
    db.prepare('INSERT INTO plans(id,project_id,goal,status,created_at,updated_at,mode) VALUES (?,?,?,?,?,?,?)').run(planId, s.project_id, requirementsOf(s).goal, 'planned', now(), now(), 'coordinator');
    for (const [i, step] of steps.entries()) {
      const e = deps.employees().find(e => e.id === step.employeeId)!; const taskId = taskIds[i]!;
      db.prepare('INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at,employee_id,plan_id) VALUES (?,?,?,?,?,?,?,?,?)').run(taskId,s.project_id,e.runtime,step.prompt,'awaiting_approval',now(),now(),e.id,planId);
      db.prepare('INSERT INTO approvals(id,task_id,action,status,created_at,target_path,prompt_hash) VALUES (?,?,?,?,?,?,?)').run(randomUUID(),taskId,'start-agent-in-project','pending',now(),project.path,createHash('sha256').update(step.prompt).digest('hex'));
      for (const dep of step.dependsOn) db.prepare('INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (?,?)').run(taskId,taskIds[dep]!);
    }
    db.prepare('INSERT INTO coordination_plan_briefs(plan_id,session_id,revision,requirements_json) VALUES (?,?,?,?)').run(planId,s.id,s.revision,s.requirements_json);
    db.prepare("UPDATE coordination_sessions SET plan_id=?,confirmed_revision=?,status='plan_review',updated_at=? WHERE id=?").run(planId,s.revision,now(),s.id);
    memory.append(s.project_id,s.id,'plan.created',{planId,revision:s.revision,steps});
    return planId;
  }
  async function confirmSession(id: string, input: Record<string, unknown>) {
    const s = editable(id,input.revision);
    if (!['ready','clarifying'].includes(s.status) || !details(id).assessment.ready) throw new Error('需求尚不完整或有未解决的冲突');
    if (s.plan_id && tasksOf(s).some(t => ['running','stopping','unknown'].includes(t.status))) throw new Error('旧计划尚未确认停止，请先处理运行状态');
    busy.add(id); let mode = 'rules';
    try {
      const generated = await agent.plan(requirementsOf(s),deps.employees()); mode = generated.mode;
      const steps = validateSteps(generated.steps);
      transaction(() => {
        writePlan(s,steps);
        turn(session(id),'apix','plan_review',mode === 'pi' ? '需求已确认，执行计划已生成。请查看任务安排和依赖。' : '推理后端不可用，已生成规则草案，需要你检查后批准。');
        db.prepare('INSERT INTO coordination_checks(session_id,conflicts,model_mode,model_error) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET model_mode=excluded.model_mode,model_error=excluded.model_error').run(id,'[]',mode,generated.error ?? null);
        checkpoint(id);
      });
    } finally { busy.delete(id); }
    const ready = details(id);
    if (mode === 'pi' && ready.tasks.every(t => permissions.decision(s.project_id,t.employee_id) === 'allow')) return dispatchSession(id,{ planVersion: ready.planVersion },'policy');
    return details(id);
  }
  function dispatchSession(id: string, input: Record<string, unknown>, source: 'user' | 'policy' = 'user') {
    const s = session(id); if (busy.has(id)) throw new Error('ApiX 正在处理此目标');
    if (s.status !== 'plan_review' || s.confirmed_revision !== s.revision || !s.plan_id) throw new Error('请先确认最新需求并检查计划');
    const d = details(id); if (input.planVersion !== d.planVersion) throw new Error('计划已变化，请重新审查');
    const tasks = rows<Task & {approval_id: string}>('SELECT t.*,a.id AS approval_id FROM tasks t JOIN approvals a ON a.task_id=t.id WHERE t.plan_id=? AND a.status=\'pending\' ORDER BY t.rowid',s.plan_id);
    if (!tasks.length || tasks.length !== d.tasks.length || tasks.some(t => t.status !== 'awaiting_approval')) throw new Error('计划已派发或部分任务已变化');
    if (tasks.some(t => permissions.decision(s.project_id,t.employee_id) === 'deny')) throw new Error('只读权限不允许启动员工');
    transaction(() => {
      for (const task of tasks) permissions.grant(task.id,s.project_id,task.employee_id,source);
      db.prepare("UPDATE coordination_sessions SET status='running',updated_at=? WHERE id=?").run(now(),id);
      memory.append(s.project_id,id,'plan.dispatched',{ planId:s.plan_id,source }); checkpoint(id);
    });
    const failures: {taskId: string; error: string}[] = [];
    for (const task of tasks) { try { deps.resolveApproval(task.approval_id,true); } catch (e) { failures.push({taskId:task.id,error:String(e instanceof Error ? e.message : e)}); } }
    checkpoint(id);
    return { ...details(id), failures };
  }
  function reviseSession(id: string, input: Record<string, unknown>) {
    const s = editable(id,input.revision); const reason = text(input.reason);
    if (!['plan_review','running','attention','awaiting_acceptance','completed'].includes(s.status) && s.status !== 'running') throw new Error('当前需求已经可编辑');
    const active = s.plan_id ? rows<{id: string}>('SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.plan_id=? AND r.status IN (\'running\',\'starting\',\'stopping\')',s.plan_id) : [];
    transaction(() => {
      if (s.plan_id) {
        db.prepare("UPDATE approvals SET status='revoked',resolved_at=? WHERE task_id IN (SELECT id FROM tasks WHERE plan_id=? AND status IN ('awaiting_approval','queued','blocked')) AND status IN ('pending','approved')").run(now(),s.plan_id);
        db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE plan_id=? AND status IN ('awaiting_approval','queued','blocked')").run(now(),s.plan_id);
      }
      db.prepare("UPDATE coordination_sessions SET status='clarifying',confirmed_revision=NULL,revision=revision+1,updated_at=? WHERE id=?").run(now(),id);
      turn(session(id),'user','change_requested',reason); checkpoint(id);
    });
    const stopErrors: string[] = [];
    for (const run of active) try { deps.stopRun(run.id); } catch(e) { stopErrors.push(String(e)); }
    turn(session(id),'apix','clarification','已取消未启动任务并请求停止运行中的任务。请修改需求；停止结果以任务状态为准。');
    return {...details(id),stopErrors};
  }
  function editPlan(id: string, input: Record<string, unknown>) {
    const s = editable(id,input.revision);
    if (s.status !== 'plan_review' || input.planVersion !== details(id).planVersion) throw new Error('只能编辑当前待审计划');
    const steps = validateSteps(input.steps as PlanStep[]);
    transaction(() => {
      db.prepare("UPDATE approvals SET status='revoked',resolved_at=? WHERE task_id IN (SELECT id FROM tasks WHERE plan_id=?) AND status='pending'").run(now(),s.plan_id);
      db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE plan_id=?").run(now(),s.plan_id);
      writePlan(s,steps); checkpoint(id);
    });
    return details(id);
  }
  function changePolicy(projectId: string, input: Record<string, unknown>) {
    const subject = text(input.subject ?? 'apix',100);
    const policy = permissions.save(projectId,subject,input.mode as PermissionMode,Number(input.version));
    const affected = rows<Task>('SELECT t.* FROM tasks t JOIN coordination_plan_briefs b ON b.plan_id=t.plan_id WHERE t.project_id=? AND (?=\'apix\' OR t.employee_id=?)',projectId,subject,subject);
    const stopErrors: string[] = [];
    for (const t of affected) {
      if (['queued','awaiting_approval'].includes(t.status)) {
        db.prepare("UPDATE tasks SET status='awaiting_approval',updated_at=? WHERE id=?").run(now(),t.id);
        db.prepare("UPDATE approvals SET status='pending',resolved_at=NULL WHERE task_id=? AND status='approved'").run(t.id);
      }
      if (['running','stopping'].includes(t.status) && input.mode !== 'full_access') {
        for (const r of rows<{id: string}>('SELECT id FROM runs WHERE task_id=? AND status IN (\'running\',\'starting\',\'stopping\')',t.id)) try { deps.stopRun(r.id); } catch(e) { stopErrors.push(String(e)); }
      }
    }
    for (const planId of new Set(affected.map(t=>t.plan_id).filter((id): id is string=>!!id))) {
      const bound = row<{session_id:string}>('SELECT session_id FROM coordination_plan_briefs WHERE plan_id=?',planId);
      if (bound) { turn(session(bound.session_id),'apix','permission_changed','权限设置已更新。旧执行授权已失效，运行中的任务按停止请求处理；已派发计划可通过“调整需求”重新安排。'); checkpoint(bound.session_id); }
    }
    // Any permission revision invalidates grants; the user must revise an already dispatched plan.
    memory.append(projectId,projectId,'permission.applied',{subject,policy,stopErrors});
    return {policy,stopErrors};
  }
  function assertExecution(task: Task) {
    const bound = row<{session_id: string; revision: number}>('SELECT session_id,revision FROM coordination_plan_briefs WHERE plan_id=?',task.plan_id);
    if (!bound) { if (process.env.APIX_LEGACY_API === '1') return; throw new Error('此任务没有 ApiX 已确认的需求，请在目标工作台重新安排'); }
    const s = session(bound.session_id);
    if (s.status !== 'running' || s.plan_id !== task.plan_id || s.revision !== bound.revision || s.confirmed_revision !== bound.revision) throw new Error('需求或计划已失效');
    permissions.assertGranted(task.id,task.project_id,task.employee_id);
    if (!deps.employees().some(e => e.id === task.employee_id)) throw new Error('员工已停用或运行时不可用');
  }
  function activeTask(sessionId: string, taskId: string, revision: unknown): {s: Session; task: Task} {
    const s = editable(sessionId, revision);
    const task = row<Task>('SELECT * FROM tasks WHERE id=? AND plan_id=?',taskId,s.plan_id);
    if (!task || task.status !== 'running') throw new Error('只能指导当前计划中正在运行的任务');
    assertExecution(task);
    return {s,task};
  }
  function instructEmployee(sessionId: string, input: Record<string,unknown>) {
    const taskId = text(input.taskId,100); const content = text(input.content,2000);
    const {s,task} = activeTask(sessionId,taskId,input.revision);
    const message = deps.sendMessage({projectId:s.project_id,taskId:task.id,from:'apix-director',to:task.employee_id,type:'event',idempotencyKey:`user-guidance:${randomUUID()}`,timeoutMs:3600000,payload:{kind:'guidance',source:'user',content,requirementRevision:s.revision}});
    if (message.status === 'rejected') throw new Error('指导消息被监督规则拒绝');
    transaction(() => {turn(s,'user','worker_guidance',`向员工补充：${content}`);memory.append(s.project_id,s.id,'guidance.sent',{taskId,messageId:message.id,source:'user',content},'user');checkpoint(sessionId);});
    return details(sessionId);
  }
  async function superviseWorkerMessage(messageId: string) {
    const message = row<{id:string;project_id:string;task_id:string|null;from_agent:string;to_agent:string;type:string;payload:string;status:string}>('SELECT * FROM agent_messages WHERE id=?',messageId);
    if (!message || !message.task_id || message.to_agent !== 'apix-director' || message.type !== 'event' || message.status === 'rejected') return;
    let payload: Record<string,unknown>;
    try { payload = object(JSON.parse(message.payload)); } catch { return; }
    if (payload.kind !== 'progress_update' || typeof payload.summary !== 'string' || !payload.summary.trim()) return;
    const summary = payload.summary.trim().slice(0,2000); const blocked = payload.blocked === true;
    const task = row<Task>('SELECT * FROM tasks WHERE id=?',message.task_id);
    const bound = task?.plan_id ? row<{session_id:string;revision:number;requirements_json:string}>('SELECT * FROM coordination_plan_briefs WHERE plan_id=?',task.plan_id) : undefined;
    if (!task || !bound || task.employee_id !== message.from_agent || task.project_id !== message.project_id) return;
    const s = session(bound.session_id);
    if (s.plan_id !== task.plan_id || s.revision !== bound.revision || s.status !== 'running' || task.status !== 'running') return;
    try { assertExecution(task); } catch { return; }
    const claimed = db.prepare("INSERT OR IGNORE INTO apix_guidance(message_id,task_id,status,summary,updated_at) VALUES (?,?,'processing',?,?)").run(messageId,task.id,summary,now());
    if (!claimed.changes) return;
    try {
      const count = row<{n:number}>("SELECT COUNT(*) AS n FROM apix_guidance WHERE task_id=? AND action='guide' AND status='sent'",task.id)?.n ?? 0;
      const decision = count >= 3 ? {action:'escalate' as const,focus:'verification' as const,mode:'rules' as const} : await agent.guide(JSON.parse(bound.requirements_json) as Requirements,task.prompt,{summary,blocked});
      const current = session(bound.session_id);
      const liveTask = row<Task>('SELECT * FROM tasks WHERE id=?',task.id);
      if (!liveTask || current.plan_id !== task.plan_id || current.revision !== bound.revision || current.status !== 'running' || liveTask.status !== 'running') throw new Error('任务状态或用户需求已变化');
      assertExecution(liveTask);
      const requirements = JSON.parse(bound.requirements_json) as Requirements;
      let outboundId: string | null = null;
      let action = decision.action;
      if (action === 'guide') {
        const focus = decision.focus === 'scope' ? `范围：${requirements.scope}` : decision.focus === 'verification' ? `验收：${requirements.acceptance}` : decision.focus === 'delivery' ? `交付物：${requirements.deliverable}` : `继续核对当前已批准任务及其前置交付物：${task.prompt}`;
        const content = `ApiX 根据你的进度报告提醒：请仅在已批准任务范围内继续。${focus} 若存在新需求或权限问题，请上报阻塞。`;
        const sent = deps.sendMessage({projectId:s.project_id,taskId:task.id,from:'apix-director',to:task.employee_id,type:'event',idempotencyKey:`apix-guidance:${message.id}`,correlationId:message.id,timeoutMs:3600000,payload:{kind:'guidance',source:'apix',focus:decision.focus,content,requirementRevision:s.revision}});
        if (sent.status === 'rejected') throw new Error('指导消息被监督规则拒绝');
        outboundId = sent.id;
        turn(current,'apix','worker_guidance',`员工报告：${summary}\nApiX 指导：${content}`);
      } else if (action === 'escalate') {
        turn(current,'apix','worker_attention',`员工报告阻塞或指导次数已达上限：${summary}\n请向员工补充当前任务说明，或使用“中途调整”修改目标。`);
      } else {
        turn(current,'apix','worker_progress',`已收到员工进度：${summary}`);
      }
      db.prepare("UPDATE apix_guidance SET status=?,action=?,focus=?,outbound_id=?,updated_at=? WHERE message_id=?").run(action === 'guide' ? 'sent' : 'recorded',action,decision.focus,outboundId,now(),messageId);
      memory.append(s.project_id,s.id,'guidance.decided',{taskId:task.id,reportMessageId:messageId,outboundId,action,focus:decision.focus,mode:decision.mode,summary});
      checkpoint(s.id);
    } catch (error) {
      db.prepare("UPDATE apix_guidance SET status='skipped',summary=?,updated_at=? WHERE message_id=?").run(`${summary}\n${String(error instanceof Error ? error.message : error).slice(0,300)}`,now(),messageId);
      memory.append(s.project_id,s.id,'guidance.skipped',{taskId:task.id,reportMessageId:messageId,error:String(error)});
    }
  }
  function superviseActiveRuns(staleAfterMs = 60000) {
    for (const active of rows<{run_id:string;task_id:string;started_at:string;session_id:string}>('SELECT r.id AS run_id,r.task_id,r.started_at,b.session_id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN coordination_plan_briefs b ON b.plan_id=t.plan_id WHERE r.status=\'running\' AND t.status=\'running\'')) {
      if (Date.now() - Date.parse(active.started_at) < staleAfterMs) continue;
      const task = row<Task>('SELECT * FROM tasks WHERE id=?',active.task_id)!;
      const s = session(active.session_id);
      try {
        assertExecution(task);
        const latestReport = row<{created_at:string}>('SELECT created_at FROM agent_messages WHERE task_id=? AND from_agent=? AND to_agent=\'apix-director\' AND type=\'event\' ORDER BY created_at DESC LIMIT 1',task.id,task.employee_id);
        if (latestReport && Date.now() - Date.parse(latestReport.created_at) < staleAfterMs) continue;
        const sent = deps.sendMessage({projectId:s.project_id,taskId:task.id,from:'apix-director',to:task.employee_id,type:'event',idempotencyKey:`apix-status-request:${active.run_id}`,timeoutMs:3600000,payload:{kind:'progress_request',source:'apix',content:'请报告当前任务的真实进度、已完成的检查和阻塞情况。遇到新需求或权限问题时不要自行扩大任务范围。'}}) as {id:string;status:string;duplicate?:boolean};
        if (sent.status === 'rejected' || sent.duplicate) continue;
        turn(s,'apix','progress_requested',`ApiX 已主动向员工请求进度：${task.prompt.slice(0,120)}`);
        memory.append(s.project_id,s.id,'guidance.progress_requested',{taskId:task.id,runId:active.run_id,messageId:sent.id});
        checkpoint(s.id);
      } catch (error) {
        memory.append(s.project_id,s.id,'guidance.monitor_failed',{taskId:task.id,runId:active.run_id,error:String(error)});
      }
    }
  }
  function recordTask(taskId: string, kind: string, payload: unknown) {
    const t = row<Task>('SELECT * FROM tasks WHERE id=?',taskId); if (!t) return;
    memory.append(t.project_id,taskId,kind,payload);
    const b = t.plan_id ? row<{session_id: string}>('SELECT session_id FROM coordination_plan_briefs WHERE plan_id=?',t.plan_id) : undefined;
    if (b) { memory.append(t.project_id,b.session_id,kind,{taskId,payload}); checkpoint(b.session_id); }
  }
  function timeline(id: string, at?: number) { const s = session(id); return memory.stateAt(s.project_id,id,at); }
  function getSettings() { return row<{provider: string; model: string; baseUrl: string; apiType: string; apiKeyEnv: string}>("SELECT provider,model,base_url AS baseUrl,api_type AS apiType,api_key_env AS apiKeyEnv FROM apix_manager_settings WHERE id=1") ?? { provider:'',model:'',baseUrl:'',apiType:'openai-completions',apiKeyEnv:'' }; }
  function saveSettings(input: Record<string, unknown>) {
    const provider = String(input.provider ?? '').trim(); const model = String(input.model ?? '').trim();
    const baseUrl = String(input.baseUrl ?? '').trim(); const apiType = String(input.apiType ?? 'openai-completions').trim(); const apiKeyEnv = String(input.apiKeyEnv ?? '').trim();
    const validation = validateModelConfig({provider, model, baseUrl, apiType, apiKeyEnv});
    if (!validation.valid) throw new Error(validation.error);
    db.prepare('INSERT INTO apix_manager_settings(id,provider,model,base_url,api_type,api_key_env) VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,base_url=excluded.base_url,api_type=excluded.api_type,api_key_env=excluded.api_key_env').run(baseUrl ? 'apix-custom' : provider,model,baseUrl,apiType,apiKeyEnv);
    return getSettings();
  }
  return { createSession, answerSession, discuss, setInteractionMode, confirmSession, dispatchSession, reviseSession, editPlan, changePolicy, assertExecution, recordTask, instructEmployee, superviseWorkerMessage, superviseActiveRuns,
    listSessions: (projectId: string) => rows<Session>('SELECT * FROM coordination_sessions WHERE project_id=? ORDER BY updated_at DESC,rowid DESC',projectId).map(s=>details(s.id)),
    sessionDetails: details, timeline, getSettings, saveSettings };
}
