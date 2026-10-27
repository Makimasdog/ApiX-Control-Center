/**
 * 双层权限策略 - manager + employee 各自 mode，版本绑定授权令牌
 *
 * 所属层级：协调层 - 领域服务（第3层）
 * 核心功能：
 *   1. get() - 获取权限策略（默认 ask_approval）
 *   2. save() - 更新权限策略（乐观锁校验版本号）
 *   3. decision() - 综合判定（取 manager 和 employee 的交集，最严格优先）
 *   4. grant() - 授予执行授权（版本绑定令牌）
 *   5. assertGranted() - 校验授权是否仍然有效
 * 依赖关系：
 *   - 依赖 contracts.ts 的 Store/PermissionMode/Policy 类型
 *   - 依赖 memory.ts 的事件溯源账本
 *   - 被 coordinator.ts 和 autonomy.ts 调用
 * 设计意图：双层策略确保权限收紧自动穿透到在跑任务——
 *   即使任务已授权，策略变更也会使旧授权失效。
 */
import type { Store, PermissionMode, Policy } from './contracts.js';
import type { Memory } from './memory.js';

/**
 * createPermissions - 创建权限管理实例
 * @param store - 数据库存储层
 * @param memory - 事件溯源账本（[→ 见 memory.ts]）
 * @returns 包含 get/save/decision/grant/assertGranted 方法的权限对象
 */
export function createPermissions(store: Store, memory: Memory) {
  const { db, row, now } = store;
  // 初始化权限策略表和授权令牌表
  db.exec(`CREATE TABLE IF NOT EXISTS apix_policies (
    project_id TEXT NOT NULL REFERENCES projects(id), subject TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('full_access','ask_approval','read_only')),
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,subject));
    CREATE TABLE IF NOT EXISTS apix_grants (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL, employee_id TEXT NOT NULL,
    manager_version INTEGER NOT NULL, employee_version INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);`);

  /**
   * get - 获取权限策略
   * @param projectId - 项目 ID
   * @param subject - 主体（默认 'apix'，也可为员工 ID）
   * @returns 权限策略（未设置时默认 ask_approval）
   */
  function get(projectId: string, subject = 'apix'): Policy {
    return row<Policy>('SELECT mode,version FROM apix_policies WHERE project_id=? AND subject=?', projectId, subject) ?? { mode: 'ask_approval', version: 0 };
  }

  /**
   * save - 更新权限策略（乐观锁校验）
   * @param projectId - 项目 ID
   * @param subject - 主体（'apix' 或员工 ID）
   * @param mode - 新权限模式
   * @param expectedVersion - 客户端持有的版本号（防并发覆盖）
   * @returns 更新后的策略
   */
  function save(projectId: string, subject: string, mode: PermissionMode, expectedVersion: number): Policy {
    if (!['full_access', 'ask_approval', 'read_only'].includes(mode)) throw new Error('权限模式无效');
    if (!row('SELECT id FROM projects WHERE id=?', projectId)) throw new Error('项目不存在');
    if (subject !== 'apix' && !row('SELECT id FROM employees WHERE id=? AND deleted_at IS NULL', subject)) throw new Error('员工不存在');
    const old = get(projectId, subject);
    if (old.version !== expectedVersion) throw new Error('权限已更新，请刷新后重试'); // 乐观锁冲突
    db.prepare('INSERT INTO apix_policies(project_id,subject,mode,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,subject) DO UPDATE SET mode=excluded.mode,version=excluded.version,updated_at=excluded.updated_at').run(projectId, subject, mode, old.version + 1, now());
    // 记录权限变更事件（审计追溯）
    memory.append(projectId, projectId, 'permission.changed', { subject, previous: old, mode, version: old.version + 1 }, 'user');
    return get(projectId, subject);
  }

  /**
   * decision - 综合权限判定（取 manager 和 employee 策略的交集）
   * @param projectId - 项目 ID
   * @param employeeId - 员工 ID
   * @returns 'allow'=完全自主 | 'ask'=需审批 | 'deny'=拒绝
   * 设计意图：任一主体为 read_only 则整体 deny；
   *   两者都为 full_access 才 allow；其余情况 ask。
   */
  function decision(projectId: string, employeeId: string): 'allow' | 'ask' | 'deny' {
    const modes = [get(projectId).mode, get(projectId, employeeId).mode];
    return modes.includes('read_only') ? 'deny' : modes.every(m => m === 'full_access') ? 'allow' : 'ask';
  }

  /**
   * grant - 授予执行授权（版本绑定令牌）
   * @param taskId - 任务 ID
   * @param projectId - 项目 ID
   * @param employeeId - 员工 ID
   * @param source - 授权来源（'user'=用户批准 / 'policy'=自动策略）
   * 设计意图：记录授权时的 manager 和 employee 版本号，
   *   后续 assertGranted() 会比对版本号，实现权限收紧穿透。
   */
  function grant(taskId: string, projectId: string, employeeId: string, source: 'user' | 'policy') {
    const result = decision(projectId, employeeId);
    if (result === 'deny' || (source === 'policy' && result !== 'allow')) throw new Error('当前权限不允许执行；请检查 ApiX 与员工权限');
    db.prepare('INSERT OR REPLACE INTO apix_grants(task_id,project_id,employee_id,manager_version,employee_version,source,created_at) VALUES (?,?,?,?,?,?,?)').run(taskId, projectId, employeeId, get(projectId).version, get(projectId, employeeId).version, source, now());
    memory.append(projectId, taskId, 'execution.authorized', { employeeId, source, manager: get(projectId), employee: get(projectId, employeeId) }, source === 'user' ? 'user' : 'apix');
  }

  /**
   * assertGranted - 校验授权是否仍然有效（版本比对）
   * @param taskId - 任务 ID
   * @param projectId - 项目 ID
   * @param employeeId - 员工 ID
   * @throws 当授权缺失、版本不匹配或权限已收紧时抛出错误
   * 设计意图：每次执行前调用，确保授权令牌未被权限变更穿透。
   */
  function assertGranted(taskId: string, projectId: string, employeeId: string) {
    const g = row<{manager_version: number; employee_version: number;project_id:string;employee_id:string}>('SELECT * FROM apix_grants WHERE task_id=?', taskId);
    if (!g || g.project_id!==projectId || g.employee_id!==employeeId || g.manager_version !== get(projectId).version || g.employee_version !== get(projectId, employeeId).version || decision(projectId, employeeId) === 'deny') throw new Error('执行授权缺失或已失效，请重新审查计划');
  }
  return { get, save, decision, grant, assertGranted };
}
/** 权限管理实例类型（用于类型引用） */
export type Permissions = ReturnType<typeof createPermissions>;
