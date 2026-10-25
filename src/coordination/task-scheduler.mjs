// Advances approved DAG tasks when their dependencies finish or fail.
export function createTaskScheduler({ db, row, rows, now, launch, recordTask = () => {}, admission=()=>null, onWaiting=()=>{}, recoverable=()=>false }) {
  let pumping=false;
  function advance(id) {
    const candidate=row('SELECT * FROM tasks WHERE id=?',id);
    if(!candidate || !['queued','awaiting_approval'].includes(candidate.status))return;
      const dependencies = rows("SELECT t.* FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?", candidate.id);
      if (dependencies.some((dependency) => ["failed", "cancelled", "blocked", "unknown", "rejected", "needs_revision"].includes(dependency.status))) {
        const failed=dependencies.filter(d=>!["accepted","completed","queued","running","awaiting_approval"].includes(d.status));
        if(failed.every(d=>d.status==='failed' && recoverable(d))){
          db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),candidate.id);
          onWaiting(candidate,'前置步骤失败，ApiX 正在自动恢复');return;
        }
        db.prepare("UPDATE tasks SET status='blocked',updated_at=? WHERE id=? AND status IN ('queued','awaiting_approval')").run(now(), candidate.id);
        scheduleDependents(candidate.id);
        return;
      }
      const requiresAcceptance = ['collaboration','coordinator'].includes(row("SELECT mode FROM plans WHERE id=?", candidate.plan_id)?.mode) || !!row("SELECT id FROM meeting_items WHERE task_id=?", candidate.id);
      const approval = row("SELECT status FROM approvals WHERE task_id=? AND action='start-agent-in-project' ORDER BY created_at DESC LIMIT 1", candidate.id);
      if (approval?.status !== "approved") return;
      let reason=null;
      if (!dependencies.every((dependency) => requiresAcceptance ? dependency.status === "accepted" : ["completed", "accepted"].includes(dependency.status))) reason='等待前置任务验收';
      else reason=admission(candidate);
      if(reason){if(candidate.status!=='queued'||candidate.queue_reason!==reason){db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),candidate.id);onWaiting(candidate,reason);}return;}
      if (["queued", "awaiting_approval"].includes(candidate.status)) {
        db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(now(), candidate.id);
        const failed=error=>{
          if(!['running','failed','blocked'].includes(row('SELECT status FROM tasks WHERE id=?',candidate.id)?.status))return;
          db.prepare("UPDATE tasks SET status=?,result=?,updated_at=? WHERE id=?").run(['HANDOFF_CONFLICT','WORKER_CREDENTIAL_CONFLICT'].includes(error.code)?'blocked':'failed',String(error.message), now(), candidate.id);
          recordTask(candidate.id, 'task.launch_failed', {error: String(error.message)});
          return scheduleDependents(candidate.id);
        };
        try { const result=launch(candidate);return result?.then?result.catch(failed):result; } catch (error) {return failed(error);}
      }
  }
  function scheduleDependents(completedTaskId) {
    const work=Promise.all(rows('SELECT task_id FROM task_dependencies WHERE depends_on_id=?',completedTaskId).map(task=>advance(task.task_id)));
    void work.catch(()=>console.error('任务派发未可靠完成，请检查任务记录。'));return work;
  }
  function pump() {
    if(pumping)return;
    pumping=true;
    try {for(const task of rows("SELECT id FROM tasks WHERE status='queued' ORDER BY rowid")){const work=advance(task.id);if(work?.then)void work.catch(()=>console.error('排队任务派发未可靠完成，请检查任务记录。'));}}finally{pumping=false;}
  }
  function resumeBlocked(planId) {
    let changed;
    do {changed=false;for(const task of rows("SELECT * FROM tasks WHERE plan_id=? AND status='blocked'",planId)){
      if(task.result || row('SELECT id FROM runs WHERE task_id=? LIMIT 1',task.id) || row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",task.id))continue;
      const approval=row("SELECT status FROM approvals WHERE task_id=? AND action='start-agent-in-project' ORDER BY created_at DESC,rowid DESC LIMIT 1",task.id);
      const dependencies=rows('SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?',task.id);
      if(approval?.status!=='approved' || !dependencies.length || dependencies.some(t=>!['accepted','completed','queued','running','awaiting_approval'].includes(t.status)))continue;
      db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),task.id);onWaiting(task,'等待恢复任务验收');changed=true;
    }}while(changed);
  }
  return { scheduleDependents,pump,resumeBlocked };
}
