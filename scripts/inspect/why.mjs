#!/usr/bin/env node
/**
 * why — 单命令追溯「这一轮为什么跑、结果是什么」
 *
 * 所属层级：运维脚本（只读）
 * 核心功能：
 *   1. 以只读方式打开 apix.sqlite，把一个会话/任务/运行轮的账本事件按序号顺序串成时间线
 *   2. 支持 --json 输出结构化结果，便于二次处理与测试断言
 * 依赖关系：
 *   - 只读 apix_ledger、coordination_sessions、tasks、runs、plans
 *   - 不 import control-plane、不启动服务、不写库
 * 设计意图：账本（src/coordination/memory.ts）已经记下 plan.created / plan.dispatched /
 *   guidance.* / task.* 等事件，但此前只能开 GUI 逐页翻；本脚本把同一条链一次打全。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认数据库位置：与 control-plane.mjs 的 dataDir 约定一致 */
export function defaultDbPath() {
  return join(process.env.APIX_DATA_DIR ?? join(homedir(), '.apix-agent-os'), 'apix.sqlite');
}

function short(value, max = 80) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 把一条账本事件压成一行人话；未知类型回退到载荷键值摘要 */
export function summarize(kind, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  switch (kind) {
    case 'plan.created':
      return `计划 ${p.planId ?? '?'}，${Array.isArray(p.steps) ? p.steps.length : '?'} 个步骤（修订 r${p.revision ?? '?'}）`;
    case 'plan.dispatched':
      return `派发计划 ${p.planId ?? '?'}（来源 ${p.source ?? '?'}）`;
    case 'interaction.recorded':
      return `${p.role ?? '?'}/${p.kind ?? '?'}：${short(p.content)}`;
    case 'coordination.snapshot':
      return `快照修订 r${p.revision ?? '?'}，状态 ${p.status ?? '?'}，任务 ${Array.isArray(p.tasks) ? p.tasks.length : '?'} 个`;
    case 'guidance.sent':
      return `指导 → ${p.taskId ?? '?'}：${short(p.content)}`;
    case 'guidance.progress_requested':
    case 'guidance.progress_request':
      return `主动请求进度 → 任务 ${p.taskId ?? '?'}${p.runId ? `（运行 ${p.runId}）` : ''}`;
    case 'guidance.decided':
      return `监督决策 ${p.action ?? p.kind ?? '?'} → 任务 ${p.taskId ?? '?'}`;
    case 'guidance.skipped':
    case 'guidance.monitor_failed':
      return `监督未生效 → 任务 ${p.taskId ?? '?'}：${short(p.error ?? p.reason ?? '')}`;
    case 'permission.applied':
    case 'permission.changed':
      return `授权 ${p.subject ?? '?'} → ${p.policy ?? '?'}`;
    case 'chain.capped':
      return `消息链熔断 hop=${p.hop ?? '?'}（${p.from ?? '?'} → ${p.to ?? '?'}），根任务 ${p.rootTaskId ?? '?'}`;
    case 'autonomy.checkpoint':
      return `自治检查点（运行 ${p.runId ?? '?'}，风险 ${p.risk ?? '?'}）`;
    case 'autonomy.timeout':
      return `自治超时（运行 ${p.runId ?? '?'}）`;
    default: {
      const keys = Object.keys(p);
      if (!keys.length) return '';
      return keys.slice(0, 4).map((key) => `${key}=${short(p[key], 40)}`).join(' ');
    }
  }
}

