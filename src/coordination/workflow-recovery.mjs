import {classifyFault} from '../../dist/src/recovery/fault-policy.js';
// Ordinary automatic collaboration shares the existing recovery authorization and budget gates.
export function createWorkflowRecovery({db,row,rows,now,workflow,permissions,scheduling,retry,record=()=>{},fault=task=>classifyFault(new Error(task.result??''),{kind:'agent'})}) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_recoveries(task_id TEXT PRIMARY KEY REFERENCES tasks(id),original_prompt TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,last_run_id TEXT,state TEXT NOT NULL,reason TEXT)`);
  let busy=false;
  function authorized(task) {
    const session=row(`SELECT s.* FROM coordination_sessions s JOIN coordination_plan_briefs b ON b.session_id=s.id
      WHERE b.plan_id=? AND s.plan_id=b.plan_id AND s.revision=b.revision AND s.confirmed_revision=b.revision AND s.status='running'`,task.plan_id);
    if(!session || session.project_id!==task.project_id || !workflow(task.project_id).enabled || permissions.decision(task.project_id,task.employee_id)!=='allow')return false;
    try{permissions.assertGranted(task.id,task.project_id,task.employee_id);return true;}catch{return false;}
  }
  function pending(task) {
    if(fault(task).strategy!=='repair')return false;
    if(row('SELECT plan_id FROM autonomy_plans WHERE plan_id=?',task.plan_id) || !authorized(task))return false;
    const saved=row('SELECT * FROM workflow_recoveries WHERE task_id=?',task.id);
    return !saved || (saved.state!=='attention' && saved.attempts<2 && Date.now()-Date.parse(saved.started_at)<30*60000);
  }
  async function tick() {
    if(busy)return;busy=true;
    try {for(const task of rows("SELECT * FROM tasks WHERE status='failed' AND plan_id NOT IN (SELECT plan_id FROM autonomy_plans) ORDER BY rowid")) {
      if(!authorized(task))continue;
      const saved=row('SELECT * FROM workflow_recoveries WHERE task_id=?',task.id);
      if(saved?.state==='attention')continue;
      const run=row('SELECT * FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
      // Never replay a process whose exit is uncertain, or resolve a code conflict silently.
      if(run && (!run.ended_at || !['failed','completed','cancelled'].includes(run.status)))continue;
      if(row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",task.id))continue;
      if(rows('SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?',task.id).some(t=>t.status!=='accepted'))continue;
      const failure=fault(task);
      if(!saved)db.prepare("INSERT INTO workflow_recoveries VALUES (?,?,0,?,NULL,'waiting',NULL)").run(task.id,task.prompt,now());
      const state=saved??row('SELECT * FROM workflow_recoveries WHERE task_id=?',task.id);
      const halt=reason=>{db.prepare("UPDATE workflow_recoveries SET state='attention',reason=? WHERE task_id=?").run(reason,task.id);record(task.id,'workflow.recovery_attention',{reason});};
      if(failure.strategy!=='repair'){halt('故障需要处理后恢复：'+failure.category);record(task.id,'workflow.recovery_blocked',{fault:failure});continue;}
      if(state.attempts>=2 || Date.now()-Date.parse(state.started_at)>=30*60000){halt('自动恢复已达到 2 次或 30 分钟上限');continue;}
      if(state.state==='prepared'){halt('恢复启动被中断，须检查原运行后再处理');continue;}
      const candidates=scheduling.candidates(task.project_id,scheduling.taskSpec(task.id),task.employee_id).filter(c=>c.eligible && workflow(task.project_id).employeeIds.includes(c.employeeId) && permissions.decision(task.project_id,c.employeeId)==='allow');
      if(!candidates.length){halt('没有满足当前权限、能力和额度条件的修复员工');continue;}
      const chosen=candidates.find(c=>!c.waiting && c.employeeId!==task.employee_id)??candidates.find(c=>!c.waiting);
      if(!chosen)continue;
      const prompt=`${state.original_prompt}\n\nApiX 自动恢复（第 ${state.attempts+1}/2 次）：上次员工运行失败。检查本任务已有文件及运行记录，修复失败原因并执行相应测试，提交实际验证证据。保持原需求、模块边界、依赖和预算；保留已完成工作，不更改授权，不自行启动其他 Agent。先核对已有命令和外部操作的结果；不要重放结果不明的发布、付款、消息或外部写入，遇到此类情况报告阻塞。`;
      if(prompt.length>10000){halt('修复指令超过上下文上限');continue;}
      db.prepare("UPDATE workflow_recoveries SET state='prepared',attempts=attempts+1,last_run_id=? WHERE task_id=?").run(run?.id??null,task.id);
      try {await retry(task,chosen.employeeId,prompt);db.prepare("UPDATE workflow_recoveries SET state='dispatched',reason=NULL WHERE task_id=?").run(task.id);record(task.id,'workflow.recovery_dispatched',{attempt:state.attempts+1,employeeId:chosen.employeeId});}
      catch {halt('自动恢复未能安全启动，请检查任务恢复记录、权限和工作区');}
    }} finally {busy=false;}
  }
  return {tick,pending};
}
