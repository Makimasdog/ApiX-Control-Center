import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
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
let child,closed;
try {
cpSync(dirname(executable), isolatedApp, { recursive: true });
const project=join(isolated,'project');mkdirSync(join(project,'src'),{recursive:true});mkdirSync(join(project,'test'));
const pkg={name:'desktop-smoke',version:'1.0.0',private:true,scripts:{test:'node test/check.cjs'}};
writeFileSync(join(project,'package.json'),JSON.stringify(pkg));writeFileSync(join(project,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version}}}));
writeFileSync(join(project,'src/value.cjs'),'module.exports=42;');writeFileSync(join(project,'test/check.cjs'),"require('node:assert/strict').equal(require('../src/value.cjs'),42);");writeFileSync(join(project,'AGENTS.md'),'# Desktop smoke fixture\nPreserve the fixture source.\n');
let gitAvailable=true;try{execFileSync('git',['init','--quiet'],{cwd:project,windowsHide:true,stdio:'pipe',timeout:10000});}catch(error){if(error.code!=='ENOENT')throw error;gitAvailable=false;}
mkdirSync('.tmp-desktop', { recursive: true });
const dataDir = mkdtempSync(resolve('.tmp-desktop/smoke-'));
const env = { ...process.env, APIX_DESKTOP_DATA_DIR: dataDir, APIX_DESKTOP_SMOKE_PROJECT:project, APIX_DESKTOP_SMOKE_GIT:gitAvailable?'1':'0' };
delete env.ELECTRON_RUN_AS_NODE;
child = spawn(join(isolatedApp, basename(executable)), ['--smoke-test'], { env, cwd: isolatedApp, windowsHide: true, stdio: 'ignore' });
closed=new Promise(done=>child.once('close',done));
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
const checks=report.projectChecks;assert(checks,'请重新构建包含项目 Worker 探针的桌面包');
assert.deepEqual(report.rendererErrors,[],'Electron renderer logged errors');
assert.equal(checks.diagnosis.status,'needs_approval',JSON.stringify(checks.diagnosis.blocks));assert.equal(checks.diagnosis.scanComplete,true);assert.equal(checks.diagnosis.source.files.length,5);assert(checks.diagnosis.source.files.some(file=>file.path==='src/value.cjs'));
assert.equal(checks.diagnosis.capabilities.managedCommands.available,true);assert.equal(checks.network,false);
const packagedNode=join(isolatedApp,'resources/backend/runtime/node.exe'),packagedNpm=join(isolatedApp,'resources/backend/runtime/node_modules/npm/bin/npm-cli.js');
assert.equal(checks.runtime.node.toLowerCase(),packagedNode.toLowerCase());assert.equal(checks.runtime.npm.toLowerCase(),packagedNpm.toLowerCase());assert.equal(checks.diagnosis.runtime.node,checks.runtime.node);
assert(checks.instructions.includes('AGENTS.md'));assert(checks.contextInstructions?.includes('AGENTS.md'));
if(gitAvailable){assert.equal(checks.diagnosis.git.tracked,true);assert.equal(checks.diagnosis.git.complete,true);assert(checks.repositoryId);}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (let n = 0; n < 50 && alive(report.supervisorPid); n++) await delay(100);
assert.equal(alive(report.supervisorPid), false, '桌面退出后监督进程仍存活');
await assert.rejects(fetch(report.url, { signal: AbortSignal.timeout(2000) }), '桌面退出后后端端口应关闭');
console.log(JSON.stringify({ passed: true, executable, dataDir, ...report }, null, 2));
} finally {
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('桌面退出未确认，保留临时副本：'+isolated)),10000);closed.then(()=>{clearTimeout(timer);done();});});}
  assert.equal(dirname(isolated),resolve(tmpdir()),'临时清理路径越界');
  rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
