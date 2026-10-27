/**
 * Agent 存活性检测 - 心跳探测、沉默超时与自动停止
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. 跟踪每个 Agent 运行的健康状态（healthy / suspected / stopping / unknown / ended）
 *   2. 定期探测（probe）：超过 probeMs 无活动则发送心跳探测
 *   3. 沉默超时：连续 2 次探测无回应且超过 silenceMs → 自动停止 Agent
 *   4. 运行时限：超过 maxRunMs 直接触发停止，防止 Agent 无限运行
 *   5. 所有权校验：不属于当前实例的 Agent 标记为 unknown
 * 依赖关系：
 *   - 被协调层主循环周期性调用 tick() 驱动健康检查
 *   - 依赖外部注入的 probe / stop / record / owned 函数
 *   - 依赖 runs 表获取运行状态，依赖 tasks 表获取任务状态
 *
 * 设计原则：存活性是活动的证据，不是成功工作的证明；状态不确定的工作绝不重放
 */
// 存活性是活动的证据，不是成功工作的证明；状态不确定的工作绝不重放
export function createAgentHealth({db,row,rows,now,probe,stop,record,owned,uncertain=()=>{},silenceMs=300000,probeMs=60000,maxRunMs=1800000}){
  // 参数校验：确保时限配置合理（maxRunMs >= silenceMs >= probeMs*2，probeMs >= 100ms）
  if(!Number.isSafeInteger(maxRunMs)||maxRunMs<silenceMs||!Number.isSafeInteger(silenceMs)||!Number.isSafeInteger(probeMs)||probeMs<100||silenceMs<probeMs*2)throw Error('Agent 失联检测时限无效');
  // 健康状态表：每个运行记录一条，跟踪最后活动时间和连续未回应次数
  db.exec(`CREATE TABLE IF NOT EXISTS agent_health(run_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL DEFAULT 1,task_id TEXT NOT NULL,last_activity_at TEXT NOT NULL,last_probe_at TEXT,misses INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);`);

  /**
   * observe - 记录 Agent 活动证据（心跳响应），重置未回应计数
   * @param runId - 运行记录 ID
   *
   * 仅在状态为 healthy 或 suspected 时重置；stopping/unknown/ended 状态不受影响
   */
  function observe(runId){db.prepare("UPDATE agent_health SET last_activity_at=?,last_probe_at=NULL,misses=0,state='healthy' WHERE run_id=? AND state IN ('healthy','suspected')").run(now(),runId);}

  /**
   * started - Agent 启动时注册健康记录
   * @param runId - 运行记录 ID
   * @param taskId - 关联的任务 ID
   *
   * 使用 INSERT OR IGNORE 防止重复注册（幂等）
   */
  function started(runId,taskId){db.prepare("INSERT OR IGNORE INTO agent_health(run_id,task_id,last_activity_at,state) VALUES (?,?,?,'healthy')").run(runId,taskId,now());}

  /**
   * finished - Agent 结束时标记健康记录为 ended
   * @param runId - 运行记录 ID
   */
  function finished(runId){db.prepare("UPDATE agent_health SET state='ended' WHERE run_id=?").run(runId);}

  /**
   * tick - 周期性健康检查驱动函数
   *
   * 处理流程：
   *   1. 检查 stopping 状态的 Agent：若探测超时（10 秒）则标记为 unknown
   *   2. 检查 healthy/suspected 状态的 Agent：
   *      a. 超过 maxRunMs → 直接停止（运行时限到期）
   *      b. 超过 silenceMs 且连续 2 次未回应 → 停止（沉默超时）
   *      c. 超过 probeMs 无活动 → 发送探测，标记为 suspected
   *   3. 所有权校验：不属于当前实例的 Agent 标记为 unknown
   */
  function tick(){
    // 第一阶段：处理 stopping 状态的 Agent（等待停止确认超时）
    for(const pending of rows("SELECT h.* FROM agent_health h JOIN runs r ON r.id=h.run_id WHERE h.state='stopping' AND r.status IN ('running','stopping')")){
      if(Date.parse(now())-Date.parse(pending.last_probe_at)>=10000){
        // 停止确认超时 → 标记为 unknown，效果不确定
        db.prepare("UPDATE agent_health SET state='unknown' WHERE run_id=?").run(pending.run_id);
        uncertain(pending.run_id);
        record(pending.task_id,'agent.stop_unknown',{schema:1,runId:pending.run_id,category:'unknown_effect',strategy:'review'});
      }
    }
    // 第二阶段：处理 healthy/suspected 状态的活跃 Agent
    for(const item of rows("SELECT h.*,r.started_at AS run_started_at FROM agent_health h JOIN runs r ON r.id=h.run_id JOIN tasks t ON t.id=h.task_id WHERE h.state IN ('healthy','suspected') AND r.status='running' AND t.status='running'")){
      // 计算距最后活动的时间和距运行开始的总时间
      const elapsed=Date.parse(now())-Date.parse(item.last_activity_at),deadline=Date.parse(now())-Date.parse(item.run_started_at)>=maxRunMs;
      // 未到探测时间且未超时 → 跳过
      if(!deadline&&elapsed<probeMs)continue;
      // 所有权校验：不属于当前实例的 Agent 标记为 unknown
      if(!owned(item.run_id)){db.prepare("UPDATE agent_health SET state='unknown' WHERE run_id=?").run(item.run_id);uncertain(item.run_id);record(item.task_id,'agent.liveness_unknown',{schema:1,runId:item.run_id});continue;}
      // 运行时限到期 或 沉默超时（超过 silenceMs 且连续 2 次未回应）→ 触发停止
      if(deadline||elapsed>=silenceMs&&item.misses>=2){
        // 原子更新状态为 stopping（防止重复触发）
        const changed=db.prepare("UPDATE agent_health SET state='stopping',last_probe_at=? WHERE run_id=? AND state IN ('healthy','suspected')").run(now(),item.run_id);if(!changed.changes)continue;
        record(item.task_id,'agent.unresponsive',{schema:1,runId:item.run_id,silenceMs:elapsed,missedProbes:item.misses,reason:deadline?'runtime_deadline':'silence',category:'unresponsive',strategy:'review'});
        // 先持久化停止意图，再执行停止：防止重启或重复 tick 触发多次停止/修复
        try{stop(item.run_id);}catch{db.prepare("UPDATE agent_health SET state='unknown' WHERE run_id=?").run(item.run_id);uncertain(item.run_id);record(item.task_id,'agent.stop_unknown',{schema:1,runId:item.run_id,category:'unknown_effect',strategy:'review'});}continue;
      }
      // 探测间隔未到 → 跳过
      if(item.last_probe_at&&Date.parse(now())-Date.parse(item.last_probe_at)<probeMs)continue;
      // 发送心跳探测，未回应次数 +1
      probe(item.task_id,item.run_id,item.misses+1);
      db.prepare("UPDATE agent_health SET state='suspected',last_probe_at=?,misses=misses+1 WHERE run_id=?").run(now(),item.run_id);
      record(item.task_id,'agent.probe',{schema:1,runId:item.run_id,miss: item.misses+1});
    }
  }
  return {observe,started,finished,tick,state:runId=>row('SELECT * FROM agent_health WHERE run_id=?',runId)};
}
