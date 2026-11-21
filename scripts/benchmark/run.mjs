#!/usr/bin/env node
/**
 * run.mjs — P3 性能基准（证据层，仅 Node 标准库，Win/Linux 可跑）
 *
 * 所属层级：运维脚本（基准测量）
 * 核心功能：测五件事并输出可复现 markdown（stdout，--report 可另存文件）
 *   1. 真实服务冷启动到 HTTP readiness（server.mjs 子进程；无 /ready 路由，口径 GET / 200）
 *   2. 真实服务空闲 RSS（Linux VmRSS / Windows tasklist 工作集）
 *   3. 派活延迟 p50/p99（仓库真实 createTaskScheduler + mock launch，fixture 经 taskProfile 校验）
 *   4. apix_ledger durable 写入 tps（仓库真实 createMemory.append，逐条自动提交）
 *   5. 持久 10 万条事件后的真实服务启动耗时（合成批量种子）
 * 隔离边界：
 *   - 全部数据在 os.tmpdir 的隔离目录（APIX_DATA_DIR 注入），不触碰真实数据目录
 *   - 只访问 127.0.0.1；mock launch 不启动任何外部 Agent；结束自动清理临时目录与子进程
 * 依赖关系：
 *   - scripts/benchmark/service-harness.mjs（真实服务探针）
 *   - dist/src/coordination/memory.js、dist/src/coordination/scheduling.js（需先 npm run build）
 *   - src/coordination/task-scheduler.mjs（真实调度器源码）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createMemory } from '../../dist/src/coordination/memory.js';
import { taskProfile } from '../../dist/src/coordination/scheduling.js';
import { createTaskScheduler } from '../../src/coordination/task-scheduler.mjs';
import {
  makeTempDir, removeTempDir, freePort, syntheticOwnerToken,
  startService, waitReady, stopService, sampleRssKb, environmentInfo, percentile,
} from './service-harness.mjs';

const HELP = `用法：node scripts/benchmark/run.mjs [选项]

选项：
  --report <路径>        另存 markdown 报告（stdout 始终输出）
  --cold-starts <n>      冷启动采样次数（默认 3，每次全新数据目录）
  --dispatch <n>         派活延迟采样数（默认 2000，另有 100 次预热不计入）
  --ledger-writes <n>    ledger durable 写入次数（默认 5000）
  --events <n>           启动耗时测试的持久事件数（默认 100000）
  --rss-wait-ms <n>      readiness 后等待多久再采空闲 RSS（默认 3000）
  --help                 显示本帮助

口径：服务无 /ready 路由，readiness = GET / 返回 HTTP 200（未认证时为登录页）。
隔离：临时数据目录 + 127.0.0.1 + 合成所有者令牌；不触碰真实数据，不启动外部 Agent。`;

function parseArgs(argv) {
  const args = { report: null, coldStarts: 3, dispatch: 2000, ledgerWrites: 5000, events: 100_000, rssWaitMs: 3000, help: false };
  const numbers = { '--cold-starts': 'coldStarts', '--dispatch': 'dispatch', '--ledger-writes': 'ledgerWrites', '--events': 'events', '--rss-wait-ms': 'rssWaitMs' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--report') { args.report = argv[++i]; if (!args.report) throw new Error('--report 缺少路径'); }
    else if (flag in numbers) {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} 需要正整数`);
      args[numbers[flag]] = value;
    } else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

const now = () => new Date().toISOString();
const storeOf = db => ({ db, row: (sql, ...p) => db.prepare(sql).get(...p), rows: (sql, ...p) => db.prepare(sql).all(...p), now });
const ms = value => value == null ? 'n/a' : value.toFixed(2);

/** 真实服务冷启动 + 空闲 RSS（最后一次采样保留服务用于 RSS） */
async function measureService(args, cleanup) {
  const coldStarts = [];
  let rss = { samples: [], medianKb: null };
  for (let i = 0; i < args.coldStarts; i++) {
    const dataDir = makeTempDir('apix-bench-cold-');
    cleanup.dirs.push(dataDir);
    const service = startService({ dataDir, port: await freePort(), ownerToken: syntheticOwnerToken() });
    cleanup.services.push(service);
    const elapsed = await waitReady(service);
    coldStarts.push(elapsed);
    if (i === args.coldStarts - 1) {
      await new Promise(resolve => setTimeout(resolve, args.rssWaitMs));
      for (let s = 0; s < 5; s++) {
        const kb = sampleRssKb(service.child.pid);
        if (kb != null) rss.samples.push(kb);
        if (s < 4) await new Promise(resolve => setTimeout(resolve, 400));
      }
      const sorted = [...rss.samples].sort((a, b) => a - b);
      rss.medianKb = percentile(sorted, 50);
    }
    await stopService(service);
  }
  const sorted = [...coldStarts].sort((a, b) => a - b);
  return { coldStarts, median: percentile(sorted, 50), min: sorted[0], max: sorted.at(-1), rss };
}

