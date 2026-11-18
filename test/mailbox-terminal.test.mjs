import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMailboxService} from '../src/messaging/mailbox.mjs';

/**
 * 信箱终态回归：超时/过期消息不能被"确认完成"静默吞掉，
 * 以及 ack 之后超时应当从领取时刻重新起算。
 */

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT);
    CREATE TABLE employees(id TEXT PRIMARY KEY,enabled INTEGER DEFAULT 1,deleted_at TEXT,role TEXT DEFAULT '');
    CREATE TABLE conversations(id TEXT PRIMARY KEY);
    CREATE TABLE tasks(id TEXT PRIMARY KEY);
    CREATE TABLE agent_mailboxes(project_id TEXT NOT NULL,agent_id TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(project_id,agent_id));
    CREATE TABLE agent_messages(
      id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,correlation_id TEXT,reply_to TEXT,
      project_id TEXT NOT NULL,task_id TEXT,conversation_id TEXT,from_agent TEXT NOT NULL,to_agent TEXT NOT NULL,
      type TEXT NOT NULL,status TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal',payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,context_tokens INTEGER,timeout_ms INTEGER NOT NULL,expires_at TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,max_retries INTEGER NOT NULL DEFAULT 3,next_retry_at TEXT,error TEXT,
      created_at TEXT NOT NULL,delivered_at TEXT,acknowledged_at TEXT,completed_at TEXT,
      target_task_id TEXT,target_run_id TEXT,source_run_id TEXT,
      UNIQUE(project_id,idempotency_key));
    CREATE TABLE agent_message_attempts(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,UNIQUE(message_id,attempt_no));
    CREATE TABLE agent_message_events(id INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT,project_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_agent TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE agent_message_artifacts(message_id TEXT NOT NULL,artifact_id TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,excerpt TEXT NOT NULL DEFAULT '',source_task_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(message_id,artifact_id));
    CREATE TABLE agent_locks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,resource_type TEXT NOT NULL,resource_key TEXT NOT NULL,owner_agent_id TEXT NOT NULL,task_id TEXT,lease_id TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,released_at TEXT);
  `);
  db.prepare('INSERT INTO projects(id,name,path) VALUES (?,?,?)').run('p1', 'P', '/tmp/p1');
  db.prepare('INSERT INTO employees(id,role) VALUES (?,?)').run('dir', 'director');
  db.prepare('INSERT INTO employees(id,role) VALUES (?,?)').run('emp', 'developer');
  db.prepare("INSERT INTO agent_mailboxes(project_id,agent_id,role,created_at) VALUES ('p1','apix-director','director',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO agent_mailboxes(project_id,agent_id,role,created_at) VALUES ('p1','emp','employee',?)").run(new Date().toISOString());
  const now = () => new Date().toISOString();
  const row = (sql, ...args) => db.prepare(sql).get(...args);
  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  return {db, mailbox: createMailboxService({db, row, rows, now}), row};
}

test('过期消息的完成确认会报错，而不是静默返回成功', () => {
  const {mailbox, db} = fixture();
  const message = mailbox.sendMessage({projectId: 'p1', from: 'apix-director', to: 'emp', type: 'event', idempotencyKey: 'expired-1', timeoutMs: 1000, payload: {kind: 'guidance'}});
  // 直接把它推到过期态，模拟处理时间超过超时。
  db.prepare("UPDATE agent_messages SET status='expired' WHERE id=?").run(message.id);
  assert.throws(() => mailbox.completeMessage(message.id, {agentId: 'emp'}), /已超时/);
  assert.equal(db.prepare('SELECT status FROM agent_messages WHERE id=?').get(message.id).status, 'expired');
});

test('ack 会把超时从领取时刻重新起算，长任务不会在处理途中过期', () => {
  const {mailbox, db} = fixture();
  const message = mailbox.sendMessage({projectId: 'p1', from: 'apix-director', to: 'emp', type: 'event', idempotencyKey: 'renew-1', timeoutMs: 60000, payload: {kind: 'guidance'}});
  // 模拟"快到期的待办"：到期时间只比现在晚 1 秒，但尚未过期。
  // ack 后应当重新获得完整的 timeout 预算，而不是沿用这 1 秒。
  const near = new Date(Date.now() + 1000).toISOString();
  db.prepare("UPDATE agent_messages SET expires_at=?,status='delivered' WHERE id=?").run(near, message.id);
  mailbox.ackMessage(message.id, {agentId: 'emp'});
  const after = db.prepare('SELECT expires_at,status FROM agent_messages WHERE id=?').get(message.id);
  assert.equal(after.status, 'processing');
  assert(Date.parse(after.expires_at) > Date.parse(near) + 30000, '续租后应获得接近完整 timeout 的处理时间');
});

test('已完成消息的重复确认保持幂等', () => {
  const {mailbox, db} = fixture();
  const message = mailbox.sendMessage({projectId: 'p1', from: 'apix-director', to: 'emp', type: 'event', idempotencyKey: 'idem-1', payload: {kind: 'guidance'}});
  mailbox.ackMessage(message.id, {agentId: 'emp'});
  mailbox.completeMessage(message.id, {agentId: 'emp'});
  const again = mailbox.completeMessage(message.id, {agentId: 'emp'});
  assert.equal(again.status, 'completed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_message_events WHERE message_id=? AND event_type='message.completed'").get(message.id).n, 1);
});
