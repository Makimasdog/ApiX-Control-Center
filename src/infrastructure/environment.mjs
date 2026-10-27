/**
 * 环境变量管理 (Environment) - .env 文件加载与员工环境变量安全过滤
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 加载项目根目录的 .env 文件到 process.env
 *   - 兼容旧版 .env 中的 ali_api_key 小写别名
 *   - 为子进程（员工 Agent）生成安全过滤后的环境变量，防止管理凭据泄漏
 * 依赖关系：
 *   - 被 [→ 见 server.mjs] 启动时调用 loadEnvironment 加载配置
 *   - 被 [→ 见 control-plane.mjs] 员工启动时调用 workerEnvironment 过滤环境变量
 *
 * 安全设计：
 *   workerEnvironment 实现"凭据隔离"——管理者的 API Key 绝不能传给员工子进程。
 *   过滤规则：
 *     1. 显式列入黑名单的管理密钥变量（APIX_OWNER_TOKEN、APIX_ALI_API_KEY 等）直接剔除
 *     2. 值与管理密钥相同的变量（防止通过别名泄漏）也剔除
 *     3. 如果员工运行时需要的密钥与管理密钥相同，直接抛错（WORKER_CREDENTIAL_CONFLICT）
 *     4. 只有通过上述检查的非敏感变量才会传给员工子进程
 */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/**
 * loadEnvironment - 加载项目 .env 文件到 process.env
 * @param {string} path - .env 文件路径，默认为项目根目录下的 .env
 *
 * 兼容性处理：旧版 .env 使用 ali_api_key（小写），新版使用 APIX_ALI_API_KEY（大写）。
 * 如果大写版本不存在而小写版本存在，自动复制一份，确保下游设置校验器能读到。
 */
export function loadEnvironment(path=fileURLToPath(new URL('../../.env',import.meta.url))) {
  if(existsSync(path))process.loadEnvFile(path);
  // 向后兼容：将旧版小写别名 ali_api_key 提升为新版大写名 APIX_ALI_API_KEY
  if(!process.env.APIX_ALI_API_KEY && process.env.ali_api_key)process.env.APIX_ALI_API_KEY=process.env.ali_api_key;
}

/**
 * workerEnvironment - 为子进程（员工 Agent）生成安全过滤后的环境变量
 * @param {Object} source - 源环境变量（通常是 process.env 的快照）
 * @param {string} runtime - 员工运行时类型（如 'pi'、'codex'、'claude'、'gemini'、'kimi' 等）
 * @param {string|string[]} managerKey - 管理者密钥的环境变量名，用于检测凭据冲突
 * @returns {Object} 过滤后的安全环境变量，可直接传给子进程
 * @throws {Error} 当员工密钥与管理者密钥冲突时抛出 WORKER_CREDENTIAL_CONFLICT
 *
 * 过滤逻辑：
 *   - 管理者密钥变量（keyNames）：绝对不传给员工，防止凭据泄漏
 *   - 值与管理密钥相同的变量：也剔除，防止通过别名或复制泄漏
 *   - 冲突检测：如果员工运行时需要的密钥恰好是管理者密钥，说明配置有误，直接报错
 *   - APIX_ 前缀的系统控制变量（DATA_DIR、AGENT_TOKEN 等）也剔除，由系统单独注入
 */
export function workerEnvironment(source, runtime, managerKey) {
  // 构建管理者密钥变量名集合（大写），用于后续过滤
  const keyNames=new Set(['APIX_OWNER_TOKEN','APIX_ALI_API_KEY','ALI_API_KEY',...(Array.isArray(managerKey)?managerKey:[managerKey]).map(key=>String(key??'').toUpperCase())]);
  // 收集管理者密钥的实际值，用于检测"变量名不同但值相同"的泄漏
  const managerValues=new Set(Object.entries(source).filter(([name,value])=>keyNames.has(name.toUpperCase()) && value).map(([,value])=>value));
  // 各员工运行时允许使用的 API Key 变量名映射
  const credentials={codex:['OPENAI_API_KEY','CODEX_API_KEY'],claude:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'],gemini:['GEMINI_API_KEY','GOOGLE_API_KEY'],kimi:['KIMI_API_KEY','MOONSHOT_API_KEY']};
  // pi 和 opencode 是通用运行时，共享所有已知凭据变量；其他运行时按映射表取
  const sharedCredentials=['OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','GEMINI_API_KEY','GOOGLE_API_KEY','KIMI_API_KEY','MOONSHOT_API_KEY'];
  const workerKeys=new Set(['pi','opencode'].includes(runtime)?sharedCredentials:Object.hasOwn(credentials,runtime)?credentials[runtime]:[]);
  const environment={};
  for(const [name,value] of Object.entries(source)) {
    const upper=name.toUpperCase();
    // 判断是否为敏感变量：变量名在黑名单中，或者值与管理密钥相同
    const secret=keyNames.has(upper) || value && managerValues.has(value);
    // 敏感变量如果同时是员工需要的密钥 → 凭据冲突，必须报错
    if(secret && value && workerKeys.has(upper))throw Object.assign(new Error(`员工 ${runtime} 的 ${upper} 与管理者凭据共用；请配置不同的管理者密钥（使用 APIX_MANAGER_* 变量）与员工密钥，或移除员工共用变量并使用其独立登录后重试`),{code:'WORKER_CREDENTIAL_CONFLICT'});
    // 剔除敏感变量和 APIX_ 系统控制变量，其余透传
    if(secret || /^APIX_(?:.*_ENTRY|DATA_DIR|MANAGER_.*|AGENT_TOKEN|PROJECT_ID|AGENT_ID|TASK_ID|RUN_ID|MAILBOX_URL)$/.test(upper))continue;
    environment[name]=value;
  }
  return environment;
}
