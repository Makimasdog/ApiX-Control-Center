import type { Store, PermissionMode, Policy } from './contracts.js';
import type { Memory } from './memory.js';

export function createPermissions(store: Store, memory: Memory) {
  const { db, row, now } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS apix_policies (
    project_id TEXT NOT NULL REFERENCES projects(id), subject TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('full_access','ask_approval','read_only')),
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,subject));
    CREATE TABLE IF NOT EXISTS apix_grants (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL, employee_id TEXT NOT NULL,
    manager_version INTEGER NOT NULL, employee_version INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);`);
  function get(projectId: string, subject = 'apix'): Policy {
    return row<Policy>('SELECT mode,version FROM apix_policies WHERE project_id=? AND subject=?', projectId, subject) ?? { mode: 'ask_approval', version: 0 };
  }
  function save(projectId: string, subject: string, mode: PermissionMode, expectedVersion: number): Policy {
    if (!['full_access', 'ask_approval', 'read_only'].includes(mode)) throw new Error('权限模式无效');
    if (!row('SELECT id FROM projects WHERE id=?', projectId)) throw new Error('项目不存在');
    if (subject !== 'apix' && !row('SELECT id FROM employees WHERE id=? AND deleted_at IS NULL', subject)) throw new Error('员工不存在');
    const old = get(projectId, subject);
    if (old.version !== expectedVersion) throw new Error('权限已更新，请刷新后重试');
    db.prepare('INSERT INTO apix_policies(project_id,subject,mode,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,subject) DO UPDATE SET mode=excluded.mode,version=excluded.version,updated_at=excluded.updated_at').run(projectId, subject, mode, old.version + 1, now());
    memory.append(projectId, projectId, 'permission.changed', { subject, previous: old, mode, version: old.version + 1 }, 'user');
    return get(projectId, subject);
  }
  function decision(projectId: string, employeeId: string): 'allow' | 'ask' | 'deny' {
    const modes = [get(projectId).mode, get(projectId, employeeId).mode];
    return modes.includes('read_only') ? 'deny' : modes.every(m => m === 'full_access') ? 'allow' : 'ask';
  }
  function grant(taskId: string, projectId: string, employeeId: string, source: 'user' | 'policy') {
    const result = decision(projectId, employeeId);
    if (result === 'deny' || (source === 'policy' && result !== 'allow')) throw new Error('当前权限不允许执行；请检查 ApiX 与员工权限');
    db.prepare('INSERT OR REPLACE INTO apix_grants(task_id,project_id,employee_id,manager_version,employee_version,source,created_at) VALUES (?,?,?,?,?,?,?)').run(taskId, projectId, employeeId, get(projectId).version, get(projectId, employeeId).version, source, now());
    memory.append(projectId, taskId, 'execution.authorized', { employeeId, source, manager: get(projectId), employee: get(projectId, employeeId) }, source === 'user' ? 'user' : 'apix');
  }
  function assertGranted(taskId: string, projectId: string, employeeId: string) {
    const g = row<{manager_version: number; employee_version: number;project_id:string;employee_id:string}>('SELECT * FROM apix_grants WHERE task_id=?', taskId);
    if (!g || g.project_id!==projectId || g.employee_id!==employeeId || g.manager_version !== get(projectId).version || g.employee_version !== get(projectId, employeeId).version || decision(projectId, employeeId) === 'deny') throw new Error('执行授权缺失或已失效，请重新审查计划');
  }
  return { get, save, decision, grant, assertGranted };
}
export type Permissions = ReturnType<typeof createPermissions>;
