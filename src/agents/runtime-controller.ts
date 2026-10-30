import {existsSync} from 'node:fs';
import type {Store} from '../coordination/contracts.js';
import {digest,redact} from '../assistant/tool-governance.js';
import {openCliRuntime} from './cli-runtime.js';
import {openCodexAppServer} from './codex-app-server.js';
import {openClaudeAgentSdk} from './claude-agent-sdk.js';
import {createRuntimeInteractions} from './runtime-interactions.js';
import {cliCapabilities,runtimeError,type RuntimeBackend,type RuntimeInput,type RunHandle} from './runtime-contract.js';

interface Settings {backend:RuntimeBackend;version:number}
interface Hooks {
  snapshot(id:string):unknown;
  assert(id:string):void;
  message(id:string,input:{requestId:string;content:string;mode:string}):{id:string};
  claimed(id:string,runId:string):void;
  record(id:string,name:string,payload:unknown):void;
  settingsChanged?(id:string):void;
  stop?(id:string):void;
}
const capabilities=(backend:string)=>backend==='cli'?cliCapabilities:{steer:backend==='codex-app-server',queue:true,questions:true,approvals:true,resume:true,usage:true,compatibility:'unverified' as const};

export function createRuntimeController(store:Store){
  const {db,row,rows,now}=store;
  db.exec(`CREATE TABLE IF NOT EXISTS employee_runtime_settings(employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,backend TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_run_bindings(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,backend TEXT NOT NULL,config_fingerprint TEXT NOT NULL,phase TEXT NOT NULL,stop_evidence TEXT NOT NULL,native_session_id TEXT,resume_from_run_id TEXT,cwd TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_runtime_turns(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,status TEXT NOT NULL,usage_json TEXT,started_at TEXT NOT NULL,ended_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_runtime_deliveries(message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(message_id,run_id),UNIQUE(run_id,request_id));
    CREATE TABLE IF NOT EXISTS agent_runtime_continuations(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,resume_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE);`);
  for(const [table,columns] of [['agent_run_bindings',['executor_version','sdk_version']],['agent_runtime_turns',['native_turn_id','input_message_id']],['agent_runtime_deliveries',['turn_id']]] as const)for(const column of columns)if(!rows<{name:string}>('PRAGMA table_info('+table+')').some(c=>c.name===column))db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS runtime_native_turn ON agent_runtime_turns(run_id,native_turn_id) WHERE native_turn_id IS NOT NULL');
  const handles=new Map<string,RunHandle>(),secrets=new Map<string,string[]>();let hooks:Hooks;
  db.prepare("UPDATE agent_run_bindings SET phase='unknown',stop_evidence='unknown',updated_at=? WHERE phase IN ('starting','running','executing','waiting_input','waiting_approval','stopping','closing')").run(now());
  db.prepare("UPDATE agent_runtime_deliveries SET state='unknown' WHERE state IN ('saved','accepted','queued') AND run_id IN (SELECT run_id FROM agent_run_bindings WHERE phase='unknown')").run();
  const interactions=createRuntimeInteractions(store,guard,id=>handles.get(id),id=>hooks.stop?hooks.stop(id):stopped(id));
  function employee(id:string){const e=row<{id:string;runtime:string}>('SELECT id,runtime FROM employees WHERE id=? AND deleted_at IS NULL',id);if(!e)throw new Error('员工不存在');return e;}
  function settings(id:string){employee(id);return row<Settings>('SELECT backend,version FROM employee_runtime_settings WHERE employee_id=?',id)??{backend:'cli' as const,version:0};}
  function options(id:string){const e=employee(id);return [{backend:'cli',compatibility:'verified',enabled:true,reason:'现有 CLI，保留原运行行为'},...(['codex','claude'].includes(e.runtime)?[{backend:e.runtime==='codex'?'codex-app-server':'claude-agent-sdk',compatibility:'unverified',enabled:true,reason:'试验接入；仅经本地协议验证，真实认证、工具行为和桌面安装包须另行验收；Claude SDK 需显式 API 供应商'}]:[])];}
  function saveSettings(id:string,input:Record<string,unknown>){
    const old=settings(id);if(input.expectedVersion!==old.version)throw runtimeError('RUNTIME_SETTINGS_CHANGED','运行方式设置已变化，请刷新');
    const option=options(id).find(o=>o.backend===input.backend);if(!option)throw runtimeError('RUNTIME_UNSUPPORTED','员工不支持此运行方式',400);
    if(input.backend!=='cli'&&input.acknowledgeExperimental!==true)throw runtimeError('RUNTIME_INCOMPATIBLE','请确认试验接入的未验证范围');
    if(row("SELECT id FROM tasks WHERE employee_id=? AND status IN ('awaiting_approval','queued','running','stopping','unknown') LIMIT 1",id))throw runtimeError('RUN_NOT_ACTIVE','员工有待处理任务，请先停止并核对后修改运行方式');
    db.exec('SAVEPOINT runtime_settings');try{db.prepare('INSERT INTO employee_runtime_settings VALUES (?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET backend=excluded.backend,version=excluded.version,updated_at=excluded.updated_at').run(id,option.backend,old.version+1,now());hooks.settingsChanged?.(id);db.exec('RELEASE runtime_settings');}catch(error){db.exec('ROLLBACK TO runtime_settings;RELEASE runtime_settings');throw error;}return {settings:settings(id),options:options(id)};
  }
  function guard(id:string){hooks.assert(id);const snapshot=digest(hooks.snapshot(id)),bound=row<{config_fingerprint:string}>('SELECT config_fingerprint FROM agent_run_bindings WHERE run_id=?',id);if(bound&&snapshot!==bound.config_fingerprint)throw runtimeError('PERMISSION_CHANGED','运行配置或权限已变化，请停止并重新检查');return snapshot;}
  function open(input:RuntimeInput,employeeId:string|null){
    const backend=employeeId?settings(employeeId).backend:'cli',fingerprint=digest(hooks.snapshot(input.runId));
    const continuation=row<{resume_run_id:string}>('SELECT resume_run_id FROM agent_runtime_continuations WHERE task_id=(SELECT task_id FROM runs WHERE id=?)',input.runId);
    const previous=continuation?row<any>('SELECT * FROM agent_run_bindings WHERE run_id=?',continuation.resume_run_id):null;
    if(previous&&(previous.backend!==backend||previous.config_fingerprint!==fingerprint||previous.cwd!==input.cwd||previous.stop_evidence!=='quiescent'))throw runtimeError('RUNTIME_INCOMPATIBLE','原生延续配置或工作区已变化，未启动新运行');
    if(backend==='claude-agent-sdk'&&!input.env.ANTHROPIC_API_KEY&&!input.env.ANTHROPIC_AUTH_TOKEN)throw runtimeError('RUNTIME_INCOMPATIBLE','Claude SDK 仅接入显式配置的 API Key/Bearer 供应商，未接管本机订阅登录');
    db.prepare("INSERT INTO agent_run_bindings(run_id,backend,config_fingerprint,phase,stop_evidence,native_session_id,resume_from_run_id,cwd,created_at,updated_at) VALUES (?,?,?,'starting','unknown',?,?,?, ?,?)").run(input.runId,backend,fingerprint,previous?.native_session_id??null,continuation?.resume_run_id??null,input.cwd,now(),now());
    const nativeInput={...input,resumeSessionId:previous?.native_session_id??undefined};
    db.prepare("UPDATE agent_run_bindings SET phase='executing',updated_at=? WHERE run_id=?").run(now(),input.runId);
    db.prepare('DELETE FROM agent_runtime_continuations WHERE task_id=(SELECT task_id FROM runs WHERE id=?)').run(input.runId);
    hooks.record(input.runId,'runtime.bound',{backend,capabilities:capabilities(backend),nativeHistory:!!previous});
    secrets.set(input.runId,Object.entries(input.env).filter(([key,value])=>/key|token|secret|password/i.test(key)&&value&&value.length>=6).map(([,value])=>value!));
    try{const handle=backend==='cli'?openCliRuntime(input):backend==='codex-app-server'?openCodexAppServer(nativeInput):openClaudeAgentSdk(nativeInput);handles.set(input.runId,handle);return handle;}catch(error){secrets.delete(input.runId);db.prepare("UPDATE agent_run_bindings SET phase='failed',updated_at=? WHERE run_id=?").run(now(),input.runId);throw error;}
  }
  function sanitize(id:string,value:unknown):any{if(typeof value==='string'){let text=value;for(const secret of secrets.get(id)??[])text=text.split(secret).join('<redacted>');return redact(text,false);}if(Array.isArray(value))return value.map(v=>sanitize(id,v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,sanitize(id,v)]));return value;}
  function observe(id:string,name:string,payload:Record<string,any>){
    if(name==='runtime.bound'){db.prepare('UPDATE agent_run_bindings SET native_session_id=?,updated_at=? WHERE run_id=?').run(payload.nativeSessionId,now(),id);hooks.record(id,name,{nativeHistory:true});return;}
    if(name==='runtime.process')db.prepare('UPDATE runs SET pid=? WHERE id=?').run(payload.pid,id);
    if(name==='runtime.version'){db.prepare('UPDATE agent_run_bindings SET executor_version=?,sdk_version=? WHERE run_id=?').run(payload.executorVersion??null,payload.sdkVersion??null,id);}
    if(name==='turn.bound'){db.prepare('UPDATE agent_runtime_turns SET native_turn_id=? WHERE id=? AND run_id=?').run(payload.nativeTurnId,payload.turnId,id);return;}
    if(name==='turn.started'){
      db.prepare("INSERT OR IGNORE INTO agent_runtime_turns(id,run_id,status,started_at) VALUES (?,?,'running',?)").run(payload.turnId,id,now());
      if(payload.messageId){db.prepare('UPDATE agent_runtime_turns SET input_message_id=? WHERE id=?').run(payload.messageId,payload.turnId);db.prepare('UPDATE agent_runtime_deliveries SET turn_id=? WHERE message_id=? AND run_id=?').run(payload.turnId,payload.messageId,id);}
      db.prepare("UPDATE agent_run_bindings SET phase='executing',updated_at=? WHERE run_id=?").run(now(),id);
    }
    if(name==='turn.finished'){interactions.invalidate(id);db.prepare("UPDATE agent_run_bindings SET phase='closing',updated_at=? WHERE run_id=?").run(now(),id);
      db.prepare('UPDATE agent_runtime_turns SET status=?,ended_at=? WHERE id=? AND run_id=? AND ended_at IS NULL').run(payload.status,now(),payload.turnId,id);
      if(payload.status==='completed'){for(const message of rows<{message_id:string}>("SELECT message_id FROM agent_runtime_deliveries WHERE run_id=? AND state='accepted'",id)){db.prepare("UPDATE agent_runtime_deliveries SET state='processed',updated_at=? WHERE message_id=? AND run_id=?").run(now(),message.message_id,id);hooks.record(id,'message.delivery',{messageId:message.message_id,state:'processed'});}}
    }
    if(name==='usage.updated'){const keys=payload.source==='codex-app-server'?['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens','totalTokens']:['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];payload={...payload,usage:Object.fromEntries(keys.filter(key=>Object.hasOwn(payload.usage??{},key)).map(key=>[key,Number.isSafeInteger(payload.usage[key])&&payload.usage[key]>=0?payload.usage[key]:null]))};db.prepare('UPDATE agent_runtime_turns SET usage_json=? WHERE id=? AND run_id=?').run(JSON.stringify(payload),payload.turnId,id);updateUsage(id);}
    if(name==='interaction.opened'){interactions.open(id,{...payload,request:sanitize(id,payload.request)});db.prepare('UPDATE agent_run_bindings SET phase=?,updated_at=? WHERE run_id=?').run(payload.kind==='question'?'waiting_input':'waiting_approval',now(),id);payload={interactionId:payload.interactionId,kind:payload.kind};}
    if(name==='message.delivery')db.prepare('UPDATE agent_runtime_deliveries SET state=?,updated_at=? WHERE run_id=? AND message_id=?').run(payload.state,now(),id,payload.messageId);
    hooks.record(id,name,redact(sanitize(id,payload),false));
  }
  function updateUsage(id:string){
    const turns=rows<any>('SELECT usage_json FROM agent_runtime_turns WHERE run_id=?',id);
    const sum=(field:'input'|'output'|'cached')=>{let total=0;for(const turn of turns){if(!turn.usage_json)return null;const data=JSON.parse(turn.usage_json),u=data.usage;const value=data.source==='codex-app-server'?u[field==='input'?'inputTokens':field==='output'?'outputTokens':'cachedInputTokens']:field==='input'?Number.isSafeInteger(u.input_tokens)&&Number.isSafeInteger(u.cache_read_input_tokens)&&Number.isSafeInteger(u.cache_creation_input_tokens)?u.input_tokens+u.cache_read_input_tokens+u.cache_creation_input_tokens:null:field==='output'?u.output_tokens:typeof u.cache_read_input_tokens==='number'&&typeof u.cache_creation_input_tokens==='number'?u.cache_read_input_tokens+u.cache_creation_input_tokens:null;if(!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(total+value))return null;total+=value;}return total;};
    db.prepare('INSERT INTO apix_run_usage VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,source=excluded.source,updated_at=excluded.updated_at').run(id,sum('input'),sum('output'),sum('cached'),'native-turns',now());
  }
  function stopped(id:string){const handle=handles.get(id);if(!handle)throw runtimeError('RUN_NOT_ACTIVE','此 Run 不受当前服务管理');interactions.invalidate(id);db.prepare("UPDATE agent_runtime_deliveries SET state='cancelled',updated_at=? WHERE run_id=? AND state IN ('saved','queued')").run(now(),id);db.prepare("UPDATE agent_run_bindings SET phase='stopping',updated_at=? WHERE run_id=?").run(now(),id);handle.interrupt();}
  function finish(id:string,phase:string,evidence?:string){const handle=handles.get(id);if(!handle)return false;if(details(id).backend!=='cli')updateUsage(id);interactions.invalidate(id);db.prepare("UPDATE agent_runtime_deliveries SET state='unknown',updated_at=? WHERE run_id=? AND state IN ('saved','accepted','queued')").run(now(),id);db.prepare('UPDATE agent_run_bindings SET phase=?,stop_evidence=?,updated_at=? WHERE run_id=?').run(phase,evidence??(handle.isActive()?'unknown':'root_exited'),now(),id);handles.delete(id);secrets.delete(id);hooks.record(id,'runtime.closed',{phase,evidence:evidence??'root_exited'});return true;}
  function details(id:string){const run=row<{status:string}>('SELECT status FROM runs WHERE id=?',id);if(!run)throw new Error('Run 不存在');const bound=row<any>('SELECT * FROM agent_run_bindings WHERE run_id=?',id);return {executorVersion:bound?.executor_version??null,sdkVersion:bound?.sdk_version??null,backend:bound?.backend??'cli',phase:bound?.phase??run.status,capabilities:capabilities(bound?.backend??'cli'),stopEvidence:bound?.stop_evidence??'unknown',legacyRecord:!bound,active:handles.get(id)?.isActive()??false,pendingInteractions:interactions.list(id).filter(i=>i.state==='pending').length,recoveryAvailable:!!bound?.native_session_id&&bound.stop_evidence==='quiescent',turns:rows('SELECT id,status,started_at,ended_at FROM agent_runtime_turns WHERE run_id=? ORDER BY rowid',id),deliveries:rows('SELECT message_id,mode,state FROM agent_runtime_deliveries WHERE run_id=? ORDER BY rowid',id)};}
  function events(id:string,input:{afterId?:unknown;beforeId?:unknown;limit?:unknown}){
    details(id);const after=input.afterId,before=input.beforeId;if(after!==undefined&&before!==undefined)throw runtimeError('INVALID_CURSOR','不能同时使用前后游标',400);
    const cursor=after??before,number=cursor===undefined?null:Number(cursor),limit=input.limit===undefined?100:Number(input.limit);
    if(number!==null&&(!Number.isSafeInteger(number)||number<1)||!Number.isSafeInteger(limit)||limit<1||limit>200)throw runtimeError('INVALID_CURSOR','游标或分页大小无效',400);
    if(number!==null&&!row('SELECT id FROM events WHERE run_id=? AND id=?',id,number))throw runtimeError('INVALID_CURSOR','游标不属于此 Run',400);
    const page=rows<any>(`SELECT id,source,kind,payload,created_at FROM events WHERE run_id=? ${number===null?'':before!==undefined?'AND id<?':'AND id>?'} ORDER BY id ${before!==undefined?'DESC':'ASC'} LIMIT ?`,id,...(number===null?[]:[number]),limit+1);
    const items=page.slice(0,limit).map(e=>({schemaVersion:1,runId:id,id:e.id,kind:e.source==='agent-runtime-v1'?e.kind:'legacy.event',occurredAt:e.created_at,payload:e.source==='agent-runtime-v1'?JSON.parse(e.payload):{summary:'旧 CLI 事件：'+e.kind}}));return {items,nextCursor:items.at(-1)?.id??null,hasMore:page.length>limit};
  }
  async function send(id:string,input:Record<string,any>){
    if(!/^[a-zA-Z0-9:_-]{8,100}$/.test(input.requestId??'')||typeof input.content!=='string'||!input.content.trim()||input.content.length>16000||!['steer','queue'].includes(input.mode))throw runtimeError('INVALID_ARGUMENTS','指导请求格式无效',400);
    const hash=digest({content:input.content,mode:input.mode}),old=row<any>('SELECT * FROM agent_runtime_deliveries WHERE run_id=? AND request_id=?',id,input.requestId);
    if(old){if(old.input_hash!==hash)throw runtimeError('IDEMPOTENCY_CONFLICT','相同请求 ID 的指导内容不同');return {messageId:old.message_id,runId:id,delivery:old.state};}
    const active=handles.get(id),info=details(id);if(!active)throw runtimeError('RUN_NOT_ACTIVE','运行不再接收指导');if(!active.send||!info.capabilities[input.mode as 'steer'|'queue'])throw runtimeError('RUNTIME_UNSUPPORTED','当前运行不支持此指导方式',400);guard(id);
    const message=hooks.message(id,{requestId:input.requestId,content:input.content,mode:input.mode});
    db.prepare("INSERT INTO agent_runtime_deliveries(message_id,run_id,request_id,input_hash,mode,state,updated_at) VALUES (?,?,?,?,?,'saved',?)").run(message.id,id,input.requestId,hash,input.mode,now());hooks.claimed(message.id,id);
    db.prepare("UPDATE agent_runtime_deliveries SET state='unknown' WHERE message_id=? AND run_id=?").run(message.id,id);
    try{const accepted=await active.send({messageId:message.id,content:input.content,mode:input.mode});if(handles.get(id)!==active)throw runtimeError('DELIVERY_UNKNOWN','运行在确认前已关闭');db.prepare('UPDATE agent_runtime_deliveries SET state=?,updated_at=? WHERE message_id=? AND run_id=?').run(accepted.state,now(),message.id,id);return {messageId:message.id,runId:id,delivery:accepted.state};}catch(error){if(error instanceof Error&&'code' in error&&['STALE_TURN','RUN_NOT_ACTIVE','RUNTIME_UNSUPPORTED'].includes(String(error.code))){db.prepare("UPDATE agent_runtime_deliveries SET state='rejected',updated_at=? WHERE message_id=? AND run_id=?").run(now(),message.id,id);throw error;}throw runtimeError('DELIVERY_UNKNOWN','指导已保存，接收未确认；请核对投递状态，不要重复发送');}
  }
  async function deliverExisting(id:string,messageId:string,content:string){
    const mode=details(id).capabilities.steer?'steer':'queue',requestId='mailbox:'+messageId;
    if(row('SELECT message_id FROM agent_runtime_deliveries WHERE run_id=? AND request_id=?',id,requestId))return;
    const active=handles.get(id);if(!active?.send)return;guard(id);
    db.prepare("INSERT INTO agent_runtime_deliveries(message_id,run_id,request_id,input_hash,mode,state,updated_at) VALUES (?,?,?,?,?,'unknown',?)").run(messageId,id,requestId,digest({content,mode}),mode,now());hooks.claimed(messageId,id);
    try{const result=await active.send({messageId,content,mode});db.prepare('UPDATE agent_runtime_deliveries SET state=?,updated_at=? WHERE run_id=? AND message_id=?').run(result.state,now(),id,messageId);}catch{hooks.record(id,'message.delivery',{messageId,state:'unknown'});}
  }
  function continuation(taskId:string,runId:string,employeeId:string){const bound=row<any>('SELECT b.*,t.employee_id,t.id task_id FROM agent_run_bindings b JOIN runs r ON r.id=b.run_id JOIN tasks t ON t.id=r.task_id WHERE b.run_id=?',runId);if(!bound||bound.task_id!==taskId||bound.employee_id!==employeeId||bound.backend==='cli'||bound.backend!==settings(employeeId).backend||!bound.native_session_id||bound.stop_evidence!=='quiescent'||!existsSync(bound.cwd)||bound.config_fingerprint!==digest(hooks.snapshot(runId)))throw runtimeError('RUNTIME_INCOMPATIBLE','原生历史、配置或停止证据不满足延续条件；请明确选择全新运行');db.prepare('INSERT INTO agent_runtime_continuations VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET resume_run_id=excluded.resume_run_id').run(taskId,runId);}
  function tick(){interactions.tick();for(const id of handles.keys()){if(details(id).backend==='cli')continue;try{guard(id);}catch{if(hooks.stop)hooks.stop(id);else stopped(id);}}}
  async function shutdown(){await Promise.allSettled([...handles.entries()].filter(([id])=>details(id).backend!=='cli').map(async([id,handle])=>{if(hooks.stop)hooks.stop(id);else stopped(id);await handle.close();}));}
  return {open,observe,tick,shutdown,stopped,finish,details,events,settings,options,saveSettings,sanitize,send,deliverExisting,interactions,continuation,setHooks:(value:Hooks)=>hooks=value,isActive:(id:string)=>handles.get(id)?.isActive()??false,waiting:(id:string)=>interactions.pending(id)};
}
