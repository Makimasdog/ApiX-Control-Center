/**
 * 事件溯源账本 - append-only 事件日志 + stateAt() 快照回放
 *
 * 所属层级：协调层 - 领域服务（第3层）
 * 核心功能：
 *   1. append() - 追加领域事件（不可变审计记录）
 *   2. events() - 查询事件历史（支持按序号截断）
 *   3. stateAt() - 快照回放（查找最近的 coordination.snapshot 事件重建状态）
 *   4. search() - 全文搜索事件负载（大小写不敏感）
 * 依赖关系：
 *   - 依赖 contracts.ts 的 Store 和 DomainEvent 类型
 *   - 被 coordinator.ts 和 permissions.ts 调用
 * 设计意图：事件溯源模式——所有状态变更都记录为不可变事件，
 *   支持审计追溯和"时光机"回放（UI timeline 功能）。
 */
import type { Store, DomainEvent } from './contracts.js';

/**
 * createMemory - 创建事件溯源账本实例
 * @param store - 数据库存储层
 * @returns 包含 append/events/stateAt/search 方法的账本对象
 */
export function createMemory(store: Store) {
  const { db, row, rows, now } = store;
  // 初始化事件账本表及索引（按项目+序号、聚合根+序号、项目+聚合根+序号）
  db.exec(`CREATE TABLE IF NOT EXISTS apix_ledger (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL DEFAULT 1,
    project_id TEXT NOT NULL REFERENCES projects(id), aggregate_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS apix_ledger_project ON apix_ledger(project_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_aggregate ON apix_ledger(aggregate_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_project_aggregate ON apix_ledger(project_id,aggregate_id,sequence);`);
  // 注册 SQLite 自定义函数：大小写不敏感的子串搜索（用于事件负载全文检索）
  db.function('apix_contains',{deterministic:true},(payload,query)=>String(payload).toLocaleLowerCase().includes(String(query).toLocaleLowerCase())?1:0);

  /**
   * append - 追加一条领域事件
   * @param projectId - 所属项目
   * @param aggregateId - 聚合根 ID（会话/任务/项目等）
   * @param kind - 事件类型（如 'plan.created'、'permission.changed'）
   * @param payload - 事件负载（会被 JSON 序列化存储）
   * @param actor - 行为发起者（默认 'apix'）
   * @returns 新事件的序号
   */
  function append(projectId: string, aggregateId: string, kind: string, payload: unknown, actor = 'apix'): number {
    return Number(db.prepare('INSERT INTO apix_ledger(project_id,aggregate_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)').run(projectId, aggregateId, kind, actor, JSON.stringify(payload), now()).lastInsertRowid);
  }

  /**
   * events - 查询事件历史
   * @param projectId - 所属项目
   * @param aggregateId - 聚合根 ID（可选，筛选特定聚合）
   * @param at - 序号上限（可选，用于时光机回放）
   * @returns 按序号升序排列的事件列表（最多 200 条）
   */
  function events(projectId: string, aggregateId?: string, at?: number): DomainEvent[] {
    const limit = at === undefined ? Number.MAX_SAFE_INTEGER : at;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('事件序号无效');
    return rows<{sequence: number; project_id: string; aggregate_id: string; kind: string; actor: string; payload: string; created_at: string}>(
      `SELECT * FROM (SELECT * FROM apix_ledger WHERE project_id=? AND sequence<=? ${aggregateId ? 'AND aggregate_id=?' : ''} ORDER BY sequence DESC LIMIT 200) ORDER BY sequence`, ...[projectId, limit, ...(aggregateId ? [aggregateId] : [])]
    ).map(e => ({ sequence: e.sequence, projectId: e.project_id, aggregateId: e.aggregate_id, kind: e.kind, actor: e.actor, payload: JSON.parse(e.payload), createdAt: e.created_at }));
  }

  /**
   * stateAt - 快照回放：查找最近的 coordination.snapshot 事件重建状态
   * @param projectId - 所属项目
   * @param aggregateId - 聚合根 ID
   * @param at - 序号上限（可选）
   * @returns 快照状态、事件列表、是否有更早的数据
   * 设计意图：快照是某个时间点的完整会话状态投影，
   *   用于 UI "时光机"功能和审计追溯。
   */
  function stateAt(projectId: string, aggregateId: string, at?: number) {
    const history = events(projectId, aggregateId, at);
    const limit=at??Number.MAX_SAFE_INTEGER;
    // 查找最近的 coordination.snapshot 事件（快照态）
    const snapshot=row<{payload:string}>('SELECT payload FROM apix_ledger WHERE project_id=? AND aggregate_id=? AND sequence<=? AND kind=\'coordination.snapshot\' ORDER BY sequence DESC LIMIT 1',projectId,aggregateId,limit);
    const first=history[0]?.sequence;
    // 检查是否有更早的事件（用于分页）
    const hasMore=first!==undefined && !!row('SELECT sequence FROM apix_ledger WHERE project_id=? AND aggregate_id=? AND sequence<? LIMIT 1',projectId,aggregateId,first);
    return {atSequence:at??history.at(-1)?.sequence??0,state:snapshot?JSON.parse(snapshot.payload):null,events:history,previousAt:hasMore?first!-1:null};
  }

  /**
   * search - 全文搜索事件负载
   * @param projectId - 所属项目
   * @param query - 搜索关键词（大小写不敏感）
   * @returns 匹配的事件列表（最多 50 条，按序号降序）
   */
  function search(projectId: string, query: string) {
    if (!query.trim()) return [];
    // 在 SQLite 内过滤并只解码最新的匹配项
    return rows<{sequence:number;project_id:string;aggregate_id:string;kind:string;actor:string;payload:string;created_at:string}>('SELECT * FROM apix_ledger WHERE project_id=? AND apix_contains(payload,?) ORDER BY sequence DESC LIMIT 50',projectId,query).map(e=>({sequence:e.sequence,projectId:e.project_id,aggregateId:e.aggregate_id,kind:e.kind,actor:e.actor,payload:JSON.parse(e.payload),createdAt:e.created_at}));
  }
  return { append, events, stateAt, search };
}
/** 账本实例类型（用于类型引用） */
export type Memory = ReturnType<typeof createMemory>;
