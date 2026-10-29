/**
 * Employee Insights - 多运行时 Token 用量采集与员工洞察
 *
 * 所属层级：员工适配层（src/agents/）
 * 核心功能：
 *   1. 监听不同 AI 运行时（pi/codex/claude/gemini/opencode/kimi）的输出事件，提取 Token 用量
 *   2. 将用量数据持久化到 apix_run_usage 表，支持累加（additive）和覆盖两种写入模式
 *   3. 按员工维度聚合查询：任务列表、推理运行记录、进度报告、Token 用量汇总
 * 依赖关系：
 *   - 被 src/control-plane.mjs 调用，在每次员工输出事件时调用 observe() 记录用量
 *   - 依赖 coordination/contracts.ts 的 Store 接口 [→ 见 src/coordination/contracts.ts]
 */
import type { Store } from '../coordination/contracts.js';

// Usage - 单次推理运行的 Token 用量结构
type Usage = { input: number | null; output: number | null; cached: number | null; source: string };
// cache - 合并缓存读取量和写入量，任一缺失则返回 null（表示该运行时未上报缓存数据）
function cache(read: unknown, write: unknown): number | null { const r=number(read); const w=number(write); return r===null || w===null ? null : r+w; }
// number - 安全地将未知类型转为非负整数，无效值返回 null
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null; }
// object - 安全地将未知类型转为对象，非对象返回空对象（防止后续属性访问报错）
function object(value: unknown): Record<string,unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
/**
 * createEmployeeInsights - 创建员工洞察模块，返回 observe 和 details 两个方法
 * @param store - 数据库存储实例 [→ 见 src/coordination/contracts.ts]
 * @returns { observe, details } - observe 记录用量，details 查询员工全貌
 */
