/**
 * schema.ts - 模块表结构的单一真源
 *
 * 为什么集中到这里：
 *   此前 69 张模块表分散在 25 个模块的工厂函数里，各自 db.exec('CREATE TABLE ...')。
 *   这带来三个问题：
 *     1. 加一列要改「建表语句」和「PRAGMA 补列」两处，还可能漏掉测试里的副本；
 *     2. 没有任何一处能看到全库结构，review 时无法判断变更影响面；
 *     3. 每次启动无条件执行 35 次 DDL。
 *
 * 现在的约定：
 *   - 所有 CREATE TABLE / CREATE INDEX 文本只写在这个文件里；
 *   - 模块调用 ensureModuleSchema(db, key) 拿到自己的表，不再内联 DDL；
 *   - 每块的 SHA-256 记录在 module_schema_versions，未变化时跳过执行，
 *     结构改动后自动重跑一次（配合 IF NOT EXISTS 与模块自身的补列逻辑）。
 *
 * 修改结构时：
 *   1. 改这里的 DDL（新装路径）；
 *   2. 若表已存在需要补列，在对应模块保留 PRAGMA/ALTER 逻辑（升级路径）；
 *   3. 跑 npm run build 与 schema 相关测试，基线不一致会直接失败。
 *
 * 例外：src/assistant/knowledge-base.ts 的 kb_fts 不在这里。
 * 它是 FTS5 虚拟表，建表语句取决于当前 SQLite 是否编译了 FTS5
 * （不可用时降级为普通表），属于运行时能力探测，不是静态结构，
 * 因此保留在模块内。
 */
import {createHash} from 'node:crypto';

