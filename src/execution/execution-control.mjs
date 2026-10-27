/**
 * 执行策略控制 - 管理项目/员工级别的并发限额、运行时暂停/恢复及准入检查
 *
 * 所属层级：执行层（src/execution/）
 * 核心功能：
 *   - 读取和保存项目的并发执行策略（项目级/员工级并发上限、暂停状态）
 *   - 支持按运行时（runtime）粒度暂停/恢复，记录暂停原因
 *   - 乐观并发控制：通过 version 字段防止并发修改冲突
 *   - 准入检查（admission）：在任务启动前校验是否满足所有策略条件
 * 依赖关系：
 *   - 被 [→ 见 server.mjs] 路由层调用，处理执行策略的 CRUD 和准入判断
 *   - 依赖 Store（SQLite 数据库）进行持久化，操作 execution_settings / runtime_pauses / tasks 表
 */

/**
 * createExecutionControl - 创建执行策略控制器实例
 * @param db - SQLite 数据库连接对象，提供 prepare() 方法执行 SQL
 * @param row - 查询单行记录的辅助函数
 * @param rows - 查询多行记录的辅助函数
 * @param now - 返回当前 ISO 时间戳的函数
 * @param recordEvent - 记录审计事件的回调函数，默认空操作
 * @returns 包含 get/save/pauseRuntime/setRuntime/admission 五个方法的控制对象
 */
