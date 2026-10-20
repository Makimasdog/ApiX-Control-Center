import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../coordination/contracts.js';

export function createAgentMailbox(store: Store) {
  const { db, row, now } = store;
  db.exec('CREATE TABLE IF NOT EXISTS apix_agent_tokens(token_hash TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),project_id TEXT NOT NULL,agent_id TEXT NOT NULL,created_at TEXT NOT NULL)');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  function issue(runId: string, projectId: string, agentId: string): string {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO apix_agent_tokens VALUES (?,?,?,?,?)').run(hash(token),runId,projectId,agentId,now());
    return token;
  }
  function authenticate(header: string | undefined) {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const actor = token ? row<{project_id:string;agent_id:string;run_id:string;task_id:string}>('SELECT a.*,r.task_id FROM apix_agent_tokens a JOIN runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE token_hash=? AND r.status IN (\'starting\',\'running\') AND t.status=\'running\' AND t.project_id=a.project_id AND t.employee_id=a.agent_id',hash(token)) : undefined;
    if (!actor) throw new Error('Agent 凭据无效或运行已结束');
    return actor;
  }
  return { issue, authenticate };
}
