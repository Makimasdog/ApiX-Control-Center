-- 迁移 1 的建表语句，冻结为升级路径的起点。
-- 这是历史文件：不要随 control-plane.mjs 更新，它代表"老用户库里已经有的结构"。
-- 新增迁移不会改变它；若确需修改，必须同时说明老库如何处理。
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), runtime TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), action TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), runtime TEXT NOT NULL, status TEXT NOT NULL, status_source TEXT NOT NULL, pid INTEGER, started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, stop_requested_at TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), source TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
