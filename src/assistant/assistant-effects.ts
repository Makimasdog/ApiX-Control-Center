/**
 * 副作用管理 (Effect Journal) — 记录工具执行产生的副作用，支持复用、核对和安全恢复
 *
 * 所属层级：助手层 - 副作用日志
 * 核心功能：
 *   1. begin — 开始一个副作用操作，生成 scope_key 防止重复执行
 *   2. complete — 标记操作完成，记录结果事件 ID 和输出指纹
 *   3. pending — 检查是否有未核对的副作用
 *   4. reconcile — 用户核对后标记为已审阅
 *   5. rejectPreflight — 预检失败时标记为安全失败状态
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 executeInner 调用
 *   - 使用 CommandSafetyError [→ 见 src/assistant/assistant-commands.ts] 抛出安全错误
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {CommandSafetyError} from './assistant-commands.js';
/** canonical - 将对象转为规范形式（键排序 + 递归处理），用于生成稳定的指纹 */
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
/**
 * createEffectJournal - 创建副作用日志管理器
 * @param store - 数据库存储接口
 * @returns 包含 begin/complete/pendingProject/rejectPreflight/pending/reconcile 方法的对象
 * 设计意图：通过 scope_key（会话+任务+轮次+工具+参数的哈希）实现幂等性——
 * 相同参数的重复执行会被检测为“已有结果待核对”而非重新执行。
 */
export function createEffectJournal({db,row,now}:Store){
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_effects(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL DEFAULT 1,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),scope_key TEXT NOT NULL,tool TEXT NOT NULL,state TEXT NOT NULL,input_fingerprint TEXT NOT NULL,output_fingerprint TEXT,result_event_id INTEGER REFERENCES assistant_events(id),created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS assistant_effect_scope ON assistant_effects(session_id,scope_key);CREATE UNIQUE INDEX IF NOT EXISTS assistant_effect_pending ON assistant_effects(session_id,scope_key) WHERE state='started';`);
  /**
   * begin - 开始一个副作用操作
   * @param sessionId - 会话 ID
   * @param taskId - 任务 ID（可选）
   * @param tool - 工具名称
   * @param args - 工具参数
   * @param fingerprint - 当前项目指纹
   * @param version - 工具/权限版本
   * @returns 包含 id/reused/result 的对象；reused=true 表示已有相同操作的结果可复用
   */
  function begin(sessionId:string,taskId:string|undefined,tool:string,args:unknown,fingerprint:string,version:string){
    const turn=row<{id:number}>("SELECT MAX(id) AS id FROM assistant_events WHERE session_id=? AND ((role='user' AND kind='message') OR kind='resumed')",sessionId)?.id??0;
    const scope=createHash('sha256').update(JSON.stringify([sessionId,taskId,turn,tool,version,canonical(args)])).digest('hex');
    const pending=row<{id:string}>("SELECT id FROM assistant_effects WHERE session_id=? AND scope_key=? AND state='started'",sessionId,scope);
    if(pending)throw new CommandSafetyError('同一有副作用操作的结果尚未确认；不重复执行',pending.id);
    const old=row<{id:string;body:string}>("SELECT x.id,e.body FROM assistant_effects x JOIN assistant_events e ON e.id=x.result_event_id AND e.session_id=x.session_id WHERE x.session_id=? AND x.scope_key=? AND x.state='completed' AND (x.input_fingerprint=? OR x.output_fingerprint=?) ORDER BY x.rowid DESC LIMIT 1",sessionId,scope,fingerprint,fingerprint);
    if(old)return {id:old.id,reused:true,result:JSON.parse(old.body).result};
    const id=randomUUID();db.prepare("INSERT INTO assistant_effects(id,session_id,scope_key,tool,state,input_fingerprint,created_at) VALUES (?,?,?,?,'started',?,?)").run(id,sessionId,scope,tool,fingerprint,now());return {id,reused:false,result:undefined};
  }
  /** complete - 标记副作用操作完成，关联结果事件 ID 和输出指纹 */
  function complete(id:string,eventId:number,fingerprint:string){db.prepare("UPDATE assistant_effects SET state='completed',result_event_id=?,output_fingerprint=? WHERE id=? AND state='started'").run(eventId,fingerprint,id);}
  return {begin,complete,pendingProject:(project:string)=>!!row("SELECT x.id FROM assistant_effects x JOIN assistant_sessions s ON s.id=x.session_id WHERE s.project_id=? AND x.state='started' LIMIT 1",project),rejectPreflight:(id:string)=>db.prepare("UPDATE assistant_effects SET state='failed_safe' WHERE id=? AND state='started'").run(id),pending:(id:string)=>!!row("SELECT id FROM assistant_effects WHERE session_id=? AND state='started' LIMIT 1",id),reconcile:(id:string)=>db.prepare("UPDATE assistant_effects SET state='reviewed_by_user' WHERE session_id=? AND state='started'").run(id)};
}
