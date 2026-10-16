// Advances approved DAG tasks when their dependencies finish or fail.
export function createTaskScheduler({ db, row, rows, now, launch, recordTask = () => {}, admission=()=>null, onWaiting=()=>{} }) {
  let pumping=false;
  function advance(id) {
    const candidate=row('SELECT * FROM tasks WHERE id=?',id);
    if(!candidate || !['queued','awaiting_approval'].includes(candidate.status))return;
      const dependencies = rows("SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?", candidate.id);
      if (dependencies.some((dependency) => ["failed", "cancelled", "blocked", "unknown", "rejected", "needs_revision"].includes(dependency.status))) {
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
      if(reason){db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),candidate.id);onWaiting(candidate,reason);return;}
      if (["queued", "awaiting_approval"].includes(candidate.status)) {
        db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(now(), candidate.id);
        try { launch(candidate); } catch (error) {
          db.prepare("UPDATE tasks SET status=?,result=?,updated_at=? WHERE id=?").run(['HANDOFF_CONFLICT','WORKER_CREDENTIAL_CONFLICT'].includes(error.code)?'blocked':'failed',String(error.message), now(), candidate.id);
          recordTask(candidate.id, 'task.launch_failed', {error: String(error.message)});
          scheduleDependents(candidate.id);
        }
      }
  }
  function scheduleDependents(completedTaskId) {
    for(const task of rows('SELECT task_id FROM task_dependencies WHERE depends_on_id=?',completedTaskId))advance(task.task_id);
  }
  function pump() {
    if(pumping)return;
    pumping=true;
    try {for(const task of rows("SELECT id FROM tasks WHERE status='queued' ORDER BY rowid"))advance(task.id);}finally{pumping=false;}
  }
  return { scheduleDependents,pump };
}
