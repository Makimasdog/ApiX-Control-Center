/**
 * 任务状态聚合 - 从任务列表计算协调状态与进度摘要
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. coordinationStatus：根据所有子任务的当前状态，聚合计算出协调层的整体状态
 *   2. progressSummary：为每个任务生成带步骤编号和等待依赖的进度摘要
 * 依赖关系：
 *   - 依赖 [→ 见 src/coordination/contracts.ts] 的 Task 类型
 *   - 被协调层主循环和前端 UI 调用以展示任务进度
 */
import type { Task } from './contracts.js';

/**
 * coordinationStatus - 根据存储的状态和任务列表计算协调层整体状态
 * @param stored - 数据库中存储的协调状态（如 running / attention / completed 等）
 * @param tasks - 当前协调会话下的所有任务列表
 * @returns 计算后的协调状态字符串
 *
 * 状态判定优先级（从高到低）：
 *   1. 任意任务处于失败/阻塞/取消等异常态 → 'attention'（需人工介入）
 *   2. 任意任务等待审批 → 'attention'
 *   3. 任意任务正在运行或停止中 → 'running'
 *   4. 全部任务已被验收 → 'completed'
 *   5. 有任务已完成但未验收 → 'awaiting_acceptance'
 *   6. 有任务排队中 → 'queued'
 *   7. 兜底 → 'attention'
 */
export function coordinationStatus(stored: string, tasks: Task[]): string {
  // 存储状态不在有效集合中或任务列表为空时，直接返回存储状态
  if (!['running', 'attention', 'awaiting_acceptance', 'completed'].includes(stored) || !tasks.length) return stored;
  // 存在异常态任务 → 需要人工介入
  if (tasks.some(t => ['failed', 'blocked', 'cancelled', 'unknown', 'rejected', 'needs_revision'].includes(t.status))) return 'attention';
  // 存在等待审批的任务 → 需要人工介入
  if (tasks.some(t => t.status === 'awaiting_approval')) return 'attention';
  // 存在正在运行或停止中的任务
  if (tasks.some(t => ['running', 'stopping'].includes(t.status))) return 'running';
  // 全部任务已被验收 → 完成
  if (tasks.every(t => t.status === 'accepted')) return 'completed';
  // 有任务已完成但未全部验收 → 等待验收
  if (tasks.some(t => t.status === 'completed')) return 'awaiting_acceptance';
  // 有任务排队中 → 排队；否则兜底为 attention
  return tasks.some(t=>t.status==='queued') ? 'queued' : 'attention';
}

/**
 * progressSummary - 为任务列表生成带步骤编号和等待依赖的进度摘要
 * @param tasks - 当前协调会话下的所有任务列表
 * @param dependencies - 任务依赖关系列表（DAG 边）
 * @returns 每个任务的摘要对象数组，包含 taskId / step / employeeId / status / waitingFor
 */
export function progressSummary(tasks: Task[], dependencies: {task_id:string;depends_on_id:string}[]) {
  return tasks.map((task, index) => ({
    taskId: task.id, step: index + 1, employeeId: task.employee_id, status: task.status,
    // 计算当前任务正在等待哪些前置依赖（仅列出尚未 accepted 的依赖）
    waitingFor: dependencies.filter(d => d.task_id === task.id && tasks.some(t => t.id === d.depends_on_id && t.status !== 'accepted')).map(d => d.depends_on_id),
  }));
}
