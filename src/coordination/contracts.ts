/**
 * 类型契约层 - 定义整个协调层的核心接口与类型基础
 *
 * 所属层级：协调层 - 契约基础（第5层）
 * 核心功能：
 *   1. 定义权限模式、交互模式、需求字段等基础类型枚举
 *   2. 定义 Session / Task / Employee / PlanStep 等核心业务接口
 *   3. 定义 Store（数据库访问）和 ModelBackend（LLM 推理）抽象接口
 *   4. 提供 JSON 对象解析与校验工具函数，容忍模型输出中混入的 Markdown 包裹
 * 依赖关系：
 *   - 被所有协调层模块引用（coordinator.ts、memory.ts、permissions.ts 等）
 *   - 依赖 Node.js 内置 node:sqlite 的 DatabaseSync 类型
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** 权限三档模式：full_access=完全自主 | ask_approval=需审批 | read_only=只读 */
export type PermissionMode = 'full_access' | 'ask_approval' | 'read_only';
/** 交互模式：structured=约束表单式逐项填写 | conversational=自然对话式沟通 */
export type InteractionMode = 'structured' | 'conversational';
/** 需求的五个结构化字段，由需求澄清流程逐步收集 */
export type RequirementField = 'goal' | 'scope' | 'constraints' | 'deliverable' | 'acceptance';
/** 需求对象：五个字段各对应一段文本 */
export type Requirements = Record<RequirementField, string>;
/** 需求评估结果：分数、阈值、缺失字段、冲突列表、是否就绪 */
export interface RequirementAssessment { score: number; threshold: number; missing: RequirementField[]; conflicts: string[]; ready: boolean }
/** 计划步骤：一次员工任务分配的完整描述 */
export interface PlanStep {
  prompt: string;           // 任务指令（员工收到的具体工作内容）
  employeeId: string;       // 指定执行的员工 ID
  dependsOn: number[];      // 前置步骤的零基索引，保证 DAG 无环
  moduleId?: string;        // 所属架构模块 ID（自主交付模式下必填）
  scheduling?: import('./scheduling.js').TaskProfile; // 调度画像（能力要求、文件范围、费用估算等）
}
/** 员工（执行 Agent）注册信息 */
export interface Employee {
  id: string;          // 唯一标识
  name: string;        // 显示名称
  role: string;        // 角色描述
  runtime: string;     // 运行时类型（如 'pi'、'codex'、'claude'）
  enabled: number;     // 是否启用（1=启用, 0=停用）
  capabilityProfile?: import('./scheduling.js').CapabilityProfile; // 能力档案（可选，由调度模块管理）
}
/** 任务记录：一次员工执行的持久化状态 */
export interface Task {
  id: string;          // 任务唯一 ID
  project_id: string;  // 所属项目
  plan_id: string | null; // 所属计划（未规划时为 null）
  employee_id: string; // 执行员工
  runtime: string;     // 运行时类型
  prompt: string;      // 任务指令
  status: string;      // 状态（awaiting_approval/queued/running/completed/accepted/failed/blocked/cancelled/needs_revision/unknown/rejected）
}
/** 协调会话：一次完整的需求澄清→计划→派发→验收生命周期 */
export interface Session {
  id: string;                // 会话唯一 ID
  project_id: string;        // 所属项目
  title: string;             // 会话标题（取 goal 前 100 字符）
  status: string;            // 状态机：clarifying→ready→plan_review→running→awaiting_acceptance→completed/cancelled/attention
  requirements_json: string; // 当前需求 JSON（序列化的 Requirements 对象）
  revision: number;          // 乐观锁版本号，每次需求变更递增
  confirmed_revision: number | null; // 已确认的需求版本号（计划生成时锁定）
  plan_id: string | null;    // 关联的执行计划 ID
  interaction_mode: InteractionMode; // 交互模式（structured/conversational）
  created_at: string;        // 创建时间（ISO 8601）
  updated_at: string;        // 最后更新时间
}
/** 存储层抽象：封装 SQLite 数据库访问，提供类型安全的查询接口 */
export interface Store {
  db: DatabaseSync;                                                    // 底层 SQLite 同步数据库实例
  row<T>(sql: string, ...params: SQLInputValue[]): T | undefined;     // 查询单行
  rows<T>(sql: string, ...params: SQLInputValue[]): T[];              // 查询多行
  now(): string;                                                       // 获取当前时间戳（ISO 8601）
}
/** 管理者工具事件：记录 ApiX 调用外部工具的起止与结果 */
export interface ManagerToolEvent { toolName:string; phase:'start'|'end'; isError?:boolean }
/** LLM 推理上下文：标识本次调用的来源会话、项目和用途，用于审计与计费 */
export interface InferenceContext {
  sessionId?: string;   // 发起会话 ID
  projectId: string;    // 所属项目
  purpose: 'discussion' | 'planning' | 'formatting' | 'connection_test' | 'architecture' | 'quality' | 'assistant_loop'; // 调用目的
  onTool?: (event: ManagerToolEvent) => void; // 工具调用回调（可选，用于记录事件）
}
/** 模型后端抽象：封装 LLM 推理调用，支持流式增量输出 */
export interface ModelBackend {
  infer(prompt: string, onDelta?: (delta: string) => void, context?: InferenceContext): Promise<string>;
}
/** ApiX 编排决策：LLM 返回的结构化指令，驱动状态机推进 */
export interface CoordinatorDecision {
  kind: 'clarification' | 'requirement_review' | 'progress' | 'work'; // 决策类型
  question: string;          // 给用户的自然语言回复（最多 10000 字符）
  updates: Partial<Requirements>; // 从用户消息中提取的需求字段更新
  conflicts: string[];       // 检测到的需求冲突
  mode: 'api' | 'rules';    // 决策来源：api=LLM 生成 / rules=规则引擎降级
  error?: string;            // 降级时的错误信息
}
/** Agent 能力描述：用于 UI 展示和运行时可用性判断 */
export interface AgentCapabilities {
  id: string;            // Agent ID
  name: string;          // 显示名称
  available: boolean;    // 当前是否可用
  managed: boolean;      // 是否由 ApiX 管理
  observable: boolean;   // 是否可观测进度
  cancellable: boolean;  // 是否可取消
  resumable: boolean;    // 是否可恢复
  stateSource: string;   // 状态数据来源标识
  mailbox?: boolean;     // 是否支持消息邮箱
}
/** 领域事件：事件溯源账本中的一条记录（[→ 见 memory.ts]） */
export interface DomainEvent {
  sequence: number;      // 全局递增序号（主键）
  projectId: string;     // 所属项目
  aggregateId: string;   // 聚合根 ID（会话/任务/项目等）
  kind: string;          // 事件类型（如 'plan.created'、'permission.changed'）
  actor: string;         // 行为发起者（'user'/'apix'/员工 ID）
  payload: unknown;      // 事件负载（JSON 序列化的业务数据）
  createdAt: string;     // 事件时间戳
}
/** 权限策略：某个主体（ApiX 或员工）在某个项目中的权限模式与版本号 */
export interface Policy { mode: PermissionMode; version: number }
/**
 * object - 校验并断言值为非空 JSON 对象（排除 null、数组、基本类型）
 * @param value - 待校验的未知值
 * @returns 类型安全的 Record<string, unknown>
 * @throws 当值不是对象时抛出错误
 */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value as Record<string, unknown>;
}
/**
 * parseJsonObject - 从模型原始回复中提取单个顶层 JSON 对象
 * @param raw - 模型返回的原始字符串（可能包含 Markdown 代码块包裹或解释文字）
 * @returns 解析后的 JSON 对象
 * @throws SyntaxError 当无法提取有效 JSON 时抛出
 * 设计意图：模型常把 JSON 包在 Markdown 代码块或解释文字里；
 *   先尝试直接解析，失败后用括号匹配扫描提取顶层容器（不递归进入子对象），
 *   确保只提取一个完整对象，歧义回复要求模型纠正而非静默猜测。
 */
