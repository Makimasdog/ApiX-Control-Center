export function createExecutionControl({db,row,rows,now,recordEvent=()=>{}}) {
  function get(projectId) {
    if(!row('SELECT id FROM projects WHERE id=?',projectId))throw new Error('项目不存在');
    const stored=row('SELECT project_limit AS projectLimit,employee_limit AS employeeLimit,paused,version FROM execution_settings WHERE project_id=?',projectId);
    return {...(stored ?? {projectLimit:4,employeeLimit:1,paused:0,version:0}),paused:!!stored?.paused,
      runtimePauses:rows('SELECT runtime,reason,source_run_id AS sourceRunId FROM runtime_pauses WHERE project_id=? AND paused=1',projectId)};
  }
  function assertVersion(projectId,input) {
    const policy=get(projectId);
    if(!Number.isInteger(input.version) || input.version!==policy.version)throw new Error('执行设置已变化，请刷新后重试');
    return policy;
  }
  function write(projectId,policy) {
    db.prepare('INSERT INTO execution_settings VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET project_limit=excluded.project_limit,employee_limit=excluded.employee_limit,paused=excluded.paused,version=excluded.version,updated_at=excluded.updated_at').run(projectId,policy.projectLimit,policy.employeeLimit,policy.paused?1:0,policy.version+1,now());
  }
  function save(projectId,input) {
    const old=assertVersion(projectId,input);
    const policy={...old,projectLimit:input.projectLimit===undefined?old.projectLimit:input.projectLimit,employeeLimit:input.employeeLimit===undefined?old.employeeLimit:input.employeeLimit,paused:input.paused===undefined?old.paused:input.paused};
    if(!Number.isInteger(policy.projectLimit) || policy.projectLimit<1 || policy.projectLimit>8 || !Number.isInteger(policy.employeeLimit) || policy.employeeLimit<1 || policy.employeeLimit>4 || typeof policy.paused!=='boolean')throw new Error('项目并发须为 1–8，员工并发须为 1–4；暂停标记须为布尔值');
    write(projectId,policy);recordEvent(projectId,'execution.settings_changed',{projectLimit:policy.projectLimit,employeeLimit:policy.employeeLimit,paused:policy.paused});
    return get(projectId);
  }
  function pauseRuntime(projectId,runtime,reason,runId=null) {
    const policy=get(projectId);
    db.prepare('INSERT INTO runtime_pauses VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,runtime) DO UPDATE SET paused=excluded.paused,reason=excluded.reason,source_run_id=excluded.source_run_id,updated_at=excluded.updated_at').run(projectId,runtime,1,reason.slice(0,1000),runId,now());
    write(projectId,policy);recordEvent(projectId,'execution.runtime_paused',{runtime,reason:reason.slice(0,1000),runId});
  }
  function setRuntime(projectId,input) {
    const policy=assertVersion(projectId,input);
    if(typeof input.runtime!=='string' || !/^[a-z][a-z0-9-]{0,49}$/.test(input.runtime) || typeof input.paused!=='boolean')throw new Error('运行时和暂停标记无效');
    if(!row('SELECT runtime FROM runtime_pauses WHERE project_id=? AND runtime=?',projectId,input.runtime))throw new Error('运行时没有暂停记录');
    db.prepare('UPDATE runtime_pauses SET paused=?,reason=?,updated_at=? WHERE project_id=? AND runtime=?').run(input.paused?1:0,input.paused?'用户暂停':'用户明确恢复',now(),projectId,input.runtime);
    write(projectId,policy);recordEvent(projectId,'execution.runtime_changed',{runtime:input.runtime,paused:input.paused});return get(projectId);
  }
  function admission(task) {
    const policy=get(task.project_id);
    if(policy.paused)return '项目已暂停新任务';
    const paused=policy.runtimePauses.find(p=>p.runtime===task.runtime);
    if(paused)return `${task.runtime} 已暂停：${paused.reason}`;
    const active=rows("SELECT id,employee_id,status FROM tasks WHERE project_id=? AND id<>? AND status IN ('running','stopping','unknown')",task.project_id,task.id);
    if(active.length>=policy.projectLimit)return `项目并发已满（${policy.projectLimit}）；状态未知任务也占用额度`;
    if(active.filter(t=>t.employee_id===task.employee_id).length>=policy.employeeLimit)return `员工并发已满（${policy.employeeLimit}）；请等待或检查状态未知任务`;
    return null;
  }
  return {get,save,pauseRuntime,setRuntime,admission};
}

export function quotaFailure(value) {
  return String(value).trim()==='429' || /余额不足|HTTP\s*402|insufficient_quota|rate_limit_(?:exceeded|error)|quota_exceeded|resource_exhausted|quota exceeded|\b(?:HTTP|status|code)\s*[:=]?\s*429\b|\b429\s+Too Many Requests\b|额度(?:已|已经)?(?:耗尽|不足|用完)/i.test(String(value));
}