export function createEmployeeInsights(store: Store) {
  const { db, row, rows } = store;
  // 初始化用量表：每个 run_id 对应一条记录，记录输入/输出/缓存 Token 及数据来源
  db.exec('CREATE TABLE IF NOT EXISTS apix_run_usage(run_id TEXT PRIMARY KEY REFERENCES runs(id),input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,source TEXT NOT NULL,updated_at TEXT NOT NULL)');
  /**
   * observe - 从员工输出事件中提取 Token 用量并写入数据库
   * @param runId - 本次推理运行的唯一标识
   * @param runtime - 运行时标识（pi/codex/claude/gemini/opencode/kimi）
   * @param item - 员工输出的一条事件记录（不同运行时格式不同）
   * 设计意图：各运行时的输出协议差异很大（事件类型名、字段路径、缓存字段命名都不同），
   *   这里用统一的 if 分支逐一适配，最终归一化为 {input, output, cached, source} 结构
   */
  function observe(runId: string, runtime: string, item: Record<string,unknown>) {
    let usage: Usage | null = null; let additive = false;
    // --- Pi 运行时：从 message_end 事件提取，usage 在 message.usage 中 ---
    if (runtime === 'pi' && item.type === 'message_end' && object(item.message).role === 'assistant') {
      const u = object(object(item.message).usage);
      const input = number(u.input) ?? number(u.inputTokens); const output = number(u.output) ?? number(u.outputTokens);
      if (input !== null || output !== null) { usage={input,output,cached:cache(u.cacheRead,u.cacheWrite),source:'pi-rpc'}; additive=true; }
    }
    // --- Codex 运行时：从 turn.completed 事件提取，用量在 usage.total_token_usage 中 ---
    if (runtime === 'codex' && item.type === 'turn.completed') {
      const u = object(item.usage); const total = object(u.total_token_usage ?? u);
      const input=number(total.input_tokens); const output=number(total.output_tokens);
      if (input !== null || output !== null) usage={input,output,cached:number(total.cached_input_tokens),source:'codex-jsonl'};
    }
    // --- Claude 运行时：从 result 事件提取，缓存分为 read 和 creation 两种 ---
    if (runtime === 'claude' && item.type === 'result') {
      const u=object(item.usage); const input=number(u.input_tokens); const output=number(u.output_tokens);
      if (input !== null || output !== null) usage={input,output,cached:cache(u.cache_read_input_tokens,u.cache_creation_input_tokens),source:'claude-stream'};
    }
    // --- Gemini 运行时：用量可能在 stats 或 usage 字段中 ---
    if (runtime === 'gemini' && item.type === 'result') {
      const u=object(item.stats ?? item.usage);
      const input=number(u.input_tokens); const output=number(u.output_tokens);
      if (input !== null || output !== null) usage={input,output,cached:number(u.cached_tokens),source:'gemini-stream'};
    }
    // --- OpenCode 运行时：从 step_finish 事件提取，用量嵌套在 part.tokens 中 ---
    if (runtime === 'opencode' && item.type === 'step_finish') {
      const tokens=object(object(item.part).tokens);
      const input=number(tokens.input); const output=number(tokens.output);
      if (input !== null || output !== null) {usage={input,output,cached:number(object(tokens.cache).read),source:'opencode-json'}; additive=true;}
    }
    // --- Kimi 运行时：从 result 事件提取，结构与 Claude 类似 ---
    if (runtime === 'kimi' && item.type === 'result') {
      const u=object(item.usage);
      const input=number(u.input_tokens); const output=number(u.output_tokens);
      if (input !== null || output !== null) usage={input,output,cached:number(u.cached_input_tokens),source:'kimi-stream'};
    }
    if (!usage) return;
    // additive 模式（Pi/OpenCode）：同一个 run 可能有多条消息，用量需要累加而非覆盖
    if (additive) db.prepare('INSERT INTO apix_run_usage VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=apix_run_usage.input_tokens+excluded.input_tokens,output_tokens=apix_run_usage.output_tokens+excluded.output_tokens,cached_tokens=apix_run_usage.cached_tokens+excluded.cached_tokens,updated_at=excluded.updated_at').run(runId,usage.input,usage.output,usage.cached,usage.source,store.now());
    // 覆盖模式（Codex/Claude/Gemini/Kimi）：一条事件就包含完整用量，直接覆盖即可
    else db.prepare('INSERT INTO apix_run_usage VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,source=excluded.source,updated_at=excluded.updated_at').run(runId,usage.input,usage.output,usage.cached,usage.source,store.now());
  }
  /**
   * details - 查询某位员工的完整洞察信息
   * @param id - 员工 ID
   * @returns 包含员工信息、任务列表、推理运行记录、进度报告和 Token 用量汇总的对象
   * 设计意图：为前端"员工详情"页面提供一站式数据聚合，一次调用返回所有需要的信息
   */
  function details(id: string) {
    const employee=row<Record<string,unknown>>('SELECT * FROM employees WHERE id=? AND deleted_at IS NULL',id);
    if (!employee) throw new Error('员工不存在');
    // 查询该员工的所有任务，关联项目名称方便前端显示
    const tasks=rows<Record<string,unknown>>('SELECT t.*,p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.employee_id=? ORDER BY t.created_at DESC',id);
    // 查询所有推理运行记录，左连接用量表以获取 Token 数据
    const runs=rows<Record<string,unknown>>('SELECT r.*,u.input_tokens,u.output_tokens,u.cached_tokens,u.source AS usage_source FROM runs r LEFT JOIN apix_run_usage u ON u.run_id=r.id JOIN tasks t ON t.id=r.task_id WHERE t.employee_id=? ORDER BY r.started_at DESC',id);
    // 从员工发出的事件消息中提取进度报告（progress_update 类型）
    const reports=rows<{id:string;task_id:string;payload:string;created_at:string}>('SELECT id,task_id,payload,created_at FROM agent_messages WHERE from_agent=? AND to_agent=\'apix-director\' AND type=\'event\' ORDER BY created_at DESC LIMIT 100',id).flatMap(message=>{ try { const payload=JSON.parse(message.payload) as Record<string,unknown>; return payload.kind==='progress_update' ? [{id:message.id,taskId:message.task_id,summary:String(payload.summary ?? ''),blocked:payload.blocked===true,createdAt:message.created_at}] : []; } catch { return []; } });
    // 汇总 Token 用量：只统计有实际用量数据的运行，measuredRuns 和 totalRuns 的差异反映数据采集覆盖率
    const known=runs.filter(r=>typeof r.input_tokens==='number' || typeof r.output_tokens==='number');
    const usage={inputTokens:known.reduce((n,r)=>n+Number(r.input_tokens ?? 0),0),outputTokens:known.reduce((n,r)=>n+Number(r.output_tokens ?? 0),0),cachedTokens:known.reduce((n,r)=>n+Number(r.cached_tokens ?? 0),0),measuredRuns:known.length,totalRuns:runs.length};
    return {employee,tasks,runs,reports,usage};
  }
  return { observe, details };
}
