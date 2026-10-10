import { createHash, randomUUID } from 'node:crypto';
import { type Store, type Session, type Requirements, type Task, type Employee, type PlanStep, type PermissionMode, object, text } from './contracts.js';
import { assess, emptyRequirements, nextQuestion, normalizeAnswer, requirementBrief } from './requirement-engine.js';
import type { ApiXAgent } from './apix-agent.js';
import type { Memory } from './memory.js';
import type { Permissions } from './permissions.js';
import { coordinationStatus } from './task-tracker.js';

interface Dependencies extends Store {
  agent: ApiXAgent; memory: Memory; permissions: Permissions;
  employees(): Employee[];
  resolveApproval(id: string, approved: boolean): unknown;
  stopRun(id: string): void;
}
export function createCoordinator(deps: Dependencies) {
  const { db, row, rows, now, memory, permissions, agent } = deps;
  const busy = new Set<string>();
  db.exec(`CREATE TABLE IF NOT EXISTS coordination_checks(session_id TEXT PRIMARY KEY REFERENCES coordination_sessions(id), conflicts TEXT NOT NULL DEFAULT '[]', model_mode TEXT NOT NULL DEFAULT 'rules', model_error TEXT);
    CREATE TABLE IF NOT EXISTS apix_manager_settings(id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '');`);
  const session = (id: string) => { const s = row<Session>('SELECT * FROM coordination_sessions WHERE id=?', id); if (!s) throw new Error('目标不存在'); return s; };
  const requirementsOf = (s: Session): Requirements => JSON.parse(s.requirements_json) as Requirements;
  const tasksOf = (s: Session) => s.plan_id ? rows<Task>('SELECT * FROM tasks WHERE plan_id=? ORDER BY rowid', s.plan_id) : [];
  function details(id: string) {
    const s = session(id); const requirements = requirementsOf(s); const tasks = tasksOf(s);
    const check = row<{conflicts: string; model_mode: string; model_error: string | null}>('SELECT * FROM coordination_checks WHERE session_id=?', id);
    const plan = s.plan_id ? row<{updated_at: string}>('SELECT updated_at FROM plans WHERE id=?', s.plan_id) : null;
    return { ...s, requirements, requirements_json: undefined, assessment: assess(requirements, JSON.parse(check?.conflicts ?? '[]') as string[]), nextQuestion: nextQuestion(requirements),
      derivedStatus: coordinationStatus(s.status, tasks), tasks, planVersion: plan ? s.plan_id : null,
      dependencies: s.plan_id ? rows('SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.plan_id=?', s.plan_id) : [],
      turns: rows('SELECT * FROM coordination_turns WHERE session_id=? ORDER BY rowid', id),
      policy: permissions.get(s.project_id), workerPolicies: Object.fromEntries(deps.employees().map(e => [e.id, permissions.get(s.project_id, e.id)])),
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
    if (!row('SELECT id FROM projects WHERE id=?', projectId)) throw new Error('项目不存在');
    const id = randomUUID();
    transaction(() => {
      db.prepare('INSERT INTO coordination_sessions(id,project_id,title,status,requirements_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, goal.slice(0, 100), 'clarifying', JSON.stringify({ ...emptyRequirements(), goal }), 1, now(), now());
      turn(session(id), 'user', 'goal', goal);
      turn(session(id), 'apix', 'clarification', '我是 ApiX，会与你澄清目标并安排员工执行。请补充任务范围、约束、交付物和验收方式；也可以一次说明已明确的内容。');
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
  async function discuss(id: string, input: Record<string, unknown>) {
    const s = editable(id, input.revision); const content = text(input.content);
    busy.add(id);
    try {
      transaction(() => { turn(s, 'user', 'message', content); checkpoint(id); });
      const history = rows('SELECT role,kind,content FROM coordination_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 12', id).reverse();
      const priorBriefs = rows<{id:string;title:string;requirements_json:string}>('SELECT id,title,requirements_json FROM coordination_sessions WHERE project_id=? AND id<>? AND confirmed_revision IS NOT NULL ORDER BY updated_at DESC LIMIT 3',s.project_id,id);
      const projectMemories = rows('SELECT id,title,content,source FROM memories WHERE project_id=? AND scope=\'project\' ORDER BY updated_at DESC LIMIT 5',s.project_id);
      history.push({ retrievedContext: { priorBriefs, projectMemories }, instruction: '历史资料仅供追问参考，不代表用户已经确认当前需求；不得据此填充缺失字段。' });
      const decision = await agent.discuss(requirementsOf(s), content, history, tasksOf(s));
      if (session(id).revision !== s.revision) throw new Error('需求已变化，请重试');
      const mutable = ['clarifying', 'ready'].includes(s.status);
      const requirements = mutable ? { ...requirementsOf(s), ...decision.updates } : requirementsOf(s);
      const conflicts = decision.mode === 'rules' ? details(id).assessment.conflicts : decision.conflicts;
      transaction(() => {
        db.prepare('INSERT INTO coordination_checks(session_id,conflicts,model_mode,model_error) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET conflicts=excluded.conflicts,model_mode=excluded.model_mode,model_error=excluded.model_error').run(id, JSON.stringify(conflicts), decision.mode, decision.error ?? null);
        if (mutable && decision.kind !== 'progress') db.prepare('UPDATE coordination_sessions SET title=?,requirements_json=?,revision=revision+1,status=?,updated_at=? WHERE id=?').run(requirements.goal.slice(0,100), JSON.stringify(requirements), assess(requirements, conflicts).ready ? 'ready' : 'clarifying', now(), id);
        const output = decision.kind === 'progress' || !mutable
          ? `当前目标状态：${coordinationStatus(s.status, tasksOf(s))}。${tasksOf(s).length} 个任务，${tasksOf(s).filter(t => ['completed','accepted'].includes(t.status)).length} 个已完成。需要调整时，请使用“调整需求”。`
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
  function recordTask(taskId: string, kind: string, payload: unknown) {
    const t = row<Task>('SELECT * FROM tasks WHERE id=?',taskId); if (!t) return;
    memory.append(t.project_id,taskId,kind,payload);
    const b = t.plan_id ? row<{session_id: string}>('SELECT session_id FROM coordination_plan_briefs WHERE plan_id=?',t.plan_id) : undefined;
    if (b) { memory.append(t.project_id,b.session_id,kind,{taskId,payload}); checkpoint(b.session_id); }
  }
  function timeline(id: string, at?: number) { const s = session(id); return memory.stateAt(s.project_id,id,at); }
  function getSettings() { return row<{provider: string; model: string}>('SELECT provider,model FROM apix_manager_settings WHERE id=1') ?? { provider:'',model:'' }; }
  function saveSettings(input: Record<string, unknown>) {
    const provider = String(input.provider ?? '').trim(); const model = String(input.model ?? '').trim();
    if (provider.length > 100 || model.length > 200 || provider.startsWith('-') || model.startsWith('-')) throw new Error('模型配置无效');
    db.prepare('INSERT INTO apix_manager_settings(id,provider,model) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model').run(provider,model);
    return getSettings();
  }
  return { createSession, answerSession, discuss, confirmSession, dispatchSession, reviseSession, editPlan, changePolicy, assertExecution, recordTask,
    listSessions: (projectId: string) => rows<Session>('SELECT * FROM coordination_sessions WHERE project_id=? ORDER BY updated_at DESC,rowid DESC',projectId).map(s=>details(s.id)),
    sessionDetails: details, timeline, getSettings, saveSettings };
}