export const moduleSchemas: Record<string, string> = {
  // 来源：src/agents/employee-insights.ts
  "agents-employee-insights": `CREATE TABLE IF NOT EXISTS apix_run_usage(run_id TEXT PRIMARY KEY REFERENCES runs(id),input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,source TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  // 来源：src/agents/runtime-adapters.ts
  "agents-runtime-adapters": `CREATE TABLE IF NOT EXISTS apix_adapters(id TEXT PRIMARY KEY,name TEXT NOT NULL,executable TEXT NOT NULL,args_json TEXT NOT NULL,format TEXT NOT NULL)`,
  // 来源：src/agents/runtime-controller.ts
  "agents-runtime-controller": `CREATE TABLE IF NOT EXISTS employee_runtime_settings(employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,backend TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_run_bindings(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,backend TEXT NOT NULL,config_fingerprint TEXT NOT NULL,phase TEXT NOT NULL,stop_evidence TEXT NOT NULL,native_session_id TEXT,resume_from_run_id TEXT,cwd TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_runtime_turns(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,status TEXT NOT NULL,usage_json TEXT,started_at TEXT NOT NULL,ended_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_runtime_deliveries(message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(message_id,run_id),UNIQUE(run_id,request_id));
    CREATE TABLE IF NOT EXISTS agent_runtime_continuations(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,resume_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE);`,
  // 来源：src/agents/runtime-interactions.ts
  "agents-runtime-interactions": `CREATE TABLE IF NOT EXISTS agent_runtime_interactions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,payload_json TEXT NOT NULL,permission_version TEXT NOT NULL,state TEXT NOT NULL,answer_request_id TEXT,answer_hash TEXT,answer_delivery TEXT NOT NULL DEFAULT 'not_sent',expires_at TEXT NOT NULL,answered_at TEXT);`,
  // 来源：src/assistant/assistant-context.ts
  "assistant-assistant-context": `CREATE TABLE IF NOT EXISTS assistant_outputs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),event_id INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`,
  // 来源：src/assistant/assistant-effects.ts
  "assistant-assistant-effects": `CREATE TABLE IF NOT EXISTS assistant_effects(id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL DEFAULT 1,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),scope_key TEXT NOT NULL,tool TEXT NOT NULL,state TEXT NOT NULL,input_fingerprint TEXT NOT NULL,output_fingerprint TEXT,result_event_id INTEGER REFERENCES assistant_events(id),created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS assistant_effect_scope ON assistant_effects(session_id,scope_key);CREATE UNIQUE INDEX IF NOT EXISTS assistant_effect_pending ON assistant_effects(session_id,scope_key) WHERE state='started';`,
  // 来源：src/assistant/assistant-loop.ts
  "assistant-assistant-loop": `CREATE TABLE IF NOT EXISTS assistant_sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,steps INTEGER NOT NULL DEFAULT 0,summary TEXT NOT NULL DEFAULT '',compacted_through INTEGER NOT NULL DEFAULT 0,pending TEXT,child_session_id TEXT,needs_verification INTEGER NOT NULL DEFAULT 0,verification TEXT,started_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),role TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_event_session ON assistant_events(session_id,id);`,
  // 来源：src/assistant/assistant-loop.ts
  "assistant-assistant-loop-2": `CREATE TABLE IF NOT EXISTS assistant_tool_discoveries(session_id TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(session_id,name));CREATE TABLE IF NOT EXISTS assistant_supervision(session_id TEXT PRIMARY KEY,digest TEXT NOT NULL,last_wake_at INTEGER NOT NULL DEFAULT 0,wakes INTEGER NOT NULL DEFAULT 0)`,
  // 来源：src/assistant/assistant-loop.ts
  "assistant-assistant-loop-3": `CREATE TABLE IF NOT EXISTS assistant_message_requests(session_id TEXT NOT NULL REFERENCES assistant_sessions(id),request_id TEXT NOT NULL,content_hash TEXT NOT NULL,event_id INTEGER NOT NULL REFERENCES assistant_events(id),created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id))`,
  // 来源：src/assistant/assistant-loop.ts
  "assistant-assistant-loop-4": `CREATE TABLE IF NOT EXISTS assistant_optimization(session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(id),mode TEXT NOT NULL CHECK(mode IN ('standard','saving')))`,
  // 来源：src/assistant/context-compaction.ts
  "assistant-context-compaction": `CREATE TABLE IF NOT EXISTS assistant_compaction_blocks(
    session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    input_signature TEXT NOT NULL,effective_watermark INTEGER NOT NULL,checkpoint_through INTEGER NOT NULL,
    generation TEXT,reason TEXT NOT NULL CHECK(reason IN ('in_progress','failed','no_gain')),created_at TEXT NOT NULL);`,
  // 来源：src/assistant/knowledge-base.ts
  "assistant-knowledge-base": `CREATE TABLE IF NOT EXISTS kb_spaces(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,description TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kb_grants(space_id TEXT NOT NULL REFERENCES kb_spaces(id) ON DELETE CASCADE,subject TEXT NOT NULL,PRIMARY KEY(space_id,subject));
    CREATE TABLE IF NOT EXISTS kb_documents(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES kb_spaces(id) ON DELETE CASCADE,filename TEXT NOT NULL,title TEXT NOT NULL,source TEXT NOT NULL,digest TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kb_chunks(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,doc_version INTEGER NOT NULL,ordinal INTEGER NOT NULL,content TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kb_queries(session_id TEXT NOT NULL,turn_id INTEGER NOT NULL,has_sources INTEGER NOT NULL,PRIMARY KEY(session_id,turn_id));
    CREATE TABLE IF NOT EXISTS kb_receipts(session_id TEXT NOT NULL,citation TEXT NOT NULL,PRIMARY KEY(session_id,citation));`,
  // 来源：src/assistant/mcp-manager.ts
  "assistant-mcp-manager": `CREATE TABLE IF NOT EXISTS apix_mcp_servers(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id));CREATE TABLE IF NOT EXISTS apix_mcp_tools(project_id TEXT NOT NULL,server_id TEXT NOT NULL,name TEXT NOT NULL,remote_name TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,name))`,
  // 来源：src/assistant/project-memory.ts
  "assistant-project-memory": `CREATE TABLE IF NOT EXISTS assistant_notes(project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,content TEXT NOT NULL,source TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,title));
    CREATE TABLE IF NOT EXISTS assistant_memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_note_versions(note_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(note_id,version));
    CREATE TABLE IF NOT EXISTS assistant_memory_usage(project_id TEXT NOT NULL,note_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,agent TEXT NOT NULL,used_at TEXT NOT NULL,PRIMARY KEY(note_id,session_id,version,agent));`,
  // 来源：src/assistant/prompt-projection.ts
  "assistant-prompt-projection": `CREATE TABLE IF NOT EXISTS assistant_prompt_settings(
    session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    strategy TEXT NOT NULL CHECK(strategy IN ('legacy','stable-prefix-v1')),version INTEGER NOT NULL,active_generation TEXT,FOREIGN KEY(session_id,active_generation) REFERENCES assistant_prompt_generations(session_id,id));
    CREATE TABLE IF NOT EXISTS assistant_prompt_generations(
    id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    boundary TEXT NOT NULL,header TEXT NOT NULL,checkpoint TEXT NOT NULL,scan_watermark INTEGER NOT NULL,
    instruction_hash TEXT NOT NULL,instruction_version INTEGER NOT NULL,reason TEXT NOT NULL,discoveries TEXT NOT NULL,integrity TEXT NOT NULL,manifest TEXT NOT NULL,
    UNIQUE(session_id,id));
    CREATE TABLE IF NOT EXISTS assistant_prompt_frames(
    generation_id TEXT NOT NULL REFERENCES assistant_prompt_generations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,event_id INTEGER,source_hash TEXT NOT NULL,rendered_text TEXT NOT NULL,rendered_hash TEXT NOT NULL,
    PRIMARY KEY(generation_id,sequence),UNIQUE(generation_id,event_id));`,
  // 来源：src/assistant/token-usage.ts
  "assistant-token-usage": `CREATE TABLE IF NOT EXISTS model_token_usage(
    id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,attempt INTEGER NOT NULL,project_id TEXT NOT NULL,
    session_id TEXT,task_id TEXT,purpose TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,api_type TEXT NOT NULL,
    status TEXT NOT NULL,usage_complete INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER,
    cached_input_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
    estimated_prompt_tokens INTEGER NOT NULL,duration_ms INTEGER,created_at TEXT NOT NULL,
    UNIQUE(invocation_id,attempt));
    CREATE INDEX IF NOT EXISTS model_token_usage_scope ON model_token_usage(project_id,session_id,task_id,created_at);`,
  // 来源：src/assistant/token-usage.ts
  "assistant-token-usage-2": `CREATE TABLE IF NOT EXISTS model_usage_details(
    usage_id TEXT PRIMARY KEY REFERENCES model_token_usage(id) ON DELETE CASCADE,body TEXT NOT NULL);`,
  // 来源：src/assistant/token-usage.ts
  "assistant-token-usage-3": `CREATE TABLE IF NOT EXISTS model_prompt_diagnostics(
    usage_id TEXT PRIMARY KEY REFERENCES model_token_usage(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,session_id TEXT NOT NULL,route_id TEXT NOT NULL,purpose TEXT NOT NULL,layout TEXT NOT NULL,
    process_id TEXT NOT NULL,config_revision INTEGER,response_headers INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS model_prompt_diagnostics_scope ON model_prompt_diagnostics(project_id,session_id,route_id,purpose,layout);`,
  // 来源：src/assistant/tool-governance.ts
  "assistant-tool-governance": `CREATE TABLE IF NOT EXISTS tool_access(project_id TEXT NOT NULL REFERENCES projects(id),subject TEXT NOT NULL,role TEXT NOT NULL,allow_json TEXT NOT NULL,deny_json TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(project_id,subject));
    CREATE TABLE IF NOT EXISTS tool_audit(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,subject TEXT NOT NULL,tool TEXT NOT NULL,args_summary TEXT NOT NULL,outcome TEXT NOT NULL,code TEXT,created_at TEXT NOT NULL);`,
  // 来源：src/assistant/tool-progress.ts
  "assistant-tool-progress": `CREATE TABLE IF NOT EXISTS tool_limits(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_observations(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,turn_id INTEGER NOT NULL,signature TEXT NOT NULL,result_hash TEXT NOT NULL,code TEXT,bytes INTEGER NOT NULL,blocked INTEGER NOT NULL,created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS tool_progress_turn ON tool_observations(session_id,turn_id,id);`,
  // 来源：src/assistant-core/personal-memory.ts
  "assistant-core-personal-memory": `CREATE TABLE IF NOT EXISTS personal_work_memory(id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)))`,
  // 来源：src/coordination/agent-health.mjs
  "coordination-agent-health": `CREATE TABLE IF NOT EXISTS agent_health(run_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL DEFAULT 1,task_id TEXT NOT NULL,last_activity_at TEXT NOT NULL,last_probe_at TEXT,misses INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);`,
  // 来源：src/coordination/autonomy.ts
  "coordination-autonomy": `CREATE TABLE IF NOT EXISTS autonomy_policies(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_plans(plan_id TEXT PRIMARY KEY REFERENCES plans(id),session_id TEXT NOT NULL,revision INTEGER NOT NULL,policy_version INTEGER NOT NULL,workflow_version INTEGER NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),module_id TEXT NOT NULL,original_prompt TEXT NOT NULL,repairs INTEGER NOT NULL DEFAULT 0,last_checkpoint TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_checks(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT,status TEXT NOT NULL,fingerprint TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_repairs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,employee_id TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);`,
  // 来源：src/coordination/coordinator.ts
  "coordination-coordinator": `CREATE TABLE IF NOT EXISTS coordination_checks(session_id TEXT PRIMARY KEY REFERENCES coordination_sessions(id), conflicts TEXT NOT NULL DEFAULT '[]', model_mode TEXT NOT NULL DEFAULT 'rules', model_error TEXT);
    CREATE TABLE IF NOT EXISTS apix_manager_settings(id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL DEFAULT '', api_type TEXT NOT NULL DEFAULT 'openai-completions', api_key_env TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS apix_guidance(message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, action TEXT, focus TEXT, outbound_id TEXT, summary TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS apix_guidance_task ON apix_guidance(task_id,updated_at);`,
  // 来源：src/coordination/memory.ts
  "coordination-memory": `CREATE TABLE IF NOT EXISTS apix_ledger (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL DEFAULT 1,
    project_id TEXT NOT NULL REFERENCES projects(id), aggregate_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS apix_ledger_project ON apix_ledger(project_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_aggregate ON apix_ledger(aggregate_id,sequence);
    CREATE INDEX IF NOT EXISTS apix_ledger_project_aggregate ON apix_ledger(project_id,aggregate_id,sequence);`,
  // 来源：src/coordination/permissions.ts
  "coordination-permissions": `CREATE TABLE IF NOT EXISTS apix_policies (
    project_id TEXT NOT NULL REFERENCES projects(id), subject TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('full_access','ask_approval','read_only')),
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,subject));
    CREATE TABLE IF NOT EXISTS apix_grants (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL, employee_id TEXT NOT NULL,
    manager_version INTEGER NOT NULL, employee_version INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);`,
  // 来源：src/coordination/planning-meetings.ts
  "coordination-planning-meetings": `CREATE TABLE IF NOT EXISTS planning_meetings(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES coordination_sessions(id),plan_id TEXT NOT NULL REFERENCES plans(id),round INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);`,
  // 来源：src/coordination/scheduling.ts
  "coordination-scheduling": `CREATE TABLE IF NOT EXISTS scheduling_profiles(employee_id TEXT PRIMARY KEY REFERENCES employees(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_accounts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_policies(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),body TEXT NOT NULL,decision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_attempts(run_id TEXT PRIMARY KEY REFERENCES runs(id),employee_id TEXT NOT NULL,model TEXT NOT NULL,kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_reservations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,account_id TEXT,amount INTEGER,currency TEXT,state TEXT NOT NULL,actual INTEGER,created_at TEXT NOT NULL);`,
  // 来源：src/coordination/scheduling.ts
  "coordination-scheduling-2": `CREATE TABLE IF NOT EXISTS scheduling_account_pauses(account_id TEXT PRIMARY KEY,reason TEXT NOT NULL,source_id TEXT NOT NULL,created_at TEXT NOT NULL)`,
  // 来源：src/coordination/workflow-recovery.mjs
  "coordination-workflow-recovery": `CREATE TABLE IF NOT EXISTS workflow_recoveries(task_id TEXT PRIMARY KEY REFERENCES tasks(id),original_prompt TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,last_run_id TEXT,state TEXT NOT NULL,reason TEXT)`,
  // 来源：src/coordination/workflow.ts
  "coordination-workflow": `CREATE TABLE IF NOT EXISTS apix_workflows(project_id TEXT PRIMARY KEY REFERENCES projects(id),body TEXT NOT NULL)`,
  // 来源：src/messaging/agent-mailbox.ts
  "messaging-agent-mailbox": `CREATE TABLE IF NOT EXISTS apix_agent_tokens(token_hash TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),project_id TEXT NOT NULL,agent_id TEXT NOT NULL,created_at TEXT NOT NULL)`,
  // 来源：src/models/agent-providers.mjs
  "models-agent-providers": `CREATE TABLE IF NOT EXISTS agent_providers(id TEXT PRIMARY KEY,version INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_provider_bindings(employee_id TEXT PRIMARY KEY REFERENCES employees(id),provider_id TEXT REFERENCES agent_providers(id),version INTEGER NOT NULL);`,
  // 来源：src/models/conversation-models.ts
  "models-conversation-models": `CREATE TABLE IF NOT EXISTS conversation_models(kind TEXT NOT NULL,session_id TEXT NOT NULL,settings TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,session_id))`,
  // 来源：src/models/conversation-models.ts
  "models-conversation-models-2": `CREATE TABLE IF NOT EXISTS conversation_model_links(kind TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(kind,session_id))`,

  // 来源：src/assistant-core/channels/channel-relay.ts
  "assistant-core-channels": `CREATE TABLE IF NOT EXISTS assistant_channel_routes (
      route_key TEXT PRIMARY KEY, session_id TEXT REFERENCES assistant_sessions(id), cursor TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS assistant_channel_deliveries (
      route_key TEXT NOT NULL REFERENCES assistant_channel_routes(route_key),
      message_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(route_key,message_id)
    );`,
  // 来源：src/assistant-core/channels/message-media.ts
  "assistant-core-message-media": `CREATE TABLE IF NOT EXISTS assistant_message_media (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES assistant_sessions(id),
      kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_message_media_session ON assistant_message_media(session_id);`,
  // 来源：src/assistant-core/gateway.ts
  "assistant-core-gateway": `CREATE TABLE IF NOT EXISTS assistant_gateway_rules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      revision INTEGER NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)),
      next_at INTEGER, last_checked_at INTEGER, deleted_at INTEGER, checkpoint TEXT, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS assistant_gateway_due ON assistant_gateway_rules(next_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS assistant_gateway_project ON assistant_gateway_rules(project_id) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS assistant_gateway_runs (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES assistant_gateway_rules(id),
      rule_name TEXT NOT NULL, trigger_key TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
      UNIQUE(rule_id, trigger_key)
    );
    CREATE TABLE IF NOT EXISTS assistant_gateway_events (
      project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, source TEXT NOT NULL,
      event_id TEXT NOT NULL, PRIMARY KEY(project_id, kind, source, event_id)
    );`,
  // 来源：src/assistant-core/skills/operations.ts
  "assistant-core-skill-operations": `CREATE TABLE IF NOT EXISTS assistant_skill_calendar (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,
      starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_skill_calendar_time ON assistant_skill_calendar(project_id,starts_at);`,
  // 来源：src/assistant-core/skills/registry.ts
  "assistant-core-skill-registry": `CREATE TABLE IF NOT EXISTS assistant_skill_grants (
    project_id TEXT NOT NULL REFERENCES projects(id),skill_id TEXT NOT NULL,revision TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(project_id,skill_id)
  )`,

};

/**
 * ensureModuleSchema - 幂等地建立某个模块的表
 *
 * 用一个内容哈希表记录已执行过的版本：
 *   - 哈希未变 → 直接返回，不再执行 DDL（启动零开销）
 *   - 哈希变化 → 重跑该块（CREATE TABLE IF NOT EXISTS 幂等，
 *     需要补列的由模块自己的 PRAGMA/ALTER 逻辑负责）
 *
 * @param db - 数据库连接
 * @param key - moduleSchemas 中的键
 */
export function ensureModuleSchema(db: {exec: (sql: string) => unknown; prepare: (sql: string) => any}, key: string) {
  const sql = moduleSchemas[key];
  if (sql === undefined) throw new Error(`未知的模块 schema：${key}`);
  const digest = createHash('sha256').update(sql).digest('hex');
  // 注册表自身只建一次；放在这里而不是模块清单里，避免"记录清单的表也进清单"
  db.exec('CREATE TABLE IF NOT EXISTS module_schema_versions(key TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = db.prepare('SELECT digest FROM module_schema_versions WHERE key=?').get(key);
  if (applied?.digest === digest) return false;
  db.exec(sql);
  db.prepare('INSERT INTO module_schema_versions(key,digest,applied_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,applied_at=excluded.applied_at')
    .run(key, digest, new Date().toISOString());
  return true;
}

/**
 * applyAllModuleSchemas - 建立全部模块表
 *
 * 控制平面在迁移块之后调用一次，保证"新装"与"升级"走同一套模块建表逻辑。
 * 返回实际执行了 DDL 的键（未变化的会被跳过）。
 */
export function applyAllModuleSchemas(db: {exec: (sql: string) => unknown; prepare: (sql: string) => any}) {
  return moduleSchemaKeys.filter((key) => ensureModuleSchema(db, key));
}

/** 所有模块 schema 的键，供启动时预热与测试遍历 */
export const moduleSchemaKeys = Object.keys(moduleSchemas);
