/**
 * DAG 任务调度器 - 基于有向无环图的任务依赖推进与准入控制
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. 推进已审批的 DAG 任务：当前置依赖完成或失败时自动更新任务状态
 *   2. 失败传播：前置任务失败时将后续任务标记为 blocked
 *   3. 准入控制（admission）：在派发前执行自定义准入检查
 *   4. 自动恢复：前置任务失败但可恢复时，保持后续任务在队列中等待
 *   5. pump 全量扫描：定期扫描排队任务并尝试推进
 * 依赖关系：
 *   - 被协调层主循环调用 pump() / scheduleDependents() 驱动任务推进
 *   - 依赖外部注入的 launch 函数执行实际任务派发
 *   - 依赖 task_dependencies 表维护 DAG 边关系
 */
// 推进已审批的 DAG 任务：当前置依赖完成或失败时自动更新状态
export function createTaskScheduler({ db, row, rows, now, launch, recordTask = () => {}, admission=()=>null, onWaiting=()=>{}, recoverable=()=>false }) {
  // pumping 互斥标志：防止 pump 被并发触发
  let pumping=false;

  /**
   * advance - 尝试推进单个任务的状态机
   * @param id - 任务 ID
   *
   * 状态流转逻辑：
   *   1. queued / awaiting_approval → 检查前置依赖
   *   2. 前置有不可恢复的失败 → blocked，并级联阻塞后续任务
   *   3. 前置全部失败但可恢复 → 保持 queued，等待自动恢复
   *   4. 前置未完成 → 保持 queued，附带等待原因
   *   5. 前置全部完成 + 审批通过 + 准入放行 → running，调用 launch 派发
   */
  function advance(id) {
    const candidate=row('SELECT * FROM tasks WHERE id=?',id);
    // 只处理排队中或待审批状态的任务
    if(!candidate || !['queued','awaiting_approval'].includes(candidate.status))return;
      // 查询当前任务的所有前置依赖任务
      const dependencies = rows("SELECT t.* FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?", candidate.id);
      // 前置依赖中存在不可恢复的终态（failed/cancelled/blocked/unknown/rejected/needs_revision）
      if (dependencies.some((dependency) => ["failed", "cancelled", "blocked", "unknown", "rejected", "needs_revision"].includes(dependency.status))) {
        const failed=dependencies.filter(d=>!["accepted","completed","queued","running","awaiting_approval"].includes(d.status));
        // 所有失败的前置任务都是 failed 且可恢复 → 保持排队等待自动恢复
        if(failed.every(d=>d.status==='failed' && recoverable(d))){
          db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),candidate.id);
          onWaiting(candidate,'前置步骤失败，ApiX 正在自动恢复');return;
        }
        // 否则标记为 blocked，并级联阻塞所有后续依赖任务
        db.prepare("UPDATE tasks SET status='blocked',updated_at=? WHERE id=? AND status IN ('queued','awaiting_approval')").run(now(), candidate.id);
        scheduleDependents(candidate.id);
        return;
      }
      // 判断是否需要人工验收：collaboration / coordinator 模式的计划或有会议条目的任务
      const requiresAcceptance = ['collaboration','coordinator'].includes(row("SELECT mode FROM plans WHERE id=?", candidate.plan_id)?.mode) || !!row("SELECT id FROM meeting_items WHERE task_id=?", candidate.id);
      // 查询最新的启动审批记录
      const approval = row("SELECT status FROM approvals WHERE task_id=? AND action='start-agent-in-project' ORDER BY created_at DESC LIMIT 1", candidate.id);
      // 审批未通过则不推进
      if (approval?.status !== "approved") return;
      let reason=null;
      // 检查前置依赖是否全部完成（需要验收时仅 accepted 即可，否则需要 completed/accepted）
      if (!dependencies.every((dependency) => requiresAcceptance ? dependency.status === "accepted" : ["completed", "accepted"].includes(dependency.status))) reason='等待前置任务验收';
      // 前置依赖已满足，执行自定义准入检查
      else reason=admission(candidate);
      // 有阻塞原因 → 保持排队状态并通知
      if(reason){if(candidate.status!=='queued'||candidate.queue_reason!==reason){db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),candidate.id);onWaiting(candidate,reason);}return;}
      // 所有条件满足 → 推进到 running 状态并派发执行
      if (["queued", "awaiting_approval"].includes(candidate.status)) {
        db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(now(), candidate.id);
        // failed 回调：派发失败时根据错误类型设置 blocked 或 failed 状态
        const failed=error=>{
          // 防止重复处理：仅当任务仍在 running/failed/blocked 状态时处理
          if(!['running','failed','blocked'].includes(row('SELECT status FROM tasks WHERE id=?',candidate.id)?.status))return;
          // HANDOFF_CONFLICT / WORKER_CREDENTIAL_CONFLICT → blocked；其他 → failed
          db.prepare("UPDATE tasks SET status=?,result=?,updated_at=? WHERE id=?").run(['HANDOFF_CONFLICT','WORKER_CREDENTIAL_CONFLICT'].includes(error.code)?'blocked':'failed',String(error.message), now(), candidate.id);
          recordTask(candidate.id, 'task.launch_failed', {error: String(error.message)});
          return scheduleDependents(candidate.id);
        };
        try { const result=launch(candidate);return result?.then?result.catch(failed):result; } catch (error) {return failed(error);}
      }
  }

  /**
   * scheduleDependents - 级联推进当前任务的所有后续依赖任务
   * @param completedTaskId - 已完成（或失败/阻塞）的任务 ID
   * @returns Promise，所有后续任务的 advance 执行完毕后可等待
   */
  function scheduleDependents(completedTaskId) {
    const work=Promise.all(rows('SELECT task_id FROM task_dependencies WHERE depends_on_id=?',completedTaskId).map(task=>advance(task.task_id)));
    void work.catch(()=>console.error('任务派发未可靠完成，请检查任务记录。'));return work;
  }

  /**
   * pump - 全量扫描所有排队任务并尝试推进
   *
   * 在每次协调循环中被调用，确保所有 queued 状态的任务都有机会被检查
   */
  function pump() {
    if(pumping)return;
    pumping=true;
    try {for(const task of rows("SELECT id FROM tasks WHERE status='queued' ORDER BY rowid")){const work=advance(task.id);if(work?.then)void work.catch(()=>console.error('排队任务派发未可靠完成，请检查任务记录。'));}}finally{pumping=false;}
  }

  /**
   * resumeBlocked - 恢复指定计划中被阻塞的任务
   * @param planId - 计划 ID
   *
   * 循环扫描 blocked 任务，当满足以下条件时将其恢复为 queued：
   *   - 无运行记录、无结果、无代码冲突
   *   - 启动审批已通过
   *   - 所有前置依赖处于可接受状态
   */
  function resumeBlocked(planId) {
    let changed;
    // 循环扫描直到没有新的状态变更（收敛）
    do {changed=false;for(const task of rows("SELECT * FROM tasks WHERE plan_id=? AND status='blocked'",planId)){
      // 已有结果、运行记录或代码冲突的任务不恢复
      if(task.result || row('SELECT id FROM runs WHERE task_id=? LIMIT 1',task.id) || row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",task.id))continue;
      const approval=row("SELECT status FROM approvals WHERE task_id=? AND action='start-agent-in-project' ORDER BY created_at DESC,rowid DESC LIMIT 1",task.id);
      const dependencies=rows('SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?',task.id);
      // 审批通过 + 有前置依赖 + 前置依赖状态均可接受 → 恢复为 queued
      if(approval?.status!=='approved' || !dependencies.length || dependencies.some(t=>!['accepted','completed','queued','running','awaiting_approval'].includes(t.status)))continue;
      db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(now(),task.id);onWaiting(task,'等待恢复任务验收');changed=true;
    }}while(changed);
  }
  return { scheduleDependents,pump,resumeBlocked };
}
