import type { Store, DomainEvent } from './contracts.js';

export function createMemory(store: Store) {
  const { db, row, rows, now } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS apix_ledger (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL DEFAULT 1,
    project_id TEXT NOT NULL REFERENCES projects(id), aggregate_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS apix_ledger_project ON apix_ledger(project_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_aggregate ON apix_ledger(aggregate_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_project_aggregate ON apix_ledger(project_id,aggregate_id,sequence);`);
  db.function('apix_contains',{deterministic:true},(payload,query)=>String(payload).toLocaleLowerCase().includes(String(query).toLocaleLowerCase())?1:0);
  function append(projectId: string, aggregateId: string, kind: string, payload: unknown, actor = 'apix'): number {
    return Number(db.prepare('INSERT INTO apix_ledger(project_id,aggregate_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)').run(projectId, aggregateId, kind, actor, JSON.stringify(payload), now()).lastInsertRowid);
  }
  function events(projectId: string, aggregateId?: string, at?: number): DomainEvent[] {
    const limit = at === undefined ? Number.MAX_SAFE_INTEGER : at;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('事件序号无效');
    return rows<{sequence: number; project_id: string; aggregate_id: string; kind: string; actor: string; payload: string; created_at: string}>(
      `SELECT * FROM (SELECT * FROM apix_ledger WHERE project_id=? AND sequence<=? ${aggregateId ? 'AND aggregate_id=?' : ''} ORDER BY sequence DESC LIMIT 200) ORDER BY sequence`, ...[projectId, limit, ...(aggregateId ? [aggregateId] : [])]
    ).map(e => ({ sequence: e.sequence, projectId: e.project_id, aggregateId: e.aggregate_id, kind: e.kind, actor: e.actor, payload: JSON.parse(e.payload), createdAt: e.created_at }));
  }
  function stateAt(projectId: string, aggregateId: string, at?: number) {
    const history = events(projectId, aggregateId, at);
    const limit=at??Number.MAX_SAFE_INTEGER;
    const snapshot=row<{payload:string}>('SELECT payload FROM apix_ledger WHERE project_id=? AND aggregate_id=? AND sequence<=? AND kind=\'coordination.snapshot\' ORDER BY sequence DESC LIMIT 1',projectId,aggregateId,limit);
    const first=history[0]?.sequence;
    const hasMore=first!==undefined && !!row('SELECT sequence FROM apix_ledger WHERE project_id=? AND aggregate_id=? AND sequence<? LIMIT 1',projectId,aggregateId,first);
    return {atSequence:at??history.at(-1)?.sequence??0,state:snapshot?JSON.parse(snapshot.payload):null,events:history,previousAt:hasMore?first!-1:null};
  }
  function search(projectId: string, query: string) {
    if (!query.trim()) return [];
    // Filter inside SQLite and decode only the newest matches; preserve Unicode literal matching.
    return rows<{sequence:number;project_id:string;aggregate_id:string;kind:string;actor:string;payload:string;created_at:string}>('SELECT * FROM apix_ledger WHERE project_id=? AND apix_contains(payload,?) ORDER BY sequence DESC LIMIT 50',projectId,query).map(e=>({sequence:e.sequence,projectId:e.project_id,aggregateId:e.aggregate_id,kind:e.kind,actor:e.actor,payload:JSON.parse(e.payload),createdAt:e.created_at}));
  }
  return { append, events, stateAt, search };
}
export type Memory = ReturnType<typeof createMemory>;
