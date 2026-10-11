import type { Task } from './contracts.js';

export function coordinationStatus(stored: string, tasks: Task[]): string {
  if (!['running', 'attention', 'awaiting_acceptance', 'completed'].includes(stored) || !tasks.length) return stored;
  if (tasks.some(t => ['failed', 'blocked', 'cancelled', 'unknown', 'rejected', 'needs_revision'].includes(t.status))) return 'attention';
  if (tasks.some(t => t.status === 'awaiting_approval')) return 'attention';
  if (tasks.some(t => ['running', 'stopping'].includes(t.status))) return 'running';
  if (tasks.every(t => t.status === 'accepted')) return 'completed';
  if (tasks.some(t => t.status === 'completed')) return 'awaiting_acceptance';
  return 'running';
}

export function progressSummary(tasks: Task[], dependencies: {task_id:string;depends_on_id:string}[]) {
  return tasks.map((task, index) => ({
    taskId: task.id, step: index + 1, employeeId: task.employee_id, status: task.status,
    waitingFor: dependencies.filter(d => d.task_id === task.id && tasks.some(t => t.id === d.depends_on_id && t.status !== 'accepted')).map(d => d.depends_on_id),
  }));
}
