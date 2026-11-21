#!/usr/bin/env node
/**
 * crash-sim.mjs — P3 崩溃模拟（强杀真实服务后核对已确认写入，仅 Node 标准库）
 *
 * 所属层级：运维脚本（故障注入验证）
 * 核心功能：
 *   1. 隔离临时目录启动真实服务 server.mjs（127.0.0.1 + 合成所有者令牌）
 *   2. 每轮并发写入：HTTP 创建协调会话（服务写入，200 响应即确认）+ 仓库模块
 *      createMemory.append（模块写入，返回 sequence 即确认）+ createEffectJournal.begin
 *      留下 state='started' 的副作用；随机时延后强杀服务子进程
 *      （Windows taskkill /F /T，POSIX SIGKILL），重启后逐条核对
 *   3. 核对口径：以「确认集合」的精确 ID/载荷为准——每条已确认写入必须恰好存在一次
 *      且载荷逐字一致；未收到确认的事务可能合法持久化（允许存在，不视为丢失/重复），
 *      不以序号连续代替确认集合
 *   4. started 副作用识别：每轮用仓库真实恢复查询 createEffectJournal.pending /
 *      pendingProject 识别残留；收尾再验证 begin 的幂等护栏（CommandSafetyError）
 *   5. 收尾全量复审 + PRAGMA integrity_check，输出可复现 markdown（stdout，--report 可另存）
 * 隔离边界：
 *   - 只杀本脚本自建的服务子进程；合成数据在 os.tmpdir 隔离目录；不触碰真实数据、
 *     不启动外部 Agent；结束自动清理
 * 依赖关系：
 *   - scripts/benchmark/service-harness.mjs（真实服务探针）
 *   - dist/src/coordination/memory.js、dist/src/assistant/assistant-effects.js（需先 npm run build）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createMemory } from '../../dist/src/coordination/memory.js';
import { createEffectJournal } from '../../dist/src/assistant/assistant-effects.js';
import {
  makeTempDir, removeTempDir, freePort, syntheticOwnerToken,
  startService, waitReady, stopService, environmentInfo,
} from '../benchmark/service-harness.mjs';

const HELP = `用法：node scripts/verify/crash-sim.mjs [选项]

选项：
  --rounds <n>             强杀回合数（默认 200）
  --burst <n>              每轮 HTTP 会话写入数（默认 8）
  --appends <n>            每轮模块账本写入数（默认 20）
  --kill-delay-max-ms <n>  写入发起后到强杀的随机时延上限（默认 150）
  --seed <n>               随机种子（默认随机生成并打印，便于复现）
  --report <路径>          另存 markdown 报告（stdout 始终输出）
  --help                   显示本帮助

口径：readiness = GET / 首次 HTTP 200（服务无 /ready 路由）。
确认集合：HTTP 200 响应（服务写入）/ append 返回 sequence（模块写入）/ begin 返回 id（副作用）。
未确认事务可能合法持久化，按精确 ID/载荷核对，不以序号连续代替确认集合。`;

function parseArgs(argv) {
  const args = { rounds: 200, burst: 8, appends: 20, killDelayMaxMs: 150, seed: null, report: null, help: false };
  const numbers = { '--rounds': 'rounds', '--burst': 'burst', '--appends': 'appends', '--kill-delay-max-ms': 'killDelayMaxMs', '--seed': 'seed' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--report') { args.report = argv[++i]; if (!args.report) throw new Error('--report 缺少路径'); }
    else if (flag in numbers) {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value < (flag === '--kill-delay-max-ms' ? 0 : 1)) throw new Error(`${flag} 取值无效`);
      args[numbers[flag]] = value;
    } else throw new Error(`未知参数 ${flag}`);
  }
  if (args.seed === null) args.seed = randomBytes(4).readUInt32BE(0);
  return args;
}

/** mulberry32：可复现的轻量伪随机（标准库无内置 seeded RNG） */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = () => new Date().toISOString();
const storeOf = db => ({ db, row: (sql, ...p) => db.prepare(sql).get(...p), rows: (sql, ...p) => db.prepare(sql).all(...p), now });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 核对一条已确认会话：行存在且唯一、需求载荷逐字一致、账本 goal 事件与 turns 各恰好一条 */
function verifySession(db, id, goal, failures, label) {
  const sessions = db.prepare('SELECT id,title,requirements_json FROM coordination_sessions WHERE id=?').all(id);
  if (sessions.length !== 1) { failures.push(`${label} 会话 ${id}：期望恰好 1 行，实际 ${sessions.length}`); return; }
  const requirements = JSON.parse(sessions[0].requirements_json);
  if (requirements.goal !== goal || sessions[0].title !== goal.slice(0, 100)) failures.push(`${label} 会话 ${id}：载荷不一致（goal=${JSON.stringify(requirements.goal)}）`);
  const goalEvents = db.prepare("SELECT payload FROM apix_ledger WHERE aggregate_id=? AND kind='interaction.recorded'").all(id)
    .map(e => JSON.parse(e.payload)).filter(p => p.role === 'user' && p.kind === 'goal');
  if (goalEvents.length !== 1) failures.push(`${label} 会话 ${id}：goal 账本事件期望恰好 1 条，实际 ${goalEvents.length}`);
  else {
    const expected = { role: 'user', kind: 'goal', content: goal, revision: 1 };
    if (JSON.stringify(goalEvents[0]) !== JSON.stringify(expected)) failures.push(`${label} 会话 ${id}：goal 事件载荷不一致 ${JSON.stringify(goalEvents[0])}`);
  }
  const turns = db.prepare("SELECT content FROM coordination_turns WHERE session_id=? AND role='user' AND kind='goal'").all(id);
  if (turns.length !== 1 || turns[0].content !== goal) failures.push(`${label} 会话 ${id}：goal turn 期望恰好 1 条且内容一致，实际 ${turns.length}`);
}

