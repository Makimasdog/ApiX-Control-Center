import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMemory} from '../dist/src/coordination/memory.js';
import {createCoordinator} from '../dist/src/coordination/coordinator.js';

/**
 * 会话快照去重
 *
 * 背景：recordTask 对每条运行时事件（turn/usage/message 等）都会写一份
 * 「整份会话 + 全部任务」的 coordination.snapshot。一次运行会产生几十条
 * 这类事件，而它们并不改变会话投影——实测 50 条事件写出 4MB 账本。
 *
 * 现在按投影签名去重：状态确实变化时仍写快照，纯运行时噪声不重复写。
 */

function fixture() {
  const db = new DatabaseSync(':memory:');
  const now = () => new Date().toISOString();
  const store = {
    db,
    row: (sql, ...params) => db.prepare(sql).get(...params),
    rows: (sql, ...params) => db.prepare(sql).all(...params),
    now,
  };
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,description TEXT,created_at TEXT);
    CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,runtime TEXT,role TEXT,department TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE plans(id TEXT PRIMARY KEY,project_id TEXT,goal TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,runtime TEXT,prompt TEXT,status TEXT,result TEXT,created_at TEXT,updated_at TEXT,plan_id TEXT,employee_id TEXT,queue_reason TEXT,verification_status TEXT,delivery_commit TEXT);
    CREATE TABLE coordination_sessions(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,requirements_json TEXT,revision INTEGER,confirmed_revision INTEGER,plan_id TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE coordination_turns(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,kind TEXT,content TEXT,created_at TEXT);
    CREATE TABLE coordination_events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,kind TEXT,payload TEXT,created_at TEXT);
    CREATE TABLE coordination_plan_briefs(plan_id TEXT PRIMARY KEY,session_id TEXT,revision INTEGER,requirements_json TEXT);
  `);
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('p1', 'P', '/tmp/p1', '', now());
  db.prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?,?)').run('e1', 'E', 'pi', 'dev', '', 1, now(), now());
  db.prepare('INSERT INTO coordination_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('s1', 'p1', 't', 'running', '{}', 1, 1, 'plan1', now(), now());
  db.prepare('INSERT INTO plans VALUES (?,?,?,?,?,?)').run('plan1', 'p1', 'goal', 'running', now(), now());
  db.prepare('INSERT INTO coordination_plan_briefs VALUES (?,?,?,?)').run('plan1', 's1', 1, '{}');
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('t0', 'p1', 'pi', 'x', 'running', '', now(), now(), 'plan1', 'e1', null, 'pending', null);

  // 协调器的依赖面很大；这里只测 recordTask → checkpoint，其余用最小桩
  const memory = createMemory(store);
  const coordinator = createCoordinator({
    ...store, memory,
    permissions: {get: () => ({mode: 'full_access', version: 1}), decision: () => 'allow', assertGranted: () => {}, grant: () => {}, save: () => ({mode: 'full_access', version: 2})},
    scheduling: {profile: () => ({model: 'm'}), taskSpec: () => ({}), assign: (_, steps) => steps, admission: () => null},
    autonomy: {settings: () => ({enabled: false, version: 1}), assertPlan: () => {}, details: () => null, context: () => '', tick: async () => {}},
    agent: {plan: async () => ({steps: [], mode: 'rules'}), architect: async () => null, guide: async () => ({action: 'observe', mode: 'rules'}), reviewWorkerQuestion: async () => null},
    resolveApproval: () => {}, stopRun: () => {}, sendMessage: () => ({id: 'm', status: 'queued'}),
    capabilities: () => [], reviewTask: () => {}, reportManagerFailure: () => {}, consult: async () => '', employees: () => [],
  });
  const snapshots = () => db.prepare("SELECT payload FROM apix_ledger WHERE kind='coordination.snapshot' ORDER BY sequence").all();
  return {coordinator, db, snaps: snapshots};
}

test('连续运行时事件只写一份快照，不随事件数线性增长', () => {
  const {coordinator, snaps} = fixture();
  // 首次事件建立基线快照
  coordinator.recordTask('t0', 'runtime.turn.started', {runId: 'r0'});
  const afterFirst = snaps().length;
  assert.equal(afterFirst, 1, '首次事件应写入一份快照');

  // 40 条不改变会话状态的运行时事件
  for (let i = 0; i < 40; i++) coordinator.recordTask('t0', `runtime.${['turn.finished', 'usage.updated', 'message.delivery'][i % 3]}`, {runId: 'r0', i});
  assert.equal(snaps().length, afterFirst, '纯运行时噪声不应重复写快照');
});

test('任务状态真正变化时必须写入新快照', () => {
  const {coordinator, db, snaps} = fixture();
  coordinator.recordTask('t0', 'runtime.turn.started', {runId: 'r0'});
  assert.equal(snaps().length, 1);

  db.prepare("UPDATE tasks SET status='completed' WHERE id='t0'").run();
  coordinator.recordTask('t0', 'agent.status', {runId: 'r0', status: 'completed'});
  assert.equal(snaps().length, 2, '状态变化后应写新快照');

  const latest = JSON.parse(snaps().at(-1).payload);
  assert.equal(latest.tasks.find((task) => task.id === 't0').status, 'completed');
});

test('快照里的任务输出有界，不复制完整报告', () => {
  const {coordinator, db, snaps} = fixture();
  const huge = 'x'.repeat(20000);
  db.prepare('UPDATE tasks SET result=? WHERE id=?').run(huge, 't0');
  coordinator.recordTask('t0', 'agent.status', {runId: 'r0'});

  const snapshot = JSON.parse(snaps().at(-1).payload);
  const task = snapshot.tasks.find((item) => item.id === 't0');
  assert.equal(task.result.length, 2000, '快照只保留有界预览');
  assert.equal(task.resultTruncated, true);
  assert.equal(task.resultBytes, 20000);
  // 完整内容仍在 tasks.result，可直接取回
  assert.equal(db.prepare('SELECT result FROM tasks WHERE id=?').get('t0').result.length, 20000);
});

test('快照去重不会因为时间戳变化而失效', () => {
  const {coordinator, db, snaps} = fixture();
  coordinator.recordTask('t0', 'runtime.turn.started', {runId: 'r0'});
  const before = snaps().length;
  // 只更新 updated_at，不改变任何语义字段
  db.prepare('UPDATE coordination_sessions SET updated_at=? WHERE id=?').run(new Date(Date.now() + 60000).toISOString(), 's1');
  coordinator.recordTask('t0', 'runtime.turn.finished', {runId: 'r0'});
  assert.equal(snaps().length, before, '时间戳变化不应触发新快照');
});
