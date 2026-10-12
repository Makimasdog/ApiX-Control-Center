import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type PermissionMode = 'full_access' | 'ask_approval' | 'read_only';
export type InteractionMode = 'structured' | 'conversational';
export type RequirementField = 'goal' | 'scope' | 'constraints' | 'deliverable' | 'acceptance';
export type Requirements = Record<RequirementField, string>;
export interface RequirementAssessment { score: number; threshold: number; missing: RequirementField[]; conflicts: string[]; ready: boolean }
export interface PlanStep { prompt: string; employeeId: string; dependsOn: number[]; scheduling?: import('./scheduling.js').TaskProfile }
export interface Employee { id: string; name: string; role: string; runtime: string; enabled: number; capabilityProfile?: import('./scheduling.js').CapabilityProfile }
export interface Task { id: string; project_id: string; plan_id: string | null; employee_id: string; runtime: string; prompt: string; status: string }
export interface Session {
  id: string; project_id: string; title: string; status: string; requirements_json: string;
  revision: number; confirmed_revision: number | null; plan_id: string | null;
  interaction_mode: InteractionMode;
  created_at: string; updated_at: string;
}
export interface Store {
  db: DatabaseSync;
  row<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  rows<T>(sql: string, ...params: SQLInputValue[]): T[];
  now(): string;
}
export interface ModelBackend { infer(prompt: string, onDelta?: (delta: string) => void): Promise<string> }
export interface CoordinatorDecision {
  kind: 'clarification' | 'requirement_review' | 'progress' | 'work';
  question: string; updates: Partial<Requirements>; conflicts: string[]; mode: 'pi' | 'rules'; error?: string;
}
export interface AgentCapabilities { id: string; name: string; available: boolean; managed: boolean; observable: boolean; cancellable: boolean; resumable: boolean; stateSource: string; mailbox?: boolean }
export interface DomainEvent { sequence: number; projectId: string; aggregateId: string; kind: string; actor: string; payload: unknown; createdAt: string }
export interface Policy { mode: PermissionMode; version: number }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`内容不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
