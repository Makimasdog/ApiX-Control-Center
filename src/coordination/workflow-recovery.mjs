/**
 * 工作流自动恢复 - 对失败的 DAG 任务进行自动重试与员工改派
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. 检测失败任务并判断是否满足自动恢复条件（故障策略为 repair）
 *   2. 最多重试 2 次，时间窗口 30 分钟，超限后标记为 attention（需人工介入）
 *   3. 自动选择可用的改派员工（优先选择非原员工且空闲的候选人）
 *   4. 生成带上下文的修复指令，包含原始提示词和失败上下文
 * 依赖关系：
 *   - 依赖 [→ 见 src/recovery/fault-policy.ts] 的 classifyFault 进行故障分类
 *   - 依赖 [→ 见 src/coordination/workflow.ts] 读取自动协作配置
 *   - 依赖 [→ 见 src/coordination/scheduling.ts] 进行员工候选查询与资源预留
 *   - 被协调层主循环周期性调用 tick() 驱动恢复流程
 */
import {classifyFault} from '../../dist/src/recovery/fault-policy.js';
// 普通自动协作复用现有的恢复授权与预算闸门

/**
 * createWorkflowRecovery - 创建工作流自动恢复管理器
 * @param db - 数据库连接对象
 * @param row - 查询单行记录的辅助函数
 * @param rows - 查询多行记录的辅助函数
 * @param now - 返回当前 ISO 时间戳的函数
 * @param workflow - 读取项目自动协作配置的函数 [→ 见 src/coordination/workflow.ts]
 * @param permissions - 权限管理模块 [→ 见 src/coordination/permissions.ts]
 * @param scheduling - 调度模块，提供员工候选查询与资源预留 [→ 见 src/coordination/scheduling.ts]
 * @param retry - 执行重试的异步函数（由外部注入）
 * @param record - 可选的事件记录回调
 * @param fault - 可选的故障分类函数，默认使用 classifyFault
 * @returns 包含 tick（周期驱动）和 pending（判断是否可恢复）的对象
 */
