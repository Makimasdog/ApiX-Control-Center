// Advances approved DAG tasks when their dependencies finish or fail.
export function createTaskScheduler({ db, row, rows, now, launch }) {
  function scheduleDependents(completedTaskId) {
    for (const candidate of rows("SELECT t.* FROM tasks t JOIN task_dependencies d ON d.task_id=t.id WHERE d.depends_on_id=?", completedTaskId)) {
      const dependencies = rows("SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?", candidate.id);
      if (dependencies.some((dependency) => ["failed", "cancelled", "blocked", "unknown", "rejected", "needs_revision"].includes(dependency.status))) {
        db.prepare("UPDATE tasks SET status='blocked',updated_at=? WHERE id=? AND status IN ('queued','awaiting_approval')").run(now(), candidate.id);
        scheduleDependents(candidate.id);
        continue;
      }
      const requiresAcceptance = row("SELECT mode FROM plans WHERE id=?", candidate.plan_id)?.mode === "collaboration" || !!row("SELECT id FROM meeting_items WHERE task_id=?", candidate.id);
      if (!dependencies.every((dependency) => requiresAcceptance ? dependency.status === "accepted" : ["completed", "accepted"].includes(dependency.status))) continue;
      const approval = row("SELECT status FROM approvals WHERE task_id=? AND action='start-agent-in-project' ORDER BY created_at DESC LIMIT 1", candidate.id);
      if (approval?.status !== "approved") continue;
      if (["queued", "awaiting_approval"].includes(candidate.status)) {
        db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(now(), candidate.id);
        try { launch(candidate); } catch { db.prepare("UPDATE tasks SET status='failed',updated_at=? WHERE id=?").run(now(), candidate.id); }
      }
    }
  }
  return { scheduleDependents };
}
