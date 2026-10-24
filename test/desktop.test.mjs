import {fetch} from './local-fetch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

const { startBackend } = createRequire(import.meta.url)('../desktop/backend.cjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function ended(pid) {
  for (let n = 0; n < 100 && alive(pid); n++) await delay(100);
  assert.equal(alive(pid), false, `进程 ${pid} 应退出`);
}
async function fixture(work) {
  const root = mkdtempSync(resolve('.tmp-desktop-test-中文 space-'));
  const dataDir = join(root, '中文 data');
  mkdirSync(dataDir);
  mkdirSync(join(root, 'runtime'));
  mkdirSync(join(root, 'src/execution'), { recursive: true });
  cpSync(process.execPath, join(root, 'runtime/node.exe'));
  for (const name of ['windows-command.ps1', 'windows-command.cs']) cpSync(join('src/execution', name), join(root, 'src/execution', name));
  const log = new PassThrough(); log.resume();
  try { await work({ root, dataDir, log }); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const server = `import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs'; import {spawn} from 'node:child_process'; import {join} from 'node:path';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
writeFileSync(join(process.env.APIX_DATA_DIR,'pids.json'),JSON.stringify({parent:process.pid,child:child.pid}));
createServer((req,res)=>res.end(JSON.stringify({data:process.env.APIX_DATA_DIR,fixture:process.env.DESKTOP_FIXTURE,node:process.execPath})))
.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('ApiX Web: http://127.0.0.1:'+process.env.PORT));`;

test('desktop owns its backend, loads external configuration, and stops the entire process tree', { skip: process.platform !== 'win32', timeout: 25000 }, () => fixture(async context => {
  writeFileSync(join(context.root, 'server.mjs'), server);
  writeFileSync(join(context.dataDir, '.env'), 'DESKTOP_FIXTURE=external-config\nPORT=1\nAPIX_DATA_DIR=wrong\n');
  const backend = await startBackend(context);
  const pids = JSON.parse(readFileSync(join(context.dataDir, 'pids.json')));
  try {
    const response = await fetch(backend.url);
    assert.deepEqual(await response.json(), { data: context.dataDir, fixture: 'external-config', node: join(context.root, 'runtime/node.exe') });
    assert(alive(pids.child));
  } finally { await Promise.all([backend.stop(), backend.stop()]); }
  await ended(pids.parent); await ended(pids.child); await ended(backend.supervisorPid);
}));

test('desktop startup failure rejects and cleans up without reporting a second runtime failure', { skip: process.platform !== 'win32', timeout: 25000 }, () => fixture(async context => {
  writeFileSync(join(context.root, 'server.mjs'), "throw new Error('fixture startup failed')");
  let exits = 0;
  await assert.rejects(startBackend({ ...context, onExit: () => exits++ }), /后端/);
  assert.equal(exits, 0);
}));

test('losing the desktop supervisor kills the backend and descendants', { skip: process.platform !== 'win32', timeout: 25000 }, () => fixture(async context => {
  writeFileSync(join(context.root, 'server.mjs'), server);
  const backend = await startBackend(context);
  const pids = JSON.parse(readFileSync(join(context.dataDir, 'pids.json')));
  try { process.kill(backend.supervisorPid); await ended(pids.parent); await ended(pids.child); }
  finally { await backend.stop(); }
}));

test('desktop keeps its origin on restart and falls back when its saved port is occupied', { skip: process.platform !== 'win32', timeout: 30000 }, () => fixture(async context => {
  writeFileSync(join(context.root, 'server.mjs'), server);
  const first = await startBackend(context);
  await first.stop();
  const second = await startBackend(context);
  try { assert.equal(second.url, first.url); } finally { await second.stop(); }
  const occupied = createServer();
  await new Promise(done => occupied.listen(Number(new URL(first.url).port), '127.0.0.1', done));
  try {
    const third = await startBackend(context);
    try { assert.notEqual(third.url, first.url); } finally { await third.stop(); }
  } finally { await new Promise(done => occupied.close(done)); }
}));


test('development backend uses an explicit Node runtime without a staged runtime copy', { skip: process.platform !== 'win32', timeout: 25000 }, () => fixture(async context => {
  writeFileSync(join(context.root,'server.mjs'),server);
  const backend=await startBackend({...context,node:process.execPath});
  try{assert.equal((await (await fetch(backend.url)).json()).node,process.execPath);}finally{await backend.stop();}
}));
