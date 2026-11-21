#!/usr/bin/env node
/**
 * rebuild-projection — P2 Step 2 只读重建校验器
 *
 * 所属层级：运维脚本（只读）
 * 核心功能：
 *   1. 全量读取 apix_ledger，按「最近快照基线 + 其后增量事件」重放 {session, plan, tasks} 投影
 *   2. 与 coordination_sessions / plans / tasks 真实表逐字段 diff，输出差异率与覆盖情况
 * 依赖关系：
 *   - 只读 apix_ledger、coordination_sessions、plans、tasks、task_dependencies、coordination_plan_briefs
 *   - 不 import control-plane、不启动服务、不写库（CLI 以 readOnly 打开）
 * 设计意图（有限覆盖，如实报告）：
 *   - 快照（coordination.snapshot）是与状态写同事务落库的完整状态证据；
 *     投影 = 每个实体最近一次包含它的快照 + 其后的可重放增量事件
 *     （task.status_changed / agent.status / artifact.collected / task.launch_failed / task.result_recorded / plan.*）。
 *   - 没有快照证据的实体（旧版本历史会话、主对话 director 计划、普通对话任务）标「未覆盖」，
 *     不参与 diff，也绝不计入绿——verdict 只有全部覆盖且零差异才是 green。
 *   - 时间戳与派生/旁路字段走白名单；两表其余未比较列如实列出，不静默忽略。
 * 历史边界：
 *   - task.status_changed 等增量事件自 2026-11-21（P2）起才记录；更早的状态变化只能靠快照吸收。
 *     快照之前的旧格式事件（如 task.launch_failed 不带 status/result）不用于字段重放。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认数据库位置：与 control-plane.mjs 的 dataDir 约定一致 */
export function defaultDbPath() {
  return join(process.env.APIX_DATA_DIR ?? join(homedir(), '.apix-agent-os'), 'apix.sqlite');
}

/** 各实体参与 diff 的字段（其余列见白名单与「未比较列」） */
const COVERED = {
  session: ['project_id', 'title', 'status', 'revision', 'confirmed_revision', 'plan_id', 'interaction_mode', 'requirements_json'],
  plan: ['project_id', 'goal', 'status', 'mode'],
  task: ['project_id', 'plan_id', 'employee_id', 'runtime', 'prompt', 'status', 'result', 'verification_status'],
};
/** 白名单：时间戳、派生字段、无账本证据的旁路写入字段（设计内不比较） */
const WHITELIST = {
  session: ['id', 'created_at', 'updated_at', 'archived_at', 'deleted_at'],
  plan: ['id', 'created_at', 'updated_at', 'pack_id', 'pack_version'],
  task: ['id', 'created_at', 'updated_at',
    // queue_reason 存在设计内陈旧值（如 blocked 时不清空），不作为可重放字段
    'queue_reason', 'recovery_fingerprint', 'delivery_commit', 'delivery_fingerprint', 'input_commit',
    'workspace_path', 'conversation_id', 'repository_id', 'kind'],
};
/** 会话聚合上镜像的任务事件（recordTask 双写）与任务聚合直写事件都按此重放 */
const TASK_EVENT_KINDS = new Set(['task.status_changed', 'agent.status', 'artifact.collected', 'task.launch_failed', 'task.result_recorded']);

/** 稳定序列化：键排序后 JSON 化，用于需求等对象字段的深比较 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** 把一条任务事件应用到投影；只认 payload 里真实存在的字段，旧格式事件不臆造状态 */
function applyTaskEvent(proj, kind, p) {
  if (!p || typeof p !== 'object') return;
  if (kind === 'task.status_changed') { if (typeof p.status === 'string') proj.status = p.status; }
  else if (kind === 'agent.status') {
    if (typeof p.status === 'string') {
      proj.status = p.status;
      proj.verification_status = p.status === 'completed' ? 'ready' : p.status === 'failed' ? 'failed' : 'pending';
    }
  } else if (kind === 'artifact.collected') { if (typeof p.content === 'string') proj.result = p.content; }
  else if (kind === 'task.launch_failed') {
    if (typeof p.status === 'string') proj.status = p.status;
    if (typeof p.result === 'string') proj.result = p.result;
  } else if (kind === 'task.result_recorded') {
    // 证据是写入后读回的真实 result（可能为 null），按原值重放
    if (typeof p.result === 'string' || p.result === null) proj.result = p.result;
  }
}

/**
 * rebuildProjection - 全量重放并逐字段核对（传入的 db 应只读打开；本函数只执行 SELECT/PRAGMA）
 * @param db - node:sqlite DatabaseSync 实例
 * @param options - { projectId } 可选项目过滤
 * @returns 报告：verdict(green/yellow/red)、mismatches、uncovered、覆盖统计、白名单与未比较列
 */
