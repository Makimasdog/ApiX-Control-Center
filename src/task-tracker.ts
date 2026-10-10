import type { Task } from './contracts.js';

export function coordinationStatus(stored: string, tasks: Task[]): string {
  if (!['running', 'attention', 'awaiting_acceptance', 'completed'].includes(stored) || !tasks.length) return stored;
  if (tasks.some(t => ['running', 'stopping'].includes(t.status))) return 'running';
  if (tasks.some(t => ['failed', 'blocked', 'cancelled', 'unknown', 'rejected', 'needs_revision'].includes(t.status))) return 'attention';
  if (tasks.some(t => t.status === 'awaiting_approval')) return 'attention';
  if (tasks.every(t => t.status === 'accepted')) return 'completed';
  if (tasks.every(t => ['completed', 'accepted'].includes(t.status))) return 'awaiting_acceptance';
  return 'running';
}