export function createExecutionControl({db,row,rows,now,recordEvent=()=>{}}) {
  /**
   * get - 读取指定项目的当前执行策略
   * @param projectId - 项目 ID
   * @returns 策略对象，包含 projectLimit（项目并发上限）、employeeLimit（员工并发上限）、
   *   paused（是否全局暂停）、version（乐观锁版本号）、runtimePauses（各运行时暂停状态数组）
   * 设计意图：若该项目尚未设置过策略，则返回默认值（项目并发 4、员工并发 1、未暂停）
   */
  function get(projectId) {
    if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');
    const stored=row('SELECT project_limit AS projectLimit,employee_limit AS employeeLimit,paused,version FROM execution_settings WHERE project_id=?',projectId);
    // 未配置过的项目使用默认策略：项目最多 4 个并发任务，每个员工最多 1 个
    return {...(stored ?? {projectLimit:4,employeeLimit:1,paused:0,version:0}),paused:!!stored?.paused,
      runtimePauses:rows('SELECT runtime,reason,source_run_id AS sourceRunId FROM runtime_pauses WHERE project_id=? AND paused=1',projectId)};
  }

  /**
   * assertVersion - 乐观锁版本校验：确保客户端提交的修改基于最新版本
   * @param projectId - 项目 ID
   * @param input - 客户端提交的数据，必须包含 version 字段
   * @returns 当前策略对象（校验通过时）
   * 设计意图：防止"读-改-写"过程中策略被其他人修改导致丢失更新
   */
  function assertVersion(projectId,input) {
    const policy=get(projectId);
    if(!Number.isInteger(input.version) || input.version!==policy.version)throw new Error('执行设置已变化，请刷新后重试');
    return policy;
  }

  /**
   * write - 将策略对象持久化到数据库（INSERT ... ON CONFLICT 实现 upsert）
   * @param projectId - 项目 ID
   * @param policy - 策略对象
   * 设计意图：每次写入自动递增 version，配合 assertVersion 实现乐观并发控制
   */
  function write(projectId,policy) {
    db.prepare('INSERT INTO execution_settings VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET project_limit=excluded.project_limit,employee_limit=excluded.employee_limit,paused=excluded.paused,version=excluded.version,updated_at=excluded.updated_at').run(projectId,policy.projectLimit,policy.employeeLimit,policy.paused?1:0,policy.version+1,now());
  }

  /**
   * save - 保存客户端提交的策略修改
   * @param projectId - 项目 ID
   * @param input - 包含 version、projectLimit、employeeLimit、paused 的修改请求
   * @returns 保存后的最新策略对象
   * 设计意图：只更新 input 中明确提供的字段，未提供的保持原值；同时进行范围校验
   */
  function save(projectId,input) {
    const old=assertVersion(projectId,input);
    // 合并策略：input 中有值则覆盖，否则保留原值
    const policy={...old,projectLimit:input.projectLimit===undefined?old.projectLimit:input.projectLimit,employeeLimit:input.employeeLimit===undefined?old.employeeLimit:input.employeeLimit,paused:input.paused===undefined?old.paused:input.paused};
    // 范围校验：项目并发 1-8，员工并发 1-4，暂停标记必须为布尔值
    if(!Number.isInteger(policy.projectLimit) || policy.projectLimit<1 || policy.projectLimit>8 || !Number.isInteger(policy.employeeLimit) || policy.employeeLimit<1 || policy.employeeLimit>4 || typeof policy.paused!=='boolean')throw new Error('项目并发须为 1–8，员工并发须为 1–4；暂停标记须为布尔值');
    write(projectId,policy);recordEvent(projectId,'execution.settings_changed',{projectLimit:policy.projectLimit,employeeLimit:policy.employeeLimit,paused:policy.paused});
    return get(projectId);
  }

  /**
   * pauseRuntime - 暂停指定运行时（如 pi-cli、codex 等）
   * @param projectId - 项目 ID
   * @param runtime - 运行时标识符
   * @param reason - 暂停原因（截取前 1000 字符）
   * @param runId - 触发暂停的来源运行 ID（可选）
   * 设计意图：运行时暂停由系统自动触发（如检测到配额耗尽），与用户手动暂停不同
   */
  function pauseRuntime(projectId,runtime,reason,runId=null) {
    const policy=get(projectId);
    // 使用 upsert 写入运行时暂停记录，同一项目+运行时只保留最新一条
    db.prepare('INSERT INTO runtime_pauses VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,runtime) DO UPDATE SET paused=excluded.paused,reason=excluded.reason,source_run_id=excluded.source_run_id,updated_at=excluded.updated_at').run(projectId,runtime,1,reason.slice(0,1000),runId,now());
    write(projectId,policy);recordEvent(projectId,'execution.runtime_paused',{runtime,reason:reason.slice(0,1000),runId});
  }

  /**
   * setRuntime - 用户手动恢复或暂停指定运行时
   * @param projectId - 项目 ID
   * @param input - 包含 version、runtime、paused 的请求对象
   * @returns 操作后的最新策略对象
   * 设计意图：与 pauseRuntime 的区别在于需要乐观锁校验，且由用户主动发起
   */
  function setRuntime(projectId,input) {
    const policy=assertVersion(projectId,input);
    // 校验 runtime 格式：小写字母开头，仅含小写字母、数字和连字符，最长 50 字符
    if(typeof input.runtime!=='string' || !/^[a-z][a-z0-9-]{0,49}$/.test(input.runtime) || typeof input.paused!=='boolean')throw new Error('运行时和暂停标记无效');
    if(!row('SELECT runtime FROM runtime_pauses WHERE project_id=? AND runtime=?',projectId,input.runtime))throw new Error('运行时没有暂停记录');
    // 更新暂停状态，同时记录操作原因（"用户暂停" 或 "用户明确恢复"）
    db.prepare('UPDATE runtime_pauses SET paused=?,reason=?,updated_at=? WHERE project_id=? AND runtime=?').run(input.paused?1:0,input.paused?'用户暂停':'用户明确恢复',now(),projectId,input.runtime);
    write(projectId,policy);recordEvent(projectId,'execution.runtime_changed',{runtime:input.runtime,paused:input.paused});return get(projectId);
  }

  /**
   * admission - 任务准入检查：判断一个任务是否满足执行条件
   * @param task - 任务对象，需包含 project_id、id、employee_id、runtime 字段
   * @returns null 表示允许执行；非 null 字符串表示拒绝原因
   * 设计意图：按优先级依次检查全局暂停 → 运行时暂停 → 项目并发 → 员工并发，
   *   状态为 'unknown' 的任务也占用额度，防止因状态不明导致的额度泄漏
   */
  function admission(task) {
    const policy=get(task.project_id);
    // 第一关：全局暂停检查
    if(policy.paused)return '项目已暂停新任务';
    // 第二关：运行时级别暂停检查
    const paused=policy.runtimePauses.find(p=>p.runtime===task.runtime);
    if(paused)return `${task.runtime} 已暂停：${paused.reason}`;
    // 第三关：项目级并发检查（排除当前任务自身，状态 unknown 也计入占用）
    const active=rows("SELECT id,employee_id,status FROM tasks WHERE project_id=? AND id<>? AND status IN ('running','stopping','unknown')",task.project_id,task.id);
    if(active.length>=policy.projectLimit)return `项目并发已满（${policy.projectLimit}）；状态未知任务也占用额度`;
    // 第四关：员工级并发检查
    if(active.filter(t=>t.employee_id===task.employee_id).length>=policy.employeeLimit)return `员工并发已满（${policy.employeeLimit}）；请等待或检查状态未知任务`;
    return null;
  }

  return {get,save,pauseRuntime,setRuntime,admission};
}

/**
 * quotaFailure - 判断一个错误值是否属于"配额/余额不足"类型
 * @param value - 待检测的错误信息（任意类型，会被转为字符串）
 * @returns 布尔值，true 表示该错误属于配额耗尽类
 * 设计意图：通过匹配 HTTP 402/429 状态码、常见配额错误关键词（中英文），
 *   统一识别各类"额度用完"错误，供上层决定是否触发运行时自动暂停
 */
export function quotaFailure(value) {
  return String(value).trim()==='429' || /余额不足|HTTP\s*402|insufficient_quota|rate_limit_(?:exceeded|error)|quota_exceeded|resource_exhausted|quota exceeded|\b(?:HTTP|status|code)\s*[:=]?\s*429\b|\b429\s+Too Many Requests\b|额度(?:已|已经)?(?:耗尽|不足|用完)/i.test(String(value));
}