/** 核对一条已确认模块写入：sequence 恰好一行且载荷逐字一致 */
function verifyAppend(db, sequence, payloadJson, failures, label) {
  const rows = db.prepare('SELECT payload FROM apix_ledger WHERE sequence=?').all(sequence);
  if (rows.length !== 1) failures.push(`${label} 账本 #${sequence}：期望恰好 1 行，实际 ${rows.length}`);
  else if (rows[0].payload !== payloadJson) failures.push(`${label} 账本 #${sequence}：载荷不一致`);
}

/** 核对 started 副作用集合：每条恰好一行且仍为 started，真实恢复查询能识别 */
function verifyEffects(db, journal, sessionId, projectId, effectIds, failures, label) {
  const rows = db.prepare('SELECT id,state FROM assistant_effects WHERE session_id=?').all(sessionId);
  const byId = new Map(rows.map(r => [r.id, r.state]));
  if (rows.length !== effectIds.length) failures.push(`${label} 副作用行数 ${rows.length} ≠ 已确认 ${effectIds.length}`);
  for (const id of effectIds) if (byId.get(id) !== 'started') failures.push(`${label} 副作用 ${id}：期望 state='started'，实际 ${byId.get(id) ?? '缺失'}`);
  if (!journal.pending(sessionId)) failures.push(`${label} journal.pending(${sessionId}) 未识别 started 残留`);
  if (!journal.pendingProject(projectId)) failures.push(`${label} journal.pendingProject(${projectId}) 未识别 started 残留`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const env = environmentInfo();
  const random = rng(args.seed);
  const dataDir = makeTempDir('apix-crash-sim-');
  const ownerToken = syntheticOwnerToken();
  const failures = [];
  const confirmed = { sessions: new Map(), appends: new Map(), effects: [] };
  let service = null;
  let db = null;
  const t0 = performance.now();
  let killCount = 0;
  let killMs = 0;
  let restartMs = 0;

  /** 启动（或重启）真实服务；端口被占用等早期退出时换新端口重试 */
  async function launch() {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      service = startService({ dataDir, port: await freePort(), ownerToken });
      try { await waitReady(service); return; }
      catch (error) { lastError = error; await stopService(service).catch(() => {}); }
    }
    throw lastError;
  }

  try {
    await launch();
    db = new DatabaseSync(join(dataDir, 'apix.sqlite'), { timeout: 5000 });
    const store = storeOf(db);
    const memory = createMemory(store);
    const journal = createEffectJournal(store);
    const projectId = 'crash-sim-project';
    const sessionId = 'crash-sim-assistant-session';
    db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES (?,?,?,?)').run(projectId, '崩溃模拟合成项目', join(dataDir, 'proj'), now());
    // assistant_sessions / assistant_events 由真实服务启动时建表；这里只插合成会话行
    db.prepare('INSERT INTO assistant_sessions(id,project_id,title,status,started_at,updated_at) VALUES (?,?,?,?,?,?)').run(sessionId, projectId, '崩溃模拟副作用会话', 'active', now(), now());
    for (let k = 0; k < 3; k++) {
      const effect = journal.begin(sessionId, undefined, 'crash-sim-tool', { seed: k }, 'fp-crash-sim', 'v1');
      confirmed.effects.push(effect.id);
    }
    const synchronous = db.prepare('PRAGMA synchronous').get().synchronous;

    for (let round = 1; round <= args.rounds; round++) {
      const label = `第 ${round} 轮`;
      const sessionsBefore = confirmed.sessions.size;
      const appendsBefore = confirmed.appends.size;
      // 1) 发起 HTTP 写入突发：只有收到完整 200 响应才计入确认集合；
      //    强杀时在途/未收到响应的事务保持「未确认」（可能合法持久化）
      const burst = [];
      for (let j = 0; j < args.burst; j++) {
        const goal = `crash-sim r${round} b${j} ${randomBytes(6).toString('hex')}`;
        burst.push((async () => {
          const response = await fetch(`http://127.0.0.1:${service.port}/api/coordination/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
            body: JSON.stringify({ projectId, goal }),
            signal: AbortSignal.timeout(15_000),
          });
          if (response.status !== 200) return;
          const body = await response.json();
          if (body?.id && body.requirements?.goal === goal) confirmed.sessions.set(body.id, goal);
          else failures.push(`${label} HTTP 200 但响应载荷异常：${JSON.stringify(body).slice(0, 200)}`);
        })().catch(() => { /* 未确认：连接被强杀打断等，合法 */ }));
      }
      // 2) 模块写入（真实 createMemory.append，与服务并发写同一 WAL 库）
      for (let j = 0; j < args.appends; j++) {
        const payload = { round, j, marker: 'crash-sim-confirmed' };
        const sequence = memory.append(projectId, `crash-sim-r${round}`, 'crash-sim.event', payload);
        confirmed.appends.set(sequence, JSON.stringify(payload));
      }
      // 3) 每轮新增一条 started 副作用（真实 createEffectJournal.begin）
      const effect = journal.begin(sessionId, undefined, 'crash-sim-tool', { round }, 'fp-crash-sim', 'v1');
      confirmed.effects.push(effect.id);
      // 4) 随机时延后强杀自建服务子进程，等待退出与在途请求落定
      await sleep(Math.floor(random() * (args.killDelayMaxMs + 1)));
      const killStart = performance.now();
      await stopService(service);
      killMs += performance.now() - killStart;
      killCount++;
      await Promise.allSettled(burst);
      // 5) 重启前核对：本轮新增确认逐条精确核对 + started 副作用可被真实恢复查询识别
      for (const [id, goal] of [...confirmed.sessions].slice(sessionsBefore)) verifySession(db, id, goal, failures, label);
      for (const [sequence, payloadJson] of [...confirmed.appends].slice(appendsBefore)) verifyAppend(db, sequence, payloadJson, failures, label);
      verifyEffects(db, journal, sessionId, projectId, confirmed.effects, failures, label);
      if (failures.length) throw new Error(`${label}发现 ${failures.length} 处不一致，提前终止（明细见 stderr）`);
      const restartStart = performance.now();
      await launch();
      restartMs += performance.now() - restartStart;
    }

    // 收尾全量复审：所有确认集合 + 未确认持久化的合法性 + 库完整性
    for (const [id, goal] of confirmed.sessions) verifySession(db, id, goal, failures, '终审');
    for (const [sequence, payloadJson] of confirmed.appends) verifyAppend(db, sequence, payloadJson, failures, '终审');
    verifyEffects(db, journal, sessionId, projectId, confirmed.effects, failures, '终审');
    const persistedSessions = db.prepare('SELECT id,requirements_json FROM coordination_sessions WHERE project_id=?').all(projectId);
    const unconfirmed = persistedSessions.filter(s => !confirmed.sessions.has(s.id));
    for (const s of unconfirmed) {
      // 未确认但持久化的会话必须同样是完整事务（行 + goal 账本事件同在），否则是撕裂写入
      const goal = JSON.parse(s.requirements_json).goal;
      verifySession(db, s.id, goal, failures, '未确认持久化');
    }
    // 幂等护栏：对已 started 的同一操作再次 begin 必须被真实恢复逻辑拦下
    let guardIdentified = false;
    try { journal.begin(sessionId, undefined, 'crash-sim-tool', { seed: 0 }, 'fp-crash-sim', 'v1'); }
    catch (error) { guardIdentified = String(error.message).includes('尚未确认') && error.operationId === confirmed.effects[0]; }
    if (!guardIdentified) failures.push('终审：begin 幂等护栏未识别 started 残留');
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') failures.push(`终审：integrity_check=${integrity}`);
    const ledgerTotal = db.prepare('SELECT COUNT(*) c FROM apix_ledger WHERE project_id=?').get(projectId).c;

    const wallMs = performance.now() - t0;
    const ok = failures.length === 0;
    const zero = ok ? '0' : '见失败明细';
    const lines = [
      '# ApiX P3 崩溃模拟报告',
      '',
      `- 时间：${now()}`,
      `- 环境：Node ${env.node} · ${env.platform} · ${env.cpu} · commit ${env.commit}`,
      `- 参数：rounds=${args.rounds} burst=${args.burst} appends=${args.appends} kill-delay-max-ms=${args.killDelayMaxMs} seed=${args.seed}`,
      '',
      '## 结论',
      '',
      ok
        ? `**${killCount} 次强杀，丢失 0 条已确认记录，重复 0 条；started 副作用每轮均可被真实恢复查询识别。**`
        : `**失败：${failures.length} 处不一致（强杀 ${killCount} 次后提前终止或终审发现）。**`,
      '',
      '## 确认集合（按精确 ID/载荷逐条核对，非序号连续口径）',
      '',
      '| 写入通道 | 运行主体 | 确认口径 | 已确认条数 | 丢失 | 重复/载荷不一致 |',
      '|---|---|---|---|---|---|',
      `| 协调会话创建 | 真实服务（HTTP POST /api/coordination/sessions） | 完整 200 响应 | ${confirmed.sessions.size} | ${zero} | ${zero} |`,
      `| 账本 append | 仓库模块 createMemory.append（与服务并发写同一 WAL 库） | 返回 sequence | ${confirmed.appends.size} | ${zero} | ${zero} |`,
      `| started 副作用 | 仓库模块 createEffectJournal.begin | 返回 id | ${confirmed.effects.length} | ${zero} | ${zero} |`,
      '',
      `- 未确认但合法持久化的会话：${unconfirmed.length} 条（强杀时在途事务；逐条核验行与 goal 账本事件同在，无撕裂写入）`,
      `- 账本总行数（本项目）：${ledgerTotal}；synchronous=${synchronous}（进程级强杀下已提交事务不丢；断电场景不在本模拟口径内）`,
      `- started 识别：每轮重启前后 journal.pending / journal.pendingProject 均为真；终审 begin 幂等护栏（CommandSafetyError）命中残留 id`,
      `- PRAGMA integrity_check：${integrity}`,
      `- 总耗时 ${(wallMs / 1000).toFixed(1)}s（平均每轮 ${(wallMs / args.rounds / 1000).toFixed(2)}s：强杀平均 ${(killMs / killCount).toFixed(0)}ms + 重启到 readiness 平均 ${(restartMs / killCount).toFixed(0)}ms）`,
      '',
      '## 口径与隔离',
      '',
      '- 被强杀的是真实服务 `server.mjs` 子进程（Windows `taskkill /F /T`，POSIX `SIGKILL`），只针对本脚本自建进程。',
      '- readiness = `GET /` 首次 HTTP 200（服务无 `/ready` 路由）。',
      '- 数据全部为隔离临时目录中的合成数据（127.0.0.1、合成所有者令牌），不触碰真实数据目录，不启动外部 Agent。',
      '- 恢复识别使用仓库真实逻辑：`createEffectJournal.pending / pendingProject / begin`（assistant-loop 同款查询）。',
      '',
      '## 复现',
      '',
      '```bash',
      'npm run build',
      `node scripts/verify/crash-sim.mjs --rounds ${args.rounds} --burst ${args.burst} --appends ${args.appends} --kill-delay-max-ms ${args.killDelayMaxMs} --seed ${args.seed}`,
      '```',
      '',
      '## 已知限制',
      '',
      '- 进程级强杀（非断电/磁盘故障）；WAL 已提交事务依赖 OS 页缓存存活，synchronous 语义内不丢。',
      `- 每轮 ${args.burst} 个 HTTP 写入 + ${args.appends} 个模块写入，随机时延 0–${args.killDelayMaxMs}ms 后强杀；seed 固定可复现同一时延序列。`,
      '- N 回合共 N+1 次真实冷启动，耗时随机器规格线性变化；CI 可用 --rounds 调小做冒烟，nightly 跑默认 200。',
      ...(ok ? [] : ['', '## 失败明细', '', ...failures.slice(0, 100).map(f => `- ${f}`), ...(failures.length > 100 ? [`- …其余 ${failures.length - 100} 条略`] : [])]),
    ];
    const report = lines.join('\n') + '\n';
    process.stdout.write(report);
    if (args.report) {
      const target = resolve(args.report);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, report);
      console.log(`报告已写入：${target}`);
    }
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error(`crash-sim: ${error instanceof Error ? error.message : error}`);
    for (const f of failures.slice(0, 50)) console.error(`  - ${f}`);
    process.exitCode = 1;
  } finally {
    if (service) await stopService(service).catch(() => {});
    if (db) { try { db.close(); } catch { /* 已关闭 */ } }
    try { removeTempDir(dataDir); } catch { /* 残留目录带 apix-crash-sim- 前缀可人工辨认 */ }
  }
}

main().catch(error => { console.error(`crash-sim: ${error instanceof Error ? error.stack ?? error.message : error}`); process.exitCode = 2; });