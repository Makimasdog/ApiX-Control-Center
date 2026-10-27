import {randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {unknownUsage,type ModelAttempt,type ModelUsage} from '../models/model-usage.js';
interface UsageTotals extends ModelUsage {calls:number;invocations:number;failed:number;pending:number;incomplete:number;retries:number;durationMs:number;estimatedPromptTokens:number}

export function createTokenUsage({db,row,rows,now}:Store){
  db.exec(`CREATE TABLE IF NOT EXISTS model_token_usage(
    id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,attempt INTEGER NOT NULL,project_id TEXT NOT NULL,
    session_id TEXT,task_id TEXT,purpose TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,api_type TEXT NOT NULL,
    status TEXT NOT NULL,usage_complete INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER,
    cached_input_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
    estimated_prompt_tokens INTEGER NOT NULL,duration_ms INTEGER,created_at TEXT NOT NULL,
    UNIQUE(invocation_id,attempt));
    CREATE INDEX IF NOT EXISTS model_token_usage_scope ON model_token_usage(project_id,session_id,task_id,created_at);`);
  function start(input:{invocationId:string;attempt:number;projectId:string;sessionId?:string;taskId?:string;purpose:string;provider:string;model:string;apiType:string;estimatedPromptTokens:number}){
    const id=randomUUID();db.prepare('INSERT INTO model_token_usage(id,invocation_id,attempt,project_id,session_id,task_id,purpose,provider,model,api_type,status,estimated_prompt_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,\'pending\',?,?)')
      .run(id,input.invocationId,input.attempt,input.projectId,input.sessionId??null,input.taskId??null,input.purpose,input.provider,input.model,input.apiType,input.estimatedPromptTokens,now());return id;
  }
  function finish(id:string,value:ModelAttempt){
    const u=value.usage;const result=db.prepare('UPDATE model_token_usage SET status=?,usage_complete=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,cache_write_tokens=?,reasoning_tokens=?,duration_ms=? WHERE id=? AND status=\'pending\'')
      .run(value.status,Number(value.usageComplete),u.inputTokens,u.outputTokens,u.cachedInputTokens,u.cacheWriteTokens,u.reasoningTokens,value.durationMs,id);
    if(result.changes!==1)throw new Error('Token 用量账本最终记录未确认');
  }
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
      // Untrusted provider counters must not overflow SQLite or become rounded actual totals.
      for(const key of Object.keys(unknownUsage()) as (keyof ModelUsage)[])if(r[key]!==null&&!Number.isSafeInteger(r[key]))r[key]=null;
      const coverage=Object.fromEntries(Object.keys(unknownUsage()).map(key=>{
        const column=({inputTokens:'input_tokens',outputTokens:'output_tokens',cachedInputTokens:'cached_input_tokens',cacheWriteTokens:'cache_write_tokens',reasoningTokens:'reasoning_tokens'} as Record<string,string>)[key]!;
        return [key,row<{known:number}>(`SELECT COUNT(${column}) known FROM model_token_usage WHERE project_id=? ${scope}`,projectId,...params)!.known];
      }));
      return {...r,coverage,cost:null};
    };
    const scope=taskId?'AND session_id=? AND task_id=?':'AND session_id=? AND task_id IS NULL',params=taskId?[sessionId,taskId]:[sessionId];
    const recent=rows<Record<string,unknown>>(`SELECT id,attempt,purpose,provider,model,api_type apiType,status,usage_complete usageComplete,input_tokens inputTokens,output_tokens outputTokens,cached_input_tokens cachedInputTokens,cache_write_tokens cacheWriteTokens,reasoning_tokens reasoningTokens,estimated_prompt_tokens estimatedPromptTokens,duration_ms durationMs,created_at createdAt FROM model_token_usage WHERE project_id=? ${scope} ORDER BY created_at DESC,rowid DESC LIMIT 30`,projectId,...params);
    return {schema:1,source:'provider_usage',taskId,task:aggregate(scope,params),session:aggregate('AND session_id=?',[sessionId]),project:aggregate('',[]),recent,historyLimit:30,cost:null,externalCliUsage:'unknown'};
  }
  return {start,finish,report};
}
export type TokenUsageReport=ReturnType<ReturnType<typeof createTokenUsage>['report']>;