/** 派活延迟：真实 createTaskScheduler + 真实 createMemory 账本 + mock launch（进程内，无外部 Agent） */
function measureDispatch(count) {
  const dir = makeTempDir('apix-bench-dispatch-');
  const db = new DatabaseSync(join(dir, 'apix.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    // 调度器 advance() 实际读到的最小表集合（列与 control-plane 迁移一致）
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE plans(id TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'director');
      CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),plan_id TEXT REFERENCES plans(id),employee_id TEXT,runtime TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,queue_reason TEXT,verification_status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE task_dependencies(task_id TEXT NOT NULL,depends_on_id TEXT NOT NULL,PRIMARY KEY(task_id,depends_on_id));
      CREATE TABLE meeting_items(id TEXT PRIMARY KEY,task_id TEXT NOT NULL);
      CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);`);
    const store = storeOf(db);
    const memory = createMemory(store);
    const projectId = 'bench-project';
    db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES (?,?,?,?)').run(projectId, '基准合成项目', join(dir, 'proj'), now());
    let launched = 0;
    const scheduler = createTaskScheduler({
      ...store,
      launch: () => { launched++; }, // mock：不启动任何真实 Agent 进程
      recordTask: (taskId, kind, payload) => memory.append(projectId, taskId, kind, payload),
      onWaiting: (task, reason) => db.prepare('UPDATE tasks SET queue_reason=? WHERE id=?').run(reason, task.id),
    });
    const insertTask = db.prepare('INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    const insertApproval = db.prepare('INSERT INTO approvals(id,task_id,action,status,created_at) VALUES (?,?,?,?,?)');
    const latencies = [];
    const total = count + 100; // 前 100 次预热不计入
    for (let i = 0; i < total; i++) {
      // fixture 画像经仓库真实 taskProfile 校验（scheduling.ts 同款入口）
      const spec = taskProfile({ kind: 'implementation', writePaths: [`src/gen/module-${i % 16}`], difficulty: 2, tags: ['ts'] });
      const id = `bench-task-${i}`;
      insertTask.run(id, projectId, 'codex', `基准任务 ${i}：写入 ${spec.writePaths.join(',')}`, 'queued', now(), now());
      insertApproval.run(`approval-${i}`, id, 'start-agent-in-project', 'approved', now());
      const t0 = performance.now();
      scheduler.pump();
      const elapsed = performance.now() - t0;
      if (i >= 100) latencies.push(elapsed);
    }
    if (launched !== total) throw new Error(`派活数量不符：期望 ${total}，实际 ${launched}`);
    const running = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='running'").get().c;
    if (running !== total) throw new Error(`running 任务数不符：期望 ${total}，实际 ${running}`);
    const sorted = [...latencies].sort((a, b) => a - b);
    return { count, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1), mean: latencies.reduce((a, b) => a + b, 0) / latencies.length };
  } finally { db.close(); removeTempDir(dir); }
}

/** apix_ledger durable 写入：真实 createMemory.append，逐条自动提交（与生产同一写入路径） */
function measureLedgerWrites(count) {
  const dir = makeTempDir('apix-bench-ledger-');
  const db = new DatabaseSync(join(dir, 'apix.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON'); // 与 control-plane 初始化一致
    const memory = createMemory(storeOf(db));
    db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES (?,?,?,?)').run('bench-project', '基准合成项目', join(dir, 'proj'), now());
    const synchronous = db.prepare('PRAGMA synchronous').get().synchronous;
    const latencies = [];
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      memory.append('bench-project', `bench-agg-${i % 100}`, 'bench.event', { i, marker: 'apix-bench-durable' });
      latencies.push(performance.now() - start);
    }
    const totalMs = performance.now() - t0;
    const persisted = db.prepare('SELECT COUNT(*) c FROM apix_ledger').get().c;
    if (persisted !== count) throw new Error(`落库数量不符：期望 ${count}，实际 ${persisted}`);
    const sorted = [...latencies].sort((a, b) => a - b);
    return { count, tps: count / (totalMs / 1000), totalMs, p50: percentile(sorted, 50), p99: percentile(sorted, 99), synchronous };
  } finally { db.close(); removeTempDir(dir); }
}

/** 持久 N 条事件后的真实服务启动：先让真实服务建好 schema，再批量合成种子，再测冷启动 */
async function measureStartupWithEvents(eventCount, cleanup) {
  const dataDir = makeTempDir('apix-bench-events-');
  cleanup.dirs.push(dataDir);
  const bootstrap = startService({ dataDir, port: await freePort(), ownerToken: syntheticOwnerToken() });
  cleanup.services.push(bootstrap);
  await waitReady(bootstrap);
  await stopService(bootstrap);
  const db = new DatabaseSync(join(dataDir, 'apix.sqlite'), { timeout: 5000 });
  const seedMs = (() => {
    const t0 = performance.now();
    try {
      db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES (?,?,?,?)').run('bench-project', '基准合成项目', join(dataDir, 'proj'), now());
      // 与 memory.append 相同的列形与负载规模；批量事务种子（非逐条 durable，报告中注明）
      const insert = db.prepare('INSERT INTO apix_ledger(project_id,aggregate_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)');
      const createdAt = now();
      for (let base = 0; base < eventCount; base += 10_000) {
        db.exec('BEGIN');
        for (let i = base; i < Math.min(base + 10_000, eventCount); i++) {
          insert.run('bench-project', `bench-agg-${i % 1000}`, 'bench.event', 'apix', JSON.stringify({ i, marker: 'apix-bench-seed' }), createdAt);
        }
        db.exec('COMMIT');
      }
      return performance.now() - t0;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 可能尚未开启事务 */ } throw error; }
  })();
  const persisted = db.prepare('SELECT COUNT(*) c FROM apix_ledger').get().c;
  db.close();
  if (persisted !== eventCount) throw new Error(`种子数量不符：期望 ${eventCount}，实际 ${persisted}`);
  const service = startService({ dataDir, port: await freePort(), ownerToken: syntheticOwnerToken() });
  cleanup.services.push(service);
  const elapsed = await waitReady(service, { timeoutMs: 180_000 });
  await stopService(service);
  return { eventCount, seedMs, startupMs: elapsed };
}

function renderReport(args, env, service, dispatch, ledger, events) {
  const rssMb = service.rss.medianKb == null ? 'n/a' : (service.rss.medianKb / 1024).toFixed(1);
  const rssNote = process.platform === 'win32' ? 'Windows 为 tasklist 工作集（近似 RSS）' : process.platform === 'linux' ? 'Linux /proc VmRSS' : 'macOS ps RSS';
  const lines = [
    '# ApiX P3 性能基准报告',
    '',
    `- 时间：${now()}`,
    `- 环境：Node ${env.node} · ${env.platform} · ${env.cpu} · ${env.cores} 核 · ${env.totalMemGiB} GiB 内存 · commit ${env.commit}`,
    `- 参数：cold-starts=${args.coldStarts} dispatch=${args.dispatch} ledger-writes=${args.ledgerWrites} events=${args.events} rss-wait-ms=${args.rssWaitMs}`,
    '',
    '## 测量口径（真实服务 vs 仓库模块）',
    '',
    '| 指标 | 运行主体 | 口径 |',
    '|---|---|---|',
    '| 冷启动 | 真实服务 `server.mjs` 子进程 | spawn → `GET /` 首次 HTTP 200（服务无 `/ready` 路由；未认证时 `/` 返回登录页亦为 200） |',
    `| 空闲 RSS | 真实服务子进程 | readiness 后等 ${args.rssWaitMs}ms，采样 5 次取中位；${rssNote} |`,
    '| 派活 p50/p99 | 仓库模块（进程内） | 真实 `createTaskScheduler.pump()` 单任务全路径（含同事务账本 append），mock launch，fixture 经 `taskProfile` 校验 |',
    '| ledger 写入 tps | 仓库模块（进程内） | 真实 `createMemory.append()` 逐条自动提交（WAL，synchronous=' + ledger.synchronous + '） |',
    `| ${events.eventCount} 事件后启动 | 真实服务子进程 | 合成批量种子（非逐条 durable）持久后，全新进程冷启动到 HTTP 200 |`,
    '',
    '全部数据为隔离临时目录中的合成数据（127.0.0.1，合成所有者令牌），不触碰真实数据目录，不启动外部 Agent。',
    '',
    '## 结果',
    '',
    '### 真实服务冷启动（ms）',
    '',
    `采样：${service.coldStarts.map(v => v.toFixed(0)).join(' / ')} → 中位 **${ms(service.median)}**（min ${ms(service.min)} / max ${ms(service.max)}）`,
    '',
    `### 空闲 RSS`,
    '',
    `中位 **${rssMb} MiB**（采样 KB：${service.rss.samples.join(', ') || '不可用'}）`,
    '',
    '### 派活延迟（真实调度器 + mock launch，ms）',
    '',
    `n=${dispatch.count}（另 100 次预热）→ p50 **${ms(dispatch.p50)}** · p99 **${ms(dispatch.p99)}** · mean ${ms(dispatch.mean)} · max ${ms(dispatch.max)}`,
    '',
    '### apix_ledger durable 写入',
    '',
    `n=${ledger.count} → **${ledger.tps.toFixed(0)} tps**（总耗时 ${ms(ledger.totalMs)}ms；单条 p50 ${ms(ledger.p50)}ms / p99 ${ms(ledger.p99)}ms；synchronous=${ledger.synchronous}）`,
    '',
    `### 持久 ${events.eventCount} 条事件后启动`,
    '',
    `种子耗时 ${ms(events.seedMs)}ms → 冷启动 **${ms(events.startupMs)}ms**`,
    '',
    '## 复现',
    '',
    '```bash',
    'npm run build',
    `node scripts/benchmark/run.mjs --cold-starts ${args.coldStarts} --dispatch ${args.dispatch} --ledger-writes ${args.ledgerWrites} --events ${args.events} --rss-wait-ms ${args.rssWaitMs}`,
    '```',
    '',
    '## 已知限制',
    '',
    '- 单机单次采样，数字随机器/负载波动；CI 趋势对比应固定 runner 规格。',
    '- 派活延迟为进程内模块口径（不含 HTTP 与真实 Agent 启动）；launch 为 mock。',
    '- 事件种子为批量事务合成数据，只用于「持久事件量 → 启动耗时」维度，不代表逐条 durable 写入速度。',
    '- Windows RSS 口径为工作集，与 Linux VmRSS 不完全可比。',
  ];
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const env = environmentInfo();
  const cleanup = { dirs: [], services: [] };
  try {
    const service = await measureService(args, cleanup);
    const dispatch = measureDispatch(args.dispatch);
    const ledger = measureLedgerWrites(args.ledgerWrites);
    const events = await measureStartupWithEvents(args.events, cleanup);
    const report = renderReport(args, env, service, dispatch, ledger, events);
    process.stdout.write(report);
    if (args.report) {
      const target = resolve(args.report);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, report);
      console.log(`报告已写入：${target}`);
    }
  } finally {
    for (const service of cleanup.services) await stopService(service).catch(() => {});
    for (const dir of cleanup.dirs) { try { removeTempDir(dir); } catch { /* 清理失败不影响结论，残留目录带 apix-bench- 前缀可人工辨认 */ } }
  }
}

main().catch(error => { console.error(`benchmark: ${error instanceof Error ? error.stack ?? error.message : error}`); process.exitCode = 2; });