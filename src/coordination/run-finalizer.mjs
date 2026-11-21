/**
 * Run 终态收尾 - 唯一的终态写入入口（CAS + 事务 + 幂等）
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. 只有 starting/running/stopping 的 Run 能进入终态，且只能写入一次
 *   2. Run 终态、Task 状态、预算结算在同一事务内提交
 *   3. DAG 推进等外部副作用在事务提交后执行；重复收尾不会重复触发
 * 依赖关系：
 *   - 被 control-plane.mjs 的 setRun 调用
 *   - 依赖外部注入的 settle（预算结算）、onTaskStatus（消息事件）、afterCommit（DAG 推进）
 *
 * 设计原则：unknown 是隔离终态，不是可以被迟到进程退出覆盖的中间态。
 */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown', 'blocked']);
export const TERMINAL_RUN_STATUSES = TERMINAL;

/**
 * createRunFinalizer - 创建 Run 终态收尾器
 * @param store - {db,row,now}
 * @param hooks - {settle, onTaskStatus, afterCommit}
 * @returns {finalize, isTerminal}
 */
export function createRunFinalizer({ db, row, now }, { settle = () => {}, onTaskStatus = () => {}, afterCommit = () => {} }) {
  /**
   * finalize - 把 Run 收敛到终态
   * @param runId - 运行 ID
   * @param status - 目标终态
   * @param source - 状态来源
   * @param exitCode - 进程退出码（可选）
   * @param evidence - 停止证据（quiescent/root_exited/unknown，可选）
   * @param options.deferAfterCommit - 是否推迟 DAG 推进（由调用方接管后续流程）
   * @param options.releaseBudget - 是否直接释放预留（准备阶段未真正启动 Agent 时）
   * @returns {changed, status, taskId}
   */
  function finalize(runId, status, source, exitCode = null, evidence = null, { deferAfterCommit = false, releaseBudget = false } = {}) {
    if (!TERMINAL.has(status)) throw new Error('finalize 只接受终态');
    const run = row('SELECT task_id,status FROM runs WHERE id=?', runId);
    if (!run) return { changed: false, status: null, taskId: null };
    if (TERMINAL.has(run.status)) return { changed: false, status: run.status, taskId: run.task_id };
    // 已请求停止的运行不能落成成功：迟到的 turn/completed 只能是停止证据不足的 unknown 或 cancelled。
    if (run.status === 'stopping' && status === 'completed') return { changed: false, status: 'stopping', taskId: run.task_id, rejected: 'STOPPING_CANNOT_COMPLETE' };
    let committed = false;
    db.exec('SAVEPOINT finalize_run');
    try {
      const updated = db.prepare("UPDATE runs SET status=?,status_source=?,ended_at=?,finalized_at=?,stop_evidence=COALESCE(?,stop_evidence),exit_code=COALESCE(?,exit_code) WHERE id=? AND status IN ('starting','running','stopping')")
        .run(status, source, now(), now(), evidence, exitCode, runId);
      if (!updated.changes) {
        db.exec('ROLLBACK TO finalize_run'); db.exec('RELEASE finalize_run');
        return { changed: false, status: row('SELECT status FROM runs WHERE id=?', runId)?.status ?? null, taskId: run.task_id };
      }
      if (status !== 'unknown') settle(runId, null, releaseBudget || source === 'workspace' || source === 'spawn');
      db.prepare('UPDATE tasks SET status=?,updated_at=?,verification_status=? WHERE id=?')
        .run(status, now(), status === 'completed' ? 'ready' : status === 'failed' ? 'failed' : 'pending', run.task_id);
      onTaskStatus(run.task_id, runId, status, source);
      db.exec('RELEASE finalize_run');
      committed = true;
    } catch (error) {
      db.exec('ROLLBACK TO finalize_run'); db.exec('RELEASE finalize_run');
      throw error;
    }
    if (committed && status !== 'unknown' && !deferAfterCommit) afterCommit(run.task_id, runId, status);
    return { changed: true, status, taskId: run.task_id };
  }
  return { finalize, isTerminal: status => TERMINAL.has(status) };
}
