/**
 * token-usage.ts - Token 用量统计：追踪每次 LLM 调用的 Token 消耗
 *
 * 所属层级：助手层 - 用量追踪
 * 核心功能：
 *   1. start —— 在 LLM 调用前创建 pending 记录（防止进程崩溃后丢失用量）
 *   2. finish —— LLM 调用完成后结算实际 Token 用量
 *   3. report —— 按项目/会话/任务维度聚合用量报告
 * 依赖关系：
 *   - 被模型调用层调用，在每次 LLM 请求前后记录用量
 *   - 依赖 [→ 见 src/models/model-usage.ts] 的 ModelAttempt / ModelUsage 类型
 *   - 依赖 [→ 见 src/coordination/contracts.ts] 的 Store 接口
 */
import {randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {unknownUsage,type ModelAttempt,type ModelUsage} from '../models/model-usage.js';
/** 用量聚合结果类型：扩展 ModelUsage 增加调用次数、失败数等统计 */
interface UsageTotals extends ModelUsage {calls:number;invocations:number;failed:number;pending:number;incomplete:number;retries:number;durationMs:number;estimatedPromptTokens:number}

/** 附加用量账本按请求尝试记账；独立于已有费用预留，不根据 token 推算或结算金额。 */
/**
 * 创建 Token 用量追踪器
 * @param store - 数据库 Store
 * @returns 包含 start / finish / report 三个方法的用量追踪器
 */
export function createTokenUsage({db,row,rows,now}:Store){
  db.exec(`CREATE TABLE IF NOT EXISTS model_token_usage(
    id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,attempt INTEGER NOT NULL,project_id TEXT NOT NULL,
    session_id TEXT,task_id TEXT,purpose TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,api_type TEXT NOT NULL,
    status TEXT NOT NULL,usage_complete INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER,
    cached_input_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
    estimated_prompt_tokens INTEGER NOT NULL,duration_ms INTEGER,created_at TEXT NOT NULL,
    UNIQUE(invocation_id,attempt));
    CREATE INDEX IF NOT EXISTS model_token_usage_scope ON model_token_usage(project_id,session_id,task_id,created_at);`);
  // 网络调用前持久化 pending；进程意外退出后保留待确认状态，不伪造成功或零消耗。
  /** start - 在 LLM 调用前创建 pending 记录，确保即使进程崩溃也有据可查 */
  function start(input:{invocationId:string;attempt:number;projectId:string;sessionId?:string;taskId?:string;purpose:string;provider:string;model:string;apiType:string;estimatedPromptTokens:number}){
    const id=randomUUID();db.prepare('INSERT INTO model_token_usage(id,invocation_id,attempt,project_id,session_id,task_id,purpose,provider,model,api_type,status,estimated_prompt_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,\'pending\',?,?)')
      .run(id,input.invocationId,input.attempt,input.projectId,input.sessionId??null,input.taskId??null,input.purpose,input.provider,input.model,input.apiType,input.estimatedPromptTokens,now());return id;
  }
  // 只允许 pending 记录结算一次，防止重复回调覆盖真实结果或掩盖保存失败。
  /** finish - LLM 调用完成后结算用量（只允许 pending 记录结算一次） */
  function finish(id:string,value:ModelAttempt){
    const u=value.usage;const result=db.prepare('UPDATE model_token_usage SET status=?,usage_complete=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,cache_write_tokens=?,reasoning_tokens=?,duration_ms=? WHERE id=? AND status=\'pending\'')
      .run(value.status,Number(value.usageComplete),u.inputTokens,u.outputTokens,u.cachedInputTokens,u.cacheWriteTokens,u.reasoningTokens,value.durationMs,id);
    if(result.changes!==1)throw new Error('Token 用量账本最终记录未确认');
  }
  /** report - 生成按项目/会话/任务维度的用量聚合报告 */
  function report(projectId:string,sessionId:string,taskId:string|null){
    const aggregate=(scope:string,params:string[])=>{
      const r=row<UsageTotals>(`SELECT COUNT(*) calls,COUNT(DISTINCT invocation_id) invocations,
        COALESCE(SUM(status='failed'),0) failed,COALESCE(SUM(status='pending'),0) pending,
        COALESCE(SUM(usage_complete=0),0) incomplete,COALESCE(SUM(attempt>1),0) retries,
        COALESCE(SUM(duration_ms),0) durationMs,
        SUM(CAST(input_tokens AS REAL)) inputTokens,SUM(CAST(output_tokens AS REAL)) outputTokens,SUM(CAST(cached_input_tokens AS REAL)) cachedInputTokens,
        SUM(CAST(cache_write_tokens AS REAL)) cacheWriteTokens,SUM(CAST(reasoning_tokens AS REAL)) reasoningTokens,
        COALESCE(SUM(estimated_prompt_tokens),0) estimatedPromptTokens
        FROM model_token_usage WHERE project_id=? ${scope}`,projectId,...params)!;
      // 先避免 SQLite 整数求和溢出，再拒绝超出安全整数范围的合计，不能把舍入值当精确用量。
      for(const key of Object.keys(unknownUsage()) as (keyof ModelUsage)[])if(r[key]!==null&&!Number.isSafeInteger(r[key]))r[key]=null;
      // 各字段分别统计观测覆盖率：已有输入计数，不代表缓存、输出或推理计数也齐全。
      const coverage=Object.fromEntries(Object.keys(unknownUsage()).map(key=>{
        const column=({inputTokens:'input_tokens',outputTokens:'output_tokens',cachedInputTokens:'cached_input_tokens',cacheWriteTokens:'cache_write_tokens',reasoningTokens:'reasoning_tokens'} as Record<string,string>)[key]!;
        return [key,row<{known:number}>(`SELECT COUNT(${column}) known FROM model_token_usage WHERE project_id=? ${scope}`,projectId,...params)!.known];
      }));
      return {...r,coverage,cost:null};
    };
    // 没有任务 ID 时只统计该会话的无任务记录，不能退化为整个项目或其他任务的数据。
    const scope=taskId?'AND session_id=? AND task_id=?':'AND session_id=? AND task_id IS NULL',params=taskId?[sessionId,taskId]:[sessionId];
    const recent=rows<Record<string,unknown>>(`SELECT id,attempt,purpose,provider,model,api_type apiType,status,usage_complete usageComplete,input_tokens inputTokens,output_tokens outputTokens,cached_input_tokens cachedInputTokens,cache_write_tokens cacheWriteTokens,reasoning_tokens reasoningTokens,estimated_prompt_tokens estimatedPromptTokens,duration_ms durationMs,created_at createdAt FROM model_token_usage WHERE project_id=? ${scope} ORDER BY created_at DESC,rowid DESC LIMIT 30`,projectId,...params);
    return {schema:1,source:'provider_usage',taskId,task:aggregate(scope,params),session:aggregate('AND session_id=?',[sessionId]),project:aggregate('',[]),recent,historyLimit:30,cost:null,externalCliUsage:'unknown'};
  }
  return {start,finish,report};
}
export type TokenUsageReport=ReturnType<ReturnType<typeof createTokenUsage>['report']>;
