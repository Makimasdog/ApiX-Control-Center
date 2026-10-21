const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { join, delimiter } = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { readFileSync, writeFileSync } = require('node:fs');

async function freePort(preferred = 0) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(preferred, '127.0.0.1', resolve); });
  } catch (error) {
    if (preferred && error.code === 'EADDRINUSE') return freePort();
    throw error;
  }
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

// Reuse the command supervisor's Windows Job Object so descendants also die on a desktop crash.
async function startBackend({ root, dataDir, log, onExit = () => {} }) {
  const portFile = join(dataDir, 'desktop-port.json');
  let preferred = 0;
  try { const value = JSON.parse(readFileSync(portFile)); if (Number.isInteger(value) && value >= 1024 && value <= 65535) preferred = value; } catch { /* First launch or invalid saved port. */ }
  const port = await freePort(preferred);
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), APIX_DATA_DIR: dataDir };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = join(root, 'runtime') + delimiter + (env[pathKey] ?? '');
  const supervisor = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(root, 'src/execution/windows-command.ps1'), '-JobName', 'Local\\ApiX-Desktop-' + randomUUID(),
  ], { cwd: dataDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopping = false;
  let settled = false;
  let started = false;
  let stopPromise;
  let pending = '';
  let output = '';
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const closed = new Promise(resolve => supervisor.once('close', resolve));
  const stop = () => stopPromise ??= (async () => {
    stopping = true;
    if (!supervisor.stdin.destroyed && !supervisor.stdin.writableEnded) supervisor.stdin.end('cancel\n');
    const timer = setTimeout(() => supervisor.kill(), 5000);
    await closed;
    clearTimeout(timer);
  })();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('后端启动超时，请查看桌面版日志。')), 45000);
    const fail = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    supervisor.once('error', fail);
    supervisor.once('close', code => {
      fail(new Error(`后端提前退出（${code}），请查看桌面版日志。`));
      if (started && !stopping) onExit(code);
    });
    supervisor.stderr.on('data', chunk => log.write(chunk));
    supervisor.stdin.on('error', fail);
    supervisor.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 200000) { fail(new Error('后端监督协议输出超限。')); supervisor.kill(); return; }
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const [kind, a, b] = pending.slice(0, at).trim().split('|');
        pending = pending.slice(at + 1);
        if (kind === 'job') supervisor.stdin.write('go\n');
        if (kind === 'out' && Object.hasOwn(decoders, a)) {
          const text = decoders[a].write(Buffer.from(b ?? '', 'base64'));
          log.write(text);
          if (a === 'stdout') {
            output = (output + text).slice(-4000);
            // Only trust the owned child's bind confirmation, never a service on an occupied port.
            if (!settled && output.includes(`ApiX Web: ${url}\n`)) {
              settled = true; started = true; clearTimeout(timer); resolve();
            }
          }
        }
        if (kind === 'error' || kind === 'end') {
          if (kind === 'error') log.write(Buffer.from(a ?? '', 'base64').toString('utf8') + '\n');
          fail(new Error('后端停止或启动失败，请查看桌面版日志。'));
          if (!stopping) supervisor.stdin.end('cancel\n');
        }
      }
    });
    supervisor.stdin.write(JSON.stringify({
      executable: join(root, 'runtime/node.exe'),
      args: ['--env-file-if-exists=' + join(dataDir, '.env'), join(root, 'server.mjs')],
      cwd: dataDir, timeoutMs: 0, env,
    }) + '\n');
  });
  try { await ready; writeFileSync(portFile, JSON.stringify(port)); } catch (error) { await stop(); throw error; }
  return { url, stop, supervisorPid: supervisor.pid };
}

module.exports = { startBackend };
