import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const executable = resolve(process.argv[2] ?? '.tmp-desktop/release/win-unpacked/ApiX Control Center.exe');
assert(existsSync(executable), '请先执行 npm run desktop:pack，或传入待验收 exe 的完整路径。');
const resources = join(dirname(executable), 'resources');
assert(existsSync(join(resources, 'backend/node_modules/@modelcontextprotocol/sdk/package.json')), '分发包缺少后端生产依赖。');
assert(existsSync(join(resources, 'backend/runtime/node_modules/npm/bin/npm-cli.js')), '分发包缺少 npm CLI。');
assert(!existsSync(join(resources, 'backend/.env')), '分发包不应包含个人 .env。');
// Run outside the repository so ancestor node_modules cannot mask missing packaged dependencies.
const isolated = mkdtempSync(join(tmpdir(), 'apix-desktop-'));
const isolatedApp = join(isolated, 'app');
try {
cpSync(dirname(executable), isolatedApp, { recursive: true });
mkdirSync('.tmp-desktop', { recursive: true });
const dataDir = mkdtempSync(resolve('.tmp-desktop/smoke-'));
const env = { ...process.env, APIX_DESKTOP_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(join(isolatedApp, basename(executable)), ['--smoke-test'], { env, cwd: isolatedApp, windowsHide: true, stdio: 'ignore' });
await new Promise((done, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('桌面验收超时，日志目录：' + dataDir)); }, 60000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error('桌面退出码：' + code)); });
});
const report = JSON.parse(readFileSync(join(dataDir, 'smoke-result.json'), 'utf8'));
assert(!report.error, report.error);
assert.equal(report.apiStatus, 200);
assert.equal(report.snapshot, 'object');
assert(report.bodyLength > 100);
assert.equal(report.nodeExposed, false);
assert(report.assets.length > 0);
assert(report.assets.every(asset => asset.status === 200), JSON.stringify(report.assets));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (let n = 0; n < 50 && alive(report.supervisorPid); n++) await delay(100);
assert.equal(alive(report.supervisorPid), false, '桌面退出后监督进程仍存活');
await assert.rejects(fetch(report.url, { signal: AbortSignal.timeout(2000) }), '桌面退出后后端端口应关闭');
console.log(JSON.stringify({ passed: true, executable, dataDir, ...report }, null, 2));
} finally {
  rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
