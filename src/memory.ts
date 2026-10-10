import type { Store, DomainEvent } from './contracts.js';

export function createMemory(store: Store) {
  const { db, rows, now } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS apix_ledger (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL DEFAULT 1,
    project_id TEXT NOT NULL REFERENCES projects(id), aggregate_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS apix_ledger_project ON apix_ledger(project_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_aggregate ON apix_ledger(aggregate_id,sequence);`);
  function append(projectId: string, aggregateId: string, kind: string, payload: unknown, actor = 'apix'): number {
    return Number(db.prepare('INSERT INTO apix_ledger(project_id,aggregate_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)').run(projectId, aggregateId, kind, actor, JSON.stringify(payload), now()).lastInsertRowid);
  }
  function events(projectId: string, aggregateId?: string, at?: number): DomainEvent[] {
    const limit = at === undefined ? Number.MAX_SAFE_INTEGER : at;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('事件序号无效');
    return rows<{sequence: number; project_id: string; aggregate_id: string; kind: string; actor: string; payload: string; created_at: string}>(
      `SELECT * FROM apix_ledger WHERE project_id=? AND sequence<=? ${aggregateId ? 'AND aggregate_id=?' : ''} ORDER BY sequence`, ...[projectId, limit, ...(aggregateId ? [aggregateId] : [])]
    ).map(e => ({ sequence: e.sequence, projectId: e.project_id, aggregateId: e.aggregate_id, kind: e.kind, actor: e.actor, payload: JSON.parse(e.payload), createdAt: e.created_at }));
  }
  function stateAt(projectId: string, aggregateId: string, at?: number) {
    const history = events(projectId, aggregateId, at);
    const snapshot = [...history].reverse().find(e => e.kind === 'coordination.snapshot');
    return { atSequence: at ?? history.at(-1)?.sequence ?? 0, state: snapshot?.payload ?? null, events: history };
  }
  function search(projectId: string, query: string) {
    if (!query.trim()) return [];
    // Literal search; projections and full event provenance remain independent of runtime sessions.
    return events(projectId).filter(e => JSON.stringify(e.payload).toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(-50).reverse();
  }
  return { append, events, stateAt, search };
}
export type Memory = ReturnType<typeof createMemory>;
