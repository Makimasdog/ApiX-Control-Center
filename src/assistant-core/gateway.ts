import {createHash, randomUUID} from 'node:crypto';
import {ToolError} from '../assistant/tool-governance.js';
import {object, type Store} from '../coordination/contracts.js';
import {bad, fileCheckpoint, nextOccurrence, readEvent, readTrigger, requiredText, type GatewayTrigger} from './gateway-triggers.js';

interface RuleInput {name: string; enabled: boolean; trigger: GatewayTrigger}
interface RuleRow {
  id: string;
  project_id: string;
  revision: number;
  definition: string;
  next_at: number | null;
  last_checked_at: number | null;
  checkpoint: string | null;
  last_error: string | null;
}
interface RunRow {
  id: string;
  rule_id: string;
  rule_name: string;
  status: 'delivered' | 'failed';
  message: string;
  scheduled_at: number;
  created_at: number;
  read_at: number | null;
}

const missing = (message: string) => new ToolError('NOT_FOUND', message, 'correct_input', {}, 404);
const conflict = () => new ToolError('GATEWAY_RULE_CONFLICT', '规则已变化，请刷新后重试', 'correct_input', {}, 409);

function readDefinition(raw: Record<string, unknown>, at: number, wasEnabled = true) {
  const name = requiredText(raw.name, 120, '规则名称');
  const {enabled = wasEnabled} = raw;
  if (typeof enabled !== 'boolean') throw bad('启用状态应为布尔值');
  const trigger = readTrigger(raw.trigger);
  let occurrence: number | null;
  try {
    occurrence = nextOccurrence(trigger, at);
  } catch {
    throw bad('Cron 表达式无效或没有可运行日期');
  }
  return {definition: {name, enabled, trigger}, nextAt: enabled ? occurrence : null};
}

function view(rule: RuleRow) {
  return {id: rule.id, revision: rule.revision, nextAt: rule.next_at, lastCheckedAt: rule.last_checked_at, lastError: rule.last_error,
    ...JSON.parse(rule.definition) as RuleInput};
}