export function parseJsonObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) throw new SyntaxError('模型回复为空');
  const source = raw.replace(/^\uFEFF/, '').trim(); // 去除 BOM 头
  let direct: unknown;
  let complete = false;
  try { direct = JSON.parse(source); complete = true; } catch {} // 快速路径：直接解析
  if (complete) {
    try { return object(direct); } catch { throw new SyntaxError('模型回复必须是单个 JSON 对象'); }
  }
  // 慢速路径：扫描顶层容器括号匹配，提取被 Markdown 包裹的 JSON
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
      if (!stack.length) start = index; // 记录顶层容器起始位置
      stack.push(char);
    } else if ((char === '}' || char === ']') && stack.length) {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw new SyntaxError('模型回复的 JSON 括号不匹配');
      if (!stack.length) candidates.push(source.slice(start, index + 1)); // 提取一个完整顶层容器
    }
  }
  if (stack.length || candidates.length !== 1) throw new SyntaxError('模型回复必须包含单个完整 JSON 对象');
  try { return object(JSON.parse(candidates[0]!)); }
  catch { throw new SyntaxError('模型回复中没有有效的单个 JSON 对象'); }
}
/**
 * text - 校验值为非空字符串且不超过长度限制
 * @param value - 待校验的未知值
 * @param max - 最大允许字符数（默认 10000）
 * @returns 去除首尾空白后的字符串
 * @throws 当值不是字符串、为空或超长时抛出错误
 */
export function text(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`内容不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
