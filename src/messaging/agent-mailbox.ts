/**
 * Agent 邮箱 - Agent 间异步消息传递的凭据管理模块
 *
 * 所属层级：消息层（src/messaging/）
 * 核心功能：
 *   1. issue() 为 Agent 运行实例颁发一次性 Token 凭据
 *   2. authenticate() 验证请求头中的 Bearer Token，确认 Agent 身份和运行状态
 *   3. Token 以 SHA-256 哈希存储，原始值仅颁发时返回一次
 * 依赖关系：
 *   - 依赖 coordination/contracts.ts 的 Store 接口
 *   - 被 src/messaging/mailbox.mjs 的上层服务调用以验证 Agent 身份
 *   - 与 runs/tasks 表关联，确保凭据仅在任务运行期间有效
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../coordination/contracts.js';

/**
 * createAgentMailbox - 创建 Agent 凭据管理服务
 * @param store - 数据库存储依赖
 * @returns { issue, authenticate } 两个操作方法
 */
export function createAgentMailbox(store: Store) {
  const { db, row, now } = store;
  // 创建 Agent Token 表，存储 Token 的 SHA-256 哈希及关联的运行/项目/Agent 信息
  db.exec('CREATE TABLE IF NOT EXISTS apix_agent_tokens(token_hash TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),project_id TEXT NOT NULL,agent_id TEXT NOT NULL,created_at TEXT NOT NULL)');

  /** hash - 计算字符串的 SHA-256 哈希 */
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');

  /**
   * issue - 为 Agent 运行实例颁发一次性 Token 凭据
   * @param runId - 运行实例 ID
   * @param projectId - 项目 ID
   * @param agentId - Agent ID
   * @returns 原始 Token 字符串（仅此处返回一次，后续只存哈希）
   */
  function issue(runId: string, projectId: string, agentId: string): string {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO apix_agent_tokens VALUES (?,?,?,?,?)').run(hash(token),runId,projectId,agentId,now());
    return token;
  }

  /**
   * authenticate - 验证请求头中的 Bearer Token
   * 检查 Token 有效性、运行状态、任务状态以及 Agent 身份一致性
   * @param header - HTTP Authorization 请求头
   * @returns 包含 project_id/agent_id/run_id/task_id 的 Actor 信息
   */
  function authenticate(header: string | undefined) {
    // 提取 Bearer Token，去除 'Bearer ' 前缀
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    // 多表关联查询：验证 Token 哈希、运行状态、任务状态和 Agent 身份
    const actor = token ? row<{project_id:string;agent_id:string;run_id:string;task_id:string}>('SELECT a.*,r.task_id FROM apix_agent_tokens a JOIN runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE token_hash=? AND r.status IN (\'starting\',\'running\') AND t.status=\'running\' AND t.project_id=a.project_id AND t.employee_id=a.agent_id',hash(token)) : undefined;
    if (!actor) throw new Error('Agent 凭据无效或运行已结束');
    return actor;
  }
  return { issue, authenticate };
}