export function createAssistantGateway({db, row, rows, now}: Store, projectRoot: (projectId: string) => string) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_gateway_rules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      revision INTEGER NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)),
      next_at INTEGER, last_checked_at INTEGER, deleted_at INTEGER, checkpoint TEXT, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS assistant_gateway_due ON assistant_gateway_rules(next_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS assistant_gateway_project ON assistant_gateway_rules(project_id) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS assistant_gateway_runs (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES assistant_gateway_rules(id),
      rule_name TEXT NOT NULL, trigger_key TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
      UNIQUE(rule_id, trigger_key)
    );
    CREATE TABLE IF NOT EXISTS assistant_gateway_events (
      project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, source TEXT NOT NULL,
      event_id TEXT NOT NULL, PRIMARY KEY(project_id, kind, source, event_id)
    );
  `);
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt: number | null = null;
  let lastTickAt: number | null = null;
  let healthy = true;
  let mode: 'embedded' | 'standalone' = 'embedded';
  const clock = () => Date.parse(now());

  function assertProject(projectId: string) {
    if (!row('SELECT id FROM projects WHERE id=?', projectId)) throw missing('项目不存在');
  }

  function ruleAt(projectId: string, id: string) {
    const rule = row<RuleRow>('SELECT * FROM assistant_gateway_rules WHERE project_id=? AND id=? AND deleted_at IS NULL', projectId, id);
    if (!rule) throw missing('规则不存在');
    return rule;
  }

  function save(projectId: string, raw: unknown, id?: string) {
    assertProject(projectId);
    const input = object(raw);
    const previous = id ? ruleAt(projectId, id) : undefined;
    if (previous && previous.revision !== input.revision) throw conflict();
    const prior = previous ? JSON.parse(previous.definition) as RuleInput : undefined;
    const {definition, nextAt} = readDefinition(input, clock(), prior?.enabled);
    const preserve = prior?.enabled === definition.enabled &&
      JSON.stringify(prior?.trigger) === JSON.stringify(definition.trigger);
    const {trigger} = definition;
    let checkpoint = preserve ? previous?.checkpoint ?? null : null;
    if (trigger.kind === 'file' && (!preserve || !definition.enabled)) {
      try {
        checkpoint = fileCheckpoint(projectRoot(projectId), trigger.path);
      } catch {
        throw bad('文件触发路径必须指向项目内允许访问的文件');
      }
    }
    if (!previous) {
      const newId = randomUUID();
      db.prepare('INSERT INTO assistant_gateway_rules(id,project_id,revision,definition,next_at,checkpoint) VALUES (?,?,1,?,?,?)')
        .run(newId, projectId, JSON.stringify(definition), nextAt, checkpoint);
      return view(ruleAt(projectId, newId));
    }
    const updated = db.prepare(`
      UPDATE assistant_gateway_rules SET definition=?, next_at=?, checkpoint=?, last_error=?, revision=revision+1
      WHERE project_id=? AND id=? AND revision=? AND deleted_at IS NULL
    `).run(JSON.stringify(definition), preserve ? previous.next_at ?? nextAt : nextAt, checkpoint,
      preserve ? previous.last_error : null, projectId, previous.id, previous.revision);
    if (!updated.changes) throw conflict();
    return view(ruleAt(projectId, previous.id));
  }

  function remove(projectId: string, id: string, raw: unknown) {
    const previous = ruleAt(projectId, id);
    if (previous.revision !== object(raw).revision) throw conflict();
    const result = db.prepare(`
      UPDATE assistant_gateway_rules SET deleted_at=?,next_at=NULL,revision=revision+1
      WHERE project_id=? AND id=? AND revision=? AND deleted_at IS NULL
    `).run(clock(), projectId, id, previous.revision);
    if (!result.changes) throw conflict();
    return {deleted: true};
  }

  function projectState(projectId: string) {
    assertProject(projectId);
    const rules = rows<RuleRow>('SELECT * FROM assistant_gateway_rules WHERE project_id=? AND deleted_at IS NULL ORDER BY rowid', projectId).map(view);
    const runs = rows<RunRow>(`
      SELECT r.id,r.rule_id,r.rule_name,r.status,r.message,r.scheduled_at,r.created_at,r.read_at
      FROM assistant_gateway_runs r JOIN assistant_gateway_rules j ON j.id=r.rule_id WHERE j.project_id=?
      ORDER BY (r.read_at IS NOT NULL),r.created_at DESC,r.rowid DESC LIMIT 50
    `, projectId);
    const unread = row<{count: number}>(`
      SELECT count(*) count FROM assistant_gateway_runs r JOIN assistant_gateway_rules j ON j.id=r.rule_id
      WHERE j.project_id=? AND r.read_at IS NULL
    `, projectId)!.count;
    return {rules, runs, unread};
  }

  function markRead(projectId: string, id: string) {
    const result = db.prepare(`
      UPDATE assistant_gateway_runs SET read_at=coalesce(read_at,?) WHERE id=? AND rule_id IN
      (SELECT id FROM assistant_gateway_rules WHERE project_id=?)
    `).run(clock(), id, projectId);
    if (!result.changes) throw missing('运行记录不存在');
    return {read: true};
  }

  function pendingDigest(projectId: string, attentionOnly: boolean) {
    const pending = rows<{key: string; status: string}>(`
      SELECT 'task:'||id AS key,status FROM tasks WHERE project_id=?
        AND status IN ('awaiting_approval','queued','running','completed','needs_revision','failed','blocked','unknown')
      UNION ALL
      SELECT 'session:'||id AS key,status FROM assistant_sessions WHERE project_id=?
        AND deleted_at IS NULL AND archived_at IS NULL AND status IN ('waiting_user','attention')
      ORDER BY key
    `, projectId, projectId).filter(item => !attentionOnly || !['queued', 'running'].includes(item.status));
    const labels: Record<string, string> = {
      awaiting_approval: '待审批', queued: '待执行', running: '进行中', completed: '待验收',
      needs_revision: '待修订', failed: '失败', blocked: '已阻塞', unknown: '待核对', waiting_user: '待回复', attention: '需关注',
    };
    const counts = new Map<string, number>();
    for (const {status} of pending) counts.set(status, (counts.get(status) ?? 0) + 1);
    const parts = [...counts].map(([status, count]) => labels[status] + ' ' + count + ' 项');
    return {
      checkpoint: createHash('sha256').update(JSON.stringify(pending)).digest('hex'),
      hasPending: pending.length > 0,
      message: parts.length ? parts.join('，') + '。' : '当前没有待处理事项。',
    };
  }

  function transaction<T>(work: () => T) {
    db.exec('SAVEPOINT assistant_gateway');
    try {
      const result = work();
      db.exec('RELEASE assistant_gateway');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO assistant_gateway; RELEASE assistant_gateway');
      throw error;
    }
  }

  function recordRun(rule: RuleRow, name: string, key: string, scheduledAt: number, at: number, status: RunRow['status'], message: string) {
    db.prepare(`
      INSERT INTO assistant_gateway_runs(id,rule_id,rule_name,trigger_key,status,message,scheduled_at,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(randomUUID(), rule.id, name, key, status, message, scheduledAt, at);
  }

  function ingest(projectId: string, raw: unknown) {
    assertProject(projectId);
    const {kind, source, eventId, summary} = readEvent(raw);
    const at = clock();
    const key = 'event:' + createHash('sha256').update(JSON.stringify([kind, source, eventId])).digest('hex');
    return transaction(() => {
      const receipt = db.prepare(`
        INSERT INTO assistant_gateway_events(project_id,kind,source,event_id) VALUES (?,?,?,?)
        ON CONFLICT DO NOTHING
      `).run(projectId, kind, source, eventId);
      if (!receipt.changes) return {duplicate: true, delivered: 0};
      const matching = rows<RuleRow>(`
        SELECT * FROM assistant_gateway_rules WHERE project_id=? AND deleted_at IS NULL
          AND json_extract(definition,'$.enabled')=1 AND json_extract(definition,'$.trigger.kind')=?
          AND json_extract(definition,'$.trigger.source')=?
      `, projectId, kind, source);
      const label = kind === 'git.push' ? 'Git 推送' : '邮件到达';
      const message = [label + ' · ' + source, summary].filter(Boolean).join('\n');
      for (const rule of matching) {
        const {name} = JSON.parse(rule.definition) as RuleInput;
        recordRun(rule, name, key, at, at, 'delivered', message);
      }
      return {duplicate: false, delivered: matching.length};
    });
  }

  function evaluate(rule: RuleRow, trigger: GatewayTrigger) {
    if (trigger.kind === 'file') {
      let checkpoint: string;
      try {
        checkpoint = fileCheckpoint(projectRoot(rule.project_id), trigger.path);
      } catch {
        return {checkpoint: rule.checkpoint, error: '文件检查失败，请核对项目路径与访问权限。'};
      }
      const changed = rule.checkpoint !== null && checkpoint !== rule.checkpoint;
      const verb = checkpoint === 'missing' ? '已删除' : rule.checkpoint === 'missing' ? '已创建' : '已变化';
      return {checkpoint, message: changed ? trigger.path + ' ' + verb + '。' : undefined};
    }
    const digest = pendingDigest(rule.project_id, trigger.kind === 'heartbeat');
    const notify = trigger.kind === 'cron' || digest.hasPending && rule.checkpoint !== digest.checkpoint;
    return {checkpoint: digest.checkpoint, message: notify ? digest.message : undefined};
  }

  function runDue(rule: RuleRow, at: number) {
    const {name, trigger} = JSON.parse(rule.definition) as RuleInput;
    let nextAt: number | null = null;
    let scheduleError: string | undefined;
    try {
      // 合并停机期间错过的时点，只生成一次当前状态汇报。
      nextAt = nextOccurrence(trigger, at);
    } catch {
      scheduleError = '无法计算下次运行时间，请更新规则。';
    }
    const result = scheduleError ? {checkpoint: rule.checkpoint, error: scheduleError} : evaluate(rule, trigger);
    const message = result.error ? result.error !== rule.last_error ? result.error : undefined : result.message;
    const scheduledAt = rule.next_at!;
    transaction(() => {
      const update = db.prepare(`
        UPDATE assistant_gateway_rules SET next_at=?,last_checked_at=?,checkpoint=?,last_error=?
        WHERE id=? AND revision=? AND next_at=? AND deleted_at IS NULL
      `).run(nextAt, at, result.checkpoint, result.error ?? null, rule.id, rule.revision, scheduledAt);
      if (update.changes && message) recordRun(rule, name, 'due:' + scheduledAt, scheduledAt, at, result.error ? 'failed' : 'delivered', message);
    });
  }

  function tick() {
    const at = clock();
    const due = rows<RuleRow>(`
      SELECT * FROM assistant_gateway_rules WHERE deleted_at IS NULL AND next_at<=?
      ORDER BY next_at,id LIMIT 50
    `, at);
    let failed = false;
    for (const rule of due) {
      try { runDue(rule, at); } catch { failed = true; }
    }
    if (failed) throw new Error('有到期规则未能保存');
    lastTickAt = at;
  }

  function start(runMode: 'embedded' | 'standalone') {
    if (timer) return;
    mode = runMode;
    startedAt = clock();
    const poll = () => {
      try {
        tick();
        healthy = true;
      } catch {
        if (healthy) process.stderr.write('ApiX Gateway 调度未完成，请检查本地数据状态。\n');
        healthy = false;
      }
    };
    poll();
    timer = setInterval(poll, 1000).unref();
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
  }

  return {save, remove, projectState, markRead, ingest, start, stop,
    status: () => ({mode, running: Boolean(timer), healthy, startedAt, lastTickAt})};
}