/** 解析 --session / --task / --run 的指向，返回查询范围 */
function resolveSubject(db, { sessionId, taskId, runId }) {
  const row = (sql, ...params) => db.prepare(sql).get(...params);
  if (runId) {
    const run = row('SELECT id,task_id,status FROM runs WHERE id=?', runId);
    if (!run) throw new Error(`运行 ${runId} 不存在`);
    taskId = run.task_id;
  }
  let task = null;
  if (taskId) {
    task = row('SELECT id,project_id,plan_id,employee_id,status FROM tasks WHERE id=?', taskId);
    if (!task) throw new Error(`任务 ${taskId} 不存在`);
  }
  let session = null;
  if (sessionId) {
    session = row('SELECT id,project_id,plan_id,status FROM coordination_sessions WHERE id=?', sessionId);
    if (!session) throw new Error(`会话 ${sessionId} 不存在`);
  } else if (task?.plan_id) {
    session = row('SELECT id,project_id,plan_id,status FROM coordination_sessions WHERE plan_id=? ORDER BY rowid DESC LIMIT 1', task.plan_id);
  } else if (task) {
    session = row('SELECT id,project_id,plan_id,status FROM coordination_sessions WHERE id=(SELECT session_id FROM coordination_plan_briefs WHERE plan_id=?) LIMIT 1', task.plan_id);
  }
  const projectId = task?.project_id ?? session?.project_id ?? null;
  if (!projectId) throw new Error('无法确定项目：请提供 --session 或 --task 或 --run');
  const planId = session?.plan_id ?? task?.plan_id ?? null;
  // 指定任务/运行时只追溯该任务（会话级计划事件仍会带上）；只给会话时覆盖计划下全部任务
  const taskIds = new Set();
  if (task) taskIds.add(task.id);
  else if (planId) for (const item of db.prepare('SELECT id FROM tasks WHERE plan_id=?').all(planId)) taskIds.add(item.id);
  return { projectId, sessionId: session?.id ?? null, planId, taskId: task?.id ?? null, runId: runId ?? null, taskIds: [...taskIds], session, task };
}

/**
 * trace — 返回按序号升序的时间线
 * @param db 已打开的 DatabaseSync（只读或内存库皆可）
 * @param options {sessionId?, taskId?, runId?, limit?}
 */
export function trace(db, options = {}) {
  const subject = resolveSubject(db, options);
  const aggregates = [subject.sessionId, ...subject.taskIds].filter(Boolean);
  const limit = Math.max(1, Math.min(2000, Number(options.limit ?? 200)));
  const events = db
    .prepare(
      `SELECT sequence,aggregate_id,kind,actor,payload,created_at FROM apix_ledger
       WHERE project_id=? AND aggregate_id IN (${aggregates.map(() => '?').join(',')})
       ORDER BY sequence ASC LIMIT ?`
    )
    .all(subject.projectId, ...aggregates, limit)
    .map((item) => ({
      sequence: item.sequence,
      at: item.created_at,
      aggregateId: item.aggregate_id,
      kind: item.kind,
      actor: item.actor,
      summary: summarize(item.kind, JSON.parse(item.payload)),
      payload: JSON.parse(item.payload),
    }));
  return { subject, events };
}

/** 一行文本格式：序号、时间、类型、人话摘要、发起者 */
export function formatLine(event) {
  const at = String(event.at ?? '').replace('T', ' ').slice(5, 19);
  return `#${String(event.sequence).padEnd(5)} ${at}  ${event.kind.padEnd(24)} ${event.summary}${event.actor ? `  [${event.actor}]` : ''}`.trimEnd();
}

function frame(subject) {
  if (subject.runId) return `运行 ${subject.runId}（任务 ${subject.taskId}）`;
  if (subject.taskId) return `任务 ${subject.taskId}（会话 ${subject.sessionId ?? '无'}）`;
  return `会话 ${subject.sessionId}`;
}

function parseArgs(argv) {
  const args = { json: false, db: null };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值`);
      return value;
    };
    if (flag === '--session') args.sessionId = next();
    else if (flag === '--task') args.taskId = next();
    else if (flag === '--run') args.runId = next();
    else if (flag === '--db') args.db = next();
    else if (flag === '--limit') args.limit = next();
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

const HELP = `用法：npm run why -- --session <id> | --task <id> | --run <id> [--json] [--limit N] [--db 路径]

只读追溯一个会话/任务/运行轮的来龙去脉（账本事件按序号排序）。
默认数据库：$APIX_DATA_DIR/apix.sqlite 或 ~/.apix-agent-os/apix.sqlite。`;
const INVOKED = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      process.exit(0);
    }
    if (!args.sessionId && !args.taskId && !args.runId) throw new Error('请至少提供 --session、--task 或 --run 之一');
    const db = new DatabaseSync(args.db ?? defaultDbPath(), { readOnly: true });
    try {
      const result = trace(db, args);
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${frame(result.subject)} · 项目 ${result.subject.projectId} · 共 ${result.events.length} 条账本事件\n`);
        for (const event of result.events) console.log(formatLine(event));
        if (!result.events.length) console.log('（没有账本事件：该会话可能尚未派发，或使用旧版本数据）');
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`why: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