export function rebuildProjection(db, options = {}) {
  // Keep ledger and live-table queries on the same SQLite read snapshot.
  db.exec('SAVEPOINT verify_projection');
  try { return compareProjection(db, options); }
  finally { db.exec('RELEASE verify_projection'); }
}

function compareProjection(db, { projectId }) {
  if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error('项目不存在');
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const filter = projectId ? ' WHERE project_id=?' : '';
  const params = projectId ? [projectId] : [];
  const events = all(`SELECT sequence,project_id,aggregate_id,kind,payload FROM apix_ledger${projectId ? ' WHERE project_id=?' : ''} ORDER BY sequence`, ...params)
    .map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  const sessions = all(`SELECT * FROM coordination_sessions${filter}`, ...params);
  const plans = all(`SELECT * FROM plans${filter}`, ...params);
  const tasks = all(`SELECT * FROM tasks${filter} ORDER BY rowid`, ...params);
  const briefs = all('SELECT plan_id,session_id FROM coordination_plan_briefs');
  const dependencies = all('SELECT task_id,depends_on_id FROM task_dependencies');

  const byAggregate = new Map();
  for (const e of events) {
    if (!byAggregate.has(e.aggregate_id)) byAggregate.set(e.aggregate_id, []);
    byAggregate.get(e.aggregate_id).push(e);
  }
  const planCreated = new Map();
  for (const e of events) if (e.kind === 'plan.created' && e.payload?.planId) planCreated.set(e.payload.planId, e);
  const sessionOfPlan = new Map(briefs.map(b => [b.plan_id, b.session_id]));
  const tasksByPlan = new Map();
  for (const t of tasks) {
    if (!t.plan_id) continue;
    if (!tasksByPlan.has(t.plan_id)) tasksByPlan.set(t.plan_id, []);
    tasksByPlan.get(t.plan_id).push(t);
  }

  const mismatches = [];
  const uncovered = [];
  const covered = { session: 0, plan: 0, task: 0 };
  let comparedFields = 0;
  const coveredTaskIds = new Set();

  const diff = (entity, id, field, projected, actual) => {
    comparedFields++;
    const equal = field === 'requirements_json'
      ? stable(projected) === stable(actual)
      : projected === actual || (projected == null && actual == null);
    if (!equal) mismatches.push({ entity, id, field, projected: projected ?? null, actual: actual ?? null });
  };

  const liveIds = { session: new Set(sessions.map(s => s.id)), plan: new Set(plans.map(p => p.id)), task: new Set(tasks.map(t => t.id)) };
  const witnessed = { session: new Set(), plan: new Set(), task: new Set() };
  for (const event of events) {
    if (event.kind === 'plan.created' && event.payload?.planId) witnessed.plan.add(event.payload.planId);
    if (event.kind !== 'coordination.snapshot') continue;
    witnessed.session.add(event.aggregate_id);
    for (const task of event.payload.tasks ?? []) witnessed.task.add(task.id);
  }
  for (const [entity, ids] of Object.entries(witnessed)) {
    for (const id of ids) if (!liveIds[entity].has(id)) diff(entity, id, 'exists', true, false);
  }

  for (const s of sessions) {
    const sessionEvents = byAggregate.get(s.id) ?? [];
    const snapshots = sessionEvents.filter(e => e.kind === 'coordination.snapshot');
    const sessionPlanIds = briefs.filter(b => b.session_id === s.id).map(b => b.plan_id);
    const sessionTasks = tasks.filter(t => sessionPlanIds.includes(t.plan_id));
    if (!snapshots.length) {
      uncovered.push({ entity: 'session', id: s.id, reason: '无 coordination.snapshot 证据（历史会话或旁路写入）' });
      for (const t of sessionTasks) uncovered.push({ entity: 'task', id: t.id, reason: '所属会话无快照证据' });
      continue;
    }
    covered.session++;
    const base = snapshots[snapshots.length - 1];
    // 会话字段基线 = 最近快照；其后的 plan.* / interaction.recorded 防御性重放
    const projSession = { ...base.payload };
    for (const e of sessionEvents) {
      if (e.sequence <= base.sequence) continue;
      const p = e.payload ?? {};
      if (e.kind === 'plan.created') { projSession.plan_id = p.planId; projSession.confirmed_revision = p.revision; projSession.status = 'plan_review'; }
      else if (e.kind === 'plan.dispatched') projSession.status = 'running';
      else if (e.kind === 'interaction.recorded' && Number.isInteger(p.revision)) projSession.revision = p.revision;
    }
    for (const field of COVERED.session) {
      if (field === 'requirements_json') diff('session', s.id, field, projSession.requirements, JSON.parse(s.requirements_json));
      else if (field in s) diff('session', s.id, field, projSession[field] ?? null, s[field]);
    }

    // 任务基线 = 最近一次包含该任务的快照（editPlan 替换后旧计划任务只存在于早期快照）
    const taskProjections = new Map();
    for (const t of sessionTasks) {
      let taskBase = null;
      for (let i = snapshots.length - 1; i >= 0; i--) {
        const found = (snapshots[i].payload.tasks ?? []).find(x => x.id === t.id);
        if (found) { taskBase = { seq: snapshots[i].sequence, state: found }; break; }
      }
      if (!taskBase) { uncovered.push({ entity: 'task', id: t.id, reason: '未出现在任何快照中（快照证据缺失）' }); continue; }
      taskProjections.set(t.id, { baseSeq: taskBase.seq, proj: { ...taskBase.state } });
    }
    // 增量重放：会话聚合镜像事件 + 各任务聚合直写事件，按全局序号排序
    const tail = [];
    for (const e of sessionEvents) {
      if (TASK_EVENT_KINDS.has(e.kind) && e.payload?.taskId) tail.push({ seq: e.sequence, taskId: e.payload.taskId, kind: e.kind, p: e.payload.payload });
    }
    for (const [taskId, entry] of taskProjections) {
      for (const e of byAggregate.get(taskId) ?? []) {
        if (e.sequence > entry.baseSeq && TASK_EVENT_KINDS.has(e.kind)) tail.push({ seq: e.sequence, taskId, kind: e.kind, p: e.payload });
      }
    }
    tail.sort((a, b) => a.seq - b.seq);
    for (const e of tail) {
      const entry = taskProjections.get(e.taskId);
      if (entry && e.seq > entry.baseSeq) applyTaskEvent(entry.proj, e.kind, e.p);
    }
    for (const t of sessionTasks) {
      const entry = taskProjections.get(t.id);
      if (!entry) continue;
      covered.task++; coveredTaskIds.add(t.id);
      for (const field of COVERED.task) if (field in t) diff('task', t.id, field, entry.proj[field] ?? null, t[field]);
    }
  }

  for (const plan of plans) {
    const created = planCreated.get(plan.id);
    const sessionId = sessionOfPlan.get(plan.id);
    if (!created || !sessionId) {
      uncovered.push({ entity: 'plan', id: plan.id, reason: '无 plan.created/会话绑定证据（主对话 director 计划或历史数据）' });
      continue;
    }
    const snapshots = (byAggregate.get(sessionId) ?? []).filter(e => e.kind === 'coordination.snapshot');
    // 计划创建时点快照：goal 与步骤→任务映射的证据来源
    const creationSnapshot = snapshots.find(e => e.sequence >= created.sequence && e.payload.plan_id === plan.id);
    covered.plan++;
    diff('plan', plan.id, 'project_id', created.project_id, plan.project_id);
    diff('plan', plan.id, 'status', 'planned', plan.status);
    diff('plan', plan.id, 'mode', 'coordinator', plan.mode);
    if (creationSnapshot) diff('plan', plan.id, 'goal', creationSnapshot.payload.requirements?.goal ?? null, plan.goal);
    else uncovered.push({ entity: 'plan', id: plan.id, reason: 'goal 未覆盖：plan.created 之后无快照证据' });
    // 依赖重建：steps[].dependsOn 索引 → 创建时点快照中的任务顺序
    const planTasks = (tasksByPlan.get(plan.id) ?? []);
    if (creationSnapshot && Array.isArray(created.payload.steps)) {
      const ordered = (creationSnapshot.payload.tasks ?? []).filter(t => t.plan_id === plan.id);
      if (ordered.length === created.payload.steps.length) {
        const expected = new Set();
        created.payload.steps.forEach((step, i) => {
          for (const dep of step.dependsOn ?? []) if (ordered[dep]) expected.add(`${ordered[i].id}|${ordered[dep].id}`);
        });
        const actual = new Set(dependencies.filter(d => planTasks.some(t => t.id === d.task_id)).map(d => `${d.task_id}|${d.depends_on_id}`));
        comparedFields++;
        if (stable([...expected].sort()) !== stable([...actual].sort())) mismatches.push({ entity: 'plan', id: plan.id, field: 'dependencies', projected: [...expected].sort(), actual: [...actual].sort() });
      } else uncovered.push({ entity: 'plan', id: plan.id, reason: 'dependencies 未覆盖：创建时点快照任务数与 steps 不一致' });
    } else uncovered.push({ entity: 'plan', id: plan.id, reason: 'dependencies 未覆盖：缺少创建时点快照或 steps 证据' });
  }

  for (const t of tasks) {
    if (coveredTaskIds.has(t.id)) continue;
    if (uncovered.some(u => u.entity === 'task' && u.id === t.id)) continue;
    uncovered.push({ entity: 'task', id: t.id, reason: t.plan_id ? '所属计划无会话绑定或会话无快照（历史/director 任务）' : '无协调会话绑定（普通对话任务或历史任务）' });
  }

  // 未比较列如实列出：既不在覆盖字段也不在白名单中的列
  const uncomparableColumns = {};
  for (const [entity, table] of [['session', 'coordination_sessions'], ['plan', 'plans'], ['task', 'tasks']]) {
    const columns = all(`PRAGMA table_info(${table})`).map(c => c.name);
    uncomparableColumns[entity] = columns.filter(c => !COVERED[entity].includes(c) && !WHITELIST[entity].includes(c));
  }

  const verdict = mismatches.length ? 'red' : uncovered.length || !comparedFields ? 'yellow' : 'green';
  return {
    verdict,
    totals: { events: events.length, sessions: sessions.length, plans: plans.length, tasks: tasks.length },
    covered, uncoveredCount: uncovered.length,
    comparedFields, mismatchCount: mismatches.length,
    diffRate: comparedFields ? mismatches.length / comparedFields : null,
    mismatches, uncovered,
    whitelist: WHITELIST, uncomparableColumns,
    replayModel: '最近快照基线 + 其后增量事件（task.status_changed/agent.status/artifact.collected/task.launch_failed/task.result_recorded/plan.*）',
    historicalBoundary: 'task.status_changed 等增量事件自 2026-11-21（P2）起记录；更早变化依赖快照吸收，无快照实体标未覆盖',
  };
}