export function createWorkflowRecovery({db,row,rows,now,workflow,permissions,scheduling,retry,record=()=>{},fault=task=>classifyFault(new Error(task.result??''),{kind:'agent'})}) {
  // 恢复记录表：跟踪每个任务的重试次数、状态和原因
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_recoveries(task_id TEXT PRIMARY KEY REFERENCES tasks(id),original_prompt TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,last_run_id TEXT,state TEXT NOT NULL,reason TEXT)`);
  // busy 互斥标志：防止 tick 被并发触发（单进程内简单锁）
  let busy=false;

  /**
   * authorized - 判断任务是否有权限执行自动恢复
   * @param task - 任务对象
   * @returns 是否通过授权校验（协作会话有效 + 工作流已启用 + 权限决策为 allow）
   */
  function authorized(task) {
    // 查找与任务 plan_id 关联的活跃协调会话，并校验 revision 一致性
    const session=row(`SELECT s.* FROM coordination_sessions s JOIN coordination_plan_briefs b ON b.session_id=s.id
      WHERE b.plan_id=? AND s.plan_id=b.plan_id AND s.revision=b.revision AND s.confirmed_revision=b.revision AND s.status='running'`,task.plan_id);
    if(!session || session.project_id!==task.project_id || !workflow(task.project_id).enabled || permissions.decision(task.project_id,task.employee_id)!=='allow')return false;
    try{permissions.assertGranted(task.id,task.project_id,task.employee_id);return true;}catch{return false;}
  }

  /**
   * pending - 判断任务是否处于可自动恢复的待定状态
   * @param task - 任务对象
   * @returns 是否满足恢复条件（故障策略为 repair + 未超限 + 未进入 attention）
   */
  function pending(task) {
    // 故障分类策略不是 repair 的不可自动恢复
    if(fault(task).strategy!=='repair')return false;
    // 计划仍存在（未被取消）或未通过授权校验的不可恢复
    if(row('SELECT plan_id FROM autonomy_plans WHERE plan_id=?',task.plan_id) || !authorized(task))return false;
    const saved=row('SELECT * FROM workflow_recoveries WHERE task_id=?',task.id);
    // 未超过 2 次重试且距首次失败不到 30 分钟才允许继续
    return !saved || (saved.state!=='attention' && saved.attempts<2 && Date.now()-Date.parse(saved.started_at)<30*60000);
  }

  /**
   * tick - 周期性驱动函数，扫描所有失败任务并尝试自动恢复
   *
   * 恢复流程：
   *   1. 遍历所有 status='failed' 且不属于活跃计划的任务
   *   2. 逐一校验授权、运行状态、代码冲突、前置依赖
   *   3. 根据故障分类决定是否可修复
   *   4. 选择改派员工（优先非原员工且空闲的候选人）
   *   5. 构造修复指令并调用 retry 执行
   */
  async function tick() {
    if(busy)return;busy=true;
    try {for(const task of rows("SELECT * FROM tasks WHERE status='failed' AND plan_id NOT IN (SELECT plan_id FROM autonomy_plans) ORDER BY rowid")) {
      if(!authorized(task))continue;
      const saved=row('SELECT * FROM workflow_recoveries WHERE task_id=?',task.id);
      // 已标记为需人工介入的任务跳过
      if(saved?.state==='attention')continue;
      const run=row('SELECT * FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id);
      // 绝不重放退出状态不确定的进程，也不静默解决代码冲突
      if(run && (!run.ended_at || !['failed','completed','cancelled'].includes(run.status)))continue;
      // 存在代码冲突的任务跳过，等待人工处理
      if(row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",task.id))continue;
      // 前置依赖任务未全部 accepted 的跳过
      if(rows('SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?',task.id).some(t=>t.status!=='accepted'))continue;
      const failure=fault(task);
      // 首次发现该任务失败时，创建恢复记录
      if(!saved)db.prepare("INSERT INTO workflow_recoveries VALUES (?,?,0,?,NULL,'waiting',NULL)").run(task.id,task.prompt,now());
      const state=saved??row('SELECT * FROM workflow_recoveries WHERE task_id=?',task.id);
      // halt 辅助函数：将任务标记为 attention（需人工介入）并记录原因
      const halt=reason=>{db.prepare("UPDATE workflow_recoveries SET state='attention',reason=? WHERE task_id=?").run(reason,task.id);record(task.id,'workflow.recovery_attention',{reason});};
      // 故障策略不是 repair → 标记需人工处理
      if(failure.strategy!=='repair'){halt('故障需要处理后恢复：'+failure.category);record(task.id,'workflow.recovery_blocked',{fault:failure});continue;}
      // 超过重试上限（2 次或 30 分钟）→ 标记需人工介入
      if(state.attempts>=2 || Date.now()-Date.parse(state.started_at)>=30*60000){halt('自动恢复已达到 2 次或 30 分钟上限');continue;}
      // 恢复启动被中断 → 需要检查原运行状态
      if(state.state==='prepared'){halt('恢复启动被中断，须检查原运行后再处理');continue;}
      // 从调度模块获取满足权限、能力和额度条件的候选员工
      const candidates=scheduling.candidates(task.project_id,scheduling.taskSpec(task.id),task.employee_id).filter(c=>c.eligible && workflow(task.project_id).employeeIds.includes(c.employeeId) && permissions.decision(task.project_id,c.employeeId)==='allow');
      if(!candidates.length){halt('没有满足当前权限、能力和额度条件的修复员工');continue;}
      // 优先选择非原员工且空闲的候选人；其次选择任意空闲候选人
      const chosen=candidates.find(c=>!c.waiting && c.employeeId!==task.employee_id)??candidates.find(c=>!c.waiting);
      if(!chosen)continue;
      // 构造修复指令：包含原始提示词 + 恢复上下文 + 安全约束
      const prompt=`${state.original_prompt}\n\nApiX 自动恢复（第 ${state.attempts+1}/2 次）：上次员工运行失败。检查本任务已有文件及运行记录，修复失败原因并执行相应测试，提交实际验证证据。保持原需求、模块边界、依赖和预算；保留已完成工作，不更改授权，不自行启动其他 Agent。先核对已有命令和外部操作的结果；不要重放结果不明的发布、付款、消息或外部写入，遇到此类情况报告阻塞。`;
      // 修复指令超过上下文上限（10000 字符）→ 标记需人工介入
      if(prompt.length>10000){halt('修复指令超过上下文上限');continue;}
      // 状态推进为 prepared，重试次数 +1
      db.prepare("UPDATE workflow_recoveries SET state='prepared',attempts=attempts+1,last_run_id=? WHERE task_id=?").run(run?.id??null,task.id);
      try {
        // 调用外部注入的 retry 执行实际重试
        await retry(task,chosen.employeeId,prompt);
        db.prepare("UPDATE workflow_recoveries SET state='dispatched',reason=NULL WHERE task_id=?").run(task.id);
        record(task.id,'workflow.recovery_dispatched',{attempt:state.attempts+1,employeeId:chosen.employeeId});
      }
      catch {halt('自动恢复未能安全启动，请检查任务恢复记录、权限和工作区');}
    }} finally {busy=false;}
  }
  return {tick,pending};
}
