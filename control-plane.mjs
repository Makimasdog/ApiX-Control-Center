import {createConversationModels} from './dist/src/conversation-models.js';
import {loadEnvironment,workerEnvironment} from './src/environment.mjs';
import {projectDirectory,sameProjectDirectory} from './src/project-folders.mjs';
import {inspectCodex,executionArgs} from './dist/src/agent-settings.js';
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { externalAgents, scanExternalAgents } from "./agent-discovery.mjs";
import { createMailboxService } from "./src/mailbox.mjs";
import { createTaskScheduler } from "./src/task-scheduler.mjs";
import { createCodeHandoffs } from "./src/code-handoffs.mjs";
import {projectBaseline,projectSourceVersion} from './src/project-baseline.mjs';
import { createExecutionControl, quotaFailure } from './src/execution-control.mjs';
import { createCoordinator } from "./dist/src/coordinator.js";
import { requirementBrief } from "./dist/src/requirement-engine.js";
import { createMemory as createEventMemory } from "./dist/src/memory.js";
import { createPermissions } from "./dist/src/permissions.js";
import { createApiXAgent } from "./dist/src/apix-agent.js";
import { isLoopbackModelUrl,getProviderConfig } from "./dist/src/model-providers.js";
import { createRuntimeAdapters } from "./dist/src/runtime-adapters.js";
import {inferModel,directModelSettings} from './dist/src/model-backend.js';
import { normalizeWorkerEvent } from "./dist/src/worker-events.js";
import { createAgentMailbox } from "./dist/src/agent-mailbox.js";
import { createEmployeeInsights } from "./dist/src/employee-insights.js";
import { workerPrompt } from "./dist/src/worker-context.js";
import { createScheduling } from './dist/src/scheduling.js';
import { consultClaude } from './src/consultation.mjs';
import {projectReadiness} from './src/readiness.mjs';
import {createTaskDelivery} from './src/task-delivery.mjs';
import {createDeliveryInspection} from './src/delivery-inspection.mjs';
import {createAutonomy} from './dist/src/autonomy.js';
import {createAssistantLoop} from './dist/src/assistant-loop.js';
import {createAssistantCommands} from './dist/src/assistant-commands.js';
import {createAssistantCoding} from './dist/src/assistant-coding.js';
import {createAssistantInference,managerInferenceError} from './dist/src/assistant-inference.js';
import {createMcpManager} from './dist/src/mcp-manager.js';
import {createChatHistory} from './dist/src/chat-history.js';
import {fileTool,projectFingerprint,projectInstructions,skillsFor} from './dist/src/assistant-tools.js';