function parseArgs(argv) {
  const args = { db: null, projectId: null, json: false, help: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} 缺少值`); return v; };
    if (flag === '--db') args.db = next();
    else if (flag === '--project') args.projectId = next();
    else if (flag === '--json') args.json = true;
    else if (flag === '--strict') args.strict = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

const HELP = `用法：node scripts/verify/rebuild-projection.mjs [--db 路径] [--project <id>] [--json] [--strict]

只读全量重放 apix_ledger，核对 session/plan/tasks 投影与真实表。
green 表示约定字段全部通过。yellow 表示没有可比较字段，或存在未覆盖实体（--strict 时退出 1）。red 表示存在差异（退出 1）。
默认数据库：$APIX_DATA_DIR/apix.sqlite 或 ~/.apix-agent-os/apix.sqlite。`;
const INVOKED = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(HELP); process.exit(0); }
    const dbPath = args.db ?? defaultDbPath();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const report = rebuildProjection(db, { projectId: args.projectId });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`账本重建核对 · ${dbPath}`);
        console.log(`事件 ${report.totals.events} 条 · 会话 ${report.totals.sessions} · 计划 ${report.totals.plans} · 任务 ${report.totals.tasks}`);
        console.log(`覆盖：会话 ${report.covered.session}/${report.totals.sessions}，计划 ${report.covered.plan}/${report.totals.plans}，任务 ${report.covered.task}/${report.totals.tasks}`);
        console.log(`比较字段 ${report.comparedFields}，差异 ${report.mismatchCount}（差异率 ${report.diffRate === null ? '不可计算' : `${(report.diffRate * 100).toFixed(2)}%`}），未覆盖实体 ${report.uncoveredCount}`);
        for (const m of report.mismatches.slice(0, 50)) console.log(`  差异 ${m.entity}/${m.id} ${m.field}: 投影=${JSON.stringify(m.projected)} 实际=${JSON.stringify(m.actual)}`);
        if (report.mismatches.length > 50) console.log(`  …其余 ${report.mismatches.length - 50} 条差异见 --json`);
        for (const u of report.uncovered.slice(0, 20)) console.log(`  未覆盖 ${u.entity}/${u.id}：${u.reason}`);
        if (report.uncovered.length > 20) console.log(`  …其余 ${report.uncovered.length - 20} 项未覆盖见 --json`);
        for (const [entity, columns] of Object.entries(report.uncomparableColumns)) if (columns.length) console.log(`  ${entity} 未比较列（白名单外，如实列出）：${columns.join(', ')}`);
        console.log(report.verdict === 'green' ? '结论：green（约定字段全部通过）'
          : report.verdict === 'yellow' ? '结论：yellow（证据不足或无可比较字段）'
          : '结论：red（投影与真实表存在差异）');
      }
      process.exitCode = report.verdict === 'red' || (args.strict && report.verdict !== 'green') ? 1 : 0;
    } finally { db.close(); }
  } catch (error) {
    console.error(`rebuild-projection: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
