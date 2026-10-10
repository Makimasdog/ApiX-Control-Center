import type { Store } from './contracts.js';

type Usage = { input: number; output: number; cached: number; source: string };
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null; }
function object(value: unknown): Record<string,unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
export function createEmployeeInsights(store: Store) {
  const { db, row, rows } = store;
  db.exec('CREATE TABLE IF NOT EXISTS apix_run_usage(run_id TEXT PRIMARY KEY REFERENCES runs(id),input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,source TEXT NOT NULL,updated_at TEXT NOT NULL)');
  function observe(runId: string, runtime: string, item: Record<string,unknown>) {
    let usage: Usage | null = null; let additive = false;
    if (runtime === 'pi' && item.type === 'message_end' && object(item.message).role === 'assistant') {
      const u = object(object(item.message).usage);
      const input = number(u.input) ?? number(u.inputTokens); const output = number(u.output) ?? number(u.outputTokens);
      if (input !== null || output !== null) { usage={input:input ?? 0,output:output ?? 0,cached:(number(u.cacheRead) ?? 0)+(number(u.cacheWrite) ?? 0),source:'pi-rpc'}; additive=true; }
    }
    if (runtime === 'codex' && item.type === 'turn.completed') {
      const u = object(item.usage); const total = object(u.total_token_usage ?? u);
      const input=number(total.input_tokens); const output=number(total.output_tokens);
      if (input !== null || output !== null) usage={input:input ?? 0,output:output ?? 0,cached:number(total.cached_input_tokens) ?? 0,source:'codex-jsonl'};
    }
    if (runtime === 'claude' && item.type === 'result') {
      const u=object(item.usage); const input=number(u.input_tokens); const output=number(u.output_tokens);
      if (input !== null || output !== null) usage={input:input ?? 0,output:output ?? 0,cached:(number(u.cache_read_input_tokens) ?? 0)+(number(u.cache_creation_input_tokens) ?? 0),source:'claude-stream'};
    }
    if (!usage) return;
    if (additive) db.prepare('INSERT INTO apix_run_usage VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=apix_run_usage.input_tokens+excluded.input_tokens,output_tokens=apix_run_usage.output_tokens+excluded.output_tokens,cached_tokens=apix_run_usage.cached_tokens+excluded.cached_tokens,updated_at=excluded.updated_at').run(runId,usage.input,usage.output,usage.cached,usage.source,store.now());
    else db.prepare('INSERT INTO apix_run_usage VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,source=excluded.source,updated_at=excluded.updated_at').run(runId,usage.input,usage.output,usage.cached,usage.source,store.now());
  }
  function details(id: string) {
    const employee=row<Record<string,unknown>>('SELECT * FROM employees WHERE id=? AND deleted_at IS NULL',id);
    if (!employee) throw new Error('员工不存在');
    const tasks=rows<Record<string,unknown>>('SELECT t.*,p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.employee_id=? ORDER BY t.created_at DESC',id);
    const runs=rows<Record<string,unknown>>('SELECT r.*,u.input_tokens,u.output_tokens,u.cached_tokens,u.source AS usage_source FROM runs r LEFT JOIN apix_run_usage u ON u.run_id=r.id JOIN tasks t ON t.id=r.task_id WHERE t.employee_id=? ORDER BY r.started_at DESC',id);
    const reports=rows<{id:string;task_id:string;payload:string;created_at:string}>('SELECT id,task_id,payload,created_at FROM agent_messages WHERE from_agent=? AND to_agent=\'apix-director\' AND type=\'event\' ORDER BY created_at DESC LIMIT 100',id).flatMap(message=>{ try { const payload=JSON.parse(message.payload) as Record<string,unknown>; return payload.kind==='progress_update' ? [{id:message.id,taskId:message.task_id,summary:String(payload.summary ?? ''),blocked:payload.blocked===true,createdAt:message.created_at}] : []; } catch { return []; } });
    const known=runs.filter(r=>typeof r.input_tokens==='number' || typeof r.output_tokens==='number');
    const usage={inputTokens:known.reduce((n,r)=>n+Number(r.input_tokens ?? 0),0),outputTokens:known.reduce((n,r)=>n+Number(r.output_tokens ?? 0),0),cachedTokens:known.reduce((n,r)=>n+Number(r.cached_tokens ?? 0),0),measuredRuns:known.length,totalRuns:runs.length};
    return {employee,tasks,runs,reports,usage};
  }
  return { observe, details };
}
