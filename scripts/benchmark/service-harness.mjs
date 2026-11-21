/**
 * service-harness — P3 基准/崩溃模拟共用的真实服务探针（仅 Node 标准库）
 *
 * 所属层级：运维脚本 helper（scripts/benchmark 与 scripts/verify 共用）
 * 核心功能：
 *   1. 隔离临时数据目录的创建与清理（os.tmpdir 下，不触碰真实数据目录）
 *   2. 以子进程方式启动真实服务 server.mjs（127.0.0.1 + 随机空闲端口 + 合成所有者令牌）
 *   3. HTTP readiness 探测：服务没有 /ready 路由，口径为 GET / 返回 HTTP 200
 *      （未认证时 / 返回登录页，同样是 200；Host 头由 fetch 自动置为 127.0.0.1:port）
 *   4. 强杀自建子进程（Windows 用 taskkill /F /T，POSIX 用 SIGKILL），只针对本 harness 启动的进程
 *   5. 子进程 RSS 采样（Linux /proc，Windows tasklist 工作集，macOS ps）
 * 依赖关系：
 *   - 被 scripts/benchmark/run.mjs 与 scripts/verify/crash-sim.mjs 引用
 *   - 不 import control-plane，不写任何数据库
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, totalmem, cpus, release } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** 仓库根目录（本文件位于 scripts/benchmark/ 下） */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 创建隔离临时目录（前缀区分用途，便于异常残留时人工辨认） */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 清理临时目录；Windows 上文件可能被短暂占用，带重试 */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** 取一个当前空闲的 127.0.0.1 端口（listen(0) 由系统分配后立即释放） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 合成所有者令牌（64 位十六进制，满足 owner-access 的格式校验；与真实令牌无关） */
export function syntheticOwnerToken() {
  return randomBytes(32).toString('hex');
}

/**
 * startService - 启动真实服务子进程（server.mjs，未修改的真实入口）
 * @returns {{child, port, dataDir, ownerToken, startedAt, output: () => string}}
 * startedAt 为 spawn 时刻（performance.now 基准），冷启动耗时从这一刻算到 HTTP 200。
 */
export function startService({ dataDir, port, ownerToken, extraEnv = {} }) {
  const child = spawn(process.execPath, [join(repoRoot, 'server.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), APIX_DATA_DIR: dataDir, APIX_OWNER_TOKEN: ownerToken, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  const collect = chunk => { buffer = (buffer + chunk).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, port, dataDir, ownerToken, startedAt: performance.now(), output: () => buffer, exited };
}

/**
 * waitReady - 轮询 GET / 直到 HTTP 200（readiness 口径，见文件头）
 * @returns 从 startedAt 到首次 200 的毫秒数
 * 子进程提前退出或超时则抛错（附带服务输出便于诊断）。
 */
export async function waitReady(service, { timeoutMs = 90_000, intervalMs = 20 } = {}) {
  const url = `http://127.0.0.1:${service.port}/`;
  let lastError = null;
  let earlyExit = null;
  service.exited.then(info => { earlyExit = info; });
  while (performance.now() - service.startedAt < timeoutMs) {
    if (earlyExit) throw new Error(`服务提前退出（code=${earlyExit.code} signal=${earlyExit.signal}）：\n${service.output()}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return performance.now() - service.startedAt;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待 readiness 超时（${timeoutMs}ms，最后错误：${lastError?.message}）：\n${service.output()}`);
}

/**
 * stopService - 强杀本 harness 启动的服务子进程并等待其退出
 * Windows：taskkill /F /T 按 PID 杀进程树（只含本脚本自建的子进程）；POSIX：SIGKILL。
 * 进程已退出时静默返回。
 */
export async function stopService(service) {
  const { child } = service;
  if (child.exitCode !== null || child.signalCode !== null) return service.exited;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 15_000 });
  } else {
    child.kill('SIGKILL');
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { return await service.exited; } finally { clearTimeout(timer); }
}

/**
 * sampleRssKb - 采样子进程常驻内存（KB）
 * Linux 读 /proc/<pid>/status 的 VmRSS；Windows 用 tasklist 的工作集（口径近似 RSS，报告中注明）；
 * macOS 用 ps。进程不存在或平台不支持时返回 null。
 */
export function sampleRssKb(pid) {
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      return match ? Number(match[1]) : null;
    }
    if (process.platform === 'win32') {
      const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      const line = (result.stdout ?? '').split(/\r?\n/).find(l => l.includes(`"${pid}"`));
      if (!line) return null;
      const fields = line.match(/"([^"]*)"/g) ?? [];
      const digits = (fields.at(-1) ?? '').replace(/[^\d]/g, '');
      return digits ? Number(digits) : null;
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 15_000 });
      const value = Number((result.stdout ?? '').trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    }
  } catch { /* 采样失败按不可用处理 */ }
  return null;
}

/** 环境信息（报告抬头用） */
export function environmentInfo() {
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 });
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch} (${release()})`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    totalMemGiB: (totalmem() / 1024 ** 3).toFixed(1),
    commit: git.status === 0 ? git.stdout.trim() : 'unknown',
  };
}

/** 最近邻百分位（输入须已升序排序） */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[index];
}