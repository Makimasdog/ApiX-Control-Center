import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type PermissionMode = 'full_access' | 'ask_approval' | 'read_only';
export type InteractionMode = 'structured' | 'conversational';
export type RequirementField = 'goal' | 'scope' | 'constraints' | 'deliverable' | 'acceptance';
export type Requirements = Record<RequirementField, string>;
export interface RequirementAssessment { score: number; threshold: number; missing: RequirementField[]; conflicts: string[]; ready: boolean }
export interface PlanStep { prompt: string; employeeId: string; dependsOn: number[]; moduleId?:string; scheduling?: import('./scheduling.js').TaskProfile }
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
export interface ManagerToolEvent { toolName:string; phase:'start'|'end'; isError?:boolean }
export interface InferenceContext { sessionId?:string; projectId:string; purpose:'discussion'|'planning'|'formatting'|'connection_test'|'architecture'|'quality'|'assistant_loop'; onTool?:(event:ManagerToolEvent)=>void }
export interface ModelBackend { infer(prompt: string, onDelta?: (delta: string) => void, context?:InferenceContext): Promise<string> }
export interface CoordinatorDecision {
  kind: 'clarification' | 'requirement_review' | 'progress' | 'work';
  question: string; updates: Partial<Requirements>; conflicts: string[]; mode: 'api' | 'rules'; error?: string;
}
export interface AgentCapabilities { id: string; name: string; available: boolean; managed: boolean; observable: boolean; cancellable: boolean; resumable: boolean; stateSource: string; mailbox?: boolean }
export interface DomainEvent { sequence: number; projectId: string; aggregateId: string; kind: string; actor: string; payload: unknown; createdAt: string }
export interface Policy { mode: PermissionMode; version: number }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value as Record<string, unknown>;
}
// 模型常把对象包在 Markdown 或解释文字里；只提取顶层对象，动作字段仍由调用方校验。
export function parseJsonObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) throw new SyntaxError('模型回复为空');
  const source = raw.replace(/^\uFEFF/, '').trim();
  let direct: unknown;
  let complete = false;
  try { direct = JSON.parse(source); complete = true; } catch {}
  if (complete) {
    try { return object(direct); } catch { throw new SyntaxError('模型回复必须是单个 JSON 对象'); }
  }
  // Scan whole containers, never their children; ambiguous replies need correction.
  const candidates: string[] = [], stack: string[] = [];
  let start = -1, inString = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && stack.length) { inString = true; continue; }
    if (char === '{' || char === '[') {
      if (!stack.length) start = index;
      stack.push(char);
    } else if ((char === '}' || char === ']') && stack.length) {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw new SyntaxError('模型回复的 JSON 括号不匹配');
      if (!stack.length) candidates.push(source.slice(start, index + 1));
    }
  }
  if (stack.length || candidates.length !== 1) throw new SyntaxError('模型回复必须包含单个完整 JSON 对象');
  try { return object(JSON.parse(candidates[0]!)); }
  catch { throw new SyntaxError('模型回复中没有有效的单个 JSON 对象'); }
}
export function text(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`内容不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