loadEnvironment();
const dataDir = process.env.APIX_DATA_DIR ?? join(homedir(), ".apix-agent-os");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "apix.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), runtime TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), action TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), runtime TEXT NOT NULL, status TEXT NOT NULL, status_source TEXT NOT NULL, pid INTEGER, started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, stop_requested_at TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), source TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)").run();
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=2").get()) {
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE approvals ADD COLUMN target_path TEXT; ALTER TABLE approvals ADD COLUMN prompt_hash TEXT");
    for (const pending of db.prepare("SELECT a.id,t.prompt,p.path FROM approvals a JOIN tasks t ON t.id=a.task_id JOIN projects p ON p.id=t.project_id WHERE a.status='pending'").all()) {
      db.prepare("UPDATE approvals SET target_path=?,prompt_hash=? WHERE id=?").run(pending.path, createHash("sha256").update(pending.prompt).digest("hex"), pending.id);
    }
    db.prepare("INSERT INTO schema_migrations(version) VALUES (2)").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=3").get()) {
  db.exec("BEGIN");
  try {
    db.exec("CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, role TEXT NOT NULL, department TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.exec("ALTER TABLE tasks ADD COLUMN employee_id TEXT REFERENCES employees(id)");
    db.prepare("INSERT INTO schema_migrations(version) VALUES (3)").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=4").get()) {
  db.exec("BEGIN");
  try {
    db.exec("CREATE TABLE plans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), goal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id,depends_on_id)); CREATE TABLE workspaces (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL); ALTER TABLE tasks ADD COLUMN plan_id TEXT REFERENCES plans(id); ALTER TABLE tasks ADD COLUMN workspace_path TEXT; ALTER TABLE tasks ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending';");
    db.prepare("INSERT INTO schema_migrations(version) VALUES (4)").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=5").get()) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, manager_id TEXT REFERENCES employees(id), created_at TEXT NOT NULL);
CREATE TABLE project_repositories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, path TEXT NOT NULL, UNIQUE(project_id,path));
CREATE TABLE workflow_packs (id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE meetings (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), topic TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE meeting_items (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), task_id TEXT NOT NULL REFERENCES tasks(id), UNIQUE(meeting_id,task_id));
CREATE TABLE shared_artifacts (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE integration_reviews (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), repository_path TEXT NOT NULL, status TEXT NOT NULL, report TEXT NOT NULL, workspace_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE workspaces ADD COLUMN base_sha TEXT;
ALTER TABLE integration_reviews ADD COLUMN base_sha TEXT;
ALTER TABLE tasks ADD COLUMN repository_id TEXT REFERENCES project_repositories(id);
ALTER TABLE tasks ADD COLUMN department_id TEXT REFERENCES departments(id);
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
ALTER TABLE plans ADD COLUMN pack_id TEXT;
ALTER TABLE plans ADD COLUMN pack_version INTEGER;
ALTER TABLE plans ADD COLUMN mode TEXT NOT NULL DEFAULT 'director';`);
    db.prepare("INSERT INTO schema_migrations(version) VALUES (5)").run();
    db.prepare("INSERT INTO workflow_packs(id,version,name,definition,created_at) VALUES (?,?,?,?,?)").run("development", 1, "软件开发协作", JSON.stringify({ steps: [
      { prompt: "分析需求并设计实施方案：{goal}", dependsOn: [] },
      { prompt: "实现主要功能：{goal}", dependsOn: [0] },
      { prompt: "并行编写测试并验证：{goal}", dependsOn: [0] },
      { prompt: "审查实现与测试结果，给出结论：{goal}", dependsOn: [1, 2] },
    ] }), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=6").get()) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE tasks ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
ALTER TABLE tasks ADD COLUMN resumes_task_id TEXT REFERENCES tasks(id);
ALTER TABLE employees ADD COLUMN deleted_at TEXT;
CREATE TABLE project_profiles (project_id TEXT PRIMARY KEY REFERENCES projects(id), summary TEXT NOT NULL DEFAULT '', goals TEXT NOT NULL DEFAULT '', constraints TEXT NOT NULL DEFAULT '', decisions TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), scope TEXT NOT NULL CHECK(scope IN ('task','project')), category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE memory_revisions (memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(memory_id,version));
CREATE VIRTUAL TABLE memory_fts USING fts5(title,content,tokenize='trigram');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memory_fts(rowid,title,content) VALUES (new.rowid,new.title,new.content); END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN DELETE FROM memory_fts WHERE rowid=old.rowid; INSERT INTO memory_fts(rowid,title,content) VALUES (new.rowid,new.title,new.content); END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN DELETE FROM memory_fts WHERE rowid=old.rowid; END;`);
    for (const task of db.prepare("SELECT id,project_id,prompt,created_at,updated_at FROM tasks WHERE plan_id IS NULL ORDER BY created_at,id").all()) {
      const conversationId = randomUUID();
      db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(conversationId, task.project_id, task.prompt.slice(0, 80), task.created_at, task.updated_at);
      db.prepare("UPDATE tasks SET conversation_id=? WHERE id=?").run(conversationId, task.id);
    }
    db.prepare("INSERT INTO schema_migrations(version) VALUES (6)").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=7").get()) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE director_threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE director_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES director_threads(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'complete', created_at TEXT NOT NULL);
CREATE TABLE director_proposals (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES director_threads(id), source_message_id TEXT NOT NULL REFERENCES director_messages(id), goal TEXT NOT NULL, steps_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, plan_id TEXT REFERENCES plans(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE memories ADD COLUMN source_message_id TEXT REFERENCES director_messages(id);`);
    db.prepare("INSERT INTO schema_migrations(version) VALUES (7)").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=8").get()) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE agent_mailboxes (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id,agent_id)
    );
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      correlation_id TEXT,
      reply_to TEXT REFERENCES agent_messages(id),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id),
      conversation_id TEXT REFERENCES conversations(id),
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      context_tokens INTEGER,
      timeout_ms INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      next_retry_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT,
      completed_at TEXT,
      UNIQUE(project_id,idempotency_key)
    );
    CREATE INDEX agent_messages_inbox ON agent_messages(project_id,to_agent,status,created_at);
    CREATE INDEX agent_messages_correlation ON agent_messages(project_id,correlation_id,created_at);
    CREATE TABLE agent_message_attempts (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(message_id,attempt_no)
    );
    CREATE TABLE agent_message_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT REFERENCES agent_messages(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_agent TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX agent_message_events_project ON agent_message_events(project_id,id);
    CREATE TABLE agent_message_artifacts (
      message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      digest TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      source_task_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(message_id,artifact_id)
    );
    CREATE TABLE agent_locks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      lease_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      released_at TEXT
    );
    CREATE UNIQUE INDEX agent_locks_active_resource ON agent_locks(project_id,resource_type,resource_key) WHERE released_at IS NULL;
    CREATE INDEX agent_locks_owner ON agent_locks(project_id,owner_agent_id,released_at);
    INSERT INTO schema_migrations(version) VALUES (8);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=9").get()) {
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE coordination_sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
      status TEXT NOT NULL, requirements_json TEXT NOT NULL, revision INTEGER NOT NULL,
      confirmed_revision INTEGER, plan_id TEXT REFERENCES plans(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX coordination_sessions_project ON coordination_sessions(project_id,updated_at);
    CREATE TABLE coordination_turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES coordination_sessions(id),
      role TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX coordination_turns_session ON coordination_turns(session_id,created_at);
    CREATE TABLE coordination_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES coordination_sessions(id),
      kind TEXT NOT NULL, ref_type TEXT, ref_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX coordination_events_session ON coordination_events(session_id,id);
    CREATE TABLE coordination_plan_briefs (
      plan_id TEXT PRIMARY KEY REFERENCES plans(id), session_id TEXT NOT NULL REFERENCES coordination_sessions(id),
      revision INTEGER NOT NULL, requirements_json TEXT NOT NULL
    );
    INSERT INTO schema_migrations(version) VALUES (9);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=10").get()) {
  db.exec("BEGIN");
  try {
    db.exec(`ALTER TABLE agent_messages ADD COLUMN target_task_id TEXT REFERENCES tasks(id);
      ALTER TABLE agent_messages ADD COLUMN target_run_id TEXT REFERENCES runs(id);
      ALTER TABLE agent_messages ADD COLUMN source_run_id TEXT REFERENCES runs(id);
      ALTER TABLE runs ADD COLUMN mailbox_seen_at TEXT;
      CREATE INDEX agent_messages_run ON agent_messages(project_id,to_agent,target_task_id,target_run_id,status);
      INSERT INTO schema_migrations(version) VALUES (10);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
if (!db.prepare("SELECT version FROM schema_migrations WHERE version=11").get()) {
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN input_commit TEXT;
      ALTER TABLE tasks ADD COLUMN delivery_commit TEXT;
      ALTER TABLE tasks ADD COLUMN delivery_fingerprint TEXT;
      ALTER TABLE workspaces ADD COLUMN common_dir TEXT;
      CREATE TABLE code_handoffs(task_id TEXT PRIMARY KEY REFERENCES tasks(id),status TEXT NOT NULL,base_sha TEXT NOT NULL,input_commit TEXT NOT NULL,report TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version) VALUES (11);`);
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
}
if(!db.prepare('SELECT version FROM schema_migrations WHERE version=12').get()) {
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN queue_reason TEXT;
      ALTER TABLE tasks ADD COLUMN recovery_fingerprint TEXT;
      CREATE TABLE execution_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id),project_limit INTEGER NOT NULL,employee_limit INTEGER NOT NULL,paused INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE runtime_pauses(project_id TEXT NOT NULL REFERENCES projects(id),runtime TEXT NOT NULL,paused INTEGER NOT NULL,reason TEXT NOT NULL,source_run_id TEXT REFERENCES runs(id),updated_at TEXT NOT NULL,PRIMARY KEY(project_id,runtime));
      INSERT INTO schema_migrations VALUES (12);`);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
const now = () => new Date().toISOString();
const running = new Map();

// A process cannot be safely reattached after a control-plane restart.
const recoveredTasks = db.prepare("SELECT id FROM tasks WHERE status IN ('running','stopping')").all();
db.prepare("UPDATE runs SET status='unknown', status_source='recovery', ended_at=? WHERE status IN ('starting','running','stopping')").run(now());
db.prepare("UPDATE tasks SET status='unknown', updated_at=? WHERE status IN ('running','stopping')").run(now());
db.prepare("UPDATE director_messages SET status='failed',content='主 Agent 推理被服务重启中断，请重新发送消息。' WHERE status='processing'").run();

const executableCache = new Map();
function findExecutable(name) {
  const cached=executableCache.get(name);
  if(cached && cached.until>Date.now() && (!cached.path || existsSync(cached.path))) return cached.path;
  let found=null;
  try {
    const paths = execFileSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", timeout: 2000, windowsHide:true, stdio:['ignore','pipe','ignore'] }).trim().split(/\r?\n/);
    found=process.platform === 'win32' ? paths.find(path=>path.toLowerCase().endsWith('.exe')) ?? paths.find(path=>path.toLowerCase().endsWith('.cmd')) ?? null : paths[0] ?? null;
  } catch { /* Optional executable is absent. */ }
  executableCache.set(name,{path:found,until:Date.now()+10000});
  return found;
}

function commandFor(runtime) {
  return runtimeAdapters.command(runtime);
}

function piShellEnvironment(env) {
  if(process.platform!=='win32')return env;
  const git=findExecutable('git');
  const bash=git?resolve(dirname(git),'..','bin','bash.exe'):null;
  if(!bash || !existsSync(bash))return env;
  const key=Object.keys(env).find(k=>k.toLowerCase()==='path') ?? 'PATH';
  return {...env,[key]:dirname(bash)+';'+(env[key] ?? '')};
}

export function runtimes() {
  const managed = runtimeAdapters.catalog();
  return [...managed, ...externalAgents().filter(a => !managed.some(m => m.id === a.id))];
}
export async function scanRuntimes() { executableCache.clear(); await scanExternalAgents(); return runtimes(); }

const rows = (sql, ...params) => db.prepare(sql).all(...params);
const row = (sql, ...params) => db.prepare(sql).get(...params);
const store = { db, row, rows, now };
const employeeInsights = createEmployeeInsights(store);
const memory = createEventMemory(store);
const permissions = createPermissions(store, memory);
const runtimeAdapters = createRuntimeAdapters(store, findExecutable);
const agentMailbox = createAgentMailbox(store);
const codeHandoffs = createCodeHandoffs({...store,dataDir,recordTask:(...args)=>coordinator.recordTask(...args)});
const executionControl=createExecutionControl({...store,recordEvent:(projectId,kind,payload)=>memory.append(projectId,projectId,kind,payload)});
const scheduling=createScheduling(store,{
  employees:()=>rows('SELECT * FROM employees WHERE deleted_at IS NULL'),available:id=>runtimes().some(r=>r.id===id && r.available && r.managed),
  denied:(projectId,employeeId,drafting=false)=>drafting ? permissions.get(projectId,employeeId).mode==='read_only' : permissions.decision(projectId,employeeId)==='deny',waiting:task=>executionControl.admission(task),supportsModel:runtimeAdapters.supportsModel
});
const autonomy=createAutonomy({...store,permissions,scheduling,
  employees:()=>rows('SELECT * FROM employees WHERE enabled=1 AND deleted_at IS NULL'),
  workflow:projectId=>coordinator.workflowSettings(projectId),
  inspect:async task=>{const result=await inspectTaskDelivery(task.id,true);if(result.error || !result.inspection)throw new Error(result.error??'交付无法检查');return result.inspection;},workspace:task=>codeHandoffs.workspace(task).path,
  accept:(id,fingerprint)=>acceptTask(id,true,fingerprint,'apix'),
  review:(...args)=>coordinator.qualityReview(...args),
  retry:async(task,employeeId,prompt)=>{const checked=await inspectTaskDelivery(task.id);const bound=row('SELECT session_id FROM coordination_plan_briefs WHERE plan_id=?',task.plan_id);const session=coordinator.sessionDetails(bound.session_id);const result=await recoverTask(task.id,{revision:session.revision,employeeId,runId:checked.latestRun?.id??null,fingerprint:checked.recoveryFingerprint,reviewed:true},'policy',prompt);if(result.failure)throw new Error(result.failure);},
  stop:id=>stopRun(id),sendMessage:input=>sendMessage(input),record:(...args)=>coordinator.recordTask(...args),
  reassignPending:(taskId,employeeId)=>{coordinator.reassignPending(taskId,employeeId);pumpTasks();},
  activatePending:planId=>{for(const approval of rows("SELECT a.id FROM approvals a JOIN tasks t ON t.id=a.task_id WHERE t.plan_id=? AND t.status='awaiting_approval' AND a.status='pending'",planId))resolveApproval(approval.id,true);pumpTasks();},
  delivered:(sessionId,planId)=>coordinator.delivered(sessionId,planId)
});

const { ensureMailbox, appendMessageEvent, publicMessage, registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact } = createMailboxService({ db, row, rows, now, recordEvent(projectId, aggregateId, kind, payload, actor) {
  memory.append(projectId, aggregateId, kind, payload, actor);
  const taskId = payload.taskId ?? row('SELECT task_id FROM agent_messages WHERE id=?', aggregateId)?.task_id;
  if (taskId) coordinator.recordTask(taskId, kind, { messageId: aggregateId, actor, ...payload });
} });

function event(runId, source, kind, payload = {}) {
  db.prepare("INSERT INTO events(run_id,source,kind,payload,created_at) VALUES (?,?,?,?,?)").run(runId, source, kind, JSON.stringify(payload), now());
  const run = row("SELECT task_id FROM runs WHERE id=?", runId);
  if (run) coordinator.recordTask(run.task_id, `runtime.${kind}`, { runId, source, payload });
}
function setRun(runId, status, source, exitCode = null) {
  db.prepare("UPDATE runs SET status=?,status_source=?,ended_at=CASE WHEN ? IN ('completed','failed','cancelled','unknown','blocked') THEN ? ELSE ended_at END,exit_code=COALESCE(?,exit_code) WHERE id=?").run(status, source, status, now(), exitCode, runId);
  const run = row("SELECT task_id FROM runs WHERE id=?", runId);
  if (run) {
    if (['completed','failed','cancelled','blocked'].includes(status)) scheduling.settle(runId,null,source==='workspace' || source==='spawn');
    db.prepare("UPDATE tasks SET status=?,updated_at=?,verification_status=? WHERE id=?").run(status, now(), status === "completed" ? "ready" : status === "failed" ? "failed" : "pending", run.task_id);
    const task = row("SELECT project_id,employee_id FROM tasks WHERE id=?", run.task_id);
    if (task) appendMessageEvent(task.project_id, null, "agent.status", task.employee_id ?? "system", { taskId: run.task_id, runId, status, source });
    if (["completed", "failed", "cancelled","blocked"].includes(status)) {scheduleDependents(run.task_id);pumpTasks();}
  }
}
function admission(task) {
  const waiting=executionControl.admission(task);if(waiting)return waiting;
  if(!task.employee_id && !task.plan_id && process.env.APIX_LEGACY_API==='1') {
    const policy=scheduling.policy(task.project_id);
    return policy.limitMinor===null && !policy.requireFreshQuota ? null : '旧任务没有员工账户，请在目标工作台重新安排以应用预算';
  }
  return scheduling.admission(task);
}
const { scheduleDependents,pump:pumpTasks } = createTaskScheduler({ db, row, rows, now, launch, admission,onWaiting:(task,reason)=>db.prepare('UPDATE tasks SET queue_reason=? WHERE id=?').run(reason,task.id), recordTask: (...args) => coordinator.recordTask(...args) });

function textFromMessage(message) {
  return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function recordOutput(runId, output, status) {
  if (!output.trim()) return;
  const run = row("SELECT task_id FROM runs WHERE id=?", runId);
  db.prepare("UPDATE tasks SET result=?,updated_at=? WHERE id=?").run(output, now(), run.task_id);
  const artifactId = randomUUID();
  db.prepare("INSERT INTO artifacts(id,run_id,kind,content,created_at) VALUES (?,?,?,?,?)").run(artifactId, runId, "agent-response", output, now());
  coordinator.recordTask(run.task_id, 'artifact.collected', { artifactId, runId, content: output, status });
  const task = row("SELECT plan_id,project_id,employee_id,conversation_id FROM tasks WHERE id=?", run.task_id);
  if (task?.plan_id) db.prepare("INSERT INTO shared_artifacts(id,plan_id,task_id,kind,content,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), task.plan_id, run.task_id, "agent-response", output, now());
  if (task?.employee_id) {
    try {
      const dispatchMessageId = running.get(runId)?.dispatchMessageId;
      const message = sendMessage({ projectId: task.project_id, taskId: run.task_id, conversationId: task.conversation_id, from: task.employee_id, to: "apix-director", type: dispatchMessageId ? "response" : "artifact_ref", replyTo: dispatchMessageId ?? undefined, idempotencyKey: `run-output:${runId}`, payload: { status, artifactId, kind: "agent-response", digest: createHash("sha256").update(output).digest("hex"), excerpt: output.slice(0, 500) } });
      attachMessageArtifact(message.id, { agentId: "apix-director", artifactId });
    } catch (error) { event(runId, "apix", "message_delivery_failed", { error: error.message }); }
  }
}

function gitRoot(projectPath) {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectPath, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}
function workspaceFor(task, project) {
  const repository = task.repository_id ? row("SELECT * FROM project_repositories WHERE id=? AND project_id=?", task.repository_id, task.project_id) : null;
  const sourcePath = repository?.path ?? project.path;
  if (!task.plan_id) return sourcePath;
  if (task.workspace_path) {
    const workspace=codeHandoffs.workspace(task);
    const baseline=projectBaseline(sourcePath,task.plan_id,dataDir,{create:false});
    const currentCommon=realpathSync.native(resolve(baseline,execFileSync('git',['rev-parse','--git-common-dir'],{cwd:baseline,encoding:'utf8'}).trim()));
    if(workspace.common!==currentCommon)throw new Error('项目或仓库路径已变化，请重新安排任务');
    if(row('SELECT status FROM code_handoffs WHERE task_id=?',task.id)?.status==='conflict'){const error=new Error('工作区仍有未审查的代码交接，请检查后恢复');error.code='HANDOFF_CONFLICT';throw error;}
    return task.workspace_path;
  }
  const root = projectBaseline(sourcePath,task.plan_id,dataDir);
  const workspaceRoot = join(dataDir, "workspaces", task.id);
  mkdirSync(dirname(workspaceRoot), { recursive: true });
  try {
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const commonDir=realpathSync.native(resolve(root,execFileSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'}).trim()));
    execFileSync("git", ["worktree", "add", "--detach", workspaceRoot, baseSha], { cwd: root, encoding: "utf8", timeout: 20000 });
    db.prepare("INSERT INTO workspaces(id,task_id,path,kind,status,created_at,base_sha,common_dir) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), task.id, workspaceRoot, "git-worktree", "ready", now(), baseSha,commonDir);
    db.prepare("UPDATE tasks SET workspace_path=?,input_commit=? WHERE id=?").run(workspaceRoot,baseSha, task.id);
    if(['coordinator','collaboration'].includes(row("SELECT mode FROM plans WHERE id=?",task.plan_id)?.mode))codeHandoffs.populate({...task,workspace_path:workspaceRoot,input_commit:baseSha});
    return workspaceRoot;
  } catch (error) {
    eventForTask(task.id, "apix", "workspace_failed", { message: error.message });
    if(error.code==='HANDOFF_CONFLICT')throw error;
    throw new Error(`无法创建独立工作区：${error.message}`);
  }
}
function eventForTask(taskId, source, kind, payload = {}) {
  const run = row("SELECT id FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1", taskId);
  if (run) event(run.id, source, kind, payload);
}

function launch(task) {
  coordinator.assertExecution(task);
  const project = row("SELECT * FROM projects WHERE id=?", task.project_id);
  const command = commandFor(task.runtime);
  if (!project || !command) throw new Error("Agent 不可用或项目不存在");
  const environment=workerEnvironment(process.env,task.runtime,managerApiKeys());
  environment.PYTHONUTF8='1';environment.PYTHONIOENCODING='utf-8';
  const repository = task.repository_id ? row("SELECT * FROM project_repositories WHERE id=? AND project_id=?", task.repository_id, task.project_id) : null;
  const sourcePath = repository?.path ?? project.path;
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) throw new Error("项目目录已不存在");
  if(task.recovery_fingerprint) {
    const actual=task.workspace_path ? codeHandoffs.inspect(task).fingerprint : 'head:'+projectSourceVersion(sourcePath,dataDir);
    if(actual!==task.recovery_fingerprint)throw new Error('恢复检查后工作区或源仓库已变化，请重新检查并批准');
  }
  const context = [];
  if(process.platform==='win32' && task.runtime==='codex')context.push('Windows 编码约定：文件、标准输入输出与报告均使用 UTF-8。通过 PowerShell 执行含中文的命令前，设置 $OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)；读取和写入文件显式使用 UTF-8，避免中文经管道变为问号。');
  const profile = row("SELECT * FROM project_profiles WHERE project_id=?", task.project_id);
  if (profile) context.push(`项目档案（用户维护，仅供参考）：\n${[profile.summary, profile.goals, profile.constraints, profile.decisions].filter(Boolean).join("\n").slice(0, 5000)}`);
  const projectMemories = rows("SELECT title,content FROM memories WHERE project_id=? AND scope='project' ORDER BY updated_at DESC LIMIT 5", task.project_id);
  if (projectMemories.length) context.push(`项目记忆（用户维护，仅供参考）：\n${projectMemories.map((item) => `${item.title}: ${item.content.slice(0, 1200)}`).join("\n")}`);
  if (task.conversation_id) {
    const history = rows("SELECT id,prompt,result,status FROM tasks WHERE conversation_id=? AND rowid<(SELECT rowid FROM tasks WHERE id=?) ORDER BY rowid DESC LIMIT 6", task.conversation_id, task.id).reverse();
    if (history.length) context.push(`本对话此前任务（请核对实际文件状态）：\n${history.map((item) => `用户：${item.prompt.slice(0, 1500)}\nAgent [${item.status}]：${item.result.slice(0, 2500)}`).join("\n---\n")}`);
    const taskMemories = rows("SELECT m.title,m.content FROM memories m JOIN tasks t ON t.id=m.task_id WHERE t.conversation_id=? AND m.scope='task' ORDER BY m.updated_at DESC LIMIT 5", task.conversation_id);
    if (taskMemories.length) context.push(`本对话任务记忆：\n${taskMemories.map((item) => `${item.title}: ${item.content.slice(0, 1000)}`).join("\n")}`);
  }
  const inputs = rows("SELECT s.id,s.task_id,s.content FROM shared_artifacts s JOIN task_dependencies d ON d.depends_on_id=s.task_id WHERE d.task_id=? ORDER BY s.created_at", task.id).map((item) => `前置交付物 ${item.id}（来源任务 ${item.task_id}，须自行验证）：\n${item.content}`);
  context.unshift(...inputs);
  const coordinated = task.plan_id ? row("SELECT requirements_json,revision FROM coordination_plan_briefs WHERE plan_id=?", task.plan_id) : null;
  const architectureContext=autonomy.context(task.id);
  if (coordinated) context.unshift(`ApiX 已确认的需求（版本 ${coordinated.revision}，执行依据）：\n${requirementBrief(JSON.parse(coordinated.requirements_json))}\n你是执行员工，ApiX 是管理者。可通过环境变量 APIX_MAILBOX_URL 指定的 HTTP 接口与团队协作，用 APIX_AGENT_TOKEN 作为 Bearer 凭据（不要输出凭据）。GET /messages 领取消息，POST /messages 发送 {to,type,payload,idempotencyKey,replyTo?}，POST /messages/:id/ack 或 /complete 确认。GET /team 查看同项目员工。推进到关键节点或遇到阻塞时，向 apix-director 发送 type=event、payload={kind:'progress_update',summary:'真实进度',blocked:true|false}；随后轮询 GET /messages，处理 ApiX 的 guidance 消息并确认。仅转交必要上下文，交付物使用引用。`);
  const approvedContext=[coordinated ? context.shift() : '',architectureContext].filter(Boolean).join('\n\n');
  const { prompt, truncated } = workerPrompt(task.prompt, approvedContext, context);
  const runId = randomUUID();
  db.exec('SAVEPOINT start_run');
  try{
    if(task.employee_id)scheduling.reserve(runId,task.project_id,task.employee_id,scheduling.taskSpec(task.id));
    db.prepare("INSERT INTO runs(id,task_id,runtime,status,status_source,started_at) VALUES (?,?,?,?,?,?)").run(runId, task.id, task.runtime, "starting", "apix", now());
    if(task.employee_id)scheduling.attempt(runId,task.id,task.employee_id);
    db.prepare("UPDATE tasks SET status='running',queue_reason=NULL,recovery_fingerprint=NULL,updated_at=? WHERE id=?").run(now(), task.id);
    db.exec('RELEASE start_run');
  }catch(error){db.exec('ROLLBACK TO start_run');db.exec('RELEASE start_run');throw error;}
  let child;
  let cwd;
  try { cwd = workspaceFor(task, project); }
  catch (error) { setRun(runId, error.code==='HANDOFF_CONFLICT'?'blocked':'failed', "workspace"); throw error; }
  const skipGitRepoCheck = task.runtime === "codex" && !gitRoot(cwd);
  const fullAccess = permissions.decision(task.project_id, task.employee_id) === "allow";
  const args = runtimeAdapters.args(task.runtime, fullAccess, skipGitRepoCheck);
  try { if(task.employee_id)args.push(...executionArgs(task.runtime,scheduling.profile(task.employee_id),scheduling.taskSpec(task.id).difficulty,runtimeAdapters.modelArgs)); }
  catch(error){setRun(runId,'failed','configuration');throw error;}
  const token = task.employee_id ? agentMailbox.issue(runId, task.project_id, task.employee_id) : '';
  try { child = spawn(command.executable, [...command.prefix, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...(task.runtime==='pi'?piShellEnvironment(environment):environment), APIX_AGENT_TOKEN: token, APIX_PROJECT_ID: task.project_id, APIX_AGENT_ID: task.employee_id ?? '', APIX_TASK_ID:task.id, APIX_RUN_ID:runId, APIX_MAILBOX_URL: `http://127.0.0.1:${process.env.PORT ?? 4173}/api/agent` } }); }
  catch (error) { setRun(runId, "failed", "spawn"); event(runId, "apix", "spawn_error", { message: error.message }); throw error; }
  running.set(runId, { child, runtime: task.runtime, output: "", stderr: "", stopped: false, settled: false });
  if (task.employee_id) {
    try {
      const dispatch = sendMessage({ projectId: task.project_id, taskId: task.id, conversationId: task.conversation_id, from: "apix-director", to: task.employee_id, type: "request", timeoutMs: 86400000, idempotencyKey: `task-dispatch:${runId}`, payload: { taskId: task.id, instructionExcerpt: task.prompt.slice(0, 4000), approval: "approved" } });
      ackMessage(dispatch.id, { agentId: task.employee_id });
      running.get(runId).dispatchMessageId = dispatch.id;
    } catch (error) { event(runId, "apix", "message_dispatch_failed", { error: error.message }); }
  }
  db.prepare("UPDATE runs SET status='running',status_source='process',pid=? WHERE id=?").run(child.pid ?? null, runId);
  event(runId, "apix", "run_started", { pid: child.pid ?? null, runtime: task.runtime, cwd, gitRepoCheckSkipped: skipGitRepoCheck, executionArgs:args });
  appendMessageEvent(task.project_id, null, "agent.status", task.employee_id ?? "system", { taskId: task.id, runId, status: "running", runtime: task.runtime });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (runtimeAdapters.format(task.runtime) === "plain") { running.get(runId).output += chunk; return; }
    buffer += chunk;
    let index;
    // One durable commit per received chunk keeps event bursts from issuing
    // hundreds of synchronous disk flushes while the HTTP loop is blocked.
    db.exec('SAVEPOINT runtime_chunk');
    try {
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { handleNative(runId, task.runtime, JSON.parse(line)); }
        catch { event(runId, task.runtime, "unparsed_stdout", { text: line.slice(0, 3000) }); }
      }
    } finally { db.exec('RELEASE runtime_chunk'); }
  });
  child.stderr.on("data", (chunk) => {
    const value = chunk;
    const active = running.get(runId);
    if (active) active.stderr = (active.stderr + value).slice(-4000);
    event(runId, task.runtime, "stderr", { text: value.slice(0, 4000) });
  });
  child.stdin.on("error", (error) => event(runId, "process", "stdin_error", { message: error.message }));
  child.on("error", (error) => { event(runId, "process", "error", { message: error.message }); });
  child.on("close", (code, signal) => {
    const active = running.get(runId);
    if (!active) return;
    if (buffer.trim()) { try { handleNative(runId,task.runtime,JSON.parse(buffer)); } catch { event(runId, task.runtime, "trailing_stdout", { text: buffer.slice(0, 3000) }); } }
    const confirmedStop = active.aborted || (active.stopped && (signal !== null || code !== 0));
    const status = confirmedStop ? "cancelled" : !active.failed && code === 0 && (task.runtime !== "pi" || active.settled && active.lastStopReason !== "error") ? "completed" : "failed";
    if(status==='failed' && (active.quotaBlocked || quotaFailure(active.stderr))){executionControl.pauseRuntime(task.project_id,task.runtime,'运行时报告额度或速率限制，请检查账户后明确恢复或重新分配',runId);if(task.employee_id)scheduling.pauseAccount(task.employee_id,runId);}
    recordOutput(runId, active.output, status);
    if (active.dispatchMessageId) {
      if (!active.output.trim()) {
        try { sendMessage({ projectId: task.project_id, taskId: task.id, conversationId: task.conversation_id, from: task.employee_id, to: "apix-director", type: "response", replyTo: active.dispatchMessageId, idempotencyKey: `run-output:${runId}`, payload: { status, error: active.stderr.slice(-1000) } }); }
        catch (error) { event(runId, "apix", "message_delivery_failed", { error: error.message }); }
      }
      completeMessage(active.dispatchMessageId, { agentId: task.employee_id });
    }
    setRun(runId, status, "process-exit", code);
    if (status === "failed" && !active.output.trim() && active.stderr.trim()) db.prepare("UPDATE tasks SET result=?,updated_at=? WHERE id=?").run(active.stderr.trim(), now(), task.id);
    event(runId, "process", "run_exited", { code, signal, status, stopRequested: active.stopped, stopConfirmed: confirmedStop });
    running.delete(runId);
  });
  if (truncated) event(runId, "apix", "context.truncated", { truncatedCount: truncated, budgetChars: 30000 });
  if (task.runtime === "pi") child.stdin.write(JSON.stringify({ id: runId, type: "prompt", message: prompt }) + "\n");
  else child.stdin.end(prompt);
  return runId;
}

function handleNative(runId, runtime, item) {
  const active = running.get(runId);
  if (!active) return;
  employeeInsights.observe(runId,runtime,item);
  scheduling.observeModel(runId,item);
  const type = item.type ?? "unknown";
  if(type==='error' || type==='turn.failed' || type==='result' && item.is_error===true || type==='message_end' && item.message?.stopReason==='error' || type==='response' && item.command==='prompt' && item.success===false) {
    const error=item.error ?? item.message?.error ?? {};
    if(quotaFailure(String(error.code ?? error.type ?? error.status ?? '')) || quotaFailure(typeof error==='string'?error:error.message ?? item.message?.errorMessage ?? item.result ?? textFromMessage(item.message)))active.quotaBlocked=true;
  }
  if (runtime === "pi") {
    if (type === "response" && item.command === "prompt" && !item.success) { event(runId, "pi-rpc", "prompt_rejected", { error: item.error }); active.child.stdin.end(); }
    if (type === "message_end" && item.message?.role === "assistant") { const value = textFromMessage(item.message); if (value) active.output = value; active.lastStopReason = item.message.stopReason; }
    if (type === "tool_execution_start") event(runId, "pi-rpc", type, { toolName: item.toolName, args: item.args });
    else if (type === "tool_execution_end") event(runId, "pi-rpc", type, { toolName: item.toolName, isError: item.isError });
    else if (type === "agent_settled" || type === "agent_end") { active.settled = true; active.aborted = item.aborted === true; event(runId, "pi-rpc", type, { aborted: item.aborted }); active.child.stdin.end(); }
    else if (["agent_start", "message_end", "response"].includes(type)) event(runId, "pi-rpc", type, type === "message_end" ? { role: item.message?.role, text: textFromMessage(item.message).slice(0, 5000) } : item);
  } else if (runtime === "claude") {
    if (type === 'assistant') active.output = textFromMessage(item.message) || active.output;
    if (type === 'result') { active.failed = item.is_error === true; if (typeof item.result === 'string') active.output = item.result; }
    event(runId, 'claude-stream', type, item);
  } else if (["gemini", "opencode", "kimi"].includes(runtime)) {
    const normalized = normalizeWorkerEvent(runtime, item);
    if (normalized?.text) active.output = normalized.textMode === 'append' ? active.output + normalized.text : normalized.text;
    if (normalized?.failed) {
      active.failed = true;
      const errorText = typeof item.error === 'string' ? item.error : item.error?.message ?? item.message;
      if (typeof errorText === 'string') active.stderr = (active.stderr + errorText).slice(-4000);
    }
    event(runId, `${runtime}-stream`, normalized?.kind ?? type, item);
  } else {
    if (type === 'result' && typeof item.text === 'string') active.output = item.text;
    if (type === 'error' && (runtime!=='codex' || normalizeWorkerEvent(runtime,item)?.failed)) active.failed = true;
    if (type === "item.completed" && item.item?.type === "agent_message") active.output += (active.output ? "\n" : "") + (item.item.text ?? "");
    if (type === "turn.failed") active.failed = true;
    if (["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.completed", "error"].includes(type)) event(runId, "codex-jsonl", type, item);
  }
}

const snapshotEpoch=randomUUID();
export function snapshot(ifNoneMatch) {
  const etag='"'+snapshotEpoch+':'+row('SELECT total_changes() AS n').n+':'+row('PRAGMA data_version').data_version+':'+Math.floor(Date.now()/10000)+'"';
  if(ifNoneMatch===etag)return {etag,notModified:true};
  const data={
    plans: plans(),
    runtimes: runtimes(),
    employees: rows("SELECT * FROM employees WHERE deleted_at IS NULL ORDER BY created_at DESC"),
    projects: rows("SELECT * FROM projects ORDER BY created_at DESC"),
    conversations: rows("SELECT c.*,(SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id) AS task_count FROM conversations c ORDER BY c.updated_at DESC"),
    profiles: rows("SELECT * FROM project_profiles"),
    memories: rows("SELECT * FROM memories ORDER BY updated_at DESC"),
    directorThreads: rows("SELECT * FROM director_threads ORDER BY updated_at DESC"),
    directorMessages: rows("SELECT * FROM director_messages ORDER BY created_at,id"),
    directorProposals: rows("SELECT * FROM director_proposals ORDER BY created_at DESC").map((item) => ({ ...item, steps: JSON.parse(item.steps_json) })),
    tasks: rows("SELECT t.*, p.name AS project_name, e.name AS employee_name FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN employees e ON e.id=t.employee_id ORDER BY t.created_at DESC"),
    approvals: rows("SELECT * FROM approvals ORDER BY created_at DESC"),
    runs: rows("SELECT * FROM runs ORDER BY started_at DESC").map((item) => ({ ...item, status_confidence: item.status_source === "process-exit" ? "confirmed" : item.status_source === "recovery" ? "unavailable" : "observed" })),
    events: rows("SELECT * FROM events ORDER BY id DESC LIMIT 300").map((item) => ({ ...item, payload: JSON.parse(item.payload) })),
    artifacts: rows("SELECT * FROM artifacts ORDER BY created_at DESC"),
    dependencies: rows("SELECT * FROM task_dependencies"),
    workspaces: rows("SELECT * FROM workspaces ORDER BY created_at DESC"),
    departments: rows("SELECT d.*,e.name AS manager_name FROM departments d LEFT JOIN employees e ON e.id=d.manager_id ORDER BY d.name"),
    repositories: rows("SELECT * FROM project_repositories ORDER BY name"),
    packs: rows("SELECT id,version,name,created_at FROM workflow_packs ORDER BY name,version DESC"),
    meetings: rows("SELECT m.*,CASE WHEN EXISTS (SELECT 1 FROM meeting_items i JOIN tasks t ON t.id=i.task_id WHERE i.meeting_id=m.id AND t.status IN ('failed','blocked','cancelled','unknown','rejected','needs_revision')) THEN 'blocked' WHEN NOT EXISTS (SELECT 1 FROM meeting_items i JOIN tasks t ON t.id=i.task_id WHERE i.meeting_id=m.id AND t.status NOT IN ('completed','accepted')) THEN 'completed' WHEN EXISTS (SELECT 1 FROM meeting_items i JOIN tasks t ON t.id=i.task_id WHERE i.meeting_id=m.id AND t.status IN ('running','stopping')) THEN 'running' ELSE m.status END AS derived_status FROM meetings m ORDER BY m.created_at DESC"),
    meetingItems: rows("SELECT * FROM meeting_items"),
    sharedArtifacts: rows("SELECT * FROM shared_artifacts ORDER BY created_at DESC"),
    integrations: rows("SELECT * FROM integration_reviews ORDER BY created_at DESC"),
    mailboxes: rows("SELECT * FROM agent_mailboxes ORDER BY created_at"),
    messages: rows("SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 300").map(publicMessage),
    messageEvents: rows("SELECT * FROM agent_message_events ORDER BY id DESC LIMIT 300").map((item) => ({ ...item, payload: JSON.parse(item.payload) })),
    messageAttempts: rows("SELECT * FROM agent_message_attempts ORDER BY created_at DESC LIMIT 300"),
    messageArtifacts: rows("SELECT * FROM agent_message_artifacts ORDER BY created_at DESC LIMIT 300"),
    locks: rows("SELECT * FROM agent_locks WHERE released_at IS NULL ORDER BY created_at DESC"),
  };
  return {etag,data};
}

export function taskDetails(id) {
  const task = row("SELECT t.*,p.name AS project_name,e.name AS employee_name FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN employees e ON e.id=t.employee_id WHERE t.id=?", id);
  if (!task) throw new Error("任务不存在");
  const runs = rows("SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC", id);
  return {
    task,
    runs,
    approvals: rows("SELECT * FROM approvals WHERE task_id=? ORDER BY created_at", id),
    events: rows("SELECT ev.* FROM events ev JOIN runs r ON r.id=ev.run_id WHERE r.task_id=? ORDER BY ev.id", id).map((item) => ({ ...item, payload: JSON.parse(item.payload) })),
    artifacts: rows("SELECT a.* FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.task_id=? ORDER BY a.created_at", id),
  };
}

export function registerEmployee(input) {
  const runtime = runtimes().find((item) => item.id === input.runtime && item.managed && item.available);
  const name = String(input.name ?? "").trim().slice(0, 100);
  const role = String(input.role ?? "").trim().slice(0, 100);
  const department = String(input.department ?? "").trim().slice(0, 100);
  if (!runtime || !name || !role) throw new Error("请选择已知 Runtime，并填写员工名称和岗位");
  const id = randomUUID();
  db.prepare("INSERT INTO employees(id,name,runtime,role,department,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, name, runtime.id, role, department, now(), now());
  for (const project of rows("SELECT id FROM projects")) ensureMailbox(project.id, id, /review|审查|评审/i.test(role) ? "reviewer" : "employee");
  return id;
}

export function updateEmployee(id, input) {
  const employee = row("SELECT * FROM employees WHERE id=? AND deleted_at IS NULL", id);
  if (!employee) throw new Error("员工不存在");
  const name = String(input.name ?? "").trim().slice(0, 100);
  const role = String(input.role ?? "").trim().slice(0, 100);
  const department = String(input.department ?? "").trim().slice(0, 100);
  if (!name || !role) throw new Error("请填写员工名称和岗位");
  db.prepare("UPDATE employees SET name=?,role=?,department=?,enabled=?,updated_at=? WHERE id=?").run(name, role, department, input.enabled === false ? 0 : 1, now(), id);
}

export function deleteEmployee(id) {
  const employee = row("SELECT * FROM employees WHERE id=? AND deleted_at IS NULL", id);
  if (!employee) throw new Error("员工不存在或已删除");
  if (row("SELECT id FROM departments WHERE manager_id=?", id)) throw new Error("该员工仍是部门经理，请先更换经理");
  if (row("SELECT id FROM tasks WHERE employee_id=? AND status IN ('awaiting_approval','queued','running','stopping') LIMIT 1", id)) throw new Error("该员工仍有待审批或运行中的任务，请先处理任务");
  db.prepare("UPDATE employees SET enabled=0,deleted_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
}

export function createConversation(input) {
  const project = row("SELECT id FROM projects WHERE id=?", input.projectId);
  if (!project) throw new Error("项目不存在");
  const id = randomUUID();
  const title = String(input.title ?? "").trim().slice(0, 80) || "新对话";
  db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, project.id, title, now(), now());
  return id;
}

export function renameConversation(id, input) {
  const title = String(input.title ?? "").trim().slice(0, 80);
  if (!title || !db.prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=?").run(title, now(), id).changes) throw new Error("对话不存在或标题为空");
}

function projectAtDirectory(path,exceptId){return rows('SELECT id,path FROM projects').find(p=>p.id!==exceptId&&sameProjectDirectory(p.path,path));}
export function createProject(input) {
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (!name) throw new Error("请填写项目名称");
  const path = projectDirectory(input.path,input.createDirectory===true);
  if(projectAtDirectory(path))throw new Error('该文件夹已添加为项目，请直接选择已有项目');
  const id = randomUUID();
  db.prepare("INSERT INTO projects(id,name,path,description,created_at) VALUES (?,?,?,?,?)").run(id, name, path, String(input.description ?? "").slice(0, 500), now());
  ensureMailbox(id, "apix-director", "director");
  ensureMailbox(id, "system", "system");
  for (const employee of rows("SELECT id,role FROM employees WHERE deleted_at IS NULL")) ensureMailbox(id, employee.id, /review|审查|评审/i.test(employee.role) ? "reviewer" : "employee");
  return id;
}
export function updateProject(id, input) {
  const existing = row("SELECT * FROM projects WHERE id=?", id);
  if (!existing) throw new Error("项目不存在");
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (!name) throw new Error('请填写项目名称');
  const path = projectDirectory(input.path);
  if(projectAtDirectory(path,id))throw new Error('该文件夹已添加为其他项目，请选择不同目录');
  if (!sameProjectDirectory(path,existing.path) && row("SELECT id FROM tasks WHERE project_id=? AND status IN ('awaiting_approval','queued','running','stopping','unknown') LIMIT 1", id)) throw new Error("该项目有待处理或运行中的任务，暂不能修改目录");
  db.prepare("UPDATE projects SET name=?,path=?,description=? WHERE id=?").run(name, path, String(input.description ?? "").slice(0, 500), id);
}
export function createTask(input) {
  const project = row("SELECT id,path FROM projects WHERE id=?", input.projectId);
  const employee = row("SELECT * FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL", input.employeeId);
  const runtime = employee && runtimes().find((item) => item.id === employee.runtime && item.available);
  const prompt = String(input.prompt ?? "").trim();
  if (!project || !runtime || !prompt || prompt.length > 20000) throw new Error("请选择可用员工和项目，并填写任务内容");
  const conversation = input.conversationId ? row("SELECT * FROM conversations WHERE id=? AND project_id=?", input.conversationId, project.id) : null;
  if (input.conversationId && !conversation) throw new Error("对话不属于当前项目");
  if (conversation && row("SELECT id FROM tasks WHERE conversation_id=? AND status IN ('awaiting_approval','queued','running','stopping') LIMIT 1", conversation.id)) throw new Error("当前对话还有待审批或运行中的任务，请先处理该任务");
  const resumed = input.resumesTaskId && conversation ? row("SELECT * FROM tasks WHERE id=? AND conversation_id=? AND project_id=? AND plan_id IS NULL", input.resumesTaskId, conversation.id, project.id) : null;
  if (input.resumesTaskId && (!resumed || !["failed", "cancelled", "unknown", "needs_revision"].includes(resumed.status))) throw new Error("只能从当前对话中已中断或失败的普通任务继续");
  const id = randomUUID(); const approvalId = randomUUID();
  const conversationId = conversation?.id ?? randomUUID();
  db.exec("BEGIN");
  try {
    if (!conversation) db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(conversationId, project.id, prompt.slice(0, 80), now(), now());
    else db.prepare("UPDATE conversations SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated_at=? WHERE id=?").run(prompt.slice(0, 80), now(), conversationId);
    db.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at,employee_id,conversation_id,resumes_task_id) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, project.id, runtime.id, prompt, "awaiting_approval", now(), now(), employee.id, conversationId, resumed?.id ?? null);
    db.prepare("INSERT INTO approvals(id,task_id,action,status,created_at,target_path,prompt_hash) VALUES (?,?,?,?,?,?,?)").run(approvalId, id, "start-agent-in-project", "pending", now(), project.path, createHash("sha256").update(prompt).digest("hex"));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { taskId: id, approvalId, conversationId };
}

function matchEmployee(employees, hint) {
  const text = hint.toLowerCase();
  const scored = employees.map((employee) => {
    let score = 0;
    for (const keyword of ["代码", "code", "实现", "开发"]) if (text.includes(keyword) && /开发|工程|code|implement/i.test(`${employee.role} ${employee.name}`)) score += 3;
    for (const keyword of ["测试", "test", "验证"]) if (text.includes(keyword) && /测试|test|qa/i.test(`${employee.role} ${employee.name}`)) score += 3;
    for (const keyword of ["审查", "review", "安全"]) if (text.includes(keyword) && /审查|review|安全/i.test(`${employee.role} ${employee.name}`)) score += 3;
    for (const keyword of ["文档", "研究", "报告", "research"]) if (text.includes(keyword) && /文档|研究|报告|research/i.test(`${employee.role} ${employee.name}`)) score += 3;
    if (/(审查|review|安全)/i.test(text) && /(审查|review|安全)/i.test(`${employee.role} ${employee.name}`)) score += 8;
    if (/(实现|开发|implement)/i.test(text) && /(开发|工程|developer|implement)/i.test(`${employee.role} ${employee.name}`)) score += 5;
    return { employee, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.employee;
}

function splitGoal(goal) {
  const clean = String(goal ?? "").trim();
  if (!clean) throw new Error("请输入 Director 目标");
  const parts = clean.split(/(?:\n|。|；|;)/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 4);
  return [
    `分析目标与现状：${clean}`,
    `实施主要变更：${clean}`,
    `验证结果并整理交付物：${clean}`,
  ];
}
export function createDirectorPlan(input) {
  const project = row("SELECT * FROM projects WHERE id=?", input.projectId);
  const employees = rows("SELECT * FROM employees WHERE enabled=1 AND deleted_at IS NULL").filter((employee) => runtimes().some((runtime) => runtime.id === employee.runtime && runtime.available));
  if (!project || employees.length === 0) throw new Error("请先选择项目并注册至少一个可用员工");
  const steps = splitGoal(input.goal);
  const planId = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO plans(id,project_id,goal,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(planId, project.id, String(input.goal).trim().slice(0, 20000), "planned", now(), now());
    let previous = null;
    for (const [index, step] of steps.entries()) {
      const employee = matchEmployee(employees, step) ?? employees[index % employees.length];
      const taskId = randomUUID(); const approvalId = randomUUID();
      db.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at,employee_id,plan_id) VALUES (?,?,?,?,?,?,?,?,?)").run(taskId, project.id, employee.runtime, step, "awaiting_approval", now(), now(), employee.id, planId);
      db.prepare("INSERT INTO approvals(id,task_id,action,status,created_at,target_path,prompt_hash) VALUES (?,?,?,?,?,?,?)").run(approvalId, taskId, "start-agent-in-project", "pending", now(), project.path, createHash("sha256").update(step).digest("hex"));
      if (previous) db.prepare("INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (?,?)").run(taskId, previous);
      previous = taskId;
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return planId;
}
export function plans() {
  return rows("SELECT p.*,pr.name AS project_name,(SELECT COUNT(*) FROM tasks t WHERE t.plan_id=p.id) AS task_count,CASE WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.plan_id=p.id AND t.status IN ('failed','blocked','cancelled','unknown','rejected','needs_revision')) THEN 'blocked' WHEN (SELECT COUNT(*) FROM tasks t WHERE t.plan_id=p.id AND t.status IN ('completed','accepted'))=(SELECT COUNT(*) FROM tasks t WHERE t.plan_id=p.id) THEN 'completed' WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.plan_id=p.id AND t.status IN ('running','stopping')) THEN 'running' WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.plan_id=p.id AND t.status='queued') THEN 'queued' ELSE p.status END AS derived_status FROM plans p JOIN projects pr ON pr.id=p.project_id ORDER BY p.created_at DESC");
}
export function resolveApproval(id, approved) {
  const approval = row("SELECT * FROM approvals WHERE id=?", id);
  if (!approval || approval.status !== "pending") throw new Error("审批已处理或不存在");
  const task = row("SELECT * FROM tasks WHERE id=?", approval.task_id);
  if (approved) coordinator.assertExecution(task);
  const project = row("SELECT * FROM projects WHERE id=?", task.project_id);
  const repository = task.repository_id ? row("SELECT path FROM project_repositories WHERE id=? AND project_id=?", task.repository_id, task.project_id) : null;
  if (approved && (approval.target_path !== (repository?.path ?? project?.path) || approval.prompt_hash !== createHash("sha256").update(task.prompt).digest("hex"))) throw new Error("任务内容或项目目录已变化，请重新创建任务并审批");
  db.prepare("UPDATE approvals SET status=?,resolved_at=? WHERE id=?").run(approved ? "approved" : "rejected", now(), id);
  if (!approved) { db.prepare("UPDATE tasks SET status='rejected',updated_at=? WHERE id=?").run(now(), task.id); scheduleDependents(task.id); return null; }
  const dependencies = rows("SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?", task.id);
  if (dependencies.some((dependency) => ["failed", "cancelled", "blocked", "unknown", "rejected", "needs_revision"].includes(dependency.status))) {
    db.prepare("UPDATE tasks SET status='blocked',updated_at=? WHERE id=?").run(now(), task.id);
    return null;
  }
  const requiresAcceptance = ['collaboration','coordinator'].includes(row("SELECT mode FROM plans WHERE id=?", task.plan_id)?.mode) || !!row("SELECT id FROM meeting_items WHERE task_id=?", task.id);
  if (!dependencies.every((dependency) => requiresAcceptance ? dependency.status === "accepted" : ["completed", "accepted"].includes(dependency.status))) {
    db.prepare("UPDATE tasks SET status='queued',queue_reason='等待前置任务验收',updated_at=? WHERE id=?").run(now(), task.id);
    return null;
  }
  const queueReason=admission(task);
  if(queueReason){db.prepare("UPDATE tasks SET status='queued',queue_reason=?,updated_at=? WHERE id=?").run(queueReason,now(),task.id);return null;}
  try { return launch(task); }
  catch (error) {
    db.prepare("UPDATE tasks SET status=?,result=?,updated_at=? WHERE id=?").run(['HANDOFF_CONFLICT','WORKER_CREDENTIAL_CONFLICT'].includes(error.code)?'blocked':'failed',error.message, now(), task.id);
    coordinator.recordTask(task.id, "task.launch_failed", { error: error.message });
    scheduleDependents(task.id);
    throw error;
  }
}
export function stopRun(id) {
  const active = running.get(id);
  if (!active) throw new Error("此 Run 已不受当前服务管理，无法确认停止");
  if (active.stopped) return;
  active.stopped = true;
  db.prepare("UPDATE runs SET status='stopping',status_source='apix-request',stop_requested_at=? WHERE id=?").run(now(), id);
  db.prepare("UPDATE tasks SET status='stopping',updated_at=? WHERE id=(SELECT task_id FROM runs WHERE id=?)").run(now(), id);
  event(id, "apix", "stop_requested");
  if (active.runtime === "pi" && active.child.stdin.writable) active.child.stdin.write(JSON.stringify({ id: randomUUID(), type: "abort" }) + "\n");
  else active.child.kill();
  setTimeout(() => { if (running.has(id)) active.child.kill(); }, 3000).unref();
}
export function acceptTask(id, accepted, fingerprint, source='user') {
  const task = row("SELECT * FROM tasks WHERE id=?", id);
  if (!task || task.status !== "completed") throw new Error("只有已完成的任务可以验收");
  if(accepted && task.plan_id)codeHandoffs.freeze(task,fingerprint);
  db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=?").run(accepted ? "accepted" : "needs_revision", now(), id);
  const run = row("SELECT id FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1", id);
  if (run) event(run.id, source, "task_reviewed", { accepted, ...(source==='apix'?{type:'autonomous_quality',reviewMode:'apix_self_review'}:{}) });
  scheduleDependents(id);
}

export function resumeTask(id, input) {
  const previous = row("SELECT * FROM tasks WHERE id=? AND plan_id IS NULL AND conversation_id IS NOT NULL", id);
  if (!previous || !["failed", "cancelled", "unknown", "needs_revision"].includes(previous.status)) throw new Error("只有中断或失败的普通对话任务可继续");
  const instruction = String(input.instruction ?? "").trim().slice(0, 4000);
  const prompt = `继续上次未完成的目标：${previous.prompt}\n补充要求：${instruction || "核对已有结果和项目当前状态后继续；不要假设上次操作未执行。"}`;
  return createTask({ projectId: previous.project_id, conversationId: previous.conversation_id, employeeId: input.employeeId ?? previous.employee_id, prompt, resumesTaskId: previous.id });
}

export function saveProjectProfile(projectId, input) {
  if (!row("SELECT id FROM projects WHERE id=?", projectId)) throw new Error("项目不存在");
  const existing = row("SELECT version FROM project_profiles WHERE project_id=?", projectId);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== (existing?.version ?? 0)) throw new Error("项目档案已变化，请刷新后再保存");
  const fields = ["summary", "goals", "constraints", "decisions"].map((key) => String(input[key] ?? "").trim().slice(0, 5000));
  const version = expectedVersion + 1;
  db.prepare("INSERT INTO project_profiles(project_id,summary,goals,constraints,decisions,version,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET summary=excluded.summary,goals=excluded.goals,constraints=excluded.constraints,decisions=excluded.decisions,version=excluded.version,updated_at=excluded.updated_at").run(projectId, ...fields, version, now());
  return { version };
}

export function createMemory(input) {
  const project = row("SELECT id FROM projects WHERE id=?", input.projectId);
  const scope = input.scope;
  const task = scope === "task" ? row("SELECT id FROM tasks WHERE id=? AND project_id=?", input.taskId, input.projectId) : null;
  const category = String(input.category ?? "").trim().slice(0, 50);
  const title = String(input.title ?? "").trim().slice(0, 120);
  const content = String(input.content ?? "").trim().slice(0, 10000);
  if (!project || !["task", "project"].includes(scope) || (scope === "task" && !task) || !category || !title || !content) throw new Error("请填写有效的项目、范围、类别、标题和内容");
  if (row("SELECT id FROM memories WHERE project_id=? AND scope=? AND category=? AND title=?", project.id, scope, category, title)) throw new Error("同范围已有同名记忆，请编辑现有记录");
  const id = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO memories(id,project_id,task_id,scope,category,title,content,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, project.id, task?.id ?? null, scope, category, title, content, "user", now(), now());
    db.prepare("INSERT INTO memory_revisions(memory_id,version,title,content,created_at) VALUES (?,?,?,?,?)").run(id, 1, title, content, now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return id;
}

export function updateMemory(id, input) {
  const existing = row("SELECT * FROM memories WHERE id=?", id);
  const title = String(input.title ?? "").trim().slice(0, 120);
  const content = String(input.content ?? "").trim().slice(0, 10000);
  if (!existing || Number(input.version) !== existing.version || !title || !content) throw new Error("记忆不存在、版本已变化或内容为空");
  if (row("SELECT id FROM memories WHERE project_id=? AND scope=? AND category=? AND title=? AND id<>?", existing.project_id, existing.scope, existing.category, title, id)) throw new Error("同范围已有同名记忆，请更换标题或编辑现有记录");
  const version = existing.version + 1;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE memories SET title=?,content=?,version=?,updated_at=? WHERE id=?").run(title, content, version, now(), id);
    db.prepare("INSERT INTO memory_revisions(memory_id,version,title,content,created_at) VALUES (?,?,?,?,?)").run(id, version, title, content, now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { version };
}

export function deleteMemory(id, input) {
  const existing = row("SELECT version FROM memories WHERE id=?", id);
  if (!existing || Number(input.version) !== existing.version) throw new Error("记忆不存在或版本已变化，请刷新后再删除");
  db.prepare("DELETE FROM memories WHERE id=?").run(id);
}

export function searchMemories(projectId, query) {
  if (!row("SELECT id FROM projects WHERE id=?", projectId)) throw new Error("项目不存在");
  const term = String(query ?? "").trim().slice(0, 100);
  if (!term) return [];
  if ([...term].length < 3) return rows("SELECT * FROM memories WHERE project_id=? AND (instr(lower(title),lower(?))>0 OR instr(lower(content),lower(?))>0) ORDER BY updated_at DESC LIMIT 50", projectId, term, term);
  return rows("SELECT m.* FROM memory_fts f JOIN memories m ON m.rowid=f.rowid WHERE memory_fts MATCH ? AND m.project_id=? ORDER BY bm25(memory_fts),m.updated_at DESC LIMIT 50", `"${term.replaceAll('"', '""')}"`, projectId);
}

export function createDepartment(input) {
  const name = String(input.name ?? "").trim().slice(0, 100);
  const manager = row("SELECT id FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL", input.managerId);
  if (!name || !manager) throw new Error("请填写部门名称并选择启用的经理员工");
  const id = randomUUID();
  db.prepare("INSERT INTO departments(id,name,manager_id,created_at) VALUES (?,?,?,?)").run(id, name, manager.id, now());
  return id;
}

export function updateDepartment(id, input) {
  const name = String(input.name ?? "").trim().slice(0, 100);
  const manager = row("SELECT id FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL", input.managerId);
  if (!name || !manager || !db.prepare("UPDATE departments SET name=?,manager_id=? WHERE id=?").run(name, manager.id, id).changes) throw new Error("部门不存在，或名称和经理无效");
}

export function addRepository(input) {
  const project = row("SELECT * FROM projects WHERE id=?", input.projectId);
  const path = resolve(String(input.path ?? "").trim());
  const name = String(input.name ?? "").trim().slice(0, 100);
  const root = gitRoot(path);
  const sameRoot = root && existsSync(path) && realpathSync.native(root).toLowerCase() === realpathSync.native(path).toLowerCase();
  if (!project || !name || !input.path || !sameRoot) throw new Error(`请选择项目及独立的 Git 仓库根目录（所选：${path}；检测到：${root ?? "无"}）`);
  const id = randomUUID();
  db.prepare("INSERT INTO project_repositories(id,project_id,name,path) VALUES (?,?,?,?)").run(id, project.id, name, path);
  return id;
}

export function saveWorkflowPack(input) {
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim().slice(0, 100);
  const steps = input.steps;
  if (!/^[a-z0-9-]{2,60}$/.test(id) || !name || !Array.isArray(steps) || steps.length < 2 || steps.length > 12) throw new Error("Pack 需要标识、名称及 2 至 12 个步骤");
  for (const [index, step] of steps.entries()) {
    if (!String(step.prompt ?? "").trim() || !Array.isArray(step.dependsOn) || step.dependsOn.some((value) => !Number.isInteger(value) || value < 0 || value >= index)) throw new Error(`Pack 步骤 ${index + 1} 无效或依赖不在前序步骤中`);
  }
  const version = (row("SELECT MAX(version) AS version FROM workflow_packs WHERE id=?", id)?.version ?? 0) + 1;
  db.prepare("INSERT INTO workflow_packs(id,version,name,definition,created_at) VALUES (?,?,?,?,?)").run(id, version, name, JSON.stringify({ steps }), now());
  return { id, version };
}

export function workflowPack(id, version) {
  const pack = version ? row("SELECT * FROM workflow_packs WHERE id=? AND version=?", id, version) : row("SELECT * FROM workflow_packs WHERE id=? ORDER BY version DESC LIMIT 1", id);
  if (!pack) throw new Error("Workflow Pack 不存在");
  return { ...pack, definition: JSON.parse(pack.definition) };
}

export function createCollaborativePlan(input) {
  const project = row("SELECT * FROM projects WHERE id=?", input.projectId);
  const goal = String(input.goal ?? "").trim().slice(0, 20000);
  const pack = input.packId ? workflowPack(input.packId, input.packVersion) : null;
  const steps = pack ? pack.definition.steps.map((step, index) => ({ ...step, employeeId: input.steps?.[index]?.employeeId, repositoryId: input.steps?.[index]?.repositoryId, departmentId: input.steps?.[index]?.departmentId })) : input.steps;
  if (!project || !goal || !Array.isArray(steps) || steps.length < 2 || steps.length > 12) throw new Error("请选择项目、目标及 2 至 12 个协作步骤");
  const prepared = steps.map((step, index) => {
    const employee = row("SELECT * FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL", step.employeeId);
    const repository = step.repositoryId ? row("SELECT * FROM project_repositories WHERE id=? AND project_id=?", step.repositoryId, project.id) : null;
    const department = step.departmentId ? row("SELECT * FROM departments WHERE id=?", step.departmentId) : null;
    const prompt = String(step.prompt ?? "").replaceAll("{goal}", goal).trim();
    if (!employee || !runtimes().some((runtime) => runtime.id === employee.runtime && runtime.available) || !prompt || prompt.length > 20000 || (step.repositoryId && !repository) || (step.departmentId && (!department || (employee.department !== department.name && employee.id !== department.manager_id))) || !Array.isArray(step.dependsOn) || step.dependsOn.some((value) => !Number.isInteger(value) || value < 0 || value >= index)) throw new Error(`协作步骤 ${index + 1} 的员工、仓库、部门或依赖无效`);
    return { employee, repository, department, prompt, dependsOn: [...new Set(step.dependsOn)] };
  });
  const planId = randomUUID();
  const taskIds = prepared.map(() => randomUUID());
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO plans(id,project_id,goal,status,created_at,updated_at,pack_id,pack_version,mode) VALUES (?,?,?,?,?,?,?,?,?)").run(planId, project.id, goal, "planned", now(), now(), pack?.id ?? null, pack?.version ?? null, "collaboration");
    for (const [index, step] of prepared.entries()) {
      const taskId = taskIds[index];
      db.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at,employee_id,plan_id,repository_id,department_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(taskId, project.id, step.employee.runtime, step.prompt, "awaiting_approval", now(), now(), step.employee.id, planId, step.repository?.id ?? null, step.department?.id ?? null);
      db.prepare("INSERT INTO approvals(id,task_id,action,status,created_at,target_path,prompt_hash) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), taskId, "start-agent-in-project", "pending", now(), step.repository?.path ?? project.path, createHash("sha256").update(step.prompt).digest("hex"));
      for (const dependency of step.dependsOn) db.prepare("INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (?,?)").run(taskId, taskIds[dependency]);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { id: planId, taskIds };
}

function directorPrompt(project, history, employees, progress, message) {
  return `APIX_DIRECTOR_JSON\n你是 ApiX 主 Agent（Director）。只负责理解用户、整理需求、设计可修改的多 Agent 提案，不运行工具，也不声称任务已经完成。只返回一个 JSON 对象，不要 Markdown。格式：{"reply":"给用户的简短中文答复","goal":"可检查的目标","steps":[{"prompt":"具体任务","employeeId":"可用员工 ID 或空字符串","dependsOn":[前序步骤的零基索引]}],"memoryCandidates":[{"category":"需求或决策","title":"短标题","content":"整理后的事实","evidence":"用户原话中的准确片段"}]}。需要新计划时 steps 为 2 至 8 项；仅回答问题、解释进度或澄清时 steps=[]，不要重复创建计划。无依赖步骤可以并行。未确定的内容在 reply 中提出，不能擅自启动任务。记忆候选必须有可在用户原话中逐字找到的 evidence，不要编造。对于正在执行的计划，先根据下列真实状态向用户说明进展；如需调整，只提新草案，不声称已改变运行中任务。\n项目：${project.name}\n项目描述：${project.description}\n可用员工：${JSON.stringify(employees.map((item) => ({ id: item.id, name: item.name, role: item.role, department: item.department })))}\n当前计划与任务状态：${JSON.stringify(progress)}\n最近对话：${JSON.stringify(history.map((item) => ({ role: item.role, content: item.content.slice(0, 1500) })))}\n用户最新消息：${message}`;
}

function managerApiKeys(){
  const settings=[row('SELECT provider,base_url AS baseUrl,api_key_env AS apiKeyEnv FROM apix_manager_settings WHERE id=1')];
  if(row("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_models'"))settings.push(...rows('SELECT settings FROM conversation_models').map(r=>JSON.parse(r.settings)));
  return [...new Set(settings.filter(Boolean).map(s=>s.apiKeyEnv||(!s.baseUrl?getProviderConfig(s.provider)?.defaultApiKeyEnv:'')).filter(Boolean))];
}

async function inferManager(prompt,onDelta,context) {
  if(context&&!row('SELECT id FROM projects WHERE id=?',context.projectId))throw new Error('推理项目不存在');
  const controller=new AbortController(),version=context?permissions.get(context.projectId).version:null;
  let revoked=false;const abort=()=>controller.abort();context?.signal?.addEventListener('abort',abort,{once:true});if(context?.signal?.aborted)abort();
  const watch=context?setInterval(()=>{if(permissions.get(context.projectId).version!==version){revoked=true;controller.abort();}},200):null;
  try{return await inferModel(context?.modelSettings??(context?.sessionId?conversationModels.get('coordination',context.sessionId).settings:coordinator.getSettings()),prompt,onDelta,{signal:controller.signal});}
  catch(error){throw managerInferenceError(error,revoked);}
  finally{if(watch)clearInterval(watch);context?.signal?.removeEventListener('abort',abort);}
}

// Pi RPC belongs only to an explicitly selected execution employee.
async function askPiEmployee(prompt,consultation) {
  const command=commandFor('pi');if(!command)throw new Error('Pi 员工未安装或不可用，请检查 APIX_PI_ENTRY 或 Pi CLI 安装');
  return await new Promise((resolve,reject)=>{
    const env=piShellEnvironment(workerEnvironment(process.env,'pi',managerApiKeys()));
    const child=spawn(command.executable,[...command.prefix,'--mode','rpc','--no-session','--no-extensions','--no-tools','--no-skills','--no-prompt-templates','--no-context-files',...(consultation.model?['--model',consultation.model]:[])],{cwd:consultation.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let raw='',answer='',stderr='',settled=false,failed=false,finished=false;const decoder=new TextDecoder();
    child.stderr.setEncoding('utf8');
    const timer=setTimeout(()=>{failed=true;child.kill();},90000);
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(answer.trim());};
    child.stdout.on('data',chunk=>{raw+=decoder.decode(chunk,{stream:true});if(raw.length>100000){failed=true;child.kill();return;}let i;while((i=raw.indexOf('\n'))>=0){const line=raw.slice(0,i);raw=raw.slice(i+1);try{const event=JSON.parse(line);if(event.type==='message_end'&&event.message?.role==='assistant'){answer=textFromMessage(event.message);failed||=['error','aborted'].includes(event.message.stopReason);}if(['agent_end','agent_settled'].includes(event.type)){settled=true;child.stdin.end();}}catch{}}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-3000);});child.on('error',()=>finish(new Error('Pi 员工进程无法启动')));child.on('close',code=>finish(code===0&&settled&&answer.trim()&&!failed?null:new Error(quotaFailure(stderr)?'Pi 员工额度不足 (insufficient_quota)':'Pi 员工未返回可用答复')));
    child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({id:randomUUID(),type:'prompt',message:prompt})+'\n');
  });
}

function normalizeDirectorSteps(rawSteps, goal, employees) {
  const candidate = Array.isArray(rawSteps) && rawSteps.length >= 2 && rawSteps.length <= 8 ? rawSteps : splitGoal(goal).map((prompt, index) => ({ prompt, dependsOn: index ? [index - 1] : [] }));
  return candidate.map((item, index) => {
    const prompt = String(item.prompt ?? "").trim().slice(0, 20000) || `完成目标的第 ${index + 1} 步：${goal}`;
    const chosen = employees.find((employee) => employee.id === item.employeeId) ?? matchEmployee(employees, prompt);
    return { prompt, employeeId: chosen?.id ?? null, dependsOn: Array.isArray(item.dependsOn) ? [...new Set(item.dependsOn.filter((value) => Number.isInteger(value) && value >= 0 && value < index))] : [] };
  });
}

export async function sendDirectorMessage(input) {
  const project = row("SELECT * FROM projects WHERE id=?", input.projectId);
  const content = String(input.content ?? "").trim();
  if (!project || !content || content.length > 10000) throw new Error("请选择项目并输入不超过一万字的消息");
  let thread = row("SELECT * FROM director_threads WHERE project_id=? ORDER BY updated_at DESC LIMIT 1", project.id);
  if (!thread) {
    const id = randomUUID();
    db.prepare("INSERT INTO director_threads(id,project_id,created_at,updated_at) VALUES (?,?,?,?)").run(id, project.id, now(), now());
    thread = row("SELECT * FROM director_threads WHERE id=?", id);
  }
  if (row("SELECT id FROM director_messages WHERE thread_id=? AND status='processing'", thread.id)) throw new Error("ApiX 正在整理上一条消息，请稍候");
  const history = rows("SELECT role,content FROM director_messages WHERE thread_id=? AND status='complete' ORDER BY created_at DESC,id DESC LIMIT 10", thread.id).reverse();
  const employees = rows("SELECT * FROM employees WHERE enabled=1 AND deleted_at IS NULL").filter((employee) => runtimes().some((runtime) => runtime.id === employee.runtime && runtime.available && runtime.managed));
  const progress = rows("SELECT p.id,p.goal,t.prompt,t.status,e.name AS employee FROM plans p JOIN tasks t ON t.plan_id=p.id LEFT JOIN employees e ON e.id=t.employee_id WHERE p.project_id=? ORDER BY p.created_at DESC,t.created_at LIMIT 24", project.id).map((item) => ({ ...item, prompt: item.prompt.slice(0, 250) }));
  const userMessageId = randomUUID(); const assistantMessageId = randomUUID();
  db.prepare("INSERT INTO director_messages(id,thread_id,role,content,created_at) VALUES (?,?,?,?,?)").run(userMessageId, thread.id, "user", content, now());
  db.prepare("INSERT INTO director_messages(id,thread_id,role,content,status,created_at) VALUES (?,?,?,?,?,?)").run(assistantMessageId, thread.id, "assistant", "ApiX 正在整理需求与计划…", "processing", now());
  db.prepare("UPDATE director_threads SET updated_at=? WHERE id=?").run(now(), thread.id);
  let result;
  let fallbackReason = "";
  try {
    const raw = await inferManager(directorPrompt(project, history, employees, progress, content));
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (!parsed || typeof parsed !== "object") throw new Error("答复格式无效");
    result = parsed;
  } catch (error) {
    fallbackReason = String(error.message).slice(0, 180);
    result = { reply: `模型未返回可用的结构化规划（${fallbackReason}）。ApiX 已按规则生成可编辑草案，请先审查。`, goal: content, steps: [] };
  }
  const goal = String(result.goal ?? content).trim().slice(0, 20000) || content;
  const steps = Array.isArray(result.steps) && result.steps.length === 0 && !fallbackReason ? [] : normalizeDirectorSteps(result.steps, goal, employees);
  const reply = String(result.reply ?? "已整理目标和可编辑的执行提案，请检查后决定是否创建计划。").trim().slice(0, 4000);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE director_messages SET content=?,status='complete' WHERE id=?").run(reply, assistantMessageId);
    const proposalId = steps.length ? randomUUID() : null;
    if (proposalId) db.prepare("INSERT INTO director_proposals(id,thread_id,source_message_id,goal,steps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(proposalId, thread.id, assistantMessageId, goal, JSON.stringify(steps), now(), now());
    for (const candidate of Array.isArray(result.memoryCandidates) ? result.memoryCandidates.slice(0, 4) : []) {
      const evidence = String(candidate.evidence ?? "").trim();
      const category = String(candidate.category ?? "需求").trim().slice(0, 50);
      const title = String(candidate.title ?? "").trim().slice(0, 120);
      const memoryContent = String(candidate.content ?? "").trim().slice(0, 10000);
      if (!evidence || !content.includes(evidence) || !category || !title || !memoryContent || row("SELECT id FROM memories WHERE project_id=? AND scope='project' AND category=? AND title=?", project.id, category, title)) continue;
      const memoryId = randomUUID();
      db.prepare("INSERT INTO memories(id,project_id,scope,category,title,content,source,source_message_id,created_at,updated_at) VALUES (?,?,'project',?,?,?,'director',?,?,?)").run(memoryId, project.id, category, title, memoryContent, userMessageId, now(), now());
      db.prepare("INSERT INTO memory_revisions(memory_id,version,title,content,created_at) VALUES (?,?,?,?,?)").run(memoryId, 1, title, memoryContent, now());
    }
    db.exec("COMMIT");
    return { threadId: thread.id, proposalId, mode: fallbackReason ? "rules" : "pi" };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function checkedProposal(id, input) {
  const proposal = row("SELECT p.*,t.project_id FROM director_proposals p JOIN director_threads t ON t.id=p.thread_id WHERE p.id=?", id);
  if (!proposal || proposal.status !== "draft" || proposal.version !== Number(input.version)) throw new Error("提案已变化，请刷新后再操作");
  const goal = String(input.goal ?? "").trim().slice(0, 20000);
  if (!goal || !Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 12) throw new Error("目标或步骤无效");
  const steps = input.steps.map((step, index) => ({ prompt: String(step.prompt ?? "").trim(), employeeId: step.employeeId, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [] }));
  if (steps.some((step, index) => !step.prompt || step.prompt.length > 20000 || !Array.isArray(step.dependsOn) || step.dependsOn.some((value) => !Number.isInteger(value) || value < 0 || value >= index))) throw new Error("步骤、依赖或任务内容无效");
  return { proposal, goal, steps };
}

export function saveDirectorProposal(id, input) {
  const { proposal, goal, steps } = checkedProposal(id, input);
  const version = proposal.version + 1;
  db.prepare("UPDATE director_proposals SET goal=?,steps_json=?,version=?,updated_at=? WHERE id=?").run(goal, JSON.stringify(steps), version, now(), id);
  return { version };
}

export function approveDirectorProposal(id, input) {
  const { proposal, goal, steps } = checkedProposal(id, input);
  const created = createCollaborativePlan({ projectId: proposal.project_id, goal, steps });
  db.prepare("UPDATE director_proposals SET goal=?,steps_json=?,status='approved',plan_id=?,version=version+1,updated_at=? WHERE id=?").run(goal, JSON.stringify(steps), created.id, now(), id);
  return { planId: created.id, taskIds: created.taskIds };
}

export function revisePendingPlanTask(id, input) {
  const task = row("SELECT * FROM tasks WHERE id=? AND plan_id IS NOT NULL AND status IN ('awaiting_approval','queued')", id);
  const employee = row("SELECT * FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL", input.employeeId);
  const prompt = String(input.prompt ?? "").trim();
  if (!task || !employee || !runtimes().some((runtime) => runtime.id === employee.runtime && runtime.available && runtime.managed) || !prompt || prompt.length > 20000) throw new Error("只能修改尚未运行的计划步骤，并指派可用员工");
  const approval = row("SELECT * FROM approvals WHERE task_id=? ORDER BY created_at DESC LIMIT 1", id);
  if (!approval || !["pending", "approved"].includes(approval.status)) throw new Error("步骤的启动审批已不可修改");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE tasks SET employee_id=?,runtime=?,prompt=?,status='awaiting_approval',updated_at=? WHERE id=?").run(employee.id, employee.runtime, prompt, now(), id);
    db.prepare("UPDATE approvals SET status='pending',resolved_at=NULL,prompt_hash=? WHERE id=?").run(createHash("sha256").update(prompt).digest("hex"), approval.id);
    db.prepare("UPDATE plans SET updated_at=? WHERE id=?").run(now(), task.plan_id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { updated: true };
}

export function approveDirectorPlan(id, input) {
  const plan = row("SELECT * FROM plans WHERE id=? AND mode='collaboration'", id);
  if (!plan || plan.updated_at !== input.version) throw new Error("计划已变化，请刷新后重新审查");
  const tasks = rows("SELECT t.*,a.id AS approval_id,a.status AS approval_status,a.target_path,a.prompt_hash,p.path AS project_path,r.path AS repository_path FROM tasks t JOIN approvals a ON a.task_id=t.id JOIN projects p ON p.id=t.project_id LEFT JOIN project_repositories r ON r.id=t.repository_id WHERE t.plan_id=? AND t.kind='work' ORDER BY t.created_at,t.id", id);
  if (!tasks.length || tasks.some((task) => task.status !== "awaiting_approval" || task.approval_status !== "pending" || task.target_path !== (task.repository_path ?? task.project_path) || task.prompt_hash !== createHash("sha256").update(task.prompt).digest("hex"))) throw new Error("计划包含已处理或已变化的步骤，请逐项审查");
  const failed = [];
  for (const task of tasks) {
    try { resolveApproval(task.approval_id, true); }
    catch (error) { failed.push({ taskId: task.id, error: error.message }); }
  }
  return { approved: tasks.length - failed.length, failed };
}

export function cancelPendingDirectorPlan(id) {
  if (!row("SELECT id FROM director_proposals WHERE plan_id=?", id)) throw new Error("这不是 ApiX 主对话创建的计划");
  const pending = rows("SELECT id FROM tasks WHERE plan_id=? AND kind='work' AND status IN ('awaiting_approval','queued','blocked')", id);
  if (!pending.length) throw new Error("计划没有可取消的未启动步骤");
  db.exec("BEGIN");
  try {
    for (const task of pending) {
      db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE id=?").run(now(), task.id);
      db.prepare("UPDATE approvals SET status='revoked',resolved_at=? WHERE task_id=? AND status IN ('pending','approved')").run(now(), task.id);
    }
    db.prepare("UPDATE plans SET updated_at=? WHERE id=?").run(now(), id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { cancelled: pending.length };
}

export function createReviewMeeting(input) {
  const plan = row("SELECT * FROM plans WHERE id=?", input.planId);
  const source = row("SELECT * FROM tasks WHERE id=? AND plan_id=?", input.sourceTaskId, input.planId);
  const reviewers = Array.isArray(input.reviewerIds) ? [...new Set(input.reviewerIds)] : [];
  const topic = String(input.topic ?? "").trim().slice(0, 500);
  if (!plan || !source || !topic || reviewers.length < 2 || reviewers.length > 6) throw new Error("会议需要计划、来源任务、主题和至少两位评审员工");
  const employees = reviewers.map((id) => row("SELECT * FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL", id));
  if (employees.some((employee) => !employee || !runtimes().some((runtime) => runtime.id === employee.runtime && runtime.available))) throw new Error("评审员工不可用");
  const id = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO meetings(id,plan_id,topic,status,created_at) VALUES (?,?,?,?,?)").run(id, plan.id, topic, "planned", now());
    for (const employee of employees) {
      const taskId = randomUUID();
      const prompt = `独立评审议题：${topic}\n来源任务：${source.prompt}\n请给出明确结论、风险与测试建议。`;
      db.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at,employee_id,plan_id,repository_id,department_id,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(taskId, source.project_id, employee.runtime, prompt, "awaiting_approval", now(), now(), employee.id, plan.id, source.repository_id, source.department_id, "meeting_review");
      db.prepare("INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (?,?)").run(taskId, source.id);
      db.prepare("INSERT INTO approvals(id,task_id,action,status,created_at,target_path,prompt_hash) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), taskId, "start-agent-in-project", "pending", now(), source.repository_id ? row("SELECT path FROM project_repositories WHERE id=?", source.repository_id).path : row("SELECT path FROM projects WHERE id=?", source.project_id).path, createHash("sha256").update(prompt).digest("hex"));
      db.prepare("INSERT INTO meeting_items(id,meeting_id,task_id) VALUES (?,?,?)").run(randomUUID(), id, taskId);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return id;
}

export function createManagerReview(input) {
  const plan = row("SELECT * FROM plans WHERE id=?", input.planId);
  const department = row("SELECT d.*,e.runtime,e.enabled FROM departments d JOIN employees e ON e.id=d.manager_id WHERE d.id=? AND e.deleted_at IS NULL", input.departmentId);
  if (!plan || !department || !department.enabled || !runtimes().some((runtime) => runtime.id === department.runtime && runtime.available)) throw new Error("计划或部门经理不可用");
  const tasks = rows("SELECT id,prompt FROM tasks WHERE plan_id=? AND department_id=? AND kind='work'", plan.id, department.id);
  if (!tasks.length) throw new Error("该计划没有部门任务");
  const project = row("SELECT * FROM projects WHERE id=?", plan.project_id);
  const prompt = `作为${department.name}经理，审查以下部门交付物，明确通过条件、风险和待办：\n${tasks.map((task) => `- ${task.prompt}`).join("\n")}`;
  const taskId = randomUUID(); const approvalId = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO tasks(id,project_id,runtime,prompt,status,created_at,updated_at,employee_id,plan_id,department_id,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(taskId, plan.project_id, department.runtime, prompt, "awaiting_approval", now(), now(), department.manager_id, plan.id, department.id, "manager_review");
    for (const task of tasks) db.prepare("INSERT INTO task_dependencies(task_id,depends_on_id) VALUES (?,?)").run(taskId, task.id);
    db.prepare("INSERT INTO approvals(id,task_id,action,status,created_at,target_path,prompt_hash) VALUES (?,?,?,?,?,?,?)").run(approvalId, taskId, "start-agent-in-project", "pending", now(), project.path, createHash("sha256").update(prompt).digest("hex"));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { taskId, approvalId };
}

export function prepareIntegration(input) {
  const plan = row("SELECT * FROM plans WHERE id=?", input.planId);
  if (!plan) throw new Error("计划不存在");
  const project = row("SELECT * FROM projects WHERE id=?", plan.project_id);
  const repository = input.repositoryId ? row("SELECT * FROM project_repositories WHERE id=? AND project_id=?", input.repositoryId, project.id) : null;
  if (input.repositoryId && !repository) throw new Error("仓库不属于该项目");
  const sourcePath = repository?.path ?? project.path;
  const root = projectBaseline(sourcePath,plan.id,dataDir,{create:false});
  const tasks = rows("SELECT t.*,w.base_sha FROM tasks t LEFT JOIN workspaces w ON w.task_id=t.id WHERE t.plan_id=? AND t.repository_id IS ? ORDER BY t.created_at", plan.id, repository?.id ?? null);
  if (!tasks.length || tasks.some((task) => task.status !== "accepted" || !task.workspace_path || !task.base_sha)) throw new Error("该仓库中的所有计划任务必须先运行并验收");
  const baseSha = tasks[0].base_sha;
  if (tasks.some((task) => task.base_sha !== baseSha)) throw new Error("任务工作区的基线不一致，请人工处理");
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== baseSha) throw new Error("源仓库 HEAD 已变化，请人工处理");
  const id = randomUUID();
  const integrationPath = join(dataDir, "integrations", id);
  mkdirSync(dirname(integrationPath), { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", integrationPath, baseSha], { cwd: root, encoding: "utf8", timeout: 20000 });
  const sourceRoot=gitRoot(sourcePath);
  const report = { taskIds: tasks.map((task) => task.id), applied: [], conflicts: [], changedFiles: [], sourcePath, sourceKind: sourceRoot && realpathSync.native(sourceRoot)===realpathSync.native(root)?'git':'snapshot' };
  for (const task of tasks) {
    const untracked = task.delivery_commit ? '' : execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: task.workspace_path, encoding: "utf8" }).trim();
    if (untracked) { report.conflicts.push({ taskId: task.id, reason: `未跟踪文件：${untracked.slice(0, 500)}` }); continue; }
    const patch = task.delivery_commit ? codeHandoffs.patch(task) : execFileSync("git", ["diff", "--binary", baseSha], { cwd: task.workspace_path, encoding: "utf8", maxBuffer: 10_000_000 });
    if (!patch) continue;
    const changed = execFileSync("git", ["diff", "--name-only", task.input_commit ?? baseSha,task.delivery_commit ?? '--'], { cwd: task.workspace_path, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    try {
      execFileSync("git", ["apply", "--check", "-"], { cwd: integrationPath, input: patch, encoding: "utf8" });
      execFileSync("git", ["apply", "-"], { cwd: integrationPath, input: patch, encoding: "utf8" });
      report.applied.push(task.id);
      report.changedFiles.push(...changed);
    } catch (error) { report.conflicts.push({ taskId: task.id, reason: String(error.stderr || error.message).slice(0, 1000) }); }
  }
  report.changedFiles = [...new Set(report.changedFiles)];
  const status = report.conflicts.length ? "conflict" : report.changedFiles.length ? "ready" : "no_changes";
  report.patchDigest=createHash('sha256').update(execFileSync('git',['diff','--binary',baseSha],{cwd:integrationPath,encoding:'utf8',maxBuffer:10000000})).digest('hex');
  db.prepare("INSERT INTO integration_reviews(id,plan_id,repository_path,status,report,workspace_path,created_at,updated_at,base_sha) VALUES (?,?,?,?,?,?,?,?,?)").run(id, plan.id, root, status, JSON.stringify(report), integrationPath, now(), now(), baseSha);
  return { id, status, report, workspacePath: integrationPath };
}

export function applyIntegration(id) {
  const review = row("SELECT * FROM integration_reviews WHERE id=?", id);
  if (!review || review.status !== "ready") throw new Error("只有无冲突的集成结果可以批准应用");
  if(JSON.parse(review.report).sourceKind==='snapshot')throw new Error('非 Git 项目的成果保存在集成工作区，请检查后导出；不能将变更应用到托管输入基线');
  const plan = row('SELECT project_id FROM plans WHERE id=?', review.plan_id);
  if (plan && permissions.get(plan.project_id).mode === 'read_only') throw new Error('只读模式不能应用集成变更');
  if (!existsSync(review.workspace_path)) throw new Error("集成工作区已不存在");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: review.repository_path, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: review.repository_path, encoding: "utf8" }).trim();
  if (head !== review.base_sha || dirty) throw new Error("源仓库已变化或工作区不干净，请重新审查");
  const patch = execFileSync("git", ["diff", "--binary", review.base_sha], { cwd: review.workspace_path, encoding: "utf8", maxBuffer: 10_000_000 });
  if(JSON.parse(review.report).patchDigest!==createHash('sha256').update(patch).digest('hex'))throw new Error('集成内容已变化，请重新审查');
  if (!patch) throw new Error("集成工作区已无差异");
  execFileSync("git", ["apply", "--check", "-"], { cwd: review.repository_path, input: patch, encoding: "utf8" });
  execFileSync("git", ["apply", "-"], { cwd: review.repository_path, input: patch, encoding: "utf8" });
  db.prepare("UPDATE integration_reviews SET status='applied',updated_at=? WHERE id=?").run(now(), id);
  return { applied: true, repositoryPath: review.repository_path };
}
export function closeStore() { db.close(); }

let notifyAssistant=()=>{};
const coordinator = createCoordinator({ ...store,onCreated:id=>conversationModels.initialize('coordination',id), memory, permissions, scheduling, autonomy,onTaskEvent:(id,kind)=>{if(!kind.startsWith('runtime.')||['runtime.run_exited','runtime.run_started','runtime.error'].includes(kind))notifyAssistant(id);}, agent: createApiXAgent({ infer:async(prompt,onDelta,context)=>{
  try{return await inferManager(prompt,onDelta,context);}
  catch(error){if(context?.purpose==='connection_test')throw new Error(quotaFailure(error.message)?'模型额度不足或触发速率限制，请核对后恢复账户':'连接测试失败，请检查模型 API 地址、模型 ID 与认证配置（90 秒后请求终止调用）');throw error;}
} }), resolveApproval, stopRun, sendMessage, capabilities:runtimes,reviewTask:(id,accepted,fingerprint)=>acceptTask(id,accepted,fingerprint),
  reportManagerFailure:(projectId,sourceId,error)=>{if(quotaFailure(error))scheduling.pauseAccountId(scheduling.policy(projectId).managerAccountId,sourceId);},
  consult:async(employeeId,prompt)=>{const e=row('SELECT runtime FROM employees WHERE id=? AND enabled=1 AND deleted_at IS NULL',employeeId);if(!['pi','claude'].includes(e?.runtime))throw new Error('此员工没有支持的无工具规划适配器');const command=commandFor(e.runtime);if(!command)throw new Error('规划员工运行时不可用');const cwd=join(dataDir,'consultations',randomUUID());mkdirSync(cwd,{recursive:true});const model=scheduling.profile(employeeId).model;try{return await (e.runtime==='claude'?consultClaude(command,prompt,cwd,model,managerApiKeys()):askPiEmployee(prompt,{cwd,model}));}catch(error){if(quotaFailure(error.message))scheduling.pauseAccount(employeeId,'consultation');throw error;}},
  employees: () => rows("SELECT * FROM employees WHERE enabled=1 AND deleted_at IS NULL").filter(e => runtimes().some(r => r.id === e.runtime && r.available && r.managed)) });
const supervisionTickMs = Number.isFinite(Number(process.env.APIX_SUPERVISION_TICK_MS ?? 15000)) ? Math.max(100, Number(process.env.APIX_SUPERVISION_TICK_MS ?? 15000)) : 15000;
const supervisionAfterMs = Number.isFinite(Number(process.env.APIX_SUPERVISION_AFTER_MS ?? 60000)) ? Math.max(100, Number(process.env.APIX_SUPERVISION_AFTER_MS ?? 60000)) : 60000;
setInterval(() => coordinator.superviseActiveRuns(supervisionAfterMs), supervisionTickMs).unref();
setInterval(() => {void autonomy.tick().catch(()=>process.stderr.write('自主交付监督发生错误，请检查当前目标状态。\n'));},supervisionTickMs).unref();
for (const task of recoveredTasks) coordinator.recordTask(task.id, 'runtime.recovery', {status:'unknown',reason:'服务重启，无法重新接管原进程'});
export const listCoordinationSessions = coordinator.listSessions;
export const coordinationSessionDetails = coordinator.sessionDetails;
const assistantProject=id=>{const project=row('SELECT * FROM projects WHERE id=?',id);if(!project)throw new Error('项目不存在');const rel=relative(realpathSync.native(project.path),realpathSync.native(dataDir));if(!rel||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel))throw new Error('工作区不能包含 ApiX 的内部状态目录');return project;};
const mcp=createMcpManager(store,{project:assistantProject,environment:()=>workerEnvironment(process.env,'mcp',managerApiKeys())});
export const mcpServers=projectId=>({servers:mcp.configs(projectId),tools:mcp.catalog(projectId)});
export const saveMcpServer=(projectId,input)=>mcp.save(projectId,input);
export const discoverMcpTools=projectId=>mcp.discover(projectId);
export const closeMcpConnections=()=>mcp.close();
const conversationModels=createConversationModels(store,()=>coordinator.getSettings());
const assistantCommands=createAssistantCommands({...store,root:projectId=>assistantProject(projectId).path,env:()=>workerEnvironment(process.env,'assistant-tool',managerApiKeys()),protectedValues:()=>managerApiKeys().map(key=>process.env[key]).filter(Boolean),policy:projectId=>permissions.get(projectId)});
const assistantCoding=createAssistantCoding(store,projectId=>assistantProject(projectId).path);
const assistant=createAssistantLoop({...store,onCreated:id=>conversationModels.initialize('assistant',id),
  toolDefinitions:projectId=>mcp.catalog(projectId),discoverTools:(projectId,signal)=>mcp.discover(projectId,signal),callExternal:(s,name,args,version,signal)=>mcp.call(s.project_id,name,args,version,signal),contextTokens:()=>Number(process.env.APIX_ASSISTANT_CONTEXT_TOKENS??32768),
  defaultProject:()=>{const path=join(dataDir,'assistant-workspace');mkdirSync(path,{recursive:true});return projectAtDirectory(path)?.id??createProject({name:'通用工作区',path});},
  policy:projectId=>permissions.get(projectId),
  describe:s=>{const project=assistantProject(s.project_id);return {environment:{platform:process.platform,node:process.execPath,commandsUseImplicitShell:false},project:{id:project.id,name:project.name,path:project.path},projectProfile:row('SELECT summary,goals,constraints,decisions FROM project_profiles WHERE project_id=?',s.project_id),legacyMemoryIndex:rows("SELECT id,title,category,source FROM memories WHERE project_id=? AND scope='project' ORDER BY updated_at DESC LIMIT 20",s.project_id),instructions:projectInstructions(project.path),skills:skillsFor(project.path).map(({id,name})=>({id,name})),employees:rows('SELECT id,name,runtime,role FROM employees WHERE enabled=1 AND deleted_at IS NULL').map(e=>({...e,capabilityProfile:scheduling.profile(e.id)})),autonomy:autonomy.settings(s.project_id),workflow:coordinator.workflowSettings(s.project_id),child:s.child_session_id?{id:s.child_session_id,status:coordinator.sessionDetails(s.child_session_id).derivedStatus}:null};},
  infer:createAssistantInference({settings:sessionId=>conversationModels.get('assistant',sessionId).settings,account:projectId=>scheduling.policy(projectId).managerAccountId,reserve:(id,projectId)=>scheduling.reserveManager(id,projectId),settle:(id,cost)=>scheduling.settle(id,cost),pause:(accountId,id)=>scheduling.pauseAccountId(accountId,id),quotaFailure,recordFailure:record=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system','inference_accounting_failure',?,?)").run(record.sessionId,JSON.stringify(record),now()),infer:inferManager}),
  commandState:(s,phase)=>{if(phase==='resume'){assistantCommands.recover(s);assistantCoding.recover(s);}else{assistantCommands.assertClear(s,phase==='message');assistantCoding.assertClear(s,phase==='message');}},
  fingerprint:projectId=>projectFingerprint(assistantProject(projectId).path),
  projectRoot:projectId=>assistantProject(projectId).path,
  execute:async(s,tool,args,signal,userApproved)=>{
    const project=assistantProject(s.project_id);
    if(tool==='read_output')return assistantCommands.readOutput(s.id,args);
    if(['read_file','list_files','write_file','edit_file','search_files','get_diff','load_skill'].includes(tool))return assistantCoding.execute(s,tool,args,signal);
    if(tool==='run_command'||tool==='verify')return assistantCommands.execute(s,tool,args,signal);
    if(tool==='read_memory'){const memory=args.id?row("SELECT id,title,content,source FROM memories WHERE project_id=? AND scope='project' AND id=?",s.project_id,String(args.id)):row("SELECT id,title,content,source FROM memories WHERE project_id=? AND scope='project' AND title=? ORDER BY updated_at DESC LIMIT 1",s.project_id,String(args.title));if(!memory)throw new Error('记忆不存在');return memory;}
    if(tool==='inspect_agents')return {employees:rows('SELECT id,name,runtime,role FROM employees WHERE enabled=1 AND deleted_at IS NULL').map(e=>({...e,capabilityProfile:scheduling.profile(e.id)})),runtimes:runtimes(),execution:executionControl.get(s.project_id),child:s.child_session_id?coordinator.sessionDetails(s.child_session_id):null};
    if(tool==='inspect_quota'){const employee=row('SELECT id,name,runtime FROM employees WHERE id=? AND deleted_at IS NULL',String(args.employeeId));if(!employee)throw new Error('员工不存在');const view=scheduling.view(s.project_id),accountId=scheduling.profile(employee.id).accountId;return {employee,observedAt:now(),runtime:await inspectEmployeeRuntime(employee.id),account:accountId?view.accounts.find(a=>a.id===accountId)??null:null,execution:executionControl.get(s.project_id),note:'运行时额度与手工账户快照分别展示，未知不等于零；查询不会恢复暂停或启动任务'};}
    if(tool==='send_agent_message'){
      if(!s.child_session_id)throw new Error('当前会话没有委派任务');const child=coordinator.sessionDetails(s.child_session_id);
      if(!child.tasks.some(t=>t.id===args.taskId))throw new Error('员工任务不属于当前循环');
      const task=child.tasks.find(t=>t.id===args.taskId);if(task.status!=='running')throw new Error('员工没有正在运行的任务');return sendMessage({projectId:s.project_id,taskId:task.id,from:'apix-director',to:task.employee_id,type:'event',idempotencyKey:'loop-guidance:'+randomUUID(),payload:{kind:'guidance',source:'apix',content:String(args.content??'').slice(0,2000)}});
    }
    if(tool==='configure_agents'){
      if(userApproved!==true)throw new Error('需要用户明确批准项目持续授权');
      if(!Array.isArray(args.runtimes)||!args.runtimes.length||args.runtimes.length>6||new Set(args.runtimes).size!==args.runtimes.length)throw new Error('请选择 1–6 个不同的本机运行时');
      if(!Array.isArray(args.checks)||!args.checks.length)throw new Error('必须指定实际验收脚本');
      for(const check of args.checks){if(!check||!Array.isArray(check.args))throw new Error('验收脚本无效');fileTool(project.path,'read_file',{path:check.args[0]});}
      db.exec('SAVEPOINT assistant_config');try{
        const created=new Set();
        const selected=args.runtimes.map(runtime=>{if(!runtimes().some(r=>r.id===runtime&&r.available&&r.managed))throw new Error('本机运行时不可用');const existing=rows('SELECT id FROM employees WHERE runtime=? AND enabled=1 AND deleted_at IS NULL ORDER BY rowid',runtime).find(e=>{const familiar=scheduling.profile(e.id).projectIds;return !familiar.length||familiar.includes(s.project_id);});if(existing)return existing.id;const id=registerEmployee({runtime,name:runtime+' Agent',role:'实现与验证'});created.add(id);return id;});
        if(args.profiles!==undefined){if(!Array.isArray(args.profiles)||args.profiles.length>6)throw new Error('能力声明无效');for(const declaration of args.profiles){const index=args.runtimes.indexOf(declaration.runtime);if(index<0)throw new Error('能力声明不属于选中运行时');const id=selected[index],priorProfile=scheduling.profile(id),model=declaration.model??priorProfile.model,contextTokens=declaration.contextTokens??null;if(!created.has(id)){if(priorProfile.model!==model||priorProfile.reasoningLevel!==declaration.reasoningLevel||priorProfile.contextTokens!==contextTokens)throw new Error('已有员工的全局能力档案与声明不一致；请使用已有声明，或在员工设置中明确修改，项目授权不会覆盖其他项目的配置');continue;}scheduling.saveProfile(id,{...priorProfile,version:priorProfile.version,model,reasoningLevel:declaration.reasoningLevel,contextTokens});}}
        const workflow=coordinator.workflowSettings(s.project_id);
        coordinator.saveWorkflow(s.project_id,{version:workflow.version,enabled:true,approved:true,managerVersion:permissions.get(s.project_id).version,employees:selected.map(id=>({id,version:permissions.get(s.project_id,id).version}))});
        const prior=autonomy.settings(s.project_id);const policy=autonomy.save(s.project_id,{...prior,version:prior.version,enabled:true,approved:true,maxRepairs:2,checks:args.checks});db.exec('RELEASE assistant_config');return {employeeIds:selected,checks:policy.checks,authorization:'persistent_project',maxRepairs:2};
      }catch(error){db.exec('ROLLBACK TO assistant_config');db.exec('RELEASE assistant_config');throw error;}
    }
    if(tool==='delegate'){
      if(s.child_session_id)throw new Error('已有委派，先检查或完成当前子流程');
      const policy=autonomy.settings(s.project_id),workflow=coordinator.workflowSettings(s.project_id);
      if(!policy.enabled||!policy.checks.length||!workflow.enabled)throw new Error('委派需要先在协作设置明确授权员工并配置实际验收命令；不自动提升权限或虚构检查。');
      if(permissions.get(s.project_id).mode!=='full_access')throw new Error('委派闭环需要管理者的项目授权');
      const requirements=args.requirements;if(!requirements||typeof requirements!=='object')throw new Error('委派需要明确范围、约束、交付物、验收标准');
      let child=coordinator.createSession({projectId:s.project_id,goal:args.goal});
      const inherited=conversationModels.get('assistant',s.id).settings;
      db.prepare('UPDATE conversation_models SET settings=? WHERE kind=? AND session_id=?').run(JSON.stringify(inherited),'coordination',child.id);
      db.prepare('UPDATE assistant_sessions SET child_session_id=? WHERE id=?').run(child.id,s.id);
      try{for(const field of ['scope','constraints','deliverable','acceptance'])child=coordinator.answerSession(child.id,{revision:child.revision,field,value:requirements[field]});child=await coordinator.confirmSession(child.id,{revision:child.revision},()=>!signal.aborted&&row('SELECT status FROM assistant_sessions WHERE id=?',s.id)?.status==='running');return {childSessionId:child.id,architecture:child.autonomy?.architecture,tasks:child.tasks};}
      catch(error){return {childSessionId:child.id,error:error.message};}
    }
    throw new Error('工具不存在');
  },
  child:id=>{const child=coordinator.sessionDetails(id);const state=child.autonomy?.state;const status=['running','ready'].includes(state)?'running':state==='attention'?'attention':state==='completed'?'completed':child.derivedStatus;return {status,complete:status==='completed'&&child.tasks.length>0&&child.tasks.every(t=>t.status==='accepted'),details:{id:child.id,status,tasks:child.tasks.map(t=>({id:t.id,status:t.status,employee_id:t.employee_id,delivery_commit:t.delivery_commit})),reports:rows("SELECT m.id,m.from_agent,m.task_id,substr(m.payload,1,3000) AS payload FROM agent_messages m JOIN tasks t ON t.id=m.task_id WHERE t.plan_id=? AND m.to_agent='apix-director' AND m.type='event' ORDER BY m.rowid DESC LIMIT 10",child.plan_id),autonomy:child.autonomy?{state:child.autonomy.state,reason:child.autonomy.reason,contractDigest:child.autonomy.architecture?.digest,checks:child.autonomy.checks.map(c=>({id:c.id,status:c.status,fingerprint:c.fingerprint})),repairs:child.autonomy.repairs.map(r=>({id:r.id,status:r.status,attempt:r.attempt}))}:null}};},
  stopChild:id=>{const child=coordinator.sessionDetails(id);if(child.busy&&!child.tasks.length||child.derivedStatus==='completed')return;coordinator.stopSession(id,{revision:child.revision});}
});
notifyAssistant=id=>assistant.notify(id);
setInterval(()=>{void assistant.tick().catch(()=>process.stderr.write('Assistant loop 监督失败\n'));},1000).unref();
export const createAssistantSession=assistant.create;
export const assistantSession=assistant.details;
export const assistantSessions=assistant.list;
export const assistantMessage=assistant.message;
export const assistantReply=assistant.reply;
export const assistantStop=assistant.stop;
export const assistantResume=assistant.resume;
export const assistantEditMemory=assistant.editMemory;
export const assistantEvents=assistant.eventPage;
export const assistantOutput=assistant.readOutput;
export const assistantStartTask=assistant.startTask;
export const assistantDelivery=assistant.delivery;
export const assistantDeliveryFile=assistant.deliveryFile;
export const assistantReviewDelivery=assistant.reviewDelivery;
export const assistantLogOutput=(id,args)=>{assistant.details(id);return assistantCommands.readOutput(id,args);};
const history=createChatHistory(store,(kind,id)=>{
  const source=row(`SELECT * FROM ${kind==='assistant'?'assistant_sessions':'coordination_sessions'} WHERE id=?`,id);
  if(!source)return false;
  if(kind==='assistant'&&row("SELECT 1 FROM assistant_events WHERE session_id=? GROUP BY session_id HAVING MAX(CASE WHEN kind IN ('restart_interrupted','process_unknown') THEN id ELSE 0 END)>MAX(CASE WHEN kind='resumed' THEN id ELSE 0 END)",id))return true;
  if(!source.archived_at&&!source.deleted_at){const d=kind==='assistant'?assistant.details(id):coordinator.sessionDetails(id);if(d.busy||['running','waiting_agents','waiting_user','planning','dispatching'].includes(d.status))return true;}
  const planId=kind==='assistant'?(source.child_session_id?row('SELECT plan_id FROM coordination_sessions WHERE id=?',source.child_session_id)?.plan_id:null):source.plan_id;
  return !!(planId&&row("SELECT id FROM tasks WHERE plan_id=? AND status IN ('awaiting_approval','queued','running','stopping','unknown') LIMIT 1",planId));
});
export const chatHistory=(projectId,view)=>history.list(projectId,view);
export const changeChatHistory=(kind,id,input)=>history.change(kind,id,input);
// Reconcile approved queued work after restart or missed completion notifications; admission still enforces pauses and quotas.
setInterval(()=>{try{pumpTasks();}catch{process.stderr.write('任务队列复核失败\n');}},5000).unref();

export const createCoordinationSession = coordinator.createSession;
export const answerCoordinationSession = coordinator.answerSession;
export const confirmCoordinationSession = coordinator.confirmSession;
export const dispatchCoordinationSession = coordinator.dispatchSession;
export const reviseCoordinationSession = coordinator.reviseSession;
export const coordinationTimeline = coordinator.timeline;
export const discussCoordinationSession = coordinator.discuss;
export const setCoordinationInteractionMode = coordinator.setInteractionMode;
export const editCoordinationPlan = coordinator.editPlan;
export const runPlanningMeeting=coordinator.runPlanningMeeting;
export const applyPlanningMeeting=coordinator.applyPlanningMeeting;
export const workflowSettings=projectId=>({...coordinator.workflowSettings(projectId),manager:permissions.get(projectId),employees:rows('SELECT * FROM employees WHERE enabled=1 AND deleted_at IS NULL').filter(e=>runtimes().some(r=>r.id===e.runtime && r.available && r.managed)).map(e=>({id:e.id,name:e.name,runtime:e.runtime,...permissions.get(projectId,e.id)}))});
export const saveWorkflow=coordinator.saveWorkflow;
export const autonomySettings=autonomy.settings;
export const saveAutonomySettings=autonomy.save;
export function resumeAutonomySession(id,input){const session=coordinator.sessionDetails(id);if(input.revision!==session.revision || !session.plan_id)throw new Error('会话已变化');autonomy.resume(session.plan_id,input);return coordinator.sessionDetails(id);}
export const stopCoordinationSession=coordinator.stopSession;
export const changePermission = coordinator.changePolicy;
export const managerSettings = coordinator.getSettings;
export const saveManagerSettings = coordinator.saveSettings;
function managerModelAvailable(){try{directModelSettings(coordinator.getSettings());return true;}catch{return false;}}
export function readiness(projectId){return projectReadiness({project:row('SELECT * FROM projects WHERE id=?',projectId),employees:rows('SELECT * FROM employees'),runtimes:runtimes(),settings:managerSettings(),managerAvailable:managerModelAvailable(),policy:projectId?permissions.get(projectId):null,budget:projectId&&row('SELECT id FROM projects WHERE id=?',projectId)?scheduling.view(projectId):null});}
export const testManagerConnection = coordinator.testModelConnection;
export const searchCoordinationMemory = memory.search;
export function permissionPolicy(projectId, subject = "apix") { return permissions.get(projectId, subject); }
export const registerRuntimeAdapter = runtimeAdapters.register;
export const instructCoordinationEmployee = coordinator.instructEmployee;
export const superviseWorkerMessage = coordinator.superviseWorkerMessage;
export const authenticateAgent = agentMailbox.authenticate;
export const taskDelivery=createTaskDelivery({row,codeHandoffs,dataDir,isActive:id=>running.get(id)?.child.exitCode===null});
export const inspectTaskDelivery=createDeliveryInspection({database:join(dataDir,'apix.sqlite'),dataDir,row,isActive:id=>running.get(id)?.child.exitCode===null});
export function executionSettings(projectId){return executionControl.get(projectId);}
export function saveExecutionSettings(projectId,input){const result=executionControl.save(projectId,input);pumpTasks();return result;}
export function changeRuntimePause(projectId,input){const result=executionControl.setRuntime(projectId,input);pumpTasks();return result;}
export const schedulingAccount=scheduling.saveAccount;
export function resumeSchedulingAccount(input){const result=scheduling.resumeAccount(input);pumpTasks();return result;}
export const employeeCapability=scheduling.profile;
export const saveEmployeeCapability=scheduling.saveProfile;
export const schedulingView=scheduling.view;
export function saveSchedulingPolicy(projectId,input){const result=scheduling.savePolicy(projectId,input);pumpTasks();return result;}
export function settleSchedulingCost(projectId,input){const result=scheduling.settleReported(projectId,input);memory.append(projectId,projectId,'budget.manually_settled',{id:input.id,actualMinor:input.actualMinor,source:'user_reported'});pumpTasks();return result;}
export async function recoverTask(id,input,source='user',repairPrompt) {
  const {task}=coordinator.assertRetry(id,input);
  if(rows('SELECT t.status FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=?',id).some(t=>t.status!=='accepted'))throw new Error('请先恢复并验收前置任务');
  const checked=await inspectTaskDelivery(id);
  coordinator.assertRetry(id,input);
  if(input.reviewed!==true || !checked.recoveryFingerprint || input.fingerprint!==checked.recoveryFingerprint || input.runId!== (checked.latestRun?.id ?? null))throw new Error('请先检查最新进程、代码与交付记录，再重新批准');
  if(checked.managedActive)throw new Error('原进程仍由本服务运行，请先停止并等待结束');
  if(task.status==='unknown' && input.confirmedStopped!==true)throw new Error('原进程状态未知，须人工确认已停止；PID 可能已被复用');
  const resolution=checked.handoff?.status==='conflict'?codeHandoffs.approveResolution(task,checked.inspection.fingerprint):null;
  const fresh=row('SELECT * FROM tasks WHERE id=?',id);
  const currentInspection=fresh.workspace_path?(await inspectTaskDelivery(id)).inspection:null;
  coordinator.assertRetry(id,input);
  if(currentInspection && (resolution ? currentInspection.tree!==resolution.tree : currentInspection.fingerprint!==checked.inspection.fingerprint))throw new Error('恢复检查后工作区已变化，请重新检查');
  const workspaceFingerprint=currentInspection?.fingerprint ?? 'head:'+checked.sourceHead;
  if(checked.latestRun?.status==='unknown'){db.prepare("UPDATE runs SET status='cancelled',status_source='user-recovery-confirmed',ended_at=? WHERE id=?").run(now(),checked.latestRun.id);scheduling.settle(checked.latestRun.id,null);}
  db.prepare("UPDATE agent_messages SET status='rejected',error='旧运行已结束，恢复时不重放旧指导',completed_at=? WHERE target_task_id=? AND status IN ('queued','delivered','processing')").run(now(),id);
  const approved=coordinator.authorizeRetry(id,{...input,workspaceFingerprint},source,repairPrompt);
  for(let pass=0;pass<8;pass++)for(const blocked of rows("SELECT id FROM tasks WHERE plan_id=? AND status='blocked'",task.plan_id)) {
    if(row("SELECT task_id FROM code_handoffs WHERE task_id=? AND status='conflict'",blocked.id))continue;
    const bad=row("SELECT t.id FROM tasks t JOIN task_dependencies d ON d.depends_on_id=t.id WHERE d.task_id=? AND t.status IN ('failed','cancelled','blocked','unknown','rejected','needs_revision') LIMIT 1",blocked.id);
    if(!bad && row("SELECT id FROM approvals WHERE task_id=? AND status='approved'",blocked.id))db.prepare("UPDATE tasks SET status='queued',queue_reason='等待恢复任务验收',updated_at=? WHERE id=?").run(now(),blocked.id);
  }
  let failure=null;
  try{resolveApproval(approved.approvalId,true);}catch(e){failure=String(e.message);}
  pumpTasks();
  return {session:coordinator.sessionDetails(approved.sessionId),failure};
}
export function freezeHistoricalDelivery(id,input) {
  const task=row("SELECT * FROM tasks WHERE id=? AND status='accepted'",id);
  if(!task || task.delivery_commit || typeof input.fingerprint!=='string')throw new Error('只能重新审查尚未冻结的历史验收交付');
  if(permissions.get(task.project_id).mode==='read_only')throw new Error('只读模式不能冻结交付');
  return codeHandoffs.freeze(task,input.fingerprint);
}
export function receiveAgentMessages(actor) {
  db.prepare('UPDATE runs SET mailbox_seen_at=? WHERE id=?').run(now(),actor.run_id);
  return receiveMessages({projectId:actor.project_id,agentId:actor.agent_id,targetTaskId:actor.task_id,targetRunId:actor.run_id});
}
export function sendAgentMessage(actor, input) {
  if (typeof input.idempotencyKey!=='string' || !input.idempotencyKey.trim() || input.idempotencyKey.length>200) throw new Error('消息需要有效的幂等键');
  let targetTaskId = actor.task_id;
  let targetRunId = actor.run_id;
  if (!['apix-director','director'].includes(input.to) && (input.to!==actor.agent_id || input.targetTaskId && input.targetTaskId!==actor.task_id)) {
    const source = row('SELECT plan_id FROM tasks WHERE id=?',actor.task_id);
    const target = row("SELECT t.id,t.plan_id,r.id AS run_id FROM tasks t JOIN runs r ON r.task_id=t.id WHERE t.id=? AND t.project_id=? AND t.employee_id=? AND t.status='running' AND r.status='running' ORDER BY r.rowid DESC LIMIT 1",input.targetTaskId ?? null,actor.project_id,input.to ?? null);
    if (!target || !source?.plan_id || target.plan_id !== source.plan_id) throw new Error('同事交接须指定同一已批准计划中正在运行的目标任务');
    targetTaskId=target.id; targetRunId=target.run_id;
  }
  if (input.replyTo) {
    const request = row('SELECT * FROM agent_messages WHERE id=?',input.replyTo);
    if (!request || request.project_id!==actor.project_id || request.to_agent!==actor.agent_id || request.target_task_id!==actor.task_id || request.target_run_id!==actor.run_id) throw new Error('不能回复其他任务或运行的消息');
  }
  return sendMessage({...input,projectId:actor.project_id,from:actor.agent_id,taskId:actor.task_id,targetTaskId,targetRunId,sourceRunId:actor.run_id,idempotencyKey:`run:${actor.run_id}:${input.idempotencyKey.trim()}`});
}
export function handleAgentMessage(actor, id, action, input) {
  const message=messageDetails(id,actor.agent_id).message;
  if(message.project_id!==actor.project_id || message.to_agent!==actor.agent_id || message.target_task_id!==actor.task_id || message.target_run_id!==actor.run_id) throw new Error('消息不属于当前任务与运行');
  return ({ack:ackMessage,complete:completeMessage,nack:nackMessage})[action](id,{...input,agentId:actor.agent_id});
}
export function employeeDetails(id){
  const details=employeeInsights.details(id);const capability=scheduling.profile(id);
  const accounts=scheduling.accounts().map(a=>{
    const usage=row("SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual WHEN state IN ('reserved','unmeasured') THEN amount ELSE 0 END),0) AS committed, COUNT(CASE WHEN state='settled' AND actual IS NULL OR state IN ('reserved','unmeasured') AND amount IS NULL THEN 1 END) AS unknownCount FROM scheduling_reservations WHERE account_id=?",a.id);
    return {...a,source:'manual',committedMinor:usage.committed,unknownCount:usage.unknownCount,budgetRemainingMinor:a.limitMinor==null||usage.unknownCount?null:Math.max(0,a.limitMinor-usage.committed)};
  });
  return {...details,capability,accounts};
}
const runtimeInfoPending=new Map();
export async function inspectEmployeeRuntime(id){
  const employee=row('SELECT runtime FROM employees WHERE id=? AND deleted_at IS NULL',id);if(!employee)throw new Error('员工不存在');
  if(employee.runtime!=='codex')return {source:'unsupported',observedAt:null,quota:{state:'unknown',windows:[],message:'此运行时尚无已接入的官方额度查询接口；请维护共享账户快照'},models:[]};
  if(runtimeInfoPending.has('codex'))return runtimeInfoPending.get('codex');
  const command=commandFor('codex');if(!command)throw new Error('Codex 未安装或不可用');
  const env=workerEnvironment(process.env,'codex',managerApiKeys());
  const pending=inspectCodex(command,env).finally(()=>runtimeInfoPending.delete('codex'));runtimeInfoPending.set('codex',pending);return pending;
}
export function agentTeam(projectId, taskId) {
  const source=taskId ? row('SELECT plan_id FROM tasks WHERE id=? AND project_id=?',taskId,projectId) : null;
  return listMailboxes(projectId).map(m => ({id:m.agent_id,role:m.role,name:row('SELECT name FROM employees WHERE id=?',m.agent_id)?.name ?? m.agent_id,
    tasks:source?.plan_id ? rows("SELECT t.id AS taskId,r.id AS runId,substr(t.prompt,1,200) AS instruction FROM tasks t JOIN runs r ON r.task_id=t.id WHERE t.project_id=? AND t.plan_id=? AND t.employee_id=? AND t.status='running' AND r.status='running'",projectId,source.plan_id,m.agent_id) : []}));
}

export { registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact };

function modelConversation(kind,id){
  if(!['assistant','coordination'].includes(kind))throw new Error('对话类型无效');
  return kind==='assistant'?assistant.details(id):coordinator.sessionDetails(id);
}
export function conversationModel(kind,id){modelConversation(kind,id);return conversationModels.get(kind,id);}
export function saveConversationModel(kind,id,input){
  const session=modelConversation(kind,id);
  if(session.busy||['running','waiting_agents','waiting_user'].includes(session.status)||session.tasks?.some(t=>['running','queued','stopping'].includes(t.status)))throw new Error('请先停止或完成当前工作，再更改对话模型');
  return conversationModels.save(kind,id,input);
}
