// 从仓库根目录使用已完成构建的 bundled Node 启动；只操作本次创建的隔离数据。
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.argv.slice(2).every(arg => arg === '--verify-only'), '只支持 --verify-only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(root, '.tmp-codex-round2-'));
const project = join(dir, 'project');
await mkdir(project);
execFileSync('git', ['init', project], { stdio: 'ignore' });
await writeFile(join(project, 'README.md'), 'ApiX isolated round 2 validation\n');
execFileSync('git', ['add', 'README.md'], { cwd: project });
execFileSync('git', ['-c', 'user.name=ApiX Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: project, stdio: 'ignore' });
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(root, 'server.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), APIX_DATA_DIR: join(dir, 'data'), APIX_LEGACY_API: '0',
    APIX_MANAGER_PI_ENTRY: join(root, 'test/fake-pi.mjs'), APIX_PI_ENTRY: join(root, 'test/fake-pi.mjs'),
    APIX_CODEX_ENTRY: join(root, 'test/fake-codex.mjs'), APIX_CLAUDE_ENTRY: join(root, 'test/fake-claude.mjs'),
    APIX_FIXTURE_STREAM: '1', APIX_FIXTURE_STREAM_DELAY_MS: '650' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
server.stderr.on('data', data => { errors = (errors + data).slice(-6000); });
const exited = once(server, 'exit');
server.on('error', error => { errors += String(error); });
async function request(path, body) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(errors || '隔离服务提前退出');
    try { await request('/api/snapshot'); ready = true; break; } catch { /* 服务正在启动 */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(ready, errors || '隔离服务启动超时');
  const catalog = await request('/api/manager/providers');
  assert.ok(catalog.providers.length > 0);
  const projectId = (await request('/api/projects', { name: 'Codex 第二轮隔离复验', path: project })).id;
  let session = await request('/api/coordination/sessions', { projectId, goal: '验证连续流式对话', interactionMode: 'conversational' });
  async function captureStream(target, content) {
  const events = [];
  const response = await fetch(`${origin}/api/coordination/sessions/${target.id}/messages/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: target.revision, content }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const started = Date.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        assert.ok(type && data, '真实服务帧缺少 event/data');
        events.push({ type, data: JSON.parse(data), elapsedMs: Date.now() - started });
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  return events;
  }
  const events = await captureStream(session, 'fixture-long-reply');
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].data.sessionId, session.id);
  const complete = events.at(-1);
  assert.equal(complete.type, 'complete');
  assert.ok(events.some(event => event.type === 'delta' && event.elapsedMs < complete.elapsedMs));
  assert.equal(complete.data.turns.at(-1).role, 'apix');
  session = await request(`/api/coordination/sessions/${session.id}`);
  assert.deepEqual(session.turns, complete.data.turns);
  assert.equal(session.revision, complete.data.revision);
  const secondRoundEvents = await captureStream(session, 'fixture-context');
  assert.equal(secondRoundEvents.at(-1).type, 'complete');
  session = secondRoundEvents.at(-1).data;
  assert.match(session.turns.at(-1).content, /fixture-long-reply/);
  const staleEvents = await captureStream({ ...session, revision: session.revision - 1 }, 'stale');
  assert.deepEqual(staleEvents.map(event => event.type), ['start', 'error']);
  assert.equal((await request(`/api/coordination/sessions/${session.id}`)).revision, session.revision);
  const fallbackEvents = await captureStream(session, 'fixture-runtime-error');
  assert.equal(fallbackEvents.at(-1).type, 'complete');
  assert.equal(fallbackEvents.at(-1).data.agent.mode, 'rules');
  const second = await request('/api/coordination/sessions', { projectId, goal: '目标切换隔离检查', interactionMode: 'conversational' });
  const legacy = { provider: 'old-pi-provider', model: 'old-model', baseUrl: '', apiType: 'openai-completions', apiKeyEnv: '' };
  assert.deepEqual(await request('/api/manager/settings', legacy), legacy);
  assert.deepEqual(await request('/api/manager/settings'), legacy);
  await request('/api/manager/settings', {});
  const manifest = { date: new Date().toISOString(), node: process.version, origin, dir, projectId,
    sessions: [session.id, second.id], model: 'fake Pi', uiAccepted: false,
    inputs: ['fixture-long-reply', 'fixture-context', 'fixture-invalid-reply', 'fixture-runtime-error'] };
  await writeFile(join(dir, '协议样本.json'), JSON.stringify({ catalog, events, secondRoundEvents, staleEvents, fallbackEvents, legacySettings: legacy }, null, 2));
  await writeFile(join(dir, '复验环境.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  console.log('隔离 API/真实协议样本检查通过；此结果不代表前端或真实模型验收通过。');
  if (!process.argv.includes('--verify-only')) {
    console.log('服务已保留供浏览器复验，Ctrl+C 停止。本轮样本位于上述 dir。');
    await new Promise(resolveStop => {
      process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop);
      exited.then(resolveStop, resolveStop);
    });
  }
} finally {
  if (server.exitCode === null) server.kill();
  await exited;
}
